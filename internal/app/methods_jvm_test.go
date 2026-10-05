package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/jvm"
)

type fakeJVMProvider struct {
	testErr    error
	probe      []jvm.Capability
	probeErr   error
	list       []jvm.ResourceSummary
	listErr    error
	value      jvm.ValueSnapshot
	valueErr   error
	preview    jvm.ChangePreview
	previewSet bool
	previewErr error
	apply      jvm.ApplyResult
	applyErr   error
	applyFn    func(context.Context, connection.ConnectionConfig, jvm.ChangeRequest) (jvm.ApplyResult, error)
	previewReq *jvm.ChangeRequest
	applyReq   *jvm.ChangeRequest
}

func (f fakeJVMProvider) Mode() string { return jvm.ModeJMX }
func (f fakeJVMProvider) TestConnection(context.Context, connection.ConnectionConfig) error {
	return f.testErr
}
func (f fakeJVMProvider) ProbeCapabilities(context.Context, connection.ConnectionConfig) ([]jvm.Capability, error) {
	return f.probe, f.probeErr
}
func (f fakeJVMProvider) ListResources(context.Context, connection.ConnectionConfig, string) ([]jvm.ResourceSummary, error) {
	return f.list, f.listErr
}
func (f fakeJVMProvider) GetValue(context.Context, connection.ConnectionConfig, string) (jvm.ValueSnapshot, error) {
	return f.value, f.valueErr
}
func (f fakeJVMProvider) PreviewChange(_ context.Context, _ connection.ConnectionConfig, req jvm.ChangeRequest) (jvm.ChangePreview, error) {
	if f.previewReq != nil {
		*f.previewReq = req
	}
	if !f.previewSet {
		return jvm.ChangePreview{Allowed: true, Summary: "preview", RiskLevel: "low"}, f.previewErr
	}
	return f.preview, f.previewErr
}
func (f fakeJVMProvider) ApplyChange(ctx context.Context, cfg connection.ConnectionConfig, req jvm.ChangeRequest) (jvm.ApplyResult, error) {
	if f.applyReq != nil {
		*f.applyReq = req
	}
	if f.applyFn != nil {
		return f.applyFn(ctx, cfg, req)
	}
	return f.apply, f.applyErr
}

func swapJVMProviderFactory(factory func(mode string) (jvm.Provider, error)) func() {
	prev := newJVMProvider
	newJVMProvider = factory
	return func() { newJVMProvider = prev }
}

func forceAuditAppendFailureAfterPending(t *testing.T, auditDir string) {
	t.Helper()

	auditPath := filepath.Join(auditDir, "jvm_audit.jsonl")
	if err := os.Remove(auditPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Remove audit file returned error: %v", err)
	}
	if err := os.RemoveAll(auditDir); err != nil {
		t.Fatalf("RemoveAll audit dir returned error: %v", err)
	}
	if err := os.WriteFile(auditDir, []byte("blocker"), 0o600); err != nil {
		t.Fatalf("WriteFile audit dir blocker returned error: %v", err)
	}
}

func expectedAuditAppendError(t *testing.T, auditRoot string) string {
	t.Helper()

	err := jvm.NewAuditStore(filepath.Join(auditRoot, "jvm_audit.jsonl")).Append(jvm.AuditRecord{
		Timestamp:    1,
		ConnectionID: "conn-orders",
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "expected raw audit append error",
		Result:       "pending",
	})
	if err == nil {
		t.Fatalf("expected audit append to fail for %q", auditRoot)
	}
	return err.Error()
}

func setJVMTestLanguage(t *testing.T, app *App, language string) {
	t.Helper()
	app.SetLanguage(language)
	t.Cleanup(func() {
		app.SetLanguage("zh-CN")
	})
}

func assertEnglishJVMConfirmationMessage(t *testing.T, got string, want string) {
	t.Helper()

	if got != want {
		t.Fatalf("expected English confirmation message %q, got %q", want, got)
	}
	for _, text := range []string{"确认", "令牌", "预览", "重新"} {
		if strings.Contains(got, text) {
			t.Fatalf("expected no Chinese confirmation text %q in message %q", text, got)
		}
	}
}

func TestTestJVMConnectionUsesPreferredProvider(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	var gotMode string
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		gotMode = mode
		return fakeJVMProvider{}, nil
	})
	defer restore()

	res := app.TestJVMConnection(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "endpoint",
			AllowedModes:  []string{"jmx", "endpoint"},
		},
	})

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	if gotMode != "endpoint" {
		t.Fatalf("expected provider mode endpoint, got %q", gotMode)
	}
	if res.Message != "JVM connection succeeded" {
		t.Fatalf("expected success message %q, got %q", "JVM connection succeeded", res.Message)
	}
}

func TestTestJVMConnectionReturnsProviderError(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{testErr: errors.New("dial failed")}, nil
	})
	defer restore()

	res := app.TestJVMConnection(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	})

	if res.Success {
		t.Fatalf("expected failure, got %+v", res)
	}
	if res.Message != "dial failed" {
		t.Fatalf("expected message %q, got %q", "dial failed", res.Message)
	}
}

func TestTestJVMConnectionTranslatesJMXBusinessPortError(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "zh-CN")
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{testErr: errors.New("jmx test connection failed: jmx helper ping failed for localhost:18080: JMX command ping failed for localhost:18080: Failed to retrieve RMIServer stub: javax.naming.CommunicationException [Root exception is java.rmi.ConnectIOException: non-JRMP server at remote endpoint]; details={\"exception\":\"java.lang.IllegalStateException\"}")}, nil
	})
	defer restore()

	res := app.TestJVMConnection(connection.ConnectionConfig{
		Type: "jvm",
		Host: "localhost",
		Port: 18080,
		JVM: connection.JVMConfig{
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	})

	if res.Success {
		t.Fatalf("expected failure, got %+v", res)
	}
	if !strings.Contains(res.Message, "不是标准 JMX 远程管理端口") {
		t.Fatalf("expected translated summary, got %q", res.Message)
	}
	if !strings.Contains(res.Message, "业务 `server.port`") {
		t.Fatalf("expected actionable suggestion, got %q", res.Message)
	}
	if !strings.Contains(res.Message, "技术细节：") {
		t.Fatalf("expected raw technical detail to be preserved, got %q", res.Message)
	}
}

func TestTestJVMConnectionLocalizesJMXBusinessPortErrorInEnglish(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{testErr: errors.New("jmx test connection failed: jmx helper ping failed for localhost:18080: JMX command ping failed for localhost:18080: Failed to retrieve RMIServer stub: javax.naming.CommunicationException [Root exception is java.rmi.ConnectIOException: non-JRMP server at remote endpoint]; details={\"exception\":\"java.lang.IllegalStateException\"}")}, nil
	})
	defer restore()

	res := app.TestJVMConnection(connection.ConnectionConfig{
		Type: "jvm",
		Host: "localhost",
		Port: 18080,
		JVM: connection.JVMConfig{
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	})

	if res.Success {
		t.Fatalf("expected failure, got %+v", res)
	}
	if !strings.Contains(res.Message, "JMX connection failed: localhost:18080 is not a standard JMX remote management port") {
		t.Fatalf("expected English translated summary, got %q", res.Message)
	}
	if !strings.Contains(res.Message, "business `server.port`") {
		t.Fatalf("expected English actionable suggestion, got %q", res.Message)
	}
	if !strings.Contains(res.Message, "Technical detail:") {
		t.Fatalf("expected English technical detail wrapper, got %q", res.Message)
	}
}

func TestTestJVMConnectionTranslatesAgentConnectionRefused(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "zh-CN")
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{testErr: errors.New("agent probe request failed: Get \"http://127.0.0.1:19090/gonavi/agent/jvm\": dial tcp 127.0.0.1:19090: connect: connection refused")}, nil
	})
	defer restore()

	res := app.TestJVMConnection(connection.ConnectionConfig{
		Type: "jvm",
		Host: "127.0.0.1",
		JVM: connection.JVMConfig{
			PreferredMode: "agent",
			AllowedModes:  []string{"agent"},
		},
	})

	if res.Success {
		t.Fatalf("expected failure, got %+v", res)
	}
	if !strings.Contains(res.Message, "目标 Agent 管理端口未监听") {
		t.Fatalf("expected translated summary, got %q", res.Message)
	}
	if !strings.Contains(res.Message, "`-javaagent`") {
		t.Fatalf("expected actionable suggestion, got %q", res.Message)
	}
}

func TestTestJVMConnectionLocalizesAgentConnectionRefusedInEnglish(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{testErr: errors.New("agent probe request failed: Get \"http://127.0.0.1:19090/gonavi/agent/jvm\": dial tcp 127.0.0.1:19090: connect: connection refused")}, nil
	})
	defer restore()

	res := app.TestJVMConnection(connection.ConnectionConfig{
		Type: "jvm",
		Host: "127.0.0.1",
		JVM: connection.JVMConfig{
			PreferredMode: "agent",
			AllowedModes:  []string{"agent"},
		},
	})

	if res.Success {
		t.Fatalf("expected failure, got %+v", res)
	}
	if !strings.Contains(res.Message, "Agent connection failed: the target Agent management port is not listening, or the address is unreachable.") {
		t.Fatalf("expected English agent summary, got %q", res.Message)
	}
	if !strings.Contains(res.Message, "Suggestion: Confirm the Java service started GoNavi Agent with `-javaagent`") {
		t.Fatalf("expected English actionable suggestion, got %q", res.Message)
	}
	if !strings.Contains(res.Message, `Technical detail: agent probe request failed: Get "http://127.0.0.1:19090/gonavi/agent/jvm": dial tcp 127.0.0.1:19090: connect: connection refused`) {
		t.Fatalf("expected raw technical detail to be preserved with English wrapper, got %q", res.Message)
	}
}

func TestTestJVMConnectionLocalizesEndpointErrorInEnglish(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{testErr: errors.New(`endpoint baseurl is invalid: parse ":bad-url": missing protocol scheme`)}, nil
	})
	defer restore()

	res := app.TestJVMConnection(connection.ConnectionConfig{
		Type: "jvm",
		Host: "127.0.0.1",
		JVM: connection.JVMConfig{
			PreferredMode: "endpoint",
			AllowedModes:  []string{"endpoint"},
		},
	})

	if res.Success {
		t.Fatalf("expected failure, got %+v", res)
	}
	if !strings.Contains(res.Message, "Endpoint connection failed: Endpoint Base URL is invalid.") {
		t.Fatalf("expected English endpoint summary, got %q", res.Message)
	}
	if !strings.Contains(res.Message, "Suggestion: Enter a full http:// or https:// URL") {
		t.Fatalf("expected English actionable suggestion, got %q", res.Message)
	}
	if !strings.Contains(res.Message, `Technical detail: endpoint baseurl is invalid: parse ":bad-url": missing protocol scheme`) {
		t.Fatalf("expected raw technical detail to be preserved with English wrapper, got %q", res.Message)
	}
}

func TestTestJVMConnectionReturnsProviderFactoryError(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return nil, errors.New("factory unavailable")
	})
	defer restore()

	res := app.TestJVMConnection(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "endpoint",
			AllowedModes:  []string{"endpoint"},
		},
	})

	if res.Success {
		t.Fatalf("expected failure, got %+v", res)
	}
	if res.Message != "factory unavailable" {
		t.Fatalf("expected message %q, got %q", "factory unavailable", res.Message)
	}
}
