package app

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
)

// 慢 SQL 历史存储。
//
// 设计要点：
//   - 每个连接指纹一份 JSONL 文件（路径：<configDir>/query_history/<connFp>.jsonl）
//   - 追加写：慢 SQL 完成后追加一行 JSON，确保读取与清空操作有序
//   - 5MB 滚动：写入前检查文件大小，超阈值则 rename 为 .jsonl.1 并新建空文件
//   - 读 TopN：全量加载到内存按字段排序 + SQL 指纹聚合
//   - 不引入 SQLite：项目现有持久化都是 JSON，依赖一致性优先

const (
	queryHistoryDirName                  = "query_history"
	queryHistoryFileMaxBytes             = 5 * 1024 * 1024
	queryHistorySlowThresholdMs    int64 = 500       // 低于 500ms 不记录，避免历史爆炸
	queryHistoryPreviewRunes             = 200       // SQL 预览截断长度
	queryHistorySQLRunes                 = 64 * 1024 // 保留用于诊断的 SQL，上限避免历史文件被超大语句撑爆
	queryHistoryDefaultResults           = 100
	queryHistoryMaxResults               = 500
	queryHistoryFingerprintVersion       = "query-history-v1"
)

var queryHistoryStoreLocks sync.Map

// queryHistoryStore 是单连接的慢 SQL 历史存储。
// 并发安全：同一连接的多条 SQL 可能并发执行，写入加锁。
type queryHistoryStore struct {
	mu       *sync.Mutex
	filePath string
}

// newQueryHistoryStore 按连接指纹构造 store。configDir 为空时用 resolveAppConfigDir。
func newQueryHistoryStore(configDir, connFingerprint string) *queryHistoryStore {
	if strings.TrimSpace(configDir) == "" {
		configDir = resolveAppConfigDir()
	}
	fp := sanitizeFingerprintForFilename(connFingerprint)
	filePath := filepath.Clean(filepath.Join(configDir, queryHistoryDirName, fp+".jsonl"))
	lock, _ := queryHistoryStoreLocks.LoadOrStore(filePath, &sync.Mutex{})
	return &queryHistoryStore{
		mu:       lock.(*sync.Mutex),
		filePath: filePath,
	}
}

// Append 追加一条执行记录。低于阈值的查询自动跳过。
// 失败仅记日志，不影响主查询流程。
func (s *queryHistoryStore) Append(record connection.QueryExecutionRecord) error {
	if record.DurationMs < queryHistorySlowThresholdMs {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(s.filePath), 0o700); err != nil {
		logger.Warnf("创建慢查询历史目录失败：%v path=%s", err, filepath.Dir(s.filePath))
		return err
	}
	fileLock, err := acquireQueryHistoryFileLock(s.filePath + ".lock")
	if err != nil {
		logger.Warnf("锁定慢查询历史失败：%v path=%s", err, s.filePath)
		return err
	}
	defer func() {
		if err := fileLock.Close(); err != nil {
			logger.Warnf("释放慢查询历史锁失败：%v path=%s", err, s.filePath)
		}
	}()
	return s.appendLocked(record)
}

// appendLocked writes one record while the caller owns both s.mu and the
// cross-process lock for s.filePath. Migration uses this primitive so copying
// and clearing a legacy store can be one atomic critical section.
func (s *queryHistoryStore) appendLocked(record connection.QueryExecutionRecord) error {
	record = sanitizeQueryHistoryRecord(record)
	s.tightenFilePermissions()

	// 检查大小并 rotate（rotate 失败不阻塞写入）
	if info, err := os.Stat(s.filePath); err == nil && info.Size() >= queryHistoryFileMaxBytes {
		rotated := s.filePath + ".1"
		// 已有 .1 文件则先删除（只保留一个历史文件）
		_ = os.Remove(rotated)
		if err := os.Rename(s.filePath, rotated); err != nil {
			logger.Warnf("慢查询历史 rotate 失败：%v path=%s", err, s.filePath)
		}
	}

	file, err := os.OpenFile(s.filePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		logger.Warnf("打开慢查询历史文件失败：%v path=%s", err, s.filePath)
		return err
	}
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		logger.Warnf("收紧慢查询历史文件权限失败：%v path=%s", err, s.filePath)
	}

	payload, err := json.Marshal(record)
	if err != nil {
		logger.Warnf("序列化慢查询记录失败：%v", err)
		return err
	}
	payload = append(payload, '\n')
	if _, err := file.Write(payload); err != nil {
		logger.Warnf("写入慢查询历史失败：%v path=%s", err, s.filePath)
		return err
	}
	return nil
}

// withQueryHistoryStoresLocked locks multiple stores in stable path order at
// both the process and OS levels. Stable ordering prevents two migrations with
// reversed source/target stores from deadlocking.
func withQueryHistoryStoresLocked(stores []*queryHistoryStore, operation func() error) (resultErr error) {
	unique := make([]*queryHistoryStore, 0, len(stores))
	seen := make(map[string]struct{}, len(stores))
	for _, store := range stores {
		if store == nil {
			continue
		}
		if _, exists := seen[store.filePath]; exists {
			continue
		}
		seen[store.filePath] = struct{}{}
		unique = append(unique, store)
	}
	sort.Slice(unique, func(i, j int) bool { return unique[i].filePath < unique[j].filePath })

	for _, store := range unique {
		store.mu.Lock()
	}
	defer func() {
		for index := len(unique) - 1; index >= 0; index-- {
			unique[index].mu.Unlock()
		}
	}()

	fileLocks := make([]*queryHistoryFileLock, 0, len(unique))
	defer func() {
		for index := len(fileLocks) - 1; index >= 0; index-- {
			resultErr = errors.Join(resultErr, fileLocks[index].Close())
		}
	}()
	for _, store := range unique {
		if err := os.MkdirAll(filepath.Dir(store.filePath), 0o700); err != nil {
			return err
		}
		fileLock, err := acquireQueryHistoryFileLock(store.filePath + ".lock")
		if err != nil {
			return err
		}
		fileLocks = append(fileLocks, fileLock)
		store.tightenFilePermissions()
	}
	if operation == nil {
		return nil
	}
	return operation()
}

func (s *queryHistoryStore) clearLocked() error {
	for _, path := range []string{s.filePath, s.filePath + ".1"} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// LoadTopN 加载历史并按指定字段排序，返回前 N 条。
// sortBy: "duration" | "frequency" | "rowsReturned" | "recent"；dedupe=true 时聚合同 SQL 指纹的执行统计。
func (s *queryHistoryStore) LoadTopN(sortBy string, limit int, dedupe bool) ([]connection.QueryExecutionRecord, error) {
	records, err := s.LoadAll()
	if err != nil {
		return nil, err
	}
	if dedupe {
		records = aggregateQueryRecords(records)
	}
	sortQueryRecords(records, sortBy)
	limit = normalizeQueryHistoryLimit(limit)
	if len(records) > limit {
		records = records[:limit]
	}
	return records, nil
}

// LoadAll returns a consistent in-memory snapshot without holding the store lock
// during JSON decoding. Callers that combine current and legacy fingerprints can
// aggregate and sort the complete record set once.
func (s *queryHistoryStore) LoadAll() ([]connection.QueryExecutionRecord, error) {
	s.mu.Lock()
	if err := os.MkdirAll(filepath.Dir(s.filePath), 0o700); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	fileLock, err := acquireQueryHistoryFileLock(s.filePath + ".lock")
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.tightenFilePermissions()
	snapshots := s.readFileSnapshots()
	lockErr := fileLock.Close()
	s.mu.Unlock()
	if lockErr != nil {
		return nil, lockErr
	}

	// JSON 解码、聚合和排序可能比文件读取耗时得多；使用内存快照后在锁外处理，
	// 避免用户刷新历史时阻塞刚执行完成的慢查询返回。
	return decodeQueryHistorySnapshots(snapshots), nil
}

func (s *queryHistoryStore) tightenFilePermissions() {
	if _, err := os.Stat(filepath.Dir(s.filePath)); err == nil {
		if err := os.Chmod(filepath.Dir(s.filePath), 0o700); err != nil {
			logger.Warnf("收紧慢查询历史目录权限失败：%v path=%s", err, filepath.Dir(s.filePath))
		}
	}
	for _, path := range []string{s.filePath, s.filePath + ".1", s.filePath + ".lock"} {
		if err := os.Chmod(path, 0o600); err != nil && !os.IsNotExist(err) {
			logger.Warnf("收紧慢查询历史文件权限失败：%v path=%s", err, path)
		}
	}
}

func normalizeQueryHistoryLimit(limit int) int {
	if limit <= 0 {
		return queryHistoryDefaultResults
	}
	if limit > queryHistoryMaxResults {
		return queryHistoryMaxResults
	}
	return limit
}

// Clear 删除主文件 + rotate 文件。文件不存在视为成功。
func (s *queryHistoryStore) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.filePath), 0o700); err != nil {
		return err
	}
	fileLock, err := acquireQueryHistoryFileLock(s.filePath + ".lock")
	if err != nil {
		return err
	}
	defer fileLock.Close()
	return s.clearLocked()
}

// readFileSnapshots 在同一连接锁内读取主文件和 rotate 文件，保证快照不会
// 与 append/rotate/clear 交错；耗时解析在解锁后完成。
func (s *queryHistoryStore) readFileSnapshots() [][]byte {
	snapshots := make([][]byte, 0, 2)
	for _, path := range []string{s.filePath + ".1", s.filePath} {
		payload, err := os.ReadFile(path)
		if err != nil {
			if !os.IsNotExist(err) {
				logger.Warnf("打开慢查询历史失败：%v path=%s", err, path)
			}
			continue
		}
		snapshots = append(snapshots, payload)
	}
	return snapshots
}

// decodeQueryHistorySnapshots 解码内存快照；单行损坏时跳过该行，不阻塞整体加载。
func sanitizeQueryHistoryRecord(record connection.QueryExecutionRecord) connection.QueryExecutionRecord {
	record.SQLPreview = buildQueryPreviewForDBType(record.DBType, record.SQLPreview)
	record.SQLText = redactQueryHistorySQL(record.DBType, record.SQLText)
	return record
}

func decodeQueryHistorySnapshots(snapshots [][]byte) []connection.QueryExecutionRecord {
	var records []connection.QueryExecutionRecord
	for _, payload := range snapshots {
		scanner := bufio.NewScanner(bytes.NewReader(payload))
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024) // 单行最大 1MB，足够大 SQL
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var r connection.QueryExecutionRecord
			if err := json.Unmarshal([]byte(line), &r); err != nil {
				continue
			}
			r = sanitizeQueryHistoryRecord(r)
			records = append(records, r)
		}
		if err := scanner.Err(); err != nil {
			logger.Warnf("解析慢查询历史快照失败：%v", err)
		}
	}
	return records
}

type queryRecordAggregate struct {
	representative connection.QueryExecutionRecord
	count          int64
	totalDuration  float64
	maxDuration    int64
	maxRowsRead    int64
	maxRowsReturn  int64
}

// aggregateQueryRecords 按 SQLFingerprint 聚合，并以最新记录承载完整 SQL 与最近执行时间。
// 旧版 JSONL 没有聚合字段时按单次执行处理，保持向后兼容。
func aggregateQueryRecords(records []connection.QueryExecutionRecord) []connection.QueryExecutionRecord {
	if len(records) == 0 {
		return records
	}
	aggregates := make(map[string]*queryRecordAggregate, len(records))
	for index, record := range records {
		key := record.SQLFingerprint
		if key == "" {
			key = fmt.Sprintf("__unfingerprinted__:%s:%d", record.ID, index)
		}
		count := record.ExecutionCount
		if count <= 0 {
			count = 1
		}
		avgDuration := record.AvgDurationMs
		if avgDuration <= 0 {
			avgDuration = float64(record.DurationMs)
		}
		maxDuration := record.MaxDurationMs
		if maxDuration < record.DurationMs {
			maxDuration = record.DurationMs
		}

		aggregate, ok := aggregates[key]
		if !ok {
			aggregate = &queryRecordAggregate{representative: record}
			aggregates[key] = aggregate
		} else if record.ExecutedAt.After(aggregate.representative.ExecutedAt) {
			aggregate.representative = record
		}
		aggregate.count += count
		aggregate.totalDuration += avgDuration * float64(count)
		if maxDuration > aggregate.maxDuration {
			aggregate.maxDuration = maxDuration
		}
		if record.RowsRead > aggregate.maxRowsRead {
			aggregate.maxRowsRead = record.RowsRead
		}
		if record.RowsReturned > aggregate.maxRowsReturn {
			aggregate.maxRowsReturn = record.RowsReturned
		}
	}
	result := make([]connection.QueryExecutionRecord, 0, len(aggregates))
	for _, aggregate := range aggregates {
		record := aggregate.representative
		record.ExecutionCount = aggregate.count
		record.AvgDurationMs = aggregate.totalDuration / float64(aggregate.count)
		record.MaxDurationMs = aggregate.maxDuration
		record.RowsRead = aggregate.maxRowsRead
		record.RowsReturned = aggregate.maxRowsReturn
		result = append(result, record)
	}
	return result
}

// dedupeQueryRecords 保留旧调用语义，实际返回聚合后的同 SQL 记录。
func dedupeQueryRecords(records []connection.QueryExecutionRecord) []connection.QueryExecutionRecord {
	return aggregateQueryRecords(records)
}

// sortQueryRecords 按字段原地排序。sortBy 不识别时按 recent。
func sortQueryRecords(records []connection.QueryExecutionRecord, sortBy string) {
	sortBy = strings.TrimSpace(sortBy)
	sort.SliceStable(records, func(i, j int) bool {
		left, right := records[i], records[j]
		var leftValue, rightValue float64
		switch sortBy {
		case "duration":
			leftValue = float64(maxInt64(left.MaxDurationMs, left.DurationMs))
			rightValue = float64(maxInt64(right.MaxDurationMs, right.DurationMs))
		case "frequency":
			leftValue = float64(maxInt64(left.ExecutionCount, 1))
			rightValue = float64(maxInt64(right.ExecutionCount, 1))
		case "rowsReturned":
			leftValue = float64(left.RowsReturned)
			rightValue = float64(right.RowsReturned)
		case "rowsRead":
			leftValue = float64(left.RowsRead)
			rightValue = float64(right.RowsRead)
		default:
			leftValue = float64(left.ExecutedAt.UnixNano())
			rightValue = float64(right.ExecutedAt.UnixNano())
		}
		if leftValue != rightValue {
			return leftValue > rightValue
		}
		if !left.ExecutedAt.Equal(right.ExecutedAt) {
			return left.ExecutedAt.After(right.ExecutedAt)
		}
		return left.SQLFingerprint < right.SQLFingerprint
	})
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

// buildSQLFingerprint 把 SQL 归一化为指纹（替换字面量为 ?、去注释、小写化关键字、sha256 前 16 字节）。
// 用于跨执行去重：同一 SQL 不同参数值视为同一指纹。
func buildSQLFingerprint(sql string) string {
	normalized := normalizeSQLForFingerprint(sql)
	if normalized == "" {
		return ""
	}
	hash := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(hash[:16])
}

// buildQueryHistoryConnectionFingerprint 在 saved-query 指纹不可用时，为 ID-only / DSN-only
// 连接提供只含哈希的安全回退；logicalDB 用于隔离 Oracle schema 与自定义连接逻辑库。
func buildQueryHistoryConnectionFingerprint(config connection.ConnectionConfig, logicalDB string) (string, bool) {
	runConfig := normalizeRunConfig(config, logicalDB)
	logicalDB = strings.TrimSpace(logicalDB)
	if logicalDB == "" {
		logicalDB = strings.TrimSpace(runConfig.Database)
	}

	// 已保存连接的 ID 是最稳定的用户身份；修改主机、SSL、SSH 或凭据时，
	// 慢查询历史仍应跟随同一连接。logicalDB 继续隔离数据库/schema。
	if id := strings.TrimSpace(runConfig.ID); id != "" {
		return hashQueryHistoryFingerprint("id", strings.ToLower(strings.TrimSpace(runConfig.Type)), id, logicalDB), true
	}

	usesOpaqueEndpoint := queryHistoryUsesOpaqueEndpoint(runConfig)
	if baseFingerprint, ok := buildConnectionFingerprint(runConfig); !usesOpaqueEndpoint && ok && baseFingerprint != "" {
		if logicalDB == "" || strings.TrimSpace(runConfig.Database) == logicalDB {
			return baseFingerprint, true
		}
		return hashQueryHistoryFingerprint("base", baseFingerprint, logicalDB), true
	}

	hosts := strings.Join(normalizeFingerprintHosts(runConfig.Hosts), ",")
	identityParts := []string{
		strings.ToLower(strings.TrimSpace(runConfig.Type)),
		strings.ToLower(strings.TrimSpace(runConfig.Driver)),
		strings.TrimSpace(runConfig.Host),
		fmt.Sprintf("%d", runConfig.Port),
		hosts,
		strings.TrimSpace(runConfig.User),
		strings.TrimSpace(runConfig.Database),
		logicalDB,
		strings.TrimSpace(runConfig.DSN),
		strings.TrimSpace(runConfig.URI),
		strings.TrimSpace(runConfig.ConnectionParams),
	}
	hasConnectionIdentity := false
	for index, part := range identityParts {
		if index == 0 || index == 3 || index == 6 || index == 7 {
			continue
		}
		if part != "" {
			hasConnectionIdentity = true
			break
		}
	}
	if !hasConnectionIdentity && strings.TrimSpace(runConfig.Database) == "" && logicalDB == "" {
		return "", false
	}
	return hashQueryHistoryFingerprint("fallback", identityParts...), true
}

func queryHistoryUsesOpaqueEndpoint(config connection.ConnectionConfig) bool {
	return strings.TrimSpace(config.Host) == "" && len(normalizeFingerprintHosts(config.Hosts)) == 0 &&
		(strings.TrimSpace(config.DSN) != "" || strings.TrimSpace(config.URI) != "")
}

func hashQueryHistoryFingerprint(kind string, parts ...string) string {
	material := queryHistoryFingerprintVersion + "\x00" + kind + "\x00" + strings.Join(parts, "\x00")
	hash := sha256.Sum256([]byte(material))
	return queryHistoryFingerprintVersion + ":" + hex.EncodeToString(hash[:])
}

// normalizeSQLForFingerprint 简化 SQL 用于指纹计算。
// 策略：
//   - 去掉前后空白
//   - 替换字符串字面量 'xxx' 为 ?
//   - 替换数字字面量为 ?
//   - 去除行注释与块注释，并规范化无意义空白
//   - 小写化未加引号的 SQL 文本，保留可能大小写敏感的引用标识符
func normalizeSQLForFingerprint(sql string) string {
	text := strings.TrimSpace(sql)
	if text == "" {
		return ""
	}
	var builder strings.Builder
	builder.Grow(len(text))
	pendingSpace := false
	appendPendingSpace := func(next byte) {
		if !pendingSpace || builder.Len() == 0 {
			pendingSpace = false
			return
		}
		current := builder.String()
		previous := current[len(current)-1]
		if !isFingerprintPunctuation(previous) && !isFingerprintPunctuation(next) {
			builder.WriteByte(' ')
		}
		pendingSpace = false
	}

	for i := 0; i < len(text); {
		ch := text[i]
		if ch == '$' {
			if end, ok := skipPostgresDollarQuotedLiteral(text, i); ok {
				appendPendingSpace('?')
				builder.WriteByte('?')
				i = end
				continue
			}
		}
		switch {
		case isSQLWhitespace(ch):
			pendingSpace = true
			i++
		case ch == '-' && i+1 < len(text) && text[i+1] == '-':
			pendingSpace = true
			i += 2
			for i < len(text) && text[i] != '\n' && text[i] != '\r' {
				i++
			}
		case ch == '#' && (i == 0 || isSQLWhitespace(text[i-1])):
			pendingSpace = true
			i++
			for i < len(text) && text[i] != '\n' && text[i] != '\r' {
				i++
			}
		case ch == '/' && i+1 < len(text) && text[i+1] == '*':
			pendingSpace = true
			i += 2
			for i+1 < len(text) && !(text[i] == '*' && text[i+1] == '/') {
				i++
			}
			if i+1 < len(text) {
				i += 2
			} else {
				i = len(text)
			}
		case ch == '\'':
			appendPendingSpace('?')
			builder.WriteByte('?')
			i = skipSQLQuotedLiteral(text, i, '\'')
		case ch == '"' || ch == '`':
			appendPendingSpace(ch)
			start := i
			i = skipSQLQuotedIdentifier(text, i, ch)
			builder.WriteString(text[start:i])
		case ch == '[':
			appendPendingSpace(ch)
			start := i
			i = skipSQLBracketIdentifier(text, i)
			builder.WriteString(text[start:i])
		case isSQLNumberStart(text, i):
			appendPendingSpace('?')
			builder.WriteByte('?')
			i = skipSQLNumber(text, i)
		default:
			appendPendingSpace(ch)
			if ch >= 'A' && ch <= 'Z' {
				ch = ch + ('a' - 'A')
			}
			builder.WriteByte(ch)
			i++
		}
	}
	return strings.TrimSpace(builder.String())
}

func isSQLWhitespace(ch byte) bool {
	switch ch {
	case ' ', '\t', '\n', '\r', '\f', '\v':
		return true
	default:
		return false
	}
}

func isFingerprintPunctuation(ch byte) bool {
	return strings.ContainsRune("(),;=<>!+-*/%|&^~.", rune(ch))
}

func skipSQLQuotedLiteral(text string, start int, quote byte) int {
	for i := start + 1; i < len(text); i++ {
		if text[i] == '\\' && i+1 < len(text) {
			i++
			continue
		}
		if text[i] != quote {
			continue
		}
		if i+1 < len(text) && text[i+1] == quote {
			i++
			continue
		}
		return i + 1
	}
	return len(text)
}

func skipSQLQuotedIdentifier(text string, start int, quote byte) int {
	for i := start + 1; i < len(text); i++ {
		if text[i] != quote {
			continue
		}
		if i+1 < len(text) && text[i+1] == quote {
			i++
			continue
		}
		return i + 1
	}
	return len(text)
}

func skipSQLBracketIdentifier(text string, start int) int {
	for i := start + 1; i < len(text); i++ {
		if text[i] != ']' {
			continue
		}
		if i+1 < len(text) && text[i+1] == ']' {
			i++
			continue
		}
		return i + 1
	}
	return len(text)
}

func skipPostgresDollarQuotedLiteral(text string, start int) (int, bool) {
	if start < 0 || start >= len(text) || text[start] != '$' {
		return start, false
	}
	tagEnd := start + 1
	if tagEnd < len(text) && text[tagEnd] != '$' {
		first := text[tagEnd]
		if !((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') || first == '_') {
			return start, false
		}
		for tagEnd < len(text) && text[tagEnd] != '$' {
			if !isSQLIdentifierByte(text[tagEnd]) {
				return start, false
			}
			tagEnd++
		}
	}
	if tagEnd >= len(text) || text[tagEnd] != '$' {
		return start, false
	}
	delimiter := text[start : tagEnd+1]
	contentStart := tagEnd + 1
	closingOffset := strings.Index(text[contentStart:], delimiter)
	if closingOffset < 0 {
		return len(text), true
	}
	return contentStart + closingOffset + len(delimiter), true
}

func isSQLIdentifierByte(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '$'
}

func isSQLNumberStart(text string, index int) bool {
	if index < 0 || index >= len(text) {
		return false
	}
	ch := text[index]
	if ch < '0' || ch > '9' {
		return false
	}
	return index == 0 || !isSQLIdentifierByte(text[index-1])
}

func skipSQLNumber(text string, start int) int {
	i := start
	if i+1 < len(text) && text[i] == '0' && (text[i+1] == 'x' || text[i+1] == 'X') {
		i += 2
		for i < len(text) && ((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'a' && text[i] <= 'f') || (text[i] >= 'A' && text[i] <= 'F')) {
			i++
		}
		return i
	}
	for i < len(text) && text[i] >= '0' && text[i] <= '9' {
		i++
	}
	if i < len(text) && text[i] == '.' {
		i++
		for i < len(text) && text[i] >= '0' && text[i] <= '9' {
			i++
		}
	}
	if i < len(text) && (text[i] == 'e' || text[i] == 'E') {
		exponentStart := i
		i++
		if i < len(text) && (text[i] == '+' || text[i] == '-') {
			i++
		}
		digitStart := i
		for i < len(text) && text[i] >= '0' && text[i] <= '9' {
			i++
		}
		if digitStart == i {
			return exponentStart
		}
	}
	return i
}

// buildQueryPreview 截断 SQL 为人类可读预览。
func redactQueryHistorySQL(dbType, sql string) string {
	if strings.TrimSpace(dbType) == "" {
		dbType = "postgres"
	}
	return strings.TrimSpace(sqlaudit.RedactQuery(dbType, sql))
}

func buildQueryPreview(sql string) string {
	return buildQueryPreviewForDBType("postgres", sql)
}

func buildQueryPreviewForDBType(dbType, sql string) string {
	text := redactQueryHistorySQL(dbType, sql)
	if text == "" {
		return ""
	}
	// 把多行/制表符折叠为单空格（保留语义但节省存储）
	text = strings.ReplaceAll(text, "\n", " ")
	text = strings.ReplaceAll(text, "\r", " ")
	text = strings.ReplaceAll(text, "\t", " ")
	// 折叠连续空白
	for strings.Contains(text, "  ") {
		text = strings.ReplaceAll(text, "  ", " ")
	}
	runes := []rune(text)
	if len(runes) <= queryHistoryPreviewRunes {
		return text
	}
	return string(runes[:queryHistoryPreviewRunes-1]) + "…"
}

// buildQuerySQLText 保留脱敏后可用于重新诊断的 SQL，并限制单条记录体积。
func buildQuerySQLText(sql string) (string, bool) {
	return buildQuerySQLTextForDBType("postgres", sql)
}

func buildQuerySQLTextForDBType(dbType, sql string) (string, bool) {
	text := redactQueryHistorySQL(dbType, sql)
	runes := []rune(text)
	inputTruncated := utf8.RuneCountInString(strings.TrimSpace(sql)) > queryHistorySQLRunes
	if len(runes) <= queryHistorySQLRunes {
		return text, inputTruncated
	}
	return string(runes[:queryHistorySQLRunes]), true
}

// sanitizeFingerprintForFilename 把指纹字符串安全化（只保留字母数字下划线）。
func sanitizeFingerprintForFilename(fp string) string {
	var builder strings.Builder
	builder.Grow(len(fp))
	for _, ch := range fp {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' {
			builder.WriteRune(ch)
		}
	}
	result := builder.String()
	if result == "" {
		return "default"
	}
	return result
}

// buildQueryExecutionRecord 是埋点时的便利构造器，组装一条完整记录。
func buildQueryExecutionRecord(config connection.ConnectionConfig, logicalDB, dbType, sql string, durationMs int64, rowsRead, rowsReturned int64) connection.QueryExecutionRecord {
	connFP, _ := buildQueryHistoryConnectionFingerprint(config, logicalDB)
	sqlText, sqlTruncated := buildQuerySQLTextForDBType(dbType, sql)
	statementCount := 0
	for _, statement := range splitSQLStatementsForDialect(dbType, sql) {
		if strings.TrimSpace(trimLeadingSQLComments(statement)) != "" {
			statementCount++
		}
	}
	return connection.QueryExecutionRecord{
		ID:             fmt.Sprintf("qhr-%d", time.Now().UnixNano()),
		ConnectionFP:   connFP,
		SQLFingerprint: buildSQLFingerprint(sql),
		SQLPreview:     buildQueryPreviewForDBType(dbType, sql),
		SQLText:        sqlText,
		SQLTruncated:   sqlTruncated,
		Diagnosable:    explainSupportedDBTypes[normalizeExplainLexicalDBType(dbType)] && isSafeExplainQuery(dbType, sql),
		StatementCount: statementCount,
		DBType:         dbType,
		DurationMs:     durationMs,
		ExecutionCount: 1,
		AvgDurationMs:  float64(durationMs),
		MaxDurationMs:  durationMs,
		RowsRead:       rowsRead,
		RowsReturned:   rowsReturned,
		ExecutedAt:     time.Now(),
	}
}
