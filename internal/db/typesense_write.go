//go:build gonavi_full_drivers || gonavi_typesense_driver

package db

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (t *TypesenseDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultTypesenseQueryTimeout)
	defer cancel()
	return t.ExecContext(ctx, query)
}

// ExecContext 执行控制台里的写请求：REST（POST / PUT / PATCH / DELETE，导入接口的请求体是 JSON Lines），
// 以及对象操作用到的 DROP TABLE、TRUNCATE、DELETE FROM … [WHERE …]。返回受影响的文档数。
func (t *TypesenseDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if t.client == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	text := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(query), ";"))
	if requests, ok := parseDocumentRESTRequests(text); ok {
		var total int64
		for _, request := range requests {
			affected, err := t.execRequest(ctx, request)
			if err != nil {
				return total, err
			}
			total += affected
		}
		return total, nil
	}
	return t.execSQLWrite(ctx, text)
}

func (t *TypesenseDB) execRequest(ctx context.Context, request documentRESTRequest) (int64, error) {
	isImport := strings.Contains(request.pathWithoutQuery(), "/documents/import")
	if request.body != nil && !isImport && !json.Valid(request.body) {
		return 0, localizedDatabaseRuntimeError("db.backend.error.typesense_body_invalid", nil)
	}
	defer t.invalidate(typesensePathCollection(request.path))
	body, err := t.doRaw(ctx, request.method, request.path, request.body)
	if err != nil {
		return 0, typesenseWriteError(err)
	}
	if isImport {
		return typesenseImportResult(body)
	}
	var payload map[string]interface{}
	if decodeJSONWithUseNumber(body, &payload) == nil {
		if deleted, ok := documentNumber(payload["num_deleted"]); ok {
			return int64(deleted), nil
		}
	}
	return 1, nil
}

// typesenseImportResult 汇总导入结果（每行一个 {"success": …}）：有失败行时报告失败数与第一条原因。
func typesenseImportResult(body []byte) (int64, error) {
	var succeeded, failed int64
	firstError := ""
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64*1024), maxRemoteJSONResponseBytes)
	for scanner.Scan() {
		var line struct {
			Success bool   `json:"success"`
			Error   string `json:"error"`
		}
		if json.Unmarshal(bytes.TrimSpace(scanner.Bytes()), &line) != nil {
			continue
		}
		if line.Success {
			succeeded++
			continue
		}
		failed++
		if firstError == "" {
			firstError = line.Error
		}
	}
	if failed > 0 {
		return succeeded, localizedDatabaseRuntimeError("db.backend.error.typesense_import_failed", map[string]any{
			"failed": failed, "total": failed + succeeded, "detail": firstError,
		})
	}
	return succeeded, nil
}

// typesensePathCollection 取路径里的集合名（/collections/{name}/...）；不针对单个集合时返回空串。
func typesensePathCollection(path string) string {
	path, _, _ = strings.Cut(path, "?")
	rest, ok := strings.CutPrefix(path, "/collections/")
	if !ok {
		return ""
	}
	segment, _, _ := strings.Cut(rest, "/")
	name, err := url.PathUnescape(segment)
	if err != nil {
		return segment
	}
	return name
}

var (
	typesenseDropPattern     = regexp.MustCompile(`(?is)^DROP\s+(?:TABLE|COLLECTION)\s+(?:IF\s+EXISTS\s+)?(.+)$`)
	typesenseTruncatePattern = regexp.MustCompile(`(?is)^TRUNCATE\s+(?:TABLE\s+)?(.+)$`)
	typesenseDeletePattern   = regexp.MustCompile(`(?is)^DELETE\s+FROM\s+`)
)

// execSQLWrite 执行 SQL 形式的对象操作：删除集合、清空文档、按条件删除文档。
func (t *TypesenseDB) execSQLWrite(ctx context.Context, text string) (int64, error) {
	if match := typesenseDropPattern.FindStringSubmatch(text); match != nil {
		name := unquoteDocumentIdent(match[1])
		defer t.invalidate("")
		_, err := t.doRaw(ctx, http.MethodDelete, typesenseCollectionPath(name, ""), nil)
		return 0, typesenseWriteError(err)
	}
	if match := typesenseTruncatePattern.FindStringSubmatch(text); match != nil {
		return t.deleteDocuments(ctx, unquoteDocumentIdent(match[1]), nil)
	}
	if typesenseDeletePattern.MatchString(text) {
		name := parseSQLFromName(text)
		if name == "" {
			return 0, localizedDatabaseRuntimeError("db.backend.error.typesense_write_unsupported", nil)
		}
		var where interface{}
		if whereAt := findSQLKeyword(text, "WHERE", 0); whereAt >= 0 {
			node, err := parseRegistryWhere(strings.TrimSpace(text[whereAt+len("WHERE"):]))
			if err != nil {
				return 0, err
			}
			where = node
		}
		return t.deleteDocuments(ctx, name, where)
	}
	return 0, localizedDatabaseRuntimeError("db.backend.error.typesense_write_unsupported", nil)
}

// deleteDocuments 删除满足条件的文档（where 为 nil 时清空集合）：条件能翻译时按 filter_by 删除，29 起清空用 truncate；
// 其余情况在客户端找出 id 后分批删除。
func (t *TypesenseDB) deleteDocuments(ctx context.Context, collection string, where interface{}) (int64, error) {
	meta, err := t.collectionMeta(ctx, collection)
	if err != nil {
		return 0, err
	}
	defer t.invalidate(meta.name)
	deleteByFilter := func(filter string) (int64, error) {
		var result struct {
			NumDeleted int64 `json:"num_deleted"`
		}
		path := typesenseCollectionPath(meta.name, "/documents?"+url.Values{"filter_by": {filter}}.Encode())
		err := t.doJSON(ctx, http.MethodDelete, path, nil, &result)
		return result.NumDeleted, typesenseWriteError(err)
	}
	if where == nil && t.supportsTruncate() {
		var result struct {
			NumDeleted int64 `json:"num_deleted"`
		}
		err := t.doJSON(ctx, http.MethodDelete, typesenseCollectionPath(meta.name, "/documents?truncate=true"), nil, &result)
		return result.NumDeleted, typesenseWriteError(err)
	}
	if where != nil {
		if filter, ok := t.nativeFilter(meta, where); ok {
			return deleteByFilter(filter)
		}
	}
	ids := make([]string, 0)
	if where == nil {
		err = t.visitDocuments(ctx, meta.name, func(document map[string]interface{}) error {
			ids = append(ids, typesenseIDText(document["id"]))
			return nil
		})
	} else {
		var matched []map[string]interface{}
		matched, err = t.scan(ctx, meta, where, nil)
		for _, document := range matched {
			ids = append(ids, typesenseIDText(document["id"]))
		}
	}
	if err != nil {
		return 0, err
	}
	var total int64
	for start := 0; start < len(ids); start += typesenseDeleteBatch {
		chunk := ids[start:min(start+typesenseDeleteBatch, len(ids))]
		if t.supportsExactFilter() {
			quoted := make([]string, 0, len(chunk))
			for _, id := range chunk {
				quoted = append(quoted, "`"+id+"`")
			}
			deleted, err := deleteByFilter("id:=[" + strings.Join(quoted, ",") + "]")
			if err != nil {
				return total, err
			}
			total += deleted
			continue
		}
		for _, id := range chunk {
			if err := t.deleteDocument(ctx, meta.name, id); err != nil {
				return total, err
			}
			total++
		}
	}
	return total, nil
}

func (t *TypesenseDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return t.ApplyChangesContext(context.Background(), tableName, changes)
}

// ApplyChangesContext 提交数据网格的增删改：文档按 id 逐个删除、部分更新（PATCH）与新建（id 已存在时服务端拒绝），
// 改 id 时新建合并后的文档再删除旧文档。Typesense 没有事务，中途失败时报告已生效的条数。
func (t *TypesenseDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if t.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	ctx, cancel := context.WithTimeout(ctx, defaultTypesenseQueryTimeout)
	defer cancel()
	meta, err := t.collectionMeta(ctx, tableName)
	if err != nil {
		return err
	}
	defer t.invalidate(meta.name)

	total := len(changes.Deletes) + len(changes.Updates) + len(changes.Inserts)
	applied := 0
	fail := func(err error) error {
		if applied == 0 {
			return err
		}
		wrapped := localizedDatabaseRuntimeError("db.backend.error.typesense_changes_partial", map[string]any{"applied": applied, "total": total, "detail": err.Error()})
		if IsWriteOutcomeUnknown(err) {
			return MarkWriteOutcomeUnknown(wrapped)
		}
		return wrapped
	}
	for _, keys := range changes.Deletes {
		id, err := typesenseRowID(keys, rowMutationActionDelete)
		if err != nil {
			return fail(err)
		}
		if err := t.deleteDocument(ctx, meta.name, id); err != nil {
			return fail(err)
		}
		applied++
	}
	for _, update := range changes.Updates {
		id, err := typesenseRowID(update.Keys, rowMutationActionUpdate)
		if err != nil {
			return fail(err)
		}
		values, err := typesenseCoerceDocument(meta, update.Values, false)
		if err != nil {
			return fail(err)
		}
		if newID, ok := values["id"]; ok && typesenseIDText(newID) != id {
			if err := t.moveDocument(ctx, meta.name, id, values); err != nil {
				return fail(err)
			}
			applied++
			continue
		}
		delete(values, "id")
		if len(values) > 0 {
			if err := t.doJSON(ctx, http.MethodPatch, typesenseDocumentPath(meta.name, id), values, nil); err != nil {
				return fail(typesenseDocumentError(err, id))
			}
		}
		applied++
	}
	for _, row := range changes.Inserts {
		document, err := typesenseCoerceDocument(meta, row, true)
		if err != nil {
			return fail(err)
		}
		if err := t.createDocument(ctx, meta.name, document); err != nil {
			return fail(err)
		}
		applied++
	}
	return nil
}

// moveDocument 改 id：读出旧文档，用合并后的内容新建文档，再删除旧文档。
func (t *TypesenseDB) moveDocument(ctx context.Context, collection, oldID string, values map[string]interface{}) error {
	var existing map[string]interface{}
	if err := t.doJSON(ctx, http.MethodGet, typesenseDocumentPath(collection, oldID), nil, &existing); err != nil {
		return typesenseDocumentError(err, oldID)
	}
	for key, value := range values {
		if value == nil {
			delete(existing, key)
		} else {
			existing[key] = value
		}
	}
	if err := t.createDocument(ctx, collection, existing); err != nil {
		return err
	}
	return t.deleteDocument(ctx, collection, oldID)
}

func (t *TypesenseDB) createDocument(ctx context.Context, collection string, document map[string]interface{}) error {
	err := t.doJSON(ctx, http.MethodPost, typesenseCollectionPath(collection, "/documents"), document, nil)
	if typesenseStatus(err, http.StatusConflict) {
		return localizedDatabaseRuntimeError("db.backend.error.typesense_document_exists", map[string]any{"id": typesenseIDText(document["id"])})
	}
	return typesenseWriteError(err)
}

func (t *TypesenseDB) deleteDocument(ctx context.Context, collection, id string) error {
	_, err := t.doRaw(ctx, http.MethodDelete, typesenseDocumentPath(collection, id), nil)
	return typesenseDocumentError(err, id)
}

func typesenseDocumentPath(collection, id string) string {
	return typesenseCollectionPath(collection, "/documents/"+url.PathEscape(id))
}

// typesenseDocumentError 把 404 转成“文档不存在”，其余按写入错误处理。
func typesenseDocumentError(err error, id string) error {
	if err == nil {
		return nil
	}
	if typesenseStatus(err, http.StatusNotFound) {
		return localizedDatabaseRuntimeError("db.backend.error.typesense_document_not_found", map[string]any{"id": id})
	}
	return typesenseWriteError(err)
}

func typesenseRowID(keys map[string]interface{}, action rowMutationAction) (string, error) {
	if value, ok := keys["id"]; ok && value != nil {
		if id := strings.TrimSpace(typesenseIDText(value)); id != "" {
			return id, nil
		}
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.typesense_id_required", map[string]any{"action": localizedRowMutationAction(action)})
}

// typesenseIDText 是 id 的文本形式（Typesense 的 id 总是字符串，整数不带小数点）。
func typesenseIDText(value interface{}) string {
	if number, ok := documentNumber(value); ok && number == math.Trunc(number) {
		return strconv.FormatInt(int64(number), 10)
	}
	return documentText(value)
}

// typesenseCoerceDocument 按 schema 类型转换网格里的值；新增行（dropNull）不写入值为 NULL 的字段。
func typesenseCoerceDocument(meta *typesenseCollectionMeta, values map[string]interface{}, dropNull bool) (map[string]interface{}, error) {
	document := make(map[string]interface{}, len(values))
	for field, value := range values {
		if field == "id" {
			if value != nil && strings.TrimSpace(typesenseIDText(value)) != "" {
				document["id"] = strings.TrimSpace(typesenseIDText(value))
			}
			continue
		}
		coerced, err := typesenseCoerceValue(meta.fieldType(field), field, value)
		if err != nil {
			return nil, err
		}
		if coerced == nil && dropNull {
			continue
		}
		document[field] = coerced
	}
	return document, nil
}

func typesenseCoerceValue(fieldType, field string, value interface{}) (interface{}, error) {
	invalid := func() error {
		return localizedDatabaseRuntimeError("db.backend.error.typesense_value_invalid", map[string]any{"field": field, "value": fmt.Sprint(value), "type": fieldType})
	}
	text, isText := value.(string)
	if !isText {
		if number, ok := documentNumber(value); ok && (fieldType == "int32" || fieldType == "int64") {
			if number != math.Trunc(number) {
				return nil, invalid()
			}
			return int64(number), nil
		}
		return value, nil
	}
	trimmed := strings.TrimSpace(text)
	switch {
	case fieldType == "int32" || fieldType == "int64":
		if trimmed == "" {
			return nil, nil
		}
		number, err := strconv.ParseInt(trimmed, 10, 64)
		if err != nil {
			return nil, invalid()
		}
		return number, nil
	case fieldType == "float":
		if trimmed == "" {
			return nil, nil
		}
		if _, err := strconv.ParseFloat(trimmed, 64); err != nil {
			return nil, invalid()
		}
		return json.Number(trimmed), nil
	case fieldType == "bool":
		if trimmed == "" {
			return nil, nil
		}
		flag, err := strconv.ParseBool(trimmed)
		if err != nil {
			return nil, invalid()
		}
		return flag, nil
	case strings.HasSuffix(fieldType, "[]") || fieldType == "object" || fieldType == "geopoint":
		if trimmed == "" {
			return nil, nil
		}
		var decoded interface{}
		if err := decodeJSONWithUseNumber([]byte(trimmed), &decoded); err != nil {
			return nil, invalid()
		}
		return decoded, nil
	case fieldType == "string":
		return text, nil
	}
	// auto / 只存储的字段：看起来像 JSON 数组或对象的文本按 JSON 写入，其余保留文本。
	if strings.HasPrefix(trimmed, "[") || strings.HasPrefix(trimmed, "{") {
		var decoded interface{}
		if decodeJSONWithUseNumber([]byte(trimmed), &decoded) == nil {
			return decoded, nil
		}
	}
	return text, nil
}
