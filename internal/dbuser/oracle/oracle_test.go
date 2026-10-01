package oracle

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/dbuser/dbusertest"
)

type oracleFixture struct {
	banner    string
	container string
	dameng    bool
	noDBA     bool
	dmPolicy  []map[string]any
}

func probe(t *testing.T, fixture oracleFixture) dbuser.ServerProfile {
	t.Helper()
	dba := dbusertest.Response{Match: "FROM DBA_USERS WHERE ROWNUM = 1", Rows: []map[string]any{}}
	if fixture.noDBA {
		dba.Err = dbusertest.ErrNotScripted
	}
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "FROM V$VERSION", Rows: []map[string]any{dbusertest.Row("BANNER", fixture.banner)}},
		dbusertest.Response{Match: "SELECT USER AS", Rows: []map[string]any{dbusertest.Row("CURRENT_USER_NAME", "SYSTEM")}},
		dba,
		dbusertest.Response{Match: "CON_NAME", Rows: []map[string]any{dbusertest.Row("CON_NAME", fixture.container)}},
		dbusertest.Response{Match: "common_user_prefix", Rows: []map[string]any{dbusertest.Row("VALUE", "C##")}},
		dbusertest.Response{Match: "SESSION_PRIVS", Rows: []map[string]any{dbusertest.Row("PRIVILEGE", "CREATE USER"), dbusertest.Row("PRIVILEGE", "ALTER USER")}},
		dbusertest.Response{Match: "DBA_TABLESPACES", Rows: []map[string]any{
			dbusertest.Row("TABLESPACE_NAME", "USERS", "CONTENTS", "PERMANENT"), dbusertest.Row("TABLESPACE_NAME", "TEMP", "CONTENTS", "TEMPORARY"),
		}},
		dbusertest.Response{Match: "DBA_PROFILES", Rows: []map[string]any{dbusertest.Row("PROFILE", "DEFAULT")}},
		dbusertest.Response{Match: "SYSTEM_PRIVILEGE_MAP", Rows: []map[string]any{dbusertest.Row("NAME", "CREATE SESSION"), dbusertest.Row("NAME", "ALTER"), dbusertest.Row("NAME", "CREATE TABLE")}},
		dbusertest.Response{Match: "V$DM_INI", Rows: fixture.dmPolicy},
	)
	provider := New()
	if fixture.dameng {
		provider = NewDameng()
	}
	profile, err := provider.Probe(context.Background(), dbuser.Env{SQL: executor}, dbuser.Target{})
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if err := dbuser.CheckDescriptorsAgainstContract(profile.Options); err != nil {
		t.Fatalf("contract drift: %v", err)
	}
	return profile
}

const (
	banner11g = "Oracle Database 11g Enterprise Edition Release 11.2.0.4.0 - 64bit Production"
	banner19c = "Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production"
)

func displays(t *testing.T, provider *Provider, profile dbuser.ServerProfile, request dbuser.ChangeRequest) []string {
	t.Helper()
	plan, err := dbuser.BuildPlan(provider, profile, request)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	return dbusertest.Displays(plan)
}

func expect(t *testing.T, got, want []string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("statements mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestProbeVersionsContainersAndDameng(t *testing.T) {
	legacy := probe(t, oracleFixture{banner: banner11g})
	if legacy.Version.Major != 11 || legacy.Feature(featNoAuthentication) || legacy.Feature(featCommonUsers) {
		t.Fatalf("11g profile: %+v", legacy)
	}
	pdb := probe(t, oracleFixture{banner: banner19c, container: "ORCLPDB1"})
	if !pdb.Feature(featNoAuthentication) || pdb.Feature(featCommonUsers) {
		t.Fatalf("19c pdb: %+v", pdb.Features)
	}
	option, _ := pdb.Option(dbuser.OptDefaultTablespace)
	if len(option.Choices) != 1 || option.Choices[0].Value != "USERS" {
		t.Fatalf("tablespace choices: %+v", option.Choices)
	}
	root := probe(t, oracleFixture{banner: banner19c, container: "CDB$ROOT"})
	if !root.Feature(featCommonUsers) || root.Dialect[dialectCommonPrefix] != "C##" {
		t.Fatalf("cdb root: %+v", root)
	}
	limited := probe(t, oracleFixture{banner: banner19c, noDBA: true})
	if !limited.ReadOnly {
		t.Fatal("without DBA views the profile must be read-only")
	}
	dm := probe(t, oracleFixture{banner: "DM Database Server 64 V8", dameng: true, dmPolicy: []map[string]any{
		dbusertest.Row("PARA_NAME", "PWD_POLICY", "PARA_VALUE", "15"), dbusertest.Row("PARA_NAME", "PWD_MIN_LEN", "PARA_VALUE", "9"),
	}})
	want := dbuser.PasswordPolicy{MinLength: 9, RequireUpper: true, RequireDigit: true, DisallowUsername: true, ForbiddenChars: `"`, Source: "PWD_POLICY"}
	if dm.Family != dbuser.FamilyDameng || dm.Version.Major != 8 || dm.PasswordPolicy != want {
		t.Fatalf("dameng profile: %+v policy=%+v", dm, dm.PasswordPolicy)
	}
	if _, ok := dm.Option(dbuser.OptTemporaryTablespace); ok {
		t.Fatal("dameng must not expose temporary tablespace")
	}
}

func TestPlanOracleUsers(t *testing.T) {
	profile := probe(t, oracleFixture{banner: banner19c, container: "ORCLPDB1"})
	expect(t, displays(t, New(), profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app_user"},
		Password: &dbuser.PasswordChange{Set: true, Password: "S3cr'et#1"},
		Options:  map[string]string{dbuser.OptDefaultTablespace: "USERS", dbuser.OptTemporaryTablespace: "TEMP", dbuser.OptTablespaceQuota: "100m", dbuser.OptProfile: "DEFAULT", dbuser.OptAccountLocked: "false"},
		GrantsAdd: []dbuser.Grant{
			{Privilege: "CREATE SESSION", Scope: dbuser.ScopeGlobal},
			{Privilege: "SELECT", Scope: dbuser.ScopeTable, Schema: "HR", Object: "EMPLOYEES", WithGrantOption: true},
			{Privilege: "UPDATE", Scope: dbuser.ScopeColumn, Schema: "HR", Object: "EMPLOYEES", Column: "SALARY"},
		},
		MembershipsAdd: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "CONNECT"}}},
	}), []string{
		`CREATE USER "APP_USER" IDENTIFIED BY "******" DEFAULT TABLESPACE "USERS" TEMPORARY TABLESPACE "TEMP" QUOTA 100M ON "USERS" PROFILE "DEFAULT" ACCOUNT UNLOCK`,
		`GRANT CREATE SESSION TO "APP_USER"`,
		`GRANT SELECT ON "HR"."EMPLOYEES" TO "APP_USER" WITH GRANT OPTION`,
		`GRANT UPDATE ("SALARY") ON "HR"."EMPLOYEES" TO "APP_USER"`,
		`GRANT "CONNECT" TO "APP_USER"`,
	})
	expect(t, displays(t, New(), profile, dbuser.ChangeRequest{
		Action:  dbuser.ActionCreate,
		Target:  dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "MixedCase"},
		Options: map[string]string{dbuser.OptCaseSensitiveName: "true", dbuser.OptNoAuthentication: "true"},
	}), []string{`CREATE USER "MixedCase" NO AUTHENTICATION`})
	expect(t, displays(t, New(), profile, dbuser.ChangeRequest{
		Action:       dbuser.ActionAlter,
		Target:       dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "APP_USER"},
		Password:     &dbuser.PasswordChange{Set: true, Password: "N3w#pass", CurrentPassword: "old#pass"},
		Options:      map[string]string{dbuser.OptAccountLocked: "true", dbuser.OptDefaultRoles: "CONNECT\nRESOURCE"},
		GrantsRevoke: []dbuser.Grant{{Privilege: "CREATE SESSION", Scope: dbuser.ScopeGlobal, WithGrantOption: true}},
	}), []string{
		`ALTER USER "APP_USER" IDENTIFIED BY "******" REPLACE "******"`,
		`ALTER USER "APP_USER" ACCOUNT LOCK`,
		`REVOKE CREATE SESSION FROM "APP_USER"`,
		`GRANT CREATE SESSION TO "APP_USER"`,
		`ALTER USER "APP_USER" DEFAULT ROLE "CONNECT", "RESOURCE"`,
	})
	expect(t, displays(t, New(), profile, dbuser.ChangeRequest{Action: dbuser.ActionDrop, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "APP_USER"}, Drop: &dbuser.DropOptions{Cascade: true}}),
		[]string{`DROP USER "APP_USER" CASCADE`})
	for name, request := range map[string]dbuser.ChangeRequest{
		"double quote password": {Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "X"}, Password: &dbuser.PasswordChange{Set: true, Password: `a"b`}},
		"quota injection":       {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "X"}, Options: map[string]string{dbuser.OptTablespaceQuota: "1M ON USERS; DROP"}},
		"rename":                {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "X"}, Rename: &dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "Y"}},
		"drop sys":              {Action: dbuser.ActionDrop, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "sys"}},
	} {
		if _, err := dbuser.BuildPlan(New(), profile, request); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestPlanCommonUsersInCDBRoot(t *testing.T) {
	profile := probe(t, oracleFixture{banner: banner19c, container: "CDB$ROOT"})
	expect(t, displays(t, New(), profile, dbuser.ChangeRequest{
		Action:    dbuser.ActionCreate,
		Target:    dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "c##ops"},
		Password:  &dbuser.PasswordChange{Set: true, Password: "Ops#2024"},
		GrantsAdd: []dbuser.Grant{{Privilege: "CREATE SESSION", Scope: dbuser.ScopeGlobal}},
	}), []string{`CREATE USER "C##OPS" IDENTIFIED BY "******" CONTAINER=ALL`, `GRANT CREATE SESSION TO "C##OPS" CONTAINER=ALL`})
	if _, err := dbuser.BuildPlan(New(), profile, dbuser.ChangeRequest{
		Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "local"}, Password: &dbuser.PasswordChange{Set: true, Password: "x"},
	}); err == nil {
		t.Fatal("root container must require the common user prefix")
	}
}

func TestPlanDamengEnforcesPolicy(t *testing.T) {
	profile := probe(t, oracleFixture{banner: "DM Database Server 64 V8", dameng: true, dmPolicy: []map[string]any{
		dbusertest.Row("PARA_NAME", "PWD_POLICY", "PARA_VALUE", "2"), dbusertest.Row("PARA_NAME", "PWD_MIN_LEN", "PARA_VALUE", "9"),
	}})
	expect(t, displays(t, NewDameng(), profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "dmuser"},
		Password: &dbuser.PasswordChange{Set: true, Password: "Dameng12345"},
		Options:  map[string]string{dbuser.OptDefaultTablespace: "USERS"},
	}), []string{`CREATE USER "DMUSER" IDENTIFIED BY "******" DEFAULT TABLESPACE "USERS"`})
	if _, err := dbuser.BuildPlan(NewDameng(), profile, dbuser.ChangeRequest{
		Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "u"}, Password: &dbuser.PasswordChange{Set: true, Password: "Dameng12345"},
		Options: map[string]string{dbuser.OptTablespaceQuota: "10M"},
	}); err == nil {
		t.Fatal("dameng has no quota option")
	}
	if _, err := dbuser.BuildPlan(NewDameng(), profile, dbuser.ChangeRequest{
		Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "u"}, Password: &dbuser.PasswordChange{Set: true, Password: "short"},
	}); err == nil {
		t.Fatal("PWD_MIN_LEN must be enforced")
	}
}

func TestDescribeReadsPrivilegesAndDefaultRoles(t *testing.T) {
	profile := probe(t, oracleFixture{banner: banner19c, container: "ORCLPDB1"})
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "FROM DBA_USERS WHERE USERNAME", Rows: []map[string]any{dbusertest.Row(
			"USERNAME", "APP", "ACCOUNT_STATUS", "EXPIRED(GRACE) & LOCKED", "DEFAULT_TABLESPACE", "USERS", "TEMPORARY_TABLESPACE", "TEMP", "PROFILE", "DEFAULT",
			"AUTHENTICATION_TYPE", "PASSWORD", "ORACLE_MAINTAINED", "N", "PASSWORD_VERSIONS", "11G 12C",
		)}},
		dbusertest.Response{Match: "DBA_TS_QUOTAS", Rows: []map[string]any{dbusertest.Row("MAX_BYTES", float64(-1))}},
		dbusertest.Response{Match: "DBA_SYS_PRIVS", Rows: []map[string]any{dbusertest.Row("PRIVILEGE", "CREATE SESSION", "ADMIN_OPTION", "YES")}},
		dbusertest.Response{Match: "DBA_TAB_PRIVS", Rows: []map[string]any{dbusertest.Row("OWNER", "HR", "TABLE_NAME", "CALC", "PRIVILEGE", "EXECUTE", "GRANTABLE", "NO", "TYPE", "FUNCTION")}},
		dbusertest.Response{Match: "DBA_COL_PRIVS", Rows: nil},
		dbusertest.Response{Match: "DBA_ROLE_PRIVS WHERE GRANTEE", Rows: []map[string]any{
			dbusertest.Row("GRANTED_ROLE", "CONNECT", "ADMIN_OPTION", "NO", "DEFAULT_ROLE", "YES"),
			dbusertest.Row("GRANTED_ROLE", "DBA", "ADMIN_OPTION", "YES", "DEFAULT_ROLE", "NO"),
		}},
	)
	detail, err := New().Describe(context.Background(), dbuser.Env{SQL: executor}, profile, dbuser.DescribeQuery{Ref: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "APP"}})
	if err != nil {
		t.Fatal(err)
	}
	if !detail.Principal.Locked || !detail.Principal.Expired || detail.Options[dbuser.OptTablespaceQuota] != "UNLIMITED" || detail.Options[dbuser.OptDefaultRoles] != "CONNECT" {
		t.Fatalf("detail: %+v", detail)
	}
	if len(detail.Grants) != 2 || detail.Grants[1].Scope != dbuser.ScopeRoutine || !detail.Grants[0].WithGrantOption {
		t.Fatalf("grants: %+v", detail.Grants)
	}
	if !strings.Contains(strings.Join(detail.Principal.Tags, ","), "pwd:11G 12C") || len(detail.MemberOf) != 2 || !detail.MemberOf[1].AdminOption {
		t.Fatalf("tags/memberships: %+v %+v", detail.Principal.Tags, detail.MemberOf)
	}
}
