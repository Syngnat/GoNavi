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
		"methods_driver_assets.go",
	}
	parts := make([]string, 0, len(paths))
	for _, path := range paths {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		parts = append(parts, string(content))
	}
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
