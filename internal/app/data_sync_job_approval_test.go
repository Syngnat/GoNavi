package app

import (
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

func approvalTestDefinition() syncjob.JobDefinition {
	return syncjob.JobDefinition{
		Name:            "orders sync",
		Enabled:         true,
		Kind:            syncjob.JobKindReconcile,
		IncrementalMode: syncjob.IncrementalSnapshot,
		Source:          syncjob.EndpointRef{ConnectionID: "source"},
		Target:          syncjob.EndpointRef{ConnectionID: "target"},
		Mappings: []syncjob.TableMapping{{
			SourceTable: "orders",
			TargetTable: "orders_archive",
			Enabled:     true,
		}},
	}
}

func TestDataSyncJobApprovalIsOneTimeAndDefinitionBound(t *testing.T) {
	application := NewApp()
	now := time.Unix(1_800_000_000, 0)
	definition := approvalTestDefinition()
	token, _, err := application.issueDataSyncJobApproval(definition, "target-fingerprint", now)
	if err != nil {
		t.Fatalf("issue approval: %v", err)
	}
	changed := definition
	changed.Mappings[0].TargetTable = "other_table"
	if _, err := application.consumeDataSyncJobApproval(token, changed, "target-fingerprint", now); err == nil {
		t.Fatal("changed task definition must invalidate approval")
	}
	if _, err := application.consumeDataSyncJobApproval(token, definition, "target-fingerprint", now); err == nil {
		t.Fatal("mismatched attempt must still consume the one-time token")
	}
}

func TestDataSyncJobApprovalTokenCannotCrossRuntimeBoundary(t *testing.T) {
	application := NewApp()
	now := time.Unix(1_800_000_000, 0)
	definition := approvalTestDefinition()
	token, _, err := application.issueDataSyncJobApproval(definition, "target-fingerprint", now)
	if err != nil {
		t.Fatalf("issue desktop approval: %v", err)
	}
	application.webRuntime = true
	if _, err := application.consumeDataSyncJobApproval(token, definition, "target-fingerprint", now); err == nil {
		t.Fatal("web runtime consumed a desktop production approval token")
	}
}

func TestStoredDataSyncJobApprovalSurvivesPersistenceMetadataChanges(t *testing.T) {
	application := NewApp()
	now := time.Unix(1_800_000_000, 0)
	definition := approvalTestDefinition()
	token, _, err := application.issueDataSyncJobApproval(definition, "target-fingerprint", now)
	if err != nil {
		t.Fatalf("issue approval: %v", err)
	}
	approval, err := application.consumeDataSyncJobApproval(token, definition, "target-fingerprint", now)
	if err != nil {
		t.Fatalf("consume approval: %v", err)
	}
	definition.Approval = &approval
	definition.Revision = 7
	definition.UpdatedAt = now.Add(time.Minute).UnixMilli()
	definition.NextRunAt = now.Add(time.Hour).UnixMilli()
	if err := application.validateStoredDataSyncJobApproval(definition, "target-fingerprint"); err != nil {
		t.Fatalf("derived state invalidated stored approval: %v", err)
	}
}

func TestStoredDataSyncJobApprovalCannotCrossRuntimeBoundary(t *testing.T) {
	desktop := NewApp()
	now := time.Unix(1_800_000_000, 0)
	definition := approvalTestDefinition()
	token, _, err := desktop.issueDataSyncJobApproval(definition, "target-fingerprint", now)
	if err != nil {
		t.Fatalf("issue desktop approval: %v", err)
	}
	approval, err := desktop.consumeDataSyncJobApproval(token, definition, "target-fingerprint", now)
	if err != nil {
		t.Fatalf("consume desktop approval: %v", err)
	}
	definition.Approval = &approval
	if err := desktop.validateStoredDataSyncJobApproval(definition, "target-fingerprint"); err != nil {
		t.Fatalf("desktop rejected its own persisted approval: %v", err)
	}

	web := NewApp()
	web.webRuntime = true
	if err := web.validateStoredDataSyncJobApproval(definition, "target-fingerprint"); err == nil {
		t.Fatal("web runtime reused a desktop production approval")
	}
}

func TestDataSyncJobApprovalScopeRejectsUnattendedPolicyChanges(t *testing.T) {
	application := NewApp()
	now := time.Unix(1_800_000_000, 0)
	definition := approvalTestDefinition()
	definition.ID = "job-1"
	definition.Lifecycle = syncjob.JobLifecycleReady
	definition.Enabled = false
	definition.Schedule = syncjob.ScheduleSpec{Kind: syncjob.ScheduleManual}
	token, _, err := application.issueDataSyncJobApproval(definition, "target-fingerprint", now)
	if err != nil {
		t.Fatalf("issue approval: %v", err)
	}
	changed := definition
	changed.Lifecycle = syncjob.JobLifecycleEnabled
	changed.Enabled = true
	changed.Schedule = syncjob.ScheduleSpec{Kind: syncjob.ScheduleContinuous}
	if _, err := application.consumeDataSyncJobApproval(token, changed, "target-fingerprint", now); err == nil {
		t.Fatal("manual approval must not authorize an enabled continuous task")
	}
}

func TestDataSyncJobApprovalChallengeEnforcesBackendCountdown(t *testing.T) {
	application := NewApp()
	application.dataSyncJobApprovalDelay = 10 * time.Second
	now := time.Unix(1_800_000_000, 0)
	definition := approvalTestDefinition()
	definition.ID = "job-1"

	challenge, notBefore, _, err := application.beginDataSyncJobApproval(definition, "target-fingerprint", now)
	if err != nil {
		t.Fatalf("begin approval: %v", err)
	}
	if _, _, err := application.confirmDataSyncJobApproval(challenge, definition, "target-fingerprint", now.Add(9*time.Second)); err == nil {
		t.Fatal("approval confirmed before the backend countdown elapsed")
	}
	if _, _, err := application.confirmDataSyncJobApproval(challenge, definition, "target-fingerprint", notBefore); err == nil {
		t.Fatal("early confirmation must consume the one-time challenge")
	}

	challenge, notBefore, _, err = application.beginDataSyncJobApproval(definition, "target-fingerprint", now)
	if err != nil {
		t.Fatalf("begin second approval: %v", err)
	}
	if token, approval, err := application.confirmDataSyncJobApproval(challenge, definition, "target-fingerprint", notBefore); err != nil || token == "" || approval.DefinitionHash == "" {
		t.Fatalf("confirm elapsed approval: token=%q approval=%#v err=%v", token, approval, err)
	}
}

func TestDataSyncJobPreflightDiscardsCallerSuppliedApproval(t *testing.T) {
	application := NewApp()
	definition := approvalTestDefinition()
	definition.Approval = &syncjob.ExecutionApproval{
		DefinitionHash:    "forged",
		TargetFingerprint: "forged",
		ApprovedAt:        time.Now().UnixMilli(),
		ApprovedByRuntime: "desktop",
	}
	result := application.preflightDataSyncJob(definition, time.Now())
	if result.Definition.Approval != nil {
		t.Fatal("preflight must not trust or echo a caller-supplied approval")
	}
}

func TestPreflightSourceComparisonKeysRequireAnExecutableKeyOnlyForExistingTarget(t *testing.T) {
	definition := approvalTestDefinition()
	definition.Options.SyncMode = "insert_update"
	noPrimaryKey := []connection.ColumnDefinition{{Name: "id", Type: "bigint"}, {Name: "external_id", Type: "varchar(64)"}, {Name: "name", Type: "varchar(64)"}}
	physicalPrimaryKey := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Key: "PRI"}}

	tests := []struct {
		name          string
		definition    syncjob.JobDefinition
		mapping       syncjob.TableMapping
		sourceColumns []connection.ColumnDefinition
		targetColumns []connection.ColumnDefinition
		targetExists  bool
		wantCodes     []string
	}{
		{
			name:          "existing target without stable key is rejected",
			definition:    definition,
			sourceColumns: noPrimaryKey,
			targetExists:  true,
			wantCodes:     []string{"source_primary_key_required"},
		},
		{
			name:          "automatic target creation does not require a key",
			definition:    definition,
			sourceColumns: noPrimaryKey,
			targetExists:  false,
		},
		{
			name:       "mapped business key without a physical primary key is rejected",
			definition: definition,
			mapping: syncjob.TableMapping{
				SourceTable: "orders",
				TargetTable: "orders_archive",
				KeyColumns:  []string{"external_id"},
			},
			sourceColumns: noPrimaryKey,
			targetColumns: []connection.ColumnDefinition{{Name: "external_id", Type: "varchar(64)"}},
			targetExists:  true,
			wantCodes:     []string{"source_primary_key_required"},
		},
		{
			name:       "renamed business key without a physical primary key is rejected",
			definition: definition,
			mapping: syncjob.TableMapping{
				SourceTable: "orders",
				TargetTable: "orders_archive",
				KeyColumns:  []string{"external_id"},
				Columns:     []syncjob.ColumnMapping{{Source: "external_id", Target: "external_code"}},
			},
			sourceColumns: noPrimaryKey,
			targetColumns: []connection.ColumnDefinition{{Name: "external_code", Type: "varchar(64)"}},
			targetExists:  true,
			wantCodes:     []string{"source_primary_key_required"},
		},
		{
			name:       "unmapped business key without a physical primary key is rejected",
			definition: definition,
			mapping: syncjob.TableMapping{
				SourceTable: "orders",
				TargetTable: "orders_archive",
				KeyColumns:  []string{"external_id"},
				Columns:     []syncjob.ColumnMapping{{Source: "name", Target: "name"}},
			},
			sourceColumns: noPrimaryKey,
			targetColumns: []connection.ColumnDefinition{{Name: "name", Type: "varchar(64)"}},
			targetExists:  true,
			wantCodes:     []string{"source_primary_key_required"},
		},
		{
			name:       "business key mapped to a missing target field still requires a physical primary key",
			definition: definition,
			mapping: syncjob.TableMapping{
				SourceTable: "orders",
				TargetTable: "orders_archive",
				KeyColumns:  []string{"external_id"},
				Columns:     []syncjob.ColumnMapping{{Source: "external_id", Target: "external_code"}},
			},
			sourceColumns: noPrimaryKey,
			targetColumns: []connection.ColumnDefinition{{Name: "name", Type: "varchar(64)"}},
			targetExists:  true,
			wantCodes:     []string{"source_primary_key_required"},
		},
		{
			name:          "physical primary key satisfies existing target update",
			definition:    definition,
			sourceColumns: physicalPrimaryKey,
			targetColumns: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}},
			targetExists:  true,
		},
		{
			name:       "business key cannot replace the physical primary key for an existing target update",
			definition: definition,
			mapping: syncjob.TableMapping{
				SourceTable: "orders",
				TargetTable: "orders_archive",
				KeyColumns:  []string{"external_id"},
				Columns: []syncjob.ColumnMapping{
					{Source: "id", Target: "id"},
					{Source: "external_id", Target: "external_code"},
				},
			},
			sourceColumns: append(physicalPrimaryKey, connection.ColumnDefinition{Name: "external_id", Type: "varchar(64)"}),
			targetColumns: []connection.ColumnDefinition{
				{Name: "id", Type: "bigint"},
				{Name: "external_code", Type: "varchar(64)"},
			},
			targetExists: true,
			wantCodes:    []string{"source_primary_key_must_be_used"},
		},
		{
			name:       "physical primary key must be mapped when using field projection",
			definition: definition,
			mapping: syncjob.TableMapping{
				SourceTable: "orders",
				TargetTable: "orders_archive",
				Columns:     []syncjob.ColumnMapping{{Source: "name", Target: "name"}},
			},
			sourceColumns: append(physicalPrimaryKey, connection.ColumnDefinition{Name: "name", Type: "varchar(64)"}),
			targetColumns: []connection.ColumnDefinition{{Name: "name", Type: "varchar(64)"}},
			targetExists:  true,
			wantCodes:     []string{"mapping_key_unmapped"},
		},
		{
			name: "empty mode defaults to insert update",
			definition: func() syncjob.JobDefinition {
				copy := definition
				copy.Options.SyncMode = ""
				return copy
			}(),
			sourceColumns: noPrimaryKey,
			targetExists:  true,
			wantCodes:     []string{"source_primary_key_required"},
		},
		{
			name: "schema-only migration does not compare rows",
			definition: func() syncjob.JobDefinition {
				copy := definition
				copy.Kind = syncjob.JobKindMigration
				copy.Options.Content = "schema"
				return copy
			}(),
			sourceColumns: noPrimaryKey,
			targetExists:  true,
		},
		{
			name: "structure migration cannot use a business key that differs from its physical key",
			definition: func() syncjob.JobDefinition {
				copy := definition
				copy.Kind = syncjob.JobKindMigration
				copy.Options.Content = "both"
				return copy
			}(),
			mapping: syncjob.TableMapping{
				SourceTable: "orders",
				TargetTable: "orders",
				KeyColumns:  []string{"external_id"},
			},
			sourceColumns: append(physicalPrimaryKey, connection.ColumnDefinition{Name: "external_id", Type: "varchar(64)"}),
			targetColumns: []connection.ColumnDefinition{{Name: "external_id", Type: "varchar(64)"}},
			targetExists:  true,
			wantCodes:     []string{"structure_migration_primary_key_required"},
		},
		{
			name: "compare task does not require an update key",
			definition: func() syncjob.JobDefinition {
				copy := definition
				copy.Kind = syncjob.JobKindCompare
				return copy
			}(),
			sourceColumns: noPrimaryKey,
			targetExists:  true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			issues := preflightSourceComparisonKeyIssues(test.definition, test.mapping, test.sourceColumns, test.targetColumns, test.targetExists, "orders")
			if len(issues) != len(test.wantCodes) {
				t.Fatalf("issues = %#v, want codes %#v", issues, test.wantCodes)
			}
			for index, code := range test.wantCodes {
				if issues[index].Code != code || issues[index].Severity != DataSyncJobPreflightBlocker {
					t.Fatalf("issues = %#v, want blocker code %s", issues, code)
				}
			}
		})
	}
}

func TestPreflightQueryComparisonKeyIssuesAcceptMappedBusinessAndCompositeKeys(t *testing.T) {
	tests := []struct {
		name          string
		mapping       syncjob.TableMapping
		targetColumns []connection.ColumnDefinition
		wantCodes     []string
	}{
		{
			name: "mapped query business key supports a target without a physical primary key",
			mapping: syncjob.TableMapping{
				KeyColumns: []string{"external_id"},
				Columns:    []syncjob.ColumnMapping{{Source: "external_id", Target: "external_code"}},
			},
			targetColumns: []connection.ColumnDefinition{{Name: "external_code", Type: "varchar(64)"}},
		},
		{
			name: "mapped composite query business keys support a target without a physical primary key",
			mapping: syncjob.TableMapping{
				KeyColumns: []string{"tenant_id", "event_id"},
				Columns: []syncjob.ColumnMapping{
					{Source: "tenant_id", Target: "tenant_code"},
					{Source: "event_id", Target: "event_code"},
				},
			},
			targetColumns: []connection.ColumnDefinition{
				{Name: "tenant_code", Type: "varchar(64)"},
				{Name: "event_code", Type: "varchar(64)"},
			},
		},
		{
			name:      "missing key is rejected",
			mapping:   syncjob.TableMapping{},
			wantCodes: []string{"query_key_required"},
		},
		{
			name: "unmapped key is rejected",
			mapping: syncjob.TableMapping{
				KeyColumns: []string{"external_id"},
				Columns:    []syncjob.ColumnMapping{{Source: "name", Target: "external_code"}},
			},
			targetColumns: []connection.ColumnDefinition{{Name: "external_code", Type: "varchar(64)", Key: "PRI"}},
			wantCodes:     []string{"query_key_unmapped"},
		},
		{
			name: "mapped key targeting a missing field is rejected",
			mapping: syncjob.TableMapping{
				KeyColumns: []string{"external_id"},
				Columns:    []syncjob.ColumnMapping{{Source: "external_id", Target: "external_code"}},
			},
			targetColumns: []connection.ColumnDefinition{{Name: "name", Type: "varchar(64)"}},
			wantCodes:     []string{"query_key_target_missing"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			issues := preflightQueryComparisonKeyIssues(test.mapping, test.targetColumns, "query -> events")
			if len(issues) != len(test.wantCodes) {
				t.Fatalf("issues = %#v, want codes %#v", issues, test.wantCodes)
			}
			for index, code := range test.wantCodes {
				if issues[index].Code != code || issues[index].Severity != DataSyncJobPreflightBlocker {
					t.Fatalf("issues = %#v, want blocker code %s", issues, code)
				}
			}
		})
	}
}

func TestPreflightImplicitTargetColumnIssuesStopsBatchAndDiffBeforeRuntime(t *testing.T) {
	sourceColumns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Key: "PRI"},
		{Name: "new_column", Type: "varchar(255)"},
	}
	targetColumns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Key: "PRI"}}

	tests := []struct {
		name       string
		definition syncjob.JobDefinition
		mapping    syncjob.TableMapping
		capability sync.MigrationCapability
		wantCode   string
		severity   DataSyncJobPreflightSeverity
	}{
		{
			name:       "data-only reconcile blocks a missing implicit target field",
			definition: approvalTestDefinition(),
			mapping: syncjob.TableMapping{
				SourceTable: "orders", TargetTable: "orders", Enabled: true,
			},
			capability: sync.MigrationCapability{SupportsAutoAddColumns: true},
			wantCode:   "target_columns_missing_for_sync",
			severity:   DataSyncJobPreflightBlocker,
		},
		{
			name: "structure migration reports the field will be added",
			definition: func() syncjob.JobDefinition {
				definition := approvalTestDefinition()
				definition.Kind = syncjob.JobKindMigration
				definition.Options.Content = "both"
				return definition
			}(),
			mapping: syncjob.TableMapping{
				SourceTable: "orders", TargetTable: "orders", Enabled: true,
			},
			capability: sync.MigrationCapability{SupportsAutoAddColumns: true},
			wantCode:   "target_columns_will_be_added",
			severity:   DataSyncJobPreflightInfo,
		},
		{
			name: "structure migration blocks when the route cannot add fields",
			definition: func() syncjob.JobDefinition {
				definition := approvalTestDefinition()
				definition.Kind = syncjob.JobKindMigration
				definition.Options.Content = "both"
				return definition
			}(),
			mapping: syncjob.TableMapping{
				SourceTable: "orders", TargetTable: "orders", Enabled: true,
			},
			capability: sync.MigrationCapability{},
			wantCode:   "target_columns_missing_for_sync",
			severity:   DataSyncJobPreflightBlocker,
		},
		{
			name:       "explicit projection intentionally ignores unmapped source fields",
			definition: approvalTestDefinition(),
			mapping: syncjob.TableMapping{
				SourceTable: "orders", TargetTable: "orders", Enabled: true,
				Columns: []syncjob.ColumnMapping{{Source: "id", Target: "id"}},
			},
			capability: sync.MigrationCapability{SupportsAutoAddColumns: true},
		},
		{
			name: "compare task reports schema differences instead of blocking",
			definition: func() syncjob.JobDefinition {
				definition := approvalTestDefinition()
				definition.Kind = syncjob.JobKindCompare
				return definition
			}(),
			mapping: syncjob.TableMapping{
				SourceTable: "orders", TargetTable: "orders", Enabled: true,
			},
			capability: sync.MigrationCapability{},
		},
		{
			name: "schema-only migration leaves field gaps to the schema planner",
			definition: func() syncjob.JobDefinition {
				definition := approvalTestDefinition()
				definition.Kind = syncjob.JobKindMigration
				definition.Options.Content = "schema"
				return definition
			}(),
			mapping: syncjob.TableMapping{
				SourceTable: "orders", TargetTable: "orders", Enabled: true,
			},
			capability: sync.MigrationCapability{},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			issues := preflightImplicitTargetColumnIssues(test.definition, test.mapping, sourceColumns, targetColumns, test.capability, "orders")
			if test.wantCode == "" {
				if len(issues) != 0 {
					t.Fatalf("issues = %#v, want none", issues)
				}
				return
			}
			if len(issues) != 1 || issues[0].Code != test.wantCode || issues[0].Severity != test.severity {
				t.Fatalf("issues = %#v, want %s (%s)", issues, test.wantCode, test.severity)
			}
		})
	}
}

func TestDataSyncJobQueryMetadataProbeUsesZeroRowWrapperAndChecksMappedFields(t *testing.T) {
	tests := []struct {
		name       string
		database   string
		wantPrefix string
	}{
		{name: "postgres", database: "postgres", wantPrefix: "SELECT * FROM ("},
		{name: "sql server", database: "sqlserver", wantPrefix: "SELECT TOP 0 * FROM ("},
		{name: "oracle", database: "oracle", wantPrefix: "SELECT * FROM ("},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			query := dataSyncJobQueryMetadataProbeSQL(connection.ConnectionConfig{Type: test.database}, "SELECT id AS event_id FROM events;")
			if !strings.HasPrefix(query, test.wantPrefix) || strings.Contains(query, ";") {
				t.Fatalf("metadata query = %q", query)
			}
		})
	}

	mapping := syncjob.TableMapping{Columns: []syncjob.ColumnMapping{{Source: "event_id", Target: "id"}, {Source: "missing", Target: "other"}}}
	issues := preflightQuerySourceColumnIssues(mapping, []string{"event_id"}, "events -> sink")
	if len(issues) != 1 || issues[0].Code != "query_source_column_missing" || issues[0].Severity != DataSyncJobPreflightBlocker {
		t.Fatalf("issues = %#v, want query source field blocker", issues)
	}
}

func TestAppendOnlyTargetPreflightIssuesBlockMutations(t *testing.T) {
	definition := approvalTestDefinition()
	definition.Options.SyncMode = "insert_update"
	definition.Options.PropagateDeletes = true
	issues := appendOnlyTargetPreflightIssues(definition, sync.MigrationCapability{
		TargetType:        "tdengine",
		SupportsMutations: false,
	})
	if len(issues) != 2 || issues[0].Code != "append_only_target_requires_insert_only" || issues[1].Code != "append_only_target_delete_unsupported" {
		t.Fatalf("unexpected append-only target issues: %#v", issues)
	}

	definition.Kind = syncjob.JobKindCompare
	if issues := appendOnlyTargetPreflightIssues(definition, sync.MigrationCapability{TargetType: "tdengine"}); len(issues) != 0 {
		t.Fatalf("compare task must not be blocked by write capability: %#v", issues)
	}
}
