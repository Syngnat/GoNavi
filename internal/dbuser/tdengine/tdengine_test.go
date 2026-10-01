package tdengine

import (
	"context"
	"reflect"
	"testing"

	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/dbuser/dbusertest"
)

func probe(t *testing.T, version string) dbuser.ServerProfile {
	t.Helper()
	executor := dbusertest.NewExecutor(dbusertest.Response{Match: "SERVER_VERSION()", Rows: []map[string]any{dbusertest.Row("version", version)}})
	profile, err := New().Probe(context.Background(), dbuser.Env{SQL: executor}, dbuser.Target{ConnectionUser: "root"})
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

func TestTDengine2UsesPrivilegeLevels(t *testing.T) {
	profile := probe(t, "2.6.0.34")
	if profile.Feature(featGrants) || len(profile.EditorTabs) != 2 {
		t.Fatalf("2.x profile: %+v", profile)
	}
	got := displays(t, profile, dbuser.ChangeRequest{
		Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "reader"},
		Password: &dbuser.PasswordChange{Set: true, Password: "taosdata"}, Options: map[string]string{dbuser.OptPrivilegeLevel: "read"},
	})
	if !reflect.DeepEqual(got, []string{"CREATE USER reader PASS '******'", "ALTER USER reader PRIVILEGE read"}) {
		t.Fatalf("2.x create: %q", got)
	}
}

func TestTDengine3GrantsFlagsAndPolicy(t *testing.T) {
	profile := probe(t, "3.3.6.0")
	if !profile.Feature(featCreateDB) || profile.PasswordPolicy.MaxLength != 16 {
		t.Fatalf("3.3.6 profile: %+v", profile)
	}
	got := displays(t, profile, dbuser.ChangeRequest{
		Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"},
		Password: &dbuser.PasswordChange{Set: true, Password: "Taos#2024"},
		Options:  map[string]string{dbuser.OptSysInfo: "false", dbuser.OptCreateDB: "true", dbuser.OptLoginEnabled: "false"},
		GrantsAdd: []dbuser.Grant{
			{Privilege: "READ", Scope: dbuser.ScopeDatabase, Database: "power"},
			{Privilege: "WRITE", Scope: dbuser.ScopeTable, Database: "power", Object: "meters"},
		},
	})
	want := []string{
		"CREATE USER etl PASS '******' SYSINFO 0 CREATEDB 1",
		"ALTER USER etl ENABLE 0",
		"GRANT READ ON `power`.* TO etl",
		"GRANT WRITE ON `power`.`meters` TO etl",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("3.x create\n got: %q\nwant: %q", got, want)
	}
	for name, request := range map[string]dbuser.ChangeRequest{
		"quote in password": {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"}, Password: &dbuser.PasswordChange{Set: true, Password: "Taos'#2024"}},
		"weak password":     {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"}, Password: &dbuser.PasswordChange{Set: true, Password: "taosdata"}},
		"bad user name":     {Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "bad-name"}, Password: &dbuser.PasswordChange{Set: true}},
		"drop root":         {Action: dbuser.ActionDrop, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "root"}},
		"db injection": {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"},
			GrantsAdd: []dbuser.Grant{{Privilege: "READ", Scope: dbuser.ScopeDatabase, Database: "a`; DROP"}}},
	} {
		if _, err := dbuser.BuildPlan(New(), profile, request); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestDescribeParsesShowUsersAndPrivileges(t *testing.T) {
	profile := probe(t, "3.3.2.0")
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "SHOW USERS", Rows: []map[string]any{
			dbusertest.Row("name", "root", "super", int64(1), "enable", int64(1), "sysinfo", int64(1)),
			dbusertest.Row("name", "etl", "super", int64(0), "enable", int64(0), "sysinfo", int64(0), "createdb", int64(1)),
		}},
		dbusertest.Response{Match: "ins_user_privileges", Rows: []map[string]any{
			dbusertest.Row("user_name", "etl", "privilege", "all", "db_name", "power", "table_name", ""),
		}},
	)
	env := dbuser.Env{SQL: executor}
	principals, err := New().List(context.Background(), env, profile, dbuser.ListQuery{})
	if err != nil || !principals[0].Superuser || !principals[0].Current || !principals[1].Locked {
		t.Fatalf("list: %+v %v", principals, err)
	}
	detail, err := New().Describe(context.Background(), env, profile, dbuser.DescribeQuery{Ref: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "etl"}})
	if err != nil {
		t.Fatal(err)
	}
	if detail.Options[dbuser.OptLoginEnabled] != "false" || detail.Options[dbuser.OptCreateDB] != "true" || len(detail.Grants) != 2 {
		t.Fatalf("detail: %+v", detail)
	}
}
