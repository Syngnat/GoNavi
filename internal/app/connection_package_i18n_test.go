package app

import (
	"errors"
	"strings"
	"testing"
	"GoNavi-Wails/shared/i18n"
)

func connectionPackageFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("source missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}


func TestImportConnectionsPayloadLocalizesPasswordRequiredErrorInGerman(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageDeDE))

	raw := `{
  "schemaVersion": 1,
  "kind": "gonavi_connection_package",
  "cipher": "AES-256-GCM",
  "kdf": {
    "name": "Argon2id",
    "memoryKiB": 65536,
    "timeCost": 3,
    "parallelism": 4,
    "salt": "salt"
  },
  "nonce": "nonce",
  "payload": "payload"
}`

	_, err := app.ImportConnectionsPayload(raw, "")
	if !errors.Is(err, errConnectionPackagePasswordRequired) {
		t.Fatalf("expected errConnectionPackagePasswordRequired, got %v", err)
	}

	want := app.appText("file.backend.error.connection_package_password_required", nil)
	if err == nil || err.Error() != want {
		t.Fatalf("expected German password-required message %q, got %q", want, errorMessage(err))
	}
	if strings.Contains(err.Error(), "恢复包密码不能为空") {
		t.Fatalf("expected no legacy Chinese password-required text in de-DE mode, got %q", err.Error())
	}
}

func TestImportConnectionsPayloadLocalizesOversizedImportErrorInGerman(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageDeDE))

	_, err := app.ImportConnectionsPayload(strings.Repeat("A", connectionImportMaxFileBytes+1), "")
	if !errors.Is(err, errConnectionImportFileTooLarge) {
		t.Fatalf("expected errConnectionImportFileTooLarge, got %v", err)
	}

	want := app.appText("file.backend.error.connection_import_file_too_large", nil)
	if err == nil || err.Error() != want {
		t.Fatalf("expected German oversized-import message %q, got %q", want, errorMessage(err))
	}
	if strings.Contains(err.Error(), "连接导入文件过大") {
		t.Fatalf("expected no legacy Chinese oversized-import text in de-DE mode, got %q", err.Error())
	}
}

func TestImportConnectionsPayloadLocalizesMySQLWorkbenchParseFailureInGerman(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageDeDE))

	raw := `<data grt_format="4.0"><value struct-name="db.mgmt.Connection"></data>`
	_, parseErr := parseMySQLWorkbenchXML(raw)
	if parseErr == nil {
		t.Fatal("expected invalid MySQL Workbench XML to fail parsing")
	}

	_, err := app.ImportConnectionsPayload(raw, "")
	want := app.appText("file.backend.error.mysql_workbench_parse_failed", map[string]any{"detail": parseErr.Error()})
	if err == nil || err.Error() != want {
		t.Fatalf("expected German MySQL Workbench parse error %q, got %q", want, errorMessage(err))
	}
	if strings.Contains(err.Error(), "解析 MySQL Workbench XML 失败") {
		t.Fatalf("expected no legacy Chinese MySQL Workbench parse text in de-DE mode, got %q", err.Error())
	}
}

func TestImportConnectionsPayloadLocalizesMySQLWorkbenchNoConnectionsErrorInGerman(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageDeDE))

	raw := `<data grt_format="4.0"><value struct-name="db.mgmt.Connection"></value></data>`

	_, err := app.ImportConnectionsPayload(raw, "")
	want := app.appText("file.backend.error.mysql_workbench_no_connections", nil)
	if err == nil || err.Error() != want {
		t.Fatalf("expected German MySQL Workbench no-connections error %q, got %q", want, errorMessage(err))
	}
	if strings.Contains(err.Error(), "未在 XML 中找到有效的连接配置") {
		t.Fatalf("expected no legacy Chinese MySQL Workbench no-connections text in de-DE mode, got %q", err.Error())
	}
}

