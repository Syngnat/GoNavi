package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/syncjob"
)

func TestDataSyncJobSaveAllowsIncompleteDraft(t *testing.T) {
	application := NewAppWithSecretStore(secretstore.NewUnavailableStore("not needed for an empty draft"))
	application.configDir = t.TempDir()
	t.Cleanup(application.shutdownDataSyncJobs)

	result := application.DataSyncJobSave(syncjob.JobDefinition{
		Name:      "unfinished migration",
		Lifecycle: syncjob.JobLifecycleDraft,
		Approval: &syncjob.ExecutionApproval{
			DefinitionHash:    "forged",
			TargetFingerprint: "forged",
			ApprovedAt:        1,
			ApprovedByRuntime: "desktop",
		},
	}, "")
	if !result.Success {
		t.Fatalf("save draft failed: %s", result.Message)
	}
	saved, ok := result.Data.(syncjob.JobDefinition)
	if !ok {
		t.Fatalf("save draft returned %T, want syncjob.JobDefinition", result.Data)
	}
	if saved.ID == "" || saved.Lifecycle != syncjob.JobLifecycleDraft || saved.Enabled {
		t.Fatalf("unexpected persisted draft: %#v", saved)
	}
	if saved.Approval != nil {
		t.Fatal("draft save persisted a caller-supplied approval")
	}

	start := application.DataSyncRunStart(saved.ID, saved.Revision, "")
	if start.Success {
		t.Fatal("draft task must not be executable")
	}
}

func TestDataSyncJobSaveRejectsExistingLifecycleRegressionToDraft(t *testing.T) {
	application := NewAppWithSecretStore(secretstore.NewUnavailableStore("endpoint resolution must not run"))
	application.configDir = t.TempDir()
	t.Cleanup(application.shutdownDataSyncJobs)
	manager, err := application.ensureDataSyncJobManager()
	if err != nil {
		t.Fatalf("create manager: %v", err)
	}

	for _, lifecycle := range []syncjob.JobLifecycle{
		syncjob.JobLifecycleReady,
		syncjob.JobLifecycleEnabled,
		syncjob.JobLifecyclePaused,
		syncjob.JobLifecycleArchived,
	} {
		t.Run(string(lifecycle), func(t *testing.T) {
			definition := approvalTestDefinition()
			definition.Name = "lifecycle " + string(lifecycle)
			definition.Lifecycle = lifecycle
			saved, err := manager.PutJob(context.Background(), definition)
			if err != nil {
				t.Fatalf("persist %s job: %v", lifecycle, err)
			}
			saved.Lifecycle = syncjob.JobLifecycleDraft
			saved.Enabled = false
			result := application.DataSyncJobSave(saved, "")
			if result.Success || !strings.Contains(result.Message, "cannot transition") {
				t.Fatalf("%s -> draft result = success:%v message:%q", lifecycle, result.Success, result.Message)
			}
			persisted, err := manager.GetJob(context.Background(), saved.ID)
			if err != nil || persisted.Lifecycle != lifecycle {
				t.Fatalf("persisted lifecycle = %s, err=%v", persisted.Lifecycle, err)
			}
		})
	}
}

func TestDataSyncCheckpointResetRequiresPausedCurrentRevisionAndInvalidatesApproval(t *testing.T) {
	application := NewApp()
	application.configDir = t.TempDir()
	t.Cleanup(application.shutdownDataSyncJobs)
	manager, definition := putDataSyncCheckpointResetFixture(t, application, syncjob.JobLifecyclePaused, syncjob.RunStatusFailed)
	if _, _, err := application.issueDataSyncJobApproval(definition, definition.Target.Fingerprint, time.Now()); err != nil {
		t.Fatalf("seed approval token: %v", err)
	}
	if _, _, _, err := application.beginDataSyncJobApproval(definition, definition.Target.Fingerprint, time.Now()); err != nil {
		t.Fatalf("seed approval challenge: %v", err)
	}

	if result := application.DataSyncCheckpointReset(definition.ID, 0); result.Success || !strings.Contains(result.Message, "requires the current task revision") {
		t.Fatalf("missing revision result = success:%v message:%q", result.Success, result.Message)
	}
	if result := application.DataSyncCheckpointReset(definition.ID, definition.Revision-1); result.Success || !strings.Contains(result.Message, "revision changed") {
		t.Fatalf("stale revision result = success:%v message:%q", result.Success, result.Message)
	}

	result := application.DataSyncCheckpointReset(definition.ID, definition.Revision)
	if !result.Success {
		t.Fatalf("reset checkpoint: %s", result.Message)
	}
	returned, ok := result.Data.(syncjob.JobDefinition)
	if !ok || returned.Revision != definition.Revision+1 || returned.Approval != nil {
		t.Fatalf("reset response = %#v", result.Data)
	}
	persisted, err := manager.GetJob(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("reload reset job: %v", err)
	}
	if persisted.Revision != definition.Revision+1 || persisted.Approval != nil || persisted.Lifecycle != syncjob.JobLifecyclePaused {
		t.Fatalf("persisted reset job = %#v", persisted)
	}
	application.dataSyncJobApprovalMu.Lock()
	remainingTokens := len(application.dataSyncJobApprovalTokens)
	remainingChallenges := len(application.dataSyncJobApprovalChallenges)
	application.dataSyncJobApprovalMu.Unlock()
	if remainingTokens != 0 || remainingChallenges != 0 {
		t.Fatalf("reset left %d approval tokens and %d challenges", remainingTokens, remainingChallenges)
	}
	if _, err := manager.GetCheckpoint(context.Background(), definition.ID); !errors.Is(err, syncjob.ErrNotFound) {
		t.Fatalf("checkpoint after reset error = %v, want not found", err)
	}
}

func TestDataSyncCheckpointResetRejectsRunnableTaskAndActiveRun(t *testing.T) {
	t.Run("ready lifecycle", func(t *testing.T) {
		application := NewApp()
		application.configDir = t.TempDir()
		t.Cleanup(application.shutdownDataSyncJobs)
		manager, definition := putDataSyncCheckpointResetFixture(t, application, syncjob.JobLifecycleReady, syncjob.RunStatusFailed)

		result := application.DataSyncCheckpointReset(definition.ID, definition.Revision)
		if result.Success || !strings.Contains(result.Message, "requires a paused task") {
			t.Fatalf("ready reset result = success:%v message:%q", result.Success, result.Message)
		}
		if _, err := manager.GetCheckpoint(context.Background(), definition.ID); err != nil {
			t.Fatalf("rejected reset removed checkpoint: %v", err)
		}
	})

	t.Run("active run", func(t *testing.T) {
		application := NewApp()
		application.configDir = t.TempDir()
		t.Cleanup(application.shutdownDataSyncJobs)
		manager, definition := putDataSyncCheckpointResetFixture(t, application, syncjob.JobLifecyclePaused, syncjob.RunStatusRunning)

		result := application.DataSyncCheckpointReset(definition.ID, definition.Revision)
		if result.Success || !strings.Contains(result.Message, "requires no active run") {
			t.Fatalf("active reset result = success:%v message:%q", result.Success, result.Message)
		}
		persisted, err := manager.GetJob(context.Background(), definition.ID)
		if err != nil || persisted.Revision != definition.Revision || persisted.Approval == nil {
			t.Fatalf("rejected reset mutated job = %#v, err=%v", persisted, err)
		}
		if _, err := manager.GetCheckpoint(context.Background(), definition.ID); err != nil {
			t.Fatalf("rejected reset removed checkpoint: %v", err)
		}
	})
}

func putDataSyncCheckpointResetFixture(
	t *testing.T,
	application *App,
	lifecycle syncjob.JobLifecycle,
	runStatus syncjob.RunStatus,
) (*syncjob.Manager, syncjob.JobDefinition) {
	t.Helper()
	manager, err := application.ensureDataSyncJobManager()
	if err != nil {
		t.Fatalf("create manager: %v", err)
	}
	definition := approvalTestDefinition()
	definition.Name = "checkpoint reset fixture"
	definition.Lifecycle = lifecycle
	definition.Source.Fingerprint = "source-fingerprint"
	definition.Target.Fingerprint = "target-fingerprint"
	definition, err = manager.PutJob(context.Background(), definition)
	if err != nil {
		t.Fatalf("persist checkpoint job: %v", err)
	}
	approvalHash, err := dataSyncJobApprovalScopeHash(definition)
	if err != nil {
		t.Fatalf("hash checkpoint approval: %v", err)
	}
	definition.Approval = &syncjob.ExecutionApproval{
		DefinitionHash:    approvalHash,
		TargetFingerprint: definition.Target.Fingerprint,
		ApprovedAt:        1,
		ApprovedByRuntime: "desktop",
	}
	definition, err = manager.PutJob(context.Background(), definition)
	if err != nil {
		t.Fatalf("persist checkpoint approval: %v", err)
	}
	snapshot, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("encode checkpoint run snapshot: %v", err)
	}
	run, err := application.dataSyncJobStore.CreateRun(context.Background(), syncjob.RunRecord{
		JobID:              definition.ID,
		JobRevision:        definition.Revision,
		Status:             runStatus,
		DefinitionSnapshot: snapshot,
	})
	if err != nil {
		t.Fatalf("create checkpoint run: %v", err)
	}
	if _, err := application.dataSyncJobStore.PutCheckpoint(context.Background(), syncjob.Checkpoint{
		Kind:               "watermark",
		JobID:              definition.ID,
		RunID:              run.ID,
		DefinitionRevision: definition.Revision,
		Table:              "orders",
		Phase:              "batch_committed",
		CursorType:         "watermark_map",
		Cursor:             json.RawMessage(`{"orders":{"id":42}}`),
	}); err != nil {
		t.Fatalf("persist checkpoint: %v", err)
	}
	return manager, definition
}
