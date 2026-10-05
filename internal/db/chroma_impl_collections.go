package db

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

func (c *ChromaDB) listCollections(ctx context.Context, dbName string) ([]chromaCollection, error) {
	if c.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	if err := c.ensureVersion(ctx); err != nil {
		return nil, err
	}
	var collections []chromaCollection
	path := "/api/v1/collections"
	if c.apiVersion == 2 {
		path = c.v2Path(dbName, "/collections")
	}
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &collections); err != nil {
		return nil, err
	}
	return collections, nil
}

func (c *ChromaDB) resolveCollection(ctx context.Context, dbName, tableName string) (chromaCollection, error) {
	name := tableNameOrDB(dbName, tableName)
	if name == "" {
		return chromaCollection{}, fmt.Errorf("collection 名称不能为空")
	}
	collections, err := c.listCollections(ctx, dbName)
	if err != nil {
		return chromaCollection{}, err
	}
	for _, item := range collections {
		if strings.EqualFold(item.Name, name) || strings.EqualFold(item.ID, name) {
			return item, nil
		}
	}
	return chromaCollection{}, fmt.Errorf("未找到 Chroma collection：%s", name)
}

func (c *ChromaDB) collectionActionPath(ctx context.Context, collectionName, action string) (string, error) {
	if err := c.ensureVersion(ctx); err != nil {
		return "", err
	}
	coll, err := c.resolveCollection(ctx, "", collectionName)
	if err != nil {
		return "", err
	}
	ident := coll.ID
	if strings.TrimSpace(ident) == "" {
		ident = coll.Name
	}
	if ident == "" {
		return "", fmt.Errorf("collection 标识为空")
	}
	if c.apiVersion == 2 {
		return c.v2Path(coll.Database, fmt.Sprintf("/collections/%s/%s", url.PathEscape(ident), action)), nil
	}
	return fmt.Sprintf("/api/v1/collections/%s/%s", url.PathEscape(ident), action), nil
}

func (c *ChromaDB) getCollectionRows(ctx context.Context, collection string, limit int, offset int, where interface{}, include []string) ([]map[string]interface{}, []string, error) {
	if limit <= 0 {
		limit = 200
	}
	path, err := c.collectionActionPath(ctx, collection, "get")
	if err != nil {
		return nil, nil, err
	}
	body := map[string]interface{}{
		"limit":   limit,
		"offset":  offset,
		"include": include,
	}
	if where != nil {
		body["where"] = where
	}
	var resp chromaGetResponse
	if err := c.doJSON(ctx, http.MethodPost, path, body, &resp); err != nil {
		return nil, nil, err
	}
	rows, columns := chromaGetResponseRows(resp)
	return rows, columns, nil
}

func (c *ChromaDB) getCollectionIDCount(ctx context.Context, path string, offset int, where interface{}) (int, error) {
	body := map[string]interface{}{
		"limit":   chromaFilteredCountPageSize,
		"offset":  offset,
		"include": []string{},
	}
	if where != nil {
		body["where"] = where
	}
	var resp chromaGetResponse
	if err := c.doJSON(ctx, http.MethodPost, path, body, &resp); err != nil {
		return 0, err
	}
	return len(resp.IDs), nil
}

func (c *ChromaDB) countCollection(ctx context.Context, collection string, where interface{}) (int64, error) {
	if where == nil {
		path, err := c.collectionActionPath(ctx, collection, "count")
		if err != nil {
			return 0, err
		}
		var raw interface{}
		if err := c.doJSON(ctx, http.MethodGet, path, nil, &raw); err == nil {
			return chromaCountValue(raw), nil
		}
	}
	path, err := c.collectionActionPath(ctx, collection, "get")
	if err != nil {
		return 0, err
	}

	countCtx := ctx
	var cancel context.CancelFunc = func() {}
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		countCtx, cancel = context.WithTimeout(ctx, defaultChromaQueryTimeout)
	}
	defer cancel()

	var total int64
	for offset := 0; ; {
		pageCount, err := c.getCollectionIDCount(countCtx, path, offset, where)
		if err != nil {
			return 0, err
		}
		total += int64(pageCount)
		if pageCount < chromaFilteredCountPageSize {
			return total, nil
		}
		offset += pageCount
	}
}

func (c *ChromaDB) queryJSON(ctx context.Context, text string) ([]map[string]interface{}, []string, error) {
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(text), &cmd); err != nil {
		return nil, nil, fmt.Errorf("Chroma JSON 命令解析失败：%w", err)
	}
	if hasAnyKey(cmd, "list_collections", "listCollections") {
		cols, err := c.listCollections(ctx, "")
		if err != nil {
			return nil, nil, err
		}
		rows := make([]map[string]interface{}, 0, len(cols))
		for _, col := range cols {
			rows = append(rows, chromaStructRow(col))
		}
		return rows, collectColumns(rows), nil
	}
	if name := firstStringValue(cmd, "get", "collection"); name != "" && (hasAnyKey(cmd, "get") || !hasAnyKey(cmd, "query", "query_embeddings", "query_texts")) {
		limit := intFromAny(cmd["limit"], 200)
		offset := intFromAny(cmd["offset"], 0)
		include := stringSliceFromAny(cmd["include"], []string{"documents", "metadatas"})
		return c.getCollectionRows(ctx, name, limit, offset, cmd["where"], include)
	}
	if name := firstStringValue(cmd, "query", "collection"); name != "" {
		return c.queryCollection(ctx, name, cmd)
	}
	return nil, nil, fmt.Errorf("Chroma JSON 查询命令仅支持 list_collections/get/query")
}

func (c *ChromaDB) queryCollection(ctx context.Context, collection string, cmd map[string]interface{}) ([]map[string]interface{}, []string, error) {
	path, err := c.collectionActionPath(ctx, collection, "query")
	if err != nil {
		return nil, nil, err
	}
	body := make(map[string]interface{})
	for _, key := range []string{"query_embeddings", "query_texts", "where", "where_document", "include"} {
		if value, ok := cmd[key]; ok {
			body[key] = value
		}
	}
	body["n_results"] = intFromAny(firstExisting(cmd, "n_results", "limit"), 10)
	if _, ok := body["include"]; !ok {
		body["include"] = []string{"documents", "metadatas", "distances"}
	}
	var raw map[string]interface{}
	if err := c.doJSON(ctx, http.MethodPost, path, body, &raw); err != nil {
		return nil, nil, err
	}
	rows := chromaQueryResponseRows(raw)
	return rows, collectColumns(rows), nil
}

func (c *ChromaDB) createCollection(ctx context.Context, body map[string]interface{}) error {
	if err := c.ensureVersion(ctx); err != nil {
		return err
	}
	path := "/api/v1/collections"
	if c.apiVersion == 2 {
		path = c.v2Path("", "/collections")
	}
	return c.doJSON(ctx, http.MethodPost, path, body, nil)
}

func (c *ChromaDB) deleteCollection(ctx context.Context, name string) error {
	if err := c.ensureVersion(ctx); err != nil {
		return err
	}
	path := fmt.Sprintf("/api/v1/collections/%s", url.PathEscape(name))
	if c.apiVersion == 2 {
		coll, err := c.resolveCollection(ctx, "", name)
		if err != nil {
			return err
		}
		ident := coll.ID
		if ident == "" {
			ident = coll.Name
		}
		path = c.v2Path(coll.Database, fmt.Sprintf("/collections/%s", url.PathEscape(ident)))
	}
	return c.doJSON(ctx, http.MethodDelete, path, nil, nil)
}

func (c *ChromaDB) upsertCommand(ctx context.Context, collection string, cmd map[string]interface{}) (int64, error) {
	if rowsValue, ok := cmd["rows"].([]interface{}); ok {
		rows := make([]map[string]interface{}, 0, len(rowsValue))
		for _, raw := range rowsValue {
			if row, ok := raw.(map[string]interface{}); ok {
				rows = append(rows, row)
			}
		}
		return int64(len(rows)), c.upsertRows(ctx, collection, rows)
	}
	body := make(map[string]interface{})
	for _, key := range []string{"ids", "documents", "metadatas", "embeddings", "uris"} {
		if value, ok := cmd[key]; ok {
			body[key] = value
		}
	}
	if _, ok := body["ids"]; !ok {
		return 0, fmt.Errorf("Chroma upsert 命令缺少 ids")
	}
	path, err := c.collectionActionPath(ctx, collection, "upsert")
	if err != nil {
		return 0, err
	}
	return int64(len(anySlice(body["ids"]))), c.doJSON(ctx, http.MethodPost, path, body, nil)
}

func (c *ChromaDB) deleteCommand(ctx context.Context, collection string, cmd map[string]interface{}) (int64, error) {
	body := make(map[string]interface{})
	for _, key := range []string{"ids", "where", "where_document"} {
		if value, ok := cmd[key]; ok {
			body[key] = value
		}
	}
	if len(body) == 0 {
		return 0, fmt.Errorf("Chroma delete 命令缺少 ids/where/where_document")
	}
	path, err := c.collectionActionPath(ctx, collection, "delete")
	if err != nil {
		return 0, err
	}
	return int64(len(anySlice(body["ids"]))), c.doJSON(ctx, http.MethodPost, path, body, nil)
}

func (c *ChromaDB) upsertRows(ctx context.Context, collection string, rows []map[string]interface{}) error {
	if len(rows) == 0 {
		return nil
	}
	ids := make([]string, 0, len(rows))
	docs := make([]interface{}, 0, len(rows))
	metadatas := make([]map[string]interface{}, 0, len(rows))
	embeddings := make([]interface{}, 0, len(rows))
	hasEmbedding := false
	for _, row := range rows {
		id := chromaRowID(row)
		if id == "" {
			return fmt.Errorf("Chroma 写入行缺少 id")
		}
		ids = append(ids, id)
		docs = append(docs, firstExisting(row, "document", "_document", "documents"))
		meta := make(map[string]interface{})
		if raw, ok := row["metadata"].(map[string]interface{}); ok {
			for k, v := range raw {
				meta[k] = v
			}
		}
		for k, v := range row {
			if isChromaReservedRowField(k) {
				continue
			}
			if strings.HasPrefix(k, "metadata.") {
				meta[strings.TrimPrefix(k, "metadata.")] = v
				continue
			}
			meta[k] = v
		}
		metadatas = append(metadatas, meta)
		if embedding := firstExisting(row, "embedding", "_embedding", "embeddings"); embedding != nil {
			embeddings = append(embeddings, normalizeChromaEmbedding(embedding))
			hasEmbedding = true
		}
	}
	body := map[string]interface{}{
		"ids":       ids,
		"documents": docs,
		"metadatas": metadatas,
	}
	if hasEmbedding {
		body["embeddings"] = embeddings
	}
	path, err := c.collectionActionPath(ctx, collection, "upsert")
	if err != nil {
		return err
	}
	return c.doJSON(ctx, http.MethodPost, path, body, nil)
}
