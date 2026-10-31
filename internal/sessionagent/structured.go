package sessionagent

// 子 Agent（审批 / 交付验证 / 市场审查）把结构化结论直接作为助手消息发出：
//
//	{"summary":"审查被环境能力阻塞：…","verdict":"blocked","findings":[]}
//
// 这是机器对机器的协议，不是对话。浏览端按普通段落渲染就是一坨单行 JSON，
// 连换行都没有。解析阶段就在这里把它拆成「正文 + 其余字段摘要」：
//
//   - 正文取顶层最长的字符串值（承载自然语言结论的那个字段）
//   - 其余字段收成摘要行：标量给原值，数组/对象给条目数
//
// 原始正文仍留在 SessionMessage.Content 里，导出与搜索都不受影响；
// Structured 只是浏览端的展示提示。
//
// 判定刻意保守，避免把工具的原始输出改头换面：
//   - 只认顶层对象（数组、坏 JSON、嵌在正文里的 JSON 都不动）
//   - 至少两个字段；单字段时必须是字符串值
//     （{"port":8080} 这类原始输出保持原样，{"outcome":"allow"} 这类纯结论要处理）

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// 结构化字段的类别。
const (
	structuredKindScalar = "scalar"
	structuredKindArray  = "array"
	structuredKindObject = "object"
)

// StructuredBody 是「整条正文是一个 JSON 对象」时的结构化拆解。
type StructuredBody struct {
	// Prose 是承载自然语言的正文。
	Prose string `json:"prose"`
	// ProseField 是正文来自哪个字段。
	ProseField string `json:"proseField,omitempty"`
	// Fields 是其余字段的摘要。
	Fields []StructuredField `json:"fields,omitempty"`
}

// StructuredField 是非正文字段的摘要。
type StructuredField struct {
	// Key 是原始字段名。
	Key string `json:"key"`
	// Kind 是字段类别：scalar / array / object。
	Kind string `json:"kind"`
	// Value 是标量字段的原值。
	Value string `json:"value,omitempty"`
	// Count 是数组/对象的条目数。
	Count int `json:"count,omitempty"`
	// Detail 是展开后的完整内容（数组/对象）。
	Detail string `json:"detail,omitempty"`
}

// splitStructuredBody 判断正文是否整条是一个 JSON 对象，是则拆出正文与字段摘要；
// 不是就返回 nil（正文按原样渲染）。
func splitStructuredBody(text string) *StructuredBody {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "{") {
		return nil
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return nil
	}
	if len(parsed) == 0 {
		return nil
	}
	if len(parsed) == 1 {
		// 单字段时只认字符串值：{"port":8080} 是工具原始输出，
		// {"outcome":"allow"} 才是纯结论。
		for _, raw := range parsed {
			var only string
			if err := json.Unmarshal(raw, &only); err != nil {
				return nil
			}
		}
	}

	// 正文 = 顶层最长的字符串值。子 Agent 的枚举值（allow / blocked / medium）
	// 都很短，真正的结论句一定是最长的那个。
	proseField, prose := "", ""
	for key, raw := range parsed {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			continue
		}
		trimmedValue := strings.TrimSpace(value)
		if len(trimmedValue) > len(prose) {
			proseField, prose = key, trimmedValue
		}
	}

	body := &StructuredBody{Prose: prose, ProseField: proseField}
	for key, raw := range parsed {
		if key == proseField {
			continue
		}
		if field, ok := describeStructuredField(key, raw); ok {
			body.Fields = append(body.Fields, field)
		}
	}
	// 字段顺序按 key 排，摘要行才稳定。
	sort.Slice(body.Fields, func(i, j int) bool { return body.Fields[i].Key < body.Fields[j].Key })
	if body.Prose == "" && len(body.Fields) == 0 {
		return nil
	}
	return body
}

// describeStructuredField 把一个非正文字段归纳成摘要行。
func describeStructuredField(key string, raw json.RawMessage) (StructuredField, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return StructuredField{Key: key, Kind: structuredKindScalar, Value: "null"}, true
	}
	switch trimmed[0] {
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return StructuredField{}, false
		}
		return StructuredField{Key: key, Kind: structuredKindArray, Count: len(items), Detail: prettyJSONOrEmpty(items)}, true
	case '{':
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return StructuredField{}, false
		}
		return StructuredField{Key: key, Kind: structuredKindObject, Count: len(fields), Detail: prettyJSONOrEmpty(fields)}, true
	}
	var scalar string
	if err := json.Unmarshal(raw, &scalar); err == nil {
		return StructuredField{Key: key, Kind: structuredKindScalar, Value: scalar}, true
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err == nil {
		return StructuredField{Key: key, Kind: structuredKindScalar, Value: strconv.FormatFloat(number, 'f', -1, 64)}, true
	}
	var flag bool
	if err := json.Unmarshal(raw, &flag); err == nil {
		return StructuredField{Key: key, Kind: structuredKindScalar, Value: strconv.FormatBool(flag)}, true
	}
	return StructuredField{}, false
}

// prettyJSONOrEmpty 缩进展开，便于浏览端直接展示；失败时留空。
func prettyJSONOrEmpty(value any) string {
	text, err := prettyJSON(value)
	if err != nil {
		return ""
	}
	return text
}
