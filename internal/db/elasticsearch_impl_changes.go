//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// esBulkActionMeta 构建 ES _bulk API 的 action 行元数据。
// 只有 ES 6.x 及更早版本必须带 _type；ES 7 起可省略，ES 8 与 OpenSearch 2.x 起携带会被整批拒绝，
// 因此版本未知时按 7.x 以后的写法省略。
func (e *ElasticsearchDB) esBulkActionMeta(action, indexName string, docID string) map[string]interface{} {
	meta := map[string]interface{}{"_index": indexName}
	if e.serverMajor > 0 && e.serverMajor < 7 {
		meta["_type"] = "_doc"
	}
	if docID != "" {
		meta["_id"] = docID
	}
	return map[string]interface{}{action: meta}
}

// resolveWriteIndex 解析别名 metadata 中唯一标记为 is_write_index 的索引。
// 直接索引名通过 GetAlias 的 404 判定；别名缺失或冲突时拒绝写入。
func (e *ElasticsearchDB) resolveWriteIndex(indexOrAlias string) (string, error) {
	return e.resolveWriteIndexContext(context.Background(), indexOrAlias)
}

func (e *ElasticsearchDB) resolveWriteIndexContext(ctx context.Context, indexOrAlias string) (string, error) {
	indexOrAlias = strings.TrimSpace(indexOrAlias)
	if indexOrAlias == "" {
		return "", fmt.Errorf("未指定索引或别名")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	res, err := e.client.Indices.GetAlias(
		e.client.Indices.GetAlias.WithContext(ctx),
		e.client.Indices.GetAlias.WithName(indexOrAlias),
	)
	if err != nil {
		return "", fmt.Errorf("读取别名 metadata 失败：%w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		if res.StatusCode == http.StatusNotFound {
			// Alias API 的 404 表示该名称不是别名，按直接索引名处理。
			_, _ = io.Copy(io.Discard, res.Body)
			return indexOrAlias, nil
		}
		body, readErr := readLimitedJSONResponseBody(res.Body)
		if readErr != nil {
			return "", fmt.Errorf("读取别名 metadata 失败：%w", readErr)
		}
		return "", fmt.Errorf("读取别名 metadata 失败（HTTP %d）：%s", res.StatusCode, strings.TrimSpace(string(body)))
	}

	body, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return "", fmt.Errorf("读取别名 metadata 失败：%w", err)
	}

	type aliasConfig struct {
		IsWriteIndex *bool `json:"is_write_index"`
	}
	type indexAliasMetadata struct {
		Aliases map[string]aliasConfig `json:"aliases"`
	}
	var aliasMap map[string]indexAliasMetadata
	if err := json.Unmarshal(body, &aliasMap); err != nil {
		return "", fmt.Errorf("解析别名 metadata 失败：%w", err)
	}

	writeIndexes := make([]string, 0, 1)
	for indexName, metadata := range aliasMap {
		config, ok := metadata.Aliases[indexOrAlias]
		if ok && config.IsWriteIndex != nil && *config.IsWriteIndex {
			writeIndexes = append(writeIndexes, indexName)
		}
	}
	if len(writeIndexes) != 1 {
		return "", fmt.Errorf("别名 %q 必须且只能有一个 is_write_index=true 索引，实际 %d 个", indexOrAlias, len(writeIndexes))
	}
	return writeIndexes[0], nil
}

// isESMetaField 判断字段名是否为 ES 元字段（不应写入文档 _source）。
func isESMetaField(name string) bool {
	switch strings.TrimSpace(name) {
	case "_id", "_index", "_type", "_score", "_source", "_routing", "_version", "_seq_no", "_primary_term", "_aggregations":
		return true
	}
	return false
}

// ApplyChanges 实现 BatchApplier 接口，通过 ES _bulk API 批量提交增删改。
func (e *ElasticsearchDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return e.ApplyChangesContext(context.Background(), tableName, changes)
}

func (e *ElasticsearchDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if e.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	indexName := resolveEsIndexName(tableName, "", e.database)
	if indexName == "" {
		return fmt.Errorf("未指定索引名")
	}

	var bulkBody bytes.Buffer

	// 如果目标是别名（非直接索引），解析出实际的可写索引名。
	writeIndexName, err := e.resolveWriteIndexContext(ctx, indexName)
	if err != nil {
		return fmt.Errorf("解析写入索引失败：%w", err)
	}

	// 删除操作
	for _, pk := range changes.Deletes {
		idVal, ok := pk["_id"]
		if !ok {
			return fmt.Errorf("删除操作缺少 _id")
		}
		actionJSON, _ := json.Marshal(e.esBulkActionMeta("delete", writeIndexName, fmt.Sprintf("%v", idVal)))
		bulkBody.Write(actionJSON)
		bulkBody.WriteByte('\n')
	}

	// 更新操作
	for _, update := range changes.Updates {
		idVal, ok := update.Keys["_id"]
		if !ok {
			return fmt.Errorf("更新操作缺少 _id")
		}
		actionJSON, _ := json.Marshal(e.esBulkActionMeta("update", writeIndexName, fmt.Sprintf("%v", idVal)))
		bulkBody.Write(actionJSON)
		bulkBody.WriteByte('\n')

		// 过滤 ES 元字段，只保留实际文档字段
		doc := make(map[string]interface{}, len(update.Values))
		for k, v := range update.Values {
			if !isESMetaField(k) {
				doc[k] = v
			}
		}
		wrapper := map[string]interface{}{"doc": doc}
		docJSON, _ := json.Marshal(wrapper)
		bulkBody.Write(docJSON)
		bulkBody.WriteByte('\n')
	}

	// 新增操作
	for _, insert := range changes.Inserts {
		var docID string
		if id, ok := insert["_id"]; ok {
			docID = fmt.Sprintf("%v", id)
		}

		// 从文档中移除 _id 和其他 ES 元字段
		doc := make(map[string]interface{}, len(insert))
		for k, v := range insert {
			if !isESMetaField(k) {
				doc[k] = v
			}
		}

		actionJSON, _ := json.Marshal(e.esBulkActionMeta("index", writeIndexName, docID))
		bulkBody.Write(actionJSON)
		bulkBody.WriteByte('\n')
		docJSON, _ := json.Marshal(doc)
		bulkBody.Write(docJSON)
		bulkBody.WriteByte('\n')
	}

	if bulkBody.Len() == 0 {
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// 数据网格提交后会立即重新查询：不刷新分片时，默认 1 秒刷新间隔内查到的仍是旧文档。
	// 不用 wait_for，避免 refresh_interval=-1 的索引一直等到超时。
	res, err := e.client.Bulk(
		bytes.NewReader(bulkBody.Bytes()),
		e.client.Bulk.WithContext(ctx),
		e.client.Bulk.WithRefresh("true"),
	)
	if err != nil {
		return fmt.Errorf("ES 批量操作失败：%w", err)
	}
	defer res.Body.Close()

	body, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return fmt.Errorf("读取 ES 批量操作响应失败：%w", err)
	}

	if res.IsError() {
		return fmt.Errorf("ES 批量操作错误：%s", string(body))
	}

	// 检查是否有单条操作失败
	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return MarkWriteOutcomeUnknown(fmt.Errorf("解析 ES 批量操作响应失败，写入状态未知：%w", err))
	}
	if hasErrors, ok := result["errors"].(bool); ok && hasErrors {
		err := elasticsearchBulkPartialFailure(result)
		logger.Warnf("%s", err.Error())
		return err
	}

	logger.Infof("ES 批量操作完成：索引=%s 删除=%d 更新=%d 新增=%d",
		indexName, len(changes.Deletes), len(changes.Updates), len(changes.Inserts))
	return nil
}

const (
	maxElasticsearchBulkFailureDetails      = 20
	maxElasticsearchBulkFailureIDRunes      = 128
	maxElasticsearchBulkFailureReasonRunes  = 200
	maxElasticsearchBulkFailureMessageRunes = 4 * 1024
)

func elasticsearchBulkPartialFailure(result map[string]interface{}) error {
	items, _ := result["items"].([]interface{})
	successCount := 0
	failureCount := 0
	details := make([]string, 0, maxElasticsearchBulkFailureDetails)
	for index, raw := range items {
		itemMap, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		opName, opMap := elasticsearchBulkItemOp(itemMap)
		if opMap == nil {
			continue
		}
		errMap, hasError := opMap["error"].(map[string]interface{})
		if !hasError {
			successCount++
			continue
		}
		failureCount++
		if len(details) < maxElasticsearchBulkFailureDetails {
			details = append(details, formatElasticsearchBulkFailureDetail(index, opName, opMap, errMap))
		}
	}
	if failureCount == 0 {
		return fmt.Errorf("ES 批量操作部分失败")
	}
	message := fmt.Sprintf("ES 批量操作部分失败：成功 %d 条，失败 %d 条：%s",
		successCount, failureCount, strings.Join(details, "; "))
	if omitted := failureCount - len(details); omitted > 0 {
		message += fmt.Sprintf("；其余 %d 条省略", omitted)
	}
	return fmt.Errorf("%s", truncateElasticsearchBulkFailureMessage(
		sanitizeElasticsearchBulkFailureText(message),
		maxElasticsearchBulkFailureMessageRunes,
	))
}

func elasticsearchBulkItemOp(item map[string]interface{}) (string, map[string]interface{}) {
	for opName, raw := range item {
		opMap, ok := raw.(map[string]interface{})
		if ok {
			return opName, opMap
		}
	}
	return "", nil
}

func formatElasticsearchBulkFailureDetail(index int, opName string, opMap, errMap map[string]interface{}) string {
	id := sanitizeElasticsearchBulkFailureText(fmt.Sprintf("%v", opMap["_id"]))
	if id == "" || id == "<nil>" {
		id = fmt.Sprintf("#%d", index+1)
	}
	id = truncateElasticsearchBulkFailureMessage(id, maxElasticsearchBulkFailureIDRunes)
	reason, _ := errMap["reason"].(string)
	if sanitizeElasticsearchBulkFailureText(reason) == "" {
		reason, _ = errMap["type"].(string)
	}
	reason = sanitizeElasticsearchBulkFailureText(reason)
	if reason == "" {
		reason = "unknown error"
	}
	reason = truncateElasticsearchBulkFailureMessage(reason, maxElasticsearchBulkFailureReasonRunes)
	opName = sanitizeElasticsearchBulkFailureText(opName)
	if opName == "" {
		return fmt.Sprintf("id=%s (%s)", id, reason)
	}
	return fmt.Sprintf("%s id=%s (%s)", opName, id, reason)
}

func sanitizeElasticsearchBulkFailureText(value string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value))
}

func truncateElasticsearchBulkFailureMessage(value string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	if utf8.RuneCountInString(value) <= maxRunes {
		return value
	}
	runes := []rune(value)
	if maxRunes == 1 {
		return "…"
	}
	return string(runes[:maxRunes-1]) + "…"
}
