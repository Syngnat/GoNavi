package postgres

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/dbuser/dbusertest"
)

type pgFixture struct {
	sourceType string
	banner     string
	versionNum string
	encryption string
	enumvals   string
	opengauss  bool
}

func probe(t *testing.T, fixture pgFixture) dbuser.ServerProfile {
	t.Helper()
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "SELECT version()", Rows: []map[string]any{dbusertest.Row("version", fixture.banner, "current_role", "postgres")}},
		dbusertest.Response{Match: "server_version_num", Rows: []map[string]any{dbusertest.Row("value", fixture.versionNum)}},
		dbusertest.Response{Match: "FROM pg_catalog.pg_roles LIMIT 1", Rows: []map[string]any{}},
		dbusertest.Response{Match: "pg_settings WHERE name =", Rows: []map[string]any{dbusertest.Row("setting", fixture.encryption, "enumvals", fixture.enumvals)}},
		dbusertest.Response{Match: "WHERE rolname = current_user", Rows: []map[string]any{dbusertest.Row("rolsuper", true, "rolcreaterole", true)}},
		dbusertest.Response{Match: "password_policy", Rows: []map[string]any{dbusertest.Row("name", "password_policy", "setting", "1"), dbusertest.Row("name", "password_min_length", "setting", "8")}},
	)
	provider := New()
	if fixture.opengauss {
		provider = NewOpenGauss()
	}
	profile, err := provider.Probe(context.Background(), dbuser.Env{SQL: executor}, dbuser.Target{SourceType: fixture.sourceType})
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if err := dbuser.CheckDescriptorsAgainstContract(profile.Options); err != nil {
		t.Fatalf("contract drift: %v", err)
	}
	return profile
}

func pg16() pgFixture {
	return pgFixture{sourceType: "postgres", banner: "PostgreSQL 16.2 on x86_64-pc-linux-gnu, compiled by gcc", versionNum: "160002", encryption: "scram-sha-256", enumvals: "{md5,scram-sha-256}"}
}

func build(t *testing.T, provider *Provider, profile dbuser.ServerProfile, request dbuser.ChangeRequest) dbuser.Plan {
	t.Helper()
	plan, err := dbuser.BuildPlan(provider, profile, request)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	return plan
}

func assertDisplays(t *testing.T, plan dbuser.Plan, want []string) {
	t.Helper()
	if got := dbusertest.Displays(plan); !reflect.DeepEqual(got, want) {
		t.Fatalf("statements mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestParseVersionNum(t *testing.T) {
	for text, want := range map[string][3]int{"160002": {16, 0, 2}, "90624": {9, 6, 24}, "120001": {12, 0, 1}} {
		got := parseVersionNum(text)
		if [3]int{got.Major, got.Minor, got.Patch} != want {
			t.Fatalf("%s → %+v", text, got)
		}
	}
}

func TestProbeFeaturesByVersionAndFlavor(t *testing.T) {
	legacy := probe(t, pgFixture{sourceType: "postgres", banner: "PostgreSQL 9.4.26", versionNum: "90426", encryption: "on"})
	if legacy.Feature(featBypassRLS) || legacy.Feature(featClientHash) || legacy.Feature(featMembershipOptions) {
		t.Fatalf("9.4 must not enable newer features: %+v", legacy.Features)
	}
	modern := probe(t, pg16())
	if !modern.Feature(featMembershipOptions) || !modern.Feature(featClientHash) || modern.Feature(featMaintain) {
		t.Fatalf("pg16 features: %+v", modern.Features)
	}
	option, ok := modern.Option(dbuser.OptPasswordEncryption)
	if !ok || option.Default != "scram-sha-256" || len(option.Choices) != 2 || !option.Choices[0].Deprecated {
		t.Fatalf("encryption option: %+v", option)
	}
	pg17 := probe(t, pgFixture{sourceType: "postgres", banner: "PostgreSQL 17.0", versionNum: "170000", encryption: "scram-sha-256", enumvals: "{md5,scram-sha-256}"})
	found := false
	for _, privilege := range pg17.Privileges {
		found = found || privilege.Name == "MAINTAIN"
	}
	if !found {
		t.Fatal("pg17 must expose MAINTAIN")
	}
	kingbase := probe(t, pgFixture{sourceType: "kingbase", banner: "KingbaseES V008R006C008B0014 on x86_64", versionNum: "120001", encryption: "sm3", enumvals: "{md5,scram-sha-256,sm3}"})
	if kingbase.Flavor != "kingbase" || kingbase.Feature(featClientHash) || !kingbase.Experimental {
		t.Fatalf("kingbase must use server-side hashing: %+v", kingbase)
	}
	if _, ok := kingbase.Option(dbuser.OptPasswordEncryption); ok {
		t.Fatal("kingbase must not offer client-side encryption choice")
	}
}

func TestPlanCreateUserPG16PrehashesScram(t *testing.T) {
	profile := probe(t, pg16())
	plan := build(t, New(), profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"},
		Password: &dbuser.PasswordChange{Set: true, Password: "Str0ng!pw"},
		Options:  map[string]string{dbuser.OptCreateDB: "true", dbuser.OptConnectionLimit: "10", dbuser.OptValidUntil: "2030-01-01", dbuser.OptComment: "svc"},
		GrantsAdd: []dbuser.Grant{
			{Privilege: "CONNECT", Scope: dbuser.ScopeDatabase, Database: "sales"},
			{Privilege: "USAGE", Scope: dbuser.ScopeSchema, Database: "sales", Schema: "public"},
			{Privilege: "SELECT", Scope: dbuser.ScopeTable, Database: "sales", Schema: "public", Object: "orders"},
			{Privilege: "UPDATE", Scope: dbuser.ScopeColumn, Database: "sales", Schema: "public", Object: "orders", Column: "note"},
			{Privilege: "EXECUTE", Scope: dbuser.ScopeRoutine, Database: "sales", Schema: "public", Object: "calc(integer, text)", ObjectType: "FUNCTION"},
		},
		MembershipsAdd: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "reader"}, Inherit: boolPtr(false)}},
	})
	assertDisplays(t, plan, []string{
		`CREATE ROLE "app" WITH CREATEDB LOGIN CONNECTION LIMIT 10 VALID UNTIL E'2030-01-01' PASSWORD '******'`,
		`COMMENT ON ROLE "app" IS E'svc'`,
		`GRANT CONNECT ON DATABASE "sales" TO "app"`,
		`GRANT USAGE ON SCHEMA "public" TO "app"`,
		`GRANT SELECT ON TABLE "public"."orders" TO "app"`,
		`GRANT UPDATE ("note") ON TABLE "public"."orders" TO "app"`,
		`GRANT EXECUTE ON FUNCTION "public"."calc"(integer, text) TO "app"`,
		`GRANT "reader" TO "app" WITH INHERIT FALSE`,
	})
	if !plan.Transactional || plan.Statements[2].Database != "" || plan.Statements[3].Database != "sales" {
		t.Fatalf("transaction/database routing: %+v", plan)
	}
	exec := plan.Statements[0].Exec
	if strings.Contains(exec, "Str0ng") || !strings.Contains(exec, "PASSWORD 'SCRAM-SHA-256$4096:") {
		t.Fatalf("password must be pre-hashed: %s", exec)
	}
}

func TestPlanMD5AndServerSideHashing(t *testing.T) {
	profile := probe(t, pg16())
	plan := build(t, New(), profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionAlter,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"},
		Password: &dbuser.PasswordChange{Set: true, Password: "pw"},
		Options:  map[string]string{dbuser.OptPasswordEncryption: "md5"},
	})
	if !strings.Contains(plan.Statements[0].Exec, "PASSWORD '"+md5Verifier("pw", "app")+"'") {
		t.Fatalf("md5 verifier: %s", plan.Statements[0].Exec)
	}
	kingbase := probe(t, pgFixture{sourceType: "kingbase", banner: "KingbaseES V008R006", versionNum: "120001", encryption: "sm3"})
	plan = build(t, New(), kingbase, dbuser.ChangeRequest{
		Action:   dbuser.ActionAlter,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"},
		Password: &dbuser.PasswordChange{Set: true, Password: `a'b\c`},
	})
	if plan.Statements[0].Exec != `ALTER ROLE "app" WITH PASSWORD E'a''b\\c'` {
		t.Fatalf("server-side hashing exec: %s", plan.Statements[0].Exec)
	}
	unicode := build(t, New(), profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionAlter,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"},
		Password: &dbuser.PasswordChange{Set: true, Password: "口令Pass1"},
	})
	if !strings.Contains(unicode.Statements[0].Exec, "E'口令Pass1'") {
		t.Fatalf("non-ASCII password must fall back to server hashing: %s", unicode.Statements[0].Exec)
	}
}

func TestPlanAlterDropAndValidation(t *testing.T) {
	profile := probe(t, pg16())
	plan := build(t, New(), profile, dbuser.ChangeRequest{
		Action:       dbuser.ActionAlter,
		Target:       dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"},
		Rename:       &dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app2"},
		Options:      map[string]string{dbuser.OptSuperuser: "false", dbuser.OptValidUntil: ""},
		GrantsRevoke: []dbuser.Grant{{Privilege: "SELECT", Scope: dbuser.ScopeTable, Database: "sales", Schema: "public", Object: "orders", WithGrantOption: true}},
	})
	assertDisplays(t, plan, []string{
		`ALTER ROLE "app" RENAME TO "app2"`,
		`ALTER ROLE "app2" WITH NOSUPERUSER VALID UNTIL E'infinity'`,
		`REVOKE GRANT OPTION FOR SELECT ON TABLE "public"."orders" FROM "app2"`,
	})
	drop := build(t, New(), profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionDrop,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"},
		Database: "sales",
		Drop:     &dbuser.DropOptions{ReassignTo: "postgres", DropOwned: true},
	})
	assertDisplays(t, drop, []string{`REASSIGN OWNED BY "app" TO "postgres"`, `DROP OWNED BY "app"`, `DROP ROLE "app"`})
	if drop.Statements[0].Database != "sales" || drop.Statements[2].Database != "" {
		t.Fatalf("drop database routing: %+v", drop.Statements)
	}
	for name, request := range map[string]dbuser.ChangeRequest{
		"routine injection": {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"},
			GrantsAdd: []dbuser.Grant{{Privilege: "EXECUTE", Scope: dbuser.ScopeRoutine, Schema: "public", Object: "f(int); DROP TABLE x; --)", ObjectType: "FUNCTION"}}},
		"bad timestamp": {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"}, Options: map[string]string{dbuser.OptValidUntil: "tomorrow'; DROP"}},
		"system role":   {Action: dbuser.ActionDrop, Target: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "pg_monitor"}},
		"name too long": {Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: strings.Repeat("r", 64)}},
	} {
		if _, err := dbuser.BuildPlan(New(), profile, request); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestPlanOpenGauss(t *testing.T) {
	profile := probe(t, pgFixture{sourceType: "opengauss", banner: "(openGauss 5.0.1 build 33b035fd) compiled at 2023", versionNum: "90204", encryption: "2", opengauss: true})
	if profile.PasswordPolicy.MinLength != 8 || profile.Feature(featClientHash) {
		t.Fatalf("opengauss policy/features: %+v", profile)
	}
	create := build(t, NewOpenGauss(), profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "og"},
		Password: &dbuser.PasswordChange{Set: true, Password: "Gauss@123"},
		Options:  map[string]string{dbuser.OptSysAdmin: "true"},
	})
	assertDisplays(t, create, []string{`CREATE USER "og" WITH SYSADMIN LOGIN IDENTIFIED BY '******'`})
	if create.Transactional {
		t.Fatal("opengauss plans must not be transactional until verified")
	}
	role := build(t, NewOpenGauss(), profile, dbuser.ChangeRequest{Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "r"}})
	assertDisplays(t, role, []string{`CREATE ROLE "r" WITH NOLOGIN PASSWORD DISABLE`})
	alter := build(t, NewOpenGauss(), profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionAlter,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "og"},
		Password: &dbuser.PasswordChange{Set: true, Password: "Gauss@456", CurrentPassword: "Gauss@123"},
		Options:  map[string]string{dbuser.OptAccountLocked: "true"},
	})
	assertDisplays(t, alter, []string{`ALTER USER "og" IDENTIFIED BY '******' REPLACE '******'`, `ALTER USER "og" ACCOUNT LOCK`})
	if _, err := dbuser.BuildPlan(NewOpenGauss(), profile, dbuser.ChangeRequest{
		Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "og"},
		Password: &dbuser.PasswordChange{Set: true, Password: "weak"},
	}); err == nil {
		t.Fatal("password policy must be enforced")
	}
	drop := build(t, NewOpenGauss(), profile, dbuser.ChangeRequest{Action: dbuser.ActionDrop, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "og"}, Drop: &dbuser.DropOptions{Cascade: true}})
	assertDisplays(t, drop, []string{`DROP USER "og" CASCADE`})
}

func TestDescribeReadsRoleAttributesGrantsAndMemberships(t *testing.T) {
	profile := probe(t, pg16())
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: "shobj_description", Rows: []map[string]any{dbusertest.Row("description", "svc")}},
		dbusertest.Response{Match: "aclexplode(d.datacl)", Rows: []map[string]any{dbusertest.Row("datname", "sales", "privilege_type", "CONNECT", "is_grantable", false)}},
		dbusertest.Response{Match: "aclexplode(c.relacl)", Rows: []map[string]any{dbusertest.Row("nspname", "public", "relname", "seq", "relkind", "S", "privilege_type", "USAGE", "is_grantable", true)}},
		dbusertest.Response{Match: "aclexplode(n.nspacl)", Rows: nil},
		dbusertest.Response{Match: "aclexplode(att.attacl)", Rows: nil},
		dbusertest.Response{Match: "aclexplode(p.proacl)", Rows: nil},
		dbusertest.Response{Match: "WHERE rolname = E'app'", Rows: []map[string]any{dbusertest.Row(
			"rolname", "app", "rolcanlogin", true, "rolsuper", false, "rolcreatedb", true, "rolconnlimit", float64(-1), "rolvaliduntil", "2030-01-01T00:00:00Z",
		)}},
		dbusertest.Response{Match: "WHERE u.rolname", Rows: []map[string]any{dbusertest.Row("role_name", "reader", "admin_option", false, "inherit_option", false, "set_option", true)}},
		dbusertest.Response{Match: "WHERE r.rolname", Rows: nil},
	)
	detail, err := New().Describe(context.Background(), dbuser.Env{SQL: executor}, profile, dbuser.DescribeQuery{Ref: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"}, Database: "sales"})
	if err != nil {
		t.Fatal(err)
	}
	if detail.Options[dbuser.OptCreateDB] != "true" || detail.Options[dbuser.OptValidUntil] != "2030-01-01 00:00:00" || detail.Options[dbuser.OptComment] != "svc" {
		t.Fatalf("options: %+v", detail.Options)
	}
	if len(detail.Grants) != 2 || detail.Grants[1].Scope != dbuser.ScopeSequence || !detail.Grants[1].WithGrantOption {
		t.Fatalf("grants: %+v", detail.Grants)
	}
	if len(detail.MemberOf) != 1 || *detail.MemberOf[0].Inherit {
		t.Fatalf("memberships: %+v", detail.MemberOf)
	}
	for _, query := range executor.Queries {
		if strings.Contains(query, "aclexplode(c.relacl)") && !strings.HasPrefix(query, "[sales] ") {
			t.Fatalf("object grants must be read in the selected database: %s", query)
		}
	}
}

// TestScramVerifierMatchesRFC7677 用 RFC 7677 的测试向量校验 StoredKey 与 ServerKey。
func TestScramVerifierMatchesRFC7677(t *testing.T) {
	salt, _ := base64.StdEncoding.DecodeString("W22ZaJ0SNY7soEsUEjb6gQ==")
	verifier, err := scramSHA256Verifier("pencil", bytes.NewReader(salt))
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(strings.TrimPrefix(verifier, "SCRAM-SHA-256$"), "$")
	keys := strings.Split(parts[1], ":")
	storedKey, _ := base64.StdEncoding.DecodeString(keys[0])
	serverKey, _ := base64.StdEncoding.DecodeString(keys[1])
	authMessage := "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0"
	if got := base64.StdEncoding.EncodeToString(hmacSHA256(serverKey, authMessage)); got != "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=" {
		t.Fatalf("server signature mismatch: %s", got)
	}
	proof, _ := base64.StdEncoding.DecodeString("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=")
	mac := hmac.New(sha256.New, storedKey)
	mac.Write([]byte(authMessage))
	signature := mac.Sum(nil)
	clientKey := make([]byte, len(proof))
	for index := range proof {
		clientKey[index] = proof[index] ^ signature[index]
	}
	if sum := sha256.Sum256(clientKey); !bytes.Equal(sum[:], storedKey) {
		t.Fatal("stored key does not match RFC 7677 client proof")
	}
	if parts[0] != "4096:W22ZaJ0SNY7soEsUEjb6gQ==" {
		t.Fatalf("iteration/salt header: %s", parts[0])
	}
}

func boolPtr(value bool) *bool {
	return &value
}
