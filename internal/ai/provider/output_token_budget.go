package provider

import (
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// 输出上限的策略是「默认不限制」。
//
// 请求和配置里都没有给出正数上限时，不替用户设置上限，让模型使用自己的最大输出；
// 一旦用户显式给了正数（哪怕很小），就原样发送，从不改写。
//
// 之前的实现给未配置的请求填过 4096 / 32768 的默认值。agent 对话里工具调用参数
// （长 SQL、DDL）和推理 token 都算输出，聊到一半就会撞上上限，Responses 直接以
// incomplete / max_output_tokens 结束，整个对话中断。
const (
	// deepSeekMaxOutputTokens 是 DeepSeek 官方文档给出的 max_tokens / max_output_tokens
	// 上限（384K）。DeepSeek 省略该参数时默认只有 8K（非思考）/ 64K（思考），并不等于
	// 不限制，所以原生 DeepSeek 端点需要显式给最大值。
	deepSeekMaxOutputTokens = 393216

	// anthropicDefaultMaxTokens 用于 Anthropic Messages API：max_tokens 是必填项，省略
	// 会被拒绝，所以取当前旗舰模型的最大输出（128K）。上限更低的模型会返回 400，
	// 由 outputTokenCapFromRejection 解析出该模型的上限后自动降一次。
	anthropicDefaultMaxTokens = 128000

	// legacyOutputTokenFallback 是无法从上游报错里解析出模型上限时退回的保守值，
	// 即历史默认值，所有已知模型都接受。
	legacyOutputTokenFallback = 4096

	// minLearnableOutputTokenCap 过滤报错文本里的无关小数字（版本号、区间下界等）。
	minLearnableOutputTokenCap = 256
)

// learnedOutputTokenCaps 记住某个端点 + 模型被上游拒绝后学到的输出上限，
// 之后的请求直接使用，不再白挨一次 400。键为「端点\x00模型」，值为 int（0 表示不发送上限）。
var learnedOutputTokenCaps sync.Map

func learnedOutputTokenCapKey(baseURL, model string) string {
	return strings.TrimRight(strings.ToLower(strings.TrimSpace(baseURL)), "/") + "\x00" + strings.ToLower(strings.TrimSpace(model))
}

func learnedOutputTokenCap(baseURL, model string) (int, bool) {
	value, ok := learnedOutputTokenCaps.Load(learnedOutputTokenCapKey(baseURL, model))
	if !ok {
		return 0, false
	}
	capValue, _ := value.(int)
	return capValue, true
}

func rememberOutputTokenCap(baseURL, model string, capValue int) {
	learnedOutputTokenCaps.Store(learnedOutputTokenCapKey(baseURL, model), capValue)
}

// isOutputTokenLimitRejection 判断上游是否因为输出上限参数而拒绝了请求：
// 必须是 provider 报出的 4xx（错误文本里带 "(HTTP 400)" / "(HTTP 422)"），并且提到了输出上限。
func isOutputTokenLimitRejection(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	if !strings.Contains(message, "(http 400)") && !strings.Contains(message, "(http 422)") {
		return false
	}
	for _, term := range []string{"max_tokens", "max_output_tokens", "max_completion_tokens", "max tokens", "output tokens"} {
		if strings.Contains(message, term) {
			return true
		}
	}
	return false
}

var (
	outputTokenNumberPattern = regexp.MustCompile(`\d[\d,]*`)
	httpStatusMarkerPattern  = regexp.MustCompile(`(?i)\(http \d{3}\)`)
)

// rejectionDetail 只保留 "(HTTP 4xx)" 之后的报错正文：状态码本身也是数字，不能当成上限。
func rejectionDetail(message string) string {
	if loc := httpStatusMarkerPattern.FindStringIndex(message); loc != nil {
		return message[loc[1]:]
	}
	return message
}

// outputTokenCapFromRejection 从上游的拒绝文本里提取该模型的输出上限。
//
// 各家措辞不同：Anthropic 是 "max_tokens: 128000 > 64000, which is the maximum ..."，
// DeepSeek 是 "the valid range of max_tokens is [1, 8192]"。共同点是上限一定小于我们
// 发送的值，所以取文本里「小于所发值、且不小于 minLearnableOutputTokenCap」的最大整数。
func outputTokenCapFromRejection(err error, sent int) (int, bool) {
	if !isOutputTokenLimitRejection(err) || sent <= minLearnableOutputTokenCap {
		return 0, false
	}
	best := 0
	for _, raw := range outputTokenNumberPattern.FindAllString(rejectionDetail(err.Error()), -1) {
		value, parseErr := strconv.Atoi(strings.ReplaceAll(raw, ",", ""))
		if parseErr != nil || value < minLearnableOutputTokenCap || value >= sent {
			continue
		}
		if value > best {
			best = value
		}
	}
	if best == 0 {
		return 0, false
	}
	return best, true
}

// explicitOutputTokens 返回用户显式给出的输出上限：请求级优先于配置级，均为正数才算显式。
func explicitOutputTokens(requestMaxTokens, configuredMaxTokens int) (int, bool) {
	if requestMaxTokens > 0 {
		return requestMaxTokens, true
	}
	if configuredMaxTokens > 0 {
		return configuredMaxTokens, true
	}
	return 0, false
}
