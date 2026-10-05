//go:build gonavi_full_drivers || gonavi_presto_driver

package db

import (
	"encoding/base64"
	"strings"
)

// Presto 的结果以 JSON 返回：数值是 JSON 数字，decimal、时间、uuid 等是服务端格式化好的字符串，varbinary 是 base64。
// array / map / row 在 PrestoSQL 里是 JSON 数组与对象，PrestoDB 0.29x 则是排版过的 JSON 文本（带空格与换行），
// 两种形式都转为结构化值，显示与 Trino 连接一致；其余值交给通用归一（大整数转字符串等）。

func prestoColumnNames(columns []prestoColumn) []string {
	names := make([]string, len(columns))
	for i, column := range columns {
		names[i] = column.Name
	}
	return ensureUniqueQueryColumnNames(names)
}

// prestoBaseType 取类型名的基础部分：varchar(10) → varchar，array(varchar) → array，timestamp(3) with time zone → timestamp。
func prestoBaseType(typeName string) string {
	text := strings.ToLower(strings.TrimSpace(typeName))
	if index := strings.IndexAny(text, "( "); index >= 0 {
		text = text[:index]
	}
	return text
}

func convertPrestoValue(typeName string, value interface{}) interface{} {
	if value == nil {
		return nil
	}
	text, isText := value.(string)
	if !isText {
		return normalizeQueryValue(value)
	}
	switch prestoBaseType(typeName) {
	case "varbinary":
		if decoded, err := base64.StdEncoding.DecodeString(text); err == nil {
			return normalizeQueryValueWithDBType(decoded, "VARBINARY")
		}
	case "array", "map", "row":
		var decoded interface{}
		if err := decodeJSONWithUseNumber([]byte(text), &decoded); err == nil {
			return normalizeQueryValue(decoded)
		}
	}
	return text
}

func prestoRowValues(columns []prestoColumn, raw []interface{}) []interface{} {
	values := make([]interface{}, len(columns))
	for i, column := range columns {
		if i < len(raw) {
			values[i] = convertPrestoValue(column.Type, raw[i])
		}
	}
	return values
}

func prestoRowMap(names []string, values []interface{}) map[string]interface{} {
	row := make(map[string]interface{}, len(names))
	for i, name := range names {
		row[name] = values[i]
	}
	return row
}

// prestoRowCollector 把结果收集为行映射；达到结果预算后停止取数并取消服务端查询。
// skip 是模拟 OFFSET 时需要丢弃的前导行数。
type prestoRowCollector struct {
	budget *RowBudget
	skip   int64
	names  []string
	data   []map[string]interface{}
}

func (c *prestoRowCollector) columns(columns []prestoColumn) error {
	c.names = prestoColumnNames(columns)
	if c.data == nil {
		c.data = make([]map[string]interface{}, 0)
	}
	return nil
}

func (c *prestoRowCollector) rows(columns []prestoColumn, page [][]interface{}) error {
	for _, raw := range page {
		if c.skip > 0 {
			c.skip--
			continue
		}
		if !c.budget.CanMaterializeRow(len(c.data)) {
			return errPrestoStopFetching
		}
		row, fieldTruncated := boundQueryRowFields(prestoRowMap(c.names, prestoRowValues(columns, raw)), c.budget.MaxFieldBytes())
		if fieldTruncated {
			c.budget.MarkFieldTruncated()
		}
		if !c.budget.ConsumeRow(estimateQueryRowBytes(row)) {
			return errPrestoStopFetching
		}
		c.data = append(c.data, row)
	}
	return nil
}

// prestoStreamSink 把结果逐行交给流式消费者（导出等），不在内存里累积。
type prestoStreamSink struct {
	consumer QueryStreamConsumer
	skip     int64
	names    []string
}

func (s *prestoStreamSink) columns(columns []prestoColumn) error {
	s.names = prestoColumnNames(columns)
	return s.consumer.SetColumns(s.names)
}

func (s *prestoStreamSink) rows(columns []prestoColumn, page [][]interface{}) error {
	valueConsumer, fastPath := s.consumer.(QueryStreamValueConsumer)
	for _, raw := range page {
		if s.skip > 0 {
			s.skip--
			continue
		}
		values := prestoRowValues(columns, raw)
		var err error
		if fastPath {
			err = valueConsumer.ConsumeRowValues(values)
		} else {
			err = s.consumer.ConsumeRow(prestoRowMap(s.names, values))
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// prestoSingleColumn 收集第一列的非空文本（SHOW CATALOGS / SHOW SCHEMAS / SHOW TABLES）。
type prestoSingleColumn struct {
	values []string
}

func (c *prestoSingleColumn) columns([]prestoColumn) error { return nil }

func (c *prestoSingleColumn) rows(_ []prestoColumn, page [][]interface{}) error {
	for _, raw := range page {
		if len(raw) == 0 || raw[0] == nil {
			continue
		}
		if text, ok := raw[0].(string); ok && strings.TrimSpace(text) != "" {
			c.values = append(c.values, text)
		}
	}
	return nil
}
