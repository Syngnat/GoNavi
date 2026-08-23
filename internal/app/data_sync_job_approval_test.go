package app

import (
	"testing"
	"time"

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
