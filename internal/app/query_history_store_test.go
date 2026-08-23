package app

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestQueryHistoryStore_AppendAndLoad(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "test-conn-fp")

	store.Append(connection.QueryExecutionRecord{
		ID:             "r1",
		ConnectionFP:   "test-conn-fp",
		SQLFingerprint: "fp-select-1",
		SQLPreview:     "SELECT * FROM t",
		DBType:         "mysql",
		DurationMs:     1000,
		ExecutedAt:     time.Now(),
	})
	store.Append(connection.QueryExecutionRecord{
		ID:             "r2",
		ConnectionFP:   "test-conn-fp",
		SQLFingerprint: "fp-select-2",
		SQLPreview:     "SELECT * FROM u WHERE id = 1",
		DBType:         "mysql",
		DurationMs:     2000,
		ExecutedAt:     time.Now().Add(time.Second),
	})

	records, err := store.LoadTopN("duration", 10, false)
	if err != nil {
		t.Fatalf("LoadTopN 失败：%v", err)
	}
	if len(records) != 2 {
		t.Fatalf("应有 2 条记录，got=%d", len(records))
	}
	// duration 排序：r2 (2000ms) 应在前面
	if records[0].ID != "r2" {
		t.Fatalf("按 duration 排序后首条应为 r2，got=%s", records[0].ID)
	}
}

func TestQueryHistoryStore_SkipBelowThreshold(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "test-conn-fp")

	// 低于 500ms 阈值应被跳过
	store.Append(connection.QueryExecutionRecord{
		ID:         "fast",
		DurationMs: 100,
		SQLPreview: "SELECT 1",
		ExecutedAt: time.Now(),
	})
	records, _ := store.LoadTopN("duration", 10, false)
	if len(records) != 0 {
		t.Fatalf("低于阈值的查询不应被记录，got=%d", len(records))
	}
}

func TestQueryHistoryStore_DedupeBySQLFingerprint(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "test-conn-fp")

	base := time.Now()
	// 同一 SQL 指纹，3 次执行（不同时间）
	for i := 0; i < 3; i++ {
		store.Append(connection.QueryExecutionRecord{
			ID:             "r" + string(rune('1'+i)),
			SQLFingerprint: "same-fp",
			DurationMs:     int64(1000 + i*500),
			ExecutedAt:     base.Add(time.Duration(i) * time.Second),
		})
	}
	records, _ := store.LoadTopN("duration", 10, true)
	if len(records) != 1 {
		t.Fatalf("去重后应剩 1 条，got=%d", len(records))
	}
	// 聚合记录以最新一条作为代表，同时保留执行统计。
	if records[0].ID != "r3" {
		t.Fatalf("去重应保留最新，got ID=%s", records[0].ID)
	}
	if records[0].ExecutionCount != 3 {
		t.Fatalf("聚合后执行次数应为 3，got=%d", records[0].ExecutionCount)
	}
	if records[0].MaxDurationMs != 2000 {
		t.Fatalf("聚合后最大耗时应为 2000ms，got=%d", records[0].MaxDurationMs)
	}
	if records[0].AvgDurationMs != 1500 {
		t.Fatalf("聚合后平均耗时应为 1500ms，got=%v", records[0].AvgDurationMs)
	}
}

func TestQueryHistoryStore_AggregatesRowsAndSupportsMeaningfulSorts(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "test-conn-fp")
	base := time.Now()

	for _, record := range []connection.QueryExecutionRecord{
		{ID: "a1", SQLFingerprint: "a", DurationMs: 900, RowsReturned: 3, ExecutedAt: base},
		{ID: "a2", SQLFingerprint: "a", DurationMs: 700, RowsReturned: 30, ExecutedAt: base.Add(time.Second)},
		{ID: "b1", SQLFingerprint: "b", DurationMs: 1200, RowsReturned: 8, ExecutedAt: base.Add(2 * time.Second)},
	} {
		store.Append(record)
	}

	byFrequency, err := store.LoadTopN("frequency", 10, true)
	if err != nil {
		t.Fatalf("按频率加载失败：%v", err)
	}
	if len(byFrequency) != 2 || byFrequency[0].SQLFingerprint != "a" || byFrequency[0].ExecutionCount != 2 {
		t.Fatalf("frequency 应优先返回执行次数最多的 SQL，got=%+v", byFrequency)
	}
	if byFrequency[0].RowsReturned != 30 {
		t.Fatalf("聚合后的返回行数应取最大值，got=%d", byFrequency[0].RowsReturned)
	}

	byRows, err := store.LoadTopN("rowsReturned", 10, true)
	if err != nil {
		t.Fatalf("按返回行数加载失败：%v", err)
	}
	if len(byRows) != 2 || byRows[0].SQLFingerprint != "a" {
		t.Fatalf("rowsReturned 应按聚合后的最大返回行数排序，got=%+v", byRows)
	}

	byDuration, err := store.LoadTopN("duration", 10, true)
	if err != nil {
		t.Fatalf("按耗时加载失败：%v", err)
	}
	if len(byDuration) != 2 || byDuration[0].SQLFingerprint != "b" {
		t.Fatalf("duration 应按最大耗时排序，got=%+v", byDuration)
	}
}

func TestQueryHistoryStore_SeparatesRowsReturnedAndRowsReadSorts(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "row-sort-conn")
	store.Append(connection.QueryExecutionRecord{ID: "scan-heavy", SQLFingerprint: "scan-heavy", DurationMs: 1000, RowsRead: 1000, RowsReturned: 1, ExecutedAt: time.Now()})
	store.Append(connection.QueryExecutionRecord{ID: "return-heavy", SQLFingerprint: "return-heavy", DurationMs: 1000, RowsRead: 2, RowsReturned: 50, ExecutedAt: time.Now()})

	byReturned, err := store.LoadTopN("rowsReturned", 10, true)
	if err != nil || len(byReturned) != 2 || byReturned[0].ID != "return-heavy" {
		t.Fatalf("rowsReturned 只能按返回行数排序，records=%+v err=%v", byReturned, err)
	}
	byRead, err := store.LoadTopN("rowsRead", 10, true)
	if err != nil || len(byRead) != 2 || byRead[0].ID != "scan-heavy" {
		t.Fatalf("rowsRead 只能按扫描行数排序，records=%+v err=%v", byRead, err)
	}
}

func TestQueryHistoryStore_RotationAtThreshold(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "test-conn-fp")

	// 写入大量记录触发 rotate（5MB 阈值）
	for i := 0; i < 50000; i++ {
		store.Append(connection.QueryExecutionRecord{
			ID:             "r",
			SQLFingerprint: "fp",
			SQLPreview:     "SELECT * FROM some_very_large_table WHERE col = 'long string to fill up space quickly'",
			DurationMs:     1000,
			ExecutedAt:     time.Now(),
		})
	}

	// 主文件存在 + rotate 文件存在
	if _, err := os.Stat(store.filePath); err != nil {
		t.Fatalf("主文件应存在：%v", err)
	}
	if _, err := os.Stat(store.filePath + ".1"); err != nil {
		t.Fatalf("rotate 文件 .1 应存在：%v", err)
	}

	records, _ := store.LoadTopN("duration", 1000, false)
	if len(records) == 0 {
		t.Fatal("rotate 后应仍能加载历史")
	}
}

func TestQueryHistoryStore_SortByRecent(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "test-conn-fp")

	base := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	times := []time.Time{
		base.Add(2 * time.Second),
		base.Add(0 * time.Second),
		base.Add(1 * time.Second),
	}
	for i, ts := range times {
		store.Append(connection.QueryExecutionRecord{
			ID:             "r" + string(rune('1'+i)),
			SQLFingerprint: "fp-" + string(rune('1'+i)),
			DurationMs:     1000,
			ExecutedAt:     ts,
		})
	}

	records, _ := store.LoadTopN("recent", 10, false)
	if len(records) != 3 {
		t.Fatalf("应有 3 条，got=%d", len(records))
	}
	// recent 排序：最新（time[0]）应在前面
	if records[0].ID != "r1" {
		t.Fatalf("recent 排序后首条应为 r1（最新），got=%s", records[0].ID)
	}
}

func TestQueryHistoryStore_Clear(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "test-conn-fp")

	store.Append(connection.QueryExecutionRecord{
		ID:         "r1",
		DurationMs: 1000,
		SQLPreview: "SELECT 1",
		ExecutedAt: time.Now(),
	})
	if err := store.Clear(); err != nil {
		t.Fatalf("Clear 失败：%v", err)
	}
	records, _ := store.LoadTopN("duration", 10, false)
	if len(records) != 0 {
		t.Fatalf("清空后应无记录，got=%d", len(records))
	}
}

func TestQueryHistoryStore_SharesLockAcrossInstances(t *testing.T) {
	dir := t.TempDir()
	first := newQueryHistoryStore(dir, "same-conn")
	second := newQueryHistoryStore(dir, "same-conn")
	if first.mu != second.mu {
		t.Fatal("同一路径的 store 实例必须共享文件锁")
	}

	const count = 100
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			store := first
			if index%2 == 0 {
				store = second
			}
			store.Append(connection.QueryExecutionRecord{
				ID:             fmt.Sprintf("r-%d", index),
				SQLFingerprint: fmt.Sprintf("fp-%d", index),
				DurationMs:     1000,
				ExecutedAt:     time.Now(),
			})
		}(i)
	}
	wg.Wait()

	records, err := first.LoadTopN("recent", count, false)
	if err != nil {
		t.Fatalf("并发追加后读取失败：%v", err)
	}
	if len(records) != count {
		t.Fatalf("并发追加不应丢记录，want=%d got=%d", count, len(records))
	}
}

func TestQueryHistoryStore_UsesPrivatePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 不提供可移植的 POSIX 权限位断言")
	}
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "private-conn")
	store.Append(connection.QueryExecutionRecord{ID: "r1", DurationMs: 1000, ExecutedAt: time.Now()})

	dirInfo, err := os.Stat(filepath.Dir(store.filePath))
	if err != nil {
		t.Fatalf("读取历史目录权限失败：%v", err)
	}
	if got := dirInfo.Mode().Perm(); got != 0o700 {
		t.Fatalf("历史目录权限应为 0700，got=%#o", got)
	}
	fileInfo, err := os.Stat(store.filePath)
	if err != nil {
		t.Fatalf("读取历史文件权限失败：%v", err)
	}
	if got := fileInfo.Mode().Perm(); got != 0o600 {
		t.Fatalf("历史文件权限应为 0600，got=%#o", got)
	}
}

func TestQueryHistoryStore_EmptyReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "missing-fp")
	records, err := store.LoadTopN("duration", 10, false)
	if err != nil {
		t.Fatalf("不存在的文件应返回空而非 error：%v", err)
	}
	if len(records) != 0 {
		t.Fatalf("空历史应返回 0 条，got=%d", len(records))
	}
}

func TestBuildSQLFingerprint_NormalizesLiterals(t *testing.T) {
	sql1 := "SELECT * FROM users WHERE id = 1 AND name = 'alice'"
	sql2 := "SELECT * FROM users WHERE id = 999 AND name = 'bob'"
	fp1 := buildSQLFingerprint(sql1)
	fp2 := buildSQLFingerprint(sql2)
	if fp1 != fp2 {
		t.Fatalf("字面量不同应归一化为同一指纹：fp1=%s fp2=%s", fp1, fp2)
	}
	if fp1 == "" {
		t.Fatal("指纹不应为空")
	}
}

func TestBuildSQLFingerprint_DifferentSQLDifferentFingerprint(t *testing.T) {
	sql1 := "SELECT * FROM users WHERE id = 1"
	sql2 := "SELECT * FROM orders WHERE id = 1"
	fp1 := buildSQLFingerprint(sql1)
	fp2 := buildSQLFingerprint(sql2)
	if fp1 == fp2 {
		t.Fatal("不同 SQL 应有不同指纹")
	}
}

func TestBuildSQLFingerprint_CaseInsensitiveKeywords(t *testing.T) {
	sql1 := "SELECT * FROM users"
	sql2 := "select * from users"
	if buildSQLFingerprint(sql1) != buildSQLFingerprint(sql2) {
		t.Fatal("大小写不同的关键字应归一化为同一指纹")
	}
}

func TestBuildSQLFingerprint_IgnoresCommentsAndFormatting(t *testing.T) {
	compact := "SELECT id,name FROM users WHERE id=123 AND status='active'"
	formatted := "  select id, name\nFROM users -- active users only\nWHERE id = 999 /* runtime value */ AND status = 'disabled'  "
	if buildSQLFingerprint(compact) != buildSQLFingerprint(formatted) {
		t.Fatalf("注释、空白和字面量差异不应拆分同一 SQL：\n%s\n%s", normalizeSQLForFingerprint(compact), normalizeSQLForFingerprint(formatted))
	}
}

func TestBuildSQLFingerprint_PreservesQuotedIdentifiers(t *testing.T) {
	upper := `SELECT "UserID" FROM "Accounts" WHERE id = 1`
	lower := `SELECT "userid" FROM "Accounts" WHERE id = 2`
	if buildSQLFingerprint(upper) == buildSQLFingerprint(lower) {
		t.Fatal("双引号标识符可能大小写敏感，指纹不能抹掉其内容或大小写")
	}
	if normalized := normalizeSQLForFingerprint(upper); !containsStr(normalized, `"UserID"`) || !containsStr(normalized, `"Accounts"`) {
		t.Fatalf("双引号标识符应完整保留，got=%q", normalized)
	}
}

func TestBuildSQLFingerprint_DoesNotReplaceDigitsInsideIdentifiers(t *testing.T) {
	if buildSQLFingerprint("SELECT * FROM report_2025") == buildSQLFingerprint("SELECT * FROM report_2026") {
		t.Fatal("标识符中的数字不是字面量，不应被替换")
	}
}

func TestBuildSQLFingerprint_HandlesPostgresDollarQuotedLiteralsBeforeComments(t *testing.T) {
	first := "SELECT $$a -- x /* inside */$$ AS payload FROM events WHERE id = 1"
	second := "select $body$b -- y /* inside */$body$ as payload from events where id=999"
	firstNormalized := normalizeSQLForFingerprint(first)
	secondNormalized := normalizeSQLForFingerprint(second)
	if !containsStr(firstNormalized, "from events") || !containsStr(secondNormalized, "from events") {
		t.Fatalf("dollar-quoted 字符串内的注释符不能截断后续 SQL：first=%q second=%q", firstNormalized, secondNormalized)
	}
	if buildSQLFingerprint(first) != buildSQLFingerprint(second) {
		t.Fatalf("不同 dollar-quoted 字面量应归一化为同一模板：first=%q second=%q", firstNormalized, secondNormalized)
	}
}

func TestBuildQueryPreview_TruncatesLongSQL(t *testing.T) {
	longSQL := ""
	for i := 0; i < 500; i++ {
		longSQL += "a"
	}
	preview := buildQueryPreview(longSQL)
	if len([]rune(preview)) > queryHistoryPreviewRunes {
		t.Fatalf("预览应不超过 %d 字符，got=%d", queryHistoryPreviewRunes, len([]rune(preview)))
	}
}

func TestBuildQueryPreview_FoldsWhitespace(t *testing.T) {
	multiLine := "SELECT *\n  FROM\tusers\nWHERE id = 1"
	preview := buildQueryPreview(multiLine)
	if containsNewline(preview) {
		t.Fatalf("预览不应含换行符：%q", preview)
	}
	if !containsStr(preview, "SELECT * FROM users WHERE id = ?") {
		t.Fatalf("预览应折叠空白并脱敏字面量：%q", preview)
	}
}

func TestBuildQueryExecutionRecord_KeepsBoundedFullSQL(t *testing.T) {
	shortSQL := "SELECT *\nFROM users WHERE id = 1"
	short := buildQueryExecutionRecord(connection.ConnectionConfig{Type: "sqlite", Database: "test.db"}, "", "sqlite", shortSQL, 1000, 0, 2)
	if short.SQLText != "SELECT *\nFROM users WHERE id = ?" || short.SQLTruncated {
		t.Fatalf("短 SQL 应保留结构、脱敏字面量且不标记截断，got text=%q truncated=%v", short.SQLText, short.SQLTruncated)
	}
	if short.ExecutionCount != 1 || short.MaxDurationMs != 1000 || short.AvgDurationMs != 1000 {
		t.Fatalf("新记录应初始化聚合字段，got=%+v", short)
	}
	if !short.Diagnosable || short.StatementCount != 1 {
		t.Fatalf("单条只读 SQL 应可诊断，got=%+v", short)
	}
	writeRecord := buildQueryExecutionRecord(connection.ConnectionConfig{Type: "sqlite", Database: "test.db"}, "", "sqlite", "UPDATE users SET active = 1", 1000, 0, 0)
	if writeRecord.Diagnosable || writeRecord.StatementCount != 1 {
		t.Fatalf("写操作不应开放执行计划诊断，got=%+v", writeRecord)
	}
	batchRecord := buildQueryExecutionRecord(connection.ConnectionConfig{Type: "sqlite", Database: "test.db"}, "", "sqlite", "SELECT 1; SELECT 2", 1000, 0, 2)
	if batchRecord.Diagnosable || batchRecord.StatementCount != 2 {
		t.Fatalf("多语句批次不应开放执行计划诊断，got=%+v", batchRecord)
	}

	longRunes := make([]rune, queryHistorySQLRunes+100)
	for i := range longRunes {
		longRunes[i] = '界'
	}
	long := buildQueryExecutionRecord(connection.ConnectionConfig{Type: "sqlite", Database: "test.db"}, "", "sqlite", string(longRunes), 1000, 0, 0)
	if !long.SQLTruncated {
		t.Fatal("超长 SQL 应标记为已截断")
	}
	if got := len([]rune(long.SQLText)); got != queryHistorySQLRunes {
		t.Fatalf("完整 SQL 上限应为 %d 个字符，got=%d", queryHistorySQLRunes, got)
	}
}

func TestBuildQueryExecutionRecord_RedactsSensitiveSQL(t *testing.T) {
	sql := "SELECT * FROM users WHERE phone = '13800138000' AND token = 'raw-token' AND id = 42"
	record := buildQueryExecutionRecord(connection.ConnectionConfig{Type: "postgres", Database: "test"}, "", "postgres", sql, 1000, 0, 1)
	for _, field := range []struct {
		name  string
		value string
	}{
		{name: "SQLPreview", value: record.SQLPreview},
		{name: "SQLText", value: record.SQLText},
	} {
		if strings.Contains(field.value, "13800138000") || strings.Contains(field.value, "raw-token") || strings.Contains(field.value, "42") {
			t.Fatalf("%s leaked raw SQL literal: %q", field.name, field.value)
		}
	}
	if !strings.Contains(record.SQLText, "SELECT") || !strings.Contains(record.SQLText, "FROM users") {
		t.Fatalf("redacted history should retain SQL structure: %q", record.SQLText)
	}
}

func TestQueryHistoryStore_RedactsLegacyRawSQLOnLoad(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "legacy-raw")
	payload := `{"id":"raw","connectionFp":"legacy-raw","sqlFp":"raw-fp","sqlPreview":"SELECT * FROM users WHERE token = 'raw-token'","sqlText":"SELECT * FROM users WHERE token = 'raw-token'","dbType":"postgres","durationMs":1000,"executedAt":"2026-08-17T00:00:00Z"}` + "\n"
	if err := os.MkdirAll(filepath.Dir(store.filePath), 0o700); err != nil {
		t.Fatalf("create history directory: %v", err)
	}
	if err := os.WriteFile(store.filePath, []byte(payload), 0o600); err != nil {
		t.Fatalf("write legacy history: %v", err)
	}

	records, err := store.LoadTopN("recent", 10, false)
	if err != nil {
		t.Fatalf("load legacy history: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected one legacy record, got %d", len(records))
	}
	if strings.Contains(records[0].SQLPreview, "raw-token") || strings.Contains(records[0].SQLText, "raw-token") {
		t.Fatalf("legacy history returned raw SQL: %+v", records[0])
	}
}
func TestQueryHistoryStore_RedactsLegacyRawSQLThroughEndpoint(t *testing.T) {
	dir := t.TempDir()
	app := &App{configDir: dir}
	config := connection.ConnectionConfig{Type: "postgres", Host: "db.internal", Port: 5432, User: "app"}
	fingerprint, ok := buildQueryHistoryConnectionFingerprint(config, "analytics")
	if !ok {
		t.Fatal("expected query history fingerprint")
	}
	store := newQueryHistoryStore(dir, fingerprint)
	if err := os.MkdirAll(filepath.Dir(store.filePath), 0o700); err != nil {
		t.Fatalf("create history directory: %v", err)
	}
	payload := `{"id":"endpoint-raw","connectionFp":"legacy","sqlFp":"endpoint-fp","sqlPreview":"SELECT * FROM users WHERE phone = '13800138000'","sqlText":"SELECT * FROM users WHERE phone = '13800138000'","dbType":"postgres","durationMs":1000,"executedAt":"2026-08-17T00:00:00Z"}` + "\n"
	if err := os.WriteFile(store.filePath, []byte(payload), 0o600); err != nil {
		t.Fatalf("write legacy history: %v", err)
	}

	result := app.GetSlowQueries(config, "analytics", "recent", 10)
	if !result.Success {
		t.Fatalf("GetSlowQueries failed: %s", result.Message)
	}
	records, ok := result.Data.([]connection.QueryExecutionRecord)
	if !ok || len(records) != 1 {
		t.Fatalf("unexpected endpoint records: %#v", result.Data)
	}
	if strings.Contains(records[0].SQLPreview, "13800138000") || strings.Contains(records[0].SQLText, "13800138000") {
		t.Fatalf("GetSlowQueries returned raw SQL: %+v", records[0])
	}
}
func TestQueryHistoryStore_LoadsLegacyJSONL(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "legacy-conn")
	if err := os.MkdirAll(filepath.Dir(store.filePath), 0o700); err != nil {
		t.Fatalf("创建目录失败：%v", err)
	}
	legacy := `{"id":"old","connectionFp":"legacy-conn","sqlFp":"legacy-fp","sqlPreview":"SELECT 1","dbType":"mysql","durationMs":800,"executedAt":"2025-01-01T00:00:00Z"}` + "\n"
	if err := os.WriteFile(store.filePath, []byte(legacy), 0o600); err != nil {
		t.Fatalf("写入旧版 JSONL 失败：%v", err)
	}

	records, err := store.LoadTopN("recent", 10, true)
	if err != nil {
		t.Fatalf("加载旧版 JSONL 失败：%v", err)
	}
	if len(records) != 1 || records[0].ID != "old" || records[0].ExecutionCount != 1 {
		t.Fatalf("旧版记录应兼容并补齐一次执行统计，got=%+v", records)
	}
}

func TestQueryHistoryStore_CapsRequestedLimit(t *testing.T) {
	dir := t.TempDir()
	store := newQueryHistoryStore(dir, "limited-conn")
	for i := 0; i < queryHistoryMaxResults+10; i++ {
		store.Append(connection.QueryExecutionRecord{
			ID:             fmt.Sprintf("r-%d", i),
			SQLFingerprint: fmt.Sprintf("fp-%d", i),
			DurationMs:     1000,
			ExecutedAt:     time.Now().Add(time.Duration(i) * time.Millisecond),
		})
	}
	records, err := store.LoadTopN("recent", queryHistoryMaxResults+100, false)
	if err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	if len(records) != queryHistoryMaxResults {
		t.Fatalf("返回条数必须限制为 %d，got=%d", queryHistoryMaxResults, len(records))
	}
}

func TestQueryResultRowsReturned(t *testing.T) {
	result := connection.QueryResult{Data: []connection.ResultSetData{
		{Rows: []map[string]interface{}{{"id": 1}, {"id": 2}}, Columns: []string{"id"}},
		{Rows: []map[string]interface{}{{"affectedRows": int64(3)}}, Columns: []string{"affectedRows"}},
		{Rows: []map[string]interface{}{{"name": "alice"}}, Columns: []string{"name"}},
	}}
	if got := queryResultRowsReturned(result); got != 3 {
		t.Fatalf("只应统计真实结果集行数，want=3 got=%d", got)
	}

	direct := connection.QueryResult{Data: []map[string]interface{}{{"id": 1}, {"id": 2}}}
	if got := queryResultRowsReturned(direct); got != 2 {
		t.Fatalf("单结果集应统计返回行数，want=2 got=%d", got)
	}
}

func TestRecordQueryExecutionUsesSelectedDatabaseScope(t *testing.T) {
	dir := t.TempDir()
	app := &App{configDir: dir}
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root", Database: "default_db"}

	app.recordQueryExecution(config, "analytics", "mysql", "SELECT * FROM events", 1000, 0, 1)

	normalized := normalizeRunConfig(config, "analytics")
	normalizedFP, _ := buildQueryHistoryConnectionFingerprint(normalized, "analytics")
	records, err := newQueryHistoryStore(dir, normalizedFP).LoadTopN("recent", 10, false)
	if err != nil || len(records) != 1 {
		t.Fatalf("记录应写入所选数据库作用域，records=%+v err=%v", records, err)
	}
	defaultFP, _ := buildQueryHistoryConnectionFingerprint(config, "")
	defaultRecords, err := newQueryHistoryStore(dir, defaultFP).LoadTopN("recent", 10, false)
	if err != nil {
		t.Fatalf("加载默认数据库作用域失败：%v", err)
	}
	if len(defaultRecords) != 0 {
		t.Fatalf("记录不应错误写入默认数据库作用域，got=%+v", defaultRecords)
	}
}

func TestBuildQueryHistoryConnectionFingerprint_SupportsIDOnlyAndDSNOnlyConnections(t *testing.T) {
	idConfig := connection.ConnectionConfig{ID: "custom-prod", Type: "custom", Driver: "postgres", DSN: "postgres://secret@db.example/app"}
	idFP, ok := buildQueryHistoryConnectionFingerprint(idConfig, "analytics")
	if !ok || idFP == "" {
		t.Fatal("只有 ID 的自定义连接也应生成慢查询指纹")
	}
	changedSecret := idConfig
	changedSecret.DSN = "postgres://rotated-secret@db.example/app"
	changedFP, ok := buildQueryHistoryConnectionFingerprint(changedSecret, "analytics")
	if !ok || changedFP != idFP {
		t.Fatal("存在稳定连接 ID 时，凭据轮换不应切断慢查询历史")
	}
	builtInWithID := connection.ConnectionConfig{
		ID: "mysql-prod", Type: "mysql", Host: "db.internal", Port: 3306, User: "app",
	}
	builtInIDFP, ok := buildQueryHistoryConnectionFingerprint(builtInWithID, "analytics")
	if !ok || builtInIDFP == "" {
		t.Fatal("普通已保存连接应使用稳定 ID 生成慢查询指纹")
	}
	changedTransport := builtInWithID
	changedTransport.Host = "db-vip.internal"
	changedTransport.UseSSL = true
	changedTransport.SSLMode = "required"
	changedTransportFP, ok := buildQueryHistoryConnectionFingerprint(changedTransport, "analytics")
	if !ok || changedTransportFP != builtInIDFP {
		t.Fatal("普通连接修改主机或 SSL 后不应丢失慢查询历史")
	}
	otherDBFP, ok := buildQueryHistoryConnectionFingerprint(idConfig, "reporting")
	if !ok || otherDBFP == idFP {
		t.Fatal("同一连接的不同逻辑数据库必须隔离慢查询历史")
	}

	dsnOnly := connection.ConnectionConfig{Type: "custom", Driver: "postgres", DSN: "postgres://secret@db.example/app"}
	dsnFP, ok := buildQueryHistoryConnectionFingerprint(dsnOnly, "analytics")
	if !ok || dsnFP == "" {
		t.Fatal("DSN-only 连接也应生成慢查询指纹")
	}
	if containsStr(dsnFP, "secret") || containsStr(dsnFP, "db.example") {
		t.Fatalf("指纹不得包含 DSN 原文，got=%q", dsnFP)
	}
	otherDSN := dsnOnly
	otherDSN.DSN = "postgres://secret@other.example/app"
	otherDSNFP, ok := buildQueryHistoryConnectionFingerprint(otherDSN, "analytics")
	if !ok || otherDSNFP == dsnFP {
		t.Fatal("没有稳定 ID 时，不同 DSN 必须使用不同慢查询指纹")
	}

	builtInDSN := connection.ConnectionConfig{Type: "postgres", DSN: "postgres://secret@db.example/app"}
	builtInFP, ok := buildQueryHistoryConnectionFingerprint(builtInDSN, "analytics")
	if !ok || builtInFP == "" {
		t.Fatal("内置数据库类型的 DSN-only 连接也应生成慢查询指纹")
	}
	otherBuiltInDSN := builtInDSN
	otherBuiltInDSN.DSN = "postgres://secret@other.example/app"
	otherBuiltInFP, ok := buildQueryHistoryConnectionFingerprint(otherBuiltInDSN, "analytics")
	if !ok || otherBuiltInFP == builtInFP {
		t.Fatal("内置数据库类型不能因 logical DB 被填充而忽略 DSN 身份")
	}
}

func TestQueryHistoryEndpointsReadAndClearLegacyBaseFingerprint(t *testing.T) {
	dir := t.TempDir()
	app := &App{configDir: dir}
	config := connection.ConnectionConfig{
		ID: "mysql-prod", Type: "mysql", Host: "db.internal", Port: 3306, User: "app",
	}
	legacyFP, ok := buildConnectionFingerprint(config)
	if !ok {
		t.Fatal("expected legacy base fingerprint")
	}
	legacyStore := newQueryHistoryStore(dir, legacyFP)
	legacyStore.Append(connection.QueryExecutionRecord{
		ID: "legacy", SQLFingerprint: "legacy-fp", SQLPreview: "SELECT 1", SQLText: "SELECT 1",
		DurationMs: 800, MaxDurationMs: 800, ExecutionCount: 1, ExecutedAt: time.Now(),
	})

	loaded := app.GetSlowQueries(config, "analytics", "recent", 10)
	if !loaded.Success {
		t.Fatalf("load legacy history failed: %s", loaded.Message)
	}
	records, ok := loaded.Data.([]connection.QueryExecutionRecord)
	if !ok || len(records) != 1 || records[0].ID != "legacy" {
		t.Fatalf("legacy base-fingerprint history should stay visible, got=%#v", loaded.Data)
	}
	remainingLegacy, err := legacyStore.LoadTopN("recent", 10, false)
	if err != nil || len(remainingLegacy) != 0 {
		t.Fatalf("legacy history should migrate to the stable ID fingerprint, records=%+v err=%v", remainingLegacy, err)
	}
	primaryFP, ok := buildQueryHistoryConnectionFingerprint(config, "analytics")
	if !ok {
		t.Fatal("expected stable primary fingerprint")
	}
	primaryRecords, err := newQueryHistoryStore(dir, primaryFP).LoadTopN("recent", 10, false)
	if err != nil || len(primaryRecords) != 1 || primaryRecords[0].ID != "legacy" {
		t.Fatalf("migrated history missing from stable fingerprint: records=%+v err=%v", primaryRecords, err)
	}

	changedConfig := config
	changedConfig.Host = "db-vip.internal"
	changedConfig.UseSSL = true
	loadedAfterEdit := app.GetSlowQueries(changedConfig, "analytics", "recent", 10)
	changedRecords, changedOK := loadedAfterEdit.Data.([]connection.QueryExecutionRecord)
	if !loadedAfterEdit.Success || !changedOK || len(changedRecords) != 1 || changedRecords[0].ID != "legacy" {
		t.Fatalf("migrated history should survive connection edits, result=%+v", loadedAfterEdit)
	}

	cleared := app.ClearSlowQueries(changedConfig, "analytics")
	if !cleared.Success {
		t.Fatalf("clear legacy history failed: %s", cleared.Message)
	}
	remaining, err := newQueryHistoryStore(dir, primaryFP).LoadTopN("recent", 10, false)
	if err != nil || len(remaining) != 0 {
		t.Fatalf("migrated history should be cleared, records=%+v err=%v", remaining, err)
	}
}

func TestMigrateQueryHistoryStore_DoesNotDropConcurrentLegacyAppend(t *testing.T) {
	dir := t.TempDir()
	// The migration helper locks stores in lexical path order. Holding the later
	// target mutex lets this test observe that migration already owns the source
	// mutex before allowing copy+clear to continue.
	source := newQueryHistoryStore(dir, "aaa-legacy")
	target := newQueryHistoryStore(dir, "zzz-primary")
	if err := source.Append(connection.QueryExecutionRecord{
		ID: "before", ConnectionFP: "aaa-legacy", SQLFingerprint: "before-fp",
		SQLText: "SELECT 1", DurationMs: 800, ExecutedAt: time.Now(),
	}); err != nil {
		t.Fatalf("seed legacy history: %v", err)
	}

	target.mu.Lock()
	migrationDone := make(chan error, 1)
	go func() {
		migrationDone <- migrateQueryHistoryStore(source, target, "zzz-primary")
	}()

	deadline := time.Now().Add(2 * time.Second)
	for {
		if !source.mu.TryLock() {
			break
		}
		source.mu.Unlock()
		if time.Now().After(deadline) {
			target.mu.Unlock()
			t.Fatal("migration did not hold the source lock across the target wait")
		}
		time.Sleep(time.Millisecond)
	}

	appendDone := make(chan error, 1)
	go func() {
		appendDone <- source.Append(connection.QueryExecutionRecord{
			ID: "during", ConnectionFP: "aaa-legacy", SQLFingerprint: "during-fp",
			SQLText: "SELECT 2", DurationMs: 900, ExecutedAt: time.Now(),
		})
	}()
	select {
	case err := <-appendDone:
		target.mu.Unlock()
		t.Fatalf("legacy append must wait for migration copy+clear, err=%v", err)
	case <-time.After(50 * time.Millisecond):
	}

	target.mu.Unlock()
	if err := <-migrationDone; err != nil {
		t.Fatalf("migrate legacy history: %v", err)
	}
	if err := <-appendDone; err != nil {
		t.Fatalf("append after migration: %v", err)
	}

	targetRecords, err := target.LoadAll()
	if err != nil || len(targetRecords) != 1 || targetRecords[0].ID != "before" {
		t.Fatalf("pre-migration record should move to target: records=%+v err=%v", targetRecords, err)
	}
	sourceRecords, err := source.LoadAll()
	if err != nil || len(sourceRecords) != 1 || sourceRecords[0].ID != "during" {
		t.Fatalf("concurrent legacy append should survive for the next migration: records=%+v err=%v", sourceRecords, err)
	}
}

func TestQueryHistoryEndpointsSupportDSNOnlyConnection(t *testing.T) {
	dir := t.TempDir()
	app := &App{configDir: dir}
	config := connection.ConnectionConfig{Type: "custom", Driver: "postgres", DSN: "postgres://secret@db.example/app"}
	app.recordQueryExecution(config, "analytics", "postgres", "SELECT * FROM events", 1000, 0, 2)

	loaded := app.GetSlowQueries(config, "analytics", "recent", 10)
	if !loaded.Success {
		t.Fatalf("DSN-only 连接应能读取慢查询：%s", loaded.Message)
	}
	records, ok := loaded.Data.([]connection.QueryExecutionRecord)
	if !ok || len(records) != 1 || records[0].RowsReturned != 2 {
		t.Fatalf("DSN-only 连接慢查询记录异常：%T %+v", loaded.Data, loaded.Data)
	}

	cleared := app.ClearSlowQueries(config, "analytics")
	if !cleared.Success {
		t.Fatalf("DSN-only 连接应能清空慢查询：%s", cleared.Message)
	}
	loaded = app.GetSlowQueries(config, "analytics", "recent", 10)
	records, ok = loaded.Data.([]connection.QueryExecutionRecord)
	if !loaded.Success || !ok || len(records) != 0 {
		t.Fatalf("清空后应无慢查询记录：success=%v type=%T data=%+v", loaded.Success, loaded.Data, loaded.Data)
	}
}

func TestSanitizeFingerprintForFilename(t *testing.T) {
	if got := sanitizeFingerprintForFilename("abc123_-"); got != "abc123_-" {
		t.Fatalf("合法字符应保留：got=%s", got)
	}
	if got := sanitizeFingerprintForFilename("a/b\\c:d"); got != "abcd" {
		t.Fatalf("非法字符应被过滤：got=%s", got)
	}
	if got := sanitizeFingerprintForFilename(""); got != "default" {
		t.Fatalf("空指纹应回退为 default，got=%s", got)
	}
}

func TestNewQueryHistoryStore_CreatesDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "deep")
	store := newQueryHistoryStore(dir, "fp")
	store.Append(connection.QueryExecutionRecord{
		ID:         "r1",
		DurationMs: 1000,
		ExecutedAt: time.Now(),
	})
	if _, err := os.Stat(store.filePath); err != nil {
		t.Fatalf("Append 应创建嵌套目录并写入：%v", err)
	}
}

func containsNewline(s string) bool {
	for _, ch := range s {
		if ch == '\n' || ch == '\r' {
			return true
		}
	}
	return false
}

func containsStr(s, substr string) bool {
	return len(s) >= len(substr) && indexOfSubstr(s, substr) >= 0
}

func indexOfSubstr(s, substr string) int {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}
