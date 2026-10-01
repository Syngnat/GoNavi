package sync

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestWidenCharLengthType(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in       string
		want     string
		wantOK   bool
		wantFrom int
		wantTo   int
	}{
		{"varchar(120)", "varchar(480)", true, 120, 480},
		{"VARCHAR(255)", "VARCHAR(1020)", true, 255, 1020},
		{"character varying(40)", "character varying(160)", true, 40, 160},
		{"char(10)", "char(40)", true, 10, 40},
		{"character(1)", "character(4)", true, 1, 4},
		{"bpchar(8)", "bpchar(32)", true, 8, 32},
		{"varchar( 30 )", "varchar( 120 )", true, 30, 120},
		{"varchar(3000000)", "varchar(10485760)", true, 3000000, 10485760},
		// 已到上限、无长度、非字符类型都必须原样返回。
		{"varchar(10485760)", "varchar(10485760)", false, 0, 0},
		{"varchar", "varchar", false, 0, 0},
		{"text", "text", false, 0, 0},
		{"numeric(10,2)", "numeric(10,2)", false, 0, 0},
		{"varchar(0)", "varchar(0)", false, 0, 0},
	}
	for _, tc := range cases {
		got, from, to, ok := widenCharLengthType(tc.in)
		if got != tc.want || ok != tc.wantOK || from != tc.wantFrom || to != tc.wantTo {
			t.Errorf("widenCharLengthType(%q) = (%q, %d, %d, %v), want (%q, %d, %d, %v)",
				tc.in, got, from, to, ok, tc.want, tc.wantFrom, tc.wantTo, tc.wantOK)
		}
	}
}

func TestByteLengthWidenerOnlyAppliesToByteTargetsFromOtherFamilies(t *testing.T) {
	t.Parallel()

	cases := []struct {
		source string
		target string
		active bool
	}{
		{"oracle", "vastbase", true},
		{"mysql", "opengauss", true},
		{"postgres", "gaussdb", true},
		{"kingbase", "vastbase", true},
		// 同一族两端语义一致，长度原样保留才是无损的。
		{"vastbase", "opengauss", false},
		{"gaussdb", "vastbase", false},
		// 字符计长的目标不需要放宽。
		{"oracle", "postgres", false},
		{"oracle", "kingbase", false},
		{"mysql", "highgo", false},
		{"oracle", "dameng", false},
	}
	for _, tc := range cases {
		col := connection.ColumnDefinition{Name: "name", Type: "varchar(120)"}
		got := newByteLengthWidener(tc.source, tc.target).Adapt(col)
		widened := got.Type == "varchar(480)"
		if widened != tc.active {
			t.Errorf("%s -> %s: widened=%v, want %v (type=%q)", tc.source, tc.target, widened, tc.active, got.Type)
		}
	}

	var nilWidener *byteLengthWidener
	col := connection.ColumnDefinition{Name: "name", Type: "varchar(120)"}
	if got := nilWidener.Adapt(col); got.Type != "varchar(120)" {
		t.Errorf("nil widener must be a no-op, got %q", got.Type)
	}
	if warnings := nilWidener.Warnings(); warnings != nil {
		t.Errorf("nil widener must not warn, got %v", warnings)
	}
}

func TestByteLengthWidenerWarningSummarizesColumns(t *testing.T) {
	t.Parallel()

	widener := newByteLengthWidener("oracle", "vastbase")
	for _, name := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		widener.Adapt(connection.ColumnDefinition{Name: name, Type: "varchar(10)"})
	}
	widener.Adapt(connection.ColumnDefinition{Name: "n", Type: "int"})

	warnings := widener.Warnings()
	if len(warnings) != 1 {
		t.Fatalf("expected a single summary warning, got %v", warnings)
	}
	for _, fragment := range []string{"vastbase", "按字节计", "a(10→40)", "等 7 个字段"} {
		if !strings.Contains(warnings[0], fragment) {
			t.Errorf("warning missing %q: %s", fragment, warnings[0])
		}
	}
	if strings.Contains(warnings[0], "f(10→40)") {
		t.Errorf("warning should cap the listed columns: %s", warnings[0])
	}
}

// Oracle 的 VARCHAR2(n) 落到海量（openGauss 系）时，含中文的数据按字节计长会超出 n，
// 这是数据同步写入 "value too long for type character varying(120) (22001)" 的根因。
func TestOracleToVastbaseAutoCreateWidensCharColumns(t *testing.T) {
	t.Parallel()

	cols := map[string][]connection.ColumnDefinition{
		"HRP_CLOUD_SHOW.AES_AE_RECORD": {
			{Name: "ID", Type: "NUMBER(19)", Nullable: "NO", Key: "PRI"},
			{Name: "REMARK", Type: "VARCHAR2(120)", Nullable: "YES"},
			{Name: "CODE", Type: "CHAR(8)", Nullable: "YES"},
			{Name: "AMOUNT", Type: "NUMBER(12,2)", Nullable: "YES"},
		},
	}
	build := func(target string) SchemaMigrationPlan {
		t.Helper()
		config := SyncConfig{
			SourceConfig:        connection.ConnectionConfig{Type: "oracle"},
			TargetConfig:        connection.ConnectionConfig{Type: target},
			TargetTableStrategy: "smart",
			SourceDatabase:      "HRP_CLOUD_SHOW",
			TargetDatabase:      "HRP_CLOUD_SHOW",
		}
		plan, _, _, err := buildSchemaMigrationPlan(config, "AES_AE_RECORD",
			&fakeMigrationDB{columns: cols}, &fakeMigrationDB{})
		if err != nil {
			t.Fatalf("%s plan error: %v", target, err)
		}
		if !plan.AutoCreate || plan.CreateTableSQL == "" {
			t.Fatalf("%s: expected auto-create plan, got action=%q warnings=%v", target, plan.PlannedAction, plan.Warnings)
		}
		return plan
	}

	vastbase := build("vastbase")
	for _, fragment := range []string{`"REMARK" varchar(480)`, `"CODE" char(32)`} {
		if !strings.Contains(vastbase.CreateTableSQL, fragment) {
			t.Errorf("vastbase DDL missing %q:\n%s", fragment, vastbase.CreateTableSQL)
		}
	}
	if !strings.Contains(strings.Join(vastbase.Warnings, "\n"), "REMARK(120→480)") {
		t.Errorf("vastbase plan must explain the widening, warnings=%v", vastbase.Warnings)
	}

	// 字符计长的 PG 系目标保持源长度，不能被误放宽。
	postgres := build("postgres")
	if !strings.Contains(postgres.CreateTableSQL, `"REMARK" varchar(120)`) {
		t.Errorf("postgres DDL must keep varchar(120):\n%s", postgres.CreateTableSQL)
	}
	if strings.Contains(strings.Join(postgres.Warnings, "\n"), "放宽为") {
		t.Errorf("postgres plan must not warn about widening, warnings=%v", postgres.Warnings)
	}
}

func TestMySQLAndPGLikeSourcesToOpenGaussWidenCharColumns(t *testing.T) {
	t.Parallel()

	cases := []struct {
		source string
		colTyp string
		want   string
	}{
		{"mysql", "varchar(64)", "varchar(256)"},
		// PG 系同族写法原样保留类型名，只放宽长度。
		{"postgres", "character varying(64)", "character varying(256)"},
		{"kingbase", "varchar(64)", "varchar(256)"},
	}
	for _, tc := range cases {
		config := SyncConfig{
			SourceConfig:        connection.ConnectionConfig{Type: tc.source},
			TargetConfig:        connection.ConnectionConfig{Type: "opengauss"},
			TargetTableStrategy: "smart",
			SourceDatabase:      "db",
			TargetDatabase:      "db",
		}
		orderCols := []connection.ColumnDefinition{
			{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
			{Name: "name", Type: tc.colTyp, Nullable: "YES"},
		}
		// PG 系源默认 schema 是 public，MySQL 系源用库名。
		sourceDB := &fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
			"db.orders":     orderCols,
			"public.orders": orderCols,
		}}
		plan, _, _, err := buildSchemaMigrationPlan(config, "orders", sourceDB, &fakeMigrationDB{})
		if err != nil {
			t.Fatalf("%s plan error: %v", tc.source, err)
		}
		if !strings.Contains(plan.CreateTableSQL, tc.want) {
			t.Errorf("%s -> opengauss DDL missing %q:\n%s", tc.source, tc.want, plan.CreateTableSQL)
		}
	}
}

func TestSameFamilyOpenGaussKeepsCharLength(t *testing.T) {
	t.Parallel()

	config := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "vastbase"},
		TargetConfig:        connection.ConnectionConfig{Type: "opengauss"},
		TargetTableStrategy: "smart",
		SourceDatabase:      "db",
		TargetDatabase:      "db",
	}
	orderCols := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "character varying(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"db.orders":     orderCols,
		"public.orders": orderCols,
	}}
	plan, _, _, err := buildSchemaMigrationPlan(config, "orders", sourceDB, &fakeMigrationDB{})
	if err != nil {
		t.Fatalf("plan error: %v", err)
	}
	if !strings.Contains(plan.CreateTableSQL, "character varying(64)") {
		t.Errorf("same-family DDL must keep the source length:\n%s", plan.CreateTableSQL)
	}
}

func TestAddColumnWidensCharColumnForByteTargets(t *testing.T) {
	t.Parallel()

	col := connection.ColumnDefinition{Name: "REMARK", Type: "VARCHAR2(50)", Nullable: "YES"}
	sql, warnings, err := buildAddColumnSQLForPair("oracle", "vastbase", "public.t", col)
	if err != nil {
		t.Fatalf("add column: %v", err)
	}
	if !strings.Contains(sql, "varchar(200)") {
		t.Errorf("ADD COLUMN must widen the byte-counted target column: %s", sql)
	}
	if !strings.Contains(strings.Join(warnings, "\n"), "REMARK(50→200)") {
		t.Errorf("ADD COLUMN must explain the widening: %v", warnings)
	}

	sql, warnings, err = buildAddColumnSQLForPair("oracle", "postgres", "public.t", col)
	if err != nil {
		t.Fatalf("add column: %v", err)
	}
	if !strings.Contains(sql, "varchar(50)") || strings.Contains(strings.Join(warnings, "\n"), "放宽为") {
		t.Errorf("char-counted targets must keep the source length: sql=%s warnings=%v", sql, warnings)
	}
}

func TestByteLengthOverflowHint(t *testing.T) {
	t.Parallel()

	pqErr := errors.New("数据批次失败: 插入失败: pq: 对于可变字符类型(120)来说，值太长了 (22001)")
	if !isValueTooLongError(pqErr) {
		t.Fatal("22001 write failures must be recognised")
	}
	if !isValueTooLongError(errors.New("ERROR: value too long for type character varying(10)")) {
		t.Fatal("PG English message must be recognised")
	}
	if isValueTooLongError(errors.New("duplicate key value violates unique constraint")) || isValueTooLongError(nil) {
		t.Fatal("unrelated errors must not be flagged")
	}

	hint := byteLengthOverflowHint("vastbase", pqErr)
	if hint == "" || !strings.Contains(hint, "vastbase") {
		t.Fatalf("byte-counted targets need an actionable hint, got %q", hint)
	}
	if got := byteLengthOverflowHint("postgres", pqErr); got != "" {
		t.Errorf("character-counted targets must not get the byte hint, got %q", got)
	}
	if got := byteLengthOverflowHint("vastbase", errors.New("connection reset")); got != "" {
		t.Errorf("unrelated failures must not get the hint, got %q", got)
	}
}

type failingBatchApplier struct{ err error }

func (f failingBatchApplier) ApplyChanges(string, connection.ChangeSet) error { return f.err }

// 所有落库路径都经过 applySnapshotChanges：字节计长目标上的「值太长」必须带上可操作提示，
// 同时保持原始错误可被 errors.Is 识别，不能因为加提示而吞掉错误链。
func TestApplySnapshotChangesAddsByteLengthHintAndKeepsErrorChain(t *testing.T) {
	cause := errors.New("插入失败: pq: 对于可变字符类型(120)来说，值太长了 (22001)")
	engine := NewSyncEngine(Reporter{})
	changes := connection.ChangeSet{Inserts: []map[string]interface{}{{"id": 1}}}

	config := SyncConfig{TargetConfig: connection.ConnectionConfig{Type: "vastbase"}}
	_, err := engine.applySnapshotChanges(config, &SyncResult{}, "src", "dst", failingBatchApplier{err: cause}, changes, 0)
	if err == nil {
		t.Fatal("expected the apply failure to be returned")
	}
	if !errors.Is(err, cause) {
		t.Errorf("error chain must be preserved, got %v", err)
	}
	if !strings.Contains(err.Error(), "22001") || !strings.Contains(err.Error(), "vastbase") {
		t.Errorf("error must keep the original text and add the hint, got %q", err.Error())
	}

	config.TargetConfig.Type = "postgres"
	_, err = engine.applySnapshotChanges(config, &SyncResult{}, "src", "dst", failingBatchApplier{err: cause}, changes, 0)
	if err == nil || !errors.Is(err, cause) || strings.Contains(err.Error(), "提示") {
		t.Errorf("character-counted targets must not get the byte-length hint, got %v", err)
	}
}

func TestFindValueLengthOverflowsSeparatesByteOnlyFromRealOverflow(t *testing.T) {
	t.Parallel()

	cols := []connection.ColumnDefinition{
		{Name: "ID", Type: "bigint"},
		{Name: "REMARK", Type: "character varying(120)"},
		{Name: "CODE", Type: "character(4)"},
		{Name: "MEMO", Type: "text"},
	}
	// 50 个汉字 = 50 字符 / 150 字节：字符数没超 120，字节数超。
	cjk := strings.Repeat("汉", 50)
	changes := connection.ChangeSet{
		Inserts: []map[string]interface{}{
			{"ID": int64(1), "REMARK": cjk, "CODE": "ab", "MEMO": strings.Repeat("x", 9999)},
			{"ID": int64(2), "REMARK": "short"},
			// 130 个 ASCII：字符数与字节数都超 120，数据本身比列长。
			{"ID": int64(3), "CODE": "toolong"},
		},
		Updates: []connection.UpdateRow{
			{Keys: map[string]interface{}{"ID": int64(4)}, Values: map[string]interface{}{"REMARK": cjk + "字"}},
		},
	}

	findings := findValueLengthOverflows(cols, changes)
	if len(findings) != 2 {
		t.Fatalf("expected REMARK and CODE, got %+v", findings)
	}
	remark, code := findings[0], findings[1]
	if remark.Column != "REMARK" || remark.Limit != 120 || remark.MaxBytes != 153 || remark.MaxChars != 51 || remark.Rows != 2 {
		t.Errorf("unexpected REMARK finding: %+v", remark)
	}
	if remark.charsOverflow() {
		t.Errorf("REMARK is byte-only overflow, charsOverflow must be false: %+v", remark)
	}
	if code.Column != "CODE" || code.Limit != 4 || !code.charsOverflow() {
		t.Errorf("unexpected CODE finding: %+v", code)
	}
	if got := suggestedCharColumnLength(remark); got != 480 {
		t.Errorf("suggested length = %d, want 480", got)
	}
	if got := suggestedCharColumnLength(valueLengthFinding{Limit: 10, MaxBytes: 500}); got != 500 {
		t.Errorf("suggested length must fit the longest value, got %d", got)
	}
	if len(findValueLengthOverflows(nil, changes)) != 0 {
		t.Error("no target columns, no findings")
	}
}

// 「数据同步」入口的差异同步写入已存在的海量表失败时，提示要点出具体字段、最长字节/字符数和参考 ALTER。
func TestApplySnapshotChangesNamesTheOffendingColumnForByteTargets(t *testing.T) {
	cols := []connection.ColumnDefinition{
		{Name: "ID", Type: "bigint", Key: "PRI"},
		{Name: "REMARK", Type: "character varying(120)"},
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"HRP_CLOUD_SHOW.AES_AE_RECORD": cols,
	}}}
	cause := errors.New("插入失败: pq: 对于可变字符类型(120)来说，值太长了 (22001)")
	target.applyFunc = func(string, connection.ChangeSet) error { return cause }

	changes := connection.ChangeSet{Inserts: []map[string]interface{}{
		{"ID": int64(1), "REMARK": strings.Repeat("汉", 50)},
	}}
	config := SyncConfig{TargetConfig: connection.ConnectionConfig{Type: "vastbase"}}
	_, err := NewSyncEngine(Reporter{}).applySnapshotChanges(config, &SyncResult{}, "src", "HRP_CLOUD_SHOW.AES_AE_RECORD", target, changes, 0)
	if err == nil || !errors.Is(err, cause) {
		t.Fatalf("expected the wrapped apply failure, got %v", err)
	}
	for _, fragment := range []string{
		"REMARK", "character varying(120)", "150 字节", "50 字符", "1 行超出",
		`ALTER TABLE "HRP_CLOUD_SHOW"."AES_AE_RECORD" ALTER COLUMN "REMARK" TYPE varchar(480);`,
		// 字符数没超、字节数超：必须带上「目标按字节计长」的口径说明。
		"按字节计",
	} {
		if !strings.Contains(err.Error(), fragment) {
			t.Errorf("error missing %q:\n%s", fragment, err.Error())
		}
	}

	// 数据本身字符数就超过列长：不能再把原因归到字节计长上。
	overlong := connection.ChangeSet{Inserts: []map[string]interface{}{
		{"ID": int64(2), "REMARK": strings.Repeat("a", 130)},
	}}
	_, err = NewSyncEngine(Reporter{}).applySnapshotChanges(config, &SyncResult{}, "src", "HRP_CLOUD_SHOW.AES_AE_RECORD", target, overlong, 0)
	if err == nil || !strings.Contains(err.Error(), "REMARK") || strings.Contains(err.Error(), "按字节计") {
		t.Errorf("real overflow must name the column without the byte-count explanation, got %v", err)
	}
}
