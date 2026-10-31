//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

// HiveTableWriteCapabilities inspects table properties and storage on every call.
// A failed or ambiguous inspection never enables destructive DML.
func (h *HiveDB) HiveTableWriteCapabilities(ctx context.Context, tableName string) (HiveTableWriteCapabilities, error) {
	session, err := h.sessionContext(ctx, true)
	if err != nil {
		return HiveTableWriteCapabilities{}, err
	}
	parts, err := hivesql.SplitTable(tableName)
	if err != nil {
		return HiveTableWriteCapabilities{}, err
	}
	database := session.config.Database
	table := parts[0]
	if len(parts) == 2 {
		database, table = parts[0], parts[1]
	}
	qualified := hiveQualifiedName(database, table)
	rows, fields, err := session.QueryContext(ctx, "DESCRIBE FORMATTED "+qualified)
	if err != nil {
		return HiveTableWriteCapabilities{}, err
	}
	details := hiveDescribeDetails(rows, fields)
	rows, fields, err = session.QueryContext(ctx, "SHOW TBLPROPERTIES "+qualified)
	if err != nil {
		return HiveTableWriteCapabilities{}, err
	}
	properties := map[string]string{}
	if len(fields) >= 2 {
		for _, row := range rows {
			key := strings.ToLower(strings.TrimSpace(hiveRowText(row, fields[0])))
			if key != "" {
				properties[key] = hiveRowText(row, fields[1])
			}
		}
	}
	columns, err := h.GetColumnsContext(ctx, database, table)
	if err != nil {
		return HiveTableWriteCapabilities{}, err
	}
	partitions := make([]string, 0)
	for _, column := range columns {
		if column.Extra == "partition" {
			partitions = append(partitions, column.Name)
		}
	}
	result := hiveDeriveWriteCapabilities(session.config.family, details, properties, partitions)
	for _, column := range columns {
		kind, err := hivesql.ParseType(column.Type)
		if err != nil {
			return HiveTableWriteCapabilities{}, err
		}
		if session.config.family == "impala" && (kind.Complex() || strings.HasPrefix(kind.Kind, "interval") || kind.Kind == "timestamp_local_tz") || session.config.family == "spark" && (kind.Kind == "uniontype" || strings.HasPrefix(kind.Kind, "interval")) {
			result.Insert = false
			result.Update = false
			result.Delete = false
			result.Reason = "this HiveServer2 family cannot portably construct or write " + column.Type
		}
	}
	if result.Transactional && result.Update {
		rows, fields, err = session.QueryContext(ctx, "SET hive.txn.manager")
		if err != nil {
			return HiveTableWriteCapabilities{}, err
		}
		manager := ""
		for _, row := range rows {
			for _, field := range fields {
				manager += hiveRowText(row, field)
			}
		}
		if !strings.Contains(strings.ToLower(manager), "dbtxnmanager") {
			result.Update = false
			result.Delete = false
			result.Reason = "Hive full-ACID DML requires DbTxnManager"
		}
	}
	return result, nil
}

func hiveDescribeDetails(rows []map[string]interface{}, fields []string) map[string]string {
	details := map[string]string{}
	if len(fields) < 2 {
		return details
	}
	for _, row := range rows {
		key := strings.TrimSuffix(strings.TrimSpace(hiveRowText(row, fields[0])), ":")
		if key != "" && !strings.HasPrefix(key, "#") {
			details[strings.ToLower(key)] = strings.TrimSpace(hiveRowText(row, fields[1]))
		}
	}
	return details
}

func hiveDeriveWriteCapabilities(family string, details, properties map[string]string, partitions []string) HiveTableWriteCapabilities {
	result := HiveTableWriteCapabilities{Family: family, Properties: properties, PartitionColumns: partitions, Insert: true, InsertOnly: true}
	kind := strings.ToUpper(details["table type"])
	if kind == "" {
		kind = strings.ToUpper(details["type"])
	}
	switch kind {
	case "MANAGED":
		kind = "MANAGED_TABLE"
	case "EXTERNAL":
		kind = "EXTERNAL_TABLE"
	}
	if strings.Contains(kind, "VIEW") {
		result.Insert = false
		result.InsertOnly = false
		result.Reason = "views are not writable through the portable HiveServer2 API"
		return result
	}
	if kind != "MANAGED_TABLE" && kind != "EXTERNAL_TABLE" && kind != "TABLE" {
		result.Insert = false
		result.InsertOnly = false
		result.Reason = "table storage kind could not be verified"
		return result
	}
	external := kind == "EXTERNAL_TABLE" || strings.EqualFold(properties["external"], "true")
	result.Truncate = !external && kind == "MANAGED_TABLE"
	handler := strings.ToLower(properties["storage_handler"] + " " + details["storage handler"] + " " + details["inputformat"] + " " + details["input format"])
	switch family {
	case "hive":
		result.Transactional = strings.EqualFold(properties["transactional"], "true")
		mode := strings.ToLower(strings.TrimSpace(properties["transactional_properties"]))
		full := result.Transactional && (mode == "" || mode == "default") && strings.Contains(handler, "orc")
		result.Update, result.Delete = full, full
		result.InsertOnly = !full
		result.Reason = "ordinary Hive tables support append, not generic UPDATE/DELETE"
		if result.Transactional {
			result.Reason = "Hive insert-only ACID tables cannot UPDATE/DELETE"
		}
		if full {
			result.Reason = "Hive full-ACID ORC table; statements autocommit independently"
		}
	case "spark":
		if strings.EqualFold(properties["transactional"], "true") {
			result.Insert = false
			result.Truncate = false
		}
		result.Reason = "Spark SQL Thrift does not expose portable UPDATE/DELETE; extensions are not assumed"
	case "impala":
		kudu := strings.Contains(handler, "kudu")
		if strings.EqualFold(properties["transactional"], "true") && !kudu {
			result.Insert = false
			result.Truncate = false
		}
		result.Update, result.Delete = kudu, kudu
		result.InsertOnly = !kudu
		result.Truncate = !kudu && !external && kind == "MANAGED_TABLE"
		result.Reason = "Impala UPDATE/DELETE requires a Kudu table"
		if kudu {
			result.Reason = "Impala Kudu DML is supported; no multi-statement transaction"
		}
	default:
		result.Insert = false
		result.Truncate = false
		result.Reason = "unknown HiveServer2 SQL family"
	}
	return result
}

// GetTableComment preserves the comment table property for backup/schema readers.
func (h *HiveDB) GetTableComment(dbName, tableName string) (string, error) {
	session, err := h.session(true)
	if err != nil {
		return "", err
	}
	if dbName == "" {
		dbName = session.config.Database
	}
	rows, fields, err := session.QueryContext(metadataContextFor(h), "SHOW TBLPROPERTIES "+hiveQualifiedName(dbName, tableName))
	if err != nil {
		return "", err
	}
	if len(fields) < 2 {
		return "", fmt.Errorf("Hive table properties returned no columns")
	}
	for _, row := range rows {
		if strings.EqualFold(strings.TrimSpace(hiveRowText(row, fields[0])), "comment") {
			return hiveRowText(row, fields[1]), nil
		}
	}
	return "", nil
}

func hiveColumnsByName(columns []connection.ColumnDefinition) map[string]connection.ColumnDefinition {
	result := make(map[string]connection.ColumnDefinition, len(columns))
	for _, column := range columns {
		result[column.Name] = column
	}
	return result
}
