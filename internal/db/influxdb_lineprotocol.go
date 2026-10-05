//go:build gonavi_full_drivers || gonavi_influxdb_driver

package db

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// influxPoint 是一个待写入的点：measurement + tag 构成 series key，字段值已按 schema 类型转换。
type influxPoint struct {
	measurement string
	tags        map[string]string
	fields      map[string]interface{}
	fieldTypes  map[string]string
	timestamp   *int64
}

var (
	influxMeasurementEscaper = strings.NewReplacer(`\`, `\\`, ",", `\,`, " ", `\ `)
	influxKeyEscaper         = strings.NewReplacer(`\`, `\\`, ",", `\,`, "=", `\=`, " ", `\ `)
	influxStringEscaper      = strings.NewReplacer(`\`, `\\`, `"`, `\"`)
)

// encode 生成一行 line protocol；没有字段时报错（line protocol 至少要一个字段）。
func (p influxPoint) encode() (string, error) {
	if len(p.fields) == 0 {
		return "", localizedDatabaseRuntimeError("db.backend.error.influxdb_field_required", map[string]any{"measurement": p.measurement})
	}
	var b strings.Builder
	b.WriteString(influxMeasurementEscaper.Replace(p.measurement))
	tagKeys := make([]string, 0, len(p.tags))
	for key, value := range p.tags {
		if value != "" {
			tagKeys = append(tagKeys, key)
		}
	}
	sort.Strings(tagKeys)
	for _, key := range tagKeys {
		b.WriteByte(',')
		b.WriteString(influxKeyEscaper.Replace(key))
		b.WriteByte('=')
		b.WriteString(influxKeyEscaper.Replace(p.tags[key]))
	}
	fieldKeys := make([]string, 0, len(p.fields))
	for key := range p.fields {
		fieldKeys = append(fieldKeys, key)
	}
	sort.Strings(fieldKeys)
	for index, key := range fieldKeys {
		if index == 0 {
			b.WriteByte(' ')
		} else {
			b.WriteByte(',')
		}
		b.WriteString(influxKeyEscaper.Replace(key))
		b.WriteByte('=')
		b.WriteString(influxEncodeFieldValue(p.fields[key], p.fieldTypes[key]))
	}
	if p.timestamp != nil {
		b.WriteByte(' ')
		b.WriteString(strconv.FormatInt(*p.timestamp, 10))
	}
	return b.String(), nil
}

func influxEncodeFieldValue(value interface{}, fieldType string) string {
	switch typed := value.(type) {
	case bool:
		return strconv.FormatBool(typed)
	case int64:
		if fieldType == "unsigned" {
			return strconv.FormatInt(typed, 10) + "u"
		}
		if fieldType == "float" {
			return strconv.FormatInt(typed, 10)
		}
		return strconv.FormatInt(typed, 10) + "i"
	case uint64:
		return strconv.FormatUint(typed, 10) + "u"
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case string:
		return `"` + influxStringEscaper.Replace(typed) + `"`
	}
	return `"` + influxStringEscaper.Replace(fmt.Sprint(value)) + `"`
}

// influxCoerceField 按字段类型转换网格值；schema 里没有的新字段按值推断（数字为 float，布尔为 boolean，其余为 string）。
func influxCoerceField(name string, schema influxMeasurementSchema, value interface{}) (interface{}, string, error) {
	field, known := schema.field(name)
	fieldType := field.fieldType
	if !known {
		switch value.(type) {
		case bool:
			fieldType = "boolean"
		case float64, int64, json.Number, int:
			fieldType = "float"
		default:
			fieldType = "string"
		}
	}
	text := strings.TrimSpace(fmt.Sprint(value))
	invalid := func() error {
		return localizedDatabaseRuntimeError("db.backend.error.influxdb_value_invalid", map[string]any{"field": name, "fieldType": fieldType, "value": fmt.Sprint(value)})
	}
	switch fieldType {
	case "integer":
		if integer, err := strconv.ParseInt(text, 10, 64); err == nil {
			return integer, fieldType, nil
		}
		if float, err := strconv.ParseFloat(text, 64); err == nil && float == float64(int64(float)) {
			return int64(float), fieldType, nil
		}
		return nil, fieldType, invalid()
	case "unsigned":
		if unsigned, err := strconv.ParseUint(text, 10, 64); err == nil {
			return unsigned, fieldType, nil
		}
		return nil, fieldType, invalid()
	case "float":
		if float, err := strconv.ParseFloat(text, 64); err == nil {
			return float, fieldType, nil
		}
		return nil, fieldType, invalid()
	case "boolean":
		if typed, ok := value.(bool); ok {
			return typed, fieldType, nil
		}
		switch strings.ToLower(text) {
		case "true", "t", "1", "yes", "y":
			return true, fieldType, nil
		case "false", "f", "0", "no", "n":
			return false, fieldType, nil
		}
		return nil, fieldType, invalid()
	}
	if typed, ok := value.(string); ok {
		return typed, fieldType, nil
	}
	return text, fieldType, nil
}

// influxParseTimestamp 把网格里的时间（RFC3339 文本、常见日期写法或纳秒整数）转成纳秒；空值返回 nil，由服务端取当前时间。
func influxParseTimestamp(value interface{}) (*int64, error) {
	invalid := func() error {
		return localizedDatabaseRuntimeError("db.backend.error.influxdb_value_invalid", map[string]any{"field": influxTimeColumn, "fieldType": "timestamp", "value": fmt.Sprint(value)})
	}
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case int64:
		return &typed, nil
	case float64:
		nanos := int64(typed)
		return &nanos, nil
	case json.Number:
		nanos, err := typed.Int64()
		if err != nil {
			return nil, invalid()
		}
		return &nanos, nil
	case time.Time:
		nanos := typed.UnixNano()
		return &nanos, nil
	}
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" {
		return nil, nil
	}
	if nanos, err := strconv.ParseInt(text, 10, 64); err == nil {
		return &nanos, nil
	}
	if normalized, ok := normalizeRegistryDate(text); ok {
		if parsed, err := time.Parse(time.RFC3339Nano, normalized); err == nil {
			nanos := parsed.UnixNano()
			return &nanos, nil
		}
	}
	return nil, invalid()
}

// influxLineProtocolTemplate 生成写入模板：tag 用占位值，字段按类型给零值。
func influxLineProtocolTemplate(measurement string, schema influxMeasurementSchema) string {
	point := influxPoint{measurement: measurement, tags: map[string]string{}, fields: map[string]interface{}{}, fieldTypes: map[string]string{}}
	for _, tag := range schema.tags {
		point.tags[tag] = "<" + tag + ">"
	}
	for _, field := range schema.fields {
		point.fieldTypes[field.name] = field.fieldType
		switch field.fieldType {
		case "integer":
			point.fields[field.name] = int64(0)
		case "unsigned":
			point.fields[field.name] = uint64(0)
		case "boolean":
			point.fields[field.name] = false
		case "string":
			point.fields[field.name] = ""
		default:
			point.fields[field.name] = float64(0)
		}
	}
	if len(point.fields) == 0 {
		point.fields["value"] = float64(0)
	}
	line, _ := point.encode()
	return line
}
