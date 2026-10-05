//go:build gonavi_full_drivers || gonavi_mongodb_driver

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Query executes a MongoDB command and returns results
// Supports JSON format commands like: {"find": "collection", "filter": {}}
func (m *MongoDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return m.queryWithContext(ctx, query)
}

// QueryContext executes a MongoDB command with the given context for timeout control
func (m *MongoDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return m.queryWithContext(ctx, query)
}

// sqlToMongoFind 将前端生成的简单 SQL 转换为 MongoDB find 命令 JSON。
// 支持：SELECT * FROM "coll" LIMIT n OFFSET m / SELECT COUNT(*) as total FROM "coll"
func sqlToMongoFind(sql string) (string, bool) {
	lower := strings.ToLower(strings.TrimSpace(sql))

	// SELECT COUNT(*) as total FROM "coll" ...
	if strings.HasPrefix(lower, "select count(") {
		coll := extractCollectionFromSQL(sql)
		if coll == "" {
			return "", false
		}
		return fmt.Sprintf(`{"count":"%s","query":{}}`, coll), true
	}

	// SELECT * FROM "coll" ... LIMIT n OFFSET m
	if !strings.HasPrefix(lower, "select") {
		return "", false
	}
	coll := extractCollectionFromSQL(sql)
	if coll == "" {
		return "", false
	}

	limit := int64(0)
	skip := int64(0)

	// 提取 LIMIT
	if idx := strings.Index(lower, "limit "); idx >= 0 {
		after := strings.TrimSpace(lower[idx+6:])
		parts := strings.Fields(after)
		if len(parts) > 0 {
			if n, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
				limit = n
			}
		}
	}

	// 提取 OFFSET
	if idx := strings.Index(lower, "offset "); idx >= 0 {
		after := strings.TrimSpace(lower[idx+7:])
		parts := strings.Fields(after)
		if len(parts) > 0 {
			if n, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
				skip = n
			}
		}
	}

	cmd := fmt.Sprintf(`{"find":"%s","filter":{}`, coll)
	if limit > 0 {
		cmd += fmt.Sprintf(`,"limit":%d`, limit)
	}
	if skip > 0 {
		cmd += fmt.Sprintf(`,"skip":%d`, skip)
	}
	cmd += "}"
	return cmd, true
}

// extractCollectionFromSQL 从 SQL 中提取 FROM 后的 collection 名称。
func extractCollectionFromSQL(sql string) string {
	lower := strings.ToLower(sql)
	idx := strings.Index(lower, "from ")
	if idx < 0 {
		return ""
	}
	after := strings.TrimSpace(sql[idx+5:])

	// 去掉引号包裹
	var coll string
	if len(after) > 0 && after[0] == '"' {
		end := strings.Index(after[1:], "\"")
		if end < 0 {
			return ""
		}
		coll = after[1 : end+1]
	} else if len(after) > 0 && after[0] == '`' {
		end := strings.Index(after[1:], "`")
		if end < 0 {
			return ""
		}
		coll = after[1 : end+1]
	} else {
		parts := strings.Fields(after)
		if len(parts) == 0 {
			return ""
		}
		coll = parts[0]
	}
	return strings.TrimSpace(coll)
}

func (m *MongoDB) queryWithContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if m.client == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil, fmt.Errorf("empty query")
	}

	// 如果输入是 SQL 语句（前端 DataViewer 统一生成），自动转换为 MongoDB JSON 命令
	lowerQuery := strings.ToLower(query)
	if strings.HasPrefix(lowerQuery, "select") || strings.HasPrefix(lowerQuery, "show") {
		if converted, ok := sqlToMongoFind(query); ok {
			query = converted
		}
	}

	// Parse JSON command
	var cmd bson.D
	if err := bson.UnmarshalExtJSON([]byte(query), true, &cmd); err != nil {
		return nil, nil, fmt.Errorf("invalid JSON command: %w", err)
	}

	// 对 find 和 count 命令使用原生 driver API，避免 RunCommand 的 firstBatch 限制
	if len(cmd) > 0 {
		switch cmd[0].Key {
		case "find":
			return m.execFind(ctx, cmd)
		case "count":
			return m.execCount(ctx, cmd)
		}
	}

	// 其他命令走 RunCommand
	db := m.client.Database(m.database)
	var result bson.M
	if err := db.RunCommand(ctx, cmd).Decode(&result); err != nil {
		return nil, nil, err
	}

	// Handle COUNT result (e.g. delete/update returns "n")
	if n, ok := result["n"]; ok {
		if _, hasCursor := result["cursor"]; !hasCursor {
			return []map[string]interface{}{{"total": n}}, []string{"total"}, nil
		}
	}

	// Convert result to standard format
	data := []map[string]interface{}{{"result": result}}
	columns := []string{"result"}

	// If result contains cursor with documents, extract them
	if cursor, ok := result["cursor"].(bson.M); ok {
		if batch, ok := cursor["firstBatch"].(bson.A); ok {
			data = make([]map[string]interface{}, 0, len(batch))
			columnSet := make(map[string]bool)
			for _, doc := range batch {
				if docMap, ok := doc.(bson.M); ok {
					row := make(map[string]interface{})
					for k, v := range docMap {
						row[k] = v
						columnSet[k] = true
					}
					data = append(data, row)
				}
			}
			columns = make([]string, 0, len(columnSet))
			for k := range columnSet {
				columns = append(columns, k)
			}
		}
	}

	return data, columns, nil
}

// execFind 使用原生 Collection.Find() 执行查询，正确处理游标迭代
func (m *MongoDB) execFind(ctx context.Context, cmd bson.D) ([]map[string]interface{}, []string, error) {
	var collName string
	var filter interface{}
	var limit int64
	var skip int64
	var sortDoc interface{}
	var projection interface{}
	var includeObjectIDLocator bool

	for _, elem := range cmd {
		switch elem.Key {
		case "find":
			collName = fmt.Sprintf("%v", elem.Value)
		case "filter":
			filter = elem.Value
		case "limit":
			limit = asMongoInt64(elem.Value)
		case "skip":
			skip = asMongoInt64(elem.Value)
		case "sort":
			sortDoc = elem.Value
		case "projection":
			projection = elem.Value
		case "__gonaviIncludeObjectIDLocator":
			if enabled, ok := elem.Value.(bool); ok {
				includeObjectIDLocator = enabled
			}
		}
	}

	if collName == "" {
		return nil, nil, fmt.Errorf("find command missing collection name")
	}
	if filter == nil {
		filter = bson.D{}
	}

	collection := m.client.Database(m.database).Collection(collName)
	opts := options.Find()
	if limit > 0 {
		opts.SetLimit(limit)
	}
	if skip > 0 {
		opts.SetSkip(skip)
	}
	if sortDoc != nil {
		opts.SetSort(sortDoc)
	}
	if projection != nil {
		opts.SetProjection(projection)
	}

	cursor, err := collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, nil, err
	}
	defer cursor.Close(ctx)
	return decodeMongoFindCursor(ctx, cursor, includeObjectIDLocator)
}

func decodeMongoFindCursor(ctx context.Context, cursor mongoCursorDecoder, includeObjectIDLocator bool) ([]map[string]interface{}, []string, error) {
	var data []map[string]interface{}
	columnSet := make(map[string]bool)

	documentNumber := 0
	for cursor.Next(ctx) {
		documentNumber++
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			return nil, nil, fmt.Errorf("decode MongoDB document %d: %w", documentNumber, err)
		}
		row := make(map[string]interface{})
		for k, v := range doc {
			if includeObjectIDLocator && k == "_id" {
				row[mongoObjectIDLocatorColumn] = buildMongoObjectIDLocatorValue(v)
				columnSet[mongoObjectIDLocatorColumn] = true
			}
			row[k] = convertBsonValue(v)
			columnSet[k] = true
		}
		data = append(data, row)
	}

	if err := cursor.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate MongoDB query results: %w", err)
	}

	columns := make([]string, 0, len(columnSet))
	for k := range columnSet {
		columns = append(columns, k)
	}
	sort.Strings(columns)

	// 将 _id 列置首
	for i, col := range columns {
		if col == "_id" && i > 0 {
			columns = append(columns[:i], columns[i+1:]...)
			columns = append([]string{"_id"}, columns...)
			break
		}
	}

	return data, columns, nil
}

func buildMongoObjectIDLocatorValue(v interface{}) interface{} {
	if oid, ok := v.(bson.ObjectID); ok {
		return bson.M{"$oid": oid.Hex()}
	}
	return convertBsonValue(v)
}

// execCount 使用原生 Collection.CountDocuments() 执行计数
func (m *MongoDB) execCount(ctx context.Context, cmd bson.D) ([]map[string]interface{}, []string, error) {
	var collName string
	var filter interface{}

	for _, elem := range cmd {
		switch elem.Key {
		case "count":
			collName = fmt.Sprintf("%v", elem.Value)
		case "query":
			filter = elem.Value
		}
	}

	if collName == "" {
		return nil, nil, fmt.Errorf("count command missing collection name")
	}
	if filter == nil {
		filter = bson.D{}
	}

	collection := m.client.Database(m.database).Collection(collName)
	n, err := collection.CountDocuments(ctx, filter)
	if err != nil {
		return nil, nil, err
	}

	return []map[string]interface{}{{"total": n}}, []string{"total"}, nil
}

// convertBsonValue 将 BSON 特殊类型转换为前端可读的 JSON 友好值
func convertBsonValue(v interface{}) interface{} {
	switch val := v.(type) {
	case map[string]interface{}:
		result := make(map[string]interface{}, len(val))
		for k, v2 := range val {
			result[k] = convertBsonValue(v2)
		}
		return result
	case bson.ObjectID:
		if converted, ok := encodeMongoExtendedJSONFieldValue(val); ok {
			return converted
		}
		return val.Hex()
	case bson.M:
		result := make(map[string]interface{}, len(val))
		for k, v2 := range val {
			result[k] = convertBsonValue(v2)
		}
		return result
	case bson.D:
		result := make(map[string]interface{}, len(val))
		for _, elem := range val {
			result[elem.Key] = convertBsonValue(elem.Value)
		}
		return result
	case bson.A:
		result := make([]interface{}, len(val))
		for i, v2 := range val {
			result[i] = convertBsonValue(v2)
		}
		return result
	case []interface{}:
		result := make([]interface{}, len(val))
		for i, v2 := range val {
			result[i] = convertBsonValue(v2)
		}
		return result
	default:
		if !shouldEncodeMongoExtendedJSONFieldValue(v) {
			return v
		}
		if converted, ok := encodeMongoExtendedJSONFieldValue(v); ok {
			return converted
		}
		return v
	}
}

func shouldEncodeMongoExtendedJSONFieldValue(v interface{}) bool {
	switch v.(type) {
	case bson.DateTime,
		bson.Decimal128,
		bson.Binary,
		bson.Regex,
		bson.Timestamp,
		bson.MaxKey,
		bson.MinKey,
		bson.Undefined,
		int32,
		int64,
		[]byte,
		time.Time:
		return true
	default:
		return false
	}
}

func encodeMongoExtendedJSONFieldValue(v interface{}) (interface{}, bool) {
	payload, err := bson.MarshalExtJSON(bson.M{"v": v}, true, false)
	if err != nil {
		return nil, false
	}

	var wrapped map[string]interface{}
	if err := json.Unmarshal(payload, &wrapped); err != nil {
		return nil, false
	}

	converted, ok := wrapped["v"]
	return converted, ok
}

func decodeMongoExtendedJSONFieldValue(v interface{}) interface{} {
	payload, err := json.Marshal(map[string]interface{}{"v": v})
	if err != nil {
		return v
	}

	var wrapped bson.M
	if err := bson.UnmarshalExtJSON(payload, false, &wrapped); err != nil {
		return v
	}

	if converted, ok := wrapped["v"]; ok {
		return converted
	}
	return v
}
