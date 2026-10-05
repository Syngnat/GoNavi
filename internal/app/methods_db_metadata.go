package app

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

func (a *App) DBGetDatabases(config connection.ConnectionConfig) connection.QueryResult {
	runConfig := normalizeRunConfig(config, "")
	configuredMongoDatabase := resolveConfiguredMongoDatabase(runConfig)
	if strings.EqualFold(strings.TrimSpace(runConfig.Type), "redis") {
		runConfig.Type = "redis"
		client, err := a.getRedisClient(runConfig)
		if err != nil {
			logger.Error(err, "DBGetDatabases 获取 Redis 连接失败：%s", formatConnSummary(runConfig))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		dbs, err := client.GetDatabases()
		if err != nil {
			logger.Error(err, "DBGetDatabases 获取 Redis 库列表失败：%s", formatConnSummary(runConfig))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		resData := make([]map[string]string, 0, len(dbs))
		for _, item := range dbs {
			resData = append(resData, map[string]string{"Database": strconv.Itoa(item.Index)})
		}
		return connection.QueryResult{Success: true, Data: resData}
	}
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetDatabases 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if configuredMongoDatabase != "" {
		return connection.QueryResult{
			Success: true,
			Data:    []map[string]string{{"Database": configuredMongoDatabase}},
		}
	}

	dbs, err := dbInst.GetDatabases()
	if err != nil && shouldRefreshCachedConnection(err) {
		if a.invalidateCachedDatabase(runConfig, err) {
			retryInst, retryErr := a.getDatabaseForcePing(runConfig)
			if retryErr != nil {
				logger.Error(retryErr, "DBGetDatabases 重建连接失败：%s", formatConnSummary(runConfig))
				return connection.QueryResult{Success: false, Message: retryErr.Error()}
			}
			dbs, err = retryInst.GetDatabases()
		}
	}
	if err != nil {
		var partialErr *db.PartialMetadataError
		if errors.As(err, &partialErr) {
			warning := partialErr.Error()
			logger.Warnf("DBGetDatabases 获取到部分数据库列表：%s err=%s", formatConnSummary(runConfig), warning)
			resData := make([]map[string]string, 0, len(dbs))
			for _, name := range dbs {
				resData = append(resData, map[string]string{"Database": name})
			}
			return connection.QueryResult{
				Success:           len(resData) > 0,
				Data:              resData,
				Message:           warning,
				Partial:           true,
				Warnings:          partialErr.Warnings(),
				FailedObjectTypes: []string{"database"},
				Retryable:         true,
			}
		}
		logger.Error(err, "DBGetDatabases 获取数据库列表失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbs = dedupeMetadataDatabaseNames(dbs)
	resData := make([]map[string]string, 0, len(dbs))
	for _, name := range dbs {
		resData = append(resData, map[string]string{"Database": name})
	}

	return connection.QueryResult{Success: true, Data: resData}
}

func (a *App) DBGetTables(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)
	if strings.EqualFold(strings.TrimSpace(runConfig.Type), "redis") {
		runConfig.Type = "redis"
		client, err := a.getRedisClient(runConfig)
		if err != nil {
			logger.Error(err, "DBGetTables 获取 Redis 连接失败：%s", formatConnSummary(runConfig))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		cursor := uint64(0)
		tables := make([]string, 0, 128)
		seen := make(map[string]struct{}, 128)
		seenCursors := map[uint64]struct{}{cursor: {}}
		for {
			result, err := client.ScanKeys("*", cursor, 1000)
			if err != nil {
				logger.Error(err, "DBGetTables 扫描 Redis Key 失败：%s", formatConnSummary(runConfig))
				return connection.QueryResult{Success: false, Message: err.Error()}
			}
			for _, item := range result.Keys {
				key := strings.TrimSpace(item.Key)
				if key == "" {
					continue
				}
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				tables = append(tables, key)
			}
			rawCursor := strings.TrimSpace(result.Cursor)
			if rawCursor == "0" {
				break
			}
			next, err := strconv.ParseUint(rawCursor, 10, 64)
			if err != nil {
				return buildRedisTablesPartialResult(tables, fmt.Sprintf("invalid cursor %q: %v", rawCursor, err))
			}
			if _, exists := seenCursors[next]; exists {
				return buildRedisTablesPartialResult(tables, fmt.Sprintf("cursor loop detected (cursor=%d next=%d)", cursor, next))
			}
			seenCursors[next] = struct{}{}
			cursor = next
		}
		resData := make([]map[string]string, 0, len(tables))
		for _, name := range tables {
			resData = append(resData, map[string]string{"Table": name})
		}
		return connection.QueryResult{Success: true, Data: resData, ScannedCount: len(tables)}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetTables 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	tables, err := dbInst.GetTables(dbName)
	if err != nil && shouldRefreshCachedConnection(err) {
		if a.invalidateCachedDatabase(runConfig, err) {
			retryInst, retryErr := a.getDatabaseForcePing(runConfig)
			if retryErr != nil {
				logger.Error(retryErr, "DBGetTables 重建连接失败：%s", formatConnSummary(runConfig))
				return connection.QueryResult{Success: false, Message: retryErr.Error()}
			}
			dbInst = retryInst
			tables, err = retryInst.GetTables(dbName)
		}
	}
	if err != nil {
		return a.tableMetadataErrorResult(runConfig, tables, err)
	}
	tables = dedupeMetadataTableNames(tables)

	if isSQLiteConnection(runConfig) {
		cachedStats, cacheErr := a.readSQLiteTableStats(runConfig, dbName)
		if cacheErr != nil {
			logger.Warnf("DBGetTables 读取 SQLite 表统计缓存失败（保留表列表）：%s err=%v", formatConnSummary(runConfig), cacheErr)
			cachedStats = map[string]sqliteCachedTableStat{}
		}
		resData := make([]map[string]string, 0, len(tables))
		for _, name := range tables {
			item := map[string]string{"Table": name}
			if stat, ok := cachedStats[name]; ok {
				applySQLiteTableStats(item, stat)
			}
			resData = append(resData, item)
		}
		return connection.QueryResult{Success: true, Data: resData}
	}

	tableRowCounts := map[string]int64{}
	if rowCounter, ok := dbInst.(db.TableRowCounter); ok {
		var countErr error
		tableRowCounts, countErr = rowCounter.GetTableRowCounts(dbName, tables)
		if countErr != nil {
			logger.Warnf("DBGetTables 获取表行数失败（保留已获取的表列表）：%s err=%v", formatConnSummary(runConfig), countErr)
		}
	}
	tableStorageStats := map[string]db.TableStorageStats{}
	if storageProvider, ok := dbInst.(db.TableStorageStatsProvider); ok {
		var storageErr error
		tableStorageStats, storageErr = storageProvider.GetTableStorageStats(dbName, tables)
		if storageErr != nil {
			logger.Warnf("DBGetTables 获取表存储大小失败（保留已获取的表列表）：%s err=%v", formatConnSummary(runConfig), storageErr)
		}
	}

	resData := make([]map[string]string, 0, len(tables))
	for _, name := range tables {
		item := map[string]string{"Table": name}
		if rowCount, ok := tableRowCounts[name]; ok {
			item["Rows"] = strconv.FormatInt(rowCount, 10)
		}
		if storageStats, ok := tableStorageStats[name]; ok {
			item["Data_length"] = strconv.FormatInt(storageStats.DataLength, 10)
			item["Index_length"] = strconv.FormatInt(storageStats.IndexLength, 10)
		}
		resData = append(resData, item)
	}

	return connection.QueryResult{Success: true, Data: resData}
}

// Metadata may come from a driver agent or catalog query with duplicate rows.
// Preserve exact identifiers and order while removing only identical nonblank entries.
func dedupeMetadataDatabaseNames(databases []string) []string {
	if len(databases) == 0 {
		return databases
	}
	seen := make(map[string]struct{}, len(databases))
	result := make([]string, 0, len(databases))
	for _, database := range databases {
		if strings.TrimSpace(database) == "" {
			continue
		}
		if _, exists := seen[database]; exists {
			continue
		}
		seen[database] = struct{}{}
		result = append(result, database)
	}
	return result
}

// Metadata may come from an optional driver agent or a catalog view with
// duplicate rows. Preserve exact identifiers and order while removing only
// identical nonblank entries so schema-qualified names remain distinct.
func dedupeMetadataTableNames(tables []string) []string {
	if len(tables) == 0 {
		return tables
	}
	seen := make(map[string]struct{}, len(tables))
	result := make([]string, 0, len(tables))
	for _, table := range tables {
		if strings.TrimSpace(table) == "" {
			continue
		}
		if _, exists := seen[table]; exists {
			continue
		}
		seen[table] = struct{}{}
		result = append(result, table)
	}
	return result
}

func buildRedisTablesPartialResult(tables []string, reason string) connection.QueryResult {
	warning := fmt.Sprintf("Redis key scan truncated after %d keys: %s", len(tables), strings.TrimSpace(reason))
	resData := make([]map[string]string, 0, len(tables))
	for _, name := range tables {
		resData = append(resData, map[string]string{"Table": name})
	}
	return connection.QueryResult{
		Success:           true,
		Data:              resData,
		Message:           warning,
		Partial:           true,
		Warnings:          []string{warning},
		Retryable:         true,
		Truncated:         true,
		ScannedCount:      len(tables),
		FailedObjectTypes: []string{"key"},
	}
}

func (a *App) DBRefreshTableStats(config connection.ConnectionConfig, dbName string, rawTables []string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)
	if !isSQLiteConnection(runConfig) {
		return connection.QueryResult{Success: false, Message: "table statistics refresh is only supported for SQLite connections"}
	}

	tables := make([]string, 0, len(rawTables))
	seen := make(map[string]struct{}, len(rawTables))
	for _, rawTable := range rawTables {
		tableName := strings.TrimSpace(rawTable)
		if tableName == "" {
			continue
		}
		if _, ok := seen[tableName]; ok {
			continue
		}
		seen[tableName] = struct{}{}
		tables = append(tables, tableName)
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBRefreshTableStats 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	tableRowCounts := map[string]int64{}
	if rowCounter, ok := dbInst.(db.TableRowCounter); ok {
		tableRowCounts, err = rowCounter.GetTableRowCounts(dbName, tables)
		if err != nil {
			logger.Warnf("DBRefreshTableStats 获取 SQLite 表行数失败（保留旧缓存）：%s err=%v", formatConnSummary(runConfig), err)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}

	tableStorageStats := map[string]db.TableStorageStats{}
	if storageProvider, ok := dbInst.(db.TableStorageStatsProvider); ok {
		tableStorageStats, err = storageProvider.GetTableStorageStats(dbName, tables)
		if err != nil {
			logger.Warnf("DBRefreshTableStats 获取 SQLite 表存储大小失败（保留旧缓存大小）：%s err=%v", formatConnSummary(runConfig), err)
			tableStorageStats = map[string]db.TableStorageStats{}
		}
	}

	if err := a.mergeSQLiteTableStats(runConfig, dbName, tables, tableRowCounts, tableStorageStats); err != nil {
		logger.Warnf("DBRefreshTableStats 写入 SQLite 表统计缓存失败（仍返回实时结果）：%s err=%v", formatConnSummary(runConfig), err)
	}
	cachedStats, cacheErr := a.readSQLiteTableStats(runConfig, dbName)
	if cacheErr != nil {
		cachedStats = map[string]sqliteCachedTableStat{}
	}
	resData := make([]map[string]string, 0, len(tables))
	for _, name := range tables {
		item := map[string]string{"Table": name}
		if stat, ok := cachedStats[name]; ok {
			applySQLiteTableStats(item, stat)
		}
		if rowCount, ok := tableRowCounts[name]; ok {
			item["Rows"] = strconv.FormatInt(rowCount, 10)
		}
		if storage, ok := tableStorageStats[name]; ok {
			item["Data_length"] = strconv.FormatInt(storage.DataLength, 10)
			item["Index_length"] = strconv.FormatInt(storage.IndexLength, 10)
		}
		resData = append(resData, item)
	}
	return connection.QueryResult{Success: true, Data: resData}
}

func containsExactTableName(tables []string, target string) bool {
	target = strings.TrimSpace(target)
	if target == "" {
		return false
	}
	for _, table := range tables {
		if strings.TrimSpace(table) == target {
			return true
		}
	}
	return false
}

type tableNameMetadataProvider interface {
	GetTables(dbName string) ([]string, error)
}

func lookupExactTableExists(database tableNameMetadataProvider, dbName, tableName string) (bool, error) {
	if checker, ok := database.(db.TableExistsChecker); ok {
		return checker.TableExists(dbName, tableName)
	}

	tables, err := database.GetTables(dbName)
	if err != nil {
		return false, err
	}
	return containsExactTableName(tables, tableName), nil
}

// usesBareTableCatalogNames identifies drivers whose GetTables result is the
// object name only. Query text may retain a delimiter around a dotted literal,
// but exact catalog comparison must receive the logical object name.
func usesBareTableCatalogNames(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "tidb", "clickhouse", "tdengine":
		return true
	default:
		return false
	}
}

func normalizeTableExistsLookup(config connection.ConnectionConfig, dbName, tableName string) (string, string) {
	dbType := resolveDDLDBType(config)
	if usesBareTableCatalogNames(dbType) {
		if schema, table := normalizeMetadataSchemaAndTable(config, dbName, tableName); strings.TrimSpace(table) != "" {
			// Metadata normalization preserves a quoted dotted final segment for
			// DDL helpers. GetTables, however, returns its logical bare name.
			if _, logicalTable := db.SplitSQLQualifiedNameForDialect(table, dbType); strings.TrimSpace(logicalTable) != "" {
				table = logicalTable
			}
			return schema, table
		}
	}

	if dbType == "sqlite" {
		// SQLite normalization already distinguishes an attached-database
		// qualifier from a literal dotted table name. Do not parse its bare
		// catalog result again or `order.items` would be split incorrectly.
		if schema, table := normalizeMetadataSchemaAndTable(config, dbName, tableName); strings.TrimSpace(table) != "" {
			return schema, table
		}
	}

	if dbType == "sqlserver" {
		// SQL Server metadata returns dotted table names as
		// `[schema].[order.items]`. Match that canonical form when the query
		// uses a bracketed dotted final segment; ordinary schema.table names
		// retain their existing catalog spelling.
		segments := db.SplitSQLIdentifierPathForDialect(tableName, "sqlserver")
		if len(segments) >= 1 && segments[len(segments)-1].Quoted && strings.Contains(segments[len(segments)-1].Value, ".") {
			quote := func(value string) string {
				return "[" + strings.ReplaceAll(strings.TrimSpace(value), "]", "]]") + "]"
			}
			schemaParts := make([]string, 0, len(segments)-1)
			for _, segment := range segments[:len(segments)-1] {
				if value := strings.TrimSpace(segment.Value); value != "" {
					schemaParts = append(schemaParts, quote(value))
				}
			}
			if len(schemaParts) == 0 {
				schemaParts = append(schemaParts, quote("dbo"))
			}
			return dbName, strings.Join(schemaParts, ".") + "." + quote(segments[len(segments)-1].Value)
		}
	}
	return dbName, tableName
}

// DBTableExists checks one table against the driver's table-name metadata without
// loading row counts, storage statistics, or sampled message fields.
func (a *App) DBTableExists(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	targetTableName := strings.TrimSpace(tableName)
	if targetTableName == "" {
		return connection.QueryResult{Success: true, Data: map[string]bool{"exists": false}}
	}

	lookupDBName, lookupTableName := normalizeTableExistsLookup(config, dbName, targetTableName)
	runConfig := normalizeMetadataRunConfig(config, lookupDBName)
	if strings.EqualFold(strings.TrimSpace(runConfig.Type), "redis") {
		runConfig.Type = "redis"
		client, err := a.getRedisClient(runConfig)
		if err != nil {
			logger.Error(err, "DBTableExists 获取 Redis 连接失败：%s key=%s", formatConnSummary(runConfig), targetTableName)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		exists, err := client.KeyExists(targetTableName)
		if err != nil {
			logger.Error(err, "DBTableExists 检查 Redis Key 失败：%s key=%s", formatConnSummary(runConfig), targetTableName)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Data: map[string]bool{"exists": exists}}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBTableExists 获取连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, targetTableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	exists, err := lookupExactTableExists(dbInst, lookupDBName, lookupTableName)
	if err != nil && shouldRefreshCachedConnection(err) {
		if a.invalidateCachedDatabase(runConfig, err) {
			retryInst, retryErr := a.getDatabaseForcePing(runConfig)
			if retryErr != nil {
				logger.Error(retryErr, "DBTableExists 重建连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, targetTableName)
				return connection.QueryResult{Success: false, Message: retryErr.Error()}
			}
			exists, err = lookupExactTableExists(retryInst, lookupDBName, lookupTableName)
		}
	}
	if err != nil {
		logger.Error(err, "DBTableExists 检查表是否存在失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, targetTableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{
		Success: true,
		Data:    map[string]bool{"exists": exists},
	}
}

func (a *App) DBGetViews(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)
	if strings.EqualFold(strings.TrimSpace(runConfig.Type), "redis") {
		return connection.QueryResult{Success: true, Data: []map[string]string{}}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetViews 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	viewLookup, err := listViewNameLookupWithStatus(dbInst, runConfig, dbName)
	if err != nil {
		logger.Warnf("DBGetViews 获取视图元数据失败：%s err=%v", formatConnSummary(runConfig), err)
		return connection.QueryResult{
			Success:   false,
			Message:   err.Error(),
			Data:      []map[string]string{},
			Retryable: true,
		}
	}

	views := mapValuesSorted(viewLookup)
	resData := make([]map[string]string, 0, len(views))
	for _, name := range views {
		resData = append(resData, map[string]string{"View": name})
	}

	return connection.QueryResult{Success: true, Data: resData}
}

func (a *App) DBGetIndexes(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetIndexes 获取连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, tableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	indexes, err := dbInst.GetIndexes(schemaName, pureTableName)
	if err != nil && shouldRefreshCachedConnection(err) {
		if a.invalidateCachedDatabase(runConfig, err) {
			retryInst, retryErr := a.getDatabaseForcePing(runConfig)
			if retryErr != nil {
				logger.Error(retryErr, "DBGetIndexes 重建连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, tableName)
				return connection.QueryResult{Success: false, Message: retryErr.Error()}
			}
			indexes, err = retryInst.GetIndexes(schemaName, pureTableName)
		}
	}
	if err != nil {
		logger.Error(err, "DBGetIndexes 获取索引定义失败：%s 表=%s.%s schema=%s pureTable=%s", formatConnSummary(runConfig), dbName, tableName, schemaName, pureTableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: ensureNonNilSlice(indexes)}
}

func (a *App) DBGetForeignKeys(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	fks, err := dbInst.GetForeignKeys(schemaName, pureTableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: ensureNonNilSlice(fks)}
}

func (a *App) DBGetDatabaseForeignKeys(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	provider, ok := dbInst.(db.DatabaseForeignKeyProvider)
	if !ok {
		return connection.QueryResult{Success: false, Message: "database-wide foreign-key metadata is not supported"}
	}

	foreignKeysByTable, err := provider.GetDatabaseForeignKeys(dbName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if foreignKeysByTable == nil {
		foreignKeysByTable = make(map[string][]connection.ForeignKeyDefinition)
	}
	return connection.QueryResult{Success: true, Data: foreignKeysByTable}
}

func (a *App) DBGetTriggers(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	triggers, err := dbInst.GetTriggers(schemaName, pureTableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: ensureNonNilSlice(triggers)}
}
