package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/shared/i18n"
)

func methodsDataRootFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("methods_data_root.go missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}

func methodsLogDirectoryFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("methods_log_directory.go missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}



func TestMethodsDataRootCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"app.data_root.backend.dialog.select_directory",
		"app.data_root.backend.error.create_target_failed",
		"app.data_root.backend.error.create_bootstrap_directory_failed",
		"app.data_root.backend.error.create_data_directory_failed",
		"app.data_root.backend.error.directory_empty",
		"app.data_root.backend.error.directory_unavailable",
		"app.data_root.backend.error.migrate_directory_failed",
		"app.data_root.backend.error.migrate_file_failed",
		"app.data_root.backend.error.open_directory_failed",
		"app.data_root.backend.error.open_directory_unsupported",
		"app.data_root.backend.error.read_source_failed",
		"app.data_root.backend.error.resolve_source_failed",
		"app.data_root.backend.error.resolve_target_failed",
		"app.data_root.backend.error.target_inside_source",
		"app.data_root.backend.error.read_source_root_failed",
		"app.data_root.backend.error.read_migrated_security_update_state_failed",
		"app.data_root.backend.error.write_migrated_security_update_state_failed",
		"app.data_root.backend.error.read_migrated_security_update_manifest_failed",
		"app.data_root.backend.error.parse_migrated_security_update_manifest_failed",
		"app.data_root.backend.error.write_migrated_security_update_manifest_failed",
		"app.data_root.backend.error.read_migrated_security_update_result_failed",
		"app.data_root.backend.error.parse_migrated_security_update_result_failed",
		"app.data_root.backend.error.write_migrated_security_update_result_failed",
		"app.data_root.backend.message.migrated_restart",
		"app.data_root.backend.message.opened",
		"app.data_root.backend.message.unchanged",
		"app.data_root.backend.message.updated_restart",
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing data-root key %q", language, key)
			}
		}
	}
}

func TestMethodsLogDirectoryCatalogKeysExistInAllLanguages(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"app.data_root.log_directory.backend.dialog.select_directory",
		"app.data_root.log_directory.backend.error.desktop_only",
		"app.data_root.log_directory.backend.error.directory_unavailable",
		"app.data_root.log_directory.backend.error.environment_managed",
		"app.data_root.log_directory.backend.error.open_directory_failed",
		"app.data_root.log_directory.backend.error.open_directory_unsupported",
		"app.data_root.log_directory.backend.error.save_failed",
		"app.data_root.log_directory.backend.message.opened",
		"app.data_root.log_directory.backend.message.unchanged",
		"app.data_root.log_directory.backend.message.updated_restart",
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing log-directory key %q", language, key)
			}
		}
	}
}

func TestApplyDataRootDirectoryUsesEnglishLocalizedMessageWhenUnchanged(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageEnUS))
	})

	defaultRoot := filepath.Join(homeDir, ".gonavi")
	result := app.ApplyDataRootDirectory(defaultRoot, false)
	if !result.Success {
		t.Fatalf("expected success for unchanged root, got %+v", result)
	}

	want := app.appText("app.data_root.backend.message.unchanged", nil)
	if result.Message != want {
		t.Fatalf("expected localized unchanged message %q, got %q", want, result.Message)
	}
	if strings.Contains(result.Message, "数据目录未发生变化") {
		t.Fatalf("expected no raw Chinese unchanged message, got %q", result.Message)
	}
}

func TestApplyDataRootDirectoryLocalizesCreateDirectoryFailure(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	blockingPath := filepath.Join(t.TempDir(), "blocked-root")
	if err := os.WriteFile(blockingPath, []byte("blocked"), 0o644); err != nil {
		t.Fatalf("write blocking path: %v", err)
	}
	detailErr := os.MkdirAll(blockingPath, 0o755)
	if detailErr == nil {
		t.Fatalf("expected MkdirAll(%q) to fail against an existing file", blockingPath)
	}

	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageEnUS))
	})

	result := app.ApplyDataRootDirectory(blockingPath, false)
	if result.Success {
		t.Fatalf("expected create-directory failure, got %+v", result)
	}

	want := app.appText("app.data_root.backend.error.create_data_directory_failed", map[string]any{
		"detail": detailErr.Error(),
	})
	if result.Message != want {
		t.Fatalf("expected localized create-directory message %q, got %q", want, result.Message)
	}
}

func TestMigrateDataRootContentsUsesEnglishLocalizedValidationMessage(t *testing.T) {
	setDefaultAppLanguage(i18n.LanguageEnUS)

	err := migrateDataRootContents("   ", filepath.Join(t.TempDir(), "target"))
	if err == nil {
		t.Fatal("expected migrateDataRootContents to fail for empty source root")
	}

	want := defaultAppText("app.data_root.backend.error.directory_empty", nil)
	if err.Error() != want {
		t.Fatalf("expected localized empty-directory message %q, got %q", want, err.Error())
	}
}

func TestRewriteSecurityUpdateBackupPathsUsesEnglishLocalizedManifestParseError(t *testing.T) {
	setDefaultAppLanguage(i18n.LanguageEnUS)

	targetRoot := t.TempDir()
	repo := newSecurityUpdateStateRepository(targetRoot)
	started, err := repo.StartRound(StartSecurityUpdateRequest{SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig})
	if err != nil {
		t.Fatalf("start security update round failed: %v", err)
	}
	if err := os.WriteFile(repo.manifestPath(started.MigrationID), []byte("{"), 0o644); err != nil {
		t.Fatalf("write invalid manifest: %v", err)
	}

	err = rewriteSecurityUpdateBackupPaths(targetRoot)
	if err == nil {
		t.Fatal("expected rewriteSecurityUpdateBackupPaths to fail for invalid manifest")
	}

	var manifest securityUpdateBackupManifest
	parseErr := json.Unmarshal([]byte("{"), &manifest)
	if parseErr == nil {
		t.Fatal("expected invalid manifest json to fail")
	}
	want := defaultAppText("app.data_root.backend.error.parse_migrated_security_update_manifest_failed", map[string]any{
		"detail": parseErr.Error(),
	})
	if err.Error() != want {
		t.Fatalf("expected localized manifest-parse message %q, got %q", want, err.Error())
	}
}

func TestApplyDataRootDirectoryLocalizesBootstrapDirectoryFailure(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	defaultRoot := appdata.DefaultRoot()
	if err := os.WriteFile(defaultRoot, []byte("blocked"), 0o644); err != nil {
		t.Fatalf("write blocking default root: %v", err)
	}

	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageEnUS))
	})

	targetRoot := filepath.Join(t.TempDir(), "custom-root")
	result := app.ApplyDataRootDirectory(targetRoot, false)
	if result.Success {
		t.Fatalf("expected bootstrap-directory failure, got %+v", result)
	}

	detailErr := os.MkdirAll(defaultRoot, 0o755)
	if detailErr == nil {
		t.Fatalf("expected MkdirAll(%q) to fail against an existing file", defaultRoot)
	}
	want := app.appText("app.data_root.backend.error.create_bootstrap_directory_failed", map[string]any{
		"detail": detailErr.Error(),
	})
	if result.Message != want {
		t.Fatalf("expected localized bootstrap-directory message %q, got %q", want, result.Message)
	}
}
