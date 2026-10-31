package app

import (
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

// hiveInsertLayout retains physical target order: Hive 1.x and complex types do
// not support the generic column-list VALUES form. Static partitions avoid
// changing the user's dynamic-partition session settings during restore.
type hiveInsertLayout struct {
	dataColumns []connection.ColumnDefinition
	partitions  []connection.ColumnDefinition
}

func newHiveInsertLayout(defs []connection.ColumnDefinition, partitions []string) (*hiveInsertLayout, error) {
	if len(defs) == 0 {
		return nil, fmt.Errorf("hive SQL export requires complete target column metadata")
	}
	partitionSet := make(map[string]bool, len(partitions))
	for _, name := range partitions {
		partitionSet[normalizeColumnName(name)] = true
	}
	layout := &hiveInsertLayout{}
	seen := make(map[string]bool, len(defs))
	for _, def := range defs {
		key := normalizeColumnName(def.Name)
		if key == "" || seen[key] {
			return nil, fmt.Errorf("invalid or ambiguous Hive column %q", def.Name)
		}
		seen[key] = true
		typ, err := hivesql.ParseType(def.Type)
		if err != nil {
			return nil, fmt.Errorf("hive column %q: %w", def.Name, err)
		}
		if partitionSet[key] || strings.EqualFold(strings.TrimSpace(def.Extra), "partition") {
			if typ.Complex() || typ.Kind == "binary" || typ.Kind == "void" {
				return nil, fmt.Errorf("unsupported Hive partition type %s", typ.String())
			}
			layout.partitions = append(layout.partitions, def)
			delete(partitionSet, key)
		} else {
			layout.dataColumns = append(layout.dataColumns, def)
		}
	}
	for name := range partitionSet {
		return nil, fmt.Errorf("Hive partition column %q is absent from column metadata", name)
	}
	if len(layout.dataColumns) == 0 {
		return nil, fmt.Errorf("hive SQL export requires at least one non-partition column")
	}
	return layout, nil
}

func (layout *hiveInsertLayout) insert(table string, row map[string]interface{}) (string, error) {
	parts, err := hivesql.SplitTable(table)
	if err != nil || len(parts) == 0 {
		return "", fmt.Errorf("invalid Hive INSERT target %q", table)
	}
	values := make([]string, 0, len(layout.dataColumns))
	for _, def := range layout.dataColumns {
		literal, err := hivesql.Value(def.Type, row[normalizeColumnName(def.Name)])
		if err != nil {
			return "", fmt.Errorf("hive column %q: %w", def.Name, err)
		}
		values = append(values, literal)
	}
	partitionSQL, err := layout.partitionSQL(row)
	if err != nil {
		return "", err
	}
	return "INSERT INTO TABLE " + hivesql.QuoteTable(table) + partitionSQL + " SELECT " + strings.Join(values, ", "), nil
}

func (layout *hiveInsertLayout) partitionSQL(row map[string]interface{}) (string, error) {
	if len(layout.partitions) == 0 {
		return "", nil
	}
	assignments := make([]string, 0, len(layout.partitions))
	for _, def := range layout.partitions {
		value, exists := row[normalizeColumnName(def.Name)]
		if !exists {
			return "", fmt.Errorf("Hive partition column %q is missing", def.Name)
		}
		literal, err := hiveStaticPartitionValue(def.Type, value)
		if err != nil {
			return "", fmt.Errorf("hive partition %q: %w", def.Name, err)
		}
		assignments = append(assignments, hivesql.QuoteIdentifier(def.Name)+"="+literal)
	}
	return " PARTITION (" + strings.Join(assignments, ", ") + ")", nil
}

func hiveStaticPartitionValue(typeName string, value interface{}) (string, error) {
	if _, err := hivesql.Value(typeName, value); err != nil {
		return "", err
	}
	if strings.Contains(fmt.Sprint(value), "${") {
		return "", fmt.Errorf("Hive static partitions cannot safely contain variable substitutions")
	}
	if value == nil {
		// This is Hive's reserved on-disk NULL partition marker, not a SQL NULL
		// expression (expressions are not legal in static PARTITION clauses).
		return hivesql.QuoteString("__HIVE_DEFAULT_PARTITION__"), nil
	}
	switch v := value.(type) {
	case time.Time:
		if strings.EqualFold(strings.TrimSpace(typeName), "date") {
			return hivesql.QuoteString(v.Format("2006-01-02")), nil
		}
		return hivesql.QuoteString(v.Format("2006-01-02 15:04:05.999999999")), nil
	case []byte:
		return hivesql.QuoteString(string(v)), nil
	default:
		return hivesql.QuoteString(fmt.Sprint(value)), nil
	}
}

func hiveDefsFromExportOptions(options ExportFileOptions) []connection.ColumnDefinition {
	defs := make([]connection.ColumnDefinition, 0, len(options.InsertSQLColumnOrder))
	for _, name := range options.InsertSQLColumnOrder {
		defs = append(defs, connection.ColumnDefinition{Name: name, Type: options.InsertSQLColumnTypes[normalizeColumnName(name)]})
	}
	return defs
}
