package provider

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

// 三个 CLI 的档位值域必须互不相同，一旦有人把它们合并成共享枚举，本用例就会失败。
func TestCLIEffortDomainsAreNotShared(t *testing.T) {
	codex, ok := LookupCLICapability("codex-cli")
	if !ok {
		t.Fatal("codex-cli capability missing")
	}
	claude, ok := LookupCLICapability("claude-cli")
	if !ok {
		t.Fatal("claude-cli capability missing")
	}
	grok, ok := LookupCLICapability("grok-cli")
	if !ok {
		t.Fatal("grok-cli capability missing")
	}

	if len(codex.EffortValues) == len(claude.EffortValues) &&
		len(claude.EffortValues) == len(grok.EffortValues) {
		t.Fatalf("三个 CLI 的档位值域长度相同，说明可能被误合并：codex=%v claude=%v grok=%v",
			codex.EffortValues, claude.EffortValues, grok.EffortValues)
	}

	// grok 实测只认 4 个值，minimal 与 max 都会被拒。
	for _, rejected := range []string{"minimal", "max"} {
		if _, err := grok.NormalizeEffort(rejected); err == nil {
			t.Fatalf("grok 不应接受档位 %q", rejected)
		}
	}
	// claude 实测不认 minimal，但认 max。
	if _, err := claude.NormalizeEffort("minimal"); err == nil {
		t.Fatal("claude 不应接受档位 minimal")
	}
	if _, err := claude.NormalizeEffort("max"); err != nil {
		t.Fatalf("claude 应接受档位 max：%v", err)
	}
}

// 空档位表示沿用 CLI 默认，不得下发任何参数。
func TestNormalizeEffortEmptyIsPassthrough(t *testing.T) {
	for _, format := range []string{"codex-cli", "claude-cli", "grok-cli"} {
		capability, _ := LookupCLICapability(format)
		value, err := capability.NormalizeEffort("  ")
		if err != nil || value != "" {
			t.Fatalf("%s 空档位应为无参透传，得到 value=%q err=%v", format, value, err)
		}
		if got := capability.AppendEffortArgs(nil, ""); len(got) != 0 {
			t.Fatalf("%s 空档位不应产生参数，得到 %v", format, got)
		}
	}
}

// 档位的拼装形态按 CLI 不同：claude/grok 用专用 flag，codex 只能走 -c 配置键。
func TestAppendEffortArgsUsesPerCLIShape(t *testing.T) {
	codex, _ := LookupCLICapability("codex-cli")
	if got := codex.AppendEffortArgs(nil, "high"); len(got) != 2 ||
		got[0] != "-c" || got[1] != `model_reasoning_effort="high"` {
		t.Fatalf("codex 档位应走 -c 配置键，得到 %v", got)
	}

	claude, _ := LookupCLICapability("claude-cli")
	if got := claude.AppendEffortArgs(nil, "xhigh"); len(got) != 2 ||
		got[0] != "--effort" || got[1] != "xhigh" {
		t.Fatalf("claude 档位应走 --effort，得到 %v", got)
	}

	grok, _ := LookupCLICapability("grok-cli")
	if got := grok.AppendEffortArgs(nil, "high"); len(got) != 2 ||
		got[0] != "--reasoning-effort" || got[1] != "high" {
		t.Fatalf("grok 档位应走 --reasoning-effort，得到 %v", got)
	}
}

// 退出码不可信的两个 CLI，必须能从输出里判出「参数没生效」。
func TestInspectRejectionCoversZeroExitAndSilentDowngrade(t *testing.T) {
	grok, _ := LookupCLICapability("grok-cli")
	grokOutput := "--effort/--reasoning-effort: unknown effort level 'xhigh-fast'; use one of: xhigh, high, medium, low"
	err := grok.InspectRejection(grokOutput)
	if err == nil {
		t.Fatal("grok 退出码为 0 时仍须从输出判出被拒")
	}
	if !strings.Contains(err.Error(), "拒绝") {
		t.Fatalf("grok 应报告为拒绝，得到 %v", err)
	}

	claude, _ := LookupCLICapability("claude-cli")
	claudeOutput := "Warning: Unknown --effort value '__bogus__' — ignoring it and using the default effort."
	err = claude.InspectRejection(claudeOutput)
	if err == nil {
		t.Fatal("claude 静默降级必须被判为参数未生效，而不是成功")
	}
	if !strings.Contains(err.Error(), "降级") {
		t.Fatalf("claude 应报告为静默降级，得到 %v", err)
	}

	// 正常输出不得误报。
	if err := grok.InspectRejection(`{"text":"ok"}`); err != nil {
		t.Fatalf("正常输出不应判为被拒：%v", err)
	}
}

// 配置预填路径必须用 filepath.Join 拼装，才能在 Windows / Linux / macOS 通用。
func TestUserConfigPathIsPlatformNeutral(t *testing.T) {
	grok, _ := LookupCLICapability("grok-cli")
	path, err := grok.userConfigPath()
	if err != nil {
		t.Skipf("无法解析用户主目录：%v", err)
	}
	if path == "" {
		t.Fatal("grok 应声明配置来源")
	}
	if !strings.HasSuffix(path, filepath.Join(".grok", "config.toml")) {
		t.Fatalf("grok 配置路径拼装不符合预期：%s", path)
	}

	// Claude Code 不在用户配置里保存模型/档位，必须显式表达为「无来源」而不是猜一个路径。
	claude, _ := LookupCLICapability("claude-cli")
	claudePath, err := claude.userConfigPath()
	if err != nil || claudePath != "" {
		t.Fatalf("claude 应声明无配置来源，得到 path=%q err=%v", claudePath, err)
	}
}

// 只解析最简 TOML 标量，且要能跳过注释与引号。
func TestSplitTOMLScalar(t *testing.T) {
	cases := []struct{ line, key, value string }{
		{`model = "grok-4.6"`, "model", "grok-4.6"},
		{`default_reasoning_effort = "xhigh"`, "default_reasoning_effort", "xhigh"},
		{`model_reasoning_effort = "max" # 注释`, "model_reasoning_effort", "max"},
	}
	for _, c := range cases {
		key, value, ok := splitTOMLScalar(c.line)
		if !ok || key != c.key || value != c.value {
			t.Fatalf("解析 %q 失败：key=%q value=%q ok=%v", c.line, key, value, ok)
		}
	}
	if _, _, ok := splitTOMLScalar("[models]"); ok {
		t.Fatal("段落头不应被当成键值对")
	}
}

// 非法档位必须在 GoNavi 侧就失败，绝不能交给 grok 去拒绝——它拒绝时退出码是 0。
func TestBuildGrokCLIArgsRejectsInvalidEffortLocally(t *testing.T) {
	_, err := buildGrokCLIArgs(ai.ProviderConfig{Effort: "max"}, "hi")
	if err == nil {
		t.Fatal("grok 不支持 max，应在本地直接失败")
	}

	args, err := buildGrokCLIArgs(ai.ProviderConfig{Model: "grok-4.6", Effort: "xhigh"}, "hi")
	if err != nil {
		t.Fatalf("合法组合不应失败：%v", err)
	}
	joined := strings.Join(args, " ")
	for _, expected := range []string{
		"--output-format json",
		"--system-prompt-override",
		"--tools",
		"--disable-web-search",
		"-m grok-4.6",
		"--reasoning-effort xhigh",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("grok 参数缺少 %q：%v", expected, args)
		}
	}
}

// 预填读的是本机各 CLI 自己的配置文件。没有配置文件时跳过，
// 因为预填只是省一次手填，缺失绝不能变成错误。
func TestCLIConfigDefaultsReadsRealLocalConfig(t *testing.T) {
	for _, format := range []string{"codex-cli", "grok-cli"} {
		capability, _ := LookupCLICapability(format)
		path, err := capability.userConfigPath()
		if err != nil || path == "" {
			t.Skipf("%s 无配置来源", format)
		}
		if !fileExists(path) {
			t.Skipf("%s 本机无 %s", format, path)
		}
		model, effort := capability.CLIConfigDefaults()
		if model == "" && effort == "" {
			t.Fatalf("%s 存在配置文件却什么都没读到：%s", format, path)
		}
		// 读出来的档位必须已经过本 CLI 的值域校验，不能把一个会被拒的值填进界面。
		if effort != "" {
			if _, err := capability.NormalizeEffort(effort); err != nil {
				t.Fatalf("%s 预填了非法档位 %q：%v", format, effort, err)
			}
		}
		t.Logf("%s 预填结果 model=%q effort=%q", format, model, effort)
	}
}

// Claude Code 没有配置来源，必须安静地返回空值而不是报错或猜测。
func TestCLIConfigDefaultsQuietWhenNoSource(t *testing.T) {
	claude, _ := LookupCLICapability("claude-cli")
	model, effort := claude.CLIConfigDefaults()
	if model != "" || effort != "" {
		t.Fatalf("claude 无配置来源却返回了值：model=%q effort=%q", model, effort)
	}
}

// 模型枚举解析要认项目符号行、剥掉 (default) 后缀，并忽略标题与登录态说明。
func TestParseCLIModelList(t *testing.T) {
	output := `You are logged in with grok.com.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`
	models := parseCLIModelList(output)
	if len(models) != 2 || models[0] != "grok-4.6" || models[1] != "grok-4.5" {
		t.Fatalf("解析结果不符：%v", models)
	}

	// 不含项目符号的输出不应被误判成模型。
	if got := parseCLIModelList("No models available.\nDefault model: none\n"); len(got) != 0 {
		t.Fatalf("非列表输出不应产出模型：%v", got)
	}
}

// 不具备枚举能力的 CLI 返回空列表而不是错误——那是能力事实，不是故障。
func TestDiscoverModelsNoopWhenUnsupported(t *testing.T) {
	for _, format := range []string{"codex-cli", "claude-cli", "codebuddy-cli"} {
		capability, _ := LookupCLICapability(format)
		models, err := capability.DiscoverModels(context.Background())
		if err != nil || len(models) != 0 {
			t.Fatalf("%s 不可枚举时应静默返回空：models=%v err=%v", format, models, err)
		}
	}
}
