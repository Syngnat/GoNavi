package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/internal/secretstore"
)

// 跨界验收：装真实插件包、拉起真实插件进程、走真实 JSON-RPC 与宿主能力，最后落到真实
// AI Service。它是唯一能证明「插件进程 → 能力注册表 → 供应商列表」整条链路通了的测试。
//
// 默认跳过，只有把 GONAVI_AICONFIG_PLUGIN_PKG 指向构建好的插件包目录（内含
// gonavi.plugin.json 与清单声明的后端可执行文件）时才运行。宿主仓库因此不依赖该插件：
// 目录缺失即跳过，不会让别人的测试变红。
func TestPluginAIConfigImportEndToEnd(t *testing.T) {
	packageDir := strings.TrimSpace(os.Getenv("GONAVI_AICONFIG_PLUGIN_PKG"))
	if packageDir == "" {
		t.Skip("set GONAVI_AICONFIG_PLUGIN_PKG to a built gonavi-ai-config package directory")
	}
	if _, err := os.Stat(filepath.Join(packageDir, "gonavi.plugin.json")); err != nil {
		t.Skipf("plugin package is unavailable: %v", err)
	}

	root := t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", root)

	service := aiservice.NewServiceWithSecretStore(secretstore.NewUnavailableStore("test"))
	aiservice.PreloadConfig(service)

	a := newPluginTestApp(t)
	// 让插件的只读能力 ai.providers（它按 a.configDir 新建一个 store）与活动 Service 读同一个
	// 数据根。默认的测试 App 会把 configDir 指到另一个临时目录，那样 conflict 判定读的是空列表，
	// 断言会以「测试自身的人为差异」而不是产品缺陷失败。
	a.configDir = root
	a.SetAIProviderStore(NewAIServiceProviderStore(service))

	inspected := a.PluginInspect(packageDir)
	if !inspected.Success {
		t.Fatalf("inspect failed: %+v", inspected)
	}
	snapshot, ok := inspected.Data.(plugin.Inspection)
	if !ok {
		t.Fatalf("unexpected inspection type %T", inspected.Data)
	}
	if result := a.PluginInstall(packageDir, snapshot.Digest, true); !result.Success {
		t.Fatalf("install failed: %+v", result)
	}
	pluginID := snapshot.Manifest.ID
	if result := a.PluginSetEnabled(pluginID, true); !result.Success {
		t.Fatalf("enable failed: %+v", result)
	}
	waitForPluginRunning(t, a, pluginID)

	// 空入参 = 扫全部来源，覆盖生产缺省路径。
	scan := a.PluginInvoke(pluginID, "sources.scan", `{}`)
	if !scan.Success {
		t.Fatalf("sources.scan failed: %+v", scan)
	}
	scanRaw, err := json.Marshal(scan.Data)
	if err != nil {
		t.Fatalf("marshal scan result: %v", err)
	}
	var scanResult struct {
		Sources []struct {
			ID       string `json:"id"`
			Detected bool   `json:"detected"`
			Count    int    `json:"count"`
			Skipped  int    `json:"skipped"`
			Disabled int    `json:"disabled"`
		} `json:"sources"`
		Items []struct {
			SourceID  string `json:"sourceId"`
			SourceKey string `json:"sourceKey"`
			Name      string `json:"name"`
			BaseURL   string `json:"baseUrl"`
			APIFormat string `json:"apiFormat"`
			HasKey    bool   `json:"hasKey"`
			Conflict  bool   `json:"conflict"`
		} `json:"items"`
	}
	if err := json.Unmarshal(scanRaw, &scanResult); err != nil {
		t.Fatalf("decode scan result: %v (%s)", err, scanRaw)
	}
	// 五个来源都必须出现在返回体里：未检测到的来源也要有卡片，页面靠它显示状态。
	counts := map[string]int{}
	for _, source := range scanResult.Sources {
		counts[source.ID] = source.Count
	}
	for _, id := range []string{"cc-switch", "magpie", "ccgui", "opencode", "mimocode"} {
		if _, ok := counts[id]; !ok {
			t.Fatalf("source %q missing from the scan result: %s", id, scanRaw)
		}
	}
	// 「结构不支持」与「上游停用」必须分开回传：把用户自己关掉的条目说成插件不认识，
	// 会让人去上游折腾一圈才发现没用。这里只核对字段可用（具体数值由插件侧 livescan 断言）。
	for _, source := range scanResult.Sources {
		if source.Skipped < 0 || source.Disabled < 0 {
			t.Fatalf("source %s reported a negative skip counter: %+v", source.ID, source)
		}
		t.Logf("source=%s count=%d skipped=%d disabled=%d", source.ID, source.Count, source.Skipped, source.Disabled)
	}
	total := 0
	for _, count := range counts {
		total += count
	}
	if total != len(scanResult.Items) {
		t.Fatalf("sum(sources[].count) = %d != items %d", total, len(scanResult.Items))
	}
	if counts["cc-switch"] == 0 {
		t.Skip("cc-switch exposes no providers on this machine")
	}
	// v1.2 的验收线：magpie 的主路径是 XDG 源配置（明文密钥）。它一旦被改回读运行态投影，
	// 所有 magpie 条目都会 hasKey=false，就在这条上立刻暴露。
	magpieWithKey := 0
	for _, item := range scanResult.Items {
		if item.SourceID == "magpie" && item.HasKey {
			magpieWithKey++
		}
	}
	if counts["magpie"] > 0 && magpieWithKey == 0 {
		t.Fatalf("magpie exposes %d entries but none carries a plaintext key: %s", counts["magpie"], scanRaw)
	}
	if strings.Contains(string(scanRaw), "apiKey") {
		t.Fatalf("scan result leaked a credential field: %s", scanRaw)
	}

	picked := make([]map[string]any, 0, 2)
	for _, item := range scanResult.Items {
		if item.Conflict || !item.HasKey || strings.TrimSpace(item.BaseURL) == "" {
			continue
		}
		if !pluginAIProviderImportAPIFormats[item.APIFormat] {
			continue
		}
		picked = append(picked, map[string]any{"sourceId": item.SourceID, "sourceKey": item.SourceKey})
		if len(picked) == 2 {
			break
		}
	}
	if len(picked) == 0 {
		t.Skip("no importable cc-switch provider on this machine")
	}
	importArguments, err := json.Marshal(map[string]any{"items": picked})
	if err != nil {
		t.Fatalf("marshal import arguments: %v", err)
	}

	applied := a.PluginInvoke(pluginID, "import.apply", string(importArguments))
	if !applied.Success {
		t.Fatalf("import.apply failed: %+v", applied)
	}
	appliedRaw, err := json.Marshal(applied.Data)
	if err != nil {
		t.Fatalf("marshal import result: %v", err)
	}
	var importResult struct {
		Imported int `json:"imported"`
		Failed   int `json:"failed"`
		Resolved int `json:"resolved"`
		Items    []struct {
			Index  int    `json:"index"`
			Status string `json:"status"`
			Reason string `json:"reason"`
		} `json:"items"`
	}
	if err := json.Unmarshal(appliedRaw, &importResult); err != nil {
		t.Fatalf("decode import result: %v (%s)", err, appliedRaw)
	}
	if importResult.Imported != len(picked) {
		t.Fatalf("imported %d of %d picked: %s", importResult.Imported, len(picked), appliedRaw)
	}
	for position, item := range importResult.Items {
		if item.Index != position {
			t.Fatalf("result index %d at position %d; indices must match the caller's items", item.Index, position)
		}
	}

	providers := service.AIGetProviders()
	if len(providers) != len(picked) {
		t.Fatalf("service holds %d providers, want %d", len(providers), len(picked))
	}
	for _, provider := range providers {
		if !provider.HasSecret {
			t.Fatalf("imported provider %q lost its credential", provider.Name)
		}
	}
	configRaw, err := os.ReadFile(filepath.Join(root, "ai_config.json"))
	if err != nil {
		t.Fatalf("read ai_config.json: %v", err)
	}
	for _, provider := range providers {
		if !strings.Contains(string(configRaw), provider.Name) {
			t.Fatalf("provider %q is missing from ai_config.json", provider.Name)
		}
	}
	if strings.Contains(string(configRaw), "sk-") {
		t.Fatalf("ai_config.json contains something that looks like a raw key")
	}
	if _, err := os.Stat(filepath.Join(root, "daily_secrets.json")); err != nil {
		t.Fatalf("credentials were not persisted through the secret store: %v", err)
	}

	// 导入后重新扫描：刚写进去的供应商必须被标成「已存在」。这条断言才真正验证了
	// conflict 判定所依赖的宿主只读能力（ai.providers.read / host.ai.providers.read）在真实宿主里通，
	// 否则权限被拒时插件只能静默降级成「一律不标冲突」，而导入结果依然全绿。
	pickedKeys := make(map[string]bool, len(picked))
	for _, item := range picked {
		if key, ok := item["sourceKey"].(string); ok {
			pickedKeys[key] = true
		}
	}
	rescan := a.PluginInvoke(pluginID, "sources.scan", `{}`)
	if !rescan.Success {
		t.Fatalf("rescan failed: %+v", rescan)
	}
	rescanRaw, err := json.Marshal(rescan.Data)
	if err != nil {
		t.Fatalf("marshal rescan result: %v", err)
	}
	var rescanResult struct {
		Items []struct {
			SourceKey string `json:"sourceKey"`
			Conflict  bool   `json:"conflict"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rescanRaw, &rescanResult); err != nil {
		t.Fatalf("decode rescan result: %v", err)
	}
	conflicts := 0
	for _, item := range rescanResult.Items {
		if pickedKeys[item.SourceKey] && item.Conflict {
			conflicts++
		}
	}
	if conflicts != len(pickedKeys) {
		t.Fatalf("imported providers are not reported as existing: %d of %d flagged", conflicts, len(pickedKeys))
	}
}

func waitForPluginRunning(t *testing.T, a *App, pluginID string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		list := a.PluginList()
		if !list.Success {
			t.Fatalf("plugin list failed: %+v", list)
		}
		for _, status := range list.Data.([]plugin.Status) {
			if status.Manifest.ID != pluginID {
				continue
			}
			if status.State == plugin.StateRunning {
				return
			}
			if status.State == plugin.StateFaulted || status.State == plugin.StateBlocked {
				t.Fatalf("plugin %s is %s", pluginID, status.State)
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("plugin %s did not reach running state", pluginID)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
