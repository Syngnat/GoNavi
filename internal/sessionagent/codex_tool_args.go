package sessionagent

// 本文件是 Codex 工具参数的解码：真实记录里的参数是「JSON 字符串里套
// JSON」，不剥掉外层包装就解析不出来，工具行只剩一个光秃秃的工具名。

import (
	"encoding/json"
	"strings"
)

// codexToolArgsText 取出工具参数的有效 JSON 文本。
//
// Codex 的 function_call 把参数写成：
//
//	"arguments":"{\"cmd\":\"rg --files /tmp\"}"
//
// 直接按对象解析必然失败，参数（cmd/workdir/query/title…）全部读不到。
// 这里先剥掉外层字符串包装；已经是对象形态的原样返回。
func codexToolArgsText(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, `"`) {
		var unquoted string
		if err := json.Unmarshal(raw, &unquoted); err == nil {
			trimmed = strings.TrimSpace(unquoted)
		}
	}
	return trimmed
}

// codexToolArgsMap 解析工具参数为键值对；解析失败返回 nil。
func codexToolArgsMap(raw json.RawMessage) map[string]json.RawMessage {
	text := codexToolArgsText(raw)
	if text == "" {
		return nil
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return nil
	}
	return parsed
}

// ─── custom_tool_call 的自由文本输入 ───
//
// custom_tool_call 的 input 不是 JSON，而是工具调用脚本文本：
//
//	text(await tools.exec_command({cmd:"git status",max_output_tokens:13000}))
//	text(await tools.write_stdin({session_id:123}))
//	const r=await Promise.allSettled([tools.exec_command({cmd:"..."}),...])
//
// 且 name 恒为 "exec"——命令只存在于这段文本里，不抠出来的话工具行只剩
// 一个没有信息量的 "exec"。

// codexCustomToolCmds 从自由文本输入里抠出全部 shell 命令。
func codexCustomToolCmds(input string) []string {
	const marker = `cmd:"`
	var cmds []string
	rest := input
	for {
		idx := strings.Index(rest, marker)
		if idx < 0 {
			return cmds
		}
		rest = rest[idx+len(marker):]
		cmd, ok := scanQuotedJSONString(rest)
		if !ok {
			return cmds
		}
		cmds = append(cmds, cmd)
	}
}

// codexCustomToolName 取出自由文本里被调用的工具名（如 exec_command）。
func codexCustomToolName(input string) string {
	const marker = "tools."
	idx := strings.Index(input, marker)
	if idx < 0 {
		return ""
	}
	rest := input[idx+len(marker):]
	end := strings.IndexAny(rest, "({ \n")
	if end < 0 {
		return ""
	}
	return rest[:end]
}

// codexExtractApplyPatch 从 custom_tool_call 的自由文本里提取 patch 块。
//
// 新版 Codex 常把 apply_patch 包在 exec 脚本的字符串字面量里：
//
//	text(await tools.apply_patch("*** Begin Patch\n...*** End Patch"))
//
// 外层 JSON 只解一层，内部的 \n 和 \" 仍是转义形态。这里必须按字符串
// 字面量再解一层，才能看到真实的 patch 行。同一脚本可能有多段 patch；
// 只有能解析出文件时才返回，否则继续按普通 exec 处理。
func codexExtractApplyPatch(input string) string {
	const marker = "tools.apply_patch("
	var patches []string
	rest := input
	for {
		idx := strings.Index(rest, marker)
		if idx < 0 {
			break
		}
		argument := strings.TrimLeft(rest[idx+len(marker):], " \t")
		// 字面量从这里开始还带着开引号，scanQuotedJSONString 只读引号
		// 之间的内容，先把开引号跳掉。
		if !strings.HasPrefix(argument, `"`) {
			rest = argument
			continue
		}
		quoted, ok := scanQuotedJSONString(argument[len(`"`):])
		if ok {
			patch := extractSingleApplyPatch(quoted)
			if patch != "" {
				patches = append(patches, patch)
			}
		}
		rest = argument[len(`"`):]
	}
	return strings.Join(patches, "\n\n")
}

// extractSingleApplyPatch 从已解码的脚本文本中取出一个完整 patch 块。
func extractSingleApplyPatch(text string) string {
	const begin = "*** Begin Patch"
	const end = "*** End Patch"
	start := strings.Index(text, begin)
	if start < 0 {
		return ""
	}
	tail := text[start+len(begin):]
	stop := strings.Index(tail, end)
	if stop < 0 {
		return ""
	}
	patch := begin + tail[:stop+len(end)]
	if len(ParseApplyPatchFiles(patch)) == 0 {
		return ""
	}
	return patch
}

// scanQuotedJSONString 读取一个带转义的 JSON 字符串字面量内容。
func scanQuotedJSONString(s string) (string, bool) {
	var b strings.Builder
	escaped := false
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if escaped {
			switch ch {
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case 'r':
				b.WriteByte('\r')
			case '"':
				b.WriteByte('"')
			case '\\':
				b.WriteByte('\\')
			case '/':
				b.WriteByte('/')
			default:
				b.WriteByte(ch)
			}
			escaped = false
			continue
		}
		switch ch {
		case '\\':
			escaped = true
		case '"':
			return b.String(), true
		default:
			b.WriteByte(ch)
		}
	}
	return "", false
}
