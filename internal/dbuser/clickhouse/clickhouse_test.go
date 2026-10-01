package clickhouse

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/dbuser/dbusertest"
)

func probe(t *testing.T, version string, rbac bool) dbuser.ServerProfile {
	t.Helper()
	users := dbusertest.Response{Match: "FROM system.users LIMIT 1", Rows: []map[string]any{}}
	if !rbac {
		users.Err = dbusertest.ErrNotScripted
	}
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "SELECT version()", Rows: []map[string]any{dbusertest.Row("version", version, "current_user_name", "default")}},
		users,
		dbusertest.Response{Match: "system.clusters", Rows: []map[string]any{dbusertest.Row("cluster", "main")}},
		dbusertest.Response{Match: "system.settings_profiles", Rows: []map[string]any{dbusertest.Row("name", "readonly")}},
		dbusertest.Response{Match: "SHOW PRIVILEGES", Rows: []map[string]any{
			dbusertest.Row("privilege", "SELECT", "level", "COLUMN"),
			dbusertest.Row("privilege", "CREATE TABLE", "level", "DATABASE"),
			dbusertest.Row("privilege", "SYSTEM RELOAD", "level", "GLOBAL"),
		}},
	)
	profile, err := New().Probe(context.Background(), dbuser.Env{SQL: executor}, dbuser.Target{})
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if err := dbuser.CheckDescriptorsAgainstContract(profile.Options); err != nil {
		t.Fatalf("contract drift: %v", err)
	}
	return profile
}

func displays(t *testing.T, profile dbuser.ServerProfile, request dbuser.ChangeRequest) []string {
	t.Helper()
	plan, err := dbuser.BuildPlan(New(), profile, request)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	return dbusertest.Displays(plan)
}

func TestProbeRBACAndVersionGates(t *testing.T) {
	old := probe(t, "20.3.21.2", false)
	if old.Supported || old.UnsupportedReason == nil || old.UnsupportedReason.Code != noticeNoRBAC {
		t.Fatalf("pre-RBAC server must be unsupported: %+v", old)
	}
	v22 := probe(t, "22.8.5.29", true)
	auth, _ := v22.Option(dbuser.OptAuthType)
	for _, choice := range auth.Choices {
		if choice.Value == "bcrypt_password" {
			t.Fatal("bcrypt must not be offered before 24.1")
		}
	}
	if _, ok := v22.Option(dbuser.OptValidUntil); ok {
		t.Fatal("VALID UNTIL must not be offered before 23.9")
	}
	v24 := probe(t, "24.3.2.23", true)
	auth, _ = v24.Option(dbuser.OptAuthType)
	if auth.Choices[0].Value != "bcrypt_password" {
		t.Fatalf("24.x auth choices: %+v", auth.Choices)
	}
	if _, ok := v24.Option(dbuser.OptOnCluster); !ok {
		t.Fatal("clusters must expose ON CLUSTER option")
	}
	if !reflect.DeepEqual(v24.Privileges[0].Scopes, []string{dbuser.ScopeGlobal, dbuser.ScopeDatabase, dbuser.ScopeTable, dbuser.ScopeColumn}) {
		t.Fatalf("SELECT scopes: %+v", v24.Privileges[0])
	}
}

func TestPlanUsersRolesAndGrants(t *testing.T) {
	profile := probe(t, "24.3.2.23", true)
	got := displays(t, profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"},
		Password: &dbuser.PasswordChange{Set: true, Password: `p'a\ss`},
		Options: map[string]string{dbuser.OptAuthType: "sha256_password", dbuser.OptHosts: "IP 10.0.0.0/8\nLIKE %.corp", dbuser.OptDefaultDatabase: "logs",
			dbuser.OptSettingsProfile: "readonly", dbuser.OptOnCluster: "main", dbuser.OptDefaultRoles: "reader"},
		GrantsAdd: []dbuser.Grant{
			{Privilege: "SELECT", Scope: dbuser.ScopeColumn, Database: "logs", Object: "events", Column: "ts"},
			{Privilege: "CREATE TABLE", Scope: dbuser.ScopeDatabase, Database: "logs"},
		},
		MembershipsAdd: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "reader"}}},
	})
	want := []string{
		"CREATE USER `etl` ON CLUSTER `main` IDENTIFIED WITH sha256_password BY '******' HOST IP '10.0.0.0/8', LIKE '%.corp' DEFAULT DATABASE `logs` SETTINGS PROFILE 'readonly'",
		"GRANT ON CLUSTER `main` SELECT(`ts`) ON `logs`.`events` TO `etl`",
		"GRANT ON CLUSTER `main` CREATE TABLE ON `logs`.* TO `etl`",
		"GRANT ON CLUSTER `main` `reader` TO `etl`",
		"ALTER USER `etl` ON CLUSTER `main` DEFAULT ROLE `reader`",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("create plan\n got: %q\nwant: %q", got, want)
	}
	plan, _ := dbuser.BuildPlan(New(), profile, dbuser.ChangeRequest{
		Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"},
		Password: &dbuser.PasswordChange{Set: true, Password: `p'a\ss`},
	})
	if plan.Statements[0].Exec != "ALTER USER `etl` IDENTIFIED WITH sha256_password BY 'p\\'a\\\\ss'" {
		t.Fatalf("exec escaping: %s", plan.Statements[0].Exec)
	}
	noPass := displays(t, profile, dbuser.ChangeRequest{Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"}, Options: map[string]string{dbuser.OptAuthType: "no_password", dbuser.OptHosts: ""}})
	if !reflect.DeepEqual(noPass, []string{"ALTER USER `etl` NOT IDENTIFIED HOST ANY"}) {
		t.Fatalf("no_password plan: %q", noPass)
	}
	for name, request := range map[string]dbuser.ChangeRequest{
		"host injection":             {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"}, Options: map[string]string{dbuser.OptHosts: "ANY; DROP USER x"}},
		"auth change needs password": {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"}, Options: map[string]string{dbuser.OptAuthType: "sha256_password"}},
		"drop default":               {Action: dbuser.ActionDrop, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "default"}},
	} {
		if _, err := dbuser.BuildPlan(New(), profile, request); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestListAndDescribeHandleConfigUsersAndArrays(t *testing.T) {
	profile := probe(t, "24.3.2.23", true)
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "SELECT * FROM system.users ORDER BY", Rows: []map[string]any{
			dbusertest.Row("name", "default", "storage", "users.xml", "auth_type", "no_password"),
			dbusertest.Row("name", "etl", "storage", "local directory", "auth_type", []any{"sha256_password"}),
		}},
		dbusertest.Response{Match: "SELECT * FROM system.roles ORDER BY", Rows: []map[string]any{dbusertest.Row("name", "reader", "storage", "local directory")}},
		dbusertest.Response{Match: "system.users WHERE name", Rows: []map[string]any{dbusertest.Row(
			"name", "etl", "storage", "local directory", "auth_type", []any{"sha256_password"}, "host_ip", []any{"10.0.0.0/8"},
			"host_names_like", "['%.corp']", "default_database", "logs", "default_roles_list", []any{"reader"},
		)}},
		dbusertest.Response{Match: "system.grants", Rows: []map[string]any{
			dbusertest.Row("access_type", "SELECT", "database", "logs", "table", "events", "column", nil, "grant_option", uint8(0), "is_partial_revoke", uint8(0)),
			dbusertest.Row("access_type", "INSERT", "database", "logs", "table", nil, "is_partial_revoke", uint8(1)),
		}},
		dbusertest.Response{Match: "system.role_grants", Rows: []map[string]any{dbusertest.Row("granted_role_name", "reader", "with_admin_option", uint8(1))}},
	)
	env := dbuser.Env{SQL: executor}
	principals, err := New().List(context.Background(), env, profile, dbuser.ListQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if !principals[0].ReadOnly || !principals[0].Current || principals[1].AuthMethod != "sha256_password" || principals[2].Ref.Kind != dbuser.KindRole {
		t.Fatalf("principals: %+v", principals)
	}
	detail, err := New().Describe(context.Background(), env, profile, dbuser.DescribeQuery{Ref: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"}})
	if err != nil {
		t.Fatal(err)
	}
	if detail.Options[dbuser.OptHosts] != "IP 10.0.0.0/8\nLIKE %.corp" || detail.Options[dbuser.OptDefaultRoles] != "reader" {
		t.Fatalf("options: %+v", detail.Options)
	}
	if len(detail.Grants) != 1 || detail.Grants[0].Scope != dbuser.ScopeTable || !detail.MemberOf[0].AdminOption {
		t.Fatalf("grants/memberships: %+v %+v", detail.Grants, detail.MemberOf)
	}
}

func TestExportDDLRedactsHashes(t *testing.T) {
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "SHOW CREATE USER", Rows: []map[string]any{dbusertest.Row("statement", "CREATE USER etl IDENTIFIED WITH sha256_hash BY 'ABCDEF' SALT 'SALTY'")}},
		dbusertest.Response{Match: "SHOW GRANTS", Rows: []map[string]any{dbusertest.Row("grant", "GRANT SELECT ON logs.* TO etl")}},
	)
	ddl, err := New().ExportDDL(context.Background(), dbuser.Env{SQL: executor}, dbuser.ServerProfile{}, dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(ddl, "ABCDEF") || strings.Contains(ddl, "SALTY") || !strings.Contains(ddl, "GRANT SELECT") {
		t.Fatalf("ddl: %s", ddl)
	}
}
