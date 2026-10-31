package db

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/hivesql"
)

// getHiveTableInfo reads catalog statistics only. It must not turn opening the
// object panel into a full warehouse COUNT(*) job or claim stale stats are exact.
func getHiveTableInfo(ctx context.Context, query tableInfoQueryFunc, database, schema, table string) (TableDetails, error) {
	parts, err := hivesql.SplitTable(table)
	if err != nil {
		return TableDetails{}, err
	}
	name := hivesql.QuoteIdentifier(parts[len(parts)-1])
	if len(parts) == 2 {
		database = parts[0]
	} else if database == "" {
		database = schema
	}
	if database != "" {
		name = hivesql.QuoteIdentifier(database) + "." + name
	}
	rows, err := query(ctx, "DESCRIBE FORMATTED "+name)
	if err != nil {
		return TableDetails{}, fmt.Errorf("read Hive table information: %w", err)
	}
	properties := hiveTableInfoProperties(rows)
	storage := properties["inputformat"]
	if storage == "" {
		storage = properties["provider"]
	}
	if strings.Contains(strings.ToLower(storage), "orc") {
		storage = "ORC"
	} else if strings.Contains(strings.ToLower(storage), "parquet") {
		storage = "Parquet"
	} else if strings.Contains(strings.ToLower(storage), "textinputformat") {
		storage = "TextFile"
	}
	if properties["table type"] == "" {
		properties["table type"] = properties["type"]
	}
	if properties["createtime"] == "" {
		properties["createtime"] = properties["created time"]
	}
	return TableDetails{
		Engine: storage, Comment: properties["comment"],
		RowFormat: properties["table type"], CreateTime: properties["createtime"],
		Rows: hiveNonnegativeStat(properties["numrows"]), DataLength: hiveNonnegativeStat(properties["totalsize"]),
	}, nil
}

func hiveTableInfoProperties(rows []map[string]interface{}) map[string]string {
	properties := make(map[string]string)
	detailsSection := false
	for _, row := range rows {
		key := strings.TrimSuffix(strings.TrimSpace(nullableStringValue(row, "col_name")), ":")
		value := nullableStringValue(row, "data_type")
		if key == "" && value == "" {
			// Impala uses name/type rather than col_name/data_type.
			key = strings.TrimSuffix(nullableStringValue(row, "name"), ":")
			value = nullableStringValue(row, "type")
		}
		if strings.HasPrefix(key, "#") && strings.Contains(strings.ToLower(key), "information") {
			detailsSection = true
			continue
		}
		if !detailsSection {
			continue
		}
		if key == "" {
			// Hive's indented table parameters occupy columns 2 and 3.
			key, value = value, nullableStringValue(row, "comment")
		}
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "inputformat", "provider", "table type", "type", "createtime", "created time", "numrows", "totalsize", "comment":
			properties[strings.ToLower(strings.TrimSpace(key))] = value
		}
	}
	return properties
}

func hiveNonnegativeStat(raw string) *int64 {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value < 0 {
		return nil
	}
	return &value
}
