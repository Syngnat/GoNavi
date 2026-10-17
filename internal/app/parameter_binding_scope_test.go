package app

import (
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/sqlparam"
)

const oracleTriggerDDL = `CREATE OR REPLACE TRIGGER trg_t
BEFORE INSERT OR UPDATE ON t
FOR EACH ROW
BEGIN
  IF :NEW.created_at IS NULL THEN
    :NEW.created_at := SYSDATE;
  END IF;
  IF :OLD.status <> :NEW.status THEN
    INSERT INTO log(old_s, new_s) VALUES(:OLD.status, :NEW.status);
  END IF;
END;`

func TestAnalyzeQueryParametersSkipsOracleStoredProgramDDL(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle"}

	analysis := app.AnalyzeQueryParameters(config, "", oracleTriggerDDL, true)
	if !analysis.Supported {
		t.Fatalf("oracle 应声明支持参数绑定")
	}
	if len(analysis.ParameterNames) != 0 {
		t.Fatalf("触发器 DDL 不应扫出参数，got %v", analysis.ParameterNames)
	}
	if len(analysis.Statements) != 1 || len(analysis.Statements[0].Parameters) != 0 {
		t.Fatalf("语句应原样保留且无参数，got %+v", analysis.Statements)
	}
}

func TestAnalyzeQueryParametersMixedScriptKeepsDMLParams(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle"}
	sql := oracleTriggerDDL + "\nSELECT * FROM t WHERE id = :id;"

	analysis := app.AnalyzeQueryParameters(config, "", sql, true)
	if !reflect.DeepEqual(analysis.ParameterNames, []string{"id"}) {
		t.Fatalf("混合脚本只应扫出 DML 的参数，got %v", analysis.ParameterNames)
	}
	if len(analysis.Statements) < 2 {
		t.Fatalf("应拆出至少两条语句，got %d", len(analysis.Statements))
	}
	if len(analysis.Statements[0].Parameters) != 0 {
		t.Fatalf("触发器语句不应有参数，got %v", analysis.Statements[0].Parameters)
	}
	if !strings.Contains(analysis.Statements[0].Text, ":NEW.created_at") {
		t.Fatalf("触发器语句应原样保留，got %q", analysis.Statements[0].Text)
	}
}

func TestAnalyzeQueryParametersDamengAndYashandbSkipDDL(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	for _, dbType := range []string{"dameng", "dm8", "yashandb"} {
		config := connection.ConnectionConfig{Type: dbType}
		analysis := app.AnalyzeQueryParameters(config, "", oracleTriggerDDL, true)
		if len(analysis.ParameterNames) != 0 {
			t.Fatalf("[%s] 触发器 DDL 不应扫出参数，got %v", dbType, analysis.ParameterNames)
		}
	}
}

func TestAnalyzeQueryParametersLeadingCommentBeforeDDL(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle"}
	sql := "-- 创建触发器\n" + oracleTriggerDDL

	analysis := app.AnalyzeQueryParameters(config, "", sql, true)
	if len(analysis.ParameterNames) != 0 {
		t.Fatalf("注释头的触发器 DDL 不应扫出参数，got %v", analysis.ParameterNames)
	}
}

// 审查发现：CREATE 与对象关键词之间夹注释时，前端掩码后能识别，Go 侧
// 只剥头部注释会漏——这里钉住「关键词间注释同样识别」的口径。
func TestAnalyzeQueryParametersMidKeywordCommentBeforeDDL(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle"}
	cases := []string{
		"CREATE /*x*/ TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN :NEW.a := 1; END;",
		"CREATE OR REPLACE /*c*/ TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN :NEW.a := 1; END;",
		"CREATE OR REPLACE\n-- header\nTRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN :NEW.a := 1; END;",
	}
	for _, sql := range cases {
		analysis := app.AnalyzeQueryParameters(config, "", sql, true)
		if len(analysis.ParameterNames) != 0 {
			t.Fatalf("关键词间夹注释的触发器 DDL 不应扫出参数，got %v\nSQL: %s", analysis.ParameterNames, sql)
		}
	}
}

// 审查建议：PACKAGE BODY、小写、DDL 夹在两条 DML 之间的场景。
func TestAnalyzeQueryParametersDDLRoutingExtraForms(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle"}

	packageBody := "CREATE OR REPLACE PACKAGE BODY pkg AS\nBEGIN\n  NULL;\n  v := :NEW.x;\nEND;"
	if analysis := app.AnalyzeQueryParameters(config, "", packageBody, true); len(analysis.ParameterNames) != 0 {
		t.Fatalf("PACKAGE BODY 不应扫出参数，got %v", analysis.ParameterNames)
	}

	lowercase := "create or replace trigger trg BEFORE INSERT ON t FOR EACH ROW BEGIN :NEW.a := 1; END;"
	if analysis := app.AnalyzeQueryParameters(config, "", lowercase, true); len(analysis.ParameterNames) != 0 {
		t.Fatalf("小写触发器 DDL 不应扫出参数，got %v", analysis.ParameterNames)
	}

	sandwich := "SELECT :a FROM dual;\n" + oracleTriggerDDL + "\nSELECT :b FROM dual;"
	analysis := app.AnalyzeQueryParameters(config, "", sandwich, true)
	if !reflect.DeepEqual(analysis.ParameterNames, []string{"a", "b"}) {
		t.Fatalf("夹心脚本应只扫出两条 DML 的参数，got %v", analysis.ParameterNames)
	}
}

func TestAnalyzeQueryParametersNonOracleDDLUnaffected(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver"}
	sql := "CREATE TRIGGER trg ON t FOR EACH ROW AS BEGIN SELECT :p AS v END;"

	analysis := app.AnalyzeQueryParameters(config, "", sql, true)
	if !reflect.DeepEqual(analysis.ParameterNames, []string{"p"}) {
		t.Fatalf("非 Oracle 方言行为不变，got %v", analysis.ParameterNames)
	}
}

func TestAnalyzeQueryParametersDDLInStringNotExcluded(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle"}
	sql := "SELECT 'CREATE TRIGGER fake' AS a, :id AS b FROM dual"

	analysis := app.AnalyzeQueryParameters(config, "", sql, true)
	if !reflect.DeepEqual(analysis.ParameterNames, []string{"id"}) {
		t.Fatalf("字符串里的 CREATE TRIGGER 不应触发排除，got %v", analysis.ParameterNames)
	}
}

func TestBindParameterizedStatementsKeepsOracleDDLRaw(t *testing.T) {
	values := map[string]sqlparam.TypedValue{
		"a": {Type: sqlparam.TypeString, Value: "x"},
	}
	stmts, err := bindParameterizedStatements(
		[]string{oracleTriggerDDL, "SELECT :a FROM dual"},
		"oracle", values, true,
	)
	if err != nil {
		t.Fatalf("bindParameterizedStatements: %v", err)
	}
	if len(stmts) != 2 {
		t.Fatalf("应产出两条语句，got %d", len(stmts))
	}
	if stmts[0].sql != oracleTriggerDDL || stmts[0].args != nil {
		t.Fatalf("触发器 DDL 应按原文执行且无绑定值，sql=%q args=%v", stmts[0].sql, stmts[0].args)
	}
	if stmts[1].sql != "SELECT :1 FROM dual" || len(stmts[1].args) != 1 {
		t.Fatalf("DML 应正常重写绑定，sql=%q args=%v", stmts[1].sql, stmts[1].args)
	}
}

func TestBindParameterizedStatementsMissingValueOnDMLOnly(t *testing.T) {
	// 触发器 DDL 不参与缺值检查：即使 DDL 里有冒号，缺值也只由 DML 触发。
	values := map[string]sqlparam.TypedValue{}
	if _, err := bindParameterizedStatements([]string{oracleTriggerDDL}, "oracle", values, true); err != nil {
		t.Fatalf("触发器 DDL 不应因缺值失败，got %v", err)
	}
	if _, err := bindParameterizedStatements([]string{"SELECT :a FROM dual"}, "oracle", values, true); err == nil {
		t.Fatalf("DML 缺值应返回错误")
	}
}
