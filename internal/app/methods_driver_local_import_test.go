package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateLocalDriverPackagePathRejectsJdbcJar(t *testing.T) {
	err := validateLocalDriverPackagePath(filepath.Join("tmp", "kingbase8.JAR"))
	if err == nil {
		t.Fatal("expected JDBC jar path to be rejected")
	}
	if !strings.Contains(err.Error(), "JDBC Jar") {
		t.Fatalf("expected JDBC jar hint, got %q", err.Error())
	}
	if err := validateLocalDriverPackagePath(filepath.Join("tmp", "kingbase-driver-agent.zip")); err != nil {
		t.Fatalf("expected zip package to stay supported, got %v", err)
	}
}

func TestInstallLocalDriverPackageRejectsJdbcJarBeforeBuildChecks(t *testing.T) {
	jarPath := filepath.Join(t.TempDir(), "kingbase8.jar")
	if err := os.WriteFile(jarPath, []byte("fake-jar"), 0o644); err != nil {
		t.Fatalf("write temp jar: %v", err)
	}

	app := &App{}
	result := app.InstallLocalDriverPackage("kingbase", jarPath, t.TempDir(), "")
	if result.Success {
		t.Fatal("expected local jar import to fail")
	}
	if !strings.Contains(result.Message, "JDBC Jar") {
		t.Fatalf("expected JDBC jar guidance, got %q", result.Message)
	}
}

func TestInstallLocalDriverPackageUsesCurrentLanguageForJdbcJarWrapper(t *testing.T) {
	jarPath := filepath.Join(t.TempDir(), "kingbase8.jar")
	if err := os.WriteFile(jarPath, []byte("fake-jar"), 0o644); err != nil {
		t.Fatalf("write temp jar: %v", err)
	}

	app := NewApp()
	app.SetLanguage("en-US")

	result := app.InstallLocalDriverPackage("kingbase", jarPath, t.TempDir(), "")
	if result.Success {
		t.Fatal("expected local jar import to fail")
	}
	if !strings.Contains(result.Message, "Importing JDBC Jar files directly is not supported.") {
		t.Fatalf("expected English JDBC jar guidance, got %q", result.Message)
	}
	if strings.Contains(result.Message, "当前驱动管理不支持直接导入 JDBC Jar") {
		t.Fatalf("expected localized wrapper instead of fixed Chinese, got %q", result.Message)
	}
}

func TestInstallLocalDriverPackageUsesCurrentLanguageForEmptyLocalPath(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	result := app.InstallLocalDriverPackage("kingbase", "", t.TempDir(), "")
	if result.Success {
		t.Fatal("expected empty local package path to fail")
	}
	if !strings.Contains(result.Message, "Local driver package path is empty") {
		t.Fatalf("expected English local package path message, got %q", result.Message)
	}
	if strings.Contains(result.Message, "本地驱动包路径为空") {
		t.Fatalf("expected localized wrapper instead of fixed Chinese, got %q", result.Message)
	}
}

func TestLocalDriverImportErrorsUseI18nWrappers(t *testing.T) {
	source := methodsDriverSource(t)

	functionNames := []string{
		"(*App) InstallLocalDriverPackage",
		"installOptionalDriverAgentFromLocalPath",
		"resolveLocalDriverAgentFromLocalDirectory",
		"installOptionalDriverAgentFromLocalArchive",
		"writeInstalledDriverPackage",
		"hashFileSHA256",
		"extractZipFileToPath",
		"copyOptionalDriverSupportFilesFromDirectory",
		"extractOptionalDriverSupportFilesFromArchive",
	}
	functionSource := ""
	for _, name := range functionNames {
		prefix := "func " + name
		if strings.HasPrefix(name, "(*App) ") {
			prefix = "func (a *App) " + strings.TrimPrefix(name, "(*App) ")
		}
		start := strings.Index(source, prefix)
		if start < 0 {
			t.Fatalf("methods_driver.go missing %s", name)
		}
		rest := source[start+len(prefix):]
		end := strings.Index(rest, "\nfunc ")
		if end < 0 {
			t.Fatalf("%s function boundary not found", name)
		}
		functionSource += rest[:end]
	}

	rawWrappers := []string{
		`fmt.Errorf("本地驱动包路径为空")`,
		`fmt.Errorf("读取本地驱动包失败：%w"`,
		`fmt.Errorf("创建 %s 驱动目录失败：%w"`,
		`fmt.Errorf("导入本地驱动代理失败：%w"`,
		`fmt.Errorf("导入本地驱动代理运行时依赖失败：%w"`,
		`fmt.Errorf("本地驱动目录路径为空")`,
		`fmt.Errorf("读取本地驱动目录失败：%w"`,
		`fmt.Errorf("本地驱动目录路径不是目录：%s"`,
		`fmt.Errorf("本地驱动目录条目过多`,
		`fmt.Errorf("扫描本地驱动目录失败：%w"`,
		`"目录中未找到 %s 代理文件`,
		`fmt.Errorf("打开本地驱动包失败：%w"`,
		`fmt.Errorf("本地驱动包内未找到 %s 代理文件`,
		`fmt.Errorf("读取本地驱动包条目失败：%w"`,
		`fmt.Errorf("创建驱动代理临时文件失败：%w"`,
		`fmt.Errorf("写入驱动代理失败：%w"`,
		`fmt.Errorf("落盘驱动代理失败：%w"`,
		`fmt.Errorf("关闭驱动代理文件失败：%w"`,
		`fmt.Errorf("设置驱动代理权限失败：%w"`,
		`fmt.Errorf("替换驱动代理失败：%w"`,
		`fmt.Errorf("计算 %s 驱动代理摘要失败：%w"`,
		`fmt.Errorf("创建驱动目录失败：%w"`,
		`fmt.Errorf("写入驱动元数据失败：%w"`,
		`fmt.Errorf("文件路径为空")`,
		`fmt.Errorf("zip 条目为空")`,
		`fmt.Errorf("运行时依赖目录为空")`,
		`fmt.Errorf("复制 %s 失败：%w"`,
		`fmt.Errorf("运行时依赖目标目录为空")`,
		`fmt.Errorf("驱动包缺少运行时依赖：%s"`,
		`fmt.Errorf("解压运行时依赖 %s 失败：%w"`,
	}
	for _, rawWrapper := range rawWrappers {
		if strings.Contains(functionSource, rawWrapper) {
			t.Fatalf("local driver import flow still contains raw error wrapper %s", rawWrapper)
		}
	}

	requiredKeys := []string{
		"driver_manager.backend.error.local_package_path_empty",
		"driver_manager.backend.error.read_local_package_failed",
		"driver_manager.backend.error.local_directory_path_empty",
		"driver_manager.backend.error.read_local_directory_failed",
		"driver_manager.backend.error.local_directory_not_directory",
		"driver_manager.backend.error.local_directory_scan_limit",
		"driver_manager.backend.error.scan_local_directory_failed",
		"driver_manager.backend.error.local_directory_entry_missing",
		"driver_manager.backend.error.open_local_package_failed",
		"driver_manager.backend.error.local_package_entry_missing",
		"driver_manager.backend.error.read_local_package_entry_failed",
		"driver_manager.backend.error.create_agent_temp_file_failed",
		"driver_manager.backend.error.write_agent_failed",
		"driver_manager.backend.error.sync_agent_failed",
		"driver_manager.backend.error.close_agent_file_failed",
		"driver_manager.backend.error.chmod_agent_failed",
		"driver_manager.backend.error.replace_agent_failed",
		"driver_manager.backend.error.named_agent_hash_failed",
		"driver_manager.backend.error.create_directory_failed",
		"driver_manager.backend.error.metadata_payload_encode_failed",
		"driver_manager.backend.error.metadata_file_write_failed",
		"driver_manager.backend.error.file_path_empty",
		"driver_manager.backend.error.zip_entry_empty",
		"driver_manager.backend.error.runtime_dependency_directory_empty",
		"driver_manager.backend.error.copy_runtime_dependency_entry_failed",
		"driver_manager.backend.error.runtime_dependency_target_directory_empty",
		"driver_manager.backend.error.runtime_dependency_entry_missing",
		"driver_manager.backend.error.extract_runtime_dependency_failed",
	}
	for _, key := range requiredKeys {
		if !strings.Contains(functionSource, key) {
			t.Fatalf("local driver import flow does not reference i18n key %q", key)
		}
	}
	if strings.Contains(functionSource, "normalizeErrorMessage(installErr)") {
		t.Fatal("local driver import error progress should use the current App language instead of normalizeErrorMessage")
	}
	if strings.Contains(functionSource, "normalizeErrorMessage(err)") {
		t.Fatal("local driver metadata write progress should use the current App language instead of normalizeErrorMessage")
	}
	if !strings.Contains(functionSource, "localizedDriverBackendErrorMessage(a, installErr)") {
		t.Fatal("local driver import error progress does not localize installErr with the current App language")
	}
	if !strings.Contains(functionSource, "localizedDriverBackendErrorMessage(a, err)") {
		t.Fatal("local driver metadata write progress does not localize err with the current App language")
	}
}

func TestDriverOperationFailureDetailUsesCurrentLanguageForLogHint(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	text := app.driverOperationErrorMessage(errors.New("boom"), "test driver error")
	if !strings.Contains(text, "boom") {
		t.Fatalf("expected raw detail in localized message, got %q", text)
	}
	if !strings.Contains(text, "detail log:") {
		t.Fatalf("expected English log hint, got %q", text)
	}
	if strings.Contains(text, "详细日志") {
		t.Fatalf("expected no Chinese log hint in en-US message, got %q", text)
	}
}

func TestDriverOperationFailureDetailUsesCurrentLanguageForRuntimeDependencyWrapper(t *testing.T) {
	driverType := "duckdb"
	if len(optionalDriverSupportFileNames(driverType)) == 0 {
		t.Skip("current platform does not require optional driver runtime dependencies")
	}

	app := NewApp()
	app.SetLanguage("en-US")

	cause := copyOptionalDriverSupportFilesFromDirectory(driverType, "", t.TempDir())
	if cause == nil {
		t.Fatal("expected runtime dependency copy helper to fail")
	}

	text := app.driverOperationErrorMessage(
		newLocalizedDriverBackendError("driver_manager.backend.error.import_local_agent_runtime_failed", nil, cause),
		"test local runtime dependency wrapper",
	)
	if !strings.Contains(text, "Failed to import local driver agent runtime dependencies:") {
		t.Fatalf("expected English runtime dependency wrapper, got %q", text)
	}
	if !strings.Contains(text, "Runtime dependency directory is empty") {
		t.Fatalf("expected English runtime dependency detail, got %q", text)
	}
	if strings.Contains(text, "运行时依赖目录为空") {
		t.Fatalf("expected no Chinese runtime dependency detail in en-US message, got %q", text)
	}
}

func TestInstallLocalDriverPackageProgressUsesLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)
	start := strings.Index(source, "func (a *App) InstallLocalDriverPackage")
	if start < 0 {
		t.Fatal("methods_driver.go missing InstallLocalDriverPackage")
	}
	rest := source[start:]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		t.Fatal("InstallLocalDriverPackage function boundary not found")
	}
	functionSource := rest[:end]

	rawMessages := []string{
		`"开始安装本地驱动包"`,
		`"写入驱动元数据"`,
		`"本地驱动包导入完成"`,
	}
	for _, rawMessage := range rawMessages {
		if strings.Contains(functionSource, rawMessage) {
			t.Fatalf("InstallLocalDriverPackage still contains raw progress message %s", rawMessage)
		}
	}

	keys := []string{
		"driver_manager.progress.local_package_start",
		"driver_manager.progress.metadata_write",
		"driver_manager.progress.local_package_done",
	}
	for _, key := range keys {
		if !strings.Contains(functionSource, key) {
			t.Fatalf("InstallLocalDriverPackage does not reference progress i18n key %q", key)
		}
	}
}
