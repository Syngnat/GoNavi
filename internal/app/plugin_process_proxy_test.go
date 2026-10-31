package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// pluginProxyEntryValue 不区分大小写地读出代理变量，避免断言依赖平台的变量写法。
func pluginProxyEntryValue(entries []string, name string) (string, int) {
	value, count := "", 0
	for _, entry := range entries {
		key, content, ok := strings.Cut(entry, "=")
		if !ok || !strings.EqualFold(key, name) {
			continue
		}
		value, count = content, count+1
	}
	return value, count
}

func restoreGlobalProxy(t *testing.T, snapshot globalProxySnapshot) {
	t.Helper()
	if _, err := setGlobalProxyConfig(snapshot.Enabled, snapshot.Proxy); err != nil {
		t.Fatalf("restore global proxy: %v", err)
	}
}

// enablePluginTestProxy 打开一个可用的全局代理，供各用例校验插件进程代理环境。
func enablePluginTestProxy(t *testing.T) {
	t.Helper()
	if _, err := setGlobalProxyConfig(true, connection.ProxyConfig{Type: "http", Host: "127.0.0.1", Port: 7890, User: "navi", Password: "s3cret"}); err != nil {
		t.Fatalf("enable global proxy: %v", err)
	}
}

// clearHostNoProxy 让用例不受宿主既有 NO_PROXY 影响：先清小写再写目标值，
// 避免在大小写不敏感的系统上互相覆盖。
func clearHostNoProxy(t *testing.T, value string) {
	t.Helper()
	t.Setenv("no_proxy", "")
	t.Setenv("NO_PROXY", value)
}

func noProxyValue(t *testing.T, entries []string) string {
	t.Helper()
	value, count := pluginProxyEntryValue(entries, "NO_PROXY")
	if count != 1 {
		t.Fatalf("NO_PROXY 应恰好注入一条：count=%d entries=%v", count, entries)
	}
	return value
}

// 插件进程的代理环境必须跟着「设置 - 全局代理」开关走：开启时套用配置代理，
// 关闭时不下发任何宿主代理变量。
func TestPluginProxyEnvironmentFollowsGlobalProxySetting(t *testing.T) {
	clearHostNoProxy(t, "")
	snapshot := currentGlobalProxyConfig()
	defer restoreGlobalProxy(t, snapshot)

	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("disable global proxy: %v", err)
	}
	if entries := pluginProxyEnvironment(); len(entries) != 0 {
		t.Fatalf("全局代理未启用时不得注入宿主代理变量：%v", entries)
	}

	enablePluginTestProxy(t)
	entries := pluginProxyEnvironment()
	if len(entries) != 4 {
		t.Fatalf("启用全局代理时应注入 4 个代理变量：%v", entries)
	}
	want := "http://navi:s3cret@127.0.0.1:7890"
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"} {
		if value, count := pluginProxyEntryValue(entries, name); count != 1 || value != want {
			t.Fatalf("%s 未按全局代理配置注入：count=%d value=%q", name, count, value)
		}
	}
	if got := noProxyValue(t, entries); got != "localhost,127.0.0.1,::1" {
		t.Fatalf("NO_PROXY 未指向本机回环：%q", got)
	}
}

// socks 代理走 ALL_PROXY 语义，同时保留 HTTP_PROXY/HTTPS_PROXY 以便只认其一的插件。
func TestPluginProxyEnvironmentKeepsSocksProxyInAllProxy(t *testing.T) {
	clearHostNoProxy(t, "")
	snapshot := currentGlobalProxyConfig()
	defer restoreGlobalProxy(t, snapshot)
	if _, err := setGlobalProxyConfig(true, connection.ProxyConfig{Type: "socks5", Host: "127.0.0.1", Port: 1080}); err != nil {
		t.Fatalf("enable socks5 global proxy: %v", err)
	}
	entries := pluginProxyEnvironment()
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"} {
		if value, count := pluginProxyEntryValue(entries, name); count != 1 || value != "socks5://127.0.0.1:1080" {
			t.Fatalf("%s 未按 socks5 代理注入：count=%d value=%q", name, count, value)
		}
	}
	if got := noProxyValue(t, entries); got != "localhost,127.0.0.1,::1" {
		t.Fatalf("NO_PROXY 未指向本机回环：%q", got)
	}
}

// 宿主没有 NO_PROXY 时，注入结果就是回环项。
func TestPluginProxyEnvironmentInjectsLoopbackNoProxyWithoutHostList(t *testing.T) {
	clearHostNoProxy(t, "")
	snapshot := currentGlobalProxyConfig()
	defer restoreGlobalProxy(t, snapshot)
	enablePluginTestProxy(t)

	if got := noProxyValue(t, pluginProxyEnvironment()); got != "localhost,127.0.0.1,::1" {
		t.Fatalf("宿主无 NO_PROXY 时应只注入回环项：%q", got)
	}
}

// 宿主已有的 NO_PROXY 条目必须逐条保留，回环项并到末尾而不是替换整条。
func TestPluginProxyEnvironmentMergesHostNoProxyEntries(t *testing.T) {
	clearHostNoProxy(t, ".corp,10.0.0.0/8")
	snapshot := currentGlobalProxyConfig()
	defer restoreGlobalProxy(t, snapshot)
	enablePluginTestProxy(t)

	got := noProxyValue(t, pluginProxyEnvironment())
	if got != ".corp,10.0.0.0/8,localhost,127.0.0.1,::1" {
		t.Fatalf("宿主 NO_PROXY 条目被覆盖：%q", got)
	}
}

// 宿主列表里的空白、大小写重复项要归一，且回环项在大小写匹配后仍不重复。
func TestPluginProxyEnvironmentNormalizesHostNoProxyEntries(t *testing.T) {
	clearHostNoProxy(t, " .corp , LOCALHOST ,.corp,10.0.0.0/8,LOCALHOST")
	snapshot := currentGlobalProxyConfig()
	defer restoreGlobalProxy(t, snapshot)
	enablePluginTestProxy(t)

	got := noProxyValue(t, pluginProxyEnvironment())
	want := ".corp,LOCALHOST,10.0.0.0/8,127.0.0.1,::1"
	if got != want {
		t.Fatalf("NO_PROXY 归一结果不符：got=%q want=%q", got, want)
	}
	seen := make(map[string]int)
	for _, entry := range strings.Split(got, ",") {
		if entry == "" || strings.TrimSpace(entry) != entry {
			t.Fatalf("NO_PROXY 条目未去空白或为空：%q", entry)
		}
		seen[strings.ToLower(entry)]++
	}
	for key, count := range seen {
		if count != 1 {
			t.Fatalf("NO_PROXY 条目 %q 重复 %d 次：%q", key, count, got)
		}
	}
	for _, loopback := range []string{"localhost", "127.0.0.1", "::1"} {
		if seen[loopback] != 1 {
			t.Fatalf("NO_PROXY 缺少回环项 %s：%q", loopback, got)
		}
	}
}

// 配置不可用时（宿主直接持有运行态）插件退回环境代理，而不是拿到无效地址。
func TestPluginProxyEnvironmentFallsBackWhenConfiguredProxyIsUnusable(t *testing.T) {
	globalProxyRuntime.mu.Lock()
	previous := globalProxySnapshot{Enabled: globalProxyRuntime.enabled, Proxy: globalProxyRuntime.proxy}
	globalProxyRuntime.enabled = true
	globalProxyRuntime.proxy = connection.ProxyConfig{Type: "http", Host: "", Port: 0}
	globalProxyRuntime.mu.Unlock()
	defer func() {
		globalProxyRuntime.mu.Lock()
		globalProxyRuntime.enabled, globalProxyRuntime.proxy = previous.Enabled, previous.Proxy
		globalProxyRuntime.mu.Unlock()
	}()

	if entries := pluginProxyEnvironment(); len(entries) != 0 {
		t.Fatalf("代理配置不可用时插件应回退环境代理：%v", entries)
	}
}

// mergePluginNoProxy 是纯函数：宿主条目、空白、大小写重复项与缺失回环项的归一规则。
func TestMergePluginNoProxyKeepsBothSides(t *testing.T) {
	cases := []struct {
		name   string
		values []string
		want   string
	}{
		{"无宿主列表", []string{""}, "localhost,127.0.0.1,::1"},
		{"保留宿主条目", []string{".corp,10.0.0.0/8"}, ".corp,10.0.0.0/8,localhost,127.0.0.1,::1"},
		{"两个变量都保留", []string{".corp", "10.0.0.0/8"}, ".corp,10.0.0.0/8,localhost,127.0.0.1,::1"},
		{"去空白去空项", []string{" ,.corp, ,10.0.0.0/8, "}, ".corp,10.0.0.0/8,localhost,127.0.0.1,::1"},
		{"大小写不敏感去重", []string{" .corp , LOCALHOST ", ".corp,::1"}, ".corp,LOCALHOST,::1,127.0.0.1"},
		{"回环项已存在则不重复追加", []string{"127.0.0.1,LOCALHOST,::1"}, "127.0.0.1,LOCALHOST,::1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := mergePluginNoProxy(tc.values...); got != tc.want {
				t.Fatalf("mergePluginNoProxy(%q) = %q, want %q", tc.values, got, tc.want)
			}
		})
	}
}
