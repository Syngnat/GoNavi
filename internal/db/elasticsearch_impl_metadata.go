//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	"github.com/elastic/go-elasticsearch/v8/esapi"
)

// GetDatabases 列出所有 Elasticsearch 索引。
func (e *ElasticsearchDB) GetDatabases() ([]string, error) {
	if e.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	totalTimeout := e.indexListTimeout
	if totalTimeout <= 0 {
		totalTimeout = defaultEsIndexListTimeout
	}
	deadline := time.Now().Add(totalTimeout)
	catTimeout := totalTimeout / 2
	if catTimeout > maxEsCatIndexListTimeout {
		catTimeout = maxEsCatIndexListTimeout
	}
	if catTimeout <= 0 {
		catTimeout = totalTimeout
	}

	catCtx, cancelCat := context.WithTimeout(metadataContextFor(e), catTimeout)
	indices, catErr := e.getDatabasesViaCat(catCtx)
	cancelCat()
	if catErr == nil {
		return normalizeESIndexNames(indices), nil
	}

	logger.Warnf("Elasticsearch CAT 索引枚举失败，回退 Alias API：%v", catErr)
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return nil, fmt.Errorf("获取索引列表失败：CAT Indices API: %v；Alias API: 总超时 %s 已耗尽", catErr, totalTimeout)
	}

	aliasCtx, cancelAlias := context.WithTimeout(metadataContextFor(e), remaining)
	indices, aliasErr := e.getDatabasesViaAlias(aliasCtx)
	cancelAlias()
	if aliasErr == nil {
		return normalizeESIndexNames(indices), nil
	}
	return nil, fmt.Errorf("获取索引列表失败：CAT Indices API: %v；Alias API: %v", catErr, aliasErr)
}

func (e *ElasticsearchDB) getDatabasesViaCat(ctx context.Context) ([]string, error) {
	indices, err := e.getDatabasesViaCatRequest(ctx, true)
	if err == nil {
		return indices, nil
	}

	var statusErr *esHTTPStatusError
	if !errors.As(err, &statusErr) || statusErr.statusCode != http.StatusBadRequest {
		return nil, err
	}

	indices, compatibilityErr := e.getDatabasesViaCatRequest(ctx, false)
	if compatibilityErr != nil {
		return nil, fmt.Errorf("全量通配请求: %v；旧版兼容请求: %v", err, compatibilityErr)
	}
	return indices, nil
}

func (e *ElasticsearchDB) getDatabasesViaCatRequest(ctx context.Context, expandAll bool) ([]string, error) {
	options := []func(*esapi.CatIndicesRequest){
		e.client.Cat.Indices.WithContext(ctx),
		e.client.Cat.Indices.WithFormat("json"),
		e.client.Cat.Indices.WithH("index"),
	}
	if expandAll {
		options = append(options, e.client.Cat.Indices.WithExpandWildcards("all"))
	}

	res, err := e.client.Cat.Indices(options...)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.IsError() {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil, &esHTTPStatusError{statusCode: res.StatusCode, status: res.Status()}
	}

	var rows []struct {
		Index string `json:"index"`
	}
	body, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return nil, fmt.Errorf("读取索引列表响应失败：%w", err)
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, fmt.Errorf("解析响应失败：%w", err)
	}

	indices := make([]string, 0, len(rows))
	for _, row := range rows {
		indices = append(indices, row.Index)
	}
	return indices, nil
}

func (e *ElasticsearchDB) getDatabasesViaAlias(ctx context.Context) ([]string, error) {
	res, err := e.client.Indices.GetAlias(
		e.client.Indices.GetAlias.WithContext(ctx),
		e.client.Indices.GetAlias.WithIndex("*"),
		e.client.Indices.GetAlias.WithExpandWildcards("all"),
		e.client.Indices.GetAlias.WithAllowNoIndices(true),
		e.client.Indices.GetAlias.WithIgnoreUnavailable(true),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.IsError() {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil, &esHTTPStatusError{statusCode: res.StatusCode, status: res.Status()}
	}

	var indexMap map[string]interface{}
	body, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return nil, fmt.Errorf("读取别名响应失败：%w", err)
	}
	if err := json.Unmarshal(body, &indexMap); err != nil {
		return nil, fmt.Errorf("解析响应失败：%w", err)
	}

	indices := make([]string, 0, len(indexMap))
	for name := range indexMap {
		indices = append(indices, name)
	}
	return indices, nil
}

func normalizeESIndexNames(indices []string) []string {
	seen := make(map[string]struct{}, len(indices))
	result := make([]string, 0, len(indices))
	for _, index := range indices {
		name := strings.TrimSpace(index)
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}

// GetTables 对 ES 而言索引即表，返回索引自身名称及别名。
func (e *ElasticsearchDB) GetTables(dbName string) ([]string, error) {
	if e.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	target := strings.TrimSpace(dbName)
	if target == "" {
		target = e.database
	}
	if target == "" {
		return nil, fmt.Errorf("未指定索引名")
	}

	tables := []string{target}
	aliases := e.esFetchIndexAliases(target)
	tables = append(tables, aliases...)
	return tables, nil
}

// TableExists checks one concrete index or alias without assuming that the
// selected index still exists after its metadata was cached.
func (e *ElasticsearchDB) TableExists(dbName, tableName string) (bool, error) {
	if e.client == nil {
		return false, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	indexName := resolveEsIndexName(dbName, tableName, e.database)
	if indexName == "" {
		return false, fmt.Errorf("未指定索引名")
	}

	ctx, cancel := context.WithTimeout(metadataContextFor(e), defaultEsPingTimeout)
	defer cancel()
	res, err := e.client.Indices.Exists(
		[]string{indexName},
		e.client.Indices.Exists.WithContext(ctx),
		e.client.Indices.Exists.WithExpandWildcards("all"),
		e.client.Indices.Exists.WithAllowNoIndices(true),
		e.client.Indices.Exists.WithIgnoreUnavailable(true),
	)
	if err != nil {
		return false, fmt.Errorf("检查索引是否存在失败：%w", err)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)

	switch res.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, fmt.Errorf("检查索引是否存在失败：%s", res.Status())
	}
}

// GetCreateStatement 返回索引的 settings + mappings 组合 JSON。
func (e *ElasticsearchDB) GetCreateStatement(dbName, tableName string) (string, error) {
	if e.client == nil {
		return "", localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	indexName := resolveEsIndexName(dbName, tableName, e.database)
	if indexName == "" {
		return "", fmt.Errorf("未指定索引名")
	}

	ctx, cancel := context.WithTimeout(metadataContextFor(e), 10*time.Second)
	defer cancel()

	res, err := e.client.Indices.Get(
		[]string{indexName},
		e.client.Indices.Get.WithContext(ctx),
	)
	if err != nil {
		return "", fmt.Errorf("获取索引定义失败：%w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return "", fmt.Errorf("获取索引定义失败：%s", res.Status())
	}

	body, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return "", fmt.Errorf("读取索引定义失败：%w", err)
	}

	var pretty map[string]interface{}
	if err := json.Unmarshal(body, &pretty); err != nil {
		return string(body), nil
	}
	formatted, _ := json.MarshalIndent(pretty, "", "  ")
	return fmt.Sprintf("// Elasticsearch index: %s\n%s", indexName, string(formatted)), nil
}

// GetColumns 返回索引的 mapping 字段定义。
func (e *ElasticsearchDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	if e.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	indexName := resolveEsIndexName(dbName, tableName, e.database)
	if indexName == "" {
		return nil, fmt.Errorf("未指定索引名")
	}

	mapping, err := e.esFetchIndexMapping(indexName)
	if err != nil {
		return nil, err
	}
	return extractColumnsFromMapping(indexName, mapping), nil
}

// GetAllColumns 返回索引的全部字段定义（带表名标识）。
func (e *ElasticsearchDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	if e.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	target := strings.TrimSpace(dbName)
	if target == "" {
		target = e.database
	}
	if target == "" {
		return nil, fmt.Errorf("未指定索引名")
	}

	mapping, err := e.esFetchIndexMapping(target)
	if err != nil {
		return nil, err
	}

	columns := extractColumnsFromMapping(target, mapping)
	result := make([]connection.ColumnDefinitionWithTable, 0, len(columns))
	for _, col := range columns {
		result = append(result, connection.ColumnDefinitionWithTable{
			TableName: target,
			Name:      col.Name,
			Type:      col.Type,
			Comment:   col.Comment,
		})
	}
	return result, nil
}

// GetIndexes 返回索引的 settings 中定义的分片与副本信息。
func (e *ElasticsearchDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	if e.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	indexName := resolveEsIndexName(dbName, tableName, e.database)
	if indexName == "" {
		return nil, fmt.Errorf("未指定索引名")
	}

	ctx, cancel := context.WithTimeout(metadataContextFor(e), 10*time.Second)
	defer cancel()

	res, err := e.client.Indices.GetSettings(
		e.client.Indices.GetSettings.WithContext(ctx),
		e.client.Indices.GetSettings.WithIndex(indexName),
	)
	if err != nil {
		return nil, fmt.Errorf("获取索引设置失败：%w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return nil, fmt.Errorf("获取索引设置失败：%s", res.Status())
	}

	body, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return nil, fmt.Errorf("读取索引设置失败：%w", err)
	}

	var settings map[string]map[string]interface{}
	if err := json.Unmarshal(body, &settings); err != nil {
		return nil, fmt.Errorf("解析索引设置失败：%w", err)
	}

	var indexes []connection.IndexDefinition

	// ES 无传统主键概念，_id 字段是每条文档的唯一标识，等效于主键。
	// 返回 _id 作为 "PRIMARY" 索引，使前端识别到唯一标识并解除只读模式。
	indexes = append(indexes, connection.IndexDefinition{
		Name:       "PRIMARY",
		ColumnName: "_id",
		NonUnique:  0,
		SeqInIndex: 1,
		IndexType:  "PRIMARY",
	})

	for name, data := range settings {
		idxSettings, _ := data["settings"].(map[string]interface{})
		indexSection, _ := idxSettings["index"].(map[string]interface{})

		shards := "1"
		replicas := "1"
		if s, ok := indexSection["number_of_shards"].(string); ok {
			shards = s
		}
		if r, ok := indexSection["number_of_replicas"].(string); ok {
			replicas = r
		}

		indexes = append(indexes, connection.IndexDefinition{
			Name:       name,
			ColumnName: fmt.Sprintf("shards=%s replicas=%s", shards, replicas),
			NonUnique:  0,
			SeqInIndex: 1,
			IndexType:  "INDEX",
		})
	}
	return indexes, nil
}

// GetForeignKeys ES 不支持外键，返回空列表。
func (e *ElasticsearchDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

// GetTriggers ES 不支持触发器，返回空列表。
func (e *ElasticsearchDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}
