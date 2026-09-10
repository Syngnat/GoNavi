package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
)

func TestOptionalDriverAgentRevisionStatusDetectsStaleClickHouseAgent(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageZhCN))

	needsUpdate, reason, expected := optionalDriverAgentRevisionStatus("clickhouse", installedDriverPackage{}, true)
	if !needsUpdate {
		t.Fatal("expected missing ClickHouse agent revision to require update")
	}
	if expected == "" {
		t.Fatal("expected ClickHouse to define an agent revision")
	}
	if reason == "" {
		t.Fatal("expected update reason")
	}
	if !strings.Contains(reason, "原因：") || !strings.Contains(reason, "影响：") {
		t.Fatalf("expected reason to explain cause and impact, got %q", reason)
	}
	if !strings.Contains(reason, "强烈建议重装") {
		t.Fatalf("expected reason to strongly recommend reinstall, got %q", reason)
	}

	current := installedDriverPackage{AgentRevision: expected}
	needsUpdate, reason, _ = optionalDriverAgentRevisionStatus("clickhouse", current, true)
	if needsUpdate {
		t.Fatalf("expected current ClickHouse agent revision to be accepted, reason=%q", reason)
	}
}

func TestOptionalDriverPackageUpdateStatusDetectsMongoV2WhenLegacyDefault(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageZhCN))

	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}
	meta := installedDriverPackage{
		Version:       "2.5.0",
		AgentRevision: db.OptionalDriverAgentRevision("mongodb"),
	}

	needsUpdate, reason, _ := optionalDriverPackageUpdateStatus(definition, meta, true)
	if !needsUpdate {
		t.Fatal("expected installed MongoDB v2 driver to require reinstall when v1 is the compatibility default")
	}
	if !strings.Contains(reason, "MongoDB 4.0") || !strings.Contains(reason, "wire version 7") {
		t.Fatalf("expected reason to explain MongoDB 4.0 compatibility, got %q", reason)
	}
}

func TestOptionalDriverPackageUpdateStatusAcceptsMongoV1WithoutRevision(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageZhCN))

	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}
	meta := installedDriverPackage{
		Version:       "1.17.9",
		AgentRevision: "",
	}

	needsUpdate, reason, _ := optionalDriverPackageUpdateStatus(definition, meta, true)
	if needsUpdate {
		t.Fatalf("expected MongoDB v1 driver to skip revision mismatch prompts, reason=%q", reason)
	}
}

func TestOptionalDriverAgentRevisionCurrentRejectsStaleMetadata(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
	})
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{
			DriverType:    driverType,
			AgentRevision: "src-stale-agent",
		}, nil
	}

	for _, driverType := range optionalDriverAgentRevisionTestDrivers(t) {
		t.Run(driverType, func(t *testing.T) {
			actual, current, err := optionalDriverAgentRevisionCurrent(driverType, "fake-driver-agent")
			if err != nil {
				t.Fatalf("expected stale metadata to be comparable, got error: %v", err)
			}
			if current {
				t.Fatalf("expected stale %s agent revision to be rejected", driverType)
			}
			if actual != "src-stale-agent" {
				t.Fatalf("unexpected actual revision: %q", actual)
			}
		})
	}
}

func TestVerifyInstalledOptionalDriverAgentRevisionRejectsProbeFailure(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
	})
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{}, errOptionalDriverAgentMetadataUnavailable
	}

	for _, driverType := range optionalDriverAgentRevisionTestDrivers(t) {
		t.Run(driverType, func(t *testing.T) {
			if _, err := verifyInstalledOptionalDriverAgentRevision(driverType, "fake-driver-agent"); err == nil {
				t.Fatalf("expected %s install verification to fail when metadata probe fails", driverType)
			}
		})
	}
}

func TestVerifyRuntimeOptionalDriverAgentRevisionAllowsStaleOceanBaseMySQLAgent(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
	})
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{
			DriverType:    driverType,
			AgentRevision: "src-stale-agent",
		}, nil
	}

	err := verifyRuntimeOptionalDriverAgentRevision(connection.ConnectionConfig{Type: "oceanbase"})
	if err != nil {
		t.Fatalf("stale agent revision must not block connections, got error: %v", err)
	}
}

func TestVerifyRuntimeOptionalDriverAgentRevisionAllowsStaleOceanBaseOracleAgent(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
	})
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{
			DriverType:    driverType,
			AgentRevision: "src-stale-agent",
		}, nil
	}

	err := verifyRuntimeOptionalDriverAgentRevision(connection.ConnectionConfig{
		Type:             "oceanbase",
		ConnectionParams: "protocol=oracle",
	})
	if err != nil {
		t.Fatalf("stale agent revision must not block connections, got error: %v", err)
	}
}

func TestVerifyRuntimeOptionalDriverAgentRevisionAllowsUnknownOceanBaseOracleAgent(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
	})
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{}, errOptionalDriverAgentMetadataUnavailable
	}

	err := verifyRuntimeOptionalDriverAgentRevision(connection.ConnectionConfig{
		Type:              "oceanbase",
		OceanBaseProtocol: "oracle",
	})
	if err != nil {
		t.Fatalf("unverified agent must not block connections, got error: %v", err)
	}
}

func TestVerifyRuntimeOptionalDriverAgentRevisionAllowsMetadataProbeFailure(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
	})
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{}, errOptionalDriverAgentMetadataUnavailable
	}

	err := verifyRuntimeOptionalDriverAgentRevision(connection.ConnectionConfig{Type: "sqlserver"})
	if err != nil {
		t.Fatalf("unverified agent must not block connections, got error: %v", err)
	}
}

func TestVerifyRuntimeOptionalDriverAgentRevisionAcceptsCurrentAgent(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
	})
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{
			DriverType:    driverType,
			AgentRevision: db.OptionalDriverAgentRevision(driverType),
		}, nil
	}

	if err := verifyRuntimeOptionalDriverAgentRevision(connection.ConnectionConfig{Type: "clickhouse"}); err != nil {
		t.Fatalf("current runtime agent should be accepted: %v", err)
	}
}

func TestVerifyRuntimeOptionalDriverAgentRevisionSkipsCustomDriver(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
	})
	calls := 0
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		calls++
		return db.OptionalDriverAgentMetadata{}, nil
	}

	if err := verifyRuntimeOptionalDriverAgentRevision(connection.ConnectionConfig{
		Type:   "custom",
		Driver: "oceanbase",
	}); err != nil {
		t.Fatalf("custom driver should skip optional agent runtime revision check: %v", err)
	}
	if calls != 0 {
		t.Fatalf("custom driver should not probe optional agent metadata, got %d calls", calls)
	}
}

func optionalDriverAgentRevisionTestDrivers(t *testing.T) []string {
	t.Helper()
	drivers := []string{
		"mariadb",
		"oceanbase",
		"diros",
		"starrocks",
		"sphinx",
		"sqlserver",
		"sqlite",
		"duckdb",
		"dameng",
		"kingbase",
		"highgo",
		"vastbase",
		"opengauss",
		"gaussdb",
		"iris",
		"cache",
		"mongodb",
		"tdengine",
		"iotdb",
		"clickhouse",
		"elasticsearch",
		"trino",
	}
	for _, driverType := range drivers {
		if db.OptionalDriverAgentRevision(driverType) == "" {
			t.Fatalf("expected %s to define an agent revision", driverType)
		}
	}
	return drivers
}

func TestSavedConnectionDriverUsageCountsIncludesOptionalAndCustomDrivers(t *testing.T) {
	app := &App{configDir: t.TempDir()}
	repo := app.savedConnectionRepository()
	if err := repo.saveAll([]connection.SavedConnectionView{
		{
			ID:   "conn-clickhouse",
			Name: "ClickHouse",
			Config: connection.ConnectionConfig{
				Type: "clickhouse",
			},
		},
		{
			ID:   "conn-custom-clickhouse",
			Name: "Custom ClickHouse",
			Config: connection.ConnectionConfig{
				Type:   "custom",
				Driver: "clickhouse",
			},
		},
		{
			ID:   "conn-mysql",
			Name: "MySQL",
			Config: connection.ConnectionConfig{
				Type: "mysql",
			},
		},
	}); err != nil {
		t.Fatalf("save connections failed: %v", err)
	}

	counts := app.savedConnectionDriverUsageCounts()
	if got := counts["clickhouse"]; got != 2 {
		t.Fatalf("expected two ClickHouse usages, got %d", got)
	}
	if got := counts["mysql"]; got != 0 {
		t.Fatalf("expected built-in MySQL to be ignored, got %d", got)
	}
}
