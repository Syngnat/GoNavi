package ai

import (
	"slices"
	"strings"
)

// ModelContextProfile 描述某个模型的上下文窗口（单位：token，与 runharness 的窗口口径一致）。
//
// DefaultWindow 是模型默认的上下文大小；Options 是用户可选的档位（升序，包含默认档）。
// len(Options) > 1 表示该模型支持调整，前端据此显示档位切换。
// 数值是展示与预算提示，随厂商发布节奏变化，集中在下面的规则表里维护，前端不复制。
type ModelContextProfile struct {
	DefaultWindow int   `json:"defaultWindow"`
	Options       []int `json:"options"`
}

const (
	contextWindow4K   = 4_096
	contextWindow128K = 128_000
	contextWindow200K = 200_000
	contextWindow258K = 258_000
	contextWindow500K = 500_000
	contextWindow1M   = 1_000_000
	contextWindow2M   = 2_000_000
)

// UnknownModelContextWindow 是无法识别的模型使用的默认值。
const UnknownModelContextWindow = contextWindow258K

// unknownModelContextOptions 是识别不出模型时给出的通用档位。
// 自定义供应商的模型名千差万别（网关别名、私有模型），与其猜一个数值，
// 不如让用户自己选，默认值仍是 UnknownModelContextWindow。
var unknownModelContextOptions = []int{
	contextWindow128K,
	contextWindow200K,
	UnknownModelContextWindow,
	contextWindow500K,
	contextWindow1M,
	contextWindow2M,
}

type modelContextRule struct {
	// dynamic, when set, replaces profile at lookup time (limits learned at run time).
	dynamic func() ModelContextProfile
	// all 中的片段必须全部出现在模型名里；any 非空时至少命中一个；
	// prefix 非空时模型名（去掉 provider/ 前缀后）必须以其中之一开头。
	all     []string
	any     []string
	prefix  []string
	profile ModelContextProfile
}

func fixedContextProfile(window int) ModelContextProfile {
	return ModelContextProfile{DefaultWindow: window, Options: []int{window}}
}

func adjustableContextProfile(defaultWindow int, options ...int) ModelContextProfile {
	return ModelContextProfile{DefaultWindow: defaultWindow, Options: options}
}

// modelContextRules 按顺序匹配，先命中先生效；更具体的规则放在前面。
var modelContextRules = []modelContextRule{
	// GoNavi 托管的 SQL 小模型：窗口由 Gateway 决定（运维后台可调），客户端从 /v1/quota 读取。
	{prefix: []string{"gonavi-sql"}, profile: fixedContextProfile(contextWindow4K), dynamic: func() ModelContextProfile {
		limits, _ := CurrentHostedModelLimits()
		return fixedContextProfile(limits.ContextWindow)
	}},
	{all: []string{"gemini-1.5-pro"}, profile: fixedContextProfile(contextWindow2M)},
	{any: []string{"gemini-3.8", "gemini-3.7", "gemini-3.1"}, profile: fixedContextProfile(contextWindow1M)},
	{all: []string{"gemini"}, profile: fixedContextProfile(contextWindow1M)},

	// GPT-6 / 6.1 一代：Sol 1.05M 上下文，档位可选 500K / 1M。
	{prefix: []string{"gpt-6", "gpt-6.1"}, profile: adjustableContextProfile(contextWindow1M, contextWindow500K, contextWindow1M)},
	{all: []string{"gpt-5"}, profile: adjustableContextProfile(contextWindow1M, contextWindow500K, contextWindow1M)},
	{all: []string{"gpt-4.1"}, profile: fixedContextProfile(contextWindow1M)},
	{any: []string{"gpt-4.5", "gpt-4o", "gpt-4"}, profile: fixedContextProfile(contextWindow128K)},
	{prefix: []string{"o1", "o3", "o4"}, profile: fixedContextProfile(contextWindow200K)},

	{all: []string{"claude"}, any: []string{"sonnet-4", "opus-4", "sonnet-5", "opus-5", "fable-5"},
		profile: adjustableContextProfile(contextWindow200K, contextWindow200K, contextWindow1M)},
	{all: []string{"claude"}, profile: fixedContextProfile(contextWindow200K)},

	// V4.1-Flash 的官方 ID 是 deepseek-flash（无版本号），与 v4 系列同为 1M 上下文。
	{all: []string{"deepseek-flash"}, profile: fixedContextProfile(contextWindow1M)},
	{all: []string{"deepseek-v4"}, profile: fixedContextProfile(contextWindow1M)},
	{all: []string{"deepseek"}, profile: fixedContextProfile(contextWindow128K)},
	{any: []string{"glm-5.3", "glm-5", "glm-4-long"}, profile: fixedContextProfile(contextWindow1M)},
	{any: []string{"glm", "z-ai"}, profile: fixedContextProfile(contextWindow128K)},
	{any: []string{"qwen3", "qwen-long"}, profile: fixedContextProfile(contextWindow1M)},
	{all: []string{"qwen"}, profile: fixedContextProfile(contextWindow128K)},
}

func modelNameMatches(lower string, rule modelContextRule) bool {
	if len(rule.prefix) > 0 {
		name := lower
		if slash := strings.LastIndex(name, "/"); slash >= 0 {
			name = name[slash+1:]
		}
		matched := false
		for _, prefix := range rule.prefix {
			if name == prefix || strings.HasPrefix(name, prefix+"-") {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	for _, part := range rule.all {
		if !strings.Contains(lower, part) {
			return false
		}
	}
	if len(rule.any) == 0 {
		return true
	}
	for _, part := range rule.any {
		if strings.Contains(lower, part) {
			return true
		}
	}
	return false
}

// ResolveModelContextProfile 按模型名解析上下文窗口。
// 无法识别或模型名为空时给出通用档位，让自定义供应商的模型也能自己选。
func ResolveModelContextProfile(model string) ModelContextProfile {
	lower := strings.ToLower(strings.TrimSpace(model))
	profile := ModelContextProfile{DefaultWindow: UnknownModelContextWindow, Options: unknownModelContextOptions}
	if lower != "" {
		for _, rule := range modelContextRules {
			if modelNameMatches(lower, rule) {
				profile = rule.profile
				if rule.dynamic != nil {
					profile = rule.dynamic()
				}
				break
			}
		}
	}
	// 返回副本，调用方改不动规则表本身。
	return ModelContextProfile{
		DefaultWindow: profile.DefaultWindow,
		Options:       append([]int(nil), profile.Options...),
	}
}

// NormalizeWindow 把用户选择的窗口收敛成可保存的值：
// 只有落在可选档位内、且不等于默认档的选择才会保留，其余一律为 0（表示跟随模型默认，不额外限制）。
// 这样换了模型后旧的选择会自动失效，不会把 500K 带到只支持 128K 的模型上。
func (p ModelContextProfile) NormalizeWindow(window int) int {
	if window <= 0 || window == p.DefaultWindow {
		return 0
	}
	if slices.Contains(p.Options, window) {
		return window
	}
	return 0
}
