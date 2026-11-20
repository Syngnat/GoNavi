package app

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/webidentity"
)

func saveScriptWorkbenchEnvironmentConnection(
	t *testing.T,
	application *App,
	name string,
	environment string,
) connection.SavedConnectionView {
	t.Helper()
	view, err := application.SaveConnection(connection.SavedConnectionInput{
		Name:            name,
		EnvironmentType: environment,
		Config: connection.ConnectionConfig{
			Type:     "postgres",
			Host:     "127.0.0.1",
			Port:     5432,
			User:     "tester",
			Database: "main",
		},
	})
	if err != nil {
		t.Fatalf("save connection: %v", err)
	}
	return view
}

func scriptWorkbenchWriteApprovalForTest(
	t *testing.T,
	application *App,
	ctx context.Context,
	request ScriptWorkbenchRunRequest,
) ScriptWorkbenchWriteApproval {
	t.Helper()
	result := application.prepareScriptWorkbenchWriteContext(ctx, request)
	if !result.Success {
		t.Fatalf("prepare write approval: %s", result.Message)
	}
	approval, ok := result.Data.(ScriptWorkbenchWriteApproval)
	if !ok {
		t.Fatalf("write approval data type = %T", result.Data)
	}
	return approval
}

func TestScriptWorkbenchProductionWriteRequiresOneTimeToken(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, true)
	production := saveScriptWorkbenchEnvironmentConnection(t, application, "prod", "production")
	ctx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleAdmin,
	})
	request := ScriptWorkbenchRunRequest{
		Script:     "1 + 1",
		AllowWrite: true,
		Connections: []ScriptWorkbenchConnection{{
			Alias:        "prod",
			ConnectionID: production.ID,
			Database:     "main",
		}},
	}
	actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)
	if _, err := application.prepareScriptWorkbenchRun(ctx, request, actor, webActor); err == nil ||
		!strings.Contains(err.Error(), "token is required") {
		t.Fatalf("missing token error = %v", err)
	}

	approval := scriptWorkbenchWriteApprovalForTest(t, application, ctx, request)
	if !approval.Required || strings.TrimSpace(approval.Token) == "" || approval.ExpiresAt == 0 {
		t.Fatalf("unexpected write approval: %+v", approval)
	}
	request.WriteApprovalToken = approval.Token
	prepared, err := application.prepareScriptWorkbenchRun(ctx, request, actor, webActor)
	if err != nil {
		t.Fatalf("run with approval: %v", err)
	}
	if !prepared.requiresWriteApproval {
		t.Fatal("production write should require approval")
	}
	if _, err := application.prepareScriptWorkbenchRun(ctx, request, actor, webActor); err == nil ||
		!strings.Contains(err.Error(), "already used") {
		t.Fatalf("reused token error = %v", err)
	}
}

func TestScriptWorkbenchWriteApprovalBindsScriptConnectionAndInputs(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, true)
	production := saveScriptWorkbenchEnvironmentConnection(t, application, "prod", "production")
	otherProduction := saveScriptWorkbenchEnvironmentConnection(t, application, "prod-2", "production")
	upload, err := StageWebUploadForEntryPointForOwner(
		application,
		webUploadPurposeScriptInput,
		"rows.csv",
		strings.NewReader("id\n1\n"),
		"alice",
	)
	if err != nil {
		t.Fatalf("stage input upload: %v", err)
	}
	ctx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleAdmin,
	})
	base := ScriptWorkbenchRunRequest{
		Script:     "1 + 1",
		AllowWrite: true,
		Connections: []ScriptWorkbenchConnection{{
			Alias:        "prod",
			ConnectionID: production.ID,
			Database:     "main",
		}},
		Inputs: []ScriptWorkbenchInput{{
			Alias:     "rows",
			Reference: upload.FilePath,
			Name:      "rows.csv",
		}},
	}
	actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)

	cases := []struct {
		name   string
		mutate func(*ScriptWorkbenchRunRequest)
	}{
		{name: "script", mutate: func(request *ScriptWorkbenchRunRequest) { request.Script = "1 + 2" }},
		{name: "connection", mutate: func(request *ScriptWorkbenchRunRequest) {
			request.Connections[0].ConnectionID = otherProduction.ID
		}},
		{name: "database", mutate: func(request *ScriptWorkbenchRunRequest) {
			request.Connections[0].Database = "other"
		}},
		{name: "input", mutate: func(request *ScriptWorkbenchRunRequest) {
			request.Inputs[0].Name = "changed.csv"
		}},
		{name: "batch size", mutate: func(request *ScriptWorkbenchRunRequest) {
			request.BatchSize = 100
		}},
		{name: "IN list limit", mutate: func(request *ScriptWorkbenchRunRequest) {
			request.INListLimit = 100
		}},
		{name: "timeout", mutate: func(request *ScriptWorkbenchRunRequest) {
			request.TimeoutMs = 2 * 60 * 1_000
		}},
		{name: "database calls", mutate: func(request *ScriptWorkbenchRunRequest) {
			request.MaxDBCalls = 20_000
		}},
		{name: "output rows", mutate: func(request *ScriptWorkbenchRunRequest) {
			request.MaxOutputRows = 80_000
		}},
		{name: "worker memory", mutate: func(request *ScriptWorkbenchRunRequest) {
			request.MemoryLimitBytes = 768 << 20
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			approval := scriptWorkbenchWriteApprovalForTest(t, application, ctx, base)
			request := base
			request.Connections = append([]ScriptWorkbenchConnection(nil), base.Connections...)
			request.Inputs = append([]ScriptWorkbenchInput(nil), base.Inputs...)
			testCase.mutate(&request)
			request.WriteApprovalToken = approval.Token
			if _, err := application.prepareScriptWorkbenchRun(ctx, request, actor, webActor); err == nil ||
				!strings.Contains(err.Error(), "does not match") {
				t.Fatalf("mutated %s token error = %v", testCase.name, err)
			}
		})
	}

	noInputRequest := base
	noInputRequest.Inputs = nil
	approval := scriptWorkbenchWriteApprovalForTest(t, application, ctx, noInputRequest)
	otherCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "bob",
		Role:     webidentity.RoleAdmin,
	})
	otherActor, otherWebActor := scriptWorkbenchActorForTest(t, application, otherCtx)
	request := noInputRequest
	request.WriteApprovalToken = approval.Token
	if _, err := application.prepareScriptWorkbenchRun(otherCtx, request, otherActor, otherWebActor); err == nil ||
		!strings.Contains(err.Error(), "does not match") {
		t.Fatalf("cross-actor token error = %v", err)
	}
	if _, err := application.prepareScriptWorkbenchRun(ctx, request, actor, webActor); err != nil {
		t.Fatalf("a mismatched attempt must not consume the approval token: %v", err)
	}
}

func TestScriptWorkbenchNonProductionWriteNeedsNoToken(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, true)
	testConnection := saveScriptWorkbenchEnvironmentConnection(t, application, "test", "test")
	ctx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleAdmin,
	})
	request := ScriptWorkbenchRunRequest{
		Script:     "1 + 1",
		AllowWrite: true,
		Connections: []ScriptWorkbenchConnection{{
			Alias:        "test",
			ConnectionID: testConnection.ID,
			Database:     "main",
		}},
	}
	approval := scriptWorkbenchWriteApprovalForTest(t, application, ctx, request)
	if approval.Required || approval.Token != "" {
		t.Fatalf("non-production approval = %+v", approval)
	}
	actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)
	if _, err := application.prepareScriptWorkbenchRun(ctx, request, actor, webActor); err != nil {
		t.Fatalf("non-production run without token: %v", err)
	}
}

func TestScriptWorkbenchWriteApprovalExpires(t *testing.T) {
	previousTTL := scriptWorkbenchWriteApprovalTTL
	scriptWorkbenchWriteApprovalTTL = time.Nanosecond
	t.Cleanup(func() { scriptWorkbenchWriteApprovalTTL = previousTTL })

	application := newScriptWorkbenchTestApp(t, true)
	production := saveScriptWorkbenchEnvironmentConnection(t, application, "prod", "production")
	ctx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleAdmin,
	})
	request := ScriptWorkbenchRunRequest{
		Script:     "1 + 1",
		AllowWrite: true,
		Connections: []ScriptWorkbenchConnection{{
			Alias:        "prod",
			ConnectionID: production.ID,
			Database:     "main",
		}},
	}
	approval := scriptWorkbenchWriteApprovalForTest(t, application, ctx, request)
	time.Sleep(time.Millisecond)
	request.WriteApprovalToken = approval.Token
	actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)
	if _, err := application.prepareScriptWorkbenchRun(ctx, request, actor, webActor); err == nil ||
		!strings.Contains(err.Error(), "expired") {
		t.Fatalf("expired token error = %v", err)
	}
}

func TestScriptWorkbenchPendingWriteApprovalsAreBounded(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, true)
	production := saveScriptWorkbenchEnvironmentConnection(t, application, "prod", "production")
	ctx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleAdmin,
	})
	request := ScriptWorkbenchRunRequest{
		Script:     "1 + 1",
		AllowWrite: true,
		Connections: []ScriptWorkbenchConnection{{
			Alias:        "prod",
			ConnectionID: production.ID,
			Database:     "main",
		}},
	}
	actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)
	prepared, err := application.buildScriptWorkbenchPreparedRun(ctx, request, actor, webActor)
	if err != nil {
		t.Fatalf("build prepared run: %v", err)
	}
	for index := 0; index < scriptWorkbenchMaxPendingWriteApprovals+8; index++ {
		if _, _, err := application.issueScriptWorkbenchWriteApproval(prepared); err != nil {
			t.Fatalf("issue approval %d: %v", index, err)
		}
	}
	application.scriptWorkbench.approvalMu.Lock()
	size := len(application.scriptWorkbench.approvals)
	application.scriptWorkbench.approvalMu.Unlock()
	if size != scriptWorkbenchMaxPendingWriteApprovals {
		t.Fatalf("pending approvals = %d, want %d", size, scriptWorkbenchMaxPendingWriteApprovals)
	}
}

func TestScriptWorkbenchWebInputErrorsDoNotExposeServerPaths(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, true)
	upload, err := StageWebUploadForEntryPointForOwner(
		application,
		webUploadPurposeScriptInput,
		"rows.csv",
		strings.NewReader("id\n1\n"),
		"alice",
	)
	if err != nil {
		t.Fatalf("stage input upload: %v", err)
	}
	actualPath, err := application.resolveWebUploadReferenceForOwner(
		upload.FilePath,
		webUploadPurposeScriptInput,
		"alice",
	)
	if err != nil {
		t.Fatalf("resolve input upload: %v", err)
	}
	if err := os.Remove(actualPath); err != nil {
		t.Fatalf("remove input upload: %v", err)
	}
	ctx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleAdmin,
	})
	actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)
	_, err = application.prepareScriptWorkbenchInput(
		"rows",
		ScriptWorkbenchInput{Alias: "rows", Reference: upload.FilePath},
		actor,
		webActor,
		500,
	)
	if !errors.Is(err, ErrWebTransferNotFound) {
		t.Fatalf("missing input error = %v, want ErrWebTransferNotFound", err)
	}
	message := err.Error()
	if strings.Contains(message, application.configDir) ||
		strings.Contains(message, actualPath) ||
		strings.Contains(message, "no such file") {
		t.Fatalf("web input error leaks a server path: %q", message)
	}
}

func TestPrepareScriptWorkbenchWriteUsesRequestContext(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, true)
	production := saveScriptWorkbenchEnvironmentConnection(t, application, "prod", "production")
	request := ScriptWorkbenchRunRequest{
		Script:     "1 + 1",
		AllowWrite: true,
		Connections: []ScriptWorkbenchConnection{{
			Alias:        "prod",
			ConnectionID: production.ID,
			Database:     "main",
		}},
	}
	if result := application.PrepareScriptWorkbenchWrite(request); result.Success {
		t.Fatal("web prepare without a request actor must fail")
	}

	handlers := WebRPCContextHandlers(application)
	handler, ok := handlers["PrepareScriptWorkbenchWrite"].(func(context.Context, ScriptWorkbenchRunRequest) connection.QueryResult)
	if !ok {
		t.Fatalf("PrepareScriptWorkbenchWrite handler type = %T", handlers["PrepareScriptWorkbenchWrite"])
	}
	ctx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleAdmin,
	})
	result := handler(ctx, request)
	if !result.Success {
		t.Fatalf("context-bound prepare failed: %s", result.Message)
	}
}
