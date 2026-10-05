//go:build gonavi_full_drivers || gonavi_weaviate_driver

package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

const maxWeaviateFailureDetails = 20

func (w *WeaviateDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultWeaviateQueryTimeout)
	defer cancel()
	return w.ExecContext(ctx, query)
}

// ExecContext 执行控制台里的 REST 写请求（POST / PUT / PATCH / DELETE /v1/...），返回受影响对象数。
func (w *WeaviateDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if w.client == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	request, ok := parseWeaviateRESTRequest(strings.TrimSpace(query))
	if !ok || request.method == http.MethodGet || request.method == http.MethodHead || request.path == "/v1/graphql" {
		return 0, localizedDatabaseRuntimeError("db.backend.error.weaviate_write_unsupported", nil)
	}
	if request.body != nil && !json.Valid(request.body) {
		return 0, localizedDatabaseRuntimeError("db.backend.error.weaviate_body_invalid", nil)
	}
	body, err := w.doRaw(ctx, request.method, request.path, request.body)
	if strings.HasPrefix(request.path, "/v1/schema") || strings.HasPrefix(request.path, "/v1/batch") || strings.HasPrefix(request.path, "/v1/objects") {
		// 写对象也可能经自动 schema 新增属性，统一让元数据缓存失效。
		w.invalidateSchema()
	}
	if err != nil {
		return 0, weaviateWriteError(err)
	}
	switch {
	case request.method == http.MethodPost && request.path == "/v1/batch/objects":
		return weaviateBatchObjectsResult(body)
	case request.method == http.MethodDelete && request.path == "/v1/batch/objects":
		return weaviateBatchDeleteResult(body)
	}
	return 1, nil
}

// weaviateWriteError 区分服务端拒绝与传输失败：后者请求可能已经生效，标记为结果未知。
func weaviateWriteError(err error) error {
	var httpErr *weaviateHTTPError
	if errors.As(err, &httpErr) || errors.Is(err, context.Canceled) {
		return err
	}
	return MarkWriteOutcomeUnknown(err)
}

type weaviateBatchObjectResult struct {
	ID     string `json:"id"`
	Result struct {
		Status string `json:"status"`
		Errors *struct {
			Error []struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"errors"`
	} `json:"result"`
}

// weaviateBatchObjectsResult 汇总批量写入结果：1.19 只在失败项带 errors，1.20 起另有 status。
func weaviateBatchObjectsResult(body []byte) (int64, error) {
	var results []weaviateBatchObjectResult
	if err := decodeJSONWithUseNumber(body, &results); err != nil {
		return 0, MarkWriteOutcomeUnknown(err)
	}
	succeeded, failed := int64(0), 0
	details := make([]string, 0, maxWeaviateFailureDetails)
	for index, item := range results {
		messages := make([]string, 0, 1)
		if item.Result.Errors != nil {
			for _, entry := range item.Result.Errors.Error {
				if text := strings.TrimSpace(entry.Message); text != "" {
					messages = append(messages, text)
				}
			}
		}
		if len(messages) == 0 && !strings.EqualFold(item.Result.Status, "FAILED") {
			succeeded++
			continue
		}
		failed++
		if len(details) < maxWeaviateFailureDetails {
			id := item.ID
			if id == "" {
				id = "#" + strconv.Itoa(index+1)
			}
			details = append(details, fmt.Sprintf("%s (%s)", id, strings.Join(messages, "; ")))
		}
	}
	if failed > 0 {
		return succeeded, localizedDatabaseRuntimeError("db.backend.error.weaviate_batch_partial_failure", map[string]any{
			"failed": failed,
			"total":  len(results),
			"detail": strings.Join(details, "; "),
		})
	}
	return succeeded, nil
}

func weaviateBatchDeleteResult(body []byte) (int64, error) {
	var response struct {
		Results struct {
			Successful int64 `json:"successful"`
			Failed     int64 `json:"failed"`
			Matches    int64 `json:"matches"`
		} `json:"results"`
	}
	if err := decodeJSONWithUseNumber(body, &response); err != nil {
		return 0, MarkWriteOutcomeUnknown(err)
	}
	if response.Results.Failed > 0 {
		return response.Results.Successful, localizedDatabaseRuntimeError("db.backend.error.weaviate_batch_partial_failure", map[string]any{
			"failed": response.Results.Failed,
			"total":  response.Results.Matches,
			"detail": "",
		})
	}
	return response.Results.Successful, nil
}

func (w *WeaviateDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return w.ApplyChangesContext(context.Background(), tableName, changes)
}

// ApplyChangesContext 提交数据网格的增删改：删除与更新逐个对象请求，新增走批量接口。
// Weaviate 没有事务，中途失败时报告已生效的条数。
func (w *WeaviateDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if w.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	ctx, cancel := context.WithTimeout(ctx, defaultWeaviateQueryTimeout)
	defer cancel()
	class, err := w.findClass(ctx, tableName)
	if err != nil {
		return err
	}
	tenant, err := w.tenantFor(class)
	if err != nil {
		return err
	}
	defer w.invalidateSchema()

	total := len(changes.Deletes) + len(changes.Updates) + len(changes.Inserts)
	applied := 0
	fail := func(err error) error {
		if applied == 0 {
			return err
		}
		wrapped := localizedDatabaseRuntimeError("db.backend.error.weaviate_changes_partial", map[string]any{"applied": applied, "total": total, "detail": err.Error()})
		if IsWriteOutcomeUnknown(err) {
			return MarkWriteOutcomeUnknown(wrapped)
		}
		return wrapped
	}
	objectPath := func(id string) string {
		return "/v1/objects/" + weaviateEscapePath(class.Class) + "/" + weaviateEscapePath(id)
	}

	for _, keys := range changes.Deletes {
		id, err := weaviateRowID(keys, rowMutationActionDelete)
		if err != nil {
			return fail(err)
		}
		if err := w.doJSON(ctx, http.MethodDelete, objectPath(id)+weaviateTenantQuery(tenant), nil, nil); err != nil {
			return fail(weaviateObjectError(err, class.Class, id))
		}
		applied++
	}
	for _, update := range changes.Updates {
		id, err := weaviateRowID(update.Keys, rowMutationActionUpdate)
		if err != nil {
			return fail(err)
		}
		payload, err := w.objectPayload(class, update.Values)
		if err != nil {
			return fail(err)
		}
		if err := w.updateObject(ctx, class, tenant, id, payload); err != nil {
			return fail(weaviateObjectError(err, class.Class, id))
		}
		applied++
	}
	if len(changes.Inserts) > 0 {
		objects := make([]map[string]interface{}, 0, len(changes.Inserts))
		for _, row := range changes.Inserts {
			payload, err := w.objectPayload(class, row)
			if err != nil {
				return fail(err)
			}
			objects = append(objects, weaviateInsertObject(class, tenant, row, payload))
		}
		var raw json.RawMessage
		if err := w.doJSON(ctx, http.MethodPost, "/v1/batch/objects", map[string]interface{}{"objects": objects}, &raw); err != nil {
			return fail(weaviateWriteError(err))
		}
		if _, err := weaviateBatchObjectsResult(raw); err != nil {
			return fail(err)
		}
	}
	return nil
}

// weaviateInsertObject 是批量写入里的一个新对象；网格填了 _id 时使用该 id。
func weaviateInsertObject(class weaviateClass, tenant string, row map[string]interface{}, payload weaviateObjectPayload) map[string]interface{} {
	object := payload.body(class.Class, tenant, false)
	if id, ok := row[weaviateIDColumn]; ok && id != nil && strings.TrimSpace(fmt.Sprint(id)) != "" {
		object["id"] = strings.TrimSpace(fmt.Sprint(id))
	}
	return object
}

func weaviateRowID(keys map[string]interface{}, action rowMutationAction) (string, error) {
	for _, name := range []string{weaviateIDColumn, "id"} {
		if value, ok := keys[name]; ok && value != nil {
			if id := strings.TrimSpace(fmt.Sprint(value)); id != "" {
				return id, nil
			}
		}
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.weaviate_id_required", map[string]any{"action": localizedRowMutationAction(action)})
}

func weaviateObjectError(err error, class, id string) error {
	var httpErr *weaviateHTTPError
	if errors.As(err, &httpErr) && httpErr.status == http.StatusNotFound {
		return localizedDatabaseRuntimeError("db.backend.error.weaviate_object_not_found", map[string]any{"class": class, "id": id})
	}
	return weaviateWriteError(err)
}

// weaviateObjectPayload 是网格一行改动按 schema 转换后的属性与向量。
type weaviateObjectPayload struct {
	properties map[string]interface{}
	vector     interface{}
	vectors    interface{}
	clears     bool
}

func (p weaviateObjectPayload) body(class, tenant string, includeNull bool) map[string]interface{} {
	properties := make(map[string]interface{}, len(p.properties))
	for name, value := range p.properties {
		if value != nil || includeNull {
			properties[name] = value
		}
	}
	body := map[string]interface{}{"class": class, "properties": properties}
	if tenant != "" {
		body["tenant"] = tenant
	}
	if p.vector != nil {
		body["vector"] = p.vector
	}
	if p.vectors != nil {
		body["vectors"] = p.vectors
	}
	return body
}

// objectPayload 按属性类型转换网格值；_id、时间戳等合成列不写回，引用属性只能在控制台修改。
func (w *WeaviateDB) objectPayload(class weaviateClass, values map[string]interface{}) (weaviateObjectPayload, error) {
	payload := weaviateObjectPayload{properties: make(map[string]interface{}, len(values))}
	for name, value := range values {
		switch name {
		case weaviateIDColumn, "id", weaviateCreatedColumn, weaviateUpdatedColumn, "_class", "_tenant", "_distance", "_certainty", "_score", "_explainScore":
			continue
		case weaviateVectorColumn:
			vector, err := weaviateDecodeJSONValue(value)
			if err != nil {
				return payload, err
			}
			payload.vector = vector
			continue
		case weaviateVectorsColumn:
			vectors, err := weaviateDecodeJSONValue(value)
			if err != nil {
				return payload, err
			}
			payload.vectors = vectors
			continue
		}
		property, ok := class.property(name)
		if !ok {
			return payload, localizedDatabaseRuntimeError("db.backend.error.weaviate_property_not_found", map[string]any{"class": class.Class, "property": name})
		}
		if property.isReference() {
			return payload, localizedDatabaseRuntimeError("db.backend.error.weaviate_reference_edit_unsupported", map[string]any{"property": property.Name})
		}
		if value == nil {
			payload.clears = true
			payload.properties[property.Name] = nil
			continue
		}
		converted, err := weaviateCoerceProperty(property, value)
		if err != nil {
			return payload, err
		}
		payload.properties[property.Name] = converted
	}
	return payload, nil
}

// updateObject 用 PATCH 合并改动；有单元格清空为 NULL 时 PATCH 无法删除属性，改为读出对象后整体 PUT（保留原向量）。
func (w *WeaviateDB) updateObject(ctx context.Context, class weaviateClass, tenant, id string, payload weaviateObjectPayload) error {
	method, path, body, err := w.updateRequest(ctx, class, tenant, id, payload)
	if err != nil {
		return err
	}
	return w.doJSON(ctx, method, path, body, nil)
}

// updateRequest 生成更新对象的请求：只改属性时用 PATCH 合并；清空属性（PATCH 做不到）时读出当前对象，
// 合并后用 PUT 整体替换（保留向量）。
func (w *WeaviateDB) updateRequest(ctx context.Context, class weaviateClass, tenant, id string, payload weaviateObjectPayload) (string, string, map[string]interface{}, error) {
	path := "/v1/objects/" + weaviateEscapePath(class.Class) + "/" + weaviateEscapePath(id)
	if !payload.clears {
		return http.MethodPatch, path, payload.body(class.Class, tenant, false), nil
	}
	query := "?include=vector"
	if tenant != "" {
		query += "&tenant=" + url.QueryEscape(tenant)
	}
	var current map[string]interface{}
	if err := w.doJSON(ctx, http.MethodGet, path+query, nil, &current); err != nil {
		return "", "", nil, err
	}
	properties, _ := current["properties"].(map[string]interface{})
	if properties == nil {
		properties = map[string]interface{}{}
	}
	for name, value := range payload.properties {
		if value == nil {
			delete(properties, name)
		} else {
			properties[name] = value
		}
	}
	body := map[string]interface{}{"class": class.Class, "id": id, "properties": properties}
	if tenant != "" {
		body["tenant"] = tenant
	}
	for _, key := range []string{"vector", "vectors"} {
		if value, ok := current[key]; ok && value != nil {
			body[key] = value
		}
	}
	if payload.vector != nil {
		body["vector"] = payload.vector
	}
	if payload.vectors != nil {
		body["vectors"] = payload.vectors
	}
	return http.MethodPut, path, body, nil
}

// weaviateDecodeJSONValue 把网格里以 JSON 文本编辑的数组 / 对象还原成结构化值。
func weaviateDecodeJSONValue(value interface{}) (interface{}, error) {
	text, ok := value.(string)
	if !ok {
		return value, nil
	}
	var decoded interface{}
	if err := decodeJSONWithUseNumber([]byte(strings.TrimSpace(text)), &decoded); err != nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.weaviate_body_invalid", nil)
	}
	return decoded, nil
}

// weaviateCoerceProperty 按 schema 数据类型转换写入值：数组与对象接受 JSON 文本，数值、布尔与日期接受字符串。
func weaviateCoerceProperty(property weaviateProperty, value interface{}) (interface{}, error) {
	base := property.baseType()
	if property.isArray() {
		items, err := weaviateDecodeJSONValue(value)
		if err != nil {
			return nil, err
		}
		list, ok := items.([]interface{})
		if !ok {
			return nil, weaviateValueError(property, value)
		}
		converted := make([]interface{}, len(list))
		for index, item := range list {
			if converted[index], err = weaviateCoerceScalar(property, base, item); err != nil {
				return nil, err
			}
		}
		return converted, nil
	}
	switch base {
	case "object", "geoCoordinates", "phoneNumber":
		return weaviateDecodeJSONValue(value)
	}
	return weaviateCoerceScalar(property, base, value)
}

func weaviateCoerceScalar(property weaviateProperty, base string, value interface{}) (interface{}, error) {
	text := strings.TrimSpace(fmt.Sprint(value))
	switch base {
	case "int":
		if number, ok := weaviateInt(value); ok {
			return number, nil
		}
		if integer, err := strconv.ParseInt(text, 10, 64); err == nil {
			return integer, nil
		}
		if float, err := strconv.ParseFloat(text, 64); err == nil && float == float64(int64(float)) {
			return int64(float), nil
		}
		return nil, weaviateValueError(property, value)
	case "number":
		if float, err := strconv.ParseFloat(text, 64); err == nil {
			return float, nil
		}
		return nil, weaviateValueError(property, value)
	case "boolean":
		if typed, ok := value.(bool); ok {
			return typed, nil
		}
		switch strings.ToLower(text) {
		case "true", "t", "1", "yes", "y":
			return true, nil
		case "false", "f", "0", "no", "n":
			return false, nil
		}
		return nil, weaviateValueError(property, value)
	case "date":
		if typed, ok := value.(time.Time); ok {
			return typed.Format(time.RFC3339Nano), nil
		}
		if date, ok := normalizeRegistryDate(text); ok {
			return date, nil
		}
		return nil, weaviateValueError(property, value)
	}
	if typed, ok := value.(string); ok {
		return typed, nil
	}
	return text, nil
}

func weaviateValueError(property weaviateProperty, value interface{}) error {
	return localizedDatabaseRuntimeError("db.backend.error.weaviate_filter_value_invalid", map[string]any{
		"property": property.Name,
		"dataType": property.typeLabel(),
		"value":    fmt.Sprint(value),
	})
}
