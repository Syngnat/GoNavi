package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/shared/i18n"
)

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
