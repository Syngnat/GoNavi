//go:build gonavi_full_drivers || gonavi_meilisearch_driver

package db

import (
	"context"
	"fmt"
	"time"
)

// meilisearchScanEntry 缓存最近一次客户端扫描的结果：数据网格翻页与计数会对同一条件连续发多次查询。
// 经本连接写入、索引 updatedAt 变化或超过 meilisearchScanTTL 后失效。
type meilisearchScanEntry struct {
	uid       string
	key       string
	updatedAt string
	documents []map[string]interface{}
	loadedAt  time.Time
}

// scan 逐页读取整个索引，在客户端按条件筛选并排序；文档数超过 meilisearchScanLimit 时拒绝，
// 提示把字段加入 filterableAttributes / sortableAttributes 交给服务端处理。
func (m *MeilisearchDB) scan(ctx context.Context, meta *meilisearchIndexMeta, where interface{}, keys []documentSortKey) ([]map[string]interface{}, error) {
	cacheKey := fmt.Sprintf("%#v|%#v", where, keys)
	m.mu.Lock()
	if entry := m.scanCache; entry != nil && entry.uid == meta.uid && entry.key == cacheKey && entry.updatedAt == meta.updatedAt &&
		time.Since(entry.loadedAt) < meilisearchScanTTL {
		m.mu.Unlock()
		return entry.documents, nil
	}
	m.mu.Unlock()

	tooLarge := func(count int64) error {
		return localizedDatabaseRuntimeError("db.backend.error.meilisearch_scan_too_large", map[string]any{
			"index": meta.uid, "count": count, "limit": meilisearchScanLimit,
		})
	}
	if meta.documents > meilisearchScanLimit {
		return nil, tooLarge(meta.documents)
	}
	matched := make([]map[string]interface{}, 0)
	for offset := 0; ; offset += meilisearchPageSize {
		if offset >= meilisearchScanLimit {
			return nil, tooLarge(int64(offset))
		}
		page, err := m.listDocuments(ctx, meta.uid, offset, meilisearchPageSize)
		if err != nil {
			return nil, err
		}
		for _, document := range page {
			if where == nil || evaluateDocumentWhere(where, document) {
				matched = append(matched, document)
			}
		}
		if len(page) < meilisearchPageSize {
			break
		}
	}
	sortDocuments(matched, keys)

	m.mu.Lock()
	m.scanCache = &meilisearchScanEntry{uid: meta.uid, key: cacheKey, updatedAt: meta.updatedAt, documents: matched, loadedAt: time.Now()}
	m.mu.Unlock()
	return matched, nil
}
