//go:build gonavi_full_drivers || gonavi_weaviate_driver

package db

import (
	"context"
	"net/http"

	"GoNavi-Wails/internal/connection"
)

var _ ChangePreviewer = (*WeaviateDB)(nil)

// PreviewChanges 按 ApplyChanges 的做法列出要发出的 REST 请求（每行一条，可在控制台执行）：按 id 删除对象，
// 更新用 PATCH（清空属性时读出当前对象后用 PUT 整体替换），新增走批量写入。无法生成请求时给出原因。
func (w *WeaviateDB) PreviewChanges(tableName string, changes connection.ChangeSet) (deletes, updates, inserts []string) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultWeaviateQueryTimeout)
	defer cancel()
	class, err := w.findClass(ctx, tableName)
	if err == nil {
		var tenant string
		if tenant, err = w.tenantFor(class); err == nil {
			return w.previewChanges(ctx, class, tenant, changes)
		}
	}
	reason := "# " + err.Error()
	for range changes.Deletes {
		deletes = append(deletes, reason)
	}
	for range changes.Updates {
		updates = append(updates, reason)
	}
	for range changes.Inserts {
		inserts = append(inserts, reason)
	}
	return deletes, updates, inserts
}

func (w *WeaviateDB) previewChanges(ctx context.Context, class weaviateClass, tenant string, changes connection.ChangeSet) (deletes, updates, inserts []string) {
	objectPath := func(id string) string {
		return "/v1/objects/" + weaviateEscapePath(class.Class) + "/" + weaviateEscapePath(id)
	}
	for _, keys := range changes.Deletes {
		id, err := weaviateRowID(keys, rowMutationActionDelete)
		if err != nil {
			deletes = append(deletes, "# "+err.Error())
			continue
		}
		deletes = append(deletes, formatConsoleRequest(http.MethodDelete, objectPath(id)+weaviateTenantQuery(tenant), nil))
	}
	for _, update := range changes.Updates {
		id, err := weaviateRowID(update.Keys, rowMutationActionUpdate)
		if err != nil {
			updates = append(updates, "# "+err.Error())
			continue
		}
		payload, err := w.objectPayload(class, update.Values)
		if err != nil {
			updates = append(updates, "# "+err.Error())
			continue
		}
		method, path, body, err := w.updateRequest(ctx, class, tenant, id, payload)
		if err != nil {
			updates = append(updates, "# "+err.Error())
			continue
		}
		updates = append(updates, formatConsoleRequest(method, path, body))
	}
	for _, row := range changes.Inserts {
		payload, err := w.objectPayload(class, row)
		if err != nil {
			inserts = append(inserts, "# "+err.Error())
			continue
		}
		body := map[string]interface{}{"objects": []map[string]interface{}{weaviateInsertObject(class, tenant, row, payload)}}
		inserts = append(inserts, formatConsoleRequest(http.MethodPost, "/v1/batch/objects", body))
	}
	return deletes, updates, inserts
}
