package app

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type fullyCapableImportDatabase struct {
	db.Database
}

type pinnedImportDatabase struct {
	db.Database
}

type tableImportDatabase struct {
	db.Database
}

type baseImportDatabase struct {
	db.Database
}

type legacyBatchImportDatabase struct {
	db.Database
}

func (*fullyCapableImportDatabase) ApplyChanges(string, connection.ChangeSet) error {
	return nil
}

func (*fullyCapableImportDatabase) ApplyChangesContext(context.Context, string, connection.ChangeSet) error {
	return nil
}

func (*fullyCapableImportDatabase) OpenSessionExecer(context.Context) (db.StatementExecer, error) {
	return nil, nil
}

func (*fullyCapableImportDatabase) ExecBatchContext(context.Context, string) (int64, error) {
	return 0, nil
}

func (*fullyCapableImportDatabase) SupportsBatchWrites() bool {
	return true
}

func (*pinnedImportDatabase) ApplyChanges(string, connection.ChangeSet) error {
	return nil
}

func (*pinnedImportDatabase) ApplyChangesContext(context.Context, string, connection.ChangeSet) error {
	return nil
}

func (*pinnedImportDatabase) OpenSessionExecer(context.Context) (db.StatementExecer, error) {
	return nil, nil
}

func (*tableImportDatabase) ApplyChanges(string, connection.ChangeSet) error {
	return nil
}

func (*tableImportDatabase) ApplyChangesContext(context.Context, string, connection.ChangeSet) error {
	return nil
}

func (*legacyBatchImportDatabase) ApplyChanges(string, connection.ChangeSet) error {
	return nil
}

func TestResolveDataImportCapabilityRejectsLegacyNonCancellableBatchRuntime(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "mysql"},
		&legacyBatchImportDatabase{},
	)

	if got.TableImport.Supported {
		t.Fatalf("legacy non-cancellable table runtime must fail closed: %#v", got.TableImport)
	}
	if got.TableImport.Reason != DataImportReasonTableRuntimeUnavailable {
		t.Fatalf("reason = %q, want %q", got.TableImport.Reason, DataImportReasonTableRuntimeUnavailable)
	}
}

func TestResolveDataImportCapabilityMySQL(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "mysql"},
		&fullyCapableImportDatabase{},
	)

	want := DataImportCapability{
		DatabaseType: "mysql",
		TableImport: DataImportModeCapability{
			Supported:                  true,
			RequiresPinnedSession:      false,
			SupportsTransactionalBatch: false,
			SupportsContinue:           true,
			SupportedFormats:           []string{"csv", "json", "xlsx"},
			SupportedEncodings:         []string{"auto", "utf-8", "utf-16le", "utf-16be", "gb18030"},
			SupportedCompressions:      []string{},
			SupportedClientDirectives:  []string{},
			SupportedConflictPolicies:  []string{"stop", "skip_duplicates"},
		},
		SQLFileImport: DataImportModeCapability{
			Supported:                  true,
			RequiresPinnedSession:      true,
			SupportsTransactionalBatch: false,
			SupportsContinue:           true,
			SupportedFormats:           []string{"sql"},
			SupportedEncodings:         []string{"auto", "utf-8", "utf-16le", "utf-16be"},
			SupportedCompressions:      []string{"gzip"},
			SupportedClientDirectives:  []string{"delimiter"},
			SupportedConflictPolicies:  []string{},
		},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("capability = %#v, want %#v", got, want)
	}
}

func TestResolveDataImportCapabilityMySQLCompatibleDialects(t *testing.T) {
	testCases := []struct {
		name       string
		config     connection.ConnectionConfig
		wantDBType string
	}{
		{name: "MariaDB", config: connection.ConnectionConfig{Type: "mariadb"}, wantDBType: "mariadb"},
		{name: "OceanBase MySQL", config: connection.ConnectionConfig{Type: "oceanbase"}, wantDBType: "oceanbase"},
		{name: "custom GreatDB", config: connection.ConnectionConfig{Type: "custom", Driver: "greatdb"}, wantDBType: "mysql"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			got := ResolveDataImportCapability(testCase.config, &fullyCapableImportDatabase{})
			if got.DatabaseType != testCase.wantDBType {
				t.Fatalf("database type = %q, want %q", got.DatabaseType, testCase.wantDBType)
			}
			if !got.TableImport.Supported || !got.SQLFileImport.Supported {
				t.Fatalf("MySQL-compatible import capability = %#v", got)
			}
			if !reflect.DeepEqual(got.TableImport.SupportedConflictPolicies, []string{"stop", "skip_duplicates"}) {
				t.Fatalf("conflict policies = %#v", got.TableImport.SupportedConflictPolicies)
			}
			if !reflect.DeepEqual(got.SQLFileImport.SupportedClientDirectives, []string{"delimiter"}) {
				t.Fatalf("client directives = %#v", got.SQLFileImport.SupportedClientDirectives)
			}
		})
	}
}

func TestResolveDataImportCapabilityOceanBaseOracleUsesOracleDialect(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"},
		&fullyCapableImportDatabase{},
	)

	if got.DatabaseType != "oracle" || !got.SQLFileImport.Supported {
		t.Fatalf("OceanBase Oracle capability = %#v", got)
	}
	if !reflect.DeepEqual(got.SQLFileImport.SupportedClientDirectives, []string{"sqlplus-slash"}) {
		t.Fatalf("client directives = %#v", got.SQLFileImport.SupportedClientDirectives)
	}
}

func TestResolveDataImportCapabilityPostgres(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "postgresql"},
		&fullyCapableImportDatabase{},
	)

	if !got.TableImport.Supported || !got.TableImport.SupportsTransactionalBatch {
		t.Fatalf("table import capability = %#v", got.TableImport)
	}
	if !got.SQLFileImport.Supported || !got.SQLFileImport.RequiresPinnedSession {
		t.Fatalf("SQL file import capability = %#v", got.SQLFileImport)
	}
	if !got.SQLFileImport.SupportsTransactionalBatch || !got.SQLFileImport.SupportsContinue {
		t.Fatalf("SQL file execution semantics = %#v", got.SQLFileImport)
	}
	if got.DatabaseType != "postgres" {
		t.Fatalf("database type = %q, want postgres", got.DatabaseType)
	}
	if len(got.SQLFileImport.SupportedClientDirectives) != 0 {
		t.Fatalf("client directives = %#v, want none", got.SQLFileImport.SupportedClientDirectives)
	}
}

func TestResolveDataImportCapabilitySQLite(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "sqlite"},
		&fullyCapableImportDatabase{},
	)

	if !got.TableImport.Supported || !got.SQLFileImport.Supported {
		t.Fatalf("SQLite import capability = %#v", got)
	}
	if !got.TableImport.SupportsTransactionalBatch || !got.SQLFileImport.SupportsTransactionalBatch {
		t.Fatalf("SQLite transactional capability = %#v", got)
	}
	if !got.TableImport.SupportsContinue || !got.SQLFileImport.SupportsContinue {
		t.Fatalf("SQLite continue capability = %#v", got)
	}
}

func TestResolveDataImportCapabilityReportsConflictPoliciesByMode(t *testing.T) {
	testCases := []struct {
		dbType string
		want   []string
	}{
		{dbType: "mysql", want: []string{"stop", "skip_duplicates"}},
		{dbType: "postgres", want: []string{"stop", "skip_duplicates", "upsert"}},
		{dbType: "sqlite", want: []string{"stop", "skip_duplicates", "upsert"}},
		{dbType: "oracle", want: []string{"stop"}},
		{dbType: "sqlserver", want: []string{"stop"}},
	}

	for _, testCase := range testCases {
		t.Run(testCase.dbType, func(t *testing.T) {
			got := ResolveDataImportCapability(
				connection.ConnectionConfig{Type: testCase.dbType},
				&fullyCapableImportDatabase{},
			)

			if !reflect.DeepEqual(got.TableImport.SupportedConflictPolicies, testCase.want) {
				t.Fatalf("table conflict policies = %#v, want %#v", got.TableImport.SupportedConflictPolicies, testCase.want)
			}
			if !reflect.DeepEqual(got.SQLFileImport.SupportedConflictPolicies, []string{}) {
				t.Fatalf("SQL conflict policies = %#v, want none", got.SQLFileImport.SupportedConflictPolicies)
			}
		})
	}
}

func TestResolveDataImportCapabilityOracle(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "oracle"},
		&pinnedImportDatabase{},
	)

	if !got.TableImport.Supported || !got.TableImport.SupportsTransactionalBatch {
		t.Fatalf("Oracle table import capability = %#v", got.TableImport)
	}
	if !got.SQLFileImport.Supported || !got.SQLFileImport.RequiresPinnedSession {
		t.Fatalf("Oracle SQL file import capability = %#v", got.SQLFileImport)
	}
	if got.SQLFileImport.SupportsTransactionalBatch {
		t.Fatalf("Oracle SQL file import must not claim batch support: %#v", got.SQLFileImport)
	}
	if !reflect.DeepEqual(got.SQLFileImport.SupportedClientDirectives, []string{"sqlplus-slash"}) {
		t.Fatalf("client directives = %#v", got.SQLFileImport.SupportedClientDirectives)
	}
}

func TestResolveDataImportCapabilityDamengRejectsStatefulSQLWithoutPinnedSession(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "dameng"},
		&tableImportDatabase{},
	)

	if !got.TableImport.Supported || !got.TableImport.SupportsTransactionalBatch {
		t.Fatalf("Dameng table import capability = %#v", got.TableImport)
	}
	if !got.TableImport.SupportsContinue {
		t.Fatalf("Dameng table import must support continue mode: %#v", got.TableImport)
	}
	if !reflect.DeepEqual(got.TableImport.SupportedFormats, []string{"csv", "json", "xlsx"}) {
		t.Fatalf("Dameng table formats = %#v", got.TableImport.SupportedFormats)
	}
	if !reflect.DeepEqual(got.TableImport.SupportedEncodings, []string{"auto", "utf-8", "utf-16le", "utf-16be", "gb18030"}) {
		t.Fatalf("Dameng table encodings = %#v", got.TableImport.SupportedEncodings)
	}
	if !reflect.DeepEqual(got.TableImport.SupportedConflictPolicies, []string{"stop"}) {
		t.Fatalf("Dameng conflict policies = %#v", got.TableImport.SupportedConflictPolicies)
	}
	if got.SQLFileImport.Supported {
		t.Fatalf("Dameng SQL file import must fail closed: %#v", got.SQLFileImport)
	}
	if got.SQLFileImport.Reason != DataImportReasonPinnedSessionUnavailable {
		t.Fatalf("reason = %q, want %q", got.SQLFileImport.Reason, DataImportReasonPinnedSessionUnavailable)
	}
}

func TestResolveDataImportCapabilityNonTransactionalDriversRejectSQLWithoutPinnedSession(t *testing.T) {
	for _, dbType := range []string{"tdengine", "clickhouse"} {
		t.Run(dbType, func(t *testing.T) {
			got := ResolveDataImportCapability(
				connection.ConnectionConfig{Type: dbType},
				&tableImportDatabase{},
			)

			if !got.TableImport.Supported || !got.TableImport.SupportsContinue {
				t.Fatalf("table import capability = %#v", got.TableImport)
			}
			if got.TableImport.SupportsTransactionalBatch {
				t.Fatalf("table import must not claim transactions: %#v", got.TableImport)
			}
			if !reflect.DeepEqual(got.TableImport.SupportedConflictPolicies, []string{"stop"}) {
				t.Fatalf("table conflict policies = %#v", got.TableImport.SupportedConflictPolicies)
			}
			if got.SQLFileImport.Supported || got.SQLFileImport.Reason != DataImportReasonPinnedSessionUnavailable {
				t.Fatalf("SQL file import capability = %#v", got.SQLFileImport)
			}
		})
	}
}

func TestResolveDataImportCapabilityFailsClosedWhenPinnedSessionIsMissing(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "mysql"},
		&tableImportDatabase{},
	)

	if !got.TableImport.Supported {
		t.Fatalf("table import capability = %#v", got.TableImport)
	}
	if got.SQLFileImport.Supported {
		t.Fatalf("SQL file import must fail closed: %#v", got.SQLFileImport)
	}
	if got.SQLFileImport.Reason != DataImportReasonPinnedSessionUnavailable {
		t.Fatalf("reason = %q, want %q", got.SQLFileImport.Reason, DataImportReasonPinnedSessionUnavailable)
	}
}

func TestResolveDataImportCapabilityRejectsUnknownDatabaseTypes(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "future-db"},
		&fullyCapableImportDatabase{},
	)

	if got.TableImport.Supported || got.SQLFileImport.Supported {
		t.Fatalf("unknown database capability = %#v", got)
	}
	if got.TableImport.Reason != DataImportReasonDatabaseUnsupported {
		t.Fatalf("table reason = %q", got.TableImport.Reason)
	}
	if got.SQLFileImport.Reason != DataImportReasonDatabaseUnsupported {
		t.Fatalf("SQL reason = %q", got.SQLFileImport.Reason)
	}
	if !reflect.DeepEqual(got.TableImport.SupportedConflictPolicies, []string{}) ||
		!reflect.DeepEqual(got.SQLFileImport.SupportedConflictPolicies, []string{}) {
		t.Fatalf("unsupported conflict policies must be empty: %#v", got)
	}
}

func TestResolveDataImportCapabilityHonorsDataImportProtection(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{
			Type: "mysql",
			Protection: connection.ConnectionProtectionConfig{
				RestrictDataImport: true,
			},
		},
		&fullyCapableImportDatabase{},
	)

	if got.TableImport.Supported || got.SQLFileImport.Supported {
		t.Fatalf("protected connection capability = %#v", got)
	}
	if got.TableImport.Reason != DataImportReasonRestricted || got.SQLFileImport.Reason != DataImportReasonRestricted {
		t.Fatalf("protected connection reasons = %q, %q", got.TableImport.Reason, got.SQLFileImport.Reason)
	}
}

func TestResolveDataImportCapabilityExplainsMissingTableRuntime(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "postgres"},
		&baseImportDatabase{},
	)

	if got.TableImport.Supported {
		t.Fatalf("table import must fail closed: %#v", got.TableImport)
	}
	if got.TableImport.Reason != DataImportReasonTableRuntimeUnavailable {
		t.Fatalf("reason = %q, want %q", got.TableImport.Reason, DataImportReasonTableRuntimeUnavailable)
	}
}

func TestAppDataImportCapabilityUsesTheEffectiveRuntime(t *testing.T) {
	application := NewApp()
	config := connection.ConnectionConfig{Type: "mysql", Host: "db.local", Port: 3306}
	application.dbCache[getCacheKey(config)] = cachedDatabase{
		inst:     &fullyCapableImportDatabase{},
		lastPing: time.Now(),
		config:   normalizeCacheKeyConfig(config),
	}

	got := application.DataImportCapability(config)

	if !got.TableImport.Supported || !got.SQLFileImport.Supported {
		t.Fatalf("capability = %#v", got)
	}
}

func TestDataImportCapabilityJSONAlwaysIncludesReason(t *testing.T) {
	capability := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "mysql"},
		&fullyCapableImportDatabase{},
	)

	raw, err := json.Marshal(capability)
	if err != nil {
		t.Fatalf("marshal capability: %v", err)
	}
	if count := strings.Count(string(raw), `"reason":""`); count != 2 {
		t.Fatalf("reason field count = %d, JSON = %s", count, raw)
	}
	if count := strings.Count(string(raw), `"supportedConflictPolicies":`); count != 2 {
		t.Fatalf("conflict policy field count = %d, JSON = %s", count, raw)
	}
	if strings.Contains(string(raw), `"supportedConflictPolicies":null`) {
		t.Fatalf("conflict policy arrays must not be null, JSON = %s", raw)
	}
}

func TestResolveDataImportCapabilityRestrictsOnlySQLFileForScriptProtection(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{
			Type: "postgres",
			Protection: connection.ConnectionProtectionConfig{
				RestrictScriptExecution: true,
			},
		},
		&fullyCapableImportDatabase{},
	)

	if !got.TableImport.Supported {
		t.Fatalf("table import should remain available: %#v", got.TableImport)
	}
	if got.SQLFileImport.Supported || got.SQLFileImport.Reason != DataImportReasonSQLFileRestricted {
		t.Fatalf("SQL file import capability = %#v", got.SQLFileImport)
	}
}

func TestResolveDataImportCapabilitySQLServerReportsGoDirective(t *testing.T) {
	got := ResolveDataImportCapability(
		connection.ConnectionConfig{Type: "mssql"},
		&fullyCapableImportDatabase{},
	)

	if got.DatabaseType != "sqlserver" || !got.SQLFileImport.Supported {
		t.Fatalf("SQL Server capability = %#v", got)
	}
	if !reflect.DeepEqual(got.SQLFileImport.SupportedClientDirectives, []string{"go"}) {
		t.Fatalf("client directives = %#v", got.SQLFileImport.SupportedClientDirectives)
	}
}
