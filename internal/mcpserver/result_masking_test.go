package mcpserver

import (
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/connection"
)

func TestMaskResultSetsMasksAliasesAndLeavesDatabaseRowsUntouched(t *testing.T) {
	original := []connection.ResultSetData{{
		StatementIndex: 1,
		Columns:        []string{"mobile", "email", "none"},
		Rows:           []map[string]interface{}{{"mobile": "13800138000", "email": []byte("abcdefghi"), "none": "visible"}},
	}}
	masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"PHONE"}, PartialMaskFields: []string{"email"}}, "mysql", "select u.phone as mobile, email, none from users u", original)
	row := masked[0].Rows[0]
	if row["mobile"] != "***********" || row["email"] != "abc***ghi" || row["none"] != "visible" {
		t.Fatalf("unexpected masked row: %#v", row)
	}
	if got := string(original[0].Rows[0]["email"].([]byte)); got != "abcdefghi" || original[0].Rows[0]["mobile"] != "13800138000" {
		t.Fatalf("original database row was mutated: %#v", original)
	}
}

func TestMaskResultSetsUsesFinalColumnForComplexExpressions(t *testing.T) {
	sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"contact"}, Rows: []map[string]interface{}{{"contact": "13800138000"}}}}
	phoneOnly := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}}, "mysql", "select concat(phone, '-') as contact from users", sets)
	if got := phoneOnly[0].Rows[0]["contact"]; got != "13800138000" {
		t.Fatalf("complex expression should not infer phone source, got %#v", got)
	}
	contact := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"contact"}}, "mysql", "select concat(phone, '-') as contact from users", sets)
	if got := contact[0].Rows[0]["contact"]; got != "***********" {
		t.Fatalf("final output column must mask complex expression, got %#v", got)
	}
}

func TestMaskResultSetsFullPrecedenceNilShortAndMultipleResults(t *testing.T) {
	sets := []connection.ResultSetData{
		{StatementIndex: 1, Columns: []string{"Phone"}, Rows: []map[string]interface{}{{"Phone": nil}, {"Phone": "123456"}}},
		{StatementIndex: 2, Columns: []string{"phone"}, Rows: []map[string]interface{}{{"phone": "123456789"}}},
	}
	masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}, PartialMaskFields: []string{"PHONE"}}, "mysql", "select phone from users; select phone from users", sets)
	got := []interface{}{masked[0].Rows[0]["Phone"], masked[0].Rows[1]["Phone"], masked[1].Rows[0]["phone"]}
	want := []interface{}{nil, "******", "*********"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("masked values = %#v, want %#v", got, want)
	}
}

func TestDirectSelectProjectionFieldsSupportsAliasesWithoutAS(t *testing.T) {
	got := directSelectProjectionFields("SELECT `u`.`phone` mobile, [email] AS mail FROM users u")
	want := map[string]string{"mobile": "phone", "mail": "email"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("projection fields = %#v, want %#v", got, want)
	}
}

func TestMaskResultSetsRecognizesSQLServerEqualsAlias(t *testing.T) {
	sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"mobile"}, Rows: []map[string]interface{}{{"mobile": "secret"}}}}
	masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}}, "sqlserver", "SELECT mobile = u.phone FROM users u", sets)
	if got := masked[0].Rows[0]["mobile"]; got != "******" {
		t.Fatalf("SQL Server equals alias leaked value: %#v", got)
	}
}

func TestMaskResultSetsUsesUnicodeCaseFold(t *testing.T) {
	sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"ς"}, Rows: []map[string]interface{}{{"ς": "secret"}}}}
	masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"Σ"}}, "postgres", `SELECT "ς" FROM users`, sets)
	if got := masked[0].Rows[0]["ς"]; got != "******" {
		t.Fatalf("Unicode case-equivalent field leaked value: %#v", got)
	}
}

func TestMaskResultSetsHonorsPostgresStandardBackslashQuoting(t *testing.T) {
	tests := []string{
		`SELECT 'a\' AS label, phone AS mobile FROM users`,
		`SELECT "a\" AS label, phone AS mobile FROM users`,
		`SELECT E'a\'b' AS label, phone AS mobile FROM users`,
	}
	for _, sqlText := range tests {
		sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"label", "mobile"}, Rows: []map[string]interface{}{{"label": "public", "mobile": "secret"}}}}
		masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}}, "postgres", sqlText, sets)
		if got := masked[0].Rows[0]["mobile"]; got != "******" {
			t.Fatalf("Postgres quoting caused leaked value for %q: %#v", sqlText, got)
		}
	}
}

func TestMaskResultSetsRecognizesCommentsHintsAndCTEs(t *testing.T) {
	tests := []struct {
		name   string
		dbType string
		sql    string
	}{
		{name: "leading comment", dbType: "mysql", sql: "/* trace */ SELECT u.phone AS mobile FROM users u"},
		{name: "projection comment", dbType: "mysql", sql: "SELECT u.phone /* comment */ AS mobile FROM users u"},
		{name: "oracle hint", dbType: "oracle", sql: "SELECT /*+ INDEX(u idx) */ u.phone AS mobile FROM users u"},
		{name: "mysql line comment", dbType: "mysql", sql: "# trace\nSELECT u.phone AS mobile FROM users u"},
		{name: "cte", dbType: "postgres", sql: "WITH active AS (SELECT phone FROM users) SELECT active.phone AS mobile FROM active"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"mobile"}, Rows: []map[string]interface{}{{"mobile": "13800138000"}}}}
			masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}}, tt.dbType, tt.sql, sets)
			if got := masked[0].Rows[0]["mobile"]; got != "***********" {
				t.Fatalf("comment/modifier query leaked value: %#v", got)
			}
		})
	}
}

func TestMaskResultSetsRecognizesQuotedIdentifiersAndSQLServerTop(t *testing.T) {
	tests := []struct {
		name   string
		dbType string
		sql    string
		field  string
	}{
		{name: "bracket space", dbType: "sqlserver", sql: "SELECT u.[phone number] AS mobile FROM users u", field: "phone number"},
		{name: "backtick space", dbType: "mysql", sql: "SELECT u.`phone number` AS mobile FROM users u", field: "phone number"},
		{name: "quoted dot", dbType: "postgres", sql: `SELECT u."phone.number" AS mobile FROM users u`, field: "phone.number"},
		{name: "top", dbType: "sqlserver", sql: "SELECT TOP (10) u.phone AS mobile FROM users u", field: "phone"},
		{name: "top percent ties", dbType: "sqlserver", sql: "SELECT DISTINCT TOP 10 PERCENT WITH TIES u.phone AS mobile FROM users u", field: "phone"},
		{name: "single quoted alias", dbType: "mysql", sql: "SELECT u.phone AS 'mobile' FROM users u", field: "phone"},
		{name: "single quoted alias without as", dbType: "mysql", sql: "SELECT u.phone 'mobile' FROM users u", field: "phone"},
		{name: "mysql-compatible modifier", dbType: "starrocks", sql: "SELECT SQL_NO_CACHE u.phone AS mobile FROM users u", field: "phone"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"mobile"}, Rows: []map[string]interface{}{{"mobile": "sensitive"}}}}
			masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{tt.field}}, tt.dbType, tt.sql, sets)
			if got := masked[0].Rows[0]["mobile"]; got != "*********" {
				t.Fatalf("quoted/modifier query leaked value: %#v", got)
			}
		})
	}
}

func TestMaskResultSetsMasksExplicitlyIndexedMultiResults(t *testing.T) {
	sets := []connection.ResultSetData{
		{StatementIndex: 1, Columns: []string{"first_mobile"}, Rows: []map[string]interface{}{{"first_mobile": "111"}}},
		{StatementIndex: 2, Columns: []string{"second_mobile"}, Rows: []map[string]interface{}{{"second_mobile": "2222"}}},
	}
	masked := maskResultSets(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"mysql",
		"SELECT phone AS first_mobile FROM users; SELECT phone AS second_mobile FROM users",
		sets,
	)
	if masked[0].Rows[0]["first_mobile"] != "***" || masked[1].Rows[0]["second_mobile"] != "****" {
		t.Fatalf("indexed multi-results leaked values: %#v", masked)
	}
}

func TestMaskResultSetsDoesNotGuessAmbiguousZeroIndexes(t *testing.T) {
	sets := []connection.ResultSetData{
		{Columns: []string{"procedure_value"}, Rows: []map[string]interface{}{{"procedure_value": "public"}}},
		{Columns: []string{"mobile"}, Rows: []map[string]interface{}{{"mobile": "secret"}}},
	}
	masked := maskResultSets(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"mysql",
		"CALL get_users(); SELECT phone AS mobile FROM users",
		sets,
	)
	if got := masked[1].Rows[0]["mobile"]; got != "secret" {
		t.Fatalf("ambiguous zero index was guessed: %#v", got)
	}
}

func TestMaskResultSetsMapsNoBackslashEscapeMultiStatements(t *testing.T) {
	sets := []connection.ResultSetData{
		{Columns: []string{"label", "mobile"}, Rows: []map[string]interface{}{{"label": "public", "mobile": "secret"}}},
		{Columns: []string{"mobile2"}, Rows: []map[string]interface{}{{"mobile2": "secret2"}}},
	}
	masked := maskResultSetsWithSQLMode(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"mysql",
		`SELECT 'a\' AS label, phone AS mobile FROM users; SELECT phone AS mobile2 FROM users`,
		sets,
		true,
	)
	if masked[0].Rows[0]["mobile"] != "******" || masked[1].Rows[0]["mobile2"] != "*******" {
		t.Fatalf("NO_BACKSLASH_ESCAPES multi-statement results leaked: %#v", masked)
	}
}

func TestMaskResultSetsMapsTruncatedNoBackslashEscapePrefix(t *testing.T) {
	sets := []connection.ResultSetData{{
		StatementIndex: 1,
		Columns:        []string{"label", "mobile"},
		Rows:           []map[string]interface{}{{"label": "public", "mobile": "secret"}},
		Truncated:      true,
	}}
	masked := maskResultSetsWithSQLMode(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"mysql",
		`SELECT 'a\' AS label, phone AS mobile FROM users; SELECT phone AS mobile2 FROM users`,
		sets,
		true,
	)
	if got := masked[0].Rows[0]["mobile"]; got != "******" {
		t.Fatalf("truncated NO_BACKSLASH_ESCAPES prefix leaked: %#v", masked)
	}
}

func TestMaskResultSetsUnionsAmbiguousMySQLSplitCandidates(t *testing.T) {
	sets := []connection.ResultSetData{{
		StatementIndex: 1,
		Columns:        []string{"label", "mobile"},
		Rows:           []map[string]interface{}{{"label": "public", "mobile": "secret"}},
	}}
	masked := maskResultSets(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"mysql",
		`SELECT 'a\' FROM fake; SELECT x \'' AS label, phone AS mobile FROM real`,
		sets,
	)
	if masked[0].Rows[0]["mobile"] != "******" || masked[0].Rows[0]["label"] != "public" {
		t.Fatalf("ambiguous MySQL split discarded the valid source mapping: %#v", masked)
	}
}

func TestMaskResultSetsDoesNotPositionallyMergeAmbiguousMySQLCandidate(t *testing.T) {
	sets := []connection.ResultSetData{
		{StatementIndex: 1, Columns: []string{"label", "mobile"}, Rows: []map[string]interface{}{{"label": "public", "mobile": "secret"}}},
		{StatementIndex: 2, Columns: []string{"public_col"}, Rows: []map[string]interface{}{{"public_col": "visible"}}},
	}
	masked := maskResultSets(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"mysql",
		`SELECT 'a\'; SELECT phone AS decoy FROM decoy; b' AS label, phone AS mobile FROM users; SELECT name AS public_col FROM users`,
		sets,
	)
	if masked[0].Rows[0]["mobile"] != "******" || masked[1].Rows[0]["public_col"] != "visible" {
		t.Fatalf("ambiguous MySQL candidate misattributed a source: %#v", masked)
	}
}

func TestMaskResultSetsDoesNotOverridePrimarySourceWithSameAliasCandidate(t *testing.T) {
	sets := []connection.ResultSetData{
		{StatementIndex: 1, Columns: []string{"label", "mobile"}, Rows: []map[string]interface{}{{"label": "public", "mobile": "secret"}}},
		{StatementIndex: 2, Columns: []string{"public_col"}, Rows: []map[string]interface{}{{"public_col": "visible"}}},
	}
	masked := maskResultSets(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"mysql",
		`SELECT 'a\' FROM first; SELECT phone AS public_col FROM decoy; b\'' AS label, phone AS mobile FROM users; SELECT name AS public_col FROM users`,
		sets,
	)
	if masked[0].Rows[0]["mobile"] != "******" || masked[1].Rows[0]["public_col"] != "visible" {
		t.Fatalf("secondary MySQL candidate overrode a proven primary source: %#v", masked)
	}
}

func TestMaskResultSetsUsesProjectionPositionForDuplicateColumns(t *testing.T) {
	sets := []connection.ResultSetData{{
		StatementIndex: 1,
		Columns:        []string{"mobile", "mobile_2"},
		Rows:           []map[string]interface{}{{"mobile": "111", "mobile_2": "2222"}},
	}}
	masked := maskResultSets(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"mysql",
		"SELECT phone AS mobile, phone AS mobile FROM users",
		sets,
	)
	if masked[0].Rows[0]["mobile"] != "***" || masked[0].Rows[0]["mobile_2"] != "****" {
		t.Fatalf("duplicate projection leaked values: %#v", masked)
	}
}

func TestMaskResultSetsKeepsCaseDistinctColumnSourcesSeparate(t *testing.T) {
	sets := []connection.ResultSetData{{
		StatementIndex: 1,
		Columns:        []string{"Mobile", "mobile"},
		Rows:           []map[string]interface{}{{"Mobile": "secret", "mobile": "public"}},
	}}
	masked := maskResultSets(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"postgres",
		`SELECT phone AS "Mobile", nickname AS "mobile" FROM users`,
		sets,
	)
	if masked[0].Rows[0]["Mobile"] != "******" || masked[0].Rows[0]["mobile"] != "public" {
		t.Fatalf("case-distinct sources were conflated: %#v", masked)
	}
}

func TestMaskResultSetsUsesExactAliasesWhenWildcardBreaksProjectionAlignment(t *testing.T) {
	sets := []connection.ResultSetData{{
		StatementIndex: 1,
		Columns:        []string{"id", "name", "Mobile", "mobile"},
		Rows:           []map[string]interface{}{{"id": 1, "name": "Alice", "Mobile": "secret", "mobile": "public"}},
	}}
	masked := maskResultSets(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"postgres",
		`SELECT u.*, u.phone AS "Mobile", u.nickname AS "mobile" FROM users u`,
		sets,
	)
	if masked[0].Rows[0]["Mobile"] != "******" || masked[0].Rows[0]["mobile"] != "public" {
		t.Fatalf("exact case-distinct aliases were not used in fallback: %#v", masked)
	}
}

func TestMaskResultSetsKeepsComplexProjectionPosition(t *testing.T) {
	sets := []connection.ResultSetData{{
		StatementIndex: 1,
		Columns:        []string{"label", "mobile"},
		Rows:           []map[string]interface{}{{"label": "public", "mobile": "13800138000"}},
	}}
	masked := maskResultSets(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"postgres",
		"SELECT $tag$from,comma$tag$ AS label, phone AS mobile FROM users",
		sets,
	)
	if masked[0].Rows[0]["label"] != "public" || masked[0].Rows[0]["mobile"] != "***********" {
		t.Fatalf("complex projection disturbed positional masking: %#v", masked)
	}
}

func TestMaskResultSetsDisabledKeepsRulesInactive(t *testing.T) {
	sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"phone"}, Rows: []map[string]interface{}{{"phone": "123456789"}}}}
	masked := maskResultSets(ai.ResultMaskingSettings{Enabled: false, FullMaskFields: []string{"phone"}}, "mysql", "SELECT phone FROM users", sets)
	if got := masked[0].Rows[0]["phone"]; got != "123456789" {
		t.Fatalf("disabled rules changed value: %#v", got)
	}
}

func TestMaskSQLValueDoesNotDropInvalidBytesBeforeMasking(t *testing.T) {
	if got := maskSQLValue([]byte{'A', 0xff, 'B'}, maskFull); got != "***" {
		t.Fatalf("invalid byte value mask = %q, want %q", got, "***")
	}
}

func TestMaskResultSetsDoesNotTreatIdentifierDollarAsDollarQuote(t *testing.T) {
	sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"mobile"}, Rows: []map[string]interface{}{{"mobile": "secret"}}}}
	masked := maskResultSets(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone$work$"}},
		"postgres",
		"SELECT u.phone$work$ AS mobile FROM users u",
		sets,
	)
	if got := masked[0].Rows[0]["mobile"]; got != "******" {
		t.Fatalf("dollar identifier leaked value: %#v", got)
	}
}

func TestMaskResultSetsLimitsDollarQuotesToPostgresFamily(t *testing.T) {
	sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"$tag$", "mobile"}, Rows: []map[string]interface{}{{"$tag$": "public", "mobile": "secret"}}}}
	masked := maskResultSets(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"mysql",
		"SELECT $tag$, phone AS mobile FROM users",
		sets,
	)
	if masked[0].Rows[0]["$tag$"] != "public" || masked[0].Rows[0]["mobile"] != "******" {
		t.Fatalf("MySQL dollar identifier disturbed projection masking: %#v", masked)
	}
}

func TestMaskResultSetsExpandsMySQLExecutableProjectionComments(t *testing.T) {
	tests := []struct {
		name   string
		dbType string
		sql    string
	}{
		{name: "mysql executable", dbType: "mysql", sql: "SELECT /*! u.phone AS mobile */ FROM users u"},
		{name: "mysql versioned executable", dbType: "mysql", sql: "SELECT /*!50100 u.phone AS mobile */ FROM users u"},
		{name: "mariadb executable", dbType: "mariadb", sql: "SELECT /*M! u.phone AS mobile */ FROM users u"},
		{name: "mariadb versioned executable", dbType: "mariadb", sql: "SELECT /*M!100100 u.phone AS mobile */ FROM users u"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"mobile"}, Rows: []map[string]interface{}{{"mobile": "secret"}}}}
			masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}}, tt.dbType, tt.sql, sets)
			if got := masked[0].Rows[0]["mobile"]; got != "******" {
				t.Fatalf("executable comment leaked value: %#v", got)
			}
		})
	}
}

func TestMaskResultSetsDoesNotExpandMariaDBExecutableCommentForMySQL(t *testing.T) {
	sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"mobile"}, Rows: []map[string]interface{}{{"mobile": "secret"}}}}
	masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}}, "mysql", "SELECT /*M! u.phone AS mobile */ 1 AS mobile FROM users u", sets)
	if got := masked[0].Rows[0]["mobile"]; got != "secret" {
		t.Fatalf("MariaDB-only executable comment was expanded for MySQL: %#v", got)
	}
}

func TestMaskResultSetsRecognizesMySQLSQLCacheModifier(t *testing.T) {
	sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"mobile"}, Rows: []map[string]interface{}{{"mobile": "secret"}}}}
	masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}}, "mariadb", "SELECT SQL_CACHE phone AS mobile FROM users", sets)
	if got := masked[0].Rows[0]["mobile"]; got != "******" {
		t.Fatalf("SQL_CACHE projection leaked value: %#v", got)
	}
}

func TestMaskResultSetsHonorsSQLServerBackslashAlias(t *testing.T) {
	sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{`mobile\`}, Rows: []map[string]interface{}{{`mobile\`: "secret"}}}}
	masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}}, "sqlserver", `SELECT phone AS 'mobile\' FROM users`, sets)
	if got := masked[0].Rows[0][`mobile\`]; got != "******" {
		t.Fatalf("SQL Server backslash alias leaked value: %#v", got)
	}
}

func TestMaskResultSetsHonorsOracleAlternativeQuotes(t *testing.T) {
	tests := []string{
		`SELECT q'[Bob's phone, from sales]' AS label, u.phone AS mobile FROM users u`,
		`SELECT nq'{Bob's phone, from sales}' AS label, u.phone AS mobile FROM users u`,
		`SELECT Q'!Bob's phone, from sales!' AS label, u.phone AS mobile FROM users u`,
		`SELECT q'§Bob's phone, from sales§' AS label, u.phone AS mobile FROM users u`,
	}
	for _, sqlText := range tests {
		sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"label", "mobile"}, Rows: []map[string]interface{}{{"label": "public", "mobile": "secret"}}}}
		masked := maskResultSets(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}}, "oracle", sqlText, sets)
		if got := masked[0].Rows[0]["mobile"]; got != "******" {
			t.Fatalf("Oracle alternative quote caused leaked value for %q: %#v", sqlText, got)
		}
	}
}

func TestMaskResultSetsHandlesBothMySQLBackslashModes(t *testing.T) {
	tests := []struct {
		sql         string
		noBackslash bool
	}{
		{sql: `SELECT 'a\'b' AS label, u.phone AS mobile FROM users u`},
		{sql: `SELECT 'a\' AS label, u.phone AS mobile FROM users u`, noBackslash: true},
	}
	for _, tt := range tests {
		sets := []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"label", "mobile"}, Rows: []map[string]interface{}{{"label": "public", "mobile": "secret"}}}}
		masked := maskResultSetsWithSQLMode(ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}}, "mysql", tt.sql, sets, tt.noBackslash)
		if got := masked[0].Rows[0]["mobile"]; got != "******" {
			t.Fatalf("MySQL backslash mode caused leaked value for %q: %#v", tt.sql, got)
		}
	}
}

func TestMaskResultSetsMapsDuplicateAliasesInNoBackslashMode(t *testing.T) {
	sets := []connection.ResultSetData{{
		StatementIndex: 1,
		Columns:        []string{"label", "mobile", "mobile_2"},
		Rows:           []map[string]interface{}{{"label": "public", "mobile": "secret", "mobile_2": "secret2"}},
	}}
	masked := maskResultSetsWithSQLMode(
		ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		"mysql",
		`SELECT 'a\' AS label, phone AS mobile, phone AS mobile FROM users`,
		sets,
		true,
	)
	if masked[0].Rows[0]["mobile"] != "******" || masked[0].Rows[0]["mobile_2"] != "*******" {
		t.Fatalf("NO_BACKSLASH_ESCAPES duplicate aliases leaked: %#v", masked)
	}
}

func TestStripSQLCommentsHonorsMySQLDashDashWhitespaceRule(t *testing.T) {
	got := stripSQLComments("mysql", "SELECT phone--not_comment AS mobile FROM users")
	if !strings.Contains(got, "--not_comment") {
		t.Fatalf("MySQL non-comment operator text was removed: %q", got)
	}
	got = stripSQLComments("mysql", "SELECT phone -- comment\n AS mobile FROM users")
	if strings.Contains(got, "comment") {
		t.Fatalf("MySQL line comment was not removed: %q", got)
	}
}
