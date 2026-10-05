package db

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"regexp"
	"sort"
	"strings"
)

// 搜索引擎类数据源（Meilisearch、Typesense 等）的 REST 控制台共用：解析「METHOD /path，换行后跟请求体」形式的请求，
// 把响应转成表格。不依赖驱动代理，app 层的读写分类也会用到。用到这里的驱动要在 sourcePrefixes 里加 document_rest。

// documentRESTRequest 是控制台里的一个 REST 请求。
type documentRESTRequest struct {
	method string
	path   string
	body   []byte
}

var documentRESTLine = regexp.MustCompile(`^(?i)(GET|HEAD|POST|PUT|PATCH|DELETE)\s+(/\S*)\s*$`)

// parseDocumentRESTRequests 解析一段 REST 请求：每个以「METHOD /path」开头的行开始一个请求，
// 之后到下一个请求行之间的内容是请求体（建表语句页给出的脚本即是多个请求）。不是 REST 文本时返回 false。
func parseDocumentRESTRequests(text string) ([]documentRESTRequest, bool) {
	lines := strings.Split(strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n")), "\n")
	requests := make([]documentRESTRequest, 0, 1)
	var body []string
	flush := func() {
		if len(requests) == 0 {
			return
		}
		if trimmed := bytes.TrimSpace([]byte(strings.Join(body, "\n"))); len(trimmed) > 0 {
			requests[len(requests)-1].body = trimmed
		}
		body = body[:0]
	}
	for _, line := range lines {
		if match := documentRESTLine.FindStringSubmatch(strings.TrimSpace(line)); match != nil {
			flush()
			requests = append(requests, documentRESTRequest{method: strings.ToUpper(match[1]), path: match[2]})
			continue
		}
		if len(requests) == 0 {
			if strings.TrimSpace(line) == "" {
				continue
			}
			return nil, false
		}
		body = append(body, line)
	}
	flush()
	return requests, len(requests) > 0
}

// pathWithoutQuery 去掉查询串。
func (r documentRESTRequest) pathWithoutQuery() string {
	path, _, _ := strings.Cut(r.path, "?")
	return path
}

// documentRESTRows 把 REST 响应转成表格：数组或 JSON Lines 逐项一行，对象里有 listKeys 中的列表字段时展开该列表，
// 其余对象作为单行。item 把列表项转成行（nil 时对象原样作为行、标量放进 value 列）。
// leading 是优先排在前面的列（如索引字段顺序），其余列按名称排序，下划线开头的元数据列在最后。
func documentRESTRows(body []byte, leading []string, item func(interface{}) map[string]interface{}, listKeys ...string) ([]map[string]interface{}, []string) {
	if item == nil {
		item = documentRESTItemRow
	}
	rows := make([]map[string]interface{}, 0)
	appendItems := func(items []interface{}) {
		for _, value := range items {
			rows = append(rows, item(value))
		}
	}
	var payload interface{}
	switch {
	case len(bytes.TrimSpace(body)) == 0:
	case decodeSingleJSONValue(body, &payload):
		switch typed := payload.(type) {
		case []interface{}:
			appendItems(typed)
		case map[string]interface{}:
			expanded := false
			for _, key := range listKeys {
				if items, ok := typed[key].([]interface{}); ok {
					appendItems(items)
					expanded = true
					break
				}
			}
			if !expanded {
				rows = append(rows, typed)
			}
		default:
			rows = append(rows, map[string]interface{}{"value": typed})
		}
	default:
		lines, ok := decodeJSONLines(body)
		if !ok {
			row := map[string]interface{}{"response": string(body)}
			return []map[string]interface{}{row}, []string{"response"}
		}
		appendItems(lines)
	}
	columns := documentRowColumns(rows, leading)
	fillDocumentRows(rows, columns)
	return rows, columns
}

func documentRESTItemRow(value interface{}) map[string]interface{} {
	if object, ok := value.(map[string]interface{}); ok {
		return object
	}
	return map[string]interface{}{"value": value}
}

// decodeSingleJSONValue 解码恰好一个 JSON 值；后面还有内容（JSON Lines）或不是 JSON 时返回 false。
func decodeSingleJSONValue(body []byte, out *interface{}) bool {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if decoder.Decode(out) != nil || decoder.More() {
		return false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return false
	}
	normalizeDecodedJSONNumbers(out)
	return true
}

// decodeJSONLines 解码 JSON Lines（如 Typesense 的导出接口）；有任何一行不是 JSON 时返回 false。
func decodeJSONLines(body []byte) ([]interface{}, bool) {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64*1024), maxRemoteJSONResponseBytes)
	items := make([]interface{}, 0)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var value interface{}
		if decodeJSONWithUseNumber(line, &value) != nil {
			return nil, false
		}
		items = append(items, value)
	}
	return items, scanner.Err() == nil && len(items) > 0
}

// documentRowColumns 汇总各行的列：leading 与 uid / id 在前，其余按名称排序，下划线开头的元数据列在最后。
func documentRowColumns(rows []map[string]interface{}, leading []string) []string {
	seen := map[string]bool{}
	for _, row := range rows {
		for key := range row {
			seen[key] = true
		}
	}
	columns := make([]string, 0, len(seen))
	placed := map[string]bool{}
	for _, name := range append(append([]string{}, leading...), "uid", "id") {
		if seen[name] && !placed[name] {
			placed[name] = true
			columns = append(columns, name)
		}
	}
	rest, meta := make([]string, 0, len(seen)), make([]string, 0)
	for name := range seen {
		switch {
		case placed[name]:
		case strings.HasPrefix(name, "_"):
			meta = append(meta, name)
		default:
			rest = append(rest, name)
		}
	}
	sort.Strings(rest)
	sort.Strings(meta)
	return append(append(columns, rest...), meta...)
}

// fillDocumentRows 让每行都含全部列：文档缺失的字段补 nil，结果表格显示 NULL 而不是 undefined。
func fillDocumentRows(rows []map[string]interface{}, columns []string) {
	for _, row := range rows {
		for _, column := range columns {
			if _, ok := row[column]; !ok {
				row[column] = nil
			}
		}
	}
}

func copyDocument(document map[string]interface{}) map[string]interface{} {
	copied := make(map[string]interface{}, len(document))
	for key, value := range document {
		copied[key] = value
	}
	return copied
}
