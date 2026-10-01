package mysql

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/dbuser/dbusertest"
)

type probeFixture struct {
	sourceType    string
	version       string
	comment       string
	sqlMode       string
	plugins       []string
	defaultPlugin string
	policyRows    []map[string]any
}

func pluginRows(names ...string) []map[string]any {
	rows := make([]map[string]any, 0, len(names))
	for _, name := range names {
		rows = append(rows, dbusertest.Row("plugin_name", name))
	}
	return rows
}

func probeProfile(t *testing.T, fixture probeFixture) dbuser.ServerProfile {
	t.Helper()
	sqlMode := fixture.sqlMode
	if sqlMode == "" {
		sqlMode = "STRICT_TRANS_TABLES"
	}
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "SELECT VERSION()", Rows: []map[string]any{dbusertest.Row("version", fixture.version, "current_account", "root@%", "sql_mode", sqlMode)}},
		dbusertest.Response{Match: "@@version_comment", Rows: []map[string]any{dbusertest.Row("version_comment", fixture.comment)}},
		dbusertest.Response{Match: "information_schema.PLUGINS", Rows: pluginRows(fixture.plugins...)},
		dbusertest.Response{Match: "@@default_authentication_plugin", Rows: []map[string]any{dbusertest.Row("plugin", fixture.defaultPlugin)}},
		dbusertest.Response{Match: "SHOW VARIABLES LIKE", Rows: fixture.policyRows},
		dbusertest.Response{Match: "USER_PRIVILEGES", Rows: []map[string]any{dbusertest.Row("privilege_type", "CREATE USER", "is_grantable", "YES")}},
		dbusertest.Response{Match: "mysql.role_edges", Rows: nil},
	)
	profile, err := New().Probe(context.Background(), dbuser.Env{SQL: executor}, dbuser.Target{SourceType: fixture.sourceType})
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if err := dbuser.CheckDescriptorsAgainstContract(profile.Options); err != nil {
		t.Fatalf("contract drift: %v", err)
	}
	return profile
}

func mysql80() probeFixture {
	return probeFixture{sourceType: "mysql", version: "8.0.36-0ubuntu0.22.04.1", comment: "(Ubuntu)",
		plugins: []string{"caching_sha2_password", "mysql_native_password", "sha256_password"}, defaultPlugin: "caching_sha2_password"}
}

func mustPlan(t *testing.T, profile dbuser.ServerProfile, request dbuser.ChangeRequest) dbuser.Plan {
	t.Helper()
	plan, err := dbuser.BuildPlan(New(), profile, request)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	return plan
}

func assertStatements(t *testing.T, got []string, want []string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("statements mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestProbeFeatureMatrixAcrossVersions(t *testing.T) {
	cases := []struct {
		name      string
		fixture   probeFixture
		flavor    string
		enabled   []string
		disabled  []string
		hasOption []string
		noOption  []string
	}{
		{
			name:     "mysql 5.5",
			fixture:  probeFixture{sourceType: "mysql", version: "5.5.62-log", plugins: []string{"mysql_native_password"}},
			flavor:   flavorMySQL,
			enabled:  []string{featResourceLimits, featRequireSSL},
			disabled: []string{featAlterUser, featAccountLock, featRoles, featExpireNow, featPluginChoice},
			noOption: []string{dbuser.OptAccountLocked, dbuser.OptAuthPlugin, dbuser.OptPasswordExpirePolicy},
		},
		{
			name:      "mysql 5.7",
			fixture:   probeFixture{sourceType: "mysql", version: "5.7.44-log", plugins: []string{"mysql_native_password", "sha256_password"}},
			flavor:    flavorMySQL,
			enabled:   []string{featAlterUser, featAccountLock, featPasswordExpire, featPluginChoice},
			disabled:  []string{featRoles, featFailedLogin, featComment},
			hasOption: []string{dbuser.OptAccountLocked, dbuser.OptAuthPlugin, dbuser.OptPasswordExpirePolicy},
			noOption:  []string{dbuser.OptFailedLoginAttempts, dbuser.OptDefaultRoles},
		},
		{
			name:      "mysql 8.0.36",
			fixture:   mysql80(),
			flavor:    flavorMySQL,
			enabled:   []string{featRoles, featDualPassword, featFailedLogin, featComment, featRequireCurrent},
			hasOption: []string{dbuser.OptFailedLoginAttempts, dbuser.OptComment, dbuser.OptDefaultRoles, dbuser.OptPasswordHistory},
		},
		{
			name:     "mariadb 10.3 via replication prefix",
			fixture:  probeFixture{sourceType: "mysql", version: "5.5.5-10.3.39-MariaDB-0+deb10u1", plugins: []string{"mysql_native_password"}},
			flavor:   flavorMariaDB,
			enabled:  []string{featAlterUser, featRoles, featSingleDefaultRole},
			disabled: []string{featAccountLock, featRoleHost, featMariaDBVia},
			noOption: []string{dbuser.OptAccountLocked, dbuser.OptAuthPlugin},
		},
		{
			name:      "mariadb 10.11",
			fixture:   probeFixture{sourceType: "mariadb", version: "10.11.6-MariaDB-log", plugins: []string{"mysql_native_password", "ed25519"}},
			flavor:    flavorMariaDB,
			enabled:   []string{featAccountLock, featPasswordExpire, featMariaDBVia},
			hasOption: []string{dbuser.OptAccountLocked, dbuser.OptAuthPlugin},
		},
		{
			name:     "oceanbase",
			fixture:  probeFixture{sourceType: "oceanbase", version: "5.7.25-OceanBase_CE-v4.2.1.2", plugins: nil},
			flavor:   flavorOceanBase,
			enabled:  []string{featAlterUser, featAccountLock},
			disabled: []string{featPluginChoice, featResourceLimits},
		},
		{
			name:    "tidb",
			fixture: probeFixture{sourceType: "mysql", version: "8.0.11-TiDB-v7.5.0", plugins: []string{"mysql_native_password", "caching_sha2_password", "tidb_sm3_password"}},
			flavor:  flavorTiDB,
			enabled: []string{featRoles, featPluginChoice},
		},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			profile := probeProfile(t, tt.fixture)
			if profile.Flavor != tt.flavor {
				t.Fatalf("flavor %s want %s", profile.Flavor, tt.flavor)
			}
			for _, feature := range tt.enabled {
				if !profile.Feature(feature) {
					t.Errorf("feature %s should be enabled", feature)
				}
			}
			for _, feature := range tt.disabled {
				if profile.Feature(feature) {
					t.Errorf("feature %s should be disabled", feature)
				}
			}
			for _, id := range tt.hasOption {
				if _, ok := profile.Option(id); !ok {
					t.Errorf("option %s should exist", id)
				}
			}
			for _, id := range tt.noOption {
				if _, ok := profile.Option(id); ok {
					t.Errorf("option %s should not exist", id)
				}
			}
		})
	}
}

func TestProbeMySQL84HidesNativePluginWhenNotLoaded(t *testing.T) {
	profile := probeProfile(t, probeFixture{sourceType: "mysql", version: "8.4.2", plugins: []string{"caching_sha2_password"}, defaultPlugin: "caching_sha2_password"})
	option, ok := profile.Option(dbuser.OptAuthPlugin)
	if !ok || len(option.Choices) != 1 || option.Choices[0].Value != "caching_sha2_password" {
		t.Fatalf("unexpected plugin choices: %+v", option.Choices)
	}
	if option.Default != "caching_sha2_password" {
		t.Fatalf("default plugin %q", option.Default)
	}
	found := false
	for _, notice := range profile.Notices {
		found = found || notice.Code == noticeNativeUnavailable
	}
	if !found {
		t.Fatal("expected native-unavailable notice on 8.4")
	}
}

func TestProbePasswordPolicyFromValidatePassword(t *testing.T) {
	fixture := mysql80()
	fixture.policyRows = []map[string]any{
		dbusertest.Row("Variable_name", "validate_password.length", "Value", "12"),
		dbusertest.Row("Variable_name", "validate_password.policy", "Value", "MEDIUM"),
		dbusertest.Row("Variable_name", "validate_password.mixed_case_count", "Value", "1"),
		dbusertest.Row("Variable_name", "validate_password.number_count", "Value", "1"),
		dbusertest.Row("Variable_name", "validate_password.special_char_count", "Value", "1"),
		dbusertest.Row("Variable_name", "validate_password.check_user_name", "Value", "ON"),
	}
	policy := probeProfile(t, fixture).PasswordPolicy
	want := dbuser.PasswordPolicy{MinLength: 12, RequireUpper: true, RequireLower: true, RequireDigit: true, RequireSpecial: true, DisallowUsername: true, Source: "validate_password"}
	if policy != want {
		t.Fatalf("policy %+v want %+v", policy, want)
	}
}

func TestPlanCreateUserMySQL80(t *testing.T) {
	profile := probeProfile(t, mysql80())
	plan := mustPlan(t, profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app", Host: "%"},
		Password: &dbuser.PasswordChange{Set: true, Password: `Pa'ss\w0rd!`},
		Options: map[string]string{
			dbuser.OptAuthPlugin:           "caching_sha2_password",
			dbuser.OptRequireSSL:           sslAny,
			dbuser.OptMaxQueriesPerHour:    "100",
			dbuser.OptPasswordExpirePolicy: expireNever,
			dbuser.OptFailedLoginAttempts:  "3",
			dbuser.OptPasswordLockDays:     "-1",
			dbuser.OptAccountLocked:        "true",
			dbuser.OptComment:              "svc",
			dbuser.OptDefaultRoles:         "reader@%",
		},
		GrantsAdd: []dbuser.Grant{
			{Privilege: "select", Scope: dbuser.ScopeDatabase, Database: "sales"},
			{Privilege: "SELECT", Scope: dbuser.ScopeColumn, Database: "sales", Object: "customer", Column: "email"},
			{Privilege: "EXECUTE", Scope: dbuser.ScopeRoutine, Database: "sales", Object: "p1", ObjectType: "procedure"},
		},
		MembershipsAdd: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "reader", Host: "%"}}},
	})
	assertStatements(t, dbusertest.Displays(plan), []string{
		"CREATE USER `app`@`%` IDENTIFIED WITH caching_sha2_password BY '******' REQUIRE SSL WITH MAX_QUERIES_PER_HOUR 100 PASSWORD EXPIRE NEVER FAILED_LOGIN_ATTEMPTS 3 PASSWORD_LOCK_TIME UNBOUNDED ACCOUNT LOCK COMMENT 'svc'",
		"GRANT SELECT ON `sales`.* TO `app`@`%`",
		"GRANT SELECT (`email`) ON `sales`.`customer` TO `app`@`%`",
		"GRANT EXECUTE ON PROCEDURE `sales`.`p1` TO `app`@`%`",
		"GRANT `reader`@`%` TO `app`@`%`",
		"SET DEFAULT ROLE `reader`@`%` TO `app`@`%`",
	})
	if !strings.Contains(plan.Statements[0].Exec, `BY 'Pa''ss\\w0rd!'`) {
		t.Fatalf("exec must carry escaped password: %s", plan.Statements[0].Exec)
	}
	if plan.Fingerprint == "" || plan.Transactional {
		t.Fatalf("unexpected plan meta: %+v", plan)
	}
}

func TestPlanRespectsNoBackslashEscapes(t *testing.T) {
	fixture := mysql80()
	fixture.sqlMode = "STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES"
	profile := probeProfile(t, fixture)
	plan := mustPlan(t, profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionAlter,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app", Host: "%"},
		Password: &dbuser.PasswordChange{Set: true, Password: `a\b`},
	})
	assertStatements(t, dbusertest.Execs(plan), []string{"ALTER USER `app`@`%` IDENTIFIED BY 'a\\b'"})
}

func TestPlanLegacyMySQL55(t *testing.T) {
	profile := probeProfile(t, probeFixture{sourceType: "mysql", version: "5.5.62-log", plugins: []string{"mysql_native_password"}})
	plan := mustPlan(t, profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "old", Host: "localhost"},
		Password: &dbuser.PasswordChange{Set: true, Password: "secret"},
		Options:  map[string]string{dbuser.OptRequireSSL: sslAny, dbuser.OptMaxUserConnections: "5"},
	})
	assertStatements(t, dbusertest.Displays(plan), []string{
		"CREATE USER `old`@`localhost` IDENTIFIED BY '******'",
		"GRANT USAGE ON *.* TO `old`@`localhost` REQUIRE SSL WITH MAX_USER_CONNECTIONS 5",
	})
	alter := mustPlan(t, profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionAlter,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "old", Host: "localhost"},
		Password: &dbuser.PasswordChange{Set: true, Password: "secret"},
	})
	assertStatements(t, dbusertest.Displays(alter), []string{"SET PASSWORD FOR `old`@`localhost` = PASSWORD('******')"})
	_, err := dbuser.BuildPlan(New(), profile, dbuser.ChangeRequest{
		Action:  dbuser.ActionAlter,
		Target:  dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "old", Host: "localhost"},
		Options: map[string]string{dbuser.OptAccountLocked: "true"},
	})
	if domainErr, ok := dbuser.AsError(err); !ok || domainErr.Code != dbuser.ErrCodeUnknownOption {
		t.Fatalf("5.5 must reject account lock, got %v", err)
	}
}

func TestPlanMariaDB(t *testing.T) {
	profile := probeProfile(t, probeFixture{sourceType: "mariadb", version: "10.11.6-MariaDB-log", plugins: []string{"mysql_native_password", "ed25519"}})
	plan := mustPlan(t, profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "m", Host: "%"},
		Password: &dbuser.PasswordChange{Set: true, Password: "x1"},
		Options: map[string]string{
			dbuser.OptAuthPlugin:           "ed25519",
			dbuser.OptAccountLocked:        "false",
			dbuser.OptPasswordExpirePolicy: expireInterval,
			dbuser.OptPasswordLifetimeDays: "90",
			dbuser.OptDefaultRoles:         "analyst",
		},
		MembershipsAdd: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "analyst"}, AdminOption: true}},
	})
	assertStatements(t, dbusertest.Displays(plan), []string{
		"CREATE USER `m`@`%` IDENTIFIED VIA ed25519 USING PASSWORD('******') ACCOUNT UNLOCK PASSWORD EXPIRE INTERVAL 90 DAY",
		"GRANT `analyst` TO `m`@`%` WITH ADMIN OPTION",
		"SET DEFAULT ROLE `analyst` FOR `m`@`%`",
	})
	role := mustPlan(t, profile, dbuser.ChangeRequest{Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "analyst"}})
	assertStatements(t, dbusertest.Displays(role), []string{"CREATE ROLE `analyst`"})
}

func TestPlanAlterRenamePasswordRevokes(t *testing.T) {
	profile := probeProfile(t, mysql80())
	plan := mustPlan(t, profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionAlter,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app", Host: "%"},
		Rename:   &dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app2", Host: "10.0.%"},
		Password: &dbuser.PasswordChange{Set: true, Password: "N3w!pass", CurrentPassword: "0ld!pass", RetainCurrent: true},
		Options:  map[string]string{dbuser.OptPasswordHistory: "", dbuser.OptExpirePasswordNow: "true"},
		GrantsRevoke: []dbuser.Grant{
			{Privilege: "SELECT", Scope: dbuser.ScopeDatabase, Database: "sales", WithGrantOption: true},
			{Privilege: "UPDATE", Scope: dbuser.ScopeTable, Database: "sales", Object: "t"},
		},
		MembershipsRemove: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "reader", Host: "%"}}},
	})
	assertStatements(t, dbusertest.Displays(plan), []string{
		"RENAME USER `app`@`%` TO `app2`@`10.0.%`",
		"ALTER USER `app2`@`10.0.%` IDENTIFIED BY '******' REPLACE '******' RETAIN CURRENT PASSWORD",
		"ALTER USER `app2`@`10.0.%` PASSWORD HISTORY DEFAULT",
		"ALTER USER `app2`@`10.0.%` PASSWORD EXPIRE",
		"REVOKE GRANT OPTION ON `sales`.* FROM `app2`@`10.0.%`",
		"REVOKE UPDATE ON `sales`.`t` FROM `app2`@`10.0.%`",
		"REVOKE `reader`@`%` FROM `app2`@`10.0.%`",
	})
}

func TestPlanRejectsUnsafeInput(t *testing.T) {
	profile := probeProfile(t, mysql80())
	base := dbuser.ChangeRequest{Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app", Host: "%"}}
	cases := []struct {
		name   string
		mutate func(*dbuser.ChangeRequest)
		code   string
	}{
		{"privilege injection", func(r *dbuser.ChangeRequest) {
			r.GrantsAdd = []dbuser.Grant{{Privilege: "SELECT ON *.* TO x; DROP", Scope: dbuser.ScopeGlobal}}
		}, dbuser.ErrCodeInvalidPrivilege},
		{"privilege scope mismatch", func(r *dbuser.ChangeRequest) {
			r.GrantsAdd = []dbuser.Grant{{Privilege: "SUPER", Scope: dbuser.ScopeTable, Database: "d", Object: "t"}}
		}, dbuser.ErrCodeInvalidPrivilege},
		{"routine type", func(r *dbuser.ChangeRequest) {
			r.GrantsAdd = []dbuser.Grant{{Privilege: "EXECUTE", Scope: dbuser.ScopeRoutine, Database: "d", Object: "p", ObjectType: "TABLE"}}
		}, dbuser.ErrCodeInvalidObject},
		{"host injection", func(r *dbuser.ChangeRequest) { r.Target.Host = "% ; DROP" }, dbuser.ErrCodeInvalidHost},
		{"plugin change without password", func(r *dbuser.ChangeRequest) {
			r.Options = map[string]string{dbuser.OptAuthPlugin: "mysql_native_password"}
		}, dbuser.ErrCodePasswordRequired},
		{"unknown plugin", func(r *dbuser.ChangeRequest) {
			r.Options = map[string]string{dbuser.OptAuthPlugin: "auth_socket"}
			r.Password = &dbuser.PasswordChange{Set: true}
		}, dbuser.ErrCodeInvalidOption},
		{"drop system account", func(r *dbuser.ChangeRequest) {
			r.Action = dbuser.ActionDrop
			r.Target.Name = "mysql.sys"
		}, dbuser.ErrCodeReservedAccount},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			request := base
			tt.mutate(&request)
			_, err := dbuser.BuildPlan(New(), profile, request)
			domainErr, ok := dbuser.AsError(err)
			if !ok || domainErr.Code != tt.code {
				t.Fatalf("want %s got %v", tt.code, err)
			}
		})
	}
	quoted := mustPlan(t, profile, dbuser.ChangeRequest{Action: dbuser.ActionDrop, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "a`b", Host: "%"}})
	assertStatements(t, dbusertest.Displays(quoted), []string{"DROP USER `a``b`@`%`"})
}

func TestDescribeParsesStructuredSources(t *testing.T) {
	profile := probeProfile(t, mysql80())
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "FROM mysql.user WHERE", Rows: []map[string]any{dbusertest.Row(
			"User", "app", "Host", "%", "plugin", "caching_sha2_password", "account_locked", "Y", "password_expired", "N",
			"password_lifetime", float64(90), "max_questions", float64(10), "max_updates", float64(0), "max_connections", float64(0),
			"max_user_connections", float64(0), "ssl_type", "X509", "Password_reuse_history", nil, "Password_reuse_time", nil,
			"Password_require_current", "Y", "authentication_string", "hash",
			"User_attributes", `{"Password_locking":{"failed_login_attempts":3,"password_lock_time_days":2},"metadata":{"comment":"svc"}}`,
		)}},
		dbusertest.Response{Match: "USER_PRIVILEGES", Rows: []map[string]any{
			dbusertest.Row("privilege_type", "USAGE", "is_grantable", "NO"),
			dbusertest.Row("privilege_type", "PROCESS", "is_grantable", "YES"),
		}},
		dbusertest.Response{Match: "SCHEMA_PRIVILEGES", Rows: []map[string]any{dbusertest.Row("table_schema", "sales", "privilege_type", "SELECT", "is_grantable", "NO")}},
		dbusertest.Response{Match: "TABLE_PRIVILEGES", Rows: nil},
		dbusertest.Response{Match: "COLUMN_PRIVILEGES", Rows: nil},
		dbusertest.Response{Match: "mysql.procs_priv", Rows: []map[string]any{dbusertest.Row("db_name", "sales", "routine_name", "p1", "routine_type", "PROCEDURE", "proc_priv", "Execute,Grant")}},
		dbusertest.Response{Match: "FROM mysql.role_edges WHERE TO_USER", Rows: []map[string]any{dbusertest.Row("from_user", "reader", "from_host", "%", "admin_option", "N")}},
		dbusertest.Response{Match: "mysql.default_roles", Rows: []map[string]any{dbusertest.Row("role_user", "reader", "role_host", "%")}},
	)
	detail, err := New().Describe(context.Background(), dbuser.Env{SQL: executor}, profile, dbuser.DescribeQuery{Ref: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app", Host: "%"}})
	if err != nil {
		t.Fatal(err)
	}
	wantOptions := map[string]string{
		dbuser.OptAccountLocked:          "true",
		dbuser.OptPasswordExpirePolicy:   expireInterval,
		dbuser.OptPasswordLifetimeDays:   "90",
		dbuser.OptRequireSSL:             sslX509,
		dbuser.OptPasswordRequireCurrent: requireCurrentRequired,
		dbuser.OptFailedLoginAttempts:    "3",
		dbuser.OptPasswordLockDays:       "2",
		dbuser.OptComment:                "svc",
		dbuser.OptPasswordHistory:        "",
		dbuser.OptMaxQueriesPerHour:      "10",
		dbuser.OptDefaultRoles:           "reader@%",
	}
	for id, want := range wantOptions {
		if detail.Options[id] != want {
			t.Errorf("option %s = %q want %q", id, detail.Options[id], want)
		}
	}
	if len(detail.Grants) != 3 {
		t.Fatalf("grants: %+v", detail.Grants)
	}
	routine := detail.Grants[2]
	if routine.Scope != dbuser.ScopeRoutine || routine.Privilege != "EXECUTE" || !routine.WithGrantOption {
		t.Fatalf("routine grant: %+v", routine)
	}
	if len(detail.MemberOf) != 1 || detail.MemberOf[0].Role.Name != "reader" {
		t.Fatalf("memberships: %+v", detail.MemberOf)
	}
}

func TestListClassifiesRolesAndSystemAccounts(t *testing.T) {
	profile := probeProfile(t, mysql80())
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "SELECT * FROM mysql.user", Rows: []map[string]any{
			dbusertest.Row("User", "root", "Host", "%", "account_locked", "N", "password_expired", "N", "authentication_string", "x", "Super_priv", "Y"),
			dbusertest.Row("User", "mysql.sys", "Host", "localhost", "account_locked", "Y", "password_expired", "N", "authentication_string", "x"),
			dbusertest.Row("User", "r_new", "Host", "%", "account_locked", "Y", "password_expired", "Y", "authentication_string", ""),
			dbusertest.Row("User", "reader", "Host", "%", "account_locked", "N", "password_expired", "N", "authentication_string", "x"),
		}},
		dbusertest.Response{Match: "FROM mysql.role_edges", Rows: []map[string]any{dbusertest.Row("from_user", "reader", "from_host", "%")}},
	)
	principals, err := New().List(context.Background(), dbuser.Env{SQL: executor}, profile, dbuser.ListQuery{})
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]dbuser.PrincipalKind{}
	for _, principal := range principals {
		kinds[principal.Ref.Name] = principal.Ref.Kind
	}
	if kinds["root"] != dbuser.KindUser || kinds["r_new"] != dbuser.KindRole || kinds["reader"] != dbuser.KindRole {
		t.Fatalf("kinds: %+v", kinds)
	}
	if !principals[1].System || !principals[0].Current || !principals[0].Superuser {
		t.Fatalf("flags: %+v", principals[:2])
	}
}

func TestRedactAccountDDL(t *testing.T) {
	text := "CREATE USER `a`@`%` IDENTIFIED WITH 'caching_sha2_password' AS '$A$005$abc' REQUIRE NONE;\n" +
		"GRANT USAGE ON *.* TO 'b'@'%' IDENTIFIED BY PASSWORD '*6BB4837EB74329105EE4568DDA7DC67ED2CA2AD9';\n" +
		"CREATE USER `c`@`%` IDENTIFIED WITH 'caching_sha2_password' AS 0x2441243030352"
	redacted := RedactAccountDDL(text)
	for _, leak := range []string{"$A$005", "*6BB48", "0x2441"} {
		if strings.Contains(redacted, leak) {
			t.Fatalf("hash leaked (%s): %s", leak, redacted)
		}
	}
}
