package app

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/shared/i18n"
)

func methodsDriverFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("methods driver source missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}

type timeoutDriverNetworkError struct{}

func (timeoutDriverNetworkError) Error() string   { return "dial timeout" }
func (timeoutDriverNetworkError) Timeout() bool   { return true }
func (timeoutDriverNetworkError) Temporary() bool { return true }

var _ net.Error = timeoutDriverNetworkError{}

func TestMethodsDriverNetworkBackendMessagesUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	checks := map[string]struct {
		rawMessages []string
		keys        []string
	}{
		"func probeDriverNetworkEndpoint": {
			rawMessages: []string{`probed.Error = "检测地址为空"`},
			keys:        []string{"driver_manager.backend.network.error.probe_url_empty"},
		},
		"func resolveDriverProbeDialAddress": {
			rawMessages: []string{
				`fmt.Errorf("检测地址为空")`,
				`fmt.Errorf("检测地址缺少主机")`,
			},
			keys: []string{
				"driver_manager.backend.network.error.probe_url_empty",
				"driver_manager.backend.network.error.probe_host_missing",
			},
		},
		"func normalizeDriverNetworkError": {
			rawMessages: []string{`return "网络连接超时"`},
			keys:        []string{"driver_manager.backend.network.error.timeout"},
		},
		"func driverLogHint": {
			rawMessages: []string{`fmt.Sprintf("（详细日志：%s）", path)`},
			keys:        []string{"driver_manager.backend.message.log_hint"},
		},
		"func logDriverOperationError": {
			rawMessages: []string{`message = "未知错误"`},
			keys:        []string{"driver_manager.backend.error.unknown"},
		},
	}

	for signature, check := range checks {
		functionSource := methodsDriverFunctionSource(t, source, signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw driver network text %q", signature, rawMessage)
			}
		}
		for _, key := range check.keys {
			if !strings.Contains(functionSource, key) {
				t.Fatalf("%s does not reference driver network i18n key %q", signature, key)
			}
		}
	}
}

func TestMethodsDriverNetworkBackendCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"driver_manager.backend.network.error.probe_url_empty",
		"driver_manager.backend.network.error.probe_host_missing",
		"driver_manager.backend.network.error.timeout",
		"driver_manager.backend.message.log_hint",
		"driver_manager.backend.error.unknown",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing driver network key %q", language, key)
			}
		}
	}
}

func TestMethodsDriverReleaseHelpersUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	checks := map[string]struct {
		rawMessages []string
		keys        []string
	}{
		"func loadReleaseAssetSizesCached": {
			rawMessages: []string{`fmt.Errorf("缓存 key 为空")`},
			keys:        []string{"driver_manager.backend.error.cache_key_empty"},
		},
		"func fetchDriverReleaseList": {
			rawMessages: []string{
				`fmt.Errorf("拉取驱动版本列表失败：HTTP %d", resp.StatusCode)`,
				`fmt.Errorf("解析驱动版本列表失败：%w", err)`,
			},
			keys: []string{
				"driver_manager.backend.error.driver_version_list_fetch_failed",
				"driver_manager.backend.error.driver_version_list_parse_failed",
			},
		},
		"func fetchDriverBundleAssetIndex": {
			rawMessages: []string{
				`fmt.Errorf("release 为空")`,
				`fmt.Errorf("未找到驱动总包索引资产")`,
			},
			keys: []string{
				"driver_manager.backend.error.release_empty",
				"driver_manager.backend.error.bundle_index_asset_missing",
			},
		},
		"func fetchDriverBundleAssetIndexCandidate": {
			rawMessages: []string{
				`fmt.Errorf("拉取驱动总包索引失败：HTTP %d")`,
				`fmt.Errorf("解析驱动总包索引失败：%w")`,
				`fmt.Errorf("驱动总包索引为空")`,
			},
			keys: []string{
				"driver_manager.backend.error.bundle_index_fetch_failed",
				"driver_manager.backend.error.bundle_index_parse_failed",
				"driver_manager.backend.error.bundle_index_empty",
			},
		},
		"func fetchReleaseByTag": {
			rawMessages: []string{`fmt.Errorf("Tag 为空")`},
			keys:        []string{"driver_manager.backend.error.tag_empty"},
		},
		"func fetchDriverReleaseByURL": {
			rawMessages: []string{
				`fmt.Errorf("API 地址为空")`,
				`fmt.Errorf("拉取 Release 信息失败：HTTP %d")`,
			},
			keys: []string{
				"driver_manager.backend.error.api_url_empty",
				"driver_manager.backend.error.release_info_fetch_failed",
			},
		},
	}

	for signature, check := range checks {
		functionSource := methodsDriverFunctionSource(t, source, signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw release helper text %q", signature, rawMessage)
			}
		}
		for _, key := range check.keys {
			if !strings.Contains(functionSource, key) {
				t.Fatalf("%s does not reference release helper i18n key %q", signature, key)
			}
		}
	}
}

func TestMethodsDriverInstallActionDetailsUseEnglishInternalWrappers(t *testing.T) {
	source := methodsDriverSource(t)

	checks := map[string]struct {
		rawMessages     []string
		internalDetails []string
	}{
		"func (a *App) InstallLocalDriverPackage": {
			rawMessages: []string{
				`"导入本地驱动包失败，driver=%s file=%s"`,
				`"写入本地驱动元数据失败，driver=%s"`,
			},
			internalDetails: []string{
				`"failed to import local driver package, driver=%s file=%s"`,
				`"failed to write local driver metadata, driver=%s"`,
			},
		},
		"func (a *App) installOptionalGoDriverPackage": {
			rawMessages: []string{
				`"驱动下载安装失败，driver=%s version=%s url=%s"`,
			},
			internalDetails: []string{
				`"failed to download and install driver, driver=%s version=%s url=%s"`,
			},
		},
		"func (a *App) driverMetadataWriteFailure": {
			rawMessages: []string{
				`"写入驱动元数据失败，driver=%s version=%s"`,
			},
			internalDetails: []string{
				`"failed to write driver metadata, driver=%s version=%s"`,
			},
		},
		"func (a *App) RemoveDriverPackage": {
			rawMessages: []string{
				`"移除驱动包失败，driver=%s path=%s"`,
			},
			internalDetails: []string{
				`"failed to remove driver package, driver=%s path=%s"`,
			},
		},
	}

	for signature, check := range checks {
		functionSource := methodsDriverFunctionSource(t, source, signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw install action detail wrapper %q", signature, rawMessage)
			}
		}
		for _, internalDetail := range check.internalDetails {
			if !strings.Contains(functionSource, internalDetail) {
				t.Fatalf("%s does not contain English internal detail wrapper %q", signature, internalDetail)
			}
		}
	}
}

func TestMethodsDriverReleaseHelperCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"driver_manager.backend.error.cache_key_empty",
		"driver_manager.backend.error.driver_version_list_fetch_failed",
		"driver_manager.backend.error.driver_version_list_parse_failed",
		"driver_manager.backend.error.release_empty",
		"driver_manager.backend.error.bundle_index_asset_missing",
		"driver_manager.backend.error.bundle_index_fetch_failed",
		"driver_manager.backend.error.bundle_index_parse_failed",
		"driver_manager.backend.error.bundle_index_empty",
		"driver_manager.backend.error.tag_empty",
		"driver_manager.backend.error.api_url_empty",
		"driver_manager.backend.error.release_info_fetch_failed",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing release helper key %q", language, key)
			}
		}
	}
}

func TestResolveDriverDownloadDirectoryUsesCurrentLanguageForCreateDirectoryFailure(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	blocker := filepath.Join(t.TempDir(), "driver-root-blocker")
	if err := os.WriteFile(blocker, []byte("blocker"), 0o644); err != nil {
		t.Fatalf("write blocker file: %v", err)
	}

	result := app.ResolveDriverDownloadDirectory(filepath.Join(blocker, "nested"))
	if result.Success {
		t.Fatalf("expected resolve driver directory failure, got %+v", result)
	}
	if !strings.Contains(result.Message, "Failed to create driver directory:") {
		t.Fatalf("expected English create-directory wrapper, got %q", result.Message)
	}
	if strings.Contains(result.Message, "\u521b\u5efa\u9a71\u52a8\u76ee\u5f55\u5931\u8d25") {
		t.Fatalf("expected no Chinese create-directory wrapper in en-US mode, got %q", result.Message)
	}
}

func TestProbeDriverNetworkEndpointUsesCurrentLanguageForEmptyURL(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))

	probed := probeDriverNetworkEndpoint(nil, driverNetworkProbeItem{URL: "   "})
	if probed.Error != "Probe URL is empty" {
		t.Fatalf("expected English probe URL message, got %q", probed.Error)
	}
	if strings.Contains(probed.Error, "检测地址为空") {
		t.Fatalf("expected no Chinese probe URL message in en-US mode, got %q", probed.Error)
	}
}

func TestResolveDriverProbeDialAddressUsesCurrentLanguageForMissingHost(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))

	_, err := resolveDriverProbeDialAddress("https:///driver")
	if err == nil {
		t.Fatal("expected probe host validation error")
	}
	if err.Error() != "Probe URL is missing a host" {
		t.Fatalf("expected English probe host message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "检测地址缺少主机") {
		t.Fatalf("expected no Chinese probe host message in en-US mode, got %q", err.Error())
	}
}

func TestNormalizeDriverNetworkErrorUsesCurrentLanguageForTimeout(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))

	text := normalizeDriverNetworkError(timeoutDriverNetworkError{})
	if text != "Network connection timed out" {
		t.Fatalf("expected English network timeout message, got %q", text)
	}
	if strings.Contains(text, "网络连接超时") {
		t.Fatalf("expected no Chinese timeout message in en-US mode, got %q", text)
	}
}

func TestDriverOperationLegacyHelpersUseCurrentLanguageForUnknownAndLogHint(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))

	if strings.TrimSpace(logger.Path()) == "" {
		t.Skip("logger path unavailable")
	}

	hint := driverLogHint()
	if !strings.Contains(hint, "detail log:") {
		t.Fatalf("expected English driver log hint, got %q", hint)
	}
	if strings.Contains(hint, "详细日志") {
		t.Fatalf("expected no Chinese driver log hint in en-US mode, got %q", hint)
	}

	text := logDriverOperationError(errors.New(""), "test driver error")
	if !strings.Contains(text, "Unknown error") {
		t.Fatalf("expected English unknown driver error fallback, got %q", text)
	}
	if !strings.Contains(text, "detail log:") {
		t.Fatalf("expected English detail log hint in legacy driver error text, got %q", text)
	}
	if strings.Contains(text, "未知错误") || strings.Contains(text, "详细日志") {
		t.Fatalf("expected no Chinese legacy driver error text in en-US mode, got %q", text)
	}
}
