package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
)

func TestOptionalDriverAgentDownloadAndBuildErrorsUseI18nWrappers(t *testing.T) {
	source := methodsDriverSource(t)

	functionNames := []string{
		"ensureOptionalDriverAgentBinary",
		"downloadOptionalDriverAgentBinary",
		"downloadOptionalDriverAgentBinaryWithMetadata",
		"downloadOptionalDriverAgentFromBundle",
		"buildOptionalDriverAgentFromSource",
	}
	functionSource := ""
	for _, name := range functionNames {
		start := strings.Index(source, "func "+name)
		if start < 0 {
			t.Fatalf("methods_driver.go missing %s", name)
		}
		rest := source[start+len("func "+name):]
		end := strings.Index(rest, "\nfunc ")
		if end < 0 {
			t.Fatalf("%s function boundary not found", name)
		}
		functionSource += rest[:end]
	}

	rawWrappers := []string{
		`fmt.Errorf("下载地址为空")`,
		`fmt.Errorf("下载失败：%w"`,
		`fmt.Errorf("安装预编译驱动包失败：%w"`,
		`fmt.Errorf("计算驱动代理摘要失败：%w"`,
		`fmt.Errorf("%s 当前平台需要随包提供运行时依赖`,
		`fmt.Errorf("驱动总包下载地址为空")`,
		`fmt.Errorf("下载驱动总包失败：%w"`,
		`fmt.Errorf("打开驱动总包失败：%w"`,
		`fmt.Errorf("驱动总包内未找到 %s`,
		`fmt.Errorf("读取驱动总包条目失败：%w"`,
		`fmt.Errorf("当前环境未安装 Go`,
		`fmt.Errorf("构建 %s 驱动代理超时`,
		`fmt.Errorf("构建 %s 驱动代理失败`,
		`fmt.Errorf("复制 %s 运行时依赖失败`,
		`fmt.Errorf("设置 %s 驱动代理权限失败`,
		`fmt.Errorf("计算 %s 驱动代理摘要失败`,
		`fmt.Errorf("清理已安装 %s 驱动代理失败`,
		`fmt.Errorf("%s 驱动代理路径被目录占用`,
		`fmt.Errorf("创建 %s 驱动目录失败`,
		`fmt.Errorf("复制预置 %s 驱动代理失败`,
		`fmt.Errorf("计算预置 %s 驱动代理摘要失败`,
	}
	for _, rawWrapper := range rawWrappers {
		if strings.Contains(functionSource, rawWrapper) {
			t.Fatalf("optional driver agent flow still contains raw error wrapper %s", rawWrapper)
		}
	}

	requiredKeys := []string{
		"driver_manager.backend.error.download_url_empty",
		"driver_manager.backend.error.download_failed",
		"driver_manager.backend.error.bundle_url_empty",
		"driver_manager.backend.error.bundle_download_failed",
		"driver_manager.backend.error.open_bundle_failed",
		"driver_manager.backend.error.read_bundle_entry_failed",
		"driver_manager.backend.error.source_build_failed",
		"driver_manager.backend.error.remove_installed_agent_failed",
		"driver_manager.backend.error.agent_path_occupied_by_directory",
		"driver_manager.backend.error.create_named_directory_failed",
		"driver_manager.backend.error.copy_bundled_agent_failed",
		"driver_manager.backend.error.bundled_agent_hash_failed",
	}
	for _, key := range requiredKeys {
		if !strings.Contains(functionSource, key) {
			t.Fatalf("optional driver agent flow does not reference i18n key %q", key)
		}
	}
}

func TestInstallOptionalDriverAgentPackageUsesLocalizedNamedHashFailure(t *testing.T) {
	source := methodsDriverSource(t)

	start := strings.Index(source, "func installOptionalDriverAgentPackage")
	if start < 0 {
		t.Fatal("methods_driver.go missing installOptionalDriverAgentPackage")
	}
	rest := source[start+len("func installOptionalDriverAgentPackage"):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		t.Fatal("installOptionalDriverAgentPackage function boundary not found")
	}
	functionSource := rest[:end]

	if strings.Contains(functionSource, `fmt.Errorf("计算 %s 驱动代理摘要失败：%w"`) {
		t.Fatal("installOptionalDriverAgentPackage still contains raw driver agent hash wrapper")
	}
	if !strings.Contains(functionSource, `newLocalizedDriverBackendError("driver_manager.backend.error.named_agent_hash_failed"`) {
		t.Fatal("installOptionalDriverAgentPackage missing localized named agent hash wrapper")
	}
}

func TestEnsureOptionalDriverAgentBinaryUsesCurrentLanguageForPrebuiltPathErrors(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	executablePath := filepath.Join(t.TempDir(), optionalDriverExecutableBaseName("kingbase"))
	if err := os.MkdirAll(executablePath, 0o755); err != nil {
		t.Fatalf("create occupied executable directory failed: %v", err)
	}

	_, _, err := ensureOptionalDriverAgentBinary(
		context.Background(),
		app,
		driverDefinition{Type: "kingbase", Name: "Kingbase"},
		executablePath,
		"builtin://activate/kingbase",
		"0.0.0-test",
	)
	if err == nil {
		t.Fatal("expected occupied executable path to fail")
	}
	message := localizedDriverBackendErrorMessage(app, err)
	if !strings.Contains(message, "Kingbase driver-agent path is occupied by a directory") {
		t.Fatalf("expected English path occupied message, got %q", message)
	}
	if strings.Contains(message, "驱动代理路径被目录占用") {
		t.Fatalf("expected localized wrapper instead of fixed Chinese, got %q", message)
	}
	if !strings.Contains(message, executablePath) {
		t.Fatalf("expected raw executable path to stay in detail, got %q", message)
	}
}

func TestVerifyInstalledOptionalDriverAgentRevisionLocalizesMetadataUnavailable(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
	})
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		if driverType != "sqlserver" {
			t.Fatalf("unexpected driver type %q", driverType)
		}
		if executablePath != `C:\raw\driver-agent.exe` {
			t.Fatalf("unexpected executable path %q", executablePath)
		}
		return db.OptionalDriverAgentMetadata{}, fmt.Errorf("probe raw detail")
	}

	_, err := verifyInstalledOptionalDriverAgentRevision("sqlserver", `C:\raw\driver-agent.exe`)
	if err == nil {
		t.Fatal("expected metadata unavailable error")
	}

	app := NewApp()
	app.SetLanguage("en-US")
	got := localizedDriverBackendErrorMessage(app, err)
	if !strings.Contains(got, "driver-agent version metadata is unavailable") {
		t.Fatalf("expected English metadata wrapper, got %q", got)
	}
	if !strings.Contains(got, "probe raw detail") {
		t.Fatalf("expected raw probe detail to pass through, got %q", got)
	}
	for _, forbidden := range []string{"驱动代理", "不可用", "请安装"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("expected no Chinese wrapper fragment %q in %q", forbidden, got)
		}
	}
}

func TestVerifyInstalledOptionalDriverAgentRevisionLocalizesRevisionMismatch(t *testing.T) {
	expectedRevision := strings.TrimSpace(db.OptionalDriverAgentRevision("sqlserver"))
	if expectedRevision == "" {
		t.Fatal("expected sqlserver to define optional driver agent revision")
	}

	cases := []struct {
		name       string
		revision   string
		wantActual string
	}{
		{name: "raw actual revision", revision: "src-old", wantActual: "src-old"},
		{name: "empty actual revision", revision: "", wantActual: "empty"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			originalProbe := optionalDriverAgentMetadataProbe
			t.Cleanup(func() {
				optionalDriverAgentMetadataProbe = originalProbe
			})
			optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
				return db.OptionalDriverAgentMetadata{
					DriverType:    driverType,
					AgentRevision: tc.revision,
				}, nil
			}

			_, err := verifyInstalledOptionalDriverAgentRevision("sqlserver", `C:\raw\driver-agent.exe`)
			if err == nil {
				t.Fatal("expected revision mismatch error")
			}

			app := NewApp()
			app.SetLanguage("en-US")
			got := localizedDriverBackendErrorMessage(app, err)
			if !strings.Contains(got, "driver-agent revision does not match") {
				t.Fatalf("expected English revision mismatch wrapper, got %q", got)
			}
			if !strings.Contains(got, "installed: "+tc.wantActual) {
				t.Fatalf("expected installed revision %q to pass through, got %q", tc.wantActual, got)
			}
			if !strings.Contains(got, "required: "+expectedRevision) {
				t.Fatalf("expected required revision %q to pass through, got %q", expectedRevision, got)
			}
			for _, forbidden := range []string{"驱动代理", "不匹配", "已安装", "当前需要", "请安装", "空"} {
				if strings.Contains(got, forbidden) {
					t.Fatalf("expected no Chinese wrapper fragment %q in %q", forbidden, got)
				}
			}
		})
	}
}

func TestVerifyInstalledOptionalDriverAgentRevisionUsesI18nWrappers(t *testing.T) {
	source := methodsDriverSource(t)
	start := strings.Index(source, "func verifyInstalledOptionalDriverAgentRevision")
	if start < 0 {
		t.Fatal("methods_driver.go missing verifyInstalledOptionalDriverAgentRevision")
	}
	rest := source[start:]
	end := strings.Index(rest[len("func verifyInstalledOptionalDriverAgentRevision"):], "\nfunc ")
	if end < 0 {
		t.Fatal("verifyInstalledOptionalDriverAgentRevision function boundary not found")
	}
	functionSource := rest[:len("func verifyInstalledOptionalDriverAgentRevision")+end]

	for _, rawWrapper := range []string{
		`驱动代理版本元数据不可用，请安装当前版本对应的 driver-agent`,
		`驱动代理 revision 不匹配（已安装：`,
		`actualLabel = "空"`,
	} {
		if strings.Contains(functionSource, rawWrapper) {
			t.Fatalf("verifyInstalledOptionalDriverAgentRevision still contains raw wrapper %s", rawWrapper)
		}
	}
	for _, key := range []string{
		"driver_manager.backend.error.agent_metadata_unavailable",
		"driver_manager.backend.error.agent_revision_mismatch",
		"driver_manager.backend.error.agent_revision_mismatch_empty_actual",
	} {
		if !strings.Contains(functionSource, key) {
			t.Fatalf("verifyInstalledOptionalDriverAgentRevision does not reference i18n key %q", key)
		}
	}
}

func TestBuildOptionalDriverInstallPlanMessagePrefersDirectThenBundle(t *testing.T) {
	message := buildOptionalDriverInstallPlanMessage(zhCNDriverProgressText(t), "SQL Server", "1.9.6", false, false, false, false, 1, 2)
	// 安装计划文案已精简为统一短句，不再区分直链/总包路径细节
	if !strings.Contains(message, "准备安装 SQL Server 驱动代理（版本 1.9.6）") {
		t.Fatalf("expected localized install plan message, got %q", message)
	}
	if strings.Contains(message, "driver_manager.progress.plan") {
		t.Fatalf("expected localized plan message instead of raw key, got %q", message)
	}
}

func TestBuildOptionalDriverFallbackProgressMessageReportsBundleFallback(t *testing.T) {
	message := buildOptionalDriverFallbackProgressMessage(zhCNDriverProgressText(t), "SQL Server", 1, 2, false)
	if !strings.Contains(message, "预编译直链不可用") {
		t.Fatalf("expected direct miss hint, got %q", message)
	}
	if !strings.Contains(message, "尝试驱动总包") {
		t.Fatalf("expected bundle fallback hint, got %q", message)
	}
}

func TestOptionalDriverProgressNewCatalogKeysResolve(t *testing.T) {
	text := zhCNDriverProgressText(t)
	plan := buildOptionalDriverInstallPlanMessage(text, "SQL Server", "1.9.6", false, false, true, false, 1, 2)
	if strings.Contains(plan, "driver_manager.progress.plan.require_source_first") || !strings.Contains(plan, "准备安装 SQL Server 驱动代理（版本 1.9.6）") {
		t.Fatalf("expected localized require-source-first plan message, got %q", plan)
	}

	prebuilt := text("driver_manager.progress.download_prebuilt_package", map[string]any{"name": "SQL Server"})
	if !strings.Contains(prebuilt, "正在下载预编译包") {
		t.Fatalf("expected localized prebuilt package progress, got %q", prebuilt)
	}

	waitBundle := text("driver_manager.progress.wait_bundle", map[string]any{"name": "SQL Server"})
	if !strings.Contains(waitBundle, "等待 SQL Server 驱动总包下载完成") {
		t.Fatalf("expected localized wait bundle progress, got %q", waitBundle)
	}
}

func zhCNDriverProgressText(t *testing.T) func(string, map[string]any) string {
	t.Helper()
	localizer := newAppLocalizer()
	if localizer == nil {
		t.Fatal("expected app localizer")
	}
	localizer.SetLanguage(i18n.LanguageZhCN)
	return localizer.T
}

func TestOptionalDriverAgentProgressMessagesUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	rawMessages := []string{
		`"准备安装 %s 驱动代理`,
		`"预编译直链未命中`,
		`"直链不可用`,
		`"发布资产未命中`,
		`"优先使用本地源码构建 %s 驱动代理"`,
		`"下载预编译 %s 驱动代理"`,
		`"从驱动总包提取 %s 代理"`,
		`"未命中预编译包，尝试开发态本地构建"`,
		`"下载 %s 驱动总包"`,
		`"等待 %s 驱动总包下载完成"`,
		`"解压 %s 驱动代理"`,
	}
	for _, rawMessage := range rawMessages {
		if strings.Contains(source, rawMessage) {
			t.Fatalf("methods_driver.go still contains raw optional driver progress message %s", rawMessage)
		}
	}

	keys := []string{
		"driver_manager.progress.plan.direct_then_bundle",
		"driver_manager.progress.plan.require_source_first",
		"driver_manager.progress.fallback.direct_to_bundle",
		"driver_manager.progress.source_build_preferred",
		"driver_manager.progress.download_prebuilt_agent",
		"driver_manager.progress.download_prebuilt_package",
		"driver_manager.progress.extract_agent_from_bundle",
		"driver_manager.progress.dev_build_fallback",
		"driver_manager.progress.download_bundle",
		"driver_manager.progress.wait_bundle",
		"driver_manager.progress.unzip_agent",
	}
	for _, key := range keys {
		if !strings.Contains(source, key) {
			t.Fatalf("methods_driver.go does not reference optional driver progress i18n key %q", key)
		}
	}
}

func TestDownloadDriverPackageRejectsUnsupportedMongoVersion(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	result := app.DownloadDriverPackage("mongodb", "1.16.1", "builtin://activate/mongodb?channel=history&version=1.16.1", t.TempDir())
	if result.Success {
		t.Fatal("expected unsupported MongoDB 1.16.1 install to be rejected")
	}
	if !strings.Contains(result.Message, "only 1.17.x and 2.x are supported") {
		t.Fatalf("expected English support-range error, got %q", result.Message)
	}
	if strings.Contains(result.Message, "仅支持 1.17.x 和 2.x") {
		t.Fatalf("expected localized wrapper instead of fixed Chinese, got %q", result.Message)
	}
}

func TestDownloadDriverPackageUsesCurrentLanguageForBuiltinWrapper(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	result := app.DownloadDriverPackage("mysql", "", "", t.TempDir())
	if result.Success {
		t.Fatal("expected built-in driver download to be rejected")
	}
	if !strings.Contains(result.Message, "Built-in drivers do not need extension package downloads") {
		t.Fatalf("expected English built-in wrapper, got %q", result.Message)
	}
	if strings.Contains(result.Message, "内置驱动无需下载扩展包") {
		t.Fatalf("expected localized wrapper instead of fixed Chinese, got %q", result.Message)
	}
}

func TestBuildDriverVersionDisplayLabelUsesLocalizedText(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	label := buildDriverVersionDisplayLabel(driverVersionOptionItem{
		Source:      "latest",
		Recommended: true,
	}, app.appText)
	if got, want := label, "Unlabeled version (latest) (recommended)"; got != want {
		t.Fatalf("expected localized English display label %q, got %q", want, got)
	}
	if strings.Contains(label, "未标注版本") || strings.Contains(label, "（最新）") || strings.Contains(label, "（推荐）") {
		t.Fatalf("expected localized display label instead of fixed Chinese, got %q", label)
	}

	rawVersionLabel := buildDriverVersionDisplayLabel(driverVersionOptionItem{
		Version: "v1.2.3",
		Source:  "latest",
	}, app.appText)
	if got, want := rawVersionLabel, "v1.2.3 (latest)"; got != want {
		t.Fatalf("expected raw version with localized suffix %q, got %q", want, got)
	}
}

func TestResolveDriverPackageSizeTextUsesLocalizedStatusText(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	builtInText := resolveDriverPackageSizeText(driverDefinition{BuiltIn: true}, installedDriverPackage{}, false, nil, app.appText)
	if got, want := builtInText, "Built-in"; got != want {
		t.Fatalf("expected localized built-in package size text %q, got %q", want, got)
	}
	if strings.Contains(builtInText, "内置") {
		t.Fatalf("expected localized built-in package size text instead of fixed Chinese, got %q", builtInText)
	}

	pendingText := resolveDriverPackageSizeText(driverDefinition{Type: "jdbc-only-test"}, installedDriverPackage{}, false, map[string]int64{}, app.appText)
	if got, want := pendingText, "Pending release"; got != want {
		t.Fatalf("expected localized pending-release package size text %q, got %q", want, got)
	}
	if strings.Contains(pendingText, "待发布") {
		t.Fatalf("expected localized pending-release package size text instead of fixed Chinese, got %q", pendingText)
	}

	sizeText := resolveDriverPackageSizeText(driverDefinition{Type: "mariadb"}, installedDriverPackage{}, false, map[string]int64{
		"mariadb": 12 * 1024 * 1024,
	}, app.appText)
	if got, want := sizeText, "12.00 MB"; got != want {
		t.Fatalf("expected raw size text %q to stay unchanged, got %q", want, got)
	}
}

func TestDriverVersionDisplayLabelsAndPackageSizeStatusesUseI18nKeys(t *testing.T) {
	source := methodsDriverSource(t)

	if !strings.Contains(source, "resolveDriverVersionOptions(definition, repositoryURL, a.appText)") {
		t.Fatal("expected GetDriverVersionList to pass app localizer into resolveDriverVersionOptions")
	}
	if !strings.Contains(source, "buildDriverVersionDisplayLabel(option, text)") {
		t.Fatal("expected resolveDriverVersionOptions to pass localizer into buildDriverVersionDisplayLabel")
	}
	if !strings.Contains(source, "resolveDriverPackageSizeText(definition, pkg, packageMetaExists, packageSizeBytesMap, a.appText)") {
		t.Fatal("expected GetDriverStatusList to pass app localizer into resolveDriverPackageSizeText")
	}

	buildStart := strings.Index(source, "func buildDriverVersionDisplayLabel")
	if buildStart < 0 {
		t.Fatal("methods_driver.go missing buildDriverVersionDisplayLabel")
	}
	buildRest := source[buildStart:]
	buildEnd := strings.Index(buildRest, "\nfunc resolveRecentDriverVersionOptions")
	if buildEnd < 0 {
		t.Fatal("buildDriverVersionDisplayLabel function boundary not found")
	}
	buildSource := buildRest[:buildEnd]

	for _, rawText := range []string{`"未标注版本"`, `"（最新）"`, `"（推荐）"`} {
		if strings.Contains(buildSource, rawText) {
			t.Fatalf("buildDriverVersionDisplayLabel still contains raw display text %s", rawText)
		}
	}
	for _, key := range []string{
		"driver_manager.version.unlabeled",
		"driver_manager.version.latest_suffix",
		"driver_manager.version.recommended_suffix",
	} {
		if !strings.Contains(buildSource, key) {
			t.Fatalf("buildDriverVersionDisplayLabel does not reference i18n key %q", key)
		}
	}

	sizeStart := strings.Index(source, "func resolveDriverPackageSizeText")
	if sizeStart < 0 {
		t.Fatal("methods_driver.go missing resolveDriverPackageSizeText")
	}
	sizeRest := source[sizeStart:]
	sizeEnd := strings.Index(sizeRest, "\nfunc readInstalledPackageSizeBytes")
	if sizeEnd < 0 {
		t.Fatal("resolveDriverPackageSizeText function boundary not found")
	}
	sizeSource := sizeRest[:sizeEnd]

	for _, rawText := range []string{`"内置"`, `"待发布"`} {
		if strings.Contains(sizeSource, rawText) {
			t.Fatalf("resolveDriverPackageSizeText still contains raw status text %s", rawText)
		}
	}
	for _, key := range []string{
		"driver_manager.package_size.built_in",
		"driver_manager.package_size.pending_release",
	} {
		if !strings.Contains(sizeSource, key) {
			t.Fatalf("resolveDriverPackageSizeText does not reference i18n key %q", key)
		}
	}
}

func TestLocalizedDriverNeedsUpdateTextsUseCurrentLanguage(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	reason, message := app.localizedDriverNeedsUpdateTexts("rev-old", "rev-new", 3)
	if !strings.Contains(reason, "The driver component has an update.") {
		t.Fatalf("expected English update reason, got %q", reason)
	}
	if strings.Contains(reason, "rev-old") || strings.Contains(reason, "rev-new") || strings.Contains(reason, "revision") {
		t.Fatalf("expected reason without revision detail, got %q", reason)
	}
	if !strings.Contains(message, "Affects 3 saved connections") {
		t.Fatalf("expected affected-connections detail, got %q", message)
	}
	if strings.Contains(reason, "需要重装") || strings.Contains(message, "已保存连接") {
		t.Fatalf("expected localized update texts instead of fixed Chinese, got reason=%q message=%q", reason, message)
	}
}

func TestLocalizeDriverSelectionErrorUsesCurrentLanguageForSlimBuild(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	definition := driverDefinition{Type: "clickhouse", Name: "ClickHouse"}
	err := app.localizeDriverSelectionError(definition, &driverBuildUnavailableError{Name: "ClickHouse"})
	if err == nil {
		t.Fatal("expected localized slim-build error")
	}
	if !strings.Contains(err.Error(), "ClickHouse is not included in the current slim build") {
		t.Fatalf("expected English slim-build wrapper, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "当前发行包为精简构建") {
		t.Fatalf("expected localized wrapper instead of fixed Chinese, got %q", err.Error())
	}
}

func TestOptionalDriverBundleCacheHelpersDoNotContainLegacyChineseWrappers(t *testing.T) {
	source := methodsDriverSource(t)

	functionNames := []string{
		"downloadOptionalDriverBundleToCache",
		"acquireOptionalDriverBundlePath",
	}
	functionSource := ""
	for _, name := range functionNames {
		start := strings.Index(source, "func "+name)
		if start < 0 {
			t.Fatalf("methods_driver.go missing %s", name)
		}
		rest := source[start+len("func "+name):]
		end := strings.Index(rest, "\nfunc ")
		if end < 0 {
			t.Fatalf("%s function boundary not found", name)
		}
		functionSource += rest[:end]
	}

	for _, rawWrapper := range []string{
		`fmt.Errorf("打开驱动总包失败：%w"`,
		`fmt.Errorf("关闭驱动总包失败：%w"`,
		`fmt.Errorf("驱动总包缓存文件不可用")`,
	} {
		if strings.Contains(functionSource, rawWrapper) {
			t.Fatalf("optional driver bundle cache helper still contains legacy raw wrapper %s", rawWrapper)
		}
	}
}
