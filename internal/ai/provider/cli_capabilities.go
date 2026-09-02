package provider

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai"
)

// 本文件是「按 CLI 适配模型与推理档位」的唯一收敛点。
//
// 三个本机 CLI 在同一件事上的做法两两不同，调用点绝不能共享枚举，
// 也不能用退出码统一判成败：
//
//   - 档位 flag 形态不同：claude/grok 有专用 flag，codex 只能走 -c 配置键。
//   - 档位值域不同：codex 6 个、claude 5 个、grok 4 个，交集只有 low/medium/high/xhigh。
//   - 非法值的失败语义不同：codex 非零退出；grok 退出码仍为 0、错误只在 stdout；
//     claude 直接静默降级为默认档位并把请求跑完。
//
// 后两种如果按退出码判断，会分别把「完全没跑」和「档位被悄悄换掉」当成功。

// CLIRejectionSemantics 描述 CLI 在收到非法模型/档位时的可观测行为。
type CLIRejectionSemantics string

const (
	// CLIRejectHardFailNonZero 非法值导致任务不执行且退出码非零，可直接依赖退出码。
	CLIRejectHardFailNonZero CLIRejectionSemantics = "hard-fail-nonzero"
	// CLIRejectHardFailZeroExit 非法值导致任务不执行，但退出码仍为 0，错误只出现在输出里。
	CLIRejectHardFailZeroExit CLIRejectionSemantics = "hard-fail-zero-exit"
	// CLIRejectSilentDowngrade 非法值只产生警告，CLI 改用默认档位继续执行。
	CLIRejectSilentDowngrade CLIRejectionSemantics = "silent-downgrade"
)

// CLIEffortStyle 描述档位参数的拼装形态。
type CLIEffortStyle string

const (
	// CLIEffortFlag 使用专用 flag，例如 --effort high。
	CLIEffortFlag CLIEffortStyle = "flag"
	// CLIEffortConfigKV 通过通用配置覆盖传入，例如 -c model_reasoning_effort="high"。
	CLIEffortConfigKV CLIEffortStyle = "config-kv"
	// CLIEffortUnsupported 该 CLI 不接受档位参数。
	CLIEffortUnsupported CLIEffortStyle = "unsupported"
)

// CLICapability 声明单个本机 CLI 的模型与档位能力。
type CLICapability struct {
	APIFormat string
	Command   string

	ModelFlag string
	// ModelDiscoveryArgs 非空表示 CLI 命令可枚举；本机缓存另由 ModelCatalogSource 指定。
	ModelDiscoveryArgs []string
	// ModelCatalogSource identifies documented aliases or a local candidate cache.
	ModelCatalogSource string

	EffortStyle     CLIEffortStyle
	EffortFlag      string
	EffortConfigKey string
	// EffortValues 是实测确认的合法值域。空表示未确认，此时不得下发档位。
	EffortValues []string
	// EffortValuesVerified 为 false 表示值域来自推断而非实测，调用方应保守处理。
	EffortValuesVerified bool

	Rejection CLIRejectionSemantics
	// RejectionMarkers 用于在退出码不可信时从输出中判定被拒。
	RejectionMarkers []string

	// ConfigRelPath 相对用户主目录，跨平台用 filepath.Join 拼装。
	ConfigRelPath []string
	// ConfigSection 为空表示键在 TOML 顶层。
	ConfigSection   string
	ConfigModelKey  string
	ConfigEffortKey string
}

// cliCapabilities 的取值来自 2026-08-28 在 macOS 上对各 CLI 的实测，
// 版本：codex 0.150.1 / claude 2.1.241 / grok 1.0.5。
// 值域或失败语义随上游版本漂移时，必须重新实测后再改本表，不得照抄随附文档。
var cliCapabilities = map[string]CLICapability{
	"codex-cli": {
		APIFormat:          "codex-cli",
		Command:            "codex",
		ModelFlag:          "-m",
		ModelCatalogSource: "codex-cache",
		EffortStyle:        CLIEffortConfigKV,
		EffortConfigKey:    "model_reasoning_effort",
		EffortValues:       []string{"minimal", "low", "medium", "high", "xhigh", "max"},
		// codex 在配置加载期不校验该键，非法值不会被立刻拒绝，因此值域取自二进制字符串。
		EffortValuesVerified: false,
		Rejection:            CLIRejectHardFailNonZero,
		ConfigRelPath:        []string{".codex", "config.toml"},
		ConfigModelKey:       "model",
		ConfigEffortKey:      "model_reasoning_effort",
	},
	"claude-cli": {
		APIFormat:            "claude-cli",
		Command:              "claude",
		ModelFlag:            "--model",
		ModelCatalogSource:   "claude-aliases",
		EffortStyle:          CLIEffortFlag,
		EffortFlag:           "--effort",
		EffortValues:         []string{"low", "medium", "high", "xhigh", "max"},
		EffortValuesVerified: true,
		Rejection:            CLIRejectSilentDowngrade,
		RejectionMarkers:     []string{"Unknown --effort value"},
		// 此适配器尚未读取 Claude 的默认配置；留空时由 CLI 自行解析。
		ConfigRelPath: nil,
	},
	"grok-cli": {
		APIFormat:            "grok-cli",
		Command:              "grok",
		ModelFlag:            "-m",
		ModelDiscoveryArgs:   []string{"models"},
		EffortStyle:          CLIEffortFlag,
		EffortFlag:           "--reasoning-effort",
		EffortValues:         []string{"low", "medium", "high", "xhigh"},
		EffortValuesVerified: true,
		Rejection:            CLIRejectHardFailZeroExit,
		RejectionMarkers: []string{
			"unknown effort level",
			"Couldn't set model",
		},
		ConfigRelPath:   []string{".grok", "config.toml"},
		ConfigSection:   "models",
		ConfigModelKey:  "default",
		ConfigEffortKey: "default_reasoning_effort",
	},
	"codebuddy-cli": {
		APIFormat:   "codebuddy-cli",
		Command:     "codebuddy",
		ModelFlag:   "--model",
		EffortStyle: CLIEffortUnsupported,
		Rejection:   CLIRejectHardFailNonZero,
	},
	"cursor-cli": {
		// Parameters checked against cursor-agent 2026.05.05-84a231c and
		// official docs on 2026-08-31; model responses remain a manual gate.
		APIFormat:          "cursor-cli",
		Command:            "cursor-agent",
		ModelFlag:          "--model",
		ModelDiscoveryArgs: []string{"models"},
		EffortStyle:        CLIEffortUnsupported,
		Rejection:          CLIRejectHardFailNonZero,
	},
}

// LookupCLICapability 按 apiFormat 取能力声明；未登记的 CLI 返回 false。
func LookupCLICapability(apiFormat string) (CLICapability, bool) {
	capability, ok := cliCapabilities[strings.ToLower(strings.TrimSpace(apiFormat))]
	return capability, ok
}

// SupportsEffort 表示该 CLI 是否可以接收档位，且值域已经确认。
func (c CLICapability) SupportsEffort() bool {
	return c.EffortStyle != CLIEffortUnsupported && len(c.EffortValues) > 0
}

// NormalizeEffort 校验档位取值。空值表示沿用 CLI 默认，不下发任何参数。
func (c CLICapability) NormalizeEffort(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return "", nil
	}
	if !c.SupportsEffort() {
		return "", fmt.Errorf("%s 不接受推理档位参数", c.Command)
	}
	for _, allowed := range c.EffortValues {
		if normalized == allowed {
			return normalized, nil
		}
	}
	return "", fmt.Errorf("%s 不支持档位 %q；可选值：%s",
		c.Command, value, strings.Join(c.EffortValues, ", "))
}

// AppendEffortArgs 按该 CLI 的形态把档位拼进参数表。空档位不改变参数。
func (c CLICapability) AppendEffortArgs(args []string, effort string) []string {
	normalized := strings.ToLower(strings.TrimSpace(effort))
	if normalized == "" {
		return args
	}
	switch c.EffortStyle {
	case CLIEffortFlag:
		return append(args, c.EffortFlag, normalized)
	case CLIEffortConfigKV:
		return append(args, "-c", fmt.Sprintf("%s=%q", c.EffortConfigKey, normalized))
	default:
		return args
	}
}

// InspectRejection 在退出码不可信时，从 CLI 输出中判定参数是否被拒或被降级。
// 返回非 nil 表示本次调用的模型/档位没有按请求生效。
func (c CLICapability) InspectRejection(output string) error {
	if len(c.RejectionMarkers) == 0 || strings.TrimSpace(output) == "" {
		return nil
	}
	for _, marker := range c.RejectionMarkers {
		index := strings.Index(output, marker)
		if index < 0 {
			continue
		}
		detail := strings.TrimSpace(firstLineFrom(output[index:]))
		switch c.Rejection {
		case CLIRejectSilentDowngrade:
			return fmt.Errorf("%s 未采用请求的参数，已静默降级：%s", c.Command, detail)
		default:
			return fmt.Errorf("%s 拒绝了本次参数：%s", c.Command, detail)
		}
	}
	return nil
}

func firstLineFrom(text string) string {
	if index := strings.IndexAny(text, "\r\n"); index >= 0 {
		return text[:index]
	}
	return text
}

// CLIConfigDefaults 读取该 CLI 自身用户配置里的默认模型与档位，仅用于界面预填。
// 读取失败、文件不存在或该 CLI 没有配置来源时返回空值，不视为错误：
// 预填只是省一次手填，绝不改变实际下发的参数。
func (c CLICapability) CLIConfigDefaults() (model string, effort string) {
	path, err := c.userConfigPath()
	if err != nil || path == "" {
		return "", ""
	}
	file, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer file.Close()

	section := ""
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.Trim(line, "[]")
			continue
		}
		if section != c.ConfigSection {
			continue
		}
		key, value, ok := splitTOMLScalar(line)
		if !ok {
			continue
		}
		switch key {
		case c.ConfigModelKey:
			if model == "" {
				model = value
			}
		case c.ConfigEffortKey:
			if effort == "" {
				effort = value
			}
		}
	}
	if _, err := c.NormalizeEffort(effort); err != nil {
		// 用户配置里的档位不在本 CLI 的合法值域内时，宁可不预填也不要填一个会被拒的值。
		effort = ""
	}
	return model, effort
}

// userConfigPath 用主目录 + filepath.Join 拼装，Windows / Linux / macOS 通用。
func (c CLICapability) userConfigPath() (string, error) {
	if len(c.ConfigRelPath) == 0 {
		return "", nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(append([]string{home}, c.ConfigRelPath...)...), nil
}

// splitTOMLScalar 只解析 `key = "value"` 与 `key = value` 两种最简形态，
// 足够覆盖各 CLI 配置里的模型与档位键；不追求完整 TOML 语义。
func splitTOMLScalar(line string) (key string, value string, ok bool) {
	index := strings.Index(line, "=")
	if index <= 0 {
		return "", "", false
	}
	key = strings.TrimSpace(line[:index])
	value = strings.TrimSpace(line[index+1:])
	if comment := strings.Index(value, " #"); comment >= 0 {
		value = strings.TrimSpace(value[:comment])
	}
	value = strings.Trim(value, `"'`)
	if key == "" || value == "" {
		return "", "", false
	}
	return key, value, true
}

// cliCapabilityOrder 固定投影顺序，避免 map 迭代顺序让界面每次刷新都变。
var cliCapabilityOrder = []string{"codex-cli", "claude-cli", "grok-cli", "codebuddy-cli", "cursor-cli"}

// CLICapabilityViews 把能力表投影给前端，并顺带带上各 CLI 自身配置里的预填值。
// 预填读取失败一律降级为空值：它只是省一次手填，绝不能让设置界面打不开。
func CLICapabilityViews() []ai.CLICapabilityView {
	views := make([]ai.CLICapabilityView, 0, len(cliCapabilityOrder))
	for _, format := range cliCapabilityOrder {
		capability, ok := cliCapabilities[format]
		if !ok {
			continue
		}
		defaultModel, defaultEffort := capability.CLIConfigDefaults()
		views = append(views, ai.CLICapabilityView{
			APIFormat:              capability.APIFormat,
			Command:                capability.Command,
			SupportsEffort:         capability.SupportsEffort(),
			EffortValues:           append([]string(nil), capability.EffortValues...),
			EffortValuesVerified:   capability.EffortValuesVerified,
			SupportsModelDiscovery: len(capability.ModelDiscoveryArgs) > 0,
			HasConfigSource:        len(capability.ConfigRelPath) > 0,
			DefaultModel:           defaultModel,
			DefaultEffort:          defaultEffort,
		})
	}
	return views
}

// modelDiscoveryTimeout 限制枚举调用；枚举失败一律降级为手填，不阻塞设置页。
var modelDiscoveryTimeout = 15 * time.Second

var cliModelLookPath = lookupLocalCLICommand
var cliModelCommandOutput = func(ctx context.Context, command string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	// A CLI wrapper may leave inherited output pipes open after it is killed.
	cmd.WaitDelay = time.Second
	cmd.Env = EnrichCLICommandPATH(cmd.Environ(), command)
	return cmd.CombinedOutput()
}

// DiscoverModels 调用该 CLI 自己的模型枚举子命令。
// 只有声明了 ModelDiscoveryArgs 的 CLI 才可枚举；其余返回空列表而不是错误，
// 因为「不可枚举」是能力事实，不是故障。
func (c CLICapability) DiscoverModels(ctx context.Context) ([]string, error) {
	if len(c.ModelDiscoveryArgs) == 0 {
		return nil, nil
	}
	if c.APIFormat == "cursor-cli" {
		return discoverCursorCLIModels(ctx)
	}
	ctx, cancel := context.WithTimeout(ctx, modelDiscoveryTimeout)
	defer cancel()

	var command string
	var err error
	if c.APIFormat == "grok-cli" {
		command, err = resolveGrokCLICommand(runtime.GOOS, cliModelLookPath)
	} else {
		command, err = cliModelLookPath(c.Command)
	}
	if err != nil {
		return nil, fmt.Errorf("%s 未安装或不在 PATH 中", c.Command)
	}
	output, runErr := cliModelCommandOutput(ctx, command, c.ModelDiscoveryArgs...)
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s 模型枚举失败：%w", c.Command, ctx.Err())
	}
	text := string(output)
	// 退出码不可信的 CLI 要先看输出：它拒绝时也可能返回 0。
	if rejection := c.InspectRejection(text); rejection != nil {
		return nil, rejection
	}
	if runErr != nil {
		return nil, fmt.Errorf("%s 模型枚举失败：%w", c.Command, runErr)
	}
	if c.APIFormat == "grok-cli" {
		for _, marker := range []string{"not logged in", "not authenticated", "please log in", "please login", "grok login", "unauthorized", "authentication required"} {
			if strings.Contains(strings.ToLower(text), marker) {
				return nil, fmt.Errorf("Grok CLI is not authenticated; sign in locally before checking models")
			}
		}
	}
	models := parseCLIModelList(text)
	if len(models) == 0 {
		return nil, fmt.Errorf("%s 模型枚举未返回任何模型", c.Command)
	}
	return models, nil
}

// parseCLIModelList 解析形如 "  * grok-4.6 (default)" / "  - grok-4.5" 的列表行。
// 它刻意宽松：只认项目符号开头的行，忽略标题与登录态说明，
// 这样 CLI 增删说明文字时不会让枚举整个失效。
func parseCLIModelList(output string) []string {
	seen := make(map[string]struct{})
	models := make([]string, 0, 4)
	for _, raw := range strings.Split(output, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		marker := string([]rune(line)[0])
		if marker != "*" && marker != "-" && marker != "•" {
			continue
		}
		candidate := strings.TrimSpace(line[len(marker):])
		if index := strings.Index(candidate, "("); index >= 0 {
			candidate = strings.TrimSpace(candidate[:index])
		}
		if candidate == "" || strings.ContainsAny(candidate, " \t") {
			continue
		}
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		models = append(models, candidate)
	}
	return models
}
