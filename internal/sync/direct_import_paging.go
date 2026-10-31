package sync

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

const defaultSyncReadPageSize = defaultSyncApplyBatchSize

func (s *SyncEngine) tryApplyDirectImportInPages(config SyncConfig, res *SyncResult, tableIndex, totalTables int, tableName string, sourceDB db.Database, targetDB db.Database, plan SchemaMigrationPlan, sourceCols, targetCols []connection.ColumnDefinition, opts TableOptions, sourceType, targetType, applyTableName string) (bool, int, error) {
	if normalizeSyncMode(config.Mode) == "full_overwrite" && hiveTargetHasRequiredColumns(targetCols) {
		return false, 0, nil
	}
	if sourceType == "hive" {
		return s.tryApplyHiveTableStream(config, res, tableName, applyTableName, sourceDB, targetDB, plan, sourceCols, targetCols, opts, sourceType, targetType)
	}
	if hasExplicitSyncMappings(config) {
		return false, 0, nil
	}
	tableMode := normalizeSyncMode(config.Mode)
	if tableMode == "insert_update" && plan.TargetTableExists {
		return false, 0, nil
	}
	if plan.TargetTableExists && isSamePhysicalSyncTable(config, plan, sourceType, targetType) {
		// OFFSET pagination observes rows appended by insert_only self-syncs.
		// Fall back to the snapshot path so it reads a fixed source set instead
		// of repeatedly importing its own newly written rows.
		return false, 0, nil
	}
	if !opts.Insert {
		return false, 0, nil
	}
	pageSize, err := normalizedSyncBatchSize(config.BatchSize)
	if err != nil {
		return true, 0, err
	}

	pkCol, ok := directImportPaginationPK(sourceType, sourceCols)
	if !ok {
		// OFFSET pagination without a deterministic ordering key can duplicate
		// or skip rows. Fall back to the snapshot path, which preserves the
		// correct auto-create/no-primary-key semantics without pretending its
		// source order is stable.
		return false, 0, nil
	}

	firstPageQuery := buildPagedSourceTableQuery(sourceType, plan.SourceQueryTable, sourceCols, pkCol, pageSize, 0)
	if strings.TrimSpace(firstPageQuery) == "" {
		return false, 0, nil
	}

	applier, ok := targetDB.(db.BatchApplier)
	if !ok {
		return true, 0, fmt.Errorf("目标驱动不支持应用数据变更 (ApplyChanges)")
	}

	s.appendLog(config.JobID, res, "info", fmt.Sprintf("  -> 启用分页流式导入：按主键 %s 每批读取 %d 行", pkCol, pageSize))
	s.progress(config.JobID, tableIndex, totalTables, tableName, "分页读取源表数据")
	firstRows, _, err := querySyncDatabaseContext(s.context(), sourceDB, firstPageQuery)
	if err != nil {
		return true, 0, fmt.Errorf("分页读取源表失败: %w", err)
	}

	targetColSet, err := s.prepareDirectImportTargetColumnSet(config, res, targetDB, plan, sourceType, targetType, sourceCols, targetCols)
	if err != nil {
		return true, 0, err
	}

	if targetType == "hive" {
		if err := validateHiveInsertRows(targetCols, firstRows); err != nil {
			return true, 0, err
		}
	}
	cleared := false
	if tableMode == "full_overwrite" && plan.TargetTableExists {
		s.appendLog(config.JobID, res, "warn", fmt.Sprintf("  -> 全量覆盖模式：即将清空目标表 %s", tableName))
		s.progress(config.JobID, tableIndex, totalTables, tableName, "清空目标表")
		if err := clearSyncTargetContext(s.context(), targetDB, targetType, plan.TargetQueryTable); err != nil {
			return true, 0, fmt.Errorf("清空目标表失败: %w", err)
		}
		cleared = true
	}
	// Clearing cannot be rolled back, so a later failure has to say the target is now empty and
	// only partially refilled; otherwise the user reads "read failed" and never learns the
	// previous contents are gone.
	failAfterClear := func(inserted int, err error) (bool, int, error) {
		if cleared {
			return true, inserted, fmt.Errorf("目标表已被清空且仅写入 %d 行（无法回滚，需人工核对）: %w", inserted, err)
		}
		return true, inserted, err
	}

	inserted, err := s.applyDirectImportPage(config, res, tableName, applyTableName, applier, targetColSet, pkCol, opts, firstRows, pageSize, 0)
	if err != nil {
		return failAfterClear(inserted, err)
	}
	if len(firstRows) < pageSize {
		return true, inserted, nil
	}

	for offset := pageSize; ; offset += pageSize {
		s.progress(config.JobID, tableIndex, totalTables, tableName, fmt.Sprintf("分页读取源表数据(%d+)", offset))
		query := buildPagedSourceTableQuery(sourceType, plan.SourceQueryTable, sourceCols, pkCol, pageSize, offset)
		rows, _, err := querySyncDatabaseContext(s.context(), sourceDB, query)
		if err != nil {
			return failAfterClear(inserted, fmt.Errorf("分页读取源表失败(offset=%d): %w", offset, err))
		}
		if len(rows) == 0 {
			return true, inserted, nil
		}
		applied, err := s.applyDirectImportPage(config, res, tableName, applyTableName, applier, targetColSet, pkCol, opts, rows, pageSize, offset)
		inserted += applied
		if err != nil {
			return failAfterClear(inserted, err)
		}
		if len(rows) < pageSize {
			return true, inserted, nil
		}
	}
}

// prepareDirectImportTargetColumnSet 返回目标表的可写列集合（小写列名），
// 供 filterInsertRows/filterUpdateRows 过滤 INSERT/UPDATE。
// 缺列检测基于存在性全集，返回值已剔除生成列：生成列由数据库算值，
// 出现在写入列清单会报 MySQL 3105 之类的错。
func (s *SyncEngine) prepareDirectImportTargetColumnSet(config SyncConfig, res *SyncResult, targetDB db.Database, plan SchemaMigrationPlan, sourceType, targetType string, sourceCols, targetCols []connection.ColumnDefinition) (map[string]struct{}, error) {
	targetColsResolved := targetCols
	if len(targetColsResolved) == 0 {
		cols, err := targetDB.GetColumns(plan.TargetSchema, plan.TargetTable)
		if err != nil {
			return nil, fmt.Errorf("获取目标表字段失败: %w", err)
		}
		targetColsResolved = cols
	}
	if len(targetColsResolved) == 0 {
		return nil, nil
	}

	existingSet := buildTargetColumnSet(targetColsResolved)
	writableSet := buildWritableTargetColumnSet(targetColsResolved)
	missing := missingSourceColumns(sourceCols, existingSet)
	if len(missing) > 0 {
		return s.resolveDirectImportMissingColumns(config, res, targetDB, plan, sourceType, targetType, sourceCols, writableSet, missing)
	}
	return writableSet, nil
}

// resolveDirectImportMissingColumns 按 AutoAddColumns 配置处理源有目标无的列：
// 允许时逐列 ALTER 补齐并把成功新增的普通列并入可写集合，否则记 warn 交给调用方忽略。
// missing 必须由存在性全集计算，不能把已有生成列误当作缺列。
func (s *SyncEngine) resolveDirectImportMissingColumns(config SyncConfig, res *SyncResult, targetDB db.Database, plan SchemaMigrationPlan, sourceType, targetType string, sourceCols []connection.ColumnDefinition, writableSet map[string]struct{}, missing []string) (map[string]struct{}, error) {
	if config.AutoAddColumns && supportsAutoAddColumnsForPair(sourceType, targetType) {
		if !syncContentAllowsSchemaChanges(config.Content) {
			return nil, fmt.Errorf("目标表缺少字段，仅同步数据模式不允许自动补齐：%s", strings.Join(missing, ", "))
		}
		s.appendLog(config.JobID, res, "warn", fmt.Sprintf("  -> 目标表缺少字段 %d 个，开始自动补齐: %s", len(missing), strings.Join(missing, ", ")))
		added := 0
		sourceColsByLower := make(map[string]connection.ColumnDefinition, len(sourceCols))
		for _, col := range sourceCols {
			key := strings.ToLower(strings.TrimSpace(col.Name))
			if key != "" {
				sourceColsByLower[key] = col
			}
		}
		for _, colName := range missing {
			srcCol, ok := sourceColsByLower[strings.ToLower(strings.TrimSpace(colName))]
			if !ok {
				return nil, fmt.Errorf("自动补字段失败：未找到源字段定义 %s", colName)
			}
			alterSQL, alterWarnings, err := buildAddColumnSQLForPair(sourceType, targetType, plan.TargetQueryTable, srcCol, plan.characterLengthTarget)
			if err != nil {
				s.appendLog(config.JobID, res, "error", fmt.Sprintf("  -> 自动补字段失败：字段=%s 错误=%v", colName, err))
				return nil, fmt.Errorf("自动补字段失败：字段=%s: %w", colName, err)
			}
			for _, warning := range alterWarnings {
				s.appendLog(config.JobID, res, "warn", "  -> "+warning)
			}
			if warning := relaxedNotNullAddColumnWarning(srcCol); warning != "" {
				s.appendLog(config.JobID, res, "warn", "  -> "+warning)
			}
			if _, err := execSyncDatabaseContext(s.context(), targetDB, alterSQL); err != nil {
				s.appendLog(config.JobID, res, "error", fmt.Sprintf("  -> 自动补字段失败：字段=%s 错误=%v", colName, err))
				return nil, fmt.Errorf("自动补字段失败：字段=%s: %w", colName, err)
			}
			added++
			writableSet[strings.ToLower(strings.TrimSpace(colName))] = struct{}{}
		}
		s.appendLog(config.JobID, res, "info", fmt.Sprintf("  -> 自动补字段完成：成功=%d 失败=%d", added, len(missing)-added))
		return writableSet, nil
	}

	s.appendLog(config.JobID, res, "warn", fmt.Sprintf("  -> 目标表缺少字段 %d 个（未开启自动补齐），将自动忽略：%s", len(missing), strings.Join(missing, ", ")))
	return writableSet, nil
}

func missingSourceColumns(sourceCols []connection.ColumnDefinition, targetColSet map[string]struct{}) []string {
	missing := make([]string, 0)
	seen := make(map[string]struct{}, len(sourceCols))
	for _, col := range sourceCols {
		name := strings.TrimSpace(col.Name)
		lower := strings.ToLower(name)
		if name == "" {
			continue
		}
		if _, ok := seen[lower]; ok {
			continue
		}
		seen[lower] = struct{}{}
		if _, ok := targetColSet[lower]; !ok {
			missing = append(missing, name)
		}
	}
	return missing
}

func (s *SyncEngine) applyDirectImportPage(config SyncConfig, res *SyncResult, sourceTable, targetTable string, applier db.BatchApplier, targetColSet map[string]struct{}, pkCol string, opts TableOptions, rows []map[string]interface{}, batchSize, indexBase int) (int, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	rows = filterRowsByPKSelection(pkCol, rows, opts.Insert, opts.SelectedInsertPKs)
	if len(rows) == 0 {
		return 0, nil
	}
	rows = filterInsertRows(rows, targetColSet)
	if len(rows) == 0 {
		return 0, nil
	}
	changeSet := connection.ChangeSet{Inserts: rows}
	config.BatchSize = batchSize
	applied, err := s.applySnapshotChanges(config, res, sourceTable, targetTable, applier, changeSet, indexBase)
	return applied.Inserts, err
}

func directImportPaginationPK(sourceType string, sourceCols []connection.ColumnDefinition) (string, bool) {
	if !supportsDirectImportPagination(sourceType) {
		return "", false
	}
	// ClickHouse's primary key is a sorting-key prefix and is not unique, so ORDER BY it does not
	// define a stable order across page boundaries. OFFSET paging would then duplicate or skip
	// rows; fall back to the snapshot path instead.
	if normalizeMigrationDBType(sourceType) == "clickhouse" {
		return "", false
	}
	pkCols := make([]string, 0, 2)
	for _, col := range sourceCols {
		if col.Key != "PRI" && col.Key != "PK" {
			continue
		}
		// OFFSET pagination is only stable when the ORDER BY column is non-null: SQLite allows
		// several NULLs in a TEXT PRIMARY KEY, and NULLs have no deterministic order, so a page
		// boundary can duplicate or skip rows. A nullable key therefore falls back to the
		// snapshot path.
		if strings.EqualFold(strings.TrimSpace(col.Nullable), "YES") {
			return "", false
		}
		pkCols = append(pkCols, col.Name)
	}
	if len(pkCols) != 1 || strings.TrimSpace(pkCols[0]) == "" {
		return "", false
	}
	return pkCols[0], true
}

func supportsDirectImportPagination(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "sqlite", "duckdb", "clickhouse", "tdengine", "starrocks", "diros":
		return true
	default:
		return false
	}
}

func buildPagedSourceTableQuery(dbType, queryTable string, cols []connection.ColumnDefinition, orderCol string, limit, offset int) string {
	selectList := buildSourceColumnSelectList(dbType, cols)
	if strings.TrimSpace(selectList) == "" {
		return ""
	}
	pageSelectList := selectList
	if normalizeMigrationDBType(dbType) == "sqlserver" {
		pageSelectList = buildSQLServerPageSelectList(cols)
	}
	baseSQL := fmt.Sprintf("SELECT %s FROM %s", selectList, quoteQualifiedIdentByType(dbType, queryTable))
	orderBy := ""
	if strings.TrimSpace(orderCol) != "" {
		orderBy = fmt.Sprintf(" ORDER BY %s ASC", quoteIdentByType(dbType, orderCol))
	}
	return buildPaginatedSelectSQLForSync(dbType, baseSQL, pageSelectList, orderBy, limit, offset)
}

func buildSourceColumnSelectList(dbType string, cols []connection.ColumnDefinition) string {
	quoted := make([]string, 0, len(cols))
	for _, col := range cols {
		name := strings.TrimSpace(col.Name)
		if name == "" {
			continue
		}
		quoted = append(quoted, quoteIdentByType(dbType, name))
	}
	return strings.Join(quoted, ", ")
}

func buildSQLServerPageSelectList(cols []connection.ColumnDefinition) string {
	quoted := make([]string, 0, len(cols))
	for _, col := range cols {
		name := strings.TrimSpace(col.Name)
		if name == "" {
			continue
		}
		quoted = append(quoted, fmt.Sprintf("[__gonavi_page_result__].%s", quoteIdentByType("sqlserver", name)))
	}
	return strings.Join(quoted, ", ")
}

func buildPaginatedSelectSQLForSync(dbType, baseSQL, selectList, orderBySQL string, limit, offset int) string {
	safeLimit := limit
	if safeLimit <= 0 {
		safeLimit = defaultSyncReadPageSize
	}
	safeOffset := offset
	if safeOffset < 0 {
		safeOffset = 0
	}
	base := strings.TrimSpace(baseSQL)
	orderBy := strings.TrimSpace(orderBySQL)

	switch normalizeMigrationDBType(dbType) {
	case "hive":
		if safeOffset != 0 {
			return ""
		}
		return strings.TrimSpace(fmt.Sprintf("%s %s LIMIT %d", base, orderBy, safeLimit))
	case "sqlserver":
		upperBound := safeOffset + safeLimit
		if orderBy == "" {
			orderBy = "ORDER BY (SELECT NULL)"
		}
		return fmt.Sprintf("SELECT %s FROM (SELECT [__gonavi_page__].*, ROW_NUMBER() OVER (%s) AS [__gonavi_rn__] FROM (%s) AS [__gonavi_page__]) AS [__gonavi_page_result__] WHERE [__gonavi_rn__] > %d AND [__gonavi_rn__] <= %d ORDER BY [__gonavi_rn__]", selectList, orderBy, base, safeOffset, upperBound)
	default:
		return fmt.Sprintf("%s %s LIMIT %d OFFSET %d", base, orderBy, safeLimit, safeOffset)
	}
}

func buildClearTargetTableSQL(targetType, targetQueryTable string) string {
	quotedTable := quoteQualifiedIdentByType(targetType, targetQueryTable)
	if normalized := normalizeMigrationDBType(targetType); normalized == "mysql" || normalized == "hive" {
		return fmt.Sprintf("TRUNCATE TABLE %s", quotedTable)
	}
	return fmt.Sprintf("DELETE FROM %s", quotedTable)
}

// isSameSyncEndpoint 判断同步的源与目标是否指向同一个逻辑连接端点（含默认 database）。
//
// 不比较表名；普通表同步还会由 isSamePhysicalSyncTable 单独核对表名。
func isSameSyncEndpoint(config SyncConfig, sourceType, targetType string) bool {
	if !isSamePhysicalSyncServer(config, sourceType, targetType) {
		return false
	}
	switch normalizeMigrationDBType(sourceType) {
	case "sqlite", "duckdb":
		return true
	}
	source := config.SourceConfig
	target := config.TargetConfig
	return strings.EqualFold(strings.TrimSpace(source.Database), strings.TrimSpace(target.Database))
}

// isSamePhysicalSyncServer 判断源与目标是否位于同一物理服务端点。
// 默认 database 只决定连接建立后的当前库，不会把同一 MySQL 服务变成不同物理端点；
// Driver/DSN 可能因 built-in/custom 连接或默认库不同而不同，不能作为物理服务不同的证据。
func isSamePhysicalSyncServer(config SyncConfig, sourceType, targetType string) bool {
	normalizedType := normalizeMigrationDBType(sourceType)
	// mysql / mariadb / oceanbase / diros / starrocks 走同一条 MySQL 线协议，同一 host:port
	// 上就是同一台物理服务。按类型名严格相等判断会把「两条连接分别填 mysql 与 mariadb」的
	// 同表自同步放行，而 full_overwrite 的分页路径会先清空再按 OFFSET 读（=已空的表），
	// 静默只导回第一页。判宽只会退回快照路径，方向安全。
	if !sameSyncProtocolFamily(normalizedType, normalizeMigrationDBType(targetType)) {
		return false
	}
	if normalizedType == "sqlite" || normalizedType == "duckdb" {
		return isSameSyncDatabaseFile(config.SourceConfig, config.TargetConfig, normalizedType)
	}
	source := config.SourceConfig
	target := config.TargetConfig
	if sourceID := strings.TrimSpace(source.ID); sourceID != "" && strings.EqualFold(sourceID, strings.TrimSpace(target.ID)) {
		return true
	}
	// URI may carry the actual endpoint independently of Host/Database. An
	// unknown URI endpoint must not be assumed distinct during live writes.
	if strings.TrimSpace(source.URI) != "" || strings.TrimSpace(target.URI) != "" {
		return true
	}
	sourceHost := strings.TrimSpace(source.Host)
	targetHost := strings.TrimSpace(target.Host)
	if sourceHost != "" && targetHost != "" {
		portsMayMatch := source.Port == target.Port || source.Port == 0 || target.Port == 0
		return normalizedSyncHost(sourceHost) == normalizedSyncHost(targetHost) && portsMayMatch
	}
	// 只要一侧使用 DSN，就无法在不解析各驱动私有格式的情况下安全排除同一服务；
	// mixed built-in/custom 连接也必须保守退回非分页路径。
	return strings.TrimSpace(source.DSN) != "" || strings.TrimSpace(target.DSN) != ""
}

// sameSyncProtocolFamily reports whether two normalized dialect names address the same physical
// server product line, so an "is this the same table" check cannot be fooled by aliases such as
// mysql vs mariadb.
func sameSyncProtocolFamily(left, right string) bool {
	if left == right {
		return true
	}
	return isMySQLCoreType(left) && isMySQLCoreType(right)
}

func normalizedSyncHost(host string) string {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return "loopback"
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsLoopback() {
			return "loopback"
		}
		return ip.String()
	}
	return host
}

func isSameSyncDatabaseFile(source, target connection.ConnectionConfig, databaseType string) bool {
	pathFor := func(config connection.ConnectionConfig) string {
		path := strings.TrimSpace(config.Host)
		if path == "" {
			path = strings.TrimSpace(config.Database)
		}
		return path
	}
	sourcePath := pathFor(source)
	targetPath := pathFor(target)
	if normalizeMigrationDBType(databaseType) == "sqlite" {
		sourcePath = normalizeSyncSQLitePath(sourcePath)
		targetPath = normalizeSyncSQLitePath(targetPath)
	}
	if sourcePath == "" || targetPath == "" || strings.EqualFold(sourcePath, ":memory:") || strings.EqualFold(targetPath, ":memory:") {
		return false
	}
	normalize := func(path string) string {
		if absolute, err := filepath.Abs(path); err == nil {
			path = absolute
		}
		return filepath.Clean(path)
	}
	sourcePath = normalize(sourcePath)
	targetPath = normalize(targetPath)
	if sourceInfo, sourceErr := os.Stat(sourcePath); sourceErr == nil {
		if targetInfo, targetErr := os.Stat(targetPath); targetErr == nil && os.SameFile(sourceInfo, targetInfo) {
			return true
		}
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(sourcePath, targetPath)
	}
	return sourcePath == targetPath
}

func normalizeSyncSQLitePath(path string) string {
	path = strings.TrimSpace(path)
	if strings.HasPrefix(path, "/") && len(path) > 3 && isSyncWindowsDrivePath(path[1:]) {
		path = path[1:]
	}
	if !isSyncWindowsDrivePath(path) {
		return path
	}
	for {
		separator := strings.LastIndex(path, ":")
		if separator <= 1 || separator+1 >= len(path) {
			return path
		}
		suffix := path[separator+1:]
		for _, char := range suffix {
			if char < '0' || char > '9' {
				return path
			}
		}
		path = path[:separator]
	}
}

func isSyncWindowsDrivePath(path string) bool {
	if len(path) < 3 || path[1] != ':' || (path[2] != '\\' && path[2] != '/') {
		return false
	}
	return (path[0] >= 'a' && path[0] <= 'z') || (path[0] >= 'A' && path[0] <= 'Z')
}

func isSamePhysicalSyncTable(config SyncConfig, plan SchemaMigrationPlan, sourceType, targetType string) bool {
	if !strings.EqualFold(strings.TrimSpace(plan.SourceQueryTable), strings.TrimSpace(plan.TargetQueryTable)) {
		return false
	}
	return isSameSyncEndpoint(config, sourceType, targetType)
}
