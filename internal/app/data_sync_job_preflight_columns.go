package app

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/syncjob"
)

// 预检的列元数据预取。
//
// 逐表校验时，每张表要读一次源端字段、一次目标端字段；N 张表就是 2N 次往返。
// 支持 TableColumnsBatcher 的驱动（当前是 Oracle）可以把同 schema 的表合并成
// 一条查询，于是降到每次「一个 schema 一条」。
//
// 设计上刻意做得保守：
//   - 只对同一 schema 下 >= 2 张表启用批量（单表用批量没有收益，还会绕过
//     驱动内部针对空结果的字典回退链）；
//   - 批量查询失败、驱动不支持、或某张表缺席，一律回退到原有的逐表读取，
//     因此行为与改动前一致，只是常见路径少发了查询。

// dataSyncPreflightColumnKey 是预取缓存的键。side 区分源端与目标端：
// 同一张表在两个端点上的字段可能不同，不能共用条目。
type dataSyncPreflightColumnKey struct {
	side     string
	database string
	schema   string
	table    string
}

// dataSyncPreflightColumnCache 保存预取到的列定义。缺席表示需要回退。
type dataSyncPreflightColumnCache struct {
	columns map[dataSyncPreflightColumnKey][]connection.ColumnDefinition
}

// lookup 返回预取结果。第二个返回值为 false 时，调用方必须回退到逐表读取。
func (c *dataSyncPreflightColumnCache) lookup(key dataSyncPreflightColumnKey) ([]connection.ColumnDefinition, bool) {
	if c == nil || c.columns == nil {
		return nil, false
	}
	columns, ok := c.columns[key]
	if !ok || len(columns) == 0 {
		return nil, false
	}
	return columns, true
}

// dataSyncPreflightColumnKeyFor 构造预取缓存键。
//
// 预取与逐表读取必须由同一个函数产出键，否则两边对 schema/表名的拆分稍有差异，
// 缓存就永远不命中 —— 而且是静默地不命中，表现为「批量查询白做了」。
func dataSyncPreflightColumnKeyFor(side string, endpoint resolvedDataSyncJobEndpoint, schemaName, tableName string) (dataSyncPreflightColumnKey, bool) {
	schema, pureTable := normalizeMetadataSchemaAndTable(endpoint.Config, endpoint.Database, qualifyDataSyncJobObject(schemaName, tableName))
	if strings.TrimSpace(pureTable) == "" {
		return dataSyncPreflightColumnKey{}, false
	}
	return dataSyncPreflightColumnKey{
		side:     side,
		database: strings.TrimSpace(endpoint.Database),
		schema:   schema,
		table:    pureTable,
	}, true
}

// dataSyncPreflightColumns 读取一张表在一端的列定义：优先用预取结果，缺席则逐表读取。
//
// 第二个返回值是失败信息，空串表示成功。调用方据此决定是否上报问题码 —— 预取
// 只是加速手段，最终的错误信息仍由这里产出，保证「哪张表、什么原因」不丢失。
func (a *App) dataSyncPreflightColumns(ctx context.Context, session *metadataSession, cache *dataSyncPreflightColumnCache, side string, endpoint resolvedDataSyncJobEndpoint, schemaName, tableName string) ([]connection.ColumnDefinition, string) {
	if key, ok := dataSyncPreflightColumnKeyFor(side, endpoint, schemaName, tableName); ok {
		if columns, hit := cache.lookup(key); hit {
			return columns, ""
		}
	}
	if session == nil || session.app == nil {
		return nil, ""
	}
	result := session.app.DBGetColumns(endpoint.Config, endpoint.Database, qualifyDataSyncJobObject(schemaName, tableName))
	if !result.Success {
		return nil, result.Message
	}
	columns, _ := result.Data.([]connection.ColumnDefinition)
	return columns, ""
}

// dataSyncPreflightColumnRequest 是待预取的一张表。
type dataSyncPreflightColumnRequest struct {
	key   dataSyncPreflightColumnKey
	table string
}

// prefetchDataSyncPreflightColumns 为启用中的映射预取两端列定义。
//
// 返回的缓存可为 nil（无映射、无可用连接、驱动不支持批量等），调用方通过
// lookup 的 ok 判断是否回退，不需要区分这些原因。
func (a *App) prefetchDataSyncPreflightColumns(ctx context.Context, definition syncjob.JobDefinition, source, target resolvedDataSyncJobEndpoint, session *metadataSession) *dataSyncPreflightColumnCache {
	if session == nil || session.app == nil || ctx.Err() != nil {
		return nil
	}
	type groupKey struct {
		side     string
		database string
		schema   string
	}
	groups := make(map[groupKey][]dataSyncPreflightColumnRequest)
	for _, mapping := range definition.Mappings {
		if !mapping.Enabled {
			continue
		}
		for _, side := range []struct {
			name     string
			endpoint resolvedDataSyncJobEndpoint
			schema   string
			table    string
		}{
			{"source", source, mapping.SourceSchema, mapping.SourceTable},
			{"target", target, mapping.TargetSchema, mapping.TargetTable},
		} {
			key, ok := dataSyncPreflightColumnKeyFor(side.name, side.endpoint, side.schema, side.table)
			if !ok {
				continue
			}
			group := groupKey{side: key.side, database: key.database, schema: key.schema}
			groups[group] = append(groups[group], dataSyncPreflightColumnRequest{key: key, table: key.table})
		}
	}

	cache := &dataSyncPreflightColumnCache{columns: make(map[dataSyncPreflightColumnKey][]connection.ColumnDefinition)}
	for group, requests := range groups {
		if ctx.Err() != nil {
			break
		}
		// 单表没有批量收益，且会绕过驱动针对空结果的字典回退，直接留给逐表路径。
		if len(requests) < 2 {
			continue
		}
		endpoint := source
		if group.side == "target" {
			endpoint = target
		}
		a.prefetchDataSyncPreflightColumnGroup(ctx, session, endpoint, group.schema, requests, cache)
	}
	return cache
}

// prefetchDataSyncPreflightColumnGroup 读取一个 schema 下多张表的字段。
//
// 任何失败都不上报问题：批量只是加速手段，一旦不可用就静默回退到逐表读取，
// 由逐表路径产出准确的错误信息（哪张表、什么原因），而不是在这里笼统地报失败。
func (a *App) prefetchDataSyncPreflightColumnGroup(ctx context.Context, session *metadataSession, endpoint resolvedDataSyncJobEndpoint, schema string, requests []dataSyncPreflightColumnRequest, cache *dataSyncPreflightColumnCache) {
	databaseInst, err := session.app.getDatabase(normalizeMetadataRunConfig(endpoint.Config, endpoint.Database))
	if err != nil || ctx.Err() != nil {
		return
	}
	batcher, ok := databaseInst.(db.TableColumnsBatcher)
	if !ok {
		return
	}
	tables := make([]string, 0, len(requests))
	for _, request := range requests {
		tables = append(tables, request.table)
	}
	batched, batchErr := batcher.GetColumnsBatch(schema, tables)
	if batchErr != nil || ctx.Err() != nil {
		return
	}
	for _, request := range requests {
		if columns, exists := batched[request.table]; exists && len(columns) > 0 {
			cache.columns[request.key] = columns
		}
	}
}
