//go:build gonavi_full_drivers || gonavi_meilisearch_driver

package db

import (
	"net/http"

	"GoNavi-Wails/internal/connection"
)

var _ ChangePreviewer = (*MeilisearchDB)(nil)

// PreviewChanges 按 ApplyChanges 的做法列出要发出的 REST 请求（每行一条，可在控制台执行）：删除走批量删除，
// 更新是部分更新（改主键时写入合并后的新文档再删除旧文档），新增写入转换后的文档。值无法转换时给出原因。
func (m *MeilisearchDB) PreviewChanges(tableName string, changes connection.ChangeSet) (deletes, updates, inserts []string) {
	ctx, cancel := newMeilisearchMetadataContext()
	defer cancel()
	meta, err := m.indexMeta(ctx, tableName)
	if err != nil {
		meta = &meilisearchIndexMeta{uid: tableName, types: map[string]string{}}
	}
	pk := meta.primaryKey
	documentsPath := meilisearchIndexPath(meta.uid, "/documents")
	deleteBatch := func(id interface{}) string {
		return formatConsoleRequest(http.MethodPost, documentsPath+"/delete-batch", []interface{}{id})
	}

	for _, keys := range changes.Deletes {
		id, err := meilisearchDocumentID(keys, pk, rowMutationActionDelete)
		if err != nil {
			deletes = append(deletes, "# "+err.Error())
			continue
		}
		deletes = append(deletes, deleteBatch(id))
	}
	for _, update := range changes.Updates {
		id, err := meilisearchDocumentID(update.Keys, pk, rowMutationActionUpdate)
		if err != nil {
			updates = append(updates, "# "+err.Error())
			continue
		}
		values, err := meilisearchCoerceDocument(meta, update.Values, false)
		if err != nil {
			updates = append(updates, "# "+err.Error())
			continue
		}
		if newID, ok := values[pk]; ok && meilisearchIDText(newID) != meilisearchIDText(id) {
			merged := map[string]interface{}{}
			if existing, err := m.getDocument(ctx, meta.uid, id); err == nil {
				merged = copyDocument(existing)
			}
			for key, value := range values {
				merged[key] = value
			}
			updates = append(updates, formatConsoleRequest(http.MethodPost, documentsPath, []map[string]interface{}{merged})+"\n\n"+deleteBatch(id))
			continue
		}
		values[pk] = id
		updates = append(updates, formatConsoleRequest(http.MethodPut, documentsPath, []map[string]interface{}{values}))
	}
	for _, row := range changes.Inserts {
		document, err := meilisearchCoerceDocument(meta, row, true)
		if err != nil {
			inserts = append(inserts, "# "+err.Error())
			continue
		}
		inserts = append(inserts, formatConsoleRequest(http.MethodPost, documentsPath, []map[string]interface{}{document}))
	}
	return deletes, updates, inserts
}
