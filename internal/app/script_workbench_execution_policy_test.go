package app

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestScriptWorkbenchMCPPolicyRejectsWriteAtReadOnlyLevel(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	ctx := context.Background()
	actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)

	_, err := application.buildScriptWorkbenchPreparedRun(ctx, ScriptWorkbenchRunRequest{
		Script:     "gonavi.log('read');",
		AllowWrite: true,
		ExecutionPolicy: &ScriptWorkbenchExecutionPolicy{
			AllowWrites: false,
			AllowDDL:    false,
		},
	}, actor, webActor)
	if err == nil || !strings.Contains(err.Error(), "blocked by the current AI safety level") {
		t.Fatalf("read-only policy write error = %v", err)
	}

	prepared, err := application.buildScriptWorkbenchPreparedRun(ctx, ScriptWorkbenchRunRequest{
		Script:     "gonavi.log('read');",
		AllowWrite: false,
		ExecutionPolicy: &ScriptWorkbenchExecutionPolicy{
			AllowWrites: false,
			AllowDDL:    false,
		},
	}, actor, webActor)
	if err != nil {
		t.Fatalf("read-only script should still run: %v", err)
	}
	if prepared.executionPolicy == nil || prepared.executionPolicy.AllowWrites {
		t.Fatalf("prepared policy = %#v", prepared.executionPolicy)
	}
}

func TestScriptWorkbenchMCPPolicyBlocksDDLButAllowsDML(t *testing.T) {
	host := &scriptWorkbenchHost{
		prepared: &scriptWorkbenchPrepared{
			allowWrite: true,
			executionPolicy: &ScriptWorkbenchExecutionPolicy{
				AllowWrites: true,
				AllowDDL:    false,
			},
		},
	}
	prepared := scriptPreparedConnection{
		config: connection.ConnectionConfig{Type: "mysql"},
		dbType: "mysql",
	}

	if err := host.ensureWriteAllowed(prepared, "UPDATE users SET active = 1"); err != nil {
		t.Fatalf("read-write safety should allow DML: %v", err)
	}
	if err := host.ensureWriteAllowed(prepared, "CREATE TABLE audit_log (id BIGINT)"); err == nil ||
		!strings.Contains(err.Error(), "script DDL is blocked") {
		t.Fatalf("read-write safety DDL error = %v", err)
	}
}

func TestScriptWorkbenchMCPPolicyAllowsDDLAtFullLevel(t *testing.T) {
	host := &scriptWorkbenchHost{
		prepared: &scriptWorkbenchPrepared{
			allowWrite: true,
			executionPolicy: &ScriptWorkbenchExecutionPolicy{
				AllowWrites: true,
				AllowDDL:    true,
			},
		},
	}
	prepared := scriptPreparedConnection{
		config: connection.ConnectionConfig{Type: "mysql"},
		dbType: "mysql",
	}
	if err := host.ensureWriteAllowed(prepared, "CREATE TABLE audit_log (id BIGINT)"); err != nil {
		t.Fatalf("full safety should allow DDL: %v", err)
	}
}

func TestScriptWorkbenchUIPolicyRemainsUnrestricted(t *testing.T) {
	host := &scriptWorkbenchHost{
		prepared: &scriptWorkbenchPrepared{allowWrite: true},
	}
	prepared := scriptPreparedConnection{
		config: connection.ConnectionConfig{Type: "mysql"},
		dbType: "mysql",
	}
	if err := host.ensureWriteAllowed(prepared, "CREATE TABLE audit_log (id BIGINT)"); err != nil {
		t.Fatalf("nil execution policy should preserve desktop behavior: %v", err)
	}
}
