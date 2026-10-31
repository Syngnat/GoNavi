//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"

	"github.com/apache/thrift/lib/go/thrift"
	hs "github.com/beltran/gohive/hiveserver"
)

func hiveResultColumns(schema *hs.TTableSchema) ([]connection.ColumnDefinition, error) {
	if schema == nil {
		return nil, fmt.Errorf("Hive result schema is missing")
	}
	columns := make([]connection.ColumnDefinition, len(schema.Columns))
	seen := map[string]bool{}
	for i, column := range schema.Columns {
		if column == nil {
			return nil, fmt.Errorf("Hive result column is missing")
		}
		name := column.ColumnName
		if name == "" {
			name = fmt.Sprintf("column_%d", i+1)
		}
		original := name
		for suffix := 2; seen[name]; suffix++ {
			name = fmt.Sprintf("%s#%d", original, suffix)
		}
		seen[name] = true
		typeName, err := hiveTypeName(column.TypeDesc, 0, 0)
		if err != nil {
			return nil, err
		}
		columns[i] = connection.ColumnDefinition{Name: name, Type: typeName, Nullable: "YES", Comment: column.GetComment()}
	}
	return columns, nil
}

func hiveTypeName(desc *hs.TTypeDesc, index, depth int) (string, error) {
	if desc == nil || index < 0 || index >= len(desc.Types) || depth > 32 {
		return "", fmt.Errorf("invalid Hive result type descriptor")
	}
	entry := desc.Types[index]
	if entry == nil {
		return "", fmt.Errorf("missing Hive result type entry")
	}
	if primitive := entry.PrimitiveEntry; primitive != nil {
		name := strings.TrimSuffix(primitive.Type.String(), "_TYPE")
		var qualifiers map[string]*hs.TTypeQualifierValue
		if primitive.TypeQualifiers != nil {
			qualifiers = primitive.TypeQualifiers.Qualifiers
		}
		get := func(key string, fallback int32) int32 {
			if value := qualifiers[key]; value != nil && value.I32Value != nil {
				return *value.I32Value
			}
			return fallback
		}
		switch name {
		case "DECIMAL":
			return fmt.Sprintf("DECIMAL(%d,%d)", get("precision", 10), get("scale", 0)), nil
		case "CHAR", "VARCHAR":
			return fmt.Sprintf("%s(%d)", name, get("characterMaximumLength", 1)), nil
		case "TIMESTAMPLOCALTZ":
			return "TIMESTAMP WITH LOCAL TIME ZONE", nil
		}
		return name, nil
	}
	if array := entry.ArrayEntry; array != nil {
		member, err := hiveTypeName(desc, int(array.ObjectTypePtr), depth+1)
		return "ARRAY<" + member + ">", err
	}
	if mapping := entry.MapEntry; mapping != nil {
		key, err := hiveTypeName(desc, int(mapping.KeyTypePtr), depth+1)
		if err != nil {
			return "", err
		}
		value, err := hiveTypeName(desc, int(mapping.ValueTypePtr), depth+1)
		return "MAP<" + key + "," + value + ">", err
	}
	if structure := entry.StructEntry; structure != nil {
		names := make([]string, 0, len(structure.NameToTypePtr))
		for name := range structure.NameToTypePtr {
			names = append(names, name)
		}
		sort.Slice(names, func(i, j int) bool { return structure.NameToTypePtr[names[i]] < structure.NameToTypePtr[names[j]] })
		fields := make([]string, len(names))
		for i, name := range names {
			member, err := hiveTypeName(desc, int(structure.NameToTypePtr[name]), depth+1)
			if err != nil {
				return "", err
			}
			fields[i] = hivesql.QuoteIdentifier(name) + ":" + member
		}
		return "STRUCT<" + strings.Join(fields, ",") + ">", nil
	}
	return "", fmt.Errorf("unsupported Hive result type descriptor")
}

func hiveConsumeRows(ctx context.Context, rows *hs.TRowSet, columns []connection.ColumnDefinition, consumer QueryStreamConsumer) (int, error) {
	if rows == nil {
		return 0, nil
	}
	vectors := rows.Columns
	if len(rows.BinaryColumns) > 0 {
		if rows.ColumnCount == nil || int(*rows.ColumnCount) != len(columns) || len(rows.BinaryColumns) > hiveMaxMessageBytes {
			return 0, fmt.Errorf("invalid Hive binary column batch")
		}
		buffer := thrift.NewTMemoryBufferLen(len(rows.BinaryColumns))
		if _, err := buffer.Write(rows.BinaryColumns); err != nil {
			return 0, err
		}
		protocol := newHiveBoundedProtocol(thrift.NewTCompactProtocolConf(buffer, &thrift.TConfiguration{MaxMessageSize: hiveMaxMessageBytes}))
		vectors = make([]*hs.TColumn, len(columns))
		for i := range vectors {
			vectors[i] = hs.NewTColumn()
			if err := vectors[i].Read(ctx, protocol); err != nil {
				return 0, err
			}
		}
	}
	if len(vectors) > 0 {
		return hiveConsumeVectors(ctx, vectors, columns, consumer)
	}
	for _, row := range rows.Rows {
		if row == nil || len(row.ColVals) != len(columns) {
			return 0, fmt.Errorf("Hive row width does not match schema")
		}
		values := make([]any, len(columns))
		for i, column := range row.ColVals {
			value, err := hiveNormalizeResultCell(hiveLegacyValue(column), columns[i].Type)
			if err != nil {
				return 0, err
			}
			values[i] = value
		}
		if err := hiveConsumeValues(ctx, columns, values, consumer); err != nil {
			return 0, err
		}
	}
	return len(rows.Rows), nil
}

func hiveConsumeVectors(ctx context.Context, vectors []*hs.TColumn, columns []connection.ColumnDefinition, consumer QueryStreamConsumer) (int, error) {
	if len(vectors) != len(columns) {
		return 0, fmt.Errorf("Hive column count does not match schema")
	}
	count := 0
	for i, column := range vectors {
		length := hiveVectorLength(column)
		if length < 0 || (i > 0 && length != count) {
			return 0, fmt.Errorf("Hive column vector lengths do not match")
		}
		count = length
	}
	for row := 0; row < count; row++ {
		values := make([]any, len(columns))
		for column, vector := range vectors {
			value, err := hiveVectorValue(vector, row)
			if err != nil {
				return row, err
			}
			normalized, err := hiveNormalizeResultCell(value, columns[column].Type)
			if err != nil {
				return row, err
			}
			values[column] = normalized
		}
		if err := hiveConsumeValues(ctx, columns, values, consumer); err != nil {
			return row, err
		}
	}
	return count, nil
}

func hiveVectorLength(column *hs.TColumn) int {
	if column == nil {
		return -1
	}
	switch {
	case column.BoolVal != nil:
		return len(column.BoolVal.Values)
	case column.ByteVal != nil:
		return len(column.ByteVal.Values)
	case column.I16Val != nil:
		return len(column.I16Val.Values)
	case column.I32Val != nil:
		return len(column.I32Val.Values)
	case column.I64Val != nil:
		return len(column.I64Val.Values)
	case column.DoubleVal != nil:
		return len(column.DoubleVal.Values)
	case column.StringVal != nil:
		return len(column.StringVal.Values)
	case column.BinaryVal != nil:
		return len(column.BinaryVal.Values)
	}
	return -1
}
func hiveVectorValue(column *hs.TColumn, row int) (any, error) {
	var nulls []byte
	var value any
	switch {
	case column.BoolVal != nil:
		nulls, value = column.BoolVal.Nulls, column.BoolVal.Values[row]
	case column.ByteVal != nil:
		nulls, value = column.ByteVal.Nulls, column.ByteVal.Values[row]
	case column.I16Val != nil:
		nulls, value = column.I16Val.Nulls, column.I16Val.Values[row]
	case column.I32Val != nil:
		nulls, value = column.I32Val.Nulls, column.I32Val.Values[row]
	case column.I64Val != nil:
		nulls, value = column.I64Val.Nulls, column.I64Val.Values[row]
	case column.DoubleVal != nil:
		nulls, value = column.DoubleVal.Nulls, column.DoubleVal.Values[row]
	case column.StringVal != nil:
		nulls, value = column.StringVal.Nulls, column.StringVal.Values[row]
	case column.BinaryVal != nil:
		nulls, value = column.BinaryVal.Nulls, column.BinaryVal.Values[row]
	default:
		return nil, fmt.Errorf("unsupported Hive column union")
	}
	if row/8 < len(nulls) && nulls[row/8]&(1<<uint(row%8)) != 0 {
		return nil, nil
	}
	return value, nil
}
func hiveLegacyValue(column *hs.TColumnValue) any {
	if column == nil {
		return nil
	}
	switch {
	case column.BoolVal != nil:
		if column.BoolVal.Value != nil {
			return *column.BoolVal.Value
		}
	case column.ByteVal != nil:
		if column.ByteVal.Value != nil {
			return *column.ByteVal.Value
		}
	case column.I16Val != nil:
		if column.I16Val.Value != nil {
			return *column.I16Val.Value
		}
	case column.I32Val != nil:
		if column.I32Val.Value != nil {
			return *column.I32Val.Value
		}
	case column.I64Val != nil:
		if column.I64Val.Value != nil {
			return *column.I64Val.Value
		}
	case column.DoubleVal != nil:
		if column.DoubleVal.Value != nil {
			return *column.DoubleVal.Value
		}
	case column.StringVal != nil:
		if column.StringVal.Value != nil {
			return *column.StringVal.Value
		}
	}
	return nil
}
func hiveNormalizeValue(value any, typeName string) any {
	if value == nil {
		return nil
	}
	if strings.EqualFold(typeName, "BINARY") {
		switch v := value.(type) {
		case []byte:
			return "0x" + hex.EncodeToString(v)
		case string:
			return "0x" + hex.EncodeToString([]byte(v))
		}
	}
	return normalizeQueryValue(value)
}
func hiveConsumeValues(ctx context.Context, columns []connection.ColumnDefinition, values []any, consumer QueryStreamConsumer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if fast, ok := consumer.(QueryStreamValueConsumer); ok {
		return fast.ConsumeRowValues(values)
	}
	row := make(map[string]any, len(columns))
	for i, column := range columns {
		row[column.Name] = values[i]
	}
	return consumer.ConsumeRow(row)
}

type hiveRowCollector struct {
	names  []string
	rows   []map[string]interface{}
	budget *RowBudget
}

func (c *hiveRowCollector) SetColumns(names []string) error {
	c.names = append([]string(nil), names...)
	return nil
}
func (c *hiveRowCollector) ConsumeRow(row map[string]interface{}) error {
	if !c.budget.CanMaterializeRow(len(c.rows)) {
		return errHiveBudgetStop
	}
	bounded, truncated := boundQueryRowFields(row, c.budget.MaxFieldBytes())
	if truncated {
		c.budget.MarkFieldTruncated()
	}
	if !c.budget.ConsumeRow(estimateQueryRowBytes(bounded)) {
		return errHiveBudgetStop
	}
	c.rows = append(c.rows, bounded)
	return nil
}
