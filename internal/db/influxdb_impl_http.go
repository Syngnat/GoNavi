//go:build gonavi_full_drivers || gonavi_influxdb_driver

package db

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// influxHTTPError 是服务端已返回的 HTTP 错误；传输层错误不是这个类型，写入时据此判断结果是否未知。
type influxHTTPError struct {
	status  int
	message string
}

func (e *influxHTTPError) Error() string { return e.message }

func (x *InfluxDB) request(ctx context.Context, method, path string, contentType *string, body []byte) (int, http.Header, []byte, error) {
	if x.client == nil {
		return 0, nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(x.baseURL, "/")+path, reader)
	if err != nil {
		return 0, nil, nil, err
	}
	if contentType != nil {
		req.Header.Set("Content-Type", *contentType)
	}
	req.Header.Set("Accept", "application/json")
	for key, value := range x.headers {
		req.Header.Set(key, value)
	}
	res, err := x.client.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer res.Body.Close()
	resBody, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return 0, nil, nil, err
	}
	return res.StatusCode, res.Header, resBody, nil
}

func (x *InfluxDB) httpError(method, path string, status int, body []byte) error {
	detail := influxErrorDetail(body)
	if detail == "" {
		detail = http.StatusText(status)
	}
	return &influxHTTPError{
		status: status,
		message: localizedDriverRuntimeText("db.backend.error.influxdb_request_failed", map[string]any{
			"method": method,
			"path":   strings.SplitN(path, "?", 2)[0],
			"detail": detail,
		}),
	}
}

// influxErrorDetail 取出 {"error": "..."}、{"message": "..."} 或 {"results":[{"error": ...}]} 中的错误说明。
func influxErrorDetail(body []byte) string {
	var payload struct {
		Error   string `json:"error"`
		Message string `json:"message"`
		Results []struct {
			Error string `json:"error"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &payload); err == nil {
		for _, text := range []string{payload.Error, payload.Message} {
			if strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
		}
		for _, result := range payload.Results {
			if strings.TrimSpace(result.Error) != "" {
				return strings.TrimSpace(result.Error)
			}
		}
	}
	return strings.TrimSpace(string(body))
}

func (x *InfluxDB) doJSON(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	var payload []byte
	var contentType *string
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = encoded
		jsonType := "application/json"
		contentType = &jsonType
	}
	status, _, resBody, err := x.request(ctx, method, path, contentType, payload)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return x.httpError(method, path, status, resBody)
	}
	if out == nil || len(bytes.TrimSpace(resBody)) == 0 {
		return nil
	}
	return decodeJSONWithUseNumber(resBody, out)
}

type influxQLSeries struct {
	Name    string            `json:"name"`
	Tags    map[string]string `json:"tags"`
	Columns []string          `json:"columns"`
	Values  [][]interface{}   `json:"values"`
}

type influxQLResult struct {
	StatementID int              `json:"statement_id"`
	Series      []influxQLSeries `json:"series"`
	Error       string           `json:"error"`
}

// influxQL 执行 InfluxQL（三个大版本都提供 v1 兼容的 /query）；write 为 true 时用 POST（1.x 的写语句必须 POST）。
func (x *InfluxDB) influxQL(ctx context.Context, database, query string, write bool) ([]influxQLResult, error) {
	values := url.Values{"q": {query}}
	if database != "" {
		values.Set("db", database)
	}
	method := http.MethodGet
	path := "/query?" + values.Encode()
	var body []byte
	var contentType *string
	if write {
		method = http.MethodPost
		path = "/query"
		body = []byte(values.Encode())
		formType := "application/x-www-form-urlencoded"
		contentType = &formType
	}
	status, _, resBody, err := x.request(ctx, method, path, contentType, body)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, x.httpError(method, "/query", status, resBody)
	}
	var payload struct {
		Results []influxQLResult `json:"results"`
		Error   string           `json:"error"`
	}
	if err := decodeJSONWithUseNumber(resBody, &payload); err != nil {
		return nil, err
	}
	if payload.Error != "" {
		return nil, x.httpError(method, "/query", status, resBody)
	}
	for _, result := range payload.Results {
		if result.Error != "" {
			// 语句级错误是服务端已处理的结果（写入不会是“结果未知”）。
			return nil, &influxHTTPError{status: status, message: localizedDriverRuntimeText("db.backend.error.influxdb_query_failed", map[string]any{"detail": result.Error})}
		}
	}
	return payload.Results, nil
}

// listBuckets 列出 2.x 的 bucket（分页读取），limit 大于 0 时最多返回 limit 个。
func (x *InfluxDB) listBuckets(ctx context.Context, limit int) ([]string, error) {
	const pageSize = 100
	names := make([]string, 0)
	for offset := 0; ; offset += pageSize {
		query := url.Values{"limit": {strconv.Itoa(pageSize)}, "offset": {strconv.Itoa(offset)}}
		if x.org != "" {
			query.Set("org", x.org)
		}
		var payload struct {
			Buckets []struct {
				Name string `json:"name"`
			} `json:"buckets"`
		}
		if err := x.doJSON(ctx, http.MethodGet, "/api/v2/buckets?"+query.Encode(), nil, &payload); err != nil {
			return nil, err
		}
		for _, bucket := range payload.Buckets {
			names = append(names, bucket.Name)
			if limit > 0 && len(names) >= limit {
				return names, nil
			}
		}
		if len(payload.Buckets) < pageSize {
			return names, nil
		}
	}
}

// listV3Databases 列出 3.x 的数据库（/api/v3/configure/database 返回 [{"iox::database": "name"}]）。
func (x *InfluxDB) listV3Databases(ctx context.Context) ([]string, error) {
	var rows []map[string]interface{}
	if err := x.doJSON(ctx, http.MethodGet, "/api/v3/configure/database?format=json", nil, &rows); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		if name, ok := row["iox::database"].(string); ok && name != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

// sqlV3 执行 3.x 的 SQL（/api/v3/query_sql，JSON 格式），列顺序取首行对象的字段顺序。
func (x *InfluxDB) sqlV3(ctx context.Context, database, query string) ([]map[string]interface{}, []string, error) {
	if database == "" {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.influxdb_database_required", nil)
	}
	jsonType := "application/json"
	payload, _ := json.Marshal(map[string]string{"db": database, "q": query, "format": "json"})
	status, _, body, err := x.request(ctx, http.MethodPost, "/api/v3/query_sql", &jsonType, payload)
	if err != nil {
		return nil, nil, err
	}
	if status < 200 || status >= 300 {
		return nil, nil, x.httpError(http.MethodPost, "/api/v3/query_sql", status, body)
	}
	var items []json.RawMessage
	if err := json.Unmarshal(body, &items); err != nil {
		return nil, nil, err
	}
	rows := make([]map[string]interface{}, 0, len(items))
	columns := make([]string, 0)
	seen := map[string]bool{}
	for _, item := range items {
		keys, err := orderedJSONKeys(item)
		if err != nil {
			return nil, nil, err
		}
		for _, key := range keys {
			if !seen[key] {
				seen[key] = true
				columns = append(columns, key)
			}
		}
		var row map[string]interface{}
		if err := decodeJSONWithUseNumber(item, &row); err != nil {
			return nil, nil, err
		}
		for key, value := range row {
			row[key] = influxValue(value)
		}
		rows = append(rows, row)
	}
	fillInfluxRows(rows, columns)
	return rows, columns, nil
}

// orderedJSONKeys 按出现顺序返回 JSON 对象的顶层键（map 解码会丢失顺序）。
func orderedJSONKeys(raw json.RawMessage) ([]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, errors.New("expected a JSON object")
	}
	keys := make([]string, 0, 8)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, _ := token.(string)
		keys = append(keys, key)
		var skip json.RawMessage
		if err := decoder.Decode(&skip); err != nil {
			return nil, err
		}
	}
	return keys, nil
}

// flux 执行 2.x 的 Flux 查询，响应是带 #datatype 注释的 CSV：每张表一段表头，空行分隔。
func (x *InfluxDB) flux(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if x.org == "" {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.influxdb_org_required", nil)
	}
	jsonType := "application/json"
	payload, _ := json.Marshal(map[string]interface{}{
		"query":   query,
		"type":    "flux",
		"dialect": map[string]interface{}{"header": true, "annotations": []string{"datatype"}},
	})
	path := "/api/v2/query?" + url.Values{"org": {x.org}}.Encode()
	status, _, body, err := x.request(ctx, http.MethodPost, path, &jsonType, payload)
	if err != nil {
		return nil, nil, err
	}
	if status < 200 || status >= 300 {
		return nil, nil, x.httpError(http.MethodPost, "/api/v2/query", status, body)
	}
	return parseFluxCSV(body)
}

// parseFluxCSV 解析 Flux 注释 CSV：#datatype 行决定类型，空行开始新表；去掉恒为空的首列与 result 列。
func parseFluxCSV(body []byte) ([]map[string]interface{}, []string, error) {
	reader := csv.NewReader(bytes.NewReader(body))
	reader.FieldsPerRecord = -1
	rows := make([]map[string]interface{}, 0)
	columns := make([]string, 0)
	seen := map[string]bool{}
	var header, types []string
	for {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, nil, err
		}
		if len(record) == 0 || (len(record) == 1 && strings.TrimSpace(record[0]) == "") {
			header, types = nil, nil
			continue
		}
		if strings.HasPrefix(record[0], "#datatype") {
			types = record
			header = nil
			continue
		}
		if strings.HasPrefix(record[0], "#") {
			continue
		}
		if header == nil {
			header = record
			for index, name := range header {
				if index == 0 || name == "" || name == "result" || seen[name] {
					continue
				}
				seen[name] = true
				columns = append(columns, name)
			}
			continue
		}
		row := make(map[string]interface{}, len(header))
		for index, name := range header {
			if index == 0 || name == "" || name == "result" || index >= len(record) {
				continue
			}
			dataType := ""
			if index < len(types) {
				dataType = types[index]
			}
			row[name] = fluxValue(record[index], dataType)
		}
		rows = append(rows, row)
	}
	fillInfluxRows(rows, columns)
	return rows, columns, nil
}

func fluxValue(text, dataType string) interface{} {
	if text == "" && dataType != "string" {
		return nil
	}
	switch dataType {
	case "long":
		if value, err := strconv.ParseInt(text, 10, 64); err == nil {
			return value
		}
	case "unsignedLong":
		if value, err := strconv.ParseUint(text, 10, 64); err == nil {
			return value
		}
	case "double":
		if value, err := strconv.ParseFloat(text, 64); err == nil {
			return value
		}
	case "boolean":
		return text == "true"
	case "dateTime:RFC3339", "dateTime:RFC3339Nano":
		if parsed, err := time.Parse(time.RFC3339Nano, text); err == nil {
			return parsed.UTC().Format(time.RFC3339Nano)
		}
	}
	return text
}

func influxValue(value interface{}) interface{} {
	if number, ok := value.(json.Number); ok {
		if integer, err := number.Int64(); err == nil {
			return integer
		}
		if float, err := number.Float64(); err == nil {
			return float
		}
		return number.String()
	}
	return value
}

// fillInfluxRows 让每行都含全部列，缺失值补 nil，结果表格显示 NULL 而不是 undefined。
func fillInfluxRows(rows []map[string]interface{}, columns []string) {
	for _, row := range rows {
		for _, column := range columns {
			if _, ok := row[column]; !ok {
				row[column] = nil
			}
		}
	}
}
