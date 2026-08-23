package app

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/db"
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
		"func (a *App) DownloadDriverPackage": {
			rawMessages: []string{
				`"驱动下载安装失败，driver=%s version=%s url=%s"`,
				`"写入驱动元数据失败，driver=%s version=%s"`,
			},
			internalDetails: []string{
				`"failed to download and install driver, driver=%s version=%s url=%s"`,
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

func TestLoadReleaseAssetSizesCachedUsesCurrentLanguageForEmptyCacheKey(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))

	_, _, err := loadReleaseAssetSizesCached("   ", func() (*githubRelease, error) {
		t.Fatal("fetch should not be called for empty cache key")
		return nil, nil
	})
	if err == nil {
		t.Fatal("expected empty cache key error")
	}
	if err.Error() != "Cache key is empty" {
		t.Fatalf("expected English cache key message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "缓存 key 为空") {
		t.Fatalf("expected no Chinese cache key message in en-US mode, got %q", err.Error())
	}
}

func TestFetchDriverBundleAssetSizeIndexUsesCurrentLanguageForStructuredErrors(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	disableGlobalProxyForTest(t)

	makeRelease := func(downloadURL string) *githubRelease {
		return &githubRelease{
			Assets: []githubAsset{{
				Name:               optionalDriverBundleIndexAssetName,
				BrowserDownloadURL: downloadURL,
			}},
		}
	}

	server500 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer server500.Close()

	serverInvalidJSON := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("{invalid"))
	}))
	defer serverInvalidJSON.Close()

	serverEmptyIndex := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"assets":{}}`))
	}))
	defer serverEmptyIndex.Close()

	cases := []struct {
		name    string
		release *githubRelease
		want    string
		avoid   string
	}{
		{
			name:    "nil release",
			release: nil,
			want:    "Release is empty",
			avoid:   "release 为空",
		},
		{
			name:    "missing bundle index asset",
			release: &githubRelease{},
			want:    "Driver bundle index asset was not found",
			avoid:   "未找到驱动总包索引资产",
		},
		{
			name:    "http status failure",
			release: makeRelease(server500.URL),
			want:    "Failed to fetch driver bundle index: HTTP 500",
			avoid:   "拉取驱动总包索引失败",
		},
		{
			name:    "parse failure",
			release: makeRelease(serverInvalidJSON.URL),
			want:    "Failed to parse driver bundle index:",
			avoid:   "解析驱动总包索引失败",
		},
		{
			name:    "empty index",
			release: makeRelease(serverEmptyIndex.URL),
			want:    "Driver bundle index is empty",
			avoid:   "驱动总包索引为空",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := fetchDriverBundleAssetSizeIndex(tc.release)
			if err == nil {
				t.Fatal("expected structured release index error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q in English release index error, got %q", tc.want, err.Error())
			}
			if strings.Contains(err.Error(), tc.avoid) {
				t.Fatalf("expected no Chinese release index error in en-US mode, got %q", err.Error())
			}
		})
	}
}

func TestFetchReleaseByTagUsesCurrentLanguageForEmptyTag(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))

	_, err := fetchReleaseByTag("   ")
	if err == nil {
		t.Fatal("expected empty tag error")
	}
	if err.Error() != "Tag is empty" {
		t.Fatalf("expected English empty tag message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "Tag 为空") {
		t.Fatalf("expected no Chinese empty tag message in en-US mode, got %q", err.Error())
	}
}

func TestFetchDriverReleaseByURLUsesCurrentLanguageForStructuredErrors(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	disableGlobalProxyForTest(t)

	_, err := fetchDriverReleaseByURL("   ")
	if err == nil {
		t.Fatal("expected empty API URL error")
	}
	if err.Error() != "API URL is empty" {
		t.Fatalf("expected English API URL message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "API 地址为空") {
		t.Fatalf("expected no Chinese API URL message in en-US mode, got %q", err.Error())
	}

	server500 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer server500.Close()

	_, err = fetchDriverReleaseByURL(server500.URL)
	if err == nil {
		t.Fatal("expected Release information fetch failure")
	}
	want := fmt.Sprintf("Failed to fetch Release information: HTTP %d", http.StatusInternalServerError)
	if err.Error() != want {
		t.Fatalf("expected English Release information fetch message %q, got %q", want, err.Error())
	}
	if strings.Contains(err.Error(), "拉取 Release 信息失败") {
		t.Fatalf("expected no Chinese Release information fetch message in en-US mode, got %q", err.Error())
	}
}

func TestMethodsDriverVersionOptionErrorsUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	functionSource := methodsDriverFunctionSource(t, source, "func resolveDriverVersionOptions")
	for _, rawMessage := range []string{
		`fmt.Errorf("驱动类型为空")`,
		`fmt.Errorf("未找到可用驱动版本")`,
	} {
		if strings.Contains(functionSource, rawMessage) {
			t.Fatalf("resolveDriverVersionOptions still contains raw version option text %q", rawMessage)
		}
	}
	for _, key := range []string{
		"driver_manager.backend.error.driver_type_empty",
		"driver_manager.backend.error.no_driver_versions",
	} {
		if !strings.Contains(functionSource, key) {
			t.Fatalf("resolveDriverVersionOptions does not reference version option i18n key %q", key)
		}
	}
}

func TestMethodsDriverVersionOptionErrorCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"driver_manager.backend.error.driver_type_empty",
		"driver_manager.backend.error.no_driver_versions",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing version option error key %q", language, key)
			}
		}
	}
}

func TestResolveDriverVersionOptionsUsesCurrentLanguageForStructuredErrors(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	_, err := resolveDriverVersionOptions(driverDefinition{}, "", app.appText)
	if err == nil {
		t.Fatal("expected empty driver type error")
	}
	if err.Error() != "Driver type is empty" {
		t.Fatalf("expected English driver type message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "驱动类型为空") {
		t.Fatalf("expected no Chinese driver type message in en-US mode, got %q", err.Error())
	}

	originalModulePath, hadModulePath := driverGoModulePathMap["mongodb"]
	originalAliasPaths, hadAliasPaths := driverGoModuleAliasPathMap["mongodb"]
	originalFallbackVersions, hadFallbackVersions := fallbackRecentDriverVersionsMap["mongodb"]
	originalLatestVersion, hadLatestVersion := latestDriverVersionMap["mongodb"]
	delete(driverGoModulePathMap, "mongodb")
	delete(driverGoModuleAliasPathMap, "mongodb")
	delete(fallbackRecentDriverVersionsMap, "mongodb")
	delete(latestDriverVersionMap, "mongodb")
	t.Cleanup(func() {
		if hadModulePath {
			driverGoModulePathMap["mongodb"] = originalModulePath
		} else {
			delete(driverGoModulePathMap, "mongodb")
		}
		if hadAliasPaths {
			driverGoModuleAliasPathMap["mongodb"] = originalAliasPaths
		} else {
			delete(driverGoModuleAliasPathMap, "mongodb")
		}
		if hadFallbackVersions {
			fallbackRecentDriverVersionsMap["mongodb"] = originalFallbackVersions
		} else {
			delete(fallbackRecentDriverVersionsMap, "mongodb")
		}
		if hadLatestVersion {
			latestDriverVersionMap["mongodb"] = originalLatestVersion
		} else {
			delete(latestDriverVersionMap, "mongodb")
		}
	})

	_, err = resolveDriverVersionOptions(
		driverDefinition{Type: "mongodb", Name: "MongoDB"},
		"unsupported://manifest",
		app.appText,
	)
	if err == nil {
		t.Fatal("expected missing driver version options error")
	}
	if err.Error() != "No available driver versions were found" {
		t.Fatalf("expected English version options message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "未找到可用驱动版本") {
		t.Fatalf("expected no Chinese version options message in en-US mode, got %q", err.Error())
	}
}

func TestMethodsDriverModuleVersionFetchErrorsUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	functionSource := methodsDriverFunctionSource(t, source, "func fetchGoModuleVersionMetas(modulePath string)")
	for _, rawMessage := range []string{
		`fmt.Errorf("模块路径为空")`,
		`fmt.Errorf("拉取模块版本列表失败：HTTP %d", resp.StatusCode)`,
		`fmt.Errorf("读取模块版本列表失败：%w", err)`,
		`fmt.Errorf("模块版本列表为空")`,
	} {
		if strings.Contains(functionSource, rawMessage) {
			t.Fatalf("fetchGoModuleVersionMetas still contains raw module-version text %q", rawMessage)
		}
	}
	for _, key := range []string{
		"driver_manager.backend.error.module_path_empty",
		"driver_manager.backend.error.module_version_list_fetch_failed",
		"driver_manager.backend.error.module_version_list_read_failed",
		"driver_manager.backend.error.module_version_list_empty",
	} {
		if !strings.Contains(functionSource, key) {
			t.Fatalf("fetchGoModuleVersionMetas does not reference module-version i18n key %q", key)
		}
	}
}

func TestMethodsDriverModuleVersionFetchErrorCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"driver_manager.backend.error.module_path_empty",
		"driver_manager.backend.error.module_version_list_fetch_failed",
		"driver_manager.backend.error.module_version_list_read_failed",
		"driver_manager.backend.error.module_version_list_empty",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing module-version fetch key %q", language, key)
			}
		}
	}
}

func TestFetchGoModuleVersionMetasUsesCurrentLanguageForEmptyModulePath(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	_, err := fetchGoModuleVersionMetas("   ")
	if err == nil {
		t.Fatal("expected empty module path error")
	}
	if err.Error() != "Module path is empty" {
		t.Fatalf("expected English module path message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "模块路径为空") {
		t.Fatalf("expected no Chinese module path message in en-US mode, got %q", err.Error())
	}
}

func TestMethodsDriverBundleAcquireErrorsUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	functionSource := methodsDriverFunctionSource(t, source, "func acquireOptionalDriverBundlePath(bundleURL string, onProgress func(downloaded, total int64), onWaiting func()) (string, error)")
	if strings.Contains(functionSource, `fmt.Errorf("驱动总包下载地址为空")`) {
		t.Fatalf("acquireOptionalDriverBundlePath still contains raw bundle URL text")
	}
	if !strings.Contains(functionSource, "driver_manager.backend.error.bundle_url_empty") {
		t.Fatalf("acquireOptionalDriverBundlePath does not reference bundle URL i18n key")
	}
}

func TestAcquireOptionalDriverBundlePathUsesCurrentLanguageForEmptyURL(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	_, err := acquireOptionalDriverBundlePath("   ", nil, nil)
	if err == nil {
		t.Fatal("expected empty bundle URL error")
	}
	if err.Error() != "Driver bundle download URL is empty" {
		t.Fatalf("expected English bundle URL message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "驱动总包下载地址为空") {
		t.Fatalf("expected no Chinese bundle URL message in en-US mode, got %q", err.Error())
	}
}

func TestMethodsDriverManifestErrorsUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	checks := map[string]struct {
		rawMessages []string
		keys        []string
	}{
		"func resolveDriverRepositoryURL": {
			rawMessages: []string{
				`fmt.Errorf("无效的文件清单地址")`,
				`fmt.Errorf("不支持的内置清单地址：%s", parsed.String())`,
				`fmt.Errorf("不支持的清单地址协议：%s", parsed.Scheme)`,
			},
			keys: []string{
				"driver_manager.backend.error.file_manifest_url_invalid",
				"driver_manager.backend.message.unsupported_builtin_manifest_url",
				"driver_manager.backend.error.manifest_scheme_unsupported",
			},
		},
		"func loadManifestPackageAndVersions": {
			rawMessages: []string{`fmt.Errorf("解析驱动清单失败：%w", err)`},
			keys:        []string{"driver_manager.backend.error.manifest_parse_failed"},
		},
		"func loadManifestContent": {
			rawMessages: []string{
				`fmt.Errorf("驱动清单地址为空")`,
				`fmt.Errorf("拉取驱动清单失败：HTTP %d", resp.StatusCode)`,
				`fmt.Errorf("驱动清单超过大小限制")`,
				`fmt.Errorf("无效的本地驱动清单地址")`,
				`fmt.Errorf("不支持的内置清单地址：%s", parsed.String())`,
			},
			keys: []string{
				"driver_manager.backend.error.manifest_url_empty",
				"driver_manager.backend.error.manifest_fetch_failed",
				"driver_manager.backend.error.manifest_too_large",
				"driver_manager.backend.error.local_manifest_url_invalid",
				"driver_manager.backend.message.unsupported_builtin_manifest_url",
			},
		},
	}

	for signature, check := range checks {
		functionSource := methodsDriverFunctionSource(t, source, signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw manifest text %q", signature, rawMessage)
			}
		}
		for _, key := range check.keys {
			if !strings.Contains(functionSource, key) {
				t.Fatalf("%s does not reference manifest i18n key %q", signature, key)
			}
		}
	}
}

func TestMethodsDriverManifestErrorCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"driver_manager.backend.error.file_manifest_url_invalid",
		"driver_manager.backend.message.unsupported_builtin_manifest_url",
		"driver_manager.backend.error.manifest_scheme_unsupported",
		"driver_manager.backend.error.manifest_parse_failed",
		"driver_manager.backend.error.manifest_url_empty",
		"driver_manager.backend.error.manifest_fetch_failed",
		"driver_manager.backend.error.manifest_too_large",
		"driver_manager.backend.error.local_manifest_url_invalid",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing manifest key %q", language, key)
			}
		}
	}
}

func TestResolveDriverRepositoryURLUsesCurrentLanguageForStructuredErrors(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	invalidFile := app.ResolveDriverRepositoryURL("file://")
	if invalidFile.Success {
		t.Fatal("expected invalid file manifest URL error")
	}
	if invalidFile.Message != "Invalid file driver manifest URL" {
		t.Fatalf("expected English invalid file manifest URL message, got %q", invalidFile.Message)
	}
	if strings.Contains(invalidFile.Message, "无效的文件清单地址") {
		t.Fatalf("expected no Chinese invalid file manifest URL text in en-US mode, got %q", invalidFile.Message)
	}

	unsupportedScheme := app.ResolveDriverRepositoryURL("unsupported://manifest")
	if unsupportedScheme.Success {
		t.Fatal("expected unsupported manifest scheme error")
	}
	if unsupportedScheme.Message != "Unsupported driver manifest URL scheme: unsupported" {
		t.Fatalf("expected English unsupported scheme message, got %q", unsupportedScheme.Message)
	}
	if strings.Contains(unsupportedScheme.Message, "不支持的清单地址协议") {
		t.Fatalf("expected no Chinese unsupported scheme text in en-US mode, got %q", unsupportedScheme.Message)
	}
}

func TestGetDriverStatusListUsesCurrentLanguageForManifestErrors(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	disableGlobalProxyForTest(t)
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	fetchServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("busy"))
	}))
	defer fetchServer.Close()
	driverManifestCacheMu.Lock()
	delete(driverManifestCache, fetchServer.URL)
	driverManifestCacheMu.Unlock()
	t.Cleanup(func() {
		driverManifestCacheMu.Lock()
		delete(driverManifestCache, fetchServer.URL)
		driverManifestCacheMu.Unlock()
	})

	fetchRes := app.GetDriverStatusList(t.TempDir(), fetchServer.URL)
	if !fetchRes.Success {
		t.Fatalf("expected status list success with manifest warning, got %+v", fetchRes)
	}
	fetchData, ok := fetchRes.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("expected status list data map, got %T", fetchRes.Data)
	}
	fetchManifestError := strings.TrimSpace(fmt.Sprint(fetchData["manifestError"]))
	if fetchManifestError != "Failed to fetch driver manifest: HTTP 503" {
		t.Fatalf("expected English manifest fetch warning, got %q", fetchManifestError)
	}
	if strings.Contains(fetchManifestError, "拉取驱动清单失败") {
		t.Fatalf("expected no Chinese manifest fetch warning in en-US mode, got %q", fetchManifestError)
	}
	fetchResCached := app.GetDriverStatusList(t.TempDir(), fetchServer.URL)
	if !fetchResCached.Success {
		t.Fatalf("expected cached status list success with manifest warning, got %+v", fetchResCached)
	}
	fetchDataCached, ok := fetchResCached.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("expected cached status list data map, got %T", fetchResCached.Data)
	}
	fetchManifestErrorCached := strings.TrimSpace(fmt.Sprint(fetchDataCached["manifestError"]))
	if fetchManifestErrorCached != "Failed to fetch driver manifest: HTTP 503" {
		t.Fatalf("expected cached English manifest fetch warning, got %q", fetchManifestErrorCached)
	}
	if strings.Contains(fetchManifestErrorCached, "拉取驱动清单失败") {
		t.Fatalf("expected no Chinese cached manifest fetch warning in en-US mode, got %q", fetchManifestErrorCached)
	}

	parseServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{not-json"))
	}))
	defer parseServer.Close()
	driverManifestCacheMu.Lock()
	delete(driverManifestCache, parseServer.URL)
	driverManifestCacheMu.Unlock()
	t.Cleanup(func() {
		driverManifestCacheMu.Lock()
		delete(driverManifestCache, parseServer.URL)
		driverManifestCacheMu.Unlock()
	})

	parseRes := app.GetDriverStatusList(t.TempDir(), parseServer.URL)
	if !parseRes.Success {
		t.Fatalf("expected status list success with manifest parse warning, got %+v", parseRes)
	}
	parseData, ok := parseRes.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("expected status list data map, got %T", parseRes.Data)
	}
	parseManifestError := strings.TrimSpace(fmt.Sprint(parseData["manifestError"]))
	if !strings.HasPrefix(parseManifestError, "Failed to parse driver manifest:") {
		t.Fatalf("expected English manifest parse warning, got %q", parseManifestError)
	}
	if strings.Contains(parseManifestError, "解析驱动清单失败") {
		t.Fatalf("expected no Chinese manifest parse warning in en-US mode, got %q", parseManifestError)
	}
	parseResCached := app.GetDriverStatusList(t.TempDir(), parseServer.URL)
	if !parseResCached.Success {
		t.Fatalf("expected cached status list success with manifest parse warning, got %+v", parseResCached)
	}
	parseDataCached, ok := parseResCached.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("expected cached status list data map, got %T", parseResCached.Data)
	}
	parseManifestErrorCached := strings.TrimSpace(fmt.Sprint(parseDataCached["manifestError"]))
	if !strings.HasPrefix(parseManifestErrorCached, "Failed to parse driver manifest:") {
		t.Fatalf("expected cached English manifest parse warning, got %q", parseManifestErrorCached)
	}
	if strings.Contains(parseManifestErrorCached, "解析驱动清单失败") {
		t.Fatalf("expected no Chinese cached manifest parse warning in en-US mode, got %q", parseManifestErrorCached)
	}
}

func TestMethodsDriverUnsupportedVersionErrorsUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	functionSource := methodsDriverFunctionSource(t, source, "func (a *App) localizeDriverSelectionError")
	for _, key := range []string{
		"driver_manager.backend.error.mongo_version_unsupported",
		"driver_manager.backend.error.driver_version_unsupported",
	} {
		if !strings.Contains(functionSource, key) {
			t.Fatalf("localizeDriverSelectionError does not reference unsupported-version i18n key %q", key)
		}
	}
}

func TestMethodsDriverUnsupportedVersionErrorTypesUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	checks := map[string]struct {
		rawMessages []string
		keys        []string
	}{
		"func (e *driverBuildUnavailableError) Error() string": {
			rawMessages: []string{
				`fmt.Sprintf("%s 当前发行包为精简构建，未内置该驱动；如需使用请安装 Full 版", strings.TrimSpace(e.Name))`,
			},
			keys: []string{
				"driver_manager.backend.status.slim_build_required",
			},
		},
		"func (e *driverVersionValidationError) Error() string": {
			rawMessages: []string{
				`fmt.Sprintf("MongoDB 版本 %s 当前不受支持；仅支持 1.17.x 和 2.x", versionText)`,
				`fmt.Sprintf("%s 版本 %s 当前不受支持", driverType, versionText)`,
			},
			keys: []string{
				"driver_manager.backend.error.mongo_version_unsupported",
				"driver_manager.backend.error.driver_version_unsupported",
			},
		},
	}

	for signature, check := range checks {
		functionSource := methodsDriverFunctionSource(t, source, signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw unsupported-version error text %q", signature, rawMessage)
			}
		}
		for _, key := range check.keys {
			if !strings.Contains(functionSource, key) {
				t.Fatalf("%s does not reference unsupported-version error i18n key %q", signature, key)
			}
		}
	}
}

func TestMethodsDriverUnsupportedVersionErrorCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"driver_manager.backend.error.mongo_version_unsupported",
		"driver_manager.backend.error.driver_version_unsupported",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing unsupported-version key %q", language, key)
			}
		}
	}
}

func TestDriverSelectionErrorTypesUseCurrentLanguageDirectly(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	cases := []struct {
		name  string
		err   error
		want  string
		avoid string
	}{
		{
			name:  "slim build required",
			err:   &driverBuildUnavailableError{Name: "ClickHouse"},
			want:  "ClickHouse is not included in the current slim build. Install the Full edition to use this driver.",
			avoid: "当前发行包为精简构建",
		},
		{
			name: "mongodb version unsupported",
			err: &driverVersionValidationError{
				DriverType: "mongodb",
				Version:    "1.16.9",
			},
			want:  "MongoDB version 1.16.9 is not supported; only 1.17.x and 2.x are supported",
			avoid: "当前不受支持；仅支持 1.17.x 和 2.x",
		},
		{
			name: "generic driver version unsupported",
			err: &driverVersionValidationError{
				DriverType: "clickhouse",
				Version:    " 24.3.1 ",
			},
			want:  "ClickHouse version 24.3.1 is not supported",
			avoid: "当前不受支持",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.err.Error()
			if got != tc.want {
				t.Fatalf("expected direct English driver error %q, got %q", tc.want, got)
			}
			if strings.Contains(got, tc.avoid) {
				t.Fatalf("expected no Chinese direct driver error in en-US mode, got %q", got)
			}
		})
	}
}

func TestLocalizeDriverSelectionErrorUsesCurrentLanguageForUnsupportedVersions(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	cases := []struct {
		name       string
		definition driverDefinition
		err        error
		want       string
		avoid      string
	}{
		{
			name:       "mongodb compatibility pin",
			definition: driverDefinition{Type: "mongodb", Name: "MongoDB"},
			err: &driverVersionValidationError{
				DriverType: "mongodb",
				Version:    "1.16.9",
			},
			want:  "MongoDB version 1.16.9 is not supported; only 1.17.x and 2.x are supported",
			avoid: "当前不受支持；仅支持 1.17.x 和 2.x",
		},
		{
			name:       "generic optional driver version",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			err: &driverVersionValidationError{
				DriverType: "clickhouse",
				Version:    " 24.3.1 ",
			},
			want:  "ClickHouse version 24.3.1 is not supported",
			avoid: "当前不受支持",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := app.localizeDriverSelectionError(tc.definition, tc.err)
			if err == nil {
				t.Fatal("expected unsupported version error")
			}
			if err.Error() != tc.want {
				t.Fatalf("expected English unsupported-version message %q, got %q", tc.want, err.Error())
			}
			if strings.Contains(err.Error(), tc.avoid) {
				t.Fatalf("expected no Chinese unsupported-version message in en-US mode, got %q", err.Error())
			}
		})
	}
}

func TestMethodsDriverRuntimeReasonCompatibilityUsesLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	checks := map[string]struct {
		rawMessages []string
		keys        []string
	}{
		"func parseDriverAgentArchIncompatibleDetail": {
			rawMessages: []string{
				`"可执行文件架构不兼容（文件="`,
				`"，当前进程="`,
			},
		},
		"func parseDriverAgentUnavailableDetail": {
			rawMessages: []string{
				`" 驱动代理不可用："`,
				`"；请在驱动管理中重新安装启用"`,
			},
			keys: []string{
				"driver_manager.backend.status.agent_unavailable_reinstall",
			},
		},
		"func (a *App) localizeDriverRuntimeReason": {
			rawMessages: []string{
				`"未识别的数据源类型"`,
				`fmt.Sprintf("%s 当前发行包为精简构建，未内置该驱动；如需使用请安装 Full 版", name)`,
				`fmt.Sprintf("%s 驱动代理路径解析失败，请在驱动管理中重新安装启用", name)`,
				`fmt.Sprintf("%s 驱动代理路径为空；请在驱动管理中重新安装启用", name)`,
				`fmt.Sprintf("%s 驱动代理缺失，请在驱动管理中重新安装启用", name)`,
				`fmt.Sprintf("%s 纯 Go 驱动未启用，请先在驱动管理中点击“安装启用”", name)`,
			},
			keys: []string{
				"driver_manager.backend.status.unrecognized_driver_type",
				"driver_manager.backend.status.slim_build_required",
				"driver_manager.backend.status.agent_path_failed",
				"driver_manager.backend.status.agent_missing",
				"driver_manager.backend.status.optional_disabled",
				"driver_manager.backend.status.agent_unavailable_reinstall",
				"driver_manager.backend.status.agent_arch_incompatible_detail",
			},
		},
		"func resolveDriverDisplayName": {
			rawMessages: []string{
				`return "未知"`,
			},
			keys: []string{
				"driver_manager.backend.driver_fallback_name",
			},
		},
	}

	for signature, check := range checks {
		functionSource := methodsDriverFunctionSource(t, source, signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw runtime-reason text %q", signature, rawMessage)
			}
		}
		for _, key := range check.keys {
			if !strings.Contains(functionSource, key) {
				t.Fatalf("%s does not reference runtime-reason i18n key %q", signature, key)
			}
		}
	}
}

func TestLocalizeDriverRuntimeReasonUsesCurrentLanguageForLegacyZhCNReasons(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	zhLocalizer, err := i18n.NewLocalizer(i18n.LanguageZhCN)
	if err != nil {
		t.Fatalf("NewLocalizer(zh-CN): %v", err)
	}

	buildLegacyAgentUnavailableReason := func(name string, detail string) string {
		current := zhLocalizer.T("driver_manager.backend.status.agent_unavailable_reinstall", map[string]any{
			"name":   name,
			"detail": detail,
		})
		return strings.Replace(current, detail+"。", detail+"；", 1)
	}

	cases := []struct {
		name       string
		definition driverDefinition
		reason     string
		want       string
		avoid      string
	}{
		{
			name:       "unrecognized driver type",
			definition: driverDefinition{},
			reason:     zhLocalizer.T("driver_manager.backend.status.unrecognized_driver_type", nil),
			want:       "Unrecognized data source type",
			avoid:      "未识别的数据源类型",
		},
		{
			name:       "slim build required",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: zhLocalizer.T("driver_manager.backend.status.slim_build_required", map[string]any{
				"name": "ClickHouse",
			}),
			want:  "ClickHouse is not included in the current slim build. Install the Full edition to use this driver.",
			avoid: "当前发行包为精简构建",
		},
		{
			name:       "agent path failed",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: zhLocalizer.T("driver_manager.backend.status.agent_path_failed", map[string]any{
				"name": "ClickHouse",
			}),
			want:  "ClickHouse driver agent path could not be resolved; reinstall and enable it in Driver Manager.",
			avoid: "驱动代理路径解析失败",
		},
		{
			name:       "agent missing",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: zhLocalizer.T("driver_manager.backend.status.agent_missing", map[string]any{
				"name": "ClickHouse",
			}),
			want:  "ClickHouse driver agent is missing; reinstall and enable it in Driver Manager.",
			avoid: "驱动代理缺失",
		},
		{
			name:       "optional driver disabled",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: zhLocalizer.T("driver_manager.backend.status.optional_disabled", map[string]any{
				"name": "ClickHouse",
			}),
			want:  "ClickHouse Go driver is not enabled; install and enable it in Driver Manager.",
			avoid: "纯 Go 驱动未启用",
		},
		{
			name:       "agent arch incompatible current zh-CN template",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: zhLocalizer.T("driver_manager.backend.status.agent_arch_incompatible_detail", map[string]any{
				"name":    "ClickHouse",
				"file":    "arm64",
				"process": "amd64",
			}),
			want:  "ClickHouse driver agent architecture is incompatible: file=arm64, current process=amd64; reinstall and enable it in Driver Manager.",
			avoid: "驱动代理架构不兼容",
		},
		{
			name:       "legacy unavailable wrapper with english arch detail",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: buildLegacyAgentUnavailableReason(
				"ClickHouse",
				"driver agent architecture is incompatible (file=arm64, current process=amd64)",
			),
			want:  "ClickHouse driver agent architecture is incompatible: file=arm64, current process=amd64; reinstall and enable it in Driver Manager.",
			avoid: "驱动代理不可用",
		},
		{
			name:       "legacy unavailable wrapper keeps raw detail",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason:     buildLegacyAgentUnavailableReason("ClickHouse", "permission denied"),
			want:       "ClickHouse driver agent is unavailable: permission denied; reinstall and enable it in Driver Manager.",
			avoid:      "驱动代理不可用",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := app.localizeDriverRuntimeReason(tc.definition, tc.reason)
			if got != tc.want {
				t.Fatalf("expected localized runtime reason %q, got %q", tc.want, got)
			}
			if strings.Contains(got, tc.avoid) {
				t.Fatalf("expected no Chinese runtime reason fragment %q in %q", tc.avoid, got)
			}
		})
	}
}

func TestResolveDriverDisplayNameUsesCurrentLanguageFallbackName(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	got := resolveDriverDisplayName(driverDefinition{})
	if got != "driver" {
		t.Fatalf("expected English fallback driver display name %q, got %q", "driver", got)
	}
	if strings.Contains(got, "未知") {
		t.Fatalf("expected no Chinese fallback driver display name, got %q", got)
	}
}

func TestMethodsDriverUpdateStatusUsesLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	checks := map[string]struct {
		rawMessages []string
		keys        []string
	}{
		"func optionalDriverAgentRevisionStatus": {
			rawMessages: []string{
				`fmt.Sprintf("当前 GoNavi 版本要求更新后的 %s driver-agent（revision: %s）", displayName, expected)`,
				`impact := "driver-agent 是独立二进制，不会随主程序自动更新；如果不重装，会继续使用旧 agent 逻辑，驱动侧已修复或优化的行为不会生效，可能继续出现旧版本问题。强烈建议重装对应驱动代理"`,
				`fmt.Sprintf("原因：%s。影响：%s", updateReason, impact)`,
				`fmt.Sprintf("原因：%s。影响：%s（已安装标记：%s，当前需要：%s）", updateReason, impact, actual, expected)`,
			},
			keys: []string{
				"driver_manager.backend.status.agent_revision_update_detail",
				"driver_manager.backend.status.agent_revision_update_detail_with_actual",
			},
		},
		"func optionalDriverPackageUpdateStatus": {
			rawMessages: []string{
				`fmt.Sprintf("原因：当前推荐 MongoDB 兼容驱动版本为 %s，已安装版本为 %s。影响：MongoDB 2.x driver-agent 使用官方 v2 驱动，要求服务端 MongoDB 4.2+；连接 MongoDB 4.0 会出现 wire version 7 不兼容。强烈建议重装对应驱动代理", pinned, installed)`,
			},
			keys: []string{
				"driver_manager.backend.status.mongodb_compatibility_update_detail",
			},
		},
	}

	for signature, check := range checks {
		functionSource := methodsDriverFunctionSource(t, source, signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw update status text %q", signature, rawMessage)
			}
		}
		for _, key := range check.keys {
			if !strings.Contains(functionSource, key) {
				t.Fatalf("%s does not reference update status i18n key %q", signature, key)
			}
		}
	}
}

func TestMethodsDriverUpdateStatusCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"driver_manager.backend.status.agent_revision_update_detail",
		"driver_manager.backend.status.agent_revision_update_detail_with_actual",
		"driver_manager.backend.status.mongodb_compatibility_update_detail",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing update status key %q", language, key)
			}
		}
	}
}

func TestOptionalDriverAgentRevisionStatusUsesCurrentLanguageForUpdateReason(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	needsUpdate, reason, expected := optionalDriverAgentRevisionStatus("clickhouse", installedDriverPackage{}, true)
	if !needsUpdate {
		t.Fatal("expected ClickHouse revision mismatch to require update")
	}
	if expected == "" {
		t.Fatal("expected ClickHouse to define an expected revision")
	}
	if !strings.Contains(reason, "Reason:") || !strings.Contains(reason, "Impact:") {
		t.Fatalf("expected English reason/impact wrapper, got %q", reason)
	}
	if !strings.Contains(reason, "ClickHouse driver-agent") || !strings.Contains(reason, expected) {
		t.Fatalf("expected English ClickHouse revision detail with expected revision, got %q", reason)
	}
	if strings.Contains(reason, "原因：") || strings.Contains(reason, "影响：") || strings.Contains(reason, "强烈建议重装") {
		t.Fatalf("expected no Chinese revision update reason in en-US mode, got %q", reason)
	}
}

func TestOptionalDriverPackageUpdateStatusUsesCurrentLanguageForMongoCompatibility(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

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
		t.Fatal("expected MongoDB legacy compatibility prompt")
	}
	if !strings.Contains(reason, "Reason:") || !strings.Contains(reason, "Impact:") {
		t.Fatalf("expected English reason/impact wrapper, got %q", reason)
	}
	if !strings.Contains(reason, "recommended MongoDB compatibility driver version") || !strings.Contains(reason, "wire version 7") {
		t.Fatalf("expected English MongoDB compatibility detail, got %q", reason)
	}
	if strings.Contains(reason, "原因：") || strings.Contains(reason, "影响：") || strings.Contains(reason, "当前推荐 MongoDB 兼容驱动版本") {
		t.Fatalf("expected no Chinese MongoDB compatibility reason in en-US mode, got %q", reason)
	}
}

func TestMethodsDriverSourceBuildHelperErrorsUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	checks := map[string]struct {
		rawMessages []string
		keys        []string
	}{
		"func optionalDriverBuildTag": {
			rawMessages: []string{
				`fmt.Errorf("未配置驱动构建标签：%s", driverType)`,
			},
			keys: []string{
				"driver_manager.backend.error.source_build_tag_unconfigured",
			},
		},
		"func locateProjectRootForAgentBuild": {
			rawMessages: []string{
				`fmt.Errorf("获取当前目录失败：%w", err)`,
				`fmt.Errorf("未找到通用驱动代理源码，无法自动构建；请使用已发布版本")`,
			},
			keys: []string{
				"driver_manager.backend.error.source_build_workdir_unavailable",
				"driver_manager.backend.error.source_build_project_root_missing",
			},
		},
		"func buildVersionedDriverModOverride": {
			rawMessages: []string{
				`fmt.Errorf("读取 go.mod 失败：%w", err)`,
				`fmt.Errorf("未在 go.mod 中找到驱动依赖：%s", modulePath)`,
				`fmt.Errorf("创建驱动构建临时目录失败：%w", err)`,
				`fmt.Errorf("写入临时 go.mod 失败：%w", err)`,
				`fmt.Errorf("写入临时 go.sum 失败：%w", writeErr)`,
			},
			keys: []string{
				"driver_manager.backend.error.source_build_go_mod_read_failed",
				"driver_manager.backend.error.source_build_module_dependency_missing",
				"driver_manager.backend.error.source_build_temp_directory_create_failed",
				"driver_manager.backend.error.source_build_temp_go_mod_write_failed",
				"driver_manager.backend.error.source_build_temp_go_sum_write_failed",
			},
		},
		"func rewriteRequiredModuleVersion": {
			rawMessages: []string{
				`fmt.Errorf("驱动模块或版本为空")`,
			},
			keys: []string{
				"driver_manager.backend.error.source_build_module_or_version_empty",
			},
		},
		"func buildOptionalDriverAgentFromSource": {
			rawMessages: []string{
				`fmt.Errorf("准备 DuckDB Windows CGO 编译器失败：%w", toolchainErr)`,
				`fmt.Errorf("准备 DuckDB Windows 动态库失败：%w", prepErr)`,
			},
			keys: []string{
				"driver_manager.backend.error.source_build_duckdb_windows_cgo_toolchain_prepare_failed",
				"driver_manager.backend.error.source_build_duckdb_windows_dynamic_library_prepare_failed",
			},
		},
		"func resolveDuckDBWindowsCGOToolchainBinFromCandidates": {
			rawMessages: []string{
				`请先安装 MSYS2 UCRT64 工具链：winget install --id MSYS2.MSYS2 -e；然后执行 C:\msys64\usr\bin\bash.exe -lc "pacman -S --needed --noconfirm mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-binutils"`,
				`fmt.Errorf("未找到可用的 gcc.exe/g++.exe；%s", installHint)`,
				`fmt.Errorf("未找到可用的 gcc.exe/g++.exe，已检查：%s；%s", strings.Join(checked, ", "), installHint)`,
			},
			keys: []string{
				"driver_manager.backend.error.source_build_duckdb_windows_toolchain_install_hint",
				"driver_manager.backend.error.source_build_duckdb_windows_gcc_not_found",
				"driver_manager.backend.error.source_build_duckdb_windows_gcc_not_found_with_checked",
			},
		},
		"func prepareDuckDBWindowsDynamicLibraryForBuild": {
			rawMessages: []string{
				`fmt.Errorf("DuckDB 官方动态库包缺少文件：%s", strings.Join(missing, ", "))`,
				`fmt.Errorf("定位 DuckDB Windows dlltool 失败：%w", err)`,
			},
			keys: []string{
				"driver_manager.backend.error.source_build_duckdb_windows_dynamic_library_missing_files",
				"driver_manager.backend.error.source_build_duckdb_windows_dlltool_resolve_failed",
			},
		},
	}

	for signature, check := range checks {
		functionSource := methodsDriverFunctionSource(t, source, signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw source-build text %q", signature, rawMessage)
			}
		}
		for _, key := range check.keys {
			if !strings.Contains(functionSource, key) {
				t.Fatalf("%s does not reference source-build i18n key %q", signature, key)
			}
		}
	}
}

func TestMethodsDriverSourceBuildHelperCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"driver_manager.backend.error.source_build_tag_unconfigured",
		"driver_manager.backend.error.source_build_workdir_unavailable",
		"driver_manager.backend.error.source_build_project_root_missing",
		"driver_manager.backend.error.source_build_go_mod_read_failed",
		"driver_manager.backend.error.source_build_module_dependency_missing",
		"driver_manager.backend.error.source_build_temp_directory_create_failed",
		"driver_manager.backend.error.source_build_temp_go_mod_write_failed",
		"driver_manager.backend.error.source_build_temp_go_sum_write_failed",
		"driver_manager.backend.error.source_build_module_or_version_empty",
		"driver_manager.backend.error.source_build_duckdb_windows_cgo_toolchain_prepare_failed",
		"driver_manager.backend.error.source_build_duckdb_windows_dynamic_library_prepare_failed",
		"driver_manager.backend.error.source_build_duckdb_windows_toolchain_install_hint",
		"driver_manager.backend.error.source_build_duckdb_windows_gcc_not_found",
		"driver_manager.backend.error.source_build_duckdb_windows_gcc_not_found_with_checked",
		"driver_manager.backend.error.source_build_duckdb_windows_dynamic_library_missing_files",
		"driver_manager.backend.error.source_build_duckdb_windows_dlltool_resolve_failed",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing source-build key %q", language, key)
			}
		}
	}
}

func TestOptionalDriverBuildTagUsesCurrentLanguageForUnconfiguredDriver(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	_, err := optionalDriverBuildTag("unsupported", "")
	if err == nil {
		t.Fatal("expected missing build-tag error")
	}
	if err.Error() != "No build tags are configured for driver type: unsupported" {
		t.Fatalf("expected English source-build tag message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "未配置驱动构建标签") {
		t.Fatalf("expected no Chinese source-build tag message in en-US mode, got %q", err.Error())
	}
}

func TestLocateProjectRootForAgentBuildUsesCurrentLanguageWhenSourceMissing(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	originalWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd() error = %v", err)
	}
	tempDir := t.TempDir()
	if err := os.Chdir(tempDir); err != nil {
		t.Fatalf("Chdir(%q) error = %v", tempDir, err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(originalWD)
	})

	_, err = locateProjectRootForAgentBuild()
	if err == nil {
		t.Fatal("expected missing project-root error")
	}
	if err.Error() != "Optional driver agent source was not found in the project; please use a published build" {
		t.Fatalf("expected English source-build project-root message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "未找到通用驱动代理源码") {
		t.Fatalf("expected no Chinese source-build project-root message in en-US mode, got %q", err.Error())
	}
}

func TestBuildVersionedDriverModOverrideUsesCurrentLanguageForStructuredErrors(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	missingGoModDir := t.TempDir()
	_, err := buildVersionedDriverModOverride(missingGoModDir, "github.com/example/driver", "1.2.3")
	if err == nil {
		t.Fatal("expected go.mod read failure")
	}
	if !strings.HasPrefix(err.Error(), "Failed to read go.mod:") {
		t.Fatalf("expected English go.mod read prefix, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "读取 go.mod 失败") {
		t.Fatalf("expected no Chinese go.mod read message in en-US mode, got %q", err.Error())
	}

	projectDir := t.TempDir()
	goMod := "module example.com/test\n\ngo 1.24.0\n\nrequire github.com/example/other v1.0.0\n"
	if writeErr := os.WriteFile(filepath.Join(projectDir, "go.mod"), []byte(goMod), 0o644); writeErr != nil {
		t.Fatalf("WriteFile(go.mod) error = %v", writeErr)
	}

	_, err = buildVersionedDriverModOverride(projectDir, "github.com/example/missing", "1.2.3")
	if err == nil {
		t.Fatal("expected missing driver dependency error")
	}
	if err.Error() != "Driver dependency was not found in go.mod: github.com/example/missing" {
		t.Fatalf("expected English missing dependency message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "未在 go.mod 中找到驱动依赖") {
		t.Fatalf("expected no Chinese missing dependency message in en-US mode, got %q", err.Error())
	}
}

func TestRewriteRequiredModuleVersionUsesCurrentLanguageForEmptyInput(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	_, _, err := rewriteRequiredModuleVersion(nil, "   ", "   ")
	if err == nil {
		t.Fatal("expected empty module/version error")
	}
	if err.Error() != "Driver module path or version is empty" {
		t.Fatalf("expected English empty module/version message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "驱动模块或版本为空") {
		t.Fatalf("expected no Chinese empty module/version message in en-US mode, got %q", err.Error())
	}
}

func TestResolveDuckDBWindowsCGOToolchainBinFromCandidatesUsesCurrentLanguageWhenNoneFound(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	_, err := resolveDuckDBWindowsCGOToolchainBinFromCandidates(nil)
	if err == nil {
		t.Fatal("expected missing DuckDB Windows toolchain error")
	}
	expected := `No usable gcc.exe/g++.exe was found; Please install the MSYS2 UCRT64 toolchain first: winget install --id MSYS2.MSYS2 -e; then run C:\msys64\usr\bin\bash.exe -lc "pacman -S --needed --noconfirm mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-binutils"`
	if err.Error() != expected {
		t.Fatalf("expected English DuckDB Windows toolchain message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "未找到可用的 gcc.exe/g++.exe") || strings.Contains(err.Error(), "请先安装 MSYS2 UCRT64 工具链") {
		t.Fatalf("expected no Chinese DuckDB Windows toolchain message in en-US mode, got %q", err.Error())
	}
}

func TestResolveDuckDBWindowsCGOToolchainBinFromCandidatesUsesCurrentLanguageWhenCheckedPathsMissing(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	_, err := resolveDuckDBWindowsCGOToolchainBinFromCandidates([]string{`C:\missing1`, `C:\missing2`})
	if err == nil {
		t.Fatal("expected missing DuckDB Windows toolchain error after checking candidates")
	}
	expected := `No usable gcc.exe/g++.exe was found. Checked: C:\missing1, C:\missing2; Please install the MSYS2 UCRT64 toolchain first: winget install --id MSYS2.MSYS2 -e; then run C:\msys64\usr\bin\bash.exe -lc "pacman -S --needed --noconfirm mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-binutils"`
	if err.Error() != expected {
		t.Fatalf("expected English DuckDB Windows checked-path message, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "未找到可用的 gcc.exe/g++.exe") || strings.Contains(err.Error(), "请先安装 MSYS2 UCRT64 工具链") {
		t.Fatalf("expected no Chinese DuckDB Windows checked-path message in en-US mode, got %q", err.Error())
	}
}
