package app

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"
)

func TestStartSecurityUpdateCreatesBackupAndImportsSavedConfig(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":      "openai-main",
				"type":    "openai",
				"name":    "OpenAI",
				"apiKey":  "sk-ai-test",
				"baseUrl": "https://api.openai.com/v1",
				"headers": map[string]any{
					"Authorization": "Bearer ai-test",
					"X-Team":        "platform",
				},
			},
		},
	})

	status, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusCompleted {
		t.Fatalf("expected completed status, got %q", status.OverallStatus)
	}
	if status.MigrationID == "" {
		t.Fatal("expected migration ID to be created")
	}
	if status.Summary.Total != 3 || status.Summary.Updated != 3 {
		t.Fatalf("expected summary total=3 updated=3, got %#v", status.Summary)
	}

	savedConnections, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(savedConnections) != 1 {
		t.Fatalf("expected 1 saved connection, got %d", len(savedConnections))
	}
	resolvedConnection, err := app.resolveConnectionSecrets(savedConnections[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolvedConnection.Password != "postgres-secret" {
		t.Fatalf("expected imported connection password, got %q", resolvedConnection.Password)
	}

	globalProxyView, err := app.loadStoredGlobalProxyView()
	if err != nil {
		t.Fatalf("loadStoredGlobalProxyView returned error: %v", err)
	}
	globalProxyBundle, err := app.loadGlobalProxySecretBundle(globalProxyView)
	if err != nil {
		t.Fatalf("loadGlobalProxySecretBundle returned error: %v", err)
	}
	if globalProxyBundle.Password != "proxy-secret" {
		t.Fatalf("expected imported proxy password, got %q", globalProxyBundle.Password)
	}

	providerStore := aiservice.NewProviderConfigStore(app.configDir, app.secretStore)
	providerSnapshot, err := providerStore.Load()
	if err != nil {
		t.Fatalf("provider store Load returned error: %v", err)
	}
	if len(providerSnapshot.Providers) != 1 {
		t.Fatalf("expected 1 AI provider, got %d", len(providerSnapshot.Providers))
	}
	if providerSnapshot.Providers[0].APIKey != "sk-ai-test" {
		t.Fatalf("expected migrated AI provider apiKey, got %q", providerSnapshot.Providers[0].APIKey)
	}

	for _, name := range []string{
		securityUpdateManifestFileName,
		securityUpdateSourceCurrentAppFileName,
		securityUpdateNormalizedPreviewFileName,
		securityUpdateResultFileName,
	} {
		if _, err := os.Stat(filepath.Join(status.BackupPath, name)); err != nil {
			t.Fatalf("expected backup artifact %q: %v", name, err)
		}
	}
}

func TestGetSecurityUpdateStatusReturnsPendingWhenOnlyAIProviderNeedsSecurityUpdate(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":      "openai-main",
				"type":    "openai",
				"name":    "OpenAI",
				"apiKey":  "sk-ai-test",
				"baseUrl": "https://api.openai.com/v1",
			},
		},
	})

	status, err := app.GetSecurityUpdateStatus()
	if err != nil {
		t.Fatalf("GetSecurityUpdateStatus returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusPending {
		t.Fatalf("expected pending status, got %q", status.OverallStatus)
	}
	if !status.CanStart || !status.ReminderVisible {
		t.Fatalf("expected pending status to expose start/reminder flags, got %#v", status)
	}
}

func TestGetSecurityUpdateStatusIncludesPendingAIProviderIssuesBeforeStart(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage("en-US")

	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":      "openai-main",
				"type":    "openai",
				"name":    "OpenAI",
				"apiKey":  "sk-ai-test",
				"baseUrl": "https://api.openai.com/v1",
			},
		},
	})

	status, err := app.GetSecurityUpdateStatus()
	if err != nil {
		t.Fatalf("GetSecurityUpdateStatus returned error: %v", err)
	}
	if len(status.Issues) != 1 {
		t.Fatalf("expected 1 pending issue, got %#v", status.Issues)
	}
	if status.Summary.Total != 1 || status.Summary.Pending != 1 {
		t.Fatalf("expected summary total=1 pending=1, got %#v", status.Summary)
	}
	issue := status.Issues[0]
	if issue.Scope != SecurityUpdateIssueScopeAIProvider {
		t.Fatalf("expected AI provider issue scope, got %#v", issue)
	}
	if issue.RefID != "openai-main" || issue.Title != "OpenAI" {
		t.Fatalf("expected provider issue to point at openai-main/OpenAI, got %#v", issue)
	}
	if issue.Status != SecurityUpdateItemStatusPending || issue.Action != SecurityUpdateIssueActionOpenAISettings {
		t.Fatalf("expected pending AI settings issue, got %#v", issue)
	}
	if issue.Message != "AI provider configuration is still saved in the current app configuration. After the security update completes, it will be moved to the new secure storage." {
		t.Fatalf("expected localized AI provider migration message, got %q", issue.Message)
	}
}




func TestRetrySecurityUpdateCurrentRoundReusesMigrationIDAfterPendingIssueIsFixed(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	ref, err := secretstore.BuildRef("ai-provider", "openai-main")
	if err != nil {
		t.Fatalf("BuildRef returned error: %v", err)
	}
	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":        "openai-main",
				"type":      "openai",
				"name":      "OpenAI",
				"hasSecret": true,
				"secretRef": ref,
				"baseUrl":   "https://api.openai.com/v1",
			},
		},
	})

	initial, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if initial.OverallStatus != SecurityUpdateOverallStatusCompleted {
		t.Fatalf("expected completed status, got %q", initial.OverallStatus)
	}

	if err := store.Put(ref, []byte(`{"apiKey":"sk-fixed","sensitiveHeaders":{"Authorization":"Bearer fixed"}}`)); err != nil {
		t.Fatalf("Put returned error: %v", err)
	}

	retried, err := app.RetrySecurityUpdateCurrentRound(RetrySecurityUpdateRequest{
		MigrationID: initial.MigrationID,
	})
	if err == nil {
		t.Fatalf("expected retry to be rejected after completed round, got %#v", retried)
	}
	if !strings.Contains(err.Error(), "requires status needs_attention") {
		t.Fatalf("expected completed round retry rejection, got %v", err)
	}
}

func TestRetrySecurityUpdateCurrentRoundDoesNotReimportBrokenLegacySourceAfterUserFix(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	ref, err := secretstore.BuildRef("ai-provider", "openai-main")
	if err != nil {
		t.Fatalf("BuildRef returned error: %v", err)
	}
	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":        "openai-main",
				"type":      "openai",
				"name":      "OpenAI",
				"hasSecret": true,
				"secretRef": ref,
				"baseUrl":   "https://api.openai.com/v1",
			},
		},
	})

	initial, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if initial.OverallStatus != SecurityUpdateOverallStatusCompleted {
		t.Fatalf("expected completed status, got %q", initial.OverallStatus)
	}

	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "legacy-1",
		Name: "Legacy Fixed",
		Config: connection.ConnectionConfig{
			ID:       "legacy-1",
			Type:     "postgres",
			Host:     "db-fixed.local",
			Port:     5432,
			User:     "postgres",
			Password: "postgres-fixed",
		},
	}); err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	if err := store.Put(ref, []byte(`{"apiKey":"sk-fixed"}`)); err != nil {
		t.Fatalf("Put returned error: %v", err)
	}

	retried, err := app.RetrySecurityUpdateCurrentRound(RetrySecurityUpdateRequest{
		MigrationID: initial.MigrationID,
	})
	if err == nil {
		t.Fatalf("expected retry to be rejected after completed round, got %#v", retried)
	}
	if !strings.Contains(err.Error(), "requires status needs_attention") {
		t.Fatalf("expected completed round retry rejection, got %v", err)
	}

	savedConnections, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(savedConnections) != 1 {
		t.Fatalf("expected 1 saved connection, got %d", len(savedConnections))
	}

	resolvedConnection, err := app.resolveConnectionSecrets(savedConnections[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolvedConnection.Host != "db-fixed.local" {
		t.Fatalf("expected retry to keep user-fixed host, got %q", resolvedConnection.Host)
	}
	if resolvedConnection.Password != "postgres-fixed" {
		t.Fatalf("expected retry to keep user-fixed password, got %q", resolvedConnection.Password)
	}
}

func TestRetrySecurityUpdateCurrentRoundLocalizesConnectionIssueMessage(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage("en-US")

	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":      "openai-main",
				"type":    "openai",
				"name":    "OpenAI",
				"apiKey":  "sk-ai-test",
				"baseUrl": "https://api.openai.com/v1",
			},
		},
	})

	completed, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if completed.OverallStatus != SecurityUpdateOverallStatusCompleted {
		t.Fatalf("expected completed status, got %q", completed.OverallStatus)
	}

	connectionRepo := app.savedConnectionRepository()
	if err := connectionRepo.deleteSecretBundle("legacy-1"); err != nil {
		t.Fatalf("deleteSecretBundle returned error: %v", err)
	}

	repo := newSecurityUpdateStateRepository(app.configDir)
	retryable := completed
	retryable.OverallStatus = SecurityUpdateOverallStatusNeedsAttention
	if err := repo.WriteResult(retryable); err != nil {
		t.Fatalf("WriteResult returned error: %v", err)
	}

	retried, err := app.RetrySecurityUpdateCurrentRound(RetrySecurityUpdateRequest{
		MigrationID: completed.MigrationID,
	})
	if err != nil {
		t.Fatalf("RetrySecurityUpdateCurrentRound returned error: %v", err)
	}
	if retried.OverallStatus != SecurityUpdateOverallStatusNeedsAttention {
		t.Fatalf("expected needs_attention status, got %q", retried.OverallStatus)
	}
	if len(retried.Issues) != 1 {
		t.Fatalf("expected one connection issue, got %#v", retried.Issues)
	}
	issue := retried.Issues[0]
	if issue.Scope != SecurityUpdateIssueScopeConnection || issue.RefID != "legacy-1" {
		t.Fatalf("expected legacy-1 connection issue, got %#v", issue)
	}
	if issue.Title != "Legacy" {
		t.Fatalf("expected connection name to stay raw, got %q", issue.Title)
	}
	if issue.Message != "Connection configuration still needs more information before the security update can be completed." {
		t.Fatalf("expected localized connection issue message, got %q", issue.Message)
	}
}

func TestRetrySecurityUpdateCurrentRoundLocalizesGlobalProxyIssueText(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage("en-US")

	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":      "openai-main",
				"type":    "openai",
				"name":    "OpenAI",
				"apiKey":  "sk-ai-test",
				"baseUrl": "https://api.openai.com/v1",
			},
		},
	})

	completed, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if completed.OverallStatus != SecurityUpdateOverallStatusCompleted {
		t.Fatalf("expected completed status, got %q", completed.OverallStatus)
	}

	if err := app.dailySecretStore().DeleteGlobalProxy(); err != nil {
		t.Fatalf("DeleteGlobalProxy returned error: %v", err)
	}

	repo := newSecurityUpdateStateRepository(app.configDir)
	retryable := completed
	retryable.OverallStatus = SecurityUpdateOverallStatusNeedsAttention
	if err := repo.WriteResult(retryable); err != nil {
		t.Fatalf("WriteResult returned error: %v", err)
	}

	retried, err := app.RetrySecurityUpdateCurrentRound(RetrySecurityUpdateRequest{
		MigrationID: completed.MigrationID,
	})
	if err != nil {
		t.Fatalf("RetrySecurityUpdateCurrentRound returned error: %v", err)
	}
	if retried.OverallStatus != SecurityUpdateOverallStatusNeedsAttention {
		t.Fatalf("expected needs_attention status, got %q", retried.OverallStatus)
	}
	if len(retried.Issues) != 1 {
		t.Fatalf("expected one global proxy issue, got %#v", retried.Issues)
	}
	issue := retried.Issues[0]
	if issue.Scope != SecurityUpdateIssueScopeGlobalProxy {
		t.Fatalf("expected global proxy issue, got %#v", issue)
	}
	if issue.Title != "Global Proxy" {
		t.Fatalf("expected localized global proxy title, got %q", issue.Title)
	}
	if issue.Message != "Global proxy password is missing. Save it again before continuing." {
		t.Fatalf("expected localized global proxy issue message, got %q", issue.Message)
	}
}

func TestRestartSecurityUpdateCreatesNewMigrationID(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	initial, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}

	restarted, err := app.RestartSecurityUpdate(RestartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("RestartSecurityUpdate returned error: %v", err)
	}
	if restarted.MigrationID == initial.MigrationID {
		t.Fatal("expected restart to create a new migration ID")
	}
}

func TestDismissSecurityUpdateReminderMarksStatusPostponed(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	status, err := app.DismissSecurityUpdateReminder()
	if err != nil {
		t.Fatalf("DismissSecurityUpdateReminder returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusPostponed {
		t.Fatalf("expected postponed status, got %q", status.OverallStatus)
	}
	if status.PostponedAt == "" {
		t.Fatal("expected postponedAt to be recorded")
	}
}

func TestDismissSecurityUpdateReminderKeepsCurrentRoundContext(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	ref, err := secretstore.BuildRef("ai-provider", "openai-main")
	if err != nil {
		t.Fatalf("BuildRef returned error: %v", err)
	}
	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":        "openai-main",
				"type":      "openai",
				"name":      "OpenAI",
				"hasSecret": true,
				"secretRef": ref,
				"baseUrl":   "https://api.openai.com/v1",
			},
		},
	})

	initial, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if initial.OverallStatus != SecurityUpdateOverallStatusCompleted {
		t.Fatalf("expected completed status, got %q", initial.OverallStatus)
	}

	postponed, err := app.DismissSecurityUpdateReminder()
	if err != nil {
		t.Fatalf("DismissSecurityUpdateReminder returned error: %v", err)
	}
	if postponed.OverallStatus != SecurityUpdateOverallStatusCompleted {
		t.Fatalf("expected completed status to be preserved, got %q", postponed.OverallStatus)
	}
	if postponed.MigrationID != initial.MigrationID {
		t.Fatalf("expected migration ID %q to be preserved, got %q", initial.MigrationID, postponed.MigrationID)
	}
	if postponed.BackupPath != initial.BackupPath {
		t.Fatalf("expected backupPath %q to be preserved, got %q", initial.BackupPath, postponed.BackupPath)
	}
	if postponed.Summary != initial.Summary {
		t.Fatalf("expected summary %#v to be preserved, got %#v", initial.Summary, postponed.Summary)
	}
	if len(postponed.Issues) != len(initial.Issues) {
		t.Fatalf("expected %d issues to be preserved, got %#v", len(initial.Issues), postponed.Issues)
	}
	if postponed.PostponedAt != "" {
		t.Fatalf("expected completed round to keep empty postponedAt, got %q", postponed.PostponedAt)
	}
}

func TestDismissSecurityUpdateReminderKeepsPendingAIProviderDetailsWithoutCurrentRound(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":      "openai-main",
				"type":    "openai",
				"name":    "OpenAI",
				"apiKey":  "sk-ai-test",
				"baseUrl": "https://api.openai.com/v1",
			},
		},
	})

	status, err := app.DismissSecurityUpdateReminder()
	if err != nil {
		t.Fatalf("DismissSecurityUpdateReminder returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusPostponed {
		t.Fatalf("expected postponed status, got %q", status.OverallStatus)
	}
	if status.Summary.Total != 1 || status.Summary.Pending != 1 {
		t.Fatalf("expected summary total=1 pending=1, got %#v", status.Summary)
	}
	if len(status.Issues) != 1 {
		t.Fatalf("expected 1 pending issue, got %#v", status.Issues)
	}
	if status.Issues[0].RefID != "openai-main" || status.Issues[0].Action != SecurityUpdateIssueActionOpenAISettings {
		t.Fatalf("expected postponed issue to keep AI provider repair entry, got %#v", status.Issues[0])
	}
}

func TestDismissSecurityUpdateReminderDoesNotOverrideCompletedRound(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	repo := newSecurityUpdateStateRepository(app.configDir)
	completed := SecurityUpdateStatus{
		SchemaVersion: securityUpdateSchemaVersion,
		MigrationID:   "migration-1",
		OverallStatus: SecurityUpdateOverallStatusCompleted,
		SourceType:    SecurityUpdateSourceTypeCurrentAppSavedConfig,
		BackupPath:    filepath.Join(app.configDir, securityUpdateBackupRootDirName, "migration-1"),
		StartedAt:     "2026-04-09T00:00:00Z",
		UpdatedAt:     "2026-04-09T00:05:00Z",
		CompletedAt:   "2026-04-09T00:05:00Z",
		Summary: SecurityUpdateSummary{
			Total:   1,
			Updated: 1,
		},
		Issues: []SecurityUpdateIssue{},
	}
	if err := repo.WriteResult(completed); err != nil {
		t.Fatalf("WriteResult returned error: %v", err)
	}

	status, err := app.DismissSecurityUpdateReminder()
	if err != nil {
		t.Fatalf("DismissSecurityUpdateReminder returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusCompleted {
		t.Fatalf("expected completed status to be preserved, got %q", status.OverallStatus)
	}
	if status.MigrationID != completed.MigrationID {
		t.Fatalf("expected migration ID %q to be preserved, got %q", completed.MigrationID, status.MigrationID)
	}
	if status.PostponedAt != "" {
		t.Fatalf("expected completed round to keep empty postponedAt, got %q", status.PostponedAt)
	}
}

func TestDismissSecurityUpdateReminderDoesNotOverrideRolledBackRound(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	repo := newSecurityUpdateStateRepository(app.configDir)
	rolledBack := SecurityUpdateStatus{
		SchemaVersion: securityUpdateSchemaVersion,
		MigrationID:   "migration-1",
		OverallStatus: SecurityUpdateOverallStatusRolledBack,
		SourceType:    SecurityUpdateSourceTypeCurrentAppSavedConfig,
		BackupPath:    filepath.Join(app.configDir, securityUpdateBackupRootDirName, "migration-1"),
		StartedAt:     "2026-04-09T00:00:00Z",
		UpdatedAt:     "2026-04-09T00:05:00Z",
		Summary: SecurityUpdateSummary{
			Total:  1,
			Failed: 1,
		},
		Issues: []SecurityUpdateIssue{
			{
				ID:         "system-blocked",
				Scope:      SecurityUpdateIssueScopeSystem,
				Title:      "安全更新未完成",
				Severity:   SecurityUpdateIssueSeverityHigh,
				Status:     SecurityUpdateItemStatusFailed,
				ReasonCode: SecurityUpdateIssueReasonCodeEnvironmentBlocked,
				Action:     SecurityUpdateIssueActionViewDetails,
				Message:    "当前环境无法完成本次安全更新，请稍后重试",
			},
		},
	}
	if err := repo.WriteResult(rolledBack); err != nil {
		t.Fatalf("WriteResult returned error: %v", err)
	}

	status, err := app.DismissSecurityUpdateReminder()
	if err != nil {
		t.Fatalf("DismissSecurityUpdateReminder returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusRolledBack {
		t.Fatalf("expected rolled_back status to be preserved, got %q", status.OverallStatus)
	}
	if status.MigrationID != rolledBack.MigrationID {
		t.Fatalf("expected migration ID %q to be preserved, got %q", rolledBack.MigrationID, status.MigrationID)
	}
	if status.PostponedAt != "" {
		t.Fatalf("expected rolled_back round to keep empty postponedAt, got %q", status.PostponedAt)
	}
	if len(status.Issues) != 1 || status.Issues[0].Scope != SecurityUpdateIssueScopeSystem {
		t.Fatalf("expected rolled_back issue details to be preserved, got %#v", status.Issues)
	}
}

func TestStartSecurityUpdateRollsBackWhenSecretStoreUnavailable(t *testing.T) {
	withTestGOOS(t, "linux")

	app := NewAppWithSecretStore(nil)
	app.configDir = t.TempDir()

	status, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusCompleted {
		t.Fatalf("expected completed status, got %q", status.OverallStatus)
	}
	if len(status.Issues) != 0 {
		t.Fatalf("expected no blocking issues, got %#v", status.Issues)
	}
}

func TestStartSecurityUpdateRollsBackWhenAIProviderSecretStoreUnavailable(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("blocked"))
	app.configDir = t.TempDir()

	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":      "openai-main",
				"type":    "openai",
				"name":    "OpenAI",
				"apiKey":  "sk-ai-test",
				"baseUrl": "https://api.openai.com/v1",
			},
		},
	})

	status, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: "",
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusCompleted {
		t.Fatalf("expected completed status, got %q", status.OverallStatus)
	}
	if len(status.Issues) != 0 {
		t.Fatalf("expected no blocking issues, got %#v", status.Issues)
	}
}

func TestStartSecurityUpdateRollsBackPartialConnectionImportWhenLaterProviderStepFails(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("blocked"))
	app.configDir = t.TempDir()

	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":      "openai-main",
				"type":    "openai",
				"name":    "OpenAI",
				"apiKey":  "sk-ai-test",
				"baseUrl": "https://api.openai.com/v1",
			},
		},
	})

	payload, err := json.Marshal(map[string]any{
		"state": map[string]any{
			"connections": []map[string]any{
				{
					"id":   "legacy-1",
					"name": "Legacy",
					"config": map[string]any{
						"id":   "legacy-1",
						"type": "postgres",
						"host": "db.local",
						"port": 5432,
						"user": "postgres",
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("Marshal returned error: %v", err)
	}

	status, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: string(payload),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusCompleted {
		t.Fatalf("expected completed status, got %q", status.OverallStatus)
	}

	savedConnections, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(savedConnections) != 1 {
		t.Fatalf("expected imported connection to remain after completed update, got %#v", savedConnections)
	}
	if savedConnections[0].ID != "legacy-1" || savedConnections[0].Config.Host != "db.local" {
		t.Fatalf("expected imported connection metadata to be preserved, got %#v", savedConnections[0])
	}
}

func TestStartSecurityUpdateRollsBackExistingConnectionMetadataAndSecretWhenLaterProviderStepFails(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "legacy-1",
		Name: "Existing",
		Config: connection.ConnectionConfig{
			ID:       "legacy-1",
			Type:     "postgres",
			Host:     "db-old.local",
			Port:     5432,
			User:     "postgres",
			Password: "old-secret",
		},
	}); err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	if err := os.WriteFile(filepath.Join(app.configDir, "ai_config.json"), []byte("{"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	payload, err := json.Marshal(map[string]any{
		"state": map[string]any{
			"connections": []map[string]any{
				{
					"id":   "legacy-1",
					"name": "Migrated",
					"config": map[string]any{
						"id":       "legacy-1",
						"type":     "postgres",
						"host":     "db-new.local",
						"port":     5432,
						"user":     "postgres",
						"password": "new-secret",
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("Marshal returned error: %v", err)
	}

	status, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: string(payload),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusRolledBack {
		t.Fatalf("expected rolled_back status, got %q", status.OverallStatus)
	}

	savedConnections, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(savedConnections) != 1 {
		t.Fatalf("expected existing connection to remain, got %#v", savedConnections)
	}
	if savedConnections[0].Name != "Existing" || savedConnections[0].Config.Host != "db-old.local" {
		t.Fatalf("expected existing connection metadata to be restored, got %#v", savedConnections[0])
	}
	resolved, err := app.resolveConnectionSecrets(savedConnections[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "old-secret" {
		t.Fatalf("expected existing connection secret to be restored, got %q", resolved.Password)
	}
}

func TestStartSecurityUpdateRollsBackExistingGlobalProxyWhenLaterProviderStepFails(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	if _, err := app.saveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled:  true,
		Type:     "http",
		Host:     "proxy-old.local",
		Port:     8080,
		User:     "ops",
		Password: "old-proxy-secret",
	}); err != nil {
		t.Fatalf("saveGlobalProxy returned error: %v", err)
	}

	if err := os.WriteFile(filepath.Join(app.configDir, "ai_config.json"), []byte("{"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	payload, err := json.Marshal(map[string]any{
		"state": map[string]any{
			"globalProxy": map[string]any{
				"enabled":  true,
				"type":     "http",
				"host":     "proxy-new.local",
				"port":     8081,
				"user":     "ops-new",
				"password": "new-proxy-secret",
			},
		},
	})
	if err != nil {
		t.Fatalf("Marshal returned error: %v", err)
	}

	status, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: string(payload),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusRolledBack {
		t.Fatalf("expected rolled_back status, got %q", status.OverallStatus)
	}

	view, err := app.loadStoredGlobalProxyView()
	if err != nil {
		t.Fatalf("loadStoredGlobalProxyView returned error: %v", err)
	}
	if view.Host != "proxy-old.local" || view.Port != 8080 || view.User != "ops" {
		t.Fatalf("expected existing global proxy metadata to be restored, got %#v", view)
	}
	bundle, err := app.loadGlobalProxySecretBundle(view)
	if err != nil {
		t.Fatalf("loadGlobalProxySecretBundle returned error: %v", err)
	}
	if bundle.Password != "old-proxy-secret" {
		t.Fatalf("expected existing global proxy secret to be restored, got %q", bundle.Password)
	}
}

func TestStartSecurityUpdateRollsBackAllChangesWhenPreviewArtifactWriteFails(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":      "openai-main",
				"type":    "openai",
				"name":    "OpenAI",
				"apiKey":  "sk-ai-test",
				"baseUrl": "https://api.openai.com/v1",
				"headers": map[string]any{
					"Authorization": "Bearer ai-test",
				},
			},
		},
	})

	restoreWriteJSONFile := swapSecurityUpdateWriteJSONFile(func(path string, payload any) error {
		if strings.HasSuffix(filepath.ToSlash(path), "/"+securityUpdateNormalizedPreviewFileName) {
			return errors.New("forced preview write failure")
		}
		return writeJSONFile(path, payload)
	})
	defer restoreWriteJSONFile()

	status, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusRolledBack {
		t.Fatalf("expected rolled_back status, got %q", status.OverallStatus)
	}

	assertSecurityUpdateRollbackRestoredCurrentAppState(t, app, store)
}

func TestStartSecurityUpdateLocalizesSystemFailureIssue(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()
	app.SetLanguage("en-US")

	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":      "openai-main",
				"type":    "openai",
				"name":    "OpenAI",
				"apiKey":  "sk-ai-test",
				"baseUrl": "https://api.openai.com/v1",
			},
		},
	})

	restoreWriteJSONFile := swapSecurityUpdateWriteJSONFile(func(path string, payload any) error {
		if strings.HasSuffix(filepath.ToSlash(path), "/"+securityUpdateNormalizedPreviewFileName) {
			return errors.New("forced preview write failure")
		}
		return writeJSONFile(path, payload)
	})
	defer restoreWriteJSONFile()

	status, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusRolledBack {
		t.Fatalf("expected rolled_back status, got %q", status.OverallStatus)
	}
	if len(status.Issues) != 1 {
		t.Fatalf("expected one system issue, got %#v", status.Issues)
	}
	issue := status.Issues[0]
	if issue.Title != "Security update was not completed" {
		t.Fatalf("expected localized system issue title, got %q", issue.Title)
	}
	if issue.Message != "The current environment could not complete this security update. Try again later." {
		t.Fatalf("expected localized system issue message, got %q", issue.Message)
	}
	if !strings.Contains(status.LastError, "forced preview write failure") {
		t.Fatalf("expected raw last error to be preserved, got %q", status.LastError)
	}
}

func TestStartSecurityUpdateRollsBackAllChangesWhenFinalResultWriteFails(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	writeLegacyAIProviderConfig(t, app.configDir, map[string]any{
		"providers": []map[string]any{
			{
				"id":      "openai-main",
				"type":    "openai",
				"name":    "OpenAI",
				"apiKey":  "sk-ai-test",
				"baseUrl": "https://api.openai.com/v1",
				"headers": map[string]any{
					"Authorization": "Bearer ai-test",
				},
			},
		},
	})

	resultWrites := 0
	restoreWriteJSONFile := swapSecurityUpdateWriteJSONFile(func(path string, payload any) error {
		if strings.HasSuffix(filepath.ToSlash(path), "/"+securityUpdateResultFileName) {
			resultWrites++
			if resultWrites == 2 {
				return errors.New("forced result write failure")
			}
		}
		return writeJSONFile(path, payload)
	})
	defer restoreWriteJSONFile()

	status, err := app.StartSecurityUpdate(StartSecurityUpdateRequest{
		SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig,
		RawPayload: buildLegacySecurityUpdatePayload(),
	})
	if err != nil {
		t.Fatalf("StartSecurityUpdate returned error: %v", err)
	}
	if status.OverallStatus != SecurityUpdateOverallStatusRolledBack {
		t.Fatalf("expected rolled_back status, got %q", status.OverallStatus)
	}

	assertSecurityUpdateRollbackRestoredCurrentAppState(t, app, store)
}

func buildLegacySecurityUpdatePayload() string {
	payload, _ := json.Marshal(map[string]any{
		"state": map[string]any{
			"connections": []map[string]any{
				{
					"id":   "legacy-1",
					"name": "Legacy",
					"config": map[string]any{
						"id":       "legacy-1",
						"type":     "postgres",
						"host":     "db.local",
						"port":     5432,
						"user":     "postgres",
						"password": "postgres-secret",
					},
				},
			},
			"globalProxy": map[string]any{
				"enabled":  true,
				"type":     "http",
				"host":     "127.0.0.1",
				"port":     8080,
				"user":     "ops",
				"password": "proxy-secret",
			},
		},
	})
	return string(payload)
}

func writeLegacyAIProviderConfig(t *testing.T, configDir string, payload map[string]any) {
	t.Helper()

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "ai_config.json"), data, 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
}

func swapSecurityUpdateWriteJSONFile(next func(path string, payload any) error) func() {
	original := securityUpdateWriteJSONFile
	securityUpdateWriteJSONFile = next
	return func() {
		securityUpdateWriteJSONFile = original
	}
}

func assertSecurityUpdateRollbackRestoredCurrentAppState(t *testing.T, app *App, store *fakeAppSecretStore) {
	t.Helper()

	savedConnections, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(savedConnections) != 0 {
		t.Fatalf("expected rollback to leave no imported connections, got %#v", savedConnections)
	}

	if _, err := app.loadStoredGlobalProxyView(); !os.IsNotExist(err) {
		t.Fatalf("expected rollback to remove imported global proxy, got err=%v", err)
	}

	inspection, err := aiservice.NewProviderConfigStore(app.configDir, app.secretStore).Inspect()
	if err != nil {
		t.Fatalf("Inspect returned error: %v", err)
	}
	if len(inspection.ProvidersNeedingMigration) != 1 || inspection.ProvidersNeedingMigration[0] != "openai-main" {
		t.Fatalf("expected AI provider migration requirement to be restored, got %#v", inspection.ProvidersNeedingMigration)
	}

	ref, err := secretstore.BuildRef("ai-provider", "openai-main")
	if err != nil {
		t.Fatalf("BuildRef returned error: %v", err)
	}
	if _, err := store.Get(ref); !os.IsNotExist(err) {
		t.Fatalf("expected rollback to remove migrated AI provider secret, got err=%v", err)
	}
}
