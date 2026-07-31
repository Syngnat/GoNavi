package app

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/nacos"
)

type nacosTransferTestClient struct {
	nacos.Client
	getConfig func(context.Context, string, string, string) (*nacos.ConfigDetail, error)
	publish   func(context.Context, nacos.PublishRequest) error
	closed    atomic.Int32
}

func (client *nacosTransferTestClient) Connect(connection.ConnectionConfig) error {
	return nil
}

func (client *nacosTransferTestClient) Close() error {
	client.closed.Add(1)
	return nil
}

func (client *nacosTransferTestClient) GetConfig(
	ctx context.Context,
	namespaceID, group, dataID string,
) (*nacos.ConfigDetail, error) {
	if client.getConfig != nil {
		return client.getConfig(ctx, namespaceID, group, dataID)
	}
	return nil, errors.New("Config not found: test fixture")
}

func (client *nacosTransferTestClient) PublishConfig(ctx context.Context, request nacos.PublishRequest) error {
	if client.publish != nil {
		return client.publish(ctx, request)
	}
	return nil
}

func TestNacosImportConfigsRejectsEmptyEffectiveSelection(t *testing.T) {
	tests := []struct {
		name  string
		items []NacosConfigIdentity
	}{
		{name: "empty", items: nil},
		{
			name: "all invalid",
			items: []NacosConfigIdentity{
				{DataID: "   ", Group: "DEFAULT_GROUP"},
				{DataID: "", Group: "DEV_GROUP"},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			installNacosCacheTestHooks(t)
			var published atomic.Int32
			client := &nacosTransferTestClient{
				publish: func(context.Context, nacos.PublishRequest) error {
					published.Add(1)
					return nil
				},
			}
			newNacosClientFunc = func() nacos.Client { return client }

			transfer := nacos.NewTransferFile("dev", "Development")
			transfer.Configs = []nacos.TransferConfigEntry{{
				DataID:  "application.yaml",
				Group:   "DEFAULT_GROUP",
				Content: "enabled: true",
			}}
			filename := filepath.Join(t.TempDir(), "selected-import.json")
			if err := nacos.WriteTransferFile(filename, transfer); err != nil {
				t.Fatalf("WriteTransferFile: %v", err)
			}

			result := (&App{}).NacosImportConfigs(connection.ConnectionConfig{
				Type:    "nacos",
				Host:    "nacos.example.test",
				Port:    8848,
				Timeout: 1,
			}, NacosImportConfigsOptions{
				NamespaceID:  "dev",
				ConflictMode: "overwrite",
				File:         filename,
				Scope:        "selected",
				Items:        test.items,
			})
			if result.Success {
				t.Fatalf("selected import unexpectedly succeeded: %#v", result)
			}
			if got := published.Load(); got != 0 {
				t.Fatalf("selected import published %d config(s), want 0", got)
			}
		})
	}
}

func TestNacosImportConfigsMatchesSelectedIdentityWithoutDelimiterCollisions(t *testing.T) {
	installNacosCacheTestHooks(t)

	var published []nacos.PublishRequest
	client := &nacosTransferTestClient{
		publish: func(_ context.Context, request nacos.PublishRequest) error {
			published = append(published, request)
			return nil
		},
	}
	newNacosClientFunc = func() nacos.Client { return client }

	transfer := nacos.NewTransferFile("dev", "Development")
	transfer.Configs = []nacos.TransferConfigEntry{
		{Group: "A", DataID: "B@@C", Content: "first"},
		{Group: "A@@B", DataID: "C", Content: "second"},
	}
	filename := filepath.Join(t.TempDir(), "delimiter-selection.json")
	if err := nacos.WriteTransferFile(filename, transfer); err != nil {
		t.Fatalf("WriteTransferFile: %v", err)
	}
	selectedIndex := 1

	result := (&App{}).NacosImportConfigs(connection.ConnectionConfig{
		Type: "nacos",
		Host: "nacos.example.test",
		Port: 8848,
	}, NacosImportConfigsOptions{
		NamespaceID:  "dev",
		ConflictMode: "overwrite",
		File:         filename,
		Scope:        "selected",
		Items: []NacosConfigIdentity{{
			Index:  &selectedIndex,
			Group:  "A@@B",
			DataID: "C",
		}},
	})
	if !result.Success {
		t.Fatalf("selected import failed: %#v", result)
	}
	if len(published) != 1 {
		t.Fatalf("published %d configs, want exactly 1", len(published))
	}
	if published[0].Group != "A@@B" || published[0].DataID != "C" || published[0].Content != "second" {
		t.Fatalf("published %#v, want the second preview row", published[0])
	}
}

func TestNacosImportConfigsRejectsSelectedItemsThatDoNotMatchTheFile(t *testing.T) {
	installNacosCacheTestHooks(t)

	var published atomic.Int32
	client := &nacosTransferTestClient{
		publish: func(context.Context, nacos.PublishRequest) error {
			published.Add(1)
			return nil
		},
	}
	newNacosClientFunc = func() nacos.Client { return client }

	transfer := nacos.NewTransferFile("dev", "Development")
	transfer.Configs = []nacos.TransferConfigEntry{{
		Group: "DEFAULT_GROUP", DataID: "application.yaml", Content: "enabled: true",
	}}
	filename := filepath.Join(t.TempDir(), "selection-mismatch.json")
	if err := nacos.WriteTransferFile(filename, transfer); err != nil {
		t.Fatalf("WriteTransferFile: %v", err)
	}

	result := (&App{}).NacosImportConfigs(connection.ConnectionConfig{
		Type: "nacos",
		Host: "nacos.example.test",
		Port: 8848,
	}, NacosImportConfigsOptions{
		NamespaceID: "dev",
		File:        filename,
		Scope:       "selected",
		Items: []NacosConfigIdentity{{
			Group: "DEFAULT_GROUP", DataID: "missing.yaml",
		}},
	})
	if result.Success {
		t.Fatalf("mismatched selected import unexpectedly succeeded: %#v", result)
	}
	if got := published.Load(); got != 0 {
		t.Fatalf("mismatched selected import published %d config(s)", got)
	}
}

func TestNacosImportConfigsReportsPartialFailures(t *testing.T) {
	installNacosCacheTestHooks(t)

	client := &nacosTransferTestClient{
		publish: func(_ context.Context, request nacos.PublishRequest) error {
			if request.DataID == "failed.yaml" {
				return errors.New("publish denied")
			}
			return nil
		},
	}
	newNacosClientFunc = func() nacos.Client { return client }

	transfer := nacos.NewTransferFile("dev", "Development")
	transfer.Configs = []nacos.TransferConfigEntry{
		{Group: "DEFAULT_GROUP", DataID: "ok.yaml", Content: "ok"},
		{Group: "DEFAULT_GROUP", DataID: "failed.yaml", Content: "failed"},
	}
	filename := filepath.Join(t.TempDir(), "partial-failure.json")
	if err := nacos.WriteTransferFile(filename, transfer); err != nil {
		t.Fatalf("WriteTransferFile: %v", err)
	}

	result := (&App{}).NacosImportConfigs(connection.ConnectionConfig{
		Type: "nacos",
		Host: "nacos.example.test",
		Port: 8848,
	}, NacosImportConfigsOptions{
		NamespaceID:  "dev",
		ConflictMode: "overwrite",
		File:         filename,
		Scope:        "all",
	})
	if result.Success {
		t.Fatalf("partial import unexpectedly reported success: %#v", result)
	}
	counts, ok := result.Data.(map[string]any)
	if !ok {
		t.Fatalf("partial import data = %#v, want count map", result.Data)
	}
	if counts["imported"] != 1 || counts["failed"] != 1 {
		t.Fatalf("partial import counts = %#v, want imported=1 failed=1", counts)
	}
}

func TestBuildNacosImportPreviewFailsWhenExistenceCheckIsForbidden(t *testing.T) {
	messages := []string{
		"Nacos HTTP error 403: permission denied; config not found",
		"Nacos HTTP 错误 403：权限不足；配置不存在",
		"Nacos HTTP 錯誤 403：權限不足；設定不存在",
		"Nacos HTTP エラー 403: 権限がありません; 設定が見つかりません",
		"Nacos-HTTP-Fehler 403: Keine Berechtigung; Konfiguration nicht gefunden",
		"Ошибка HTTP Nacos 403: нет разрешения; Конфигурация не найдена",
	}
	for _, forbiddenMessage := range messages {
		t.Run(forbiddenMessage, func(t *testing.T) {
			client := &nacosTransferTestClient{
				getConfig: func(context.Context, string, string, string) (*nacos.ConfigDetail, error) {
					return nil, errors.New(forbiddenMessage)
				},
			}
			payload := nacos.NewTransferFile("source", "Source")
			payload.Configs = []nacos.TransferConfigEntry{{
				DataID: "application.yaml",
				Group:  "DEFAULT_GROUP",
			}}

			_, err := buildNacosImportPreview(context.Background(), client, "import.json", "target", payload)
			if err == nil {
				t.Fatal("preview unexpectedly treated forbidden existence check as missing config")
			}
			if !strings.Contains(err.Error(), "403") {
				t.Fatalf("preview error = %v, want forbidden existence check error", err)
			}
		})
	}
}

func TestBuildNacosImportPreviewFailsOnNonNotFoundErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{name: "timeout", err: context.DeadlineExceeded},
		{name: "unrelated number", err: errors.New("upstream port 4040 is unavailable")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := &nacosTransferTestClient{
				getConfig: func(context.Context, string, string, string) (*nacos.ConfigDetail, error) {
					return nil, test.err
				},
			}
			payload := nacos.NewTransferFile("source", "Source")
			payload.Configs = []nacos.TransferConfigEntry{{
				DataID: "application.yaml",
				Group:  "DEFAULT_GROUP",
			}}

			_, err := buildNacosImportPreview(context.Background(), client, "import.json", "target", payload)
			if err == nil {
				t.Fatalf("preview unexpectedly treated %v as missing config", test.err)
			}
			if !errors.Is(err, test.err) && err.Error() != test.err.Error() {
				t.Fatalf("preview error = %v, want %v", err, test.err)
			}
		})
	}
}

func TestBuildNacosImportPreviewTreatsExplicitHTTP404AsMissing(t *testing.T) {
	client := &nacosTransferTestClient{
		getConfig: func(context.Context, string, string, string) (*nacos.ConfigDetail, error) {
			return nil, errors.New("Nacos HTTP error 404: config is absent")
		},
	}
	payload := nacos.NewTransferFile("source", "Source")
	payload.Configs = []nacos.TransferConfigEntry{{
		DataID: "application.yaml",
		Group:  "DEFAULT_GROUP",
	}}

	preview, err := buildNacosImportPreview(context.Background(), client, "import.json", "target", payload)
	if err != nil {
		t.Fatalf("preview rejected an explicit HTTP 404: %v", err)
	}
	if preview.ExistsCount != 0 || preview.NewCount != 1 || len(preview.Items) != 1 ||
		preview.Items[0].Exists || preview.Items[0].Index != 0 {
		t.Fatalf("preview = %#v, want one missing config", preview)
	}
}

func TestBuildNacosImportPreviewTreatsLocalizedConfigNotFoundAsMissing(t *testing.T) {
	messages := []string{
		"Config not found: DEFAULT_GROUP / application.yaml",
		"配置不存在：DEFAULT_GROUP / application.yaml",
		"設定不存在：DEFAULT_GROUP / application.yaml",
		"設定が見つかりません: DEFAULT_GROUP / application.yaml",
		"Konfiguration nicht gefunden: DEFAULT_GROUP / application.yaml",
		"Конфигурация не найдена: DEFAULT_GROUP / application.yaml",
	}
	for _, message := range messages {
		t.Run(message, func(t *testing.T) {
			client := &nacosTransferTestClient{
				getConfig: func(context.Context, string, string, string) (*nacos.ConfigDetail, error) {
					return nil, errors.New(message)
				},
			}
			payload := nacos.NewTransferFile("source", "Source")
			payload.Configs = []nacos.TransferConfigEntry{{
				DataID: "application.yaml",
				Group:  "DEFAULT_GROUP",
			}}

			preview, err := buildNacosImportPreview(context.Background(), client, "import.json", "target", payload)
			if err != nil {
				t.Fatalf("preview rejected localized config-not-found error: %v", err)
			}
			if preview.NewCount != 1 || preview.ExistsCount != 0 {
				t.Fatalf("preview = %#v, want one missing config", preview)
			}
		})
	}
}

func TestEnsureNacosDataImportAllowedHonorsExplicitProtection(t *testing.T) {
	app := &App{}
	base := connection.ConnectionConfig{Type: "nacos"}

	if err := app.ensureNacosDataImportAllowed(base); err != nil {
		t.Fatalf("unrestricted import was rejected: %v", err)
	}

	importRestricted := base
	importRestricted.Protection.RestrictDataImport = true
	if err := app.ensureNacosDataImportAllowed(importRestricted); err == nil {
		t.Fatal("restrictDataImport should reject Nacos config import")
	}

	dataEditRestricted := base
	dataEditRestricted.Protection.RestrictDataEdit = true
	if err := app.ensureNacosDataImportAllowed(dataEditRestricted); err != nil {
		t.Fatalf("restrictDataEdit should not reject independently protected Nacos config import: %v", err)
	}

	readOnly := base
	readOnly.ReadOnly = true
	if err := app.ensureNacosDataImportAllowed(readOnly); err == nil {
		t.Fatal("readOnly should reject Nacos config import")
	}
}

func TestEnsureNacosStructureEditAllowedHonorsOwnProtection(t *testing.T) {
	app := &App{}
	base := connection.ConnectionConfig{Type: "nacos"}

	if err := app.ensureNacosStructureEditAllowed(base); err != nil {
		t.Fatalf("unrestricted structure edit was rejected: %v", err)
	}

	structureRestricted := base
	structureRestricted.Protection.RestrictStructureEdit = true
	if err := app.ensureNacosStructureEditAllowed(structureRestricted); err == nil {
		t.Fatal("restrictStructureEdit should reject Nacos structure edits")
	}

	dataEditRestricted := base
	dataEditRestricted.Protection.RestrictDataEdit = true
	if err := app.ensureNacosStructureEditAllowed(dataEditRestricted); err != nil {
		t.Fatalf("restrictDataEdit should not reject independently protected Nacos structure edits: %v", err)
	}

	importRestricted := base
	importRestricted.Protection.RestrictDataImport = true
	if err := app.ensureNacosStructureEditAllowed(importRestricted); err != nil {
		t.Fatalf("restrictDataImport should not reject independently protected Nacos structure edits: %v", err)
	}

	readOnly := base
	readOnly.ReadOnly = true
	if err := app.ensureNacosStructureEditAllowed(readOnly); err == nil {
		t.Fatal("readOnly should reject Nacos structure edits")
	}
}
