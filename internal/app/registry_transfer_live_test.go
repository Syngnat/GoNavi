//go:build gonavi_full_drivers

package app

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
	syncbackend "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/uievents"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// registryTransferCase 描述一次端到端实测：在实验室库里建表灌数，然后依次走导出、SQL 备份与恢复、
// 表数据导入、跨库迁移（按描述表与能力契约声明的入口逐项执行，未开放的入口跳过）。
// 用例文件由 GONAVI_TRANSFER_LIVE_CASES 指定（JSON 数组），GONAVI_TRANSFER_LIVE_ONLY 可按名称筛选；
// 驱动代理需事先构建到 GONAVI_TRANSFER_LIVE_DRIVERS 目录（<目录>/<类型>/<类型>-driver-agent.exe）。
type registryTransferCase struct {
	Name     string                      `json:"name"`
	Config   connection.ConnectionConfig `json:"config"`
	Database string                      `json:"database"`
	Table    string                      `json:"table"`
	Rows     int                         `json:"rows"`
	// Preseeded 为 true 时表已有数据（如 Presto 的 tpch 目录），只读不灌数，Rows 为已知行数。
	Preseeded bool `json:"preseeded"`
	// ExtraRows 是表里除灌入行之外固有的行数（ZooKeeper 的表节点本身也是一行）。
	ExtraRows int `json:"extraRows"`
	// Setup 在灌数前执行（建表），Cleanup 在结束后执行；以 ? 开头的语句允许失败。
	Setup   []string `json:"setup"`
	Cleanup []string `json:"cleanup"`
	// Insert 是逐行 INSERT 模板（{id} {name} {amount} {flag} {created} {note}）；为空时按 ChangeRow 经 ApplyChanges 写入。
	Insert    string            `json:"insert"`
	ChangeRow map[string]string `json:"changeRow"`
	// FlagStyle 为 int 时 {flag} 输出 1 / 0，否则输出 TRUE / FALSE；EscapeBackslash 为 true 时 {note} 的反斜杠加倍。
	FlagStyle       string `json:"flagStyle"`
	EscapeBackslash bool   `json:"escapeBackslash"`
	// Count 统计行数的语句，{table} 替换为表名。
	Count string `json:"count"`
	// DropTable 在恢复备份前删除原表。
	DropTable string `json:"dropTable"`
	// ImportTable / ImportSetup：表数据导入的目标（先建空表），ImportCount 为空时沿用 Count。
	ImportTable string   `json:"importTable"`
	ImportSetup []string `json:"importSetup"`
	// CompareColumns 只比较这些列（键值库的版本号、修订号在重新写入后会变化）；为空时比较全部列。
	CompareColumns []string `json:"compareColumns"`
	// DBRestoreError 非空时整库恢复应失败且报错包含该文本（库里有备份不包含的依赖对象），失败后原表必须完好。
	DBRestoreError string `json:"dbRestoreError"`
	// Skip 跳过的步骤：export、backup、restore、import、sync、syncBack。
	Skip    []string                 `json:"skip"`
	Targets []registryTransferTarget `json:"targets"`
	// BackTable 是从目标库迁回本库时使用的表名（需本库能作为同步目标）。
	BackTable string `json:"backTable"`
}

type registryTransferTarget struct {
	Name     string                      `json:"name"`
	Config   connection.ConnectionConfig `json:"config"`
	Database string                      `json:"database"`
	Count    string                      `json:"count"`
	Drop     string                      `json:"drop"`
	// Create 非空时先建好目标表并按 existing_only 迁移（源库没有自动建表规划器时，如 Presto / Trino）。
	Create string `json:"create"`
	// Mode 为空时用 insert_update；没有主键的源（Presto）用 insert_only。
	Mode string `json:"mode"`
	// PostSync 在迁入目标后执行（如给目标表加索引），迁回时带上“创建索引”。
	PostSync []string `json:"postSync"`
}

func TestRegistryTransferLive(t *testing.T) {
	casesPath := strings.TrimSpace(os.Getenv("GONAVI_TRANSFER_LIVE_CASES"))
	if casesPath == "" {
		t.Skip("set GONAVI_TRANSFER_LIVE_CASES to a JSON case file")
	}
	raw, err := os.ReadFile(casesPath)
	if err != nil {
		t.Fatal(err)
	}
	var cases []registryTransferCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if dir := strings.TrimSpace(os.Getenv("GONAVI_TRANSFER_LIVE_DRIVERS")); dir != "" {
		db.SetExternalDriverDownloadDirectory(dir)
	}
	only := map[string]bool{}
	for _, name := range strings.Split(os.Getenv("GONAVI_TRANSFER_LIVE_ONLY"), ",") {
		if name = strings.TrimSpace(name); name != "" {
			only[name] = true
		}
	}
	for _, tc := range cases {
		tc := tc
		if len(only) > 0 && !only[tc.Name] {
			continue
		}
		t.Run(tc.Name, func(t *testing.T) { runRegistryTransferCase(t, tc) })
	}
}

func newRegistryTransferApp(t *testing.T) (*App, func(string) string) {
	t.Helper()
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()
	app.ctx = uievents.WithEmitter(context.Background(), noopImportEventEmitter{})
	outDir := t.TempDir()
	var target string
	app.saveFileDialog = func(_ context.Context, _ runtime.SaveDialogOptions) (string, error) { return target, nil }
	next := func(name string) string {
		target = filepath.Join(outDir, name)
		return target
	}
	t.Cleanup(app.closeCachedDatabasesForShutdown)
	return app, next
}

func runRegistryTransferCase(t *testing.T, tc registryTransferCase) {
	app, nextFile := newRegistryTransferApp(t)
	config := tc.Config
	spec, _ := db.DataSourceSpec(config.Type)
	// 虚拟库（etcd 前缀、ZooKeeper 节点）与应用一致：导航树上的库名不写进连接配置。
	if tc.Database != "" && !spec.SyntheticDatabase {
		config.Database = tc.Database
	}
	if tc.Rows <= 0 {
		tc.Rows = 2500
	}
	skip := map[string]bool{}
	for _, step := range tc.Skip {
		skip[step] = true
	}
	capability := db.ResolveDataSourceCapability(config.Type)

	inst, err := app.getDatabase(config)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	execAll(t, inst, tc.Setup)
	defer execAll(t, inst, tc.Cleanup)
	if !tc.Preseeded {
		seedRegistryTransferRows(t, inst, tc)
	}
	total := tc.Rows + tc.ExtraRows
	expectCount(t, inst, tc.Count, tc.Table, total, "seed")
	baseline := exportJSONRows(t, app, nextFile, config, tc.Database, tc.Table)
	if len(baseline) != total {
		t.Fatalf("json export rows = %d, want %d", len(baseline), total)
	}

	csvPath := ""
	if !skip["export"] {
		csvPath = nextFile("export.csv")
		result := app.ExportTableWithOptions(config, tc.Database, tc.Table, ExportFileOptions{Format: "csv"})
		if !result.Success {
			t.Fatalf("csv export: %s", result.Message)
		}
		if got := countCSVRecords(t, csvPath); got != total {
			t.Fatalf("csv export rows = %d, want %d", got, total)
		}
		for _, format := range []string{"xlsx", "md", "html"} {
			nextFile("export." + format)
			if result := app.ExportTableWithOptions(config, tc.Database, tc.Table, ExportFileOptions{Format: format}); !result.Success {
				t.Fatalf("%s export: %s", format, result.Message)
			}
		}
		t.Logf("export csv/json/xlsx/md/html ok (%d rows)", total)
	}

	if capability.UI.SQLQueryExport && !skip["backup"] {
		dumpPath := nextFile("backup.sql")
		result := app.ExportTablesSQLWithOptions(config, tc.Database, []string{tc.Table}, true, true, ExportFileOptions{Format: "sql", IncludeDropIfExists: true})
		if !result.Success {
			t.Fatalf("sql backup: %s", result.Message)
		}
		if spec.SQLFileImport && !skip["restore"] {
			execAll(t, inst, []string{tc.DropTable})
			restore := app.ImportDatabaseSQLWithOptions(config, tc.Database, dumpPath, "restore-"+tc.Name, false, "")
			if !restore.Success {
				dump, _ := os.ReadFile(dumpPath)
				t.Fatalf("sql restore: %s\n--- dump head ---\n%s", restore.Message, headText(string(dump), 1500))
			}
			expectCount(t, inst, tc.Count, tc.Table, total, "restore")
			restored := exportJSONRows(t, app, nextFile, config, tc.Database, tc.Table)
			compareRows(t, "restore", baseline, restored, tc.CompareColumns)
			// 再恢复一次：带 DROP 的备份应能覆盖已有表。
			if again := app.ImportDatabaseSQLWithOptions(config, tc.Database, dumpPath, "restore2-"+tc.Name, false, ""); !again.Success {
				t.Fatalf("sql restore over existing table: %s", again.Message)
			}
			expectCount(t, inst, tc.Count, tc.Table, total, "restore-again")
			t.Logf("sql backup + restore ok")
		}
		if spec.SQLFileImport && !skip["dbBackup"] {
			// 整库备份（侧栏“备份全部表”）：带建库 / USE / 删除重建，恢复后原表行数不变。
			dbDump := nextFile("database.sql")
			result := app.ExportDatabaseSQLWithOptions(config, tc.Database, true, ExportFileOptions{Format: "sql", IncludeDatabaseContext: true, IncludeDropIfExists: true})
			if !result.Success {
				t.Fatalf("database backup: %s", result.Message)
			}
			restore := app.ImportDatabaseSQLWithOptions(config, tc.Database, dbDump, "dbrestore-"+tc.Name, false, "")
			if tc.DBRestoreError != "" {
				if restore.Success || !strings.Contains(restore.Message, tc.DBRestoreError) {
					t.Fatalf("database restore should fail with %q, got success=%v %s", tc.DBRestoreError, restore.Success, restore.Message)
				}
				expectCount(t, inst, tc.Count, tc.Table, total, "database-restore-rejected")
				t.Logf("database restore rejected atomically: %s", headText(restore.Message, 160))
			} else if !restore.Success {
				dump, _ := os.ReadFile(dbDump)
				t.Fatalf("database restore: %s\n--- dump head ---\n%s", restore.Message, headText(string(dump), 1200))
			}
			if tc.DBRestoreError == "" {
				expectCount(t, inst, tc.Count, tc.Table, total, "database-restore")
				t.Logf("database backup + restore ok")
			}
		}
	}

	if spec.ExcelImport && !skip["import"] && csvPath != "" && tc.ImportTable != "" {
		execAll(t, inst, tc.ImportSetup)
		stop := false
		result := app.ImportDataWithProgressOptions(config, tc.Database, tc.ImportTable, csvPath, ImportFileOptions{JobID: "import-" + tc.Name, ContinueOnError: &stop})
		if !result.Success {
			t.Fatalf("table import: %s", result.Message)
		}
		expectCount(t, inst, tc.Count, tc.ImportTable, total, "import")
		imported := exportJSONRows(t, app, nextFile, config, tc.Database, tc.ImportTable)
		compareRows(t, "import", baseline, imported, tc.CompareColumns)
		t.Logf("table import ok")
	}

	if spec.Sync != nil && spec.Sync.Source && !skip["sync"] {
		for _, target := range tc.Targets {
			runRegistryTransferSync(t, config, tc, target, spec.Sync.Target && !skip["syncBack"])
		}
	}
}

func runRegistryTransferSync(t *testing.T, source connection.ConnectionConfig, tc registryTransferCase, target registryTransferTarget, back bool) {
	targetConfig := target.Config
	if target.Database != "" {
		targetConfig.Database = target.Database
	}
	targetInst, err := db.NewDatabase(targetConfig.Type)
	if err != nil {
		t.Fatal(err)
	}
	if err := targetInst.Connect(targetConfig); err != nil {
		t.Fatalf("connect %s: %v", target.Name, err)
	}
	defer targetInst.Close()
	dropTarget := strings.ReplaceAll(target.Drop, "{table}", tc.Table)
	execAll(t, targetInst, []string{"?" + dropTarget})
	mode := target.Mode
	if mode == "" {
		mode = "insert_update"
	}
	strategy := "auto_create_if_missing"
	if target.Create != "" {
		execAll(t, targetInst, []string{strings.ReplaceAll(target.Create, "{table}", tc.Table)})
		strategy = "existing_only"
	}
	result := syncbackend.NewSyncEngine(syncbackend.Reporter{}).RunSync(syncbackend.SyncConfig{
		SourceConfig:        source,
		TargetConfig:        targetConfig,
		SourceDatabase:      tc.Database,
		TargetDatabase:      target.Database,
		Tables:              []string{tc.Table},
		Content:             "both",
		Mode:                mode,
		TargetTableStrategy: strategy,
		CreateIndexes:       strategy != "existing_only",
	})
	if !result.Success {
		t.Fatalf("sync -> %s: %s\n%s", target.Name, result.Message, strings.Join(result.Logs, "\n"))
	}
	expectCount(t, targetInst, target.Count, tc.Table, tc.Rows, "sync->"+target.Name)
	t.Logf("sync -> %s ok", target.Name)
	for _, statement := range target.PostSync {
		execAll(t, targetInst, []string{strings.ReplaceAll(statement, "{table}", tc.Table)})
	}
	if !back || tc.BackTable == "" {
		execAll(t, targetInst, []string{"?" + dropTarget})
		return
	}
	sourceInst, err := db.NewDatabase(source.Type)
	if err != nil {
		t.Fatal(err)
	}
	if err := sourceInst.Connect(source); err != nil {
		t.Fatal(err)
	}
	defer sourceInst.Close()
	dropBack := strings.ReplaceAll(tc.DropTable, tc.Table, tc.BackTable)
	execAll(t, sourceInst, []string{"?" + dropBack})
	backResult := syncbackend.NewSyncEngine(syncbackend.Reporter{}).RunSync(syncbackend.SyncConfig{
		SourceConfig:        targetConfig,
		TargetConfig:        source,
		SourceDatabase:      target.Database,
		TargetDatabase:      tc.Database,
		Tables:              []string{tc.Table},
		Content:             "both",
		Mode:                "insert_update",
		TargetTableStrategy: "auto_create_if_missing",
		CreateIndexes:       len(target.PostSync) > 0,
		Mappings: []syncbackend.SyncObjectMapping{{
			Source: syncbackend.SyncObjectRef{Name: tc.Table}, Target: syncbackend.SyncObjectRef{Name: tc.BackTable},
		}},
	})
	if !backResult.Success {
		t.Fatalf("sync %s -> back: %s\n%s", target.Name, backResult.Message, strings.Join(backResult.Logs, "\n"))
	}
	expectCount(t, sourceInst, tc.Count, tc.BackTable, tc.Rows, "sync-back<-"+target.Name)
	if len(backResult.Logs) > 0 && len(target.PostSync) > 0 {
		for _, line := range backResult.Logs {
			if strings.Contains(line, "索引") {
				t.Logf("  %s", line)
			}
		}
	}
	execAll(t, sourceInst, []string{"?" + dropBack})
	execAll(t, targetInst, []string{"?" + dropTarget})
	t.Logf("sync %s -> back ok", target.Name)
}

func execAll(t *testing.T, inst db.Database, statements []string) {
	t.Helper()
	for _, statement := range statements {
		statement = strings.TrimSpace(statement)
		if statement == "" {
			continue
		}
		optional := strings.HasPrefix(statement, "?")
		statement = strings.TrimSpace(strings.TrimPrefix(statement, "?"))
		if statement == "" {
			continue
		}
		if strings.HasPrefix(statement, "sleep ") {
			if d, err := time.ParseDuration(strings.TrimSpace(strings.TrimPrefix(statement, "sleep "))); err == nil {
				time.Sleep(d)
			}
			continue
		}
		if _, err := inst.Exec(statement); err != nil && !optional {
			t.Fatalf("exec %q: %v", headText(statement, 200), err)
		}
	}
}

func registryTransferRow(i int) (name string, amount float64, flag bool, created time.Time, note string) {
	name = fmt.Sprintf("name-%05d", i)
	amount = float64(i)*1.25 + 0.5
	flag = i%2 == 0
	created = time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC).Add(time.Duration(i) * time.Minute)
	note = fmt.Sprintf("note %d", i)
	if i%10 == 0 {
		note = fmt.Sprintf("it's %d \\ 中文 \"q\"", i)
	}
	return
}

func seedRegistryTransferRows(t *testing.T, inst db.Database, tc registryTransferCase) {
	t.Helper()
	if strings.TrimSpace(tc.Insert) != "" {
		for i := 1; i <= tc.Rows; i++ {
			name, amount, flag, created, note := registryTransferRow(i)
			quote := func(text string) string {
				if tc.EscapeBackslash {
					text = strings.ReplaceAll(text, `\`, `\\`)
				}
				return "'" + strings.ReplaceAll(text, "'", "''") + "'"
			}
			flagText := "FALSE"
			if flag {
				flagText = "TRUE"
			}
			switch tc.FlagStyle {
			case "int":
				flagText = map[bool]string{true: "1", false: "0"}[flag]
			case "tf":
				flagText = map[bool]string{true: "'t'", false: "'f'"}[flag]
			}
			statement := strings.NewReplacer(
				"{id}", strconv.Itoa(i),
				"{name}", quote(name),
				"{amount}", strconv.FormatFloat(amount, 'f', 2, 64),
				"{flag}", flagText,
				"{created}", quote(created.Format("2006-01-02 15:04:05")),
				"{note}", quote(note),
			).Replace(tc.Insert)
			if _, err := inst.Exec(statement); err != nil {
				t.Fatalf("seed row %d: %v", i, err)
			}
		}
		return
	}
	applier, ok := inst.(db.BatchApplier)
	if !ok {
		t.Fatalf("%s has no ApplyChanges for seeding", tc.Name)
	}
	batch := make([]map[string]interface{}, 0, 500)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := applier.ApplyChanges(tc.Table, connection.ChangeSet{Inserts: batch}); err != nil {
			t.Fatalf("seed via ApplyChanges: %v", err)
		}
		batch = batch[:0]
	}
	for i := 1; i <= tc.Rows; i++ {
		name, amount, flag, created, note := registryTransferRow(i)
		row := map[string]interface{}{}
		for column, template := range tc.ChangeRow {
			switch template {
			case "{id}":
				row[column] = i
			case "{amount}":
				row[column] = amount
			case "{flag}":
				row[column] = flag
			default:
				row[column] = strings.NewReplacer(
					"{uuid}", fmt.Sprintf("00000000-0000-0000-0000-%012d", i),
					"{id}", strconv.Itoa(i), "{name}", name, "{note}", note,
					"{created}", created.Format(time.RFC3339), "{table}", tc.Table,
				).Replace(template)
			}
		}
		batch = append(batch, row)
		if len(batch) == cap(batch) {
			flush()
		}
	}
	flush()
}

func expectCount(t *testing.T, inst db.Database, countQuery, table string, want int, stage string) {
	t.Helper()
	if strings.TrimSpace(countQuery) == "" {
		return
	}
	query := strings.ReplaceAll(countQuery, "{table}", table)
	var got int
	for attempt := 0; attempt < 10; attempt++ {
		rows, _, err := inst.Query(query)
		if err != nil {
			t.Fatalf("%s count %q: %v", stage, query, err)
		}
		got = -1
		if len(rows) > 0 {
			for _, value := range rows[0] {
				got, _ = strconv.Atoi(strings.TrimSpace(fmt.Sprint(value)))
			}
		}
		if got == want {
			return
		}
		time.Sleep(time.Second)
	}
	t.Fatalf("%s count = %d, want %d", stage, got, want)
}

func exportJSONRows(t *testing.T, app *App, nextFile func(string) string, config connection.ConnectionConfig, database, table string) []map[string]interface{} {
	t.Helper()
	path := nextFile(fmt.Sprintf("%s-%d.json", sanitizeExportFileStem(table), time.Now().UnixNano()))
	result := app.ExportTableWithOptions(config, database, table, ExportFileOptions{Format: "json"})
	if !result.Success {
		t.Fatalf("json export %s: %s", table, result.Message)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]interface{}
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("json export parse: %v\n%s", err, headText(string(raw), 500))
	}
	return rows
}

func countCSVRecords(t *testing.T, path string) int {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader := csv.NewReader(file)
	reader.FieldsPerRecord = -1
	count := -1
	for {
		_, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("csv parse: %v", err)
		}
		count++
	}
	return count
}

// compareRows 按 id（或 key / 第一个列）排序后逐行比较各列的文本形式。
func compareRows(t *testing.T, stage string, want, got []map[string]interface{}, onlyColumns []string) {
	t.Helper()
	if len(want) != len(got) {
		t.Fatalf("%s rows = %d, want %d", stage, len(got), len(want))
	}
	sortRows(want)
	sortRows(got)
	mismatches := 0
	for i := range want {
		for column, value := range want[i] {
			if _, ok := got[i][column]; !ok || (len(onlyColumns) > 0 && !containsFoldString(onlyColumns, column)) {
				continue
			}
			if normalizeTransferValue(value) != normalizeTransferValue(got[i][column]) {
				mismatches++
				if mismatches <= 5 {
					t.Errorf("%s row %d column %s: got %v, want %v", stage, i, column, got[i][column], value)
				}
			}
		}
	}
	if mismatches > 0 {
		t.Fatalf("%s: %d mismatched values", stage, mismatches)
	}
}

func sortRows(rows []map[string]interface{}) {
	key := func(row map[string]interface{}) string {
		for _, column := range []string{"id", "ID", "key", "path", "_id"} {
			if value, ok := row[column]; ok {
				text := normalizeTransferValue(value)
				if n, err := strconv.Atoi(text); err == nil {
					return fmt.Sprintf("%012d", n)
				}
				return text
			}
		}
		return fmt.Sprint(row)
	}
	sort.SliceStable(rows, func(i, j int) bool { return key(rows[i]) < key(rows[j]) })
}

func normalizeTransferValue(value interface{}) string {
	text := strings.TrimSpace(fmt.Sprint(value))
	if value == nil {
		return ""
	}
	if f, err := strconv.ParseFloat(text, 64); err == nil {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	switch strings.ToLower(text) {
	case "true", "t":
		return "1"
	case "false", "f":
		return "0"
	}
	text = strings.TrimSuffix(strings.Replace(text, "T", " ", 1), "Z")
	return strings.TrimSuffix(text, ".000")
}

func headText(text string, n int) string {
	if len(text) <= n {
		return text
	}
	return text[:n] + "..."
}

func containsFoldString(values []string, candidate string) bool {
	for _, value := range values {
		if strings.EqualFold(value, candidate) {
			return true
		}
	}
	return false
}
