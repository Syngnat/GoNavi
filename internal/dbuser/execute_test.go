package dbuser

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeExecutor struct {
	executed []string
	failOn   string
	failText string
}

func (f *fakeExecutor) Query(context.Context, string, string) ([]map[string]any, error) {
	return nil, nil
}

func (f *fakeExecutor) Exec(_ context.Context, database, statement string) error {
	f.executed = append(f.executed, database+"|"+statement)
	if f.failOn != "" && strings.Contains(statement, f.failOn) {
		return errors.New(f.failText)
	}
	return nil
}

type fakeSessions struct {
	executed []string
	failOn   string
	opened   int
	closed   int
}

func (f *fakeSessions) OpenSession(_ context.Context, database string) (Session, error) {
	f.opened++
	f.executed = append(f.executed, "open:"+database)
	return &fakeSession{parent: f}, nil
}

type fakeSession struct{ parent *fakeSessions }

func (s *fakeSession) Exec(_ context.Context, statement string) error {
	s.parent.executed = append(s.parent.executed, statement)
	if s.parent.failOn != "" && strings.Contains(statement, s.parent.failOn) {
		return errors.New("boom " + statement)
	}
	return nil
}

func (s *fakeSession) Close() error {
	s.parent.closed++
	return nil
}

func plan(statements ...Statement) Plan {
	return Plan{Statements: statements}
}

func TestExecuteSequentialStopsAtFirstFailureAndSanitizes(t *testing.T) {
	executor := &fakeExecutor{failOn: "GRANT", failText: "syntax error near 'hunter22'"}
	var secrets Secrets
	secrets.Add("hunter22")
	report := Execute(context.Background(), Env{SQL: executor}, plan(
		Plain("CREATE USER a", "", RiskNormal),
		Plain("GRANT SELECT", "", RiskNormal),
		Plain("GRANT UPDATE", "", RiskNormal),
	), &secrets)
	if report.FailedIndex != 2 || report.ExecutedCount != 1 {
		t.Fatalf("failedIndex=%d executed=%d", report.FailedIndex, report.ExecutedCount)
	}
	if len(executor.executed) != 2 {
		t.Fatalf("must stop after failure: %v", executor.executed)
	}
	if !report.Results[2].Skipped {
		t.Fatal("remaining statements must be skipped")
	}
	if strings.Contains(report.Results[1].Error, "hunter22") {
		t.Fatalf("error leaks password: %s", report.Results[1].Error)
	}
}

func TestExecuteOptionalFailureContinues(t *testing.T) {
	executor := &fakeExecutor{failOn: "SAVE", failText: "no aclfile"}
	optional := Plain("ACL SAVE", "", RiskNormal)
	optional.Optional = true
	report := Execute(context.Background(), Env{SQL: executor}, plan(Plain("A", "", RiskNormal), optional), &Secrets{})
	if report.Failed() || report.ExecutedCount != 1 || len(report.Notices) != 1 {
		t.Fatalf("optional failure must only warn: %+v", report)
	}
}

func TestExecuteTransactionalGroupsByDatabaseAndRollsBack(t *testing.T) {
	sessions := &fakeSessions{failOn: "GRANT BAD"}
	report := Execute(context.Background(), Env{Sessions: sessions}, Plan{Transactional: true, Statements: []Statement{
		Plain("CREATE ROLE r", "", RiskNormal),
		Plain("GRANT SELECT ON t TO r", "sales", RiskNormal),
		Plain("GRANT BAD", "sales", RiskNormal),
		Plain("COMMENT", "", RiskNormal),
	}}, &Secrets{})
	if report.FailedIndex != 3 || !report.RolledBack {
		t.Fatalf("failedIndex=%d rolledBack=%v", report.FailedIndex, report.RolledBack)
	}
	if report.ExecutedCount != 1 {
		t.Fatalf("only first group should count as committed, got %d", report.ExecutedCount)
	}
	joined := strings.Join(sessions.executed, ";")
	for _, want := range []string{"open:;BEGIN;CREATE ROLE r;COMMIT", "open:sales;BEGIN;GRANT SELECT ON t TO r;GRANT BAD;ROLLBACK"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in %s", want, joined)
		}
	}
	if strings.Contains(joined, "COMMENT") {
		t.Fatal("statements after failure must not run")
	}
	if sessions.opened != sessions.closed {
		t.Fatalf("sessions leaked: opened=%d closed=%d", sessions.opened, sessions.closed)
	}
	if !report.Results[1].Skipped || report.Results[1].Success {
		t.Fatalf("rolled back statement must not be reported as success: %+v", report.Results[1])
	}
	if !report.Results[3].Skipped {
		t.Fatal("trailing statement must be skipped")
	}
}

func TestExecuteTransactionalFallsBackWithoutSessions(t *testing.T) {
	executor := &fakeExecutor{}
	report := Execute(context.Background(), Env{SQL: executor}, Plan{Transactional: true, Statements: []Statement{
		Plain("A", "", RiskNormal),
	}}, &Secrets{})
	if report.Failed() || len(report.Notices) != 1 || report.Notices[0].Code != NoticeTransactionFallback {
		t.Fatalf("expected fallback notice: %+v", report)
	}
}

func TestFingerprintIgnoresPasswordButTracksStatementsAndDialect(t *testing.T) {
	profile := ServerProfile{Family: FamilyMySQL, Version: Version{Raw: "8.0.36"}, Dialect: map[string]string{"backslash": "true"}}
	build := func(password string) Plan {
		var builder SQLBuilder
		builder.Write("CREATE USER x IDENTIFIED BY ").Secret(MySQLString(password, true), Masked("'", "'"))
		return Plan{Statements: []Statement{builder.Statement("", RiskNormal)}}
	}
	if Fingerprint(profile, build("a")) != Fingerprint(profile, build("b")) {
		t.Fatal("password must not affect fingerprint")
	}
	changed := profile
	changed.Dialect = map[string]string{"backslash": "false"}
	if Fingerprint(profile, build("a")) == Fingerprint(changed, build("a")) {
		t.Fatal("dialect change must affect fingerprint")
	}
	other := Plan{Statements: []Statement{Plain("DROP USER x", "", RiskDanger)}}
	if Fingerprint(profile, build("a")) == Fingerprint(profile, other) {
		t.Fatal("different statements must differ")
	}
}
