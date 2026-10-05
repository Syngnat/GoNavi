//go:build gonavi_full_drivers || gonavi_typesense_driver

package db

import (
	"net/http"

	"GoNavi-Wails/internal/connection"
)

var _ ChangePreviewer = (*TypesenseDB)(nil)

// PreviewChanges 按 ApplyChanges 的做法列出要发出的 REST 请求（每行一条，可在控制台执行）：按 id 删除、
// 部分更新（PATCH），改 id 时新建合并后的文档再删除旧文档，新增用 POST 新建。值无法转换时给出原因。
func (t *TypesenseDB) PreviewChanges(tableName string, changes connection.ChangeSet) (deletes, updates, inserts []string) {
	ctx, cancel := newTypesenseMetadataContext()
	defer cancel()
	meta, err := t.collectionMeta(ctx, tableName)
	if err != nil {
		meta = &typesenseCollectionMeta{name: tableName, schema: map[string]typesenseField{}, extras: map[string]bool{}}
	}
	createPath := typesenseCollectionPath(meta.name, "/documents")

	for _, keys := range changes.Deletes {
		id, err := typesenseRowID(keys, rowMutationActionDelete)
		if err != nil {
			deletes = append(deletes, "# "+err.Error())
			continue
		}
		deletes = append(deletes, formatConsoleRequest(http.MethodDelete, typesenseDocumentPath(meta.name, id), nil))
	}
	for _, update := range changes.Updates {
		id, err := typesenseRowID(update.Keys, rowMutationActionUpdate)
		if err != nil {
			updates = append(updates, "# "+err.Error())
			continue
		}
		values, err := typesenseCoerceDocument(meta, update.Values, false)
		if err != nil {
			updates = append(updates, "# "+err.Error())
			continue
		}
		if newID, ok := values["id"]; ok && typesenseIDText(newID) != id {
			var merged map[string]interface{}
			if t.doJSON(ctx, http.MethodGet, typesenseDocumentPath(meta.name, id), nil, &merged) != nil || merged == nil {
				merged = map[string]interface{}{}
			}
			for key, value := range values {
				if value == nil {
					delete(merged, key)
				} else {
					merged[key] = value
				}
			}
			updates = append(updates, formatConsoleRequest(http.MethodPost, createPath, merged)+"\n\n"+
				formatConsoleRequest(http.MethodDelete, typesenseDocumentPath(meta.name, id), nil))
			continue
		}
		delete(values, "id")
		updates = append(updates, formatConsoleRequest(http.MethodPatch, typesenseDocumentPath(meta.name, id), values))
	}
	for _, row := range changes.Inserts {
		document, err := typesenseCoerceDocument(meta, row, true)
		if err != nil {
			inserts = append(inserts, "# "+err.Error())
			continue
		}
		inserts = append(inserts, formatConsoleRequest(http.MethodPost, createPath, document))
	}
	return deletes, updates, inserts
}
