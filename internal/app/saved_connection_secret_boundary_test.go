package app

import (
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestPartitionConnectionParamsSeparatesCredentialKeys(t *testing.T) {
	public, sensitive := partitionConnectionParams(
		"application_name=gonavi&connectTimeout=10&accessToken=token-secret&client_secret=client-secret&PASSWORD=db-secret",
	)
	publicValues, err := url.ParseQuery(public)
	if err != nil {
		t.Fatal(err)
	}
	if publicValues.Get("application_name") != "gonavi" || publicValues.Get("connectTimeout") != "10" {
		t.Fatalf("ordinary parameters were not preserved: %q", public)
	}
	if strings.Contains(public, "token-secret") || strings.Contains(public, "client-secret") || strings.Contains(public, "db-secret") {
		t.Fatalf("public parameters contain credentials: %q", public)
	}

	sensitiveValues, err := url.ParseQuery(sensitive)
	if err != nil {
		t.Fatal(err)
	}
	if sensitiveValues.Get("accessToken") != "token-secret" ||
		sensitiveValues.Get("client_secret") != "client-secret" ||
		sensitiveValues.Get("PASSWORD") != "db-secret" {
		t.Fatalf("credential parameters were not retained in the secret partition: %q", sensitive)
	}

	merged, err := url.ParseQuery(mergeConnectionParams(public, sensitive))
	if err != nil {
		t.Fatal(err)
	}
	if merged.Get("application_name") != "gonavi" || merged.Get("accessToken") != "token-secret" {
		t.Fatalf("merged parameters do not reconstruct runtime configuration: %#v", merged)
	}

	malformedPublic, malformedSecret := partitionConnectionParams("token=secret;broken")
	if malformedPublic != "" || malformedSecret != "token=secret;broken" {
		t.Fatalf("malformed parameters must fail closed, public=%q secret=%q", malformedPublic, malformedSecret)
	}
}

func TestSavedConnectionJVMSecretsAndSensitiveParamsStayOutOfPublicMetadata(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	input := connection.SavedConnectionInput{
		ID:   "conn-secret-boundary",
		Name: "Secret boundary",
		Config: connection.ConnectionConfig{
			ID:               "conn-secret-boundary",
			Type:             "jvm",
			Host:             "jvm.local",
			Password:         "primary-secret",
			URI:              "https://user:uri-secret@jvm.local",
			DSN:              "password=dsn-secret",
			ConnectionParams: "application_name=gonavi&accessToken=param-token&client_secret=param-secret",
			JVM: connection.JVMConfig{
				JMX: connection.JVMJMXConfig{
					Enabled:  true,
					Username: "monitor",
					Password: "jmx-secret",
				},
				Endpoint: connection.JVMEndpointConfig{Enabled: true, BaseURL: "https://endpoint.local", APIKey: "endpoint-key"},
				Agent:    connection.JVMAgentConfig{Enabled: true, BaseURL: "https://agent.local", APIKey: "agent-key"},
				Diagnostic: connection.JVMDiagnosticConfig{
					Enabled: true,
					BaseURL: "https://diagnostic.local",
					APIKey:  "diagnostic-key",
				},
			},
		},
	}

	saved, err := app.SaveConnection(input)
	if err != nil {
		t.Fatal(err)
	}
	assertPublicSavedConnectionSecretless(t, saved)
	if !saved.HasPrimaryPassword || !saved.HasOpaqueURI || !saved.HasOpaqueDSN ||
		!saved.HasJVMJMXPassword || !saved.HasJVMEndpointAPIKey || !saved.HasJVMAgentAPIKey ||
		!saved.HasJVMDiagnosticAPIKey || !saved.HasSensitiveParams {
		t.Fatalf("expected all saved secret flags, got %#v", saved)
	}

	rawView, err := app.savedConnectionRepository().Find(input.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertPublicSavedConnectionSecretless(t, rawView)
	metadata, err := os.ReadFile(app.savedConnectionRepository().connectionsPath())
	if err != nil {
		t.Fatal(err)
	}
	assertJSONOmitsSecretLiterals(t, metadata)

	bundle, ok, err := app.dailySecretStore().GetConnection(input.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected secret bundle to be persisted")
	}
	if bundle.JVMJMXPassword != "jmx-secret" || bundle.JVMEndpointAPIKey != "endpoint-key" ||
		bundle.JVMAgentAPIKey != "agent-key" || bundle.JVMDiagnosticAPIKey != "diagnostic-key" {
		t.Fatalf("JVM credentials were not persisted in the secret store: %#v", bundle)
	}
	sensitiveValues, err := url.ParseQuery(bundle.SensitiveParams)
	if err != nil {
		t.Fatal(err)
	}
	if sensitiveValues.Get("accessToken") != "param-token" || sensitiveValues.Get("client_secret") != "param-secret" {
		t.Fatalf("sensitive connection params were not persisted in the secret store: %q", bundle.SensitiveParams)
	}

	resolved, err := app.resolveConnectionSecrets(rawView.Config)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Password != "primary-secret" || resolved.URI == "" || resolved.DSN == "" ||
		resolved.JVM.JMX.Password != "jmx-secret" || resolved.JVM.Endpoint.APIKey != "endpoint-key" ||
		resolved.JVM.Agent.APIKey != "agent-key" || resolved.JVM.Diagnostic.APIKey != "diagnostic-key" {
		t.Fatalf("runtime secret resolution did not restore credentials: %#v", resolved)
	}
	resolvedParams, err := url.ParseQuery(resolved.ConnectionParams)
	if err != nil {
		t.Fatal(err)
	}
	if resolvedParams.Get("application_name") != "gonavi" || resolvedParams.Get("accessToken") != "param-token" {
		t.Fatalf("runtime connection params were not reconstructed: %#v", resolvedParams)
	}

	listed, err := app.GetSavedConnections()
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 {
		t.Fatalf("expected one saved connection, got %d", len(listed))
	}
	assertPublicSavedConnectionSecretless(t, listed[0])
	listedJSON, err := json.Marshal(listed)
	if err != nil {
		t.Fatal(err)
	}
	assertJSONOmitsSecretLiterals(t, listedJSON)

	editable, err := app.GetEditableSavedConnection(input.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertPublicSavedConnectionSecretless(t, editable)
	editableJSON, err := json.Marshal(editable)
	if err != nil {
		t.Fatal(err)
	}
	assertJSONOmitsSecretLiterals(t, editableJSON)

	// A metadata-only edit must keep the existing bundle even though no secret is
	// returned to the WebView and therefore none is echoed back.
	update := connection.SavedConnectionInput{ID: saved.ID, Name: "Renamed", Config: saved.Config}
	updated, err := app.SaveConnection(update)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.HasJVMJMXPassword || !updated.HasSensitiveParams {
		t.Fatalf("metadata-only save dropped secret flags: %#v", updated)
	}
	resolvedAfterUpdate, err := app.resolveConnectionSecrets(updated.Config)
	if err != nil {
		t.Fatal(err)
	}
	if resolvedAfterUpdate.JVM.JMX.Password != "jmx-secret" ||
		!strings.Contains(resolvedAfterUpdate.ConnectionParams, "param-token") {
		t.Fatalf("metadata-only save dropped stored secrets: %#v", resolvedAfterUpdate)
	}
}

func TestSaveConnectionExplicitlyClearsNewSecretFields(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	initial, err := app.SaveConnection(connection.SavedConnectionInput{
		ID: "conn-clear-new-secrets",
		Config: connection.ConnectionConfig{
			ID:               "conn-clear-new-secrets",
			Type:             "jvm",
			ConnectionParams: "application_name=gonavi&token=secret",
			JVM: connection.JVMConfig{
				JMX:        connection.JVMJMXConfig{Password: "jmx-secret"},
				Endpoint:   connection.JVMEndpointConfig{APIKey: "endpoint-key"},
				Agent:      connection.JVMAgentConfig{APIKey: "agent-key"},
				Diagnostic: connection.JVMDiagnosticConfig{APIKey: "diagnostic-key"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	cleared, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:                       initial.ID,
		Config:                   initial.Config,
		ClearJVMJMXPassword:      true,
		ClearJVMEndpointAPIKey:   true,
		ClearJVMAgentAPIKey:      true,
		ClearJVMDiagnosticAPIKey: true,
		ClearSensitiveParams:     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cleared.HasJVMJMXPassword || cleared.HasJVMEndpointAPIKey || cleared.HasJVMAgentAPIKey ||
		cleared.HasJVMDiagnosticAPIKey || cleared.HasSensitiveParams {
		t.Fatalf("explicit clear did not reset secret flags: %#v", cleared)
	}
	resolved, err := app.resolveConnectionSecrets(cleared.Config)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.JVM.JMX.Password != "" || resolved.JVM.Endpoint.APIKey != "" ||
		resolved.JVM.Agent.APIKey != "" || resolved.JVM.Diagnostic.APIKey != "" ||
		strings.Contains(resolved.ConnectionParams, "secret") {
		t.Fatalf("explicit clear did not remove secret material: %#v", resolved)
	}
}

func TestConnectionPackageEncryptsAndRestoresNewSecretFields(t *testing.T) {
	source := NewAppWithSecretStore(newFakeAppSecretStore())
	source.configDir = t.TempDir()
	if _, err := source.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-package-secrets",
		Name: "Package secrets",
		Config: connection.ConnectionConfig{
			ID:               "conn-package-secrets",
			Type:             "jvm",
			ConnectionParams: "application_name=gonavi&token=package-token",
			JVM: connection.JVMConfig{
				JMX:        connection.JVMJMXConfig{Password: "package-jmx-secret"},
				Endpoint:   connection.JVMEndpointConfig{APIKey: "package-endpoint-key"},
				Agent:      connection.JVMAgentConfig{APIKey: "package-agent-key"},
				Diagnostic: connection.JVMDiagnosticConfig{APIKey: "package-diagnostic-key"},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}

	exported, err := source.buildExportedConnectionPackage(ConnectionExportOptions{IncludeSecrets: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{
		"package-token", "package-jmx-secret", "package-endpoint-key", "package-agent-key", "package-diagnostic-key",
	} {
		if strings.Contains(string(exported), secret) {
			t.Fatalf("encrypted connection package contains plaintext %q", secret)
		}
	}

	destination := NewAppWithSecretStore(newFakeAppSecretStore())
	destination.configDir = t.TempDir()
	result, err := destination.ImportConnectionsPayload(string(exported), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Connections) != 1 {
		t.Fatalf("expected one imported connection, got %d", len(result.Connections))
	}
	assertPublicSavedConnectionSecretless(t, result.Connections[0])
	resolved, err := destination.resolveConnectionSecrets(result.Connections[0].Config)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.JVM.JMX.Password != "package-jmx-secret" ||
		resolved.JVM.Endpoint.APIKey != "package-endpoint-key" ||
		resolved.JVM.Agent.APIKey != "package-agent-key" ||
		resolved.JVM.Diagnostic.APIKey != "package-diagnostic-key" ||
		!strings.Contains(resolved.ConnectionParams, "package-token") {
		t.Fatalf("import did not restore encrypted secret fields: %#v", resolved)
	}
}

func TestDailySecretMigrationMergesInlineJVMSecretsWithExistingBundle(t *testing.T) {
	repo := newSavedConnectionRepository(t.TempDir(), newFakeAppSecretStore())
	if err := repo.saveAll([]connection.SavedConnectionView{{
		ID:                 "conn-migrate-new-secrets",
		Name:               "Migration",
		HasPrimaryPassword: true,
		Config: connection.ConnectionConfig{
			ID:               "conn-migrate-new-secrets",
			Type:             "jvm",
			ConnectionParams: "application_name=gonavi&accessToken=migrated-token",
			JVM: connection.JVMConfig{
				JMX:      connection.JVMJMXConfig{Password: "migrated-jmx-secret"},
				Endpoint: connection.JVMEndpointConfig{APIKey: "migrated-endpoint-key"},
			},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := repo.dailySecrets().PutConnection("conn-migrate-new-secrets", toDailyConnectionBundle(connectionSecretBundle{
		Password: "existing-primary-secret",
	})); err != nil {
		t.Fatal(err)
	}

	if err := migrateSavedConnectionSecrets(repo, legacyWebKitVisibleConfig{}); err != nil {
		t.Fatal(err)
	}
	view, err := repo.Find("conn-migrate-new-secrets")
	if err != nil {
		t.Fatal(err)
	}
	assertPublicSavedConnectionSecretless(t, view)
	if !view.HasPrimaryPassword || !view.HasJVMJMXPassword || !view.HasJVMEndpointAPIKey || !view.HasSensitiveParams {
		t.Fatalf("migration did not preserve all secret flags: %#v", view)
	}
	bundle, ok, err := repo.dailySecrets().GetConnection(view.ID)
	if err != nil || !ok {
		t.Fatalf("expected migrated bundle, ok=%v err=%v", ok, err)
	}
	if bundle.Password != "existing-primary-secret" || bundle.JVMJMXPassword != "migrated-jmx-secret" ||
		bundle.JVMEndpointAPIKey != "migrated-endpoint-key" || !strings.Contains(bundle.SensitiveParams, "migrated-token") {
		t.Fatalf("migration dropped old or new secret material: %#v", bundle)
	}
}

func assertPublicSavedConnectionSecretless(t *testing.T, view connection.SavedConnectionView) {
	t.Helper()
	config := view.Config
	if config.Password != "" || config.SSH.Password != "" || config.Proxy.Password != "" ||
		config.HTTPTunnel.Password != "" || config.MySQLReplicaPassword != "" ||
		config.MongoReplicaPassword != "" || config.RedisSentinelPassword != "" ||
		config.URI != "" || config.DSN != "" || config.JVM.JMX.Password != "" ||
		config.JVM.Endpoint.APIKey != "" || config.JVM.Agent.APIKey != "" ||
		config.JVM.Diagnostic.APIKey != "" {
		t.Fatalf("public saved connection contains a secret field: %#v", config)
	}
	_, sensitive := partitionConnectionParams(config.ConnectionParams)
	if sensitive != "" {
		t.Fatalf("public saved connection contains sensitive connection params: %q", config.ConnectionParams)
	}
}

func assertJSONOmitsSecretLiterals(t *testing.T, payload []byte) {
	t.Helper()
	for _, secret := range []string{
		"primary-secret", "uri-secret", "dsn-secret", "param-token", "param-secret",
		"jmx-secret", "endpoint-key", "agent-key", "diagnostic-key",
	} {
		if strings.Contains(string(payload), secret) {
			t.Fatalf("public/metadata JSON contains secret literal %q: %s", secret, payload)
		}
	}
}
