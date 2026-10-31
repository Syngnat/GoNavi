package plugin

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// proxyEntryValue counts case-insensitive matches so a single assertion covers
// every casing a plugin backend may see for one proxy variable.
func proxyEntryValue(env []string, name string) (string, int) {
	value, count := "", 0
	for _, entry := range env {
		key, content, ok := strings.Cut(entry, "=")
		if !ok || !strings.EqualFold(key, name) {
			continue
		}
		value, count = content, count+1
	}
	return value, count
}

// proxyEnvironmentEntries renders injected entries the way the embedding host
// supplies them.
func proxyEnvironmentEntries(values ...string) func() []string {
	return func() []string { return values }
}

// A plugin process must see the same environment proxy the host itself would use.
func TestPluginProcessEnvironmentInheritsHostProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://environment-proxy:8080")
	t.Setenv("NO_PROXY", "internal.example")
	t.Setenv("GONAVI_RPC_TOKEN", "application-secret")
	env := processEnvironment(`C:\plugins\demo`, `C:\data\demo`, nil)
	if value, count := proxyEntryValue(env, "HTTPS_PROXY"); count != 1 || value != "http://environment-proxy:8080" {
		t.Fatalf("plugin process did not inherit the environment proxy: count=%d value=%q env=%v", count, value, env)
	}
	if value, count := proxyEntryValue(env, "NO_PROXY"); count != 1 || value != "internal.example" {
		t.Fatalf("plugin process did not inherit the environment bypass list: count=%d value=%q", count, value)
	}
	if _, count := proxyEntryValue(env, "GONAVI_RPC_TOKEN"); count != 0 {
		t.Fatalf("plugin process received an application credential: %v", env)
	}
	if value, _ := proxyEntryValue(env, "GONAVI_PLUGIN_PACKAGE"); value != `C:\plugins\demo` {
		t.Fatalf("plugin package root missing: %q", value)
	}
	if value, _ := proxyEntryValue(env, "GONAVI_PLUGIN_DATA"); value != `C:\data\demo` {
		t.Fatalf("plugin data root missing: %q", value)
	}
	if value, _ := proxyEntryValue(env, "PYTHONNOUSERSITE"); value != "1" {
		t.Fatalf("PYTHONNOUSERSITE missing: %q", value)
	}
}

// An injected proxy wins over the host environment and collapses to one entry per
// variable, which is exactly what a POSIX getenv call resolves to.
func TestPluginProcessEnvironmentPrefersInjectedProxy(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://environment-proxy:8080")
	t.Setenv("http_proxy", "http://environment-lowercase:8080")
	injected := []string{
		"HTTP_PROXY=http://configured:7890",
		"HTTPS_PROXY=http://configured:7890",
		"ALL_PROXY=socks5://configured:1080",
		"NO_PROXY=localhost,127.0.0.1,::1",
	}
	enabled := processEnvironment(`C:\plugins\demo`, `C:\data\demo`, proxyEnvironmentEntries(injected...))
	disabled := processEnvironment(`C:\plugins\demo`, `C:\data\demo`, nil)

	if value, count := proxyEntryValue(enabled, "HTTP_PROXY"); count != 1 || value != "http://configured:7890" {
		t.Fatalf("configured proxy did not replace the environment value: count=%d value=%q env=%v", count, value, enabled)
	}
	if value, count := proxyEntryValue(enabled, "ALL_PROXY"); count != 1 || value != "socks5://configured:1080" {
		t.Fatalf("configured all-proxy missing: count=%d value=%q", count, value)
	}
	if value, count := proxyEntryValue(enabled, "NO_PROXY"); count != 1 || value != "localhost,127.0.0.1,::1" {
		t.Fatalf("loopback bypass missing: count=%d value=%q", count, value)
	}
	// Without an injected proxy the child keeps the environment proxy: that is the
	// disabled global proxy state, and it must differ from the enabled one.
	if value, count := proxyEntryValue(disabled, "HTTP_PROXY"); count != 1 || !strings.HasPrefix(value, "http://environment-") {
		t.Fatalf("disabled proxy state did not keep the environment proxy: count=%d value=%q", count, value)
	}
	if _, count := proxyEntryValue(disabled, "ALL_PROXY"); count != 0 {
		t.Fatalf("disabled proxy state must not inject a configured proxy: %v", disabled)
	}
}

// Injected entries pass the same allow list, so a callback cannot widen what a
// plugin process reads.
func TestPluginProcessEnvironmentRejectsNonProxyEntries(t *testing.T) {
	env := processEnvironment(`C:\plugins\demo`, `C:\data\demo`, proxyEnvironmentEntries(
		"PATH=C:\\attacker",
		"GONAVI_RPC_TOKEN=leaked",
		"AWS_SECRET_ACCESS_KEY=leaked",
		"HTTP_PROXY=http://configured:7890",
	))
	if value, _ := proxyEntryValue(env, "PATH"); value != os.Getenv("PATH") {
		t.Fatalf("injected entry replaced PATH: %q", value)
	}
	for _, name := range []string{"GONAVI_RPC_TOKEN", "AWS_SECRET_ACCESS_KEY"} {
		if _, count := proxyEntryValue(env, name); count != 0 {
			t.Fatalf("injected entry leaked %s: %v", name, env)
		}
	}
	if value, count := proxyEntryValue(env, "HTTP_PROXY"); count != 1 || value != "http://configured:7890" {
		t.Fatalf("proxy entry was dropped: count=%d value=%q", count, value)
	}
}

// TestPluginProcessEnvironmentChild dumps its own environment for the parent test.
// Like the other process fixtures it stays inert without its helper flag.
func TestPluginProcessEnvironmentChild(t *testing.T) {
	requested := false
	for _, arg := range os.Args {
		if arg == "--dump-plugin-environment" {
			requested = true
		}
	}
	if !requested {
		return
	}
	content, err := json.Marshal(os.Environ())
	if err != nil {
		os.Exit(71)
	}
	if _, err = os.Stdout.Write(append(content, '\n')); err != nil {
		os.Exit(72)
	}
}

// The real child process must observe the injected proxy instead of the host
// environment value.
func TestPluginProcessEnvironmentAppliesToChildProcess(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://environment-proxy:8080")
	t.Setenv("GONAVI_RPC_TOKEN", "application-secret")
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("locate test executable: %v", err)
	}
	command := exec.Command(executable, "-test.run=^TestPluginProcessEnvironmentChild$", "--", "--dump-plugin-environment")
	command.Env = processEnvironment(`C:\plugins\demo`, `C:\data\demo`, proxyEnvironmentEntries(
		"HTTP_PROXY=http://navi:s3cret@configured:7890",
		"HTTPS_PROXY=http://navi:s3cret@configured:7890",
		"ALL_PROXY=socks5://configured:1080",
		"NO_PROXY=localhost,127.0.0.1,::1",
	))
	output, err := command.Output()
	if err != nil {
		t.Fatalf("dump child environment: %v", err)
	}
	env := decodeEnvironmentDump(t, output)
	if value, count := proxyEntryValue(env, "HTTP_PROXY"); count != 1 || value != "http://navi:s3cret@configured:7890" {
		t.Fatalf("child process proxy mismatch: count=%d value=%q", count, value)
	}
	if value, count := proxyEntryValue(env, "NO_PROXY"); count != 1 || value != "localhost,127.0.0.1,::1" {
		t.Fatalf("child process bypass list mismatch: count=%d value=%q", count, value)
	}
	if _, count := proxyEntryValue(env, "GONAVI_RPC_TOKEN"); count != 0 {
		t.Fatalf("child process received an application credential: %v", env)
	}
}

func decodeEnvironmentDump(t *testing.T, output []byte) []string {
	t.Helper()
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "[") {
			continue
		}
		var entries []string
		if err := json.Unmarshal([]byte(line), &entries); err == nil && len(entries) > 0 {
			return entries
		}
	}
	t.Fatalf("child process did not dump its environment: %q", string(output))
	return nil
}
