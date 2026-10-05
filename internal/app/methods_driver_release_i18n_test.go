package app

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"GoNavi-Wails/shared/i18n"
)

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
