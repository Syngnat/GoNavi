package app

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/dbuser/dbusertest"
	"GoNavi-Wails/internal/sqlaudit"
)

// fakeUserMgmtDB 复用 fakeCreateDatabaseDB 的元数据桩，只替换 Query/Exec。
type fakeUserMgmtDB struct {
	*fakeCreateDatabaseDB
	responses []dbusertest.Response
	execs     []string
	execErr   map[string]string
}

func (f *fakeUserMgmtDB) Query(query string) ([]map[string]interface{}, []string, error) {
	for _, response := range f.responses {
		if strings.Contains(query, response.Match) {
			return response.Rows, nil, response.Err
		}
	}
	return nil, nil, errors.New("not scripted")
}

func (f *fakeUserMgmtDB) Exec(query string) (int64, error) {
	f.execs = append(f.execs, query)
	for match, message := range f.execErr {
		if strings.Contains(query, match) {
			return 0, errors.New(message)
		}
	}
	return 0, nil
}

func newFakeMySQLUserMgmtDB() *fakeUserMgmtDB {
	return &fakeUserMgmtDB{
		fakeCreateDatabaseDB: &fakeCreateDatabaseDB{},
		execErr:              map[string]string{},
		responses: []dbusertest.Response{
			{Match: "SELECT VERSION()", Rows: []map[string]any{dbusertest.Row("version", "8.0.36", "current_account", "root@%", "sql_mode", "")}},
			{Match: "@@version_comment", Rows: []map[string]any{dbusertest.Row("version_comment", "MySQL Community Server")}},
			{Match: "information_schema.PLUGINS", Rows: []map[string]any{dbusertest.Row("plugin_name", "caching_sha2_password"), dbusertest.Row("plugin_name", "mysql_native_password")}},
			{Match: "@@default_authentication_plugin", Rows: []map[string]any{dbusertest.Row("plugin", "caching_sha2_password")}},
			{Match: "USER_PRIVILEGES", Rows: []map[string]any{dbusertest.Row("privilege_type", "CREATE USER", "is_grantable", "YES")}},
			{Match: "SELECT * FROM mysql.user", Rows: []map[string]any{dbusertest.Row("User", "root", "Host", "%", "account_locked", "N")}},
		},
	}
}

func installFakeUserMgmtDB(t *testing.T, fake *fakeUserMgmtDB) {
	t.Helper()
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	newDatabaseFunc = func(string) (db.Database, error) { return fake, nil }
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) { return raw, nil }
}

func userMgmtMySQLConfig() connection.ConnectionConfig {
	return connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}
}

const userMgmtTestPassword = "Sup3r'Secret\\pw"

func createUserRequest(password string) dbuser.ChangeRequest {
	return dbuser.ChangeRequest{
		Action:    dbuser.ActionCreate,
		Target:    dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app", Host: "%"},
		Password:  &dbuser.PasswordChange{Set: true, Password: password},
		GrantsAdd: []dbuser.Grant{{Privilege: "SELECT", Scope: dbuser.ScopeDatabase, Database: "sales"}},
	}
}

func previewFingerprint(t *testing.T, app *App, config connection.ConnectionConfig, request dbuser.ChangeRequest) string {
	t.Helper()
	result := app.UserMgmtPreview(config, request)
	if !result.Success {
		t.Fatalf("preview failed: %s", result.Message)
	}
	plan, ok := result.Data.(dbuser.Plan)
	if !ok {
		t.Fatalf("preview data type %T", result.Data)
	}
	for _, statement := range plan.Statements {
		if strings.Contains(statement.Display, "Sup3r") {
			t.Fatalf("preview leaked password: %s", statement.Display)
		}
	}
	return plan.Fingerprint
}

func TestUserMgmtRejectsCustomAndUnsupportedSources(t *testing.T) {
	app := newSQLAuditTestApp(t)
	for _, config := range []connection.ConnectionConfig{
		{Type: "custom", Driver: "mysql"},
		{Type: "sqlite"},
		{Type: "trino"},
	} {
		result := app.UserMgmtOverview(config, dbuser.ListQuery{})
		if result.Success {
			t.Fatalf("%s/%s must be unsupported", config.Type, config.Driver)
		}
	}
}

func TestUserMgmtOverviewReturnsProfileAndPrincipals(t *testing.T) {
	installFakeUserMgmtDB(t, newFakeMySQLUserMgmtDB())
	app := newSQLAuditTestApp(t)
	result := app.UserMgmtOverview(userMgmtMySQLConfig(), dbuser.ListQuery{})
	if !result.Success {
		t.Fatalf("overview failed: %s", result.Message)
	}
	overview := result.Data.(UserMgmtOverview)
	if overview.Profile.Family != dbuser.FamilyMySQL || len(overview.Principals) != 1 || !overview.Principals[0].Current {
		t.Fatalf("unexpected overview: %+v", overview)
	}
	for _, notice := range overview.Profile.Notices {
		if notice.Text == "" || notice.Text == userMgmtNoticeKey(notice.Code) {
			t.Fatalf("notice %s not localized: %q", notice.Code, notice.Text)
		}
	}
}

func TestUserMgmtApplyExecutesWithoutLeakingPassword(t *testing.T) {
	fake := newFakeMySQLUserMgmtDB()
	installFakeUserMgmtDB(t, fake)
	app := newSQLAuditTestApp(t)
	config := userMgmtMySQLConfig()
	fingerprint := previewFingerprint(t, app, config, createUserRequest(""))

	result := app.UserMgmtApply(config, createUserRequest(userMgmtTestPassword), fingerprint)
	if !result.Success || result.ExecutedCount != 2 {
		t.Fatalf("apply failed: %+v", result)
	}
	if len(fake.execs) != 2 || !strings.Contains(fake.execs[0], `'Sup3r''Secret\\pw'`) {
		t.Fatalf("unexpected executed statements: %q", fake.execs)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Source: userMgmtAuditSource})
	if len(events) != 1 {
		t.Fatalf("audit events = %d", len(events))
	}
	if strings.Contains(events[0].SQLText, "Sup3r") || events[0].StatementCount != 2 {
		t.Fatalf("audit leaked or miscounted: %+v", events[0])
	}
}

func TestUserMgmtApplyRejectsFingerprintMismatchAndMissingPassword(t *testing.T) {
	fake := newFakeMySQLUserMgmtDB()
	installFakeUserMgmtDB(t, fake)
	app := newSQLAuditTestApp(t)
	config := userMgmtMySQLConfig()

	if result := app.UserMgmtApply(config, createUserRequest(userMgmtTestPassword), "stale"); result.Success {
		t.Fatal("stale fingerprint must be rejected")
	}
	fingerprint := previewFingerprint(t, app, config, createUserRequest(""))
	if result := app.UserMgmtApply(config, createUserRequest(""), fingerprint); result.Success {
		t.Fatal("apply without password must be rejected")
	}
	if len(fake.execs) != 0 {
		t.Fatalf("nothing must execute: %q", fake.execs)
	}
}

func TestUserMgmtApplyBlockedByStructureProtection(t *testing.T) {
	fake := newFakeMySQLUserMgmtDB()
	installFakeUserMgmtDB(t, fake)
	app := newSQLAuditTestApp(t)
	config := userMgmtMySQLConfig()
	config.Protection.RestrictStructureEdit = true

	if result := app.UserMgmtPreview(config, createUserRequest("")); result.Success {
		t.Fatal("preview must be blocked on protected connection")
	}
	if result := app.UserMgmtApply(config, createUserRequest(userMgmtTestPassword), "any"); result.Success {
		t.Fatal("apply must be blocked on protected connection")
	}
	overview := app.UserMgmtOverview(config, dbuser.ListQuery{})
	if !overview.Success || !overview.Data.(UserMgmtOverview).Profile.ReadOnly {
		t.Fatalf("overview must stay readable but read-only: %+v", overview)
	}
	if len(fake.execs) != 0 {
		t.Fatalf("protected connection executed: %q", fake.execs)
	}
}

func TestUserMgmtApplyPartialFailureIsSanitized(t *testing.T) {
	fake := newFakeMySQLUserMgmtDB()
	fake.execErr["GRANT"] = "Error 1064: near 'Sup3r''Secret\\\\pw' at line 1"
	installFakeUserMgmtDB(t, fake)
	app := newSQLAuditTestApp(t)
	config := userMgmtMySQLConfig()
	fingerprint := previewFingerprint(t, app, config, createUserRequest(""))

	result := app.UserMgmtApply(config, createUserRequest(userMgmtTestPassword), fingerprint)
	if result.Success || result.FailedIndex != 2 || result.ExecutedCount != 1 || !result.Partial {
		t.Fatalf("unexpected partial result: %+v", result)
	}
	if strings.Contains(result.Message, "Sup3r") {
		t.Fatalf("message leaked password: %s", result.Message)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Source: userMgmtAuditSource})
	if len(events) != 1 || strings.Contains(events[0].Error, "Sup3r") || strings.Contains(events[0].SQLText, "Sup3r") {
		t.Fatalf("audit leaked password: %+v", events)
	}
}
