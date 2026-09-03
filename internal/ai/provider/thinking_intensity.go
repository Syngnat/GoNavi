package provider

import (
	"strings"

	"GoNavi-Wails/internal/ai"
)

// ThinkingProfile 描述不同服务商/协议下的思考档位体系。
type ThinkingProfile string

const (
	ThinkingProfileOpenAI    ThinkingProfile = "openai"    // none/minimal/low/medium/high/xhigh
	ThinkingProfileAnthropic ThinkingProfile = "anthropic" // off/low/medium/high/xhigh/max
	ThinkingProfileDeepSeek  ThinkingProfile = "deepseek"  // off/low/medium/high
	ThinkingProfileGemini    ThinkingProfile = "gemini"    // off/minimal/low/medium/high
	ThinkingProfileGeneric   ThinkingProfile = "generic"   // off/low/medium/high
)

// NormalizeThinkingIntensity 保留服务商原生档位字面量，不做跨档压缩。
// 空值表示“未设置 / 走供应商默认”。
func NormalizeThinkingIntensity(raw string) ai.ThinkingIntensity {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return ""
	case "auto", "default":
		return ""
	case "off", "disabled", "false", "0":
		return ai.ThinkingIntensityOff
	case "none":
		// OpenAI 用 none 表示不推理；与 off 同义但保留字面量供映射。
		return ai.ThinkingIntensity("none")
	case "minimal", "min":
		return ai.ThinkingIntensity("minimal")
	case "low", "light":
		return ai.ThinkingIntensityLow
	case "medium", "mid", "normal", "standard":
		return ai.ThinkingIntensityMedium
	case "high":
		return ai.ThinkingIntensityHigh
	case "xhigh", "extra_high", "extra-high", "xh":
		return ai.ThinkingIntensity("xhigh")
	case "max", "maximum", "heavy":
		return ai.ThinkingIntensity("max")
	default:
		return ""
	}
}

// ResolveThinkingProfile 根据供应商类型、API 格式、端点与模型选择档位体系。
func ResolveThinkingProfile(providerType, apiFormat, baseURL, model string) ThinkingProfile {
	ptype := strings.ToLower(strings.TrimSpace(providerType))
	format := strings.ToLower(strings.TrimSpace(apiFormat))
	base := strings.ToLower(strings.TrimSpace(baseURL))
	modelName := strings.ToLower(strings.TrimSpace(model))

	if isDeepSeekHost(baseURL) || strings.Contains(base, "deepseek") || strings.Contains(modelName, "deepseek") {
		return ThinkingProfileDeepSeek
	}
	if ptype == "gemini" || format == "gemini" || strings.Contains(base, "generativelanguage.googleapis.com") || strings.Contains(base, "googleapis.com/v1beta") {
		return ThinkingProfileGemini
	}
	if ptype == "anthropic" || format == "anthropic" {
		return ThinkingProfileAnthropic
	}
	if ptype == "openai" || format == "" || format == "openai" || format == "openai-responses" {
		return ThinkingProfileOpenAI
	}
	return ThinkingProfileGeneric
}

// ThinkingIntensityOptions 返回某 profile 支持的档位（UI / 校验用）。
func ThinkingIntensityOptions(profile ThinkingProfile) []string {
	switch profile {
	case ThinkingProfileOpenAI:
		return []string{"none", "minimal", "low", "medium", "high", "xhigh"}
	case ThinkingProfileAnthropic:
		return []string{"off", "low", "medium", "high", "xhigh", "max"}
	case ThinkingProfileDeepSeek:
		return []string{"off", "low", "medium", "high"}
	case ThinkingProfileGemini:
		return []string{"off", "minimal", "low", "medium", "high"}
	default:
		return []string{"off", "low", "medium", "high"}
	}
}

func clampThinkingIntensityToProfile(raw string, profile ThinkingProfile) ai.ThinkingIntensity {
	intensity := NormalizeThinkingIntensity(raw)
	if intensity == "" {
		return ""
	}
	// 统一 off/none
	normalized := string(intensity)
	if intensity == ai.ThinkingIntensityOff {
		if profile == ThinkingProfileOpenAI {
			normalized = "none"
		} else {
			normalized = "off"
		}
	}
	if intensity == ai.ThinkingIntensity("none") && profile != ThinkingProfileOpenAI {
		normalized = "off"
	}

	allowed := ThinkingIntensityOptions(profile)
	for _, opt := range allowed {
		if opt == normalized {
			return ai.ThinkingIntensity(normalized)
		}
	}
	// 跨体系兜底：尽量落到最接近的可用档位
	switch normalized {
	case "medium":
		return ai.ThinkingIntensityMedium
	case "xhigh", "max":
		if profile == ThinkingProfileOpenAI {
			return ai.ThinkingIntensity("xhigh")
		}
		if profile == ThinkingProfileAnthropic && normalized == "max" {
			// anthropic 支持 max；此处仅当 max 不在 allowed 时才会进入（理论上不会）
			return ai.ThinkingIntensity("max")
		}
		return ai.ThinkingIntensityHigh
	case "minimal":
		if profile == ThinkingProfileGemini || profile == ThinkingProfileOpenAI {
			return ai.ThinkingIntensity("minimal")
		}
		return ai.ThinkingIntensityLow
	case "none", "off":
		if profile == ThinkingProfileOpenAI {
			return ai.ThinkingIntensity("none")
		}
		return ai.ThinkingIntensityOff
	default:
		return ai.ThinkingIntensityMedium
	}
}

func anthropicThinkingBudgetTokens(intensity ai.ThinkingIntensity) int {
	switch intensity {
	case ai.ThinkingIntensityLow, ai.ThinkingIntensity("minimal"):
		return 1024
	case ai.ThinkingIntensityHigh:
		return 16000
	case ai.ThinkingIntensity("xhigh"):
		return 32000
	case ai.ThinkingIntensity("max"):
		return 64000
	default:
		return 8192
	}
}

// anthropicOutputEffort 映射到 Anthropic/DeepSeek Anthropic 的 effort 字面量。
func anthropicOutputEffort(intensity ai.ThinkingIntensity) string {
	switch intensity {
	case ai.ThinkingIntensityOff, ai.ThinkingIntensity("none"), "":
		return ""
	case ai.ThinkingIntensityLow, ai.ThinkingIntensity("minimal"):
		return "low"
	case ai.ThinkingIntensityMedium:
		return "medium"
	case ai.ThinkingIntensityHigh:
		return "high"
	case ai.ThinkingIntensity("xhigh"):
		return "xhigh"
	case ai.ThinkingIntensity("max"):
		return "max"
	default:
		return "medium"
	}
}

// openAIReasoningEffort 映射到 OpenAI reasoning_effort。
func openAIReasoningEffort(intensity ai.ThinkingIntensity) string {
	switch intensity {
	case "", ai.ThinkingIntensityOff:
		return ""
	case ai.ThinkingIntensity("none"):
		return "none"
	case ai.ThinkingIntensity("minimal"):
		return "minimal"
	case ai.ThinkingIntensityLow:
		return "low"
	case ai.ThinkingIntensityMedium:
		return "medium"
	case ai.ThinkingIntensityHigh:
		return "high"
	case ai.ThinkingIntensity("xhigh"), ai.ThinkingIntensity("max"):
		return "xhigh"
	default:
		return ""
	}
}

// geminiThinkingLevel 映射到 Gemini thinking_level。
func geminiThinkingLevel(intensity ai.ThinkingIntensity) string {
	switch intensity {
	case ai.ThinkingIntensityOff, ai.ThinkingIntensity("none"):
		return ""
	case ai.ThinkingIntensity("minimal"):
		return "minimal"
	case ai.ThinkingIntensityLow:
		return "low"
	case ai.ThinkingIntensityMedium:
		return "medium"
	case ai.ThinkingIntensityHigh, ai.ThinkingIntensity("xhigh"), ai.ThinkingIntensity("max"):
		return "high"
	default:
		return ""
	}
}

// geminiThinkingBudget 给 Gemini 2.5 系列 thinking_budget 兜底。
func geminiThinkingBudget(intensity ai.ThinkingIntensity) int {
	switch intensity {
	case ai.ThinkingIntensityOff, ai.ThinkingIntensity("none"):
		return 0
	case ai.ThinkingIntensity("minimal"), ai.ThinkingIntensityLow:
		return 1024
	case ai.ThinkingIntensityMedium:
		return 8192
	case ai.ThinkingIntensityHigh, ai.ThinkingIntensity("xhigh"), ai.ThinkingIntensity("max"):
		return 24576
	default:
		return -1 // dynamic
	}
}
