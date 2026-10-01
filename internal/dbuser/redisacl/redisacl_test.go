package redisacl

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/dbuser"
)

type fakeCommands struct {
	topology string
	replies  map[string]any
	nodes    map[string][]dbuser.NodeResult
	calls    [][]string
	failOn   string
}

func (f *fakeCommands) Do(_ context.Context, args []string) (any, error) {
	f.calls = append(f.calls, args)
	key := strings.Join(args, " ")
	if f.failOn != "" && strings.HasPrefix(key, f.failOn) {
		return nil, errors.New("ERR " + key)
	}
	if reply, ok := f.replies[key]; ok {
		return reply, nil
	}
	return nil, errors.New("unexpected " + key)
}

func (f *fakeCommands) DoEachNode(_ context.Context, args []string) ([]dbuser.NodeResult, error) {
	f.calls = append(f.calls, append([]string{"@each"}, args...))
	return f.nodes[strings.Join(args, " ")], nil
}

func (f *fakeCommands) Topology() string {
	return f.topology
}

func newFake(version, topology string) *fakeCommands {
	return &fakeCommands{
		topology: topology,
		replies: map[string]any{
			"INFO server":        "# Server\r\nredis_version:" + version + "\r\nconfig_file:/etc/redis.conf\r\n",
			"ACL WHOAMI":         "default",
			"CONFIG GET aclfile": []any{"aclfile", ""},
			"ACL CAT":            []any{"read", "write", "dangerous"},
			"ACL LIST": []any{
				"user default on nopass sanitize-payload ~* &* +@all",
				"user app on #2e0c... ~app:* resetchannels &news -@all +@read +@write -flushall (~cache:* +get)",
				"user blocked off resetchannels -@all",
			},
		},
		nodes: map[string][]dbuser.NodeResult{},
	}
}

func probe(t *testing.T, commands *fakeCommands) dbuser.ServerProfile {
	t.Helper()
	profile, err := New().Probe(context.Background(), dbuser.Env{Commands: commands}, dbuser.Target{})
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if err := dbuser.CheckDescriptorsAgainstContract(profile.Options); err != nil {
		t.Fatalf("contract drift: %v", err)
	}
	return profile
}

func TestProbeGatesByVersion(t *testing.T) {
	legacy := probe(t, newFake("5.0.14", "standalone"))
	if legacy.Supported || legacy.UnsupportedReason == nil || legacy.UnsupportedReason.Code != noticeNoACL {
		t.Fatalf("redis 5 must be unsupported: %+v", legacy)
	}
	v6 := probe(t, newFake("6.0.20", "standalone"))
	if v6.Feature(featChannels) || v6.Feature(featSelectors) {
		t.Fatalf("6.0 features: %+v", v6.Features)
	}
	if _, ok := v6.Option(dbuser.OptACLChannels); ok {
		t.Fatal("6.0 must not expose channel rules")
	}
	v7 := probe(t, newFake("7.2.4", "cluster"))
	if !v7.Feature(featSelectors) || v7.Dialect[dialectPersist] != persistConfig || v7.CurrentUser != "default" {
		t.Fatalf("7.2 profile: %+v", v7)
	}
	commands, _ := v7.Option(dbuser.OptACLCommands)
	if len(commands.Choices) != 6 {
		t.Fatalf("category choices: %+v", commands.Choices)
	}
}

func TestParseACLLineHandlesSelectors(t *testing.T) {
	rules, ok := parseACLLine("user app on #abc ~app:* %R~ro:* resetchannels &news -@all +@read +config|get (~cache:* +get) (&c +publish)")
	if !ok || !rules.enabled || rules.passwords != 1 {
		t.Fatalf("parse: %+v", rules)
	}
	if !reflect.DeepEqual(rules.keys, []string{"~app:*", "%R~ro:*"}) || !reflect.DeepEqual(rules.selectors, []string{"(~cache:* +get)", "(&c +publish)"}) {
		t.Fatalf("keys/selectors: %+v", rules)
	}
	if !reflect.DeepEqual(rules.commands, []string{"-@all", "+@read", "+config|get"}) {
		t.Fatalf("commands: %+v", rules.commands)
	}
}

func TestPlanSetUserArgsAndPersistence(t *testing.T) {
	profile := probe(t, newFake("7.2.4", "standalone"))
	plan, err := dbuser.BuildPlan(New(), profile, dbuser.ChangeRequest{
		Action:   dbuser.ActionCreate,
		Target:   dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"},
		Password: &dbuser.PasswordChange{Set: true, Password: "p w"},
		Options: map[string]string{dbuser.OptLoginEnabled: "true", dbuser.OptACLKeys: "~app:*\n%R~ro:*", dbuser.OptACLChannels: "&news",
			dbuser.OptACLCommands: "+@read\n-flushall", dbuser.OptACLSelectors: "(~cache:* +get)"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ACL", "SETUSER", "app", "on", "resetpass", ">p w", "resetkeys", "~app:*", "%R~ro:*", "resetchannels", "&news", "-@all", "+@read", "-flushall", "clearselectors", "(~cache:* +get)"}
	if !reflect.DeepEqual(plan.Statements[0].Args, want) {
		t.Fatalf("args: %q", plan.Statements[0].Args)
	}
	if strings.Contains(plan.Statements[0].Display, "p w") || !strings.Contains(plan.Statements[0].Display, ">******") {
		t.Fatalf("display must mask password: %s", plan.Statements[0].Display)
	}
	if len(plan.Statements) != 2 || !plan.Statements[1].Optional || plan.Statements[1].Display != "CONFIG REWRITE" {
		t.Fatalf("persistence statement: %+v", plan.Statements)
	}
	retain, err := dbuser.BuildPlan(New(), profile, dbuser.ChangeRequest{
		Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"},
		Password: &dbuser.PasswordChange{Set: true, Password: "second", RetainCurrent: true}, Options: map[string]string{dbuser.OptACLPersist: "false"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(retain.Statements[0].Args, []string{"ACL", "SETUSER", "app", ">second"}) || len(retain.Statements) != 1 {
		t.Fatalf("retain current password: %+v", retain.Statements)
	}
	for name, request := range map[string]dbuser.ChangeRequest{
		"rule injection":          {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"}, Options: map[string]string{dbuser.OptACLKeys: "~a nopass"}},
		"command injection":       {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"}, Options: map[string]string{dbuser.OptACLCommands: "on"}},
		"selector nesting":        {Action: dbuser.ActionAlter, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"}, Options: map[string]string{dbuser.OptACLSelectors: "((~a))"}},
		"space in name":           {Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "a b"}, Password: &dbuser.PasswordChange{Set: true, Password: "x"}},
		"drop default":            {Action: dbuser.ActionDrop, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "default"}},
		"create without password": {Action: dbuser.ActionCreate, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "x"}},
	} {
		if _, err := dbuser.BuildPlan(New(), profile, request); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestClusterAppliesOnEveryNodeAndReportsDrift(t *testing.T) {
	commands := newFake("7.2.4", "cluster")
	commands.nodes["ACL LIST"] = []dbuser.NodeResult{
		{Node: "10.0.0.1:7000", Result: []any{"user default on nopass ~* &* +@all", "user app on #h1 ~app:* -@all +@read"}},
		{Node: "10.0.0.2:7000", Result: []any{"user default on nopass ~* &* +@all", "user app on #h1 ~app:* -@all +@read +@write"}},
	}
	profile := probe(t, commands)
	principals, err := New().List(context.Background(), dbuser.Env{Commands: commands}, profile, dbuser.ListQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(principals) != 2 || !strings.Contains(strings.Join(principals[0].Tags, ","), "drift") || len(principals[1].Tags) != 1 {
		t.Fatalf("drift detection: %+v", principals)
	}
	plan, err := dbuser.BuildPlan(New(), profile, dbuser.ChangeRequest{Action: dbuser.ActionDrop, Target: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"}})
	if err != nil {
		t.Fatal(err)
	}
	if !plan.Statements[0].EachNode || !plan.Statements[1].EachNode {
		t.Fatalf("cluster statements must run on each node: %+v", plan.Statements)
	}
	commands.nodes["ACL DELUSER app"] = []dbuser.NodeResult{{Node: "a"}, {Node: "b", Err: errors.New("NOPERM")}}
	commands.nodes["CONFIG REWRITE"] = []dbuser.NodeResult{{Node: "a"}, {Node: "b"}}
	report := dbuser.Execute(context.Background(), dbuser.Env{Commands: commands}, plan, &dbuser.Secrets{})
	if report.FailedIndex != 1 || len(report.Results) < 2 || report.Results[1].Node != "b" {
		t.Fatalf("per-node failure must be reported: %+v", report)
	}
}

func TestDescribeAndExportMaskHashes(t *testing.T) {
	commands := newFake("7.2.4", "standalone")
	profile := probe(t, commands)
	detail, err := New().Describe(context.Background(), dbuser.Env{Commands: commands}, profile, dbuser.DescribeQuery{Ref: dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"}})
	if err != nil {
		t.Fatal(err)
	}
	if detail.Options[dbuser.OptACLCommands] != "-@all\n+@read\n+@write\n-flushall" || detail.Options[dbuser.OptACLSelectors] != "(~cache:* +get)" {
		t.Fatalf("describe: %+v", detail.Options)
	}
	ddl, err := New().ExportDDL(context.Background(), dbuser.Env{Commands: commands}, profile, dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: "app"})
	if err != nil || strings.Contains(ddl, "#2e0c") || !strings.Contains(ddl, "#******") {
		t.Fatalf("export: %s %v", ddl, err)
	}
}
