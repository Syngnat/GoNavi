package app

import (
	"os"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func methodsDriverSource(t *testing.T) string {
	t.Helper()

	paths := []string{
		"methods_driver.go",
		// methods_driver.go 已按主题拆成多个同包文件，源码扫描型测试需一并聚合。
		"methods_driver_types.go",
		"methods_driver_manifest_defaults.go",
		"methods_driver_errors_i18n.go",
		"methods_driver_selection.go",
		"methods_driver_status.go",
		"methods_driver_install_api.go",
		"methods_driver_network_probe.go",
		"methods_driver_definitions.go",
		"methods_driver_versions.go",
		"methods_driver_version_meta.go",
		"methods_driver_releases.go",
		"methods_driver_manifest.go",
		"methods_driver_installed.go",
		"methods_driver_install_local.go",
		"methods_driver_agent_ensure.go",
		"methods_driver_agent_download.go",
		"methods_driver_agent_build.go",
		"methods_driver_build_env.go",
		"methods_driver_optional_update.go",
		"methods_driver_assets.go",
		"methods_driver_asset_urls.go",
		"methods_driver_asset_bundle.go",
		"methods_driver_asset_candidates.go",
		"methods_driver_asset_activate.go",
		"methods_driver_asset_sizes.go",
		"methods_driver_asset_releases.go",
		"methods_driver_download.go",
		// zip 解压原语已抽到独立文件，源码扫描型测试需一并聚合。
		"methods_driver_zip.go",
	}
	parts := make([]string, 0, len(paths))
	for _, path := range paths {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		parts = append(parts, string(content))
	}
	// 末尾哨兵：多处调用方按 "\nfunc " 切分函数体，若目标函数恰好是最后一个，
	// 切分会因找不到边界而失败。补一个空函数给它们一个可停靠的边界。
	parts = append(parts, "\nfunc methodsDriverSourceSentinel() {}")
	return strings.Join(parts, "\n\n")
}

func installFakeOptionalDriverRuntime(t *testing.T) {
	t.Helper()

	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	verifyDriverAgentRevisionFunc = func(connection.ConnectionConfig) error { return nil }
	t.Cleanup(func() {
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})
}

func disableGlobalProxyForTest(t *testing.T) {
	t.Helper()

	proxySnapshot := currentGlobalProxyConfig()
	if _, err := setGlobalProxyConfig(false, proxySnapshot.Proxy); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy)
	})
}
