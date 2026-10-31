package app

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/dataexport"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

// These lexical values bypass the legacy date-looking-string normalization.
// Their string kind also keeps Parquet's conservative, exact string promotion.
type hiveExportText string
type hiveExportJSON string

// MarshalJSON emits a validated complex value without a second string encoding.
func (v hiveExportJSON) MarshalJSON() ([]byte, error) { return []byte(v), nil }

func hiveExportConsumerMode(consumer db.QueryStreamConsumer) (normalize, textNull bool) {
	switch c := consumer.(type) {
	case *countingExportConsumer:
		return hiveExportConsumerMode(c.delegate)
	case *exportColumnProjectionConsumer:
		return hiveExportConsumerMode(c.delegate)
	case *hiveCSVFileWriter:
		return true, false
	case *csvExportFileWriter:
		return true, true
	case *xlsxExportFileWriter:
		return true, !c.losslessHive
	case *jsonExportFileWriter, *markdownExportFileWriter, *htmlExportFileWriter, *dataexport.Parquet:
		return true, false
	default:
		return false, false
	}
}

type hiveExportConsumer struct {
	delegate      db.QueryStreamConsumer
	columns       []string
	sourceColumns []string
	tableLabel    string
	columnTypes   map[string]string
	textNull      bool
}

func (c *hiveExportConsumer) SetColumns(columns []string) error {
	c.sourceColumns = append([]string(nil), columns...)
	c.columns = hiveExportBareColumns(columns, c.tableLabel)
	return c.delegate.SetColumns(c.columns)
}

// SetColumnDefinitions rejects values that cannot be reconstructed from Hive wire text.
func (c *hiveExportConsumer) SetColumnDefinitions(columns []connection.ColumnDefinition) error {
	c.columnTypes = make(map[string]string, len(columns))
	for _, column := range columns {
		if err := validateHiveExportColumnTypes([]connection.ColumnDefinition{column}); err != nil {
			return err
		}
		c.columnTypes[column.Name] = column.Type
	}
	return nil
}

func (c *hiveExportConsumer) validatedCell(source string, value interface{}) (interface{}, error) {
	if typeName := c.columnTypes[source]; typeName != "" {
		if _, err := hivesql.Value(typeName, value); err != nil {
			return nil, fmt.Errorf("Hive wire value is not losslessly representable: %w", err)
		}
	}
	return hiveExportCellValue(value, c.textNull)
}

func (c *hiveExportConsumer) ConsumeRow(row map[string]interface{}) error {
	normalized := make(map[string]interface{}, len(c.columns))
	for i, name := range c.columns {
		value, err := c.validatedCell(c.sourceColumns[i], row[c.sourceColumns[i]])
		if err != nil {
			return fmt.Errorf("export Hive column %q: %w", name, err)
		}
		normalized[name] = value
	}
	return c.delegate.ConsumeRow(normalized)
}

func (c *hiveExportConsumer) ConsumeRowValues(values []interface{}) error {
	normalized := make([]interface{}, len(c.columns))
	for i := range c.columns {
		var value interface{}
		if i < len(values) {
			value = values[i]
		}
		cell, err := c.validatedCell(c.sourceColumns[i], value)
		if err != nil {
			return fmt.Errorf("export Hive column %q: %w", c.columns[i], err)
		}
		normalized[i] = cell
	}
	if target, ok := c.delegate.(exportValueStreamConsumer); ok {
		return target.ConsumeRowValues(normalized)
	}
	row := make(map[string]interface{}, len(c.columns))
	for i, name := range c.columns {
		row[name] = normalized[i]
	}
	return c.delegate.ConsumeRow(row)
}

func hiveExportCellValue(value interface{}, textNull bool) (interface{}, error) {
	if value == nil {
		if textNull {
			return hiveExportText("NULL"), nil
		}
		return nil, nil
	}
	value, err := hiveJSONSafeValue(value, 0)
	if err != nil {
		return nil, err
	}
	if value == nil {
		return hiveExportCellValue(nil, textNull)
	}
	switch v := value.(type) {
	case string:
		return hiveExportText(v), nil
	case map[string]interface{}, []interface{}:
		encoded, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		if len(encoded) > maxImportCellBytes {
			return nil, fmt.Errorf("Hive complex export value exceeds cell byte limit")
		}
		return hiveExportJSON(encoded), nil
	default:
		return value, nil
	}
}

func hiveJSONSafeValue(value interface{}, depth int) (interface{}, error) {
	if depth > 32 {
		return nil, fmt.Errorf("Hive export nesting exceeds 32")
	}
	switch v := value.(type) {
	case nil:
		return nil, nil
	case time.Time:
		return v.Format("2006-01-02 15:04:05.999999999"), nil
	case []byte:
		if v == nil {
			return nil, nil
		}
		return "0x" + hex.EncodeToString(v), nil
	case json.Number:
		if !jsonNumberSQLLiteralPattern.MatchString(v.String()) {
			return nil, fmt.Errorf("invalid Hive JSON number")
		}
		return v, nil
	case float32:
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			return nil, fmt.Errorf("non-finite Hive export number cannot be represented losslessly")
		}
		return v, nil
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, fmt.Errorf("non-finite Hive export number cannot be represented losslessly")
		}
		return v, nil
	}
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			return nil, nil
		}
		return hiveJSONSafeValue(rv.Elem().Interface(), depth+1)
	case reflect.Map:
		if rv.IsNil() {
			return nil, nil
		}
		out := make(map[string]interface{}, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			key := fmt.Sprint(iter.Key().Interface())
			if _, duplicate := out[key]; duplicate {
				return nil, fmt.Errorf("ambiguous Hive MAP key %q", key)
			}
			normalized, err := hiveJSONSafeValue(iter.Value().Interface(), depth+1)
			if err != nil {
				return nil, err
			}
			out[key] = normalized
		}
		return out, nil
	case reflect.Slice, reflect.Array:
		if rv.Kind() == reflect.Slice && rv.IsNil() {
			return nil, nil
		}
		out := make([]interface{}, rv.Len())
		for i := range out {
			normalized, err := hiveJSONSafeValue(rv.Index(i).Interface(), depth+1)
			if err != nil {
				return nil, err
			}
			out[i] = normalized
		}
		return out, nil
	default:
		return value, nil
	}
}
