//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// esFetchIndexAliases 获取指定索引关联的所有别名。
func (e *ElasticsearchDB) esFetchIndexAliases(indexName string) []string {
	ctx, cancel := context.WithTimeout(metadataContextFor(e), 10*time.Second)
	defer cancel()

	res, err := e.client.Indices.GetAlias(
		e.client.Indices.GetAlias.WithContext(ctx),
		e.client.Indices.GetAlias.WithIndex(indexName),
	)
	if err != nil {
		logger.Warnf("Elasticsearch 获取索引别名失败：%v", err)
		return nil
	}
	defer res.Body.Close()

	if res.IsError() {
		logger.Warnf("Elasticsearch 获取索引别名失败：%s", res.Status())
		return nil
	}

	// 响应格式：{ "index_name": { "aliases": { "alias_name": {} } } }
	body, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		logger.Warnf("Elasticsearch 读取索引别名响应失败：%v", err)
		return nil
	}

	var aliasMap map[string]interface{}
	if err := json.Unmarshal(body, &aliasMap); err != nil {
		logger.Warnf("Elasticsearch 解析索引别名失败：%v", err)
		return nil
	}

	var result []string
	for _, indexData := range aliasMap {
		data, ok := indexData.(map[string]interface{})
		if !ok {
			continue
		}
		aliases, ok := data["aliases"].(map[string]interface{})
		if !ok {
			continue
		}
		for aliasName := range aliases {
			if name := strings.TrimSpace(aliasName); name != "" {
				result = append(result, name)
			}
		}
	}
	return result
}

// esFetchIndexMapping 获取索引的 mapping 定义。
func (e *ElasticsearchDB) esFetchIndexMapping(indexName string) (map[string]interface{}, error) {
	if e.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}

	ctx, cancel := context.WithTimeout(metadataContextFor(e), 10*time.Second)
	defer cancel()

	res, err := e.client.Indices.GetMapping(
		e.client.Indices.GetMapping.WithContext(ctx),
		e.client.Indices.GetMapping.WithIndex(indexName),
	)
	if err != nil {
		return nil, fmt.Errorf("获取索引 mapping 失败：%w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return nil, fmt.Errorf("获取索引 mapping 失败：%s", res.Status())
	}

	body, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return nil, fmt.Errorf("读取 mapping 响应失败：%w", err)
	}

	var mappingResult map[string]interface{}
	if err := json.Unmarshal(body, &mappingResult); err != nil {
		return nil, fmt.Errorf("解析 mapping 失败：%w", err)
	}

	return mappingResult, nil
}

// extractColumnsFromMapping 从 mapping JSON 中提取字段定义。
// 递归处理嵌套对象（user.name）和多字段（title.keyword）。
// 兼容 ES 6.x（mappings.{type}.properties）和 ES 7.x+（mappings.properties）。
func extractColumnsFromMapping(indexName string, mapping map[string]interface{}) []connection.ColumnDefinition {
	indexData, ok := mapping[indexName].(map[string]interface{})
	if !ok {
		// 响应可能直接包含 index 数据（无外层索引名包裹），尝试自动查找
		for _, v := range mapping {
			if data, ok := v.(map[string]interface{}); ok {
				indexData = data
				break
			}
		}
	}
	if indexData == nil {
		return []connection.ColumnDefinition{}
	}

	mappings, ok := indexData["mappings"].(map[string]interface{})
	if !ok {
		return []connection.ColumnDefinition{}
	}

	properties, _ := mappings["properties"].(map[string]interface{})

	// ES 6.x：properties 在 type 层下面（如 mappings.doc.properties）
	if properties == nil {
		for _, v := range mappings {
			if typeMap, ok := v.(map[string]interface{}); ok {
				if props, ok := typeMap["properties"].(map[string]interface{}); ok {
					properties = props
					break
				}
			}
		}
	}

	if properties == nil {
		return []connection.ColumnDefinition{}
	}

	var columns []connection.ColumnDefinition
	expandESProperties(properties, "", &columns)

	// _id 是 ES 文档的唯一标识，等效于关系型数据库的主键。
	// 始终放在列首，使前端 editLocator 能识别主键并启用行编辑。
	idCol := connection.ColumnDefinition{
		Name:    "_id",
		Type:    "keyword",
		Key:     "PRI",
		Comment: "ES 文档唯一标识",
	}
	columns = append([]connection.ColumnDefinition{idCol}, columns...)

	return columns
}

// expandESProperties 递归展开 ES mapping properties。
// prefix 用于构建嵌套字段的点分路径（如 user.name）。
func expandESProperties(properties map[string]interface{}, prefix string, columns *[]connection.ColumnDefinition) {
	for name, prop := range properties {
		fullName := name
		if prefix != "" {
			fullName = prefix + "." + name
		}

		propMap, _ := prop.(map[string]interface{})
		colType := extractEsFieldType(prop)

		// 从 mapping 属性中提取注释
		comment := ""
		if propMap != nil {
			if desc, ok := propMap["description"].(string); ok {
				comment = desc
			}
		}

		col := connection.ColumnDefinition{
			Name:     fullName,
			Type:     colType,
			Nullable: "YES",
			Comment:  comment,
		}

		// 提取默认值（ES 7.x+ 的 null_value 作为参考）
		if propMap != nil {
			if nullVal, ok := propMap["null_value"]; ok {
				defaultStr := fmt.Sprintf("%v", nullVal)
				col.Default = &defaultStr
			}
		}

		*columns = append(*columns, col)

		// 递归处理嵌套对象的子字段
		if propMap != nil {
			if nested, ok := propMap["properties"].(map[string]interface{}); ok {
				expandESProperties(nested, fullName, columns)
			}
		}

		// 展开多字段（fields），如 title.keyword
		if propMap != nil {
			if fields, ok := propMap["fields"].(map[string]interface{}); ok {
				for fieldName, fieldDef := range fields {
					fieldType := extractEsFieldType(fieldDef)
					multiFieldName := fullName + "." + fieldName
					*columns = append(*columns, connection.ColumnDefinition{
						Name:     multiFieldName,
						Type:     fieldType,
						Nullable: "YES",
						Comment:  "multi-field",
					})
				}
			}
		}
	}
}

// extractEsFieldType 从字段属性中提取类型描述。
func extractEsFieldType(prop interface{}) string {
	propMap, ok := prop.(map[string]interface{})
	if !ok {
		return "unknown"
	}
	fieldType, _ := propMap["type"].(string)
	if fieldType == "" {
		if _, ok := propMap["properties"]; ok {
			return "object"
		}
		return "unknown"
	}
	return fieldType
}
