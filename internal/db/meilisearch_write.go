//go:build gonavi_full_drivers || gonavi_meilisearch_driver

package db

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (m *MeilisearchDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultMeilisearchQueryTimeout)
	defer cancel()
	return m.ExecContext(ctx, query)
}

// ExecContext 执行控制台里的写请求：REST（POST / PUT / PATCH / DELETE，多个请求依次执行），
// 以及对象操作用到的 DROP TABLE、TRUNCATE、DELETE FROM … [WHERE …]、ALTER TABLE … RENAME TO …。返回受影响的文档数。
func (m *MeilisearchDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if m.client == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	text := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(query), ";"))
	if requests, ok := parseDocumentRESTRequests(text); ok {
		var total int64
		for _, request := range requests {
			if request.body != nil && !json.Valid(request.body) {
				return total, localizedDatabaseRuntimeError("db.backend.error.meilisearch_body_invalid", nil)
			}
			task, err := m.enqueue(ctx, request.method, request.path, request.body)
			if err != nil {
				return total, err
			}
			total += meilisearchTaskAffected(task)
		}
		return total, nil
	}
	return m.execSQLWrite(ctx, text)
}

var (
	meilisearchDropPattern     = regexp.MustCompile(`(?is)^DROP\s+(?:TABLE|INDEX)\s+(?:IF\s+EXISTS\s+)?(.+)$`)
	meilisearchTruncatePattern = regexp.MustCompile(`(?is)^TRUNCATE\s+(?:TABLE\s+)?(.+)$`)
	meilisearchDeletePattern   = regexp.MustCompile(`(?is)^DELETE\s+FROM\s+`)
	meilisearchRenamePattern   = regexp.MustCompile(`(?is)^ALTER\s+(?:TABLE|INDEX)\s+(.+?)\s+RENAME\s+TO\s+(.+)$`)
)

// execSQLWrite 执行 SQL 形式的对象操作：删除索引、清空文档、按条件删除文档、重命名索引
// （PATCH /indexes/{uid} 改 uid，较新的服务端才支持，旧版本由服务端报 immutable_index_uid）。
func (m *MeilisearchDB) execSQLWrite(ctx context.Context, text string) (int64, error) {
	if match := meilisearchRenamePattern.FindStringSubmatch(text); match != nil {
		oldUID, newUID := unquoteDocumentIdent(match[1]), unquoteDocumentIdent(match[2])
		defer m.invalidate("")
		_, err := m.enqueueJSON(ctx, http.MethodPatch, meilisearchIndexPath(oldUID, ""), map[string]string{"uid": newUID})
		return 0, err
	}
	if match := meilisearchDropPattern.FindStringSubmatch(text); match != nil {
		uid := unquoteDocumentIdent(match[1])
		_, err := m.enqueue(ctx, http.MethodDelete, meilisearchIndexPath(uid, ""), nil)
		return 0, err
	}
	if match := meilisearchTruncatePattern.FindStringSubmatch(text); match != nil {
		task, err := m.enqueue(ctx, http.MethodDelete, meilisearchIndexPath(unquoteDocumentIdent(match[1]), "/documents"), nil)
		return meilisearchTaskAffected(task), err
	}
	if meilisearchDeletePattern.MatchString(text) {
		return m.deleteWhere(ctx, text)
	}
	return 0, localizedDatabaseRuntimeError("db.backend.error.meilisearch_write_unsupported", nil)
}

// deleteWhere 执行 DELETE FROM：无条件时清空文档；1.2 起条件能翻译时按过滤删除，否则在客户端找出主键后批量删除。
func (m *MeilisearchDB) deleteWhere(ctx context.Context, text string) (int64, error) {
	uid := parseSQLFromName(text)
	if uid == "" {
		return 0, localizedDatabaseRuntimeError("db.backend.error.meilisearch_write_unsupported", nil)
	}
	whereAt := findSQLKeyword(text, "WHERE", 0)
	if whereAt < 0 {
		task, err := m.enqueue(ctx, http.MethodDelete, meilisearchIndexPath(uid, "/documents"), nil)
		return meilisearchTaskAffected(task), err
	}
	where, err := parseRegistryWhere(strings.TrimSpace(text[whereAt+len("WHERE"):]))
	if err != nil {
		return 0, err
	}
	meta, err := m.indexMeta(ctx, uid)
	if err != nil {
		return 0, err
	}
	if filter, ok := m.nativeFilter(meta, where); ok && m.supportsDocumentFilter() {
		task, err := m.enqueueJSON(ctx, http.MethodPost, meilisearchIndexPath(uid, "/documents/delete"), map[string]interface{}{"filter": filter})
		return meilisearchTaskAffected(task), err
	}
	if meta.primaryKey == "" {
		return 0, localizedDatabaseRuntimeError("db.backend.error.meilisearch_primary_key_required", map[string]any{"index": uid})
	}
	matched, err := m.scan(ctx, meta, where, nil)
	if err != nil {
		return 0, err
	}
	ids := make([]interface{}, 0, len(matched))
	for _, document := range matched {
		ids = append(ids, document[meta.primaryKey])
	}
	var total int64
	for start := 0; start < len(ids); start += meilisearchPageSize {
		chunk := ids[start:min(start+meilisearchPageSize, len(ids))]
		task, err := m.enqueueJSON(ctx, http.MethodPost, meilisearchIndexPath(uid, "/documents/delete-batch"), chunk)
		if err != nil {
			return total, err
		}
		if affected, ok := meilisearchTaskDetail(task, "deletedDocuments"); ok {
			total += affected
		} else {
			total += int64(len(chunk))
		}
	}
	return total, nil
}

func (m *MeilisearchDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return m.ApplyChangesContext(context.Background(), tableName, changes)
}

// ApplyChangesContext 提交数据网格的增删改。文档按主键定位：删除走批量删除；更新先确认文档仍存在，
// 再用部分更新（PUT）合并改动列，改了主键时写入新文档后删除旧文档；新增先确认主键未被占用（POST 会静默覆盖）。
// Meilisearch 没有事务，中途失败时报告已生效的条数。
func (m *MeilisearchDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if m.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	ctx, cancel := context.WithTimeout(ctx, defaultMeilisearchQueryTimeout)
	defer cancel()
	meta, err := m.indexMeta(ctx, tableName)
	if err != nil {
		return err
	}
	defer m.invalidate(meta.uid)
	pk := meta.primaryKey
	if pk == "" && (len(changes.Deletes) > 0 || len(changes.Updates) > 0) {
		return localizedDatabaseRuntimeError("db.backend.error.meilisearch_primary_key_required", map[string]any{"index": meta.uid})
	}

	total := len(changes.Deletes) + len(changes.Updates) + len(changes.Inserts)
	applied := 0
	fail := func(err error) error {
		if applied == 0 {
			return err
		}
		wrapped := localizedDatabaseRuntimeError("db.backend.error.meilisearch_changes_partial", map[string]any{"applied": applied, "total": total, "detail": err.Error()})
		if IsWriteOutcomeUnknown(err) {
			return MarkWriteOutcomeUnknown(wrapped)
		}
		return wrapped
	}

	if len(changes.Deletes) > 0 {
		ids := make([]interface{}, 0, len(changes.Deletes))
		for _, keys := range changes.Deletes {
			id, err := meilisearchDocumentID(keys, pk, rowMutationActionDelete)
			if err != nil {
				return fail(err)
			}
			ids = append(ids, id)
		}
		task, err := m.enqueueJSON(ctx, http.MethodPost, meilisearchIndexPath(meta.uid, "/documents/delete-batch"), ids)
		if err != nil {
			return fail(err)
		}
		if deleted, ok := meilisearchTaskDetail(task, "deletedDocuments"); ok && deleted < int64(len(ids)) {
			applied += int(deleted)
			return fail(localizedDatabaseRuntimeError("db.backend.error.meilisearch_documents_missing", map[string]any{"expected": len(ids), "actual": deleted}))
		}
		applied += len(ids)
	}

	partial := make([]map[string]interface{}, 0, len(changes.Updates))
	for _, update := range changes.Updates {
		id, err := meilisearchDocumentID(update.Keys, pk, rowMutationActionUpdate)
		if err != nil {
			return fail(err)
		}
		existing, err := m.getDocument(ctx, meta.uid, id)
		if err != nil {
			return fail(err)
		}
		values, err := meilisearchCoerceDocument(meta, update.Values, false)
		if err != nil {
			return fail(err)
		}
		if newID, ok := values[pk]; ok && meilisearchIDText(newID) != meilisearchIDText(id) {
			if err := m.moveDocument(ctx, meta.uid, id, newID, existing, values); err != nil {
				return fail(err)
			}
			applied++
			continue
		}
		values[pk] = id
		partial = append(partial, values)
	}
	if len(partial) > 0 {
		if _, err := m.enqueueJSON(ctx, http.MethodPut, meilisearchIndexPath(meta.uid, "/documents"), partial); err != nil {
			return fail(err)
		}
		applied += len(partial)
	}

	if len(changes.Inserts) > 0 {
		documents := make([]map[string]interface{}, 0, len(changes.Inserts))
		for _, row := range changes.Inserts {
			document, err := meilisearchCoerceDocument(meta, row, true)
			if err != nil {
				return fail(err)
			}
			if pk != "" {
				id, ok := document[pk]
				if !ok || strings.TrimSpace(meilisearchIDText(id)) == "" {
					return fail(localizedDatabaseRuntimeError("db.backend.error.meilisearch_document_id_required", map[string]any{"field": pk}))
				}
				if _, err := m.getDocument(ctx, meta.uid, id); err == nil {
					return fail(localizedDatabaseRuntimeError("db.backend.error.meilisearch_document_exists", map[string]any{"id": meilisearchIDText(id)}))
				} else if !isMeilisearchDocumentMissing(err) {
					return fail(err)
				}
			}
			documents = append(documents, document)
		}
		if _, err := m.enqueueJSON(ctx, http.MethodPost, meilisearchIndexPath(meta.uid, "/documents"), documents); err != nil {
			return fail(err)
		}
	}
	return nil
}

// moveDocument 改主键：写入合并了改动的新文档，再删除旧文档。
func (m *MeilisearchDB) moveDocument(ctx context.Context, uid string, oldID, newID interface{}, existing, values map[string]interface{}) error {
	if _, err := m.getDocument(ctx, uid, newID); err == nil {
		return localizedDatabaseRuntimeError("db.backend.error.meilisearch_document_exists", map[string]any{"id": meilisearchIDText(newID)})
	} else if !isMeilisearchDocumentMissing(err) {
		return err
	}
	merged := copyDocument(existing)
	for key, value := range values {
		merged[key] = value
	}
	if _, err := m.enqueueJSON(ctx, http.MethodPost, meilisearchIndexPath(uid, "/documents"), []map[string]interface{}{merged}); err != nil {
		return err
	}
	_, err := m.enqueueJSON(ctx, http.MethodPost, meilisearchIndexPath(uid, "/documents/delete-batch"), []interface{}{oldID})
	return err
}

// getDocument 按主键读取文档；文档不存在时报 meilisearch_document_not_found。
func (m *MeilisearchDB) getDocument(ctx context.Context, uid string, id interface{}) (map[string]interface{}, error) {
	var document map[string]interface{}
	err := m.doJSON(ctx, http.MethodGet, meilisearchIndexPath(uid, "/documents/"+url.PathEscape(meilisearchIDText(id))), nil, &document)
	if err != nil {
		if isMeilisearchErrorCode(err, "document_not_found") {
			return nil, &meilisearchDocumentMissingError{cause: err, id: meilisearchIDText(id)}
		}
		return nil, err
	}
	return document, nil
}

type meilisearchDocumentMissingError struct {
	cause error
	id    string
}

func (e *meilisearchDocumentMissingError) Error() string {
	return localizedDriverRuntimeText("db.backend.error.meilisearch_document_not_found", map[string]any{"id": e.id})
}

func (e *meilisearchDocumentMissingError) Unwrap() error { return e.cause }

func isMeilisearchDocumentMissing(err error) bool {
	var missing *meilisearchDocumentMissingError
	return errors.As(err, &missing)
}

// meilisearchDocumentID 取行的主键值。
func meilisearchDocumentID(keys map[string]interface{}, pk string, action rowMutationAction) (interface{}, error) {
	if value, ok := keys[pk]; ok && value != nil && strings.TrimSpace(meilisearchIDText(value)) != "" {
		return value, nil
	}
	return nil, localizedDatabaseRuntimeError("db.backend.error.meilisearch_key_required", map[string]any{
		"action": localizedRowMutationAction(action), "field": pk,
	})
}

// meilisearchIDText 是主键值的文本形式（整数不带小数点）。
func meilisearchIDText(value interface{}) string {
	if number, ok := documentNumber(value); ok && number == float64(int64(number)) {
		return strconv.FormatInt(int64(number), 10)
	}
	return documentText(value)
}

// meilisearchCoerceDocument 按字段推断类型转换网格里的值：数值、布尔解析文本，数组与对象按 JSON 解析；
// 新增行（dropNull）不写入值为 NULL 的字段，让文档保持干净。
func meilisearchCoerceDocument(meta *meilisearchIndexMeta, values map[string]interface{}, dropNull bool) (map[string]interface{}, error) {
	document := make(map[string]interface{}, len(values))
	for field, value := range values {
		coerced, err := meilisearchCoerceValue(meta.fieldType(field), field, value)
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

func meilisearchCoerceValue(kind, field string, value interface{}) (interface{}, error) {
	text, isText := value.(string)
	if !isText {
		return value, nil
	}
	trimmed := strings.TrimSpace(text)
	invalid := func() error {
		return localizedDatabaseRuntimeError("db.backend.error.meilisearch_value_invalid", map[string]any{"field": field, "value": text, "type": kind})
	}
	switch kind {
	case "number":
		if trimmed == "" {
			return nil, nil
		}
		if _, err := strconv.ParseFloat(trimmed, 64); err != nil {
			return nil, invalid()
		}
		return json.Number(trimmed), nil
	case "boolean":
		if trimmed == "" {
			return nil, nil
		}
		flag, err := strconv.ParseBool(trimmed)
		if err != nil {
			return nil, invalid()
		}
		return flag, nil
	case "array", "object":
		if trimmed == "" {
			return nil, nil
		}
		var decoded interface{}
		if err := decodeJSONWithUseNumber([]byte(trimmed), &decoded); err != nil {
			return nil, invalid()
		}
		return decoded, nil
	case "any", "mixed":
		// 类型未知时，看起来像 JSON 数组 / 对象的文本按 JSON 写入，其余保留文本。
		if strings.HasPrefix(trimmed, "[") || strings.HasPrefix(trimmed, "{") {
			var decoded interface{}
			if decodeJSONWithUseNumber([]byte(trimmed), &decoded) == nil {
				return decoded, nil
			}
		}
	}
	return text, nil
}
