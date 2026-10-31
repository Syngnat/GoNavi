//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"

	hs "github.com/beltran/gohive/hiveserver"
)

// GetDatabases enumerates HS2 schemas (Hive databases), not a synthetic catalog.
func (h *HiveDB) GetDatabases() ([]string, error) {
	session, err := h.session(true)
	if err != nil {
		return nil, err
	}
	rows, _, err := session.nativeMetadata(metadataContextFor(h), func(ctx context.Context) (*hs.TOperationHandle, error) {
		response, err := session.wire.api.GetSchemas(ctx, &hs.TGetSchemasReq{SessionHandle: session.handle})
		if err != nil {
			return nil, err
		}
		if err = hiveCheckStatus(response.GetStatus()); err != nil {
			return nil, err
		}
		return response.OperationHandle, nil
	})
	if err != nil {
		return nil, err
	}
	return hiveUniqueNames(rows, "TABLE_SCHEM"), nil
}

// GetTables returns only base tables; views use HiveViews and cannot be exported as tables.
func (h *HiveDB) GetTables(dbName string) ([]string, error) {
	return h.catalogTables(metadataContextFor(h), dbName, false)
}

// HiveViews enumerates protocol-native view metadata across all three server families.
func (h *HiveDB) HiveViews(ctx context.Context, dbName string) ([]string, error) {
	return h.catalogTables(ctx, dbName, true)
}

func (h *HiveDB) catalogTables(ctx context.Context, dbName string, views bool) ([]string, error) {
	session, err := h.session(true)
	if err != nil {
		return nil, err
	}
	if dbName == "" {
		dbName = session.config.Database
	}
	pattern := hs.TPatternOrIdentifier(hiveMetadataPattern(dbName))
	types := []string{"TABLE", "MANAGED_TABLE", "EXTERNAL_TABLE"}
	if views {
		types = []string{"VIEW", "VIRTUAL_VIEW", "MATERIALIZED_VIEW"}
	}
	rows, _, err := session.nativeMetadata(ctx, func(ctx context.Context) (*hs.TOperationHandle, error) {
		response, err := session.wire.api.GetTables(ctx, &hs.TGetTablesReq{SessionHandle: session.handle, SchemaName: &pattern, TableTypes: types})
		if err != nil {
			return nil, err
		}
		if err = hiveCheckStatus(response.GetStatus()); err != nil {
			return nil, err
		}
		return response.OperationHandle, nil
	})
	if err != nil {
		return nil, err
	}
	filtered := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		kind := strings.ToUpper(hiveRowText(row, "TABLE_TYPE"))
		isView := strings.Contains(kind, "VIEW")
		if kind != "" && isView != views {
			continue
		}
		if schema := hiveRowText(row, "TABLE_SCHEM"); schema != "" && !strings.EqualFold(schema, dbName) {
			continue
		}
		filtered = append(filtered, row)
	}
	return hiveUniqueNames(filtered, "TABLE_NAME"), nil
}

func (s *hiveSession) nativeMetadata(ctx context.Context, open func(context.Context) (*hs.TOperationHandle, error)) ([]map[string]interface{}, []string, error) {
	collector := &hiveRowCollector{}
	err := s.run(ctx, func(ctx context.Context) (resultErr error) {
		operation, err := open(ctx)
		if err != nil {
			var semantic *hiveStatusError
			if !errors.As(err, &semantic) {
				s.broken = true
				s.cancel()
			}
			return err
		}
		if operation == nil {
			return fmt.Errorf("Hive metadata returned no operation")
		}
		defer func() { resultErr = errors.Join(resultErr, s.cleanupOperation(ctx, operation, resultErr != nil)) }()
		if _, err = s.waitOperation(ctx, operation); err != nil {
			return err
		}
		return s.fetchOperation(ctx, operation, collector)
	})
	return collector.rows, collector.names, err
}

func hiveMetadataPattern(name string) string {
	r := strings.NewReplacer("\\", "\\\\", "_", "\\_", "%", "\\%")
	return r.Replace(name)
}
func hiveRowText(row map[string]interface{}, name string) string {
	value := metadataRowValue(row, name)
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}
func hiveUniqueNames(rows []map[string]interface{}, key string) []string {
	seen := map[string]bool{}
	for _, row := range rows {
		if name := hiveRowText(row, key); name != "" {
			seen[name] = true
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// GetCreateStatement preserves native multi-row SHOW CREATE TABLE output, including view definitions.
func (h *HiveDB) GetCreateStatement(dbName, tableName string) (string, error) {
	session, err := h.session(true)
	if err != nil {
		return "", err
	}
	if dbName == "" {
		dbName = session.config.Database
	}
	rows, fields, err := session.QueryContext(metadataContextFor(h), "SHOW CREATE TABLE "+hiveQualifiedName(dbName, tableName))
	if err != nil {
		return "", err
	}
	if len(fields) == 0 || len(rows) == 0 {
		return "", fmt.Errorf("HiveServer2 returned no DDL")
	}
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		if value := row[fields[0]]; value != nil {
			lines = append(lines, fmt.Sprint(value))
		}
	}
	statement := strings.Join(lines, "\n")
	if strings.TrimSpace(statement) == "" {
		return "", fmt.Errorf("HiveServer2 returned empty DDL")
	}
	return statement, nil
}

// GetColumns preserves nested types, comments, and partition columns in Extra.
func (h *HiveDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return h.GetColumnsContext(metadataContextFor(h), dbName, tableName)
}

// GetColumnsContext reads metadata without mutating the user's selected database.
func (h *HiveDB) GetColumnsContext(ctx context.Context, dbName, tableName string) ([]connection.ColumnDefinition, error) {
	session, err := h.sessionContext(ctx, true)
	if err != nil {
		return nil, err
	}
	if dbName == "" {
		dbName = session.config.Database
	}
	var columns []connection.ColumnDefinition
	err = session.run(ctx, func(ctx context.Context) error {
		var readErr error
		columns, readErr = session.hiveColumnsOnOwner(ctx, dbName, tableName)
		return readErr
	})
	return columns, err
}

func hiveDescribeColumns(rows []map[string]interface{}, fields []string) ([]connection.ColumnDefinition, error) {
	if len(fields) < 2 {
		return nil, fmt.Errorf("Hive DESCRIBE returned no column metadata")
	}
	columns := make([]connection.ColumnDefinition, 0, len(rows))
	indexes := map[string]int{}
	partition := false
	for _, row := range rows {
		name := strings.TrimSpace(hiveRowText(row, fields[0]))
		typeName := strings.TrimSpace(hiveRowText(row, fields[1]))
		if strings.HasPrefix(name, "#") {
			lower := strings.ToLower(name)
			switch {
			case strings.Contains(lower, "partition information"):
				partition = true
			case strings.Contains(lower, "col_name"):
				// Header row inside the partition block; keep the current section.
			default:
				partition = false
			}
			continue
		}
		if name == "" || typeName == "" {
			continue
		}
		if _, err := hivesql.ParseType(typeName); err != nil {
			return nil, fmt.Errorf("Hive column %q: %w", name, err)
		}
		extra := ""
		if partition {
			extra = "partition"
		}
		if index, exists := indexes[name]; exists {
			if partition {
				columns[index].Extra = "partition"
			}
			continue
		}
		comment := ""
		if len(fields) > 2 {
			comment = hiveRowText(row, fields[2])
		}
		if strings.EqualFold(comment, "from deserializer") || strings.EqualFold(comment, "null") {
			comment = ""
		}
		indexes[name] = len(columns)
		columns = append(columns, connection.ColumnDefinition{Name: name, Type: typeName, Nullable: "YES", Extra: extra, Comment: comment})
	}
	if len(columns) == 0 {
		return nil, fmt.Errorf("Hive DESCRIBE returned no columns")
	}
	return columns, nil
}

// GetAllColumns aggregates per-table metadata and reports partial failures honestly.
func (h *HiveDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := h.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	views, err := h.HiveViews(metadataContextFor(h), dbName)
	if err != nil {
		return nil, err
	}
	tables = append(tables, views...)
	var all []connection.ColumnDefinitionWithTable
	var failures []MetadataObjectFailure
	for _, table := range tables {
		if err := metadataContextFor(h).Err(); err != nil {
			return all, err
		}
		columns, err := h.GetColumns(dbName, table)
		if err != nil {
			failures = append(failures, MetadataObjectFailure{ObjectName: table, Err: err})
			continue
		}
		for _, column := range columns {
			all = append(all, connection.ColumnDefinitionWithTable{TableName: table, Name: column.Name, Type: column.Type, Comment: column.Comment})
		}
	}
	if err := NewPartialMetadataError(failures); err != nil {
		return all, err
	}
	return all, nil
}

// TableExists checks an exact catalog name, never a wildcard-expanded match.
func (h *HiveDB) TableExists(dbName, tableName string) (bool, error) {
	tables, err := h.GetTables(dbName)
	if err != nil {
		return false, err
	}
	views, err := h.HiveViews(metadataContextFor(h), dbName)
	if err != nil {
		return false, err
	}
	for _, name := range append(tables, views...) {
		if name == tableName {
			return true, nil
		}
	}
	return false, nil
}

// GetIndexes returns an empty list: Hive has no portable index metadata model.
// An absent capability is not a failed metadata load, so the UI must not show
// an error toast when opening the table designer's index tab.
func (h *HiveDB) GetIndexes(string, string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

// GetForeignKeys returns an empty list: Hive constraints are not enforced uniformly
// and there is no portable foreign-key metadata model for the generic designer.
func (h *HiveDB) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

// GetTriggers returns an empty list: Hive has no trigger metadata.
func (h *HiveDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}
