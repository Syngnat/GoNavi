package app

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/jvm"
)

type fakeJVMMonitoringManager struct {
	startSnapshot     jvm.MonitoringSessionSnapshot
	startErr          error
	historySnapshot   jvm.MonitoringSessionSnapshot
	historyErr        error
	stopErr           error
	startCfg          connection.ConnectionConfig
	startMode         string
	historyConnection string
	historyMode       string
	stopConnection    string
	stopMode          string
	shutdownCalls     int
}

func (f *fakeJVMMonitoringManager) Start(_ context.Context, cfg connection.ConnectionConfig, mode string) (jvm.MonitoringSessionSnapshot, error) {
	f.startCfg = cfg
	f.startMode = mode
	return f.startSnapshot, f.startErr
}

func (f *fakeJVMMonitoringManager) GetHistory(connectionID string, providerMode string) (jvm.MonitoringSessionSnapshot, error) {
	f.historyConnection = connectionID
	f.historyMode = providerMode
	return f.historySnapshot, f.historyErr
}

func (f *fakeJVMMonitoringManager) Stop(connectionID string, providerMode string) error {
	f.stopConnection = connectionID
	f.stopMode = providerMode
	return f.stopErr
}

func (f *fakeJVMMonitoringManager) Shutdown() {
	f.shutdownCalls++
}

func swapJVMMonitoringManager(manager jvmMonitoringService) func() {
	prev := currentJVMMonitoringManager
	currentJVMMonitoringManager = manager
	return func() { currentJVMMonitoringManager = prev }
}

func newJVMMonitoringTestApp(t *testing.T) *App {
	t.Helper()
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	return app
}

func saveJVMMonitoringConnection(t *testing.T, app *App, cfg connection.ConnectionConfig) connection.SavedConnectionView {
	t.Helper()
	view, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:     cfg.ID,
		Name:   "jvm-monitor",
		Config: cfg,
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}
	return view
}

func TestJVMStartMonitoringReturnsManagerSnapshot(t *testing.T) {
	app := newJVMMonitoringTestApp(t)
	manager := &fakeJVMMonitoringManager{
		startSnapshot: jvm.MonitoringSessionSnapshot{
			ConnectionID: "conn-monitor",
			ProviderMode: jvm.ModeEndpoint,
			Running:      true,
			Points: []jvm.JVMMonitoringPoint{
				{Timestamp: 1713945600000, ThreadCount: 21},
			},
		},
	}
	restore := swapJVMMonitoringManager(manager)
	defer restore()

	cfg := connection.ConnectionConfig{
		ID:   "conn-monitor",
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeEndpoint,
			AllowedModes:  []string{jvm.ModeEndpoint},
		},
	}
	saveJVMMonitoringConnection(t, app, cfg)

	res := app.JVMStartMonitoring(cfg)

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	snapshot, ok := res.Data.(jvm.MonitoringSessionSnapshot)
	if !ok {
		t.Fatalf("expected monitoring snapshot, got %#v", res.Data)
	}
	if !snapshot.Running || len(snapshot.Points) != 1 {
		t.Fatalf("unexpected snapshot: %#v", snapshot)
	}
	if manager.startCfg.ID != "conn-monitor" {
		t.Fatalf("expected manager to receive config ID, got %#v", manager.startCfg)
	}
}

func TestJVMStartMonitoringRestoresSavedCredentialsAfterReload(t *testing.T) {
	app := newJVMMonitoringTestApp(t)
	manager := &fakeJVMMonitoringManager{
		startSnapshot: jvm.MonitoringSessionSnapshot{
			ConnectionID: "conn-auth",
			ProviderMode: jvm.ModeEndpoint,
			Running:      true,
		},
	}
	restore := swapJVMMonitoringManager(manager)
	defer restore()

	saved := saveJVMMonitoringConnection(t, app, connection.ConnectionConfig{
		ID:   "conn-auth",
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeEndpoint,
			AllowedModes:  []string{jvm.ModeEndpoint, jvm.ModeJMX, jvm.ModeAgent},
			JMX:           connection.JVMJMXConfig{Enabled: true, Username: "monitor", Password: "jmx-secret"},
			Endpoint:      connection.JVMEndpointConfig{Enabled: true, BaseURL: "https://endpoint.local", APIKey: "endpoint-key"},
			Agent:         connection.JVMAgentConfig{Enabled: true, BaseURL: "https://agent.local", APIKey: "agent-key"},
		},
	})
	if saved.Config.JVM.JMX.Password != "" || saved.Config.JVM.Endpoint.APIKey != "" || saved.Config.JVM.Agent.APIKey != "" {
		t.Fatalf("saved connection view must not expose JVM credentials: %#v", saved.Config.JVM)
	}

	listed, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("expected one saved connection, got %d", len(listed))
	}
	if listed[0].Config.JVM.JMX.Password != "" || listed[0].Config.JVM.Endpoint.APIKey != "" || listed[0].Config.JVM.Agent.APIKey != "" {
		t.Fatalf("public connection list must not expose JVM credentials: %#v", listed[0].Config.JVM)
	}

	res := app.JVMStartMonitoring(listed[0].Config)
	if !res.Success {
		t.Fatalf("expected success after restoring saved credentials, got %+v", res)
	}
	if manager.startCfg.JVM.JMX.Password != "jmx-secret" ||
		manager.startCfg.JVM.Endpoint.APIKey != "endpoint-key" ||
		manager.startCfg.JVM.Agent.APIKey != "agent-key" {
		t.Fatalf("expected monitoring manager to receive restored credentials, got %#v", manager.startCfg.JVM)
	}
}

func TestJVMStartMonitoringReturnsClearErrorWhenSavedCredentialsMissing(t *testing.T) {
	app := newJVMMonitoringTestApp(t)
	app.SetLanguage("en-US")
	manager := &fakeJVMMonitoringManager{}
	restore := swapJVMMonitoringManager(manager)
	defer restore()

	res := app.JVMStartMonitoring(connection.ConnectionConfig{
		ID:   "conn-missing-secret",
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeEndpoint,
			AllowedModes:  []string{jvm.ModeEndpoint},
		},
	})
	if res.Success {
		t.Fatalf("expected missing-credential failure, got %+v", res)
	}
	want := "The saved secret for the current connection was not found. Re-enter the password, save, and try again."
	if res.Message != want {
		t.Fatalf("expected missing-credential message %q, got %#v", want, res)
	}
	if manager.startCfg.ID != "" {
		t.Fatalf("expected monitoring manager not to start with unresolved credentials, got %#v", manager.startCfg)
	}
}

func TestJVMStartMonitoringReturnsClearErrorWhenSecretBundleIsMissing(t *testing.T) {
	app := newJVMMonitoringTestApp(t)
	app.SetLanguage("en-US")
	manager := &fakeJVMMonitoringManager{}
	restore := swapJVMMonitoringManager(manager)
	defer restore()

	saved := saveJVMMonitoringConnection(t, app, connection.ConnectionConfig{
		ID:   "conn-deleted-secret",
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeJMX,
			AllowedModes:  []string{jvm.ModeJMX},
			JMX:           connection.JVMJMXConfig{Enabled: true, Username: "monitor", Password: "jmx-secret"},
		},
	})
	if err := app.dailySecretStore().DeleteConnection("conn-deleted-secret"); err != nil {
		t.Fatalf("DeleteConnection returned error: %v", err)
	}

	res := app.JVMStartMonitoring(saved.Config)
	if res.Success {
		t.Fatalf("expected missing-credential failure after secret deletion, got %+v", res)
	}
	want := "The saved secret for the current connection was not found. Re-enter the password, save, and try again."
	if res.Message != want {
		t.Fatalf("expected missing-credential message %q, got %#v", want, res)
	}
	if manager.startCfg.ID != "" {
		t.Fatalf("expected monitoring manager not to start with unresolved credentials, got %#v", manager.startCfg)
	}
}

func TestJVMStartMonitoringKeepsInlineSecretsForUnsavedConnection(t *testing.T) {
	app := newJVMMonitoringTestApp(t)
	manager := &fakeJVMMonitoringManager{
		startSnapshot: jvm.MonitoringSessionSnapshot{
			ConnectionID: "orders.internal",
			ProviderMode: jvm.ModeEndpoint,
			Running:      true,
		},
	}
	restore := swapJVMMonitoringManager(manager)
	defer restore()

	res := app.JVMStartMonitoring(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeEndpoint,
			AllowedModes:  []string{jvm.ModeEndpoint},
			Endpoint:      connection.JVMEndpointConfig{Enabled: true, BaseURL: "https://endpoint.local", APIKey: "inline-endpoint-key"},
		},
	})
	if !res.Success {
		t.Fatalf("expected unsaved inline secrets to be accepted, got %+v", res)
	}
	if manager.startCfg.JVM.Endpoint.APIKey != "inline-endpoint-key" {
		t.Fatalf("expected monitoring manager to receive inline credentials, got %#v", manager.startCfg.JVM)
	}
}

func TestJVMGetMonitoringHistoryResolvesPreferredMode(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	manager := &fakeJVMMonitoringManager{
		historySnapshot: jvm.MonitoringSessionSnapshot{
			ConnectionID: "conn-history",
			ProviderMode: jvm.ModeJMX,
			Running:      true,
		},
	}
	restore := swapJVMMonitoringManager(manager)
	defer restore()

	res := app.JVMGetMonitoringHistory(connection.ConnectionConfig{
		ID:   "conn-history",
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeJMX,
			AllowedModes:  []string{jvm.ModeJMX},
		},
	}, "")

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	if manager.historyConnection != "conn-history" || manager.historyMode != jvm.ModeJMX {
		t.Fatalf("unexpected manager history args: connection=%q mode=%q", manager.historyConnection, manager.historyMode)
	}
}

func TestJVMStopMonitoringReturnsManagerError(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	manager := &fakeJVMMonitoringManager{
		stopErr: errors.New("session not found"),
	}
	restore := swapJVMMonitoringManager(manager)
	defer restore()

	res := app.JVMStopMonitoring(connection.ConnectionConfig{
		ID:   "conn-stop",
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeAgent,
			AllowedModes:  []string{jvm.ModeAgent},
		},
	}, "")

	if res.Success {
		t.Fatalf("expected failure, got %+v", res)
	}
	if res.Message != "session not found" {
		t.Fatalf("expected message %q, got %#v", "session not found", res)
	}
	if manager.stopConnection != "conn-stop" || manager.stopMode != jvm.ModeAgent {
		t.Fatalf("unexpected manager stop args: connection=%q mode=%q", manager.stopConnection, manager.stopMode)
	}
}

func TestCloseJVMMonitoringSessionsShutsDownManager(t *testing.T) {
	manager := &fakeJVMMonitoringManager{}
	restore := swapJVMMonitoringManager(manager)
	defer restore()

	closeJVMMonitoringSessions()

	if manager.shutdownCalls != 1 {
		t.Fatalf("expected JVM monitoring manager shutdown once, got %d", manager.shutdownCalls)
	}
}

func TestJVMMonitoringMethodsLocalizeManagerLocalizedErrors(t *testing.T) {
	app := newJVMMonitoringTestApp(t)
	app.SetLanguage("en-US")
	manager := &fakeJVMMonitoringManager{
		startErr: &jvm.LocalizedError{
			Key: "jvm.backend.monitoring.error.snapshot_unsupported",
			Params: map[string]any{
				"provider": "JMX",
			},
		},
		historyErr: &jvm.LocalizedError{
			Key: "jvm.backend.monitoring.error.session_not_found",
			Params: map[string]any{
				"connectionId": "conn-history",
				"providerMode": jvm.ModeJMX,
			},
		},
		stopErr: &jvm.LocalizedError{
			Key: "jvm.backend.monitoring.error.session_not_found",
			Params: map[string]any{
				"connectionId": "conn-stop",
				"providerMode": jvm.ModeAgent,
			},
		},
	}
	restore := swapJVMMonitoringManager(manager)
	defer restore()

	startCfg := connection.ConnectionConfig{
		ID:   "conn-monitor",
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeJMX,
			AllowedModes:  []string{jvm.ModeJMX},
		},
	}
	saveJVMMonitoringConnection(t, app, startCfg)
	startRes := app.JVMStartMonitoring(startCfg)
	assertMonitoringEnglishMessage(t, startRes, "JMX monitoring snapshot is not supported yet")

	historyRes := app.JVMGetMonitoringHistory(connection.ConnectionConfig{
		ID:   "conn-history",
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeJMX,
			AllowedModes:  []string{jvm.ModeJMX},
		},
	}, "")
	assertMonitoringEnglishMessage(t, historyRes, "Monitoring session not found for conn-history jmx")

	stopRes := app.JVMStopMonitoring(connection.ConnectionConfig{
		ID:   "conn-stop",
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeAgent,
			AllowedModes:  []string{jvm.ModeAgent},
		},
	}, "")
	assertMonitoringEnglishMessage(t, stopRes, "Monitoring session not found for conn-stop agent")
}

func TestJVMMonitoringMethodsLocalizeStructuredProviderWarnings(t *testing.T) {
	app := newJVMMonitoringTestApp(t)
	app.SetLanguage("en-US")
	manager := &fakeJVMMonitoringManager{
		startSnapshot: jvm.MonitoringSessionSnapshot{
			ConnectionID: "conn-monitor",
			ProviderMode: jvm.ModeJMX,
			Running:      false,
			ProviderWarnings: []string{
				"endpoint cpu metric unavailable",
				"__gonavi_i18n__:jvm.backend.monitoring.warning.sample_auto_stopped:count=3",
			},
		},
		historySnapshot: jvm.MonitoringSessionSnapshot{
			ConnectionID: "conn-monitor",
			ProviderMode: jvm.ModeJMX,
			Running:      false,
			ProviderWarnings: []string{
				"__gonavi_i18n__:jvm.backend.monitoring.warning.sample_auto_stopped:count=3",
				"collector returned HTTP 503",
			},
		},
	}
	restore := swapJVMMonitoringManager(manager)
	defer restore()

	startCfg := connection.ConnectionConfig{
		ID:   "conn-monitor",
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeJMX,
			AllowedModes:  []string{jvm.ModeJMX},
		},
	}
	saveJVMMonitoringConnection(t, app, startCfg)
	startRes := app.JVMStartMonitoring(startCfg)
	startSnapshot := assertMonitoringSnapshot(t, startRes)
	assertMonitoringWarnings(t, startSnapshot.ProviderWarnings, []string{
		"endpoint cpu metric unavailable",
		"Monitoring sampling failed 3 consecutive times and this session was stopped automatically",
	})

	historyRes := app.JVMGetMonitoringHistory(connection.ConnectionConfig{
		ID:   "conn-monitor",
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: jvm.ModeJMX,
			AllowedModes:  []string{jvm.ModeJMX},
		},
	}, "")
	historySnapshot := assertMonitoringSnapshot(t, historyRes)
	assertMonitoringWarnings(t, historySnapshot.ProviderWarnings, []string{
		"Monitoring sampling failed 3 consecutive times and this session was stopped automatically",
		"collector returned HTTP 503",
	})
}

func assertMonitoringEnglishMessage(t *testing.T, res connection.QueryResult, want string) {
	t.Helper()

	if res.Success {
		t.Fatalf("expected monitoring method to fail, got %+v", res)
	}
	if res.Message != want {
		t.Fatalf("expected monitoring message %q, got %+v", want, res)
	}
	if strings.Contains(res.Message, "jvm.backend.") {
		t.Fatalf("expected localized message instead of raw key, got %q", res.Message)
	}
}

func assertMonitoringSnapshot(t *testing.T, res connection.QueryResult) jvm.MonitoringSessionSnapshot {
	t.Helper()

	if !res.Success {
		t.Fatalf("expected monitoring method to succeed, got %+v", res)
	}
	snapshot, ok := res.Data.(jvm.MonitoringSessionSnapshot)
	if !ok {
		t.Fatalf("expected monitoring snapshot, got %#v", res.Data)
	}
	return snapshot
}

func assertMonitoringWarnings(t *testing.T, got []string, want []string) {
	t.Helper()

	if len(got) != len(want) {
		t.Fatalf("expected warnings %#v, got %#v", want, got)
	}
	for index, expected := range want {
		if got[index] != expected {
			t.Fatalf("expected warning %d to be %q, got %#v", index, expected, got)
		}
		if strings.Contains(got[index], "jvm.backend.") {
			t.Fatalf("expected localized warning instead of raw key, got %#v", got)
		}
	}
}
