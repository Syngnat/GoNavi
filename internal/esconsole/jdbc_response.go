package esconsole

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// IsQueryPluginRoute 报告控制台路由是否为 OpenSearch SQL / PPL 查询（不含 explain），其响应可以按表格展示。
func IsQueryPluginRoute(route string) bool {
	return route == "/_plugins/_sql" || route == "/_plugins/_ppl"
}

// ParseJDBCResponse 把 OpenSearch SQL / PPL 插件默认的 jdbc 格式响应
// {"schema":[{"name","alias","type"}],"datarows":[[...]]} 转成表格行；格式不符时返回 false，由调用方按原始 JSON 展示。
func ParseJDBCResponse(body []byte) ([]map[string]interface{}, []string, bool) {
	var payload struct {
		Schema []struct {
			Name  string `json:"name"`
			Alias string `json:"alias"`
		} `json:"schema"`
		Datarows [][]interface{} `json:"datarows"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil || len(payload.Schema) == 0 {
		return nil, nil, false
	}
	columns := make([]string, len(payload.Schema))
	seen := make(map[string]int, len(payload.Schema))
	for index, column := range payload.Schema {
		name := column.Alias
		if name == "" {
			name = column.Name
		}
		if name == "" {
			name = "column_" + strconv.Itoa(index+1)
		}
		// 同名列（如 SELECT a, a）用序号区分，避免行里互相覆盖。
		seen[name]++
		if seen[name] > 1 {
			name += "_" + strconv.Itoa(seen[name])
		}
		columns[index] = name
	}
	rows := make([]map[string]interface{}, 0, len(payload.Datarows))
	for _, values := range payload.Datarows {
		row := make(map[string]interface{}, len(columns))
		for index, column := range columns {
			if index < len(values) {
				row[column] = normalizeJDBCValue(values[index])
			} else {
				row[column] = nil
			}
		}
		rows = append(rows, row)
	}
	return rows, columns, true
}

// normalizeJDBCValue 把 json.Number 还原成整数或浮点数，嵌套对象与数组保持原样交给结果表格序列化。
func normalizeJDBCValue(value interface{}) interface{} {
	number, ok := value.(json.Number)
	if !ok {
		return value
	}
	if integer, err := number.Int64(); err == nil {
		return integer
	}
	if float, err := number.Float64(); err == nil {
		return float
	}
	return number.String()
}
