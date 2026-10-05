package db

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

func (m *MilvusDB) queryEntities(ctx context.Context, collection, filter string, outputFields []string, limit, offset int) ([]map[string]interface{}, []string, error) {
	name := strings.TrimSpace(collection)
	if name == "" {
		return nil, nil, fmt.Errorf("collection name cannot be empty")
	}
	if limit <= 0 {
		limit = 200
	}
	if len(outputFields) == 0 {
		outputFields = []string{"*"}
	}
	body := map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
		"outputFields":   outputFields,
		"limit":          limit,
	}
	if strings.TrimSpace(filter) != "" {
		body["filter"] = filter
	}
	if offset > 0 {
		body["offset"] = offset
	}
	var raw interface{}
	if err := m.doJSON(ctx, http.MethodPost, milvusEntitiesQueryPath, body, &raw); err != nil {
		return nil, nil, err
	}
	rows := milvusRowsFromValue(raw)
	return rows, collectColumns(rows), nil
}

func (m *MilvusDB) countEntities(ctx context.Context, collection, filter string) (int64, error) {
	rows, _, err := m.queryEntities(ctx, collection, filter, []string{"count(*)"}, 1, 0)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	return milvusCountValue(firstExisting(rows[0], "count(*)", "count", "total")), nil
}

func (m *MilvusDB) searchEntities(ctx context.Context, collection string, cmd map[string]interface{}) ([]map[string]interface{}, []string, error) {
	name := strings.TrimSpace(collection)
	if name == "" {
		return nil, nil, fmt.Errorf("collection name cannot be empty")
	}
	data := milvusSearchData(cmd)
	if len(data) == 0 {
		return nil, nil, fmt.Errorf("Milvus search requires data or vector")
	}
	annsField := firstStringValue(cmd, "anns_field", "annsField", "vector_field", "vectorField")
	if annsField == "" {
		var err error
		annsField, err = m.vectorField(ctx, name)
		if err != nil {
			return nil, nil, err
		}
	}
	body := map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
		"data":           data,
		"annsField":      annsField,
		"limit":          intFromAny(firstExisting(cmd, "limit", "n_results", "nResults"), 10),
	}
	if outputFields := stringSliceFromAny(firstExisting(cmd, "output_fields", "outputFields"), nil); len(outputFields) > 0 {
		body["outputFields"] = outputFields
	}
	if filter := firstStringValue(cmd, "filter", "expr"); filter != "" {
		body["filter"] = filter
	}
	if offset := intFromAny(firstExisting(cmd, "offset"), 0); offset > 0 {
		body["offset"] = offset
	}
	if params := firstExisting(cmd, "search_params", "searchParams", "params"); params != nil {
		body["searchParams"] = params
	}
	var raw interface{}
	if err := m.doJSON(ctx, http.MethodPost, milvusEntitiesSearchPath, body, &raw); err != nil {
		return nil, nil, err
	}
	rows := milvusRowsFromValue(raw)
	return rows, collectColumns(rows), nil
}

func (m *MilvusDB) queryJSON(ctx context.Context, text string) ([]map[string]interface{}, []string, error) {
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(text), &cmd); err != nil {
		return nil, nil, fmt.Errorf("decode Milvus JSON command: %w", err)
	}
	if hasAnyKey(cmd, "list_collections", "listCollections") {
		collections, err := m.listCollections(ctx, m.database)
		if err != nil {
			return nil, nil, err
		}
		rows := make([]map[string]interface{}, 0, len(collections))
		for _, name := range collections {
			rows = append(rows, map[string]interface{}{"name": name})
		}
		return rows, []string{"name"}, nil
	}
	if name := firstStringValue(cmd, "describe_collection", "describeCollection", "get_collection", "getCollection"); name != "" {
		info, err := m.getCollectionInfo(ctx, m.database, name)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{info}, collectColumns([]map[string]interface{}{info}), nil
	}
	if name := firstStringValue(cmd, "count", "collection"); name != "" && hasAnyKey(cmd, "count") {
		total, err := m.countEntities(ctx, name, firstStringValue(cmd, "filter", "expr"))
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"total": total}}, []string{"total"}, nil
	}
	if name := firstStringValue(cmd, "search", "collection", "query"); name != "" && (hasAnyKey(cmd, "search", "vector", "query_vector", "queryVector", "data")) {
		return m.searchEntities(ctx, name, cmd)
	}
	if name := firstStringValue(cmd, "query", "scroll", "get", "collection"); name != "" {
		return m.queryEntities(
			ctx,
			name,
			firstStringValue(cmd, "filter", "expr"),
			stringSliceFromAny(firstExisting(cmd, "output_fields", "outputFields", "fields"), []string{"*"}),
			intFromAny(firstExisting(cmd, "limit"), 200),
			intFromAny(firstExisting(cmd, "offset"), 0),
		)
	}
	return nil, nil, fmt.Errorf("Milvus JSON query commands support list_collections/describe_collection/query/count/search")
}

func (m *MilvusDB) createCollection(ctx context.Context, collection string, cmd map[string]interface{}) error {
	name := strings.TrimSpace(collection)
	if name == "" {
		return fmt.Errorf("collection name cannot be empty")
	}
	body := map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
	}
	if dimension := intFromAny(firstExisting(cmd, "dimension", "dim"), 0); dimension > 0 {
		body["dimension"] = dimension
	}
	for _, item := range []struct {
		keys []string
		name string
	}{
		{[]string{"metric_type", "metricType"}, "metricType"},
		{[]string{"primary_field_name", "primaryFieldName"}, "primaryFieldName"},
		{[]string{"vector_field_name", "vectorFieldName"}, "vectorFieldName"},
		{[]string{"vector_field_type", "vectorFieldType"}, "vectorFieldType"},
		{[]string{"id_type", "idType"}, "idType"},
		{[]string{"consistency_level", "consistencyLevel"}, "consistencyLevel"},
		{[]string{"description"}, "description"},
	} {
		if value := firstExisting(cmd, item.keys...); value != nil {
			body[item.name] = value
		}
	}
	if value := firstExisting(cmd, "auto_id", "autoID"); value != nil {
		body["autoID"] = milvusBoolValue(value, false)
	}
	if value := firstExisting(cmd, "schema"); value != nil {
		body["schema"] = value
	}
	if value := firstExisting(cmd, "index_params", "indexParams"); value != nil {
		body["indexParams"] = value
	}
	if value := firstExisting(cmd, "params"); value != nil {
		body["params"] = value
	}
	if value := firstExisting(cmd, "properties"); value != nil {
		body["properties"] = value
	}
	return m.doJSON(ctx, http.MethodPost, milvusCollectionsCreatePath, body, nil)
}

func (m *MilvusDB) dropCollection(ctx context.Context, collection string) error {
	name := strings.TrimSpace(collection)
	if name == "" {
		return fmt.Errorf("collection name cannot be empty")
	}
	return m.doJSON(ctx, http.MethodPost, milvusCollectionsDropPath, map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
	}, nil)
}

func (m *MilvusDB) insertEntities(ctx context.Context, collection string, rows []map[string]interface{}) error {
	return m.writeEntities(ctx, milvusEntitiesInsertPath, collection, rows, false)
}

func (m *MilvusDB) upsertEntities(ctx context.Context, collection string, rows []map[string]interface{}, partialUpdate bool) error {
	return m.writeEntities(ctx, milvusEntitiesUpsertPath, collection, rows, partialUpdate)
}

func (m *MilvusDB) writeEntities(ctx context.Context, path, collection string, rows []map[string]interface{}, partialUpdate bool) error {
	name := strings.TrimSpace(collection)
	if name == "" {
		return fmt.Errorf("collection name cannot be empty")
	}
	if len(rows) == 0 {
		return nil
	}
	body := map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
		"data":           rows,
	}
	if partialUpdate {
		body["partialUpdate"] = true
	}
	return m.doJSON(ctx, http.MethodPost, path, body, nil)
}

func (m *MilvusDB) deleteCommand(ctx context.Context, collection string, cmd map[string]interface{}) (int64, error) {
	filter := firstStringValue(cmd, "filter", "expr")
	count := int64(0)
	if filter == "" {
		ids := anySlice(firstExisting(cmd, "ids", "id", "primary_keys", "primaryKeys"))
		if len(ids) == 0 {
			return 0, fmt.Errorf("Milvus delete command requires filter or ids")
		}
		primary, err := m.primaryFieldInfo(ctx, collection)
		if err != nil {
			return 0, err
		}
		filter, err = milvusIDFilterWithType(primary.name, primary.typeName, ids)
		if err != nil {
			return 0, err
		}
		count = int64(len(ids))
	}
	if err := m.deleteEntities(ctx, collection, filter); err != nil {
		return 0, err
	}
	return count, nil
}

func (m *MilvusDB) deleteEntities(ctx context.Context, collection, filter string) error {
	if strings.TrimSpace(filter) == "" {
		return fmt.Errorf("Milvus delete filter cannot be empty")
	}
	return m.doJSON(ctx, http.MethodPost, milvusEntitiesDeletePath, map[string]interface{}{
		"dbName":         m.database,
		"collectionName": strings.TrimSpace(collection),
		"filter":         filter,
	}, nil)
}

func (m *MilvusDB) createIndex(ctx context.Context, collection string, cmd map[string]interface{}) error {
	name := strings.TrimSpace(collection)
	if name == "" {
		return fmt.Errorf("collection name cannot be empty")
	}
	indexParams := firstExisting(cmd, "index_params", "indexParams")
	if indexParams == nil {
		fieldName := firstStringValue(cmd, "field_name", "fieldName")
		if fieldName == "" {
			return fmt.Errorf("Milvus create_index command requires field_name or index_params")
		}
		index := map[string]interface{}{"fieldName": fieldName}
		if indexName := firstStringValue(cmd, "index_name", "indexName"); indexName != "" {
			index["indexName"] = indexName
		}
		if metricType := firstStringValue(cmd, "metric_type", "metricType"); metricType != "" {
			index["metricType"] = metricType
		}
		if indexType := firstStringValue(cmd, "index_type", "indexType"); indexType != "" {
			index["indexType"] = indexType
		}
		if params := firstExisting(cmd, "params"); params != nil {
			index["params"] = params
		}
		indexParams = []map[string]interface{}{index}
	}
	return m.doJSON(ctx, http.MethodPost, milvusIndexesCreatePath, map[string]interface{}{
		"dbName":         m.database,
		"collectionName": name,
		"indexParams":    indexParams,
	}, nil)
}

func (m *MilvusDB) dropIndex(ctx context.Context, collection, indexName string) error {
	if strings.TrimSpace(indexName) == "" {
		return fmt.Errorf("Milvus drop_index command requires index_name")
	}
	return m.doJSON(ctx, http.MethodPost, milvusIndexesDropPath, map[string]interface{}{
		"dbName":         m.database,
		"collectionName": strings.TrimSpace(collection),
		"indexName":      strings.TrimSpace(indexName),
	}, nil)
}

type milvusPrimaryField struct {
	name     string
	typeName string
}

func (m *MilvusDB) primaryFieldInfo(ctx context.Context, collection string) (milvusPrimaryField, error) {
	info, err := m.getCollectionInfo(ctx, m.database, collection)
	if err != nil {
		return milvusPrimaryField{}, err
	}
	for _, field := range milvusMapSlice(info["fields"]) {
		if milvusBoolValue(firstExisting(field, "primaryKey", "isPrimary", "isPrimaryKey"), false) {
			if name := firstStringValue(field, "name", "fieldName"); name != "" {
				return milvusPrimaryField{
					name:     name,
					typeName: firstStringValue(field, "type", "dataType"),
				}, nil
			}
		}
	}
	return milvusPrimaryField{}, fmt.Errorf("Milvus collection %q has no primary key field", collection)
}

func (m *MilvusDB) vectorField(ctx context.Context, collection string) (string, error) {
	info, err := m.getCollectionInfo(ctx, m.database, collection)
	if err != nil {
		return "", err
	}
	for _, field := range milvusMapSlice(info["fields"]) {
		if !strings.Contains(strings.ToLower(firstStringValue(field, "type", "dataType")), "vector") {
			continue
		}
		if name := firstStringValue(field, "name", "fieldName"); name != "" {
			return name, nil
		}
	}
	return "", fmt.Errorf("Milvus collection %q has no vector field", collection)
}
