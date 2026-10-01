package mongo

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/dbuser/dbusertest"
)

// resultRow 模拟 agent 回传：非游标命令包成 {"result": {...}}，数值为 float64。
func resultRow(document string) []map[string]any {
	var decoded map[string]any
	if err := json.Unmarshal([]byte(document), &decoded); err != nil {
		panic(err)
	}
	return []map[string]any{{"result": decoded}}
}

func probe(t *testing.T, version string) dbuser.ServerProfile {
	t.Helper()
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: `"buildInfo"`, Rows: resultRow(`{"version": "` + version + `", "ok": 1}`)},
		dbusertest.Response{Match: `"connectionStatus"`, Rows: resultRow(`{"authInfo": {"authenticatedUsers": [{"user": "admin", "db": "admin"}], "authenticatedUserPrivileges": [{"actions": ["createUser", "dropUser", "grantRole", "revokeRole", "changePassword", "viewUser"]}]}}`)},
		dbusertest.Response{Match: `"rolesInfo"`, Rows: resultRow(`{"roles": [{"role": "root", "db": "admin", "isBuiltin": true}, {"role": "custom", "db": "admin", "isBuiltin": false}]}`)},
		dbusertest.Response{Match: `"listDatabases"`, Rows: resultRow(`{"databases": [{"name": "admin"}, {"name": "sales"}, {"name": "local"}]}`)},
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

func TestProbeMechanismsAndAssignableRoles(t *testing.T) {
	legacy := probe(t, "3.6.23")
	option, _ := legacy.Option(dbuser.OptMechanisms)
	if len(option.Choices) != 1 || option.Choices[0].Value != "SCRAM-SHA-1" {
		t.Fatalf("3.6 mechanisms: %+v", option.Choices)
	}
	modern := probe(t, "7.0.2")
	option, _ = modern.Option(dbuser.OptMechanisms)
	if len(option.Choices) != 2 || modern.CurrentUser != "admin@admin" || !modern.Permissions.CanCreate {
		t.Fatalf("7.0 profile: %+v", modern)
	}
	want := []dbuser.PrincipalRef{{Kind: dbuser.KindRole, Name: "root", Database: "admin"}}
	for _, role := range perDatabaseRoles {
		want = append(want, dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: role, Database: "sales"})
	}
	if !reflect.DeepEqual(modern.AssignableRoles, want) {
		t.Fatalf("assignable roles: %+v", modern.AssignableRoles)
	}
}

func TestPlanUserCommandsAreOrderedAndMasked(t *testing.T) {
	profile := probe(t, "7.0.2")
	plan, err := dbuser.BuildPlan(New(), profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app", Database: "sales"},
		Password: &dbuser.PasswordChange{Set: true, Password: `p"w\d`},
		Options: map[string]string{dbuser.OptMechanisms: "SCRAM-SHA-256", dbuser.OptCustomData: `{"team": "etl"}`,
			dbuser.OptClientSources: "10.0.0.0/8"},
		MembershipsAdd: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "readWrite", Database: "sales"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	statement := plan.Statements[0]
	wantDisplay := `{"createUser": "app", "pwd": "******", "roles": [{"role": "readWrite", "db": "sales"}], "mechanisms": ["SCRAM-SHA-256"], "customData": {"team":"etl"}, "authenticationRestrictions": [{"clientSource": ["10.0.0.0/8"]}]}`
	if statement.Display != wantDisplay || statement.Database != "sales" {
		t.Fatalf("display: %s (db %s)", statement.Display, statement.Database)
	}
	if !strings.HasPrefix(statement.Exec, `{"createUser": "app", "pwd": "p\"w\\d"`) || !json.Valid([]byte(statement.Exec)) {
		t.Fatalf("exec must be valid ordered JSON with escaped password: %s", statement.Exec)
	}
	alter, err := dbuser.BuildPlan(New(), profile, dbuser.ChangeRequest{
		Action:            dbuser.ActionAlter,
		Target:            dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app", Database: "sales"},
		Password:          &dbuser.PasswordChange{Set: true, Password: "n3w"},
		MembershipsAdd:    []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "read", Database: "reports"}}},
		MembershipsRemove: []dbuser.Membership{{Role: dbuser.PrincipalRef{Kind: dbuser.KindRole, Name: "readWrite", Database: "sales"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := dbusertest.Displays(alter); !reflect.DeepEqual(got, []string{
		`{"updateUser": "app", "pwd": "******"}`,
		`{"revokeRolesFromUser": "app", "roles": [{"role": "readWrite", "db": "sales"}]}`,
		`{"grantRolesToUser": "app", "roles": [{"role": "read", "db": "reports"}]}`,
	}) {
		t.Fatalf("alter: %q", got)
	}
	if _, err := dbuser.BuildPlan(New(), profile, dbuser.ChangeRequest{
		Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app", Database: "sales"},
		Options: map[string]string{dbuser.OptCustomData: "not json"},
	}); err == nil {
		t.Fatal("invalid customData must be rejected")
	}
}

func TestListAndDescribeParseAgentDocuments(t *testing.T) {
	profile := probe(t, "6.0.5")
	executor := dbusertest.NewExecutor(
		dbusertest.Response{Match: `{"usersInfo": {"forAllDBs"`, Rows: resultRow(`{"users": [{"user": "admin", "db": "admin"}, {"user": "app", "db": "sales"}]}`)},
		dbusertest.Response{Match: `"find": "system.roles"`, Rows: []map[string]any{{"role": "auditor", "db": "admin"}}},
		dbusertest.Response{Match: `{"usersInfo": {"user"`, Rows: resultRow(`{"users": [{"user": "app", "db": "sales", "roles": [{"role": "readWrite", "db": "sales"}], "mechanisms": ["SCRAM-SHA-1", "SCRAM-SHA-256"], "customData": {"team": "etl"}, "authenticationRestrictions": [{"clientSource": ["10.0.0.1"], "serverAddress": ["10.0.0.9"]}]}]}`)},
	)
	env := dbuser.Env{SQL: executor}
	principals, err := New().List(context.Background(), env, profile, dbuser.ListQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(principals) != 3 || !principals[0].Current || principals[2].Ref.Kind != dbuser.KindRole {
		t.Fatalf("principals: %+v", principals)
	}
	detail, err := New().Describe(context.Background(), env, profile, dbuser.DescribeQuery{Ref: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app", Database: "sales"}})
	if err != nil {
		t.Fatal(err)
	}
	if detail.Options[dbuser.OptMechanisms] != "SCRAM-SHA-1\nSCRAM-SHA-256" || detail.Options[dbuser.OptClientSources] != "10.0.0.1" || !strings.Contains(detail.Options[dbuser.OptCustomData], `"team": "etl"`) {
		t.Fatalf("options: %+v", detail.Options)
	}
	if len(detail.MemberOf) != 1 || detail.MemberOf[0].Role.Database != "sales" {
		t.Fatalf("memberships: %+v", detail.MemberOf)
	}
	if !strings.HasPrefix(executor.Queries[len(executor.Queries)-1], "[sales] ") {
		t.Fatalf("describe must run in the auth database: %q", executor.Queries)
	}
}
