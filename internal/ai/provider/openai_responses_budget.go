package provider

import "strings"

// normalizeOpenAIResponsesModelName removes a gateway namespace before model
// capability checks. Providers commonly expose names such as
// "deepseek/deepseek-v4-flash-0731".
func normalizeOpenAIResponsesModelName(model string) string {
	name := strings.ToLower(strings.TrimSpace(model))
	if slash := strings.LastIndex(name, "/"); slash >= 0 {
		name = name[slash+1:]
	}
	return strings.TrimSpace(name)
}

// openAIResponsesReasoningModel 识别默认带推理的模型（OpenAI 推理系列与 DeepSeek）。
// 兼容网关往往只在模型名中保留 deepseek 别名，不能只按请求域名判断。
func openAIResponsesReasoningModel(model string) bool {
	name := normalizeOpenAIResponsesModelName(model)
	switch {
	case strings.HasPrefix(name, "gpt-5"),
		strings.HasPrefix(name, "o1"),
		strings.HasPrefix(name, "o3"),
		strings.HasPrefix(name, "o4"),
		strings.Contains(name, "deepseek"):
		return true
	default:
		return false
	}
}
