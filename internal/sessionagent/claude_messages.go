package sessionagent

// 本文件是 Claude Code 消息解析：user/assistant/tool_use/tool_result
// 映射为统一消息块。映射参考 cc-switch session_manager/providers/claude.rs。

import (
	"encoding/json"
	"strconv"
	"strings"
)

// ParseClaudeMessages 把 Claude jsonl 解析为统一消息流（含块与轮次）。
// isMeta / isSidechain / attachment 等记录跳过，坏行静默忽略。
func ParseClaudeMessages(path string) ([]SessionMessage, []TurnIndex, error) {
	reader, err := OpenRollout(path)
	if err != nil {
		return nil, nil, err
	}
	defer reader.Close()

	p := &claudeParser{
		callIndex: map[string]callSite{},
	}
	// LineSpans 记录每行字节区间，供 ContentRef 按需定位（同 codex）。
	spans := NewLineSpans(reader)
	for {
		line, span, ok := spans.Next()
		if !ok {
			break
		}
		p.processLine(line, span)
	}
	if err := spans.Err(); err != nil {
		return p.messages, BuildTurns(p.messages), err
	}
	return p.messages, BuildTurns(p.messages), nil
}

type claudeParser struct {
	messages  []SessionMessage
	callIndex map[string]callSite
	// lineSpan 是当前处理行的字节区间，构造 ContentRef 时写入。
	lineSpan LineSpan
}

// lineRef 构造指向当前行内 pointer 的内容引用（携带字节区间）。
func (p *claudeParser) lineRef(pointer string) *ContentRef {
	ref := p.lineSpan.ContentRef(pointer)
	return &ref
}

func (p *claudeParser) processLine(line string, span LineSpan) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return
	}
	p.lineSpan = span
	var item claudeLine
	if err := json.Unmarshal([]byte(trimmed), &item); err != nil {
		return
	}
	if item.IsMeta || item.IsSidechain {
		return
	}
	switch item.Type {
	case "user", "assistant":
		p.onMessage(item)
	}
}

func (p *claudeParser) onMessage(item claudeLine) {
	if item.Message == nil {
		return
	}
	var msg claudeMessage
	if err := json.Unmarshal(item.Message, &msg); err != nil {
		return
	}
	role := RoleUser
	if msg.Role == "assistant" {
		role = RoleAssistant
	} else if msg.Role == "system" {
		role = RoleSystem
	}

	for idx, c := range claudeMessageContentItems(msg.Content) {
		switch c.Type {
		case "text":
			text := strings.TrimSpace(c.Text)
			if text == "" {
				continue
			}
			injected := claudeIsInjectedText(text)
			// 剥 system-reminder 壳。
			text = stripSystemReminders(text)
			if text == "" {
				continue
			}
			p.pushMessage(role, text, injected)
		case "thinking", "redacted_thinking":
			block := ThinkingBlock{
				Text:     TruncateRunes(strings.TrimSpace(c.Text), ThinkingPreviewChars),
				Redacted: c.Type == "redacted_thinking" || strings.TrimSpace(c.Text) == "",
			}
			if block.Text == "" {
				block.Redacted = true
			}
			p.pushBlock(SessionBlock{Type: BlockThinking, Thinking: &block})
		case "tool_use":
			kind, title, detail := classifyClaudeTool(c.Name, c.Input)
			block := ToolCallBlock{
				ID:            c.ID,
				RawName:       c.Name,
				Kind:          kind,
				Title:         title,
				Detail:        detail,
				InputPreview:  TruncateRunes(string(c.Input), InputPreviewChars),
				InputTotalLen: uint32(len([]rune(string(c.Input)))),
			}
			if block.InputTotalLen > uint32(len([]rune(block.InputPreview))) {
				block.InputFull = p.lineRef("/message/content")
			}
			idx := p.pushBlock(SessionBlock{Type: BlockToolCall, ToolCall: &block})
			p.callIndex[block.ID] = callSite{
				msgIdx:   len(p.messages) - 1,
				blockIdx: idx,
			}
		case "tool_result":
			// 结果配对键是 tool_use_id（Claude 约定），id 是兜底。
			callID := firstNonEmpty(c.ToolUseID, c.ID)
			result := ToolResultBlock{
				CallID: callID,
				Status: ToolStatusSuccess,
			}
			// 工具输出写在 content 字段（不是 text）：可能是字符串，也可能是
			// [{type:text,text}]。旧实现读 c.Text，两种形态都取不到，工具
			// 输出在界面上彻底不可达。
			preview := MakePreview(stripSystemReminders(strings.TrimSpace(claudeToolResultText(c.Content))))
			result.Preview = preview.Text
			result.TotalLen = preview.TotalLen
			result.LineCount = preview.LineCount
			result.Truncated = preview.Truncated
			if preview.Truncated {
				result.Full = p.lineRef("/message/content")
			}
			site, ok := p.callIndex[callID]
			if ok {
				msg := &p.messages[site.msgIdx]
				msg.Blocks = append(msg.Blocks, SessionBlock{Type: BlockToolResult, ToolResult: &result})
				delete(p.callIndex, callID)
			} else {
				p.pushMessage(RoleTool, "", false)
				p.messages[len(p.messages)-1].Blocks = append(
					p.messages[len(p.messages)-1].Blocks,
					SessionBlock{Type: BlockToolResult, ToolResult: &result},
				)
			}
		case "image":
			p.pushBlock(SessionBlock{Type: BlockImage, Image: claudeImageRef(c, p, idx)})
		}
	}
}

// claudeToolResultText 取 tool_result 的正文。Claude 把工具输出写在
// content 字段：可能是字符串，也可能是 [{type:text,text}] 内容项数组。
func claudeToolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var parts []string
	for _, item := range claudeMessageContentItems(raw) {
		if text := strings.TrimSpace(item.Text); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}

// claudeImageRef 解析 Claude 图片块。
//
// 真实形态是 {"type":"image","source":{"type":"base64","media_type":
// "image/png","data":"..."}} 或 {"type":"file","path":"..."}。旧实现读
// c.Text，图片正文与路径都取不到，粘贴的截图在界面上不显示。
// base64 走内联引用（ContentRef 指向行内 /source/data），文件走本机路径。
func claudeImageRef(c claudeMessageContent, p *claudeParser, index int) *ImageRef {
	ref := &ImageRef{Source: ImageLocalFile}
	if len(c.Source) == 0 {
		return ref
	}
	var source claudeImageSource
	if err := json.Unmarshal(c.Source, &source); err != nil {
		return ref
	}
	ref.MediaType = source.MediaType
	switch source.Type {
	case "base64":
		ref.Source = ImageInline
		ref.Size = uint32(len(source.Data))
		if source.Data != "" {
			ref.Content = p.lineRef("/message/content/" + strconv.Itoa(index) + "/source/data")
		}
	case "file":
		ref.Path = source.Path
	case "url":
		ref.Path = source.URL
	}
	return ref
}

// stripSystemReminders 剥离 <system-reminder>…</system-reminder> 壳。
func stripSystemReminders(text string) string {
	result := text
	for {
		start := strings.Index(result, "<system-reminder>")
		if start < 0 {
			break
		}
		end := strings.Index(result[start:], "</system-reminder>")
		if end < 0 {
			result = result[:start]
			break
		}
		result = result[:start] + result[start+end+len("</system-reminder>"):]
	}
	return strings.TrimSpace(result)
}

// pushMessage 把消息追加到流（assistant 纯文本可合并进前一条）。
func (p *claudeParser) pushMessage(role MessageRole, text string, injected bool) {
	if role == RoleAssistant && !injected && len(p.messages) > 0 {
		last := &p.messages[len(p.messages)-1]
		if last.Role == role && strings.TrimSpace(last.Content) == "" && len(last.Blocks) > 0 {
			last.Content = text
			last.Structured = splitStructuredBody(text)
			return
		}
	}
	p.messages = append(p.messages, SessionMessage{
		Role:     role,
		Content:  text,
		Injected: injected,
		// 整条正文是 JSON 对象时（子 Agent 的结构化结论）拆出正文与字段摘要。
		Structured: structuredBodyOf(text, injected),
	})
}

// structuredBodyOf 是 splitStructuredBody 的注入内容版本：注入内容是工具
// 塞给模型的上下文，不是给人看的结论，不做结构化拆解。
func structuredBodyOf(text string, injected bool) *StructuredBody {
	if injected {
		return nil
	}
	return splitStructuredBody(text)
}

// pushBlock 把块追加到当前 assistant 消息。
func (p *claudeParser) pushBlock(block SessionBlock) int {
	if len(p.messages) > 0 {
		last := p.messages[len(p.messages)-1]
		if last.Role == RoleAssistant {
			p.messages[len(p.messages)-1].Blocks = append(last.Blocks, block)
			return len(p.messages[len(p.messages)-1].Blocks) - 1
		}
	}
	p.messages = append(p.messages, SessionMessage{
		Role:   RoleAssistant,
		Blocks: []SessionBlock{block},
	})
	return 0
}

// classifyClaudeTool 按工具名与参数推断分类与标题。
func classifyClaudeTool(name string, args json.RawMessage) (ToolKind, string, string) {
	lower := strings.ToLower(name)
	var parsed map[string]json.RawMessage
	_ = json.Unmarshal(args, &parsed)
	argString := func(key string) string {
		if raw, ok := parsed[key]; ok {
			var s string
			if json.Unmarshal(raw, &s) == nil {
				return strings.TrimSpace(s)
			}
		}
		return ""
	}

	switch lower {
	case "bash", "shell":
		cmd := firstNonEmpty(argString("command"), argString("cmd"))
		return ToolShell, OneLineTitle(cmd), argString("description")
	case "read", "view":
		return ToolRead, TruncateRunes(firstNonEmpty(argString("file_path"), argString("path"), name), TitleChars), ""
	case "edit", "multiedit":
		return ToolEdit, TruncateRunes(firstNonEmpty(argString("file_path"), argString("path"), name), TitleChars), ""
	case "write":
		return ToolWrite, TruncateRunes(firstNonEmpty(argString("file_path"), argString("path"), name), TitleChars), ""
	case "grep", "glob":
		return ToolSearch, TruncateRunes(firstNonEmpty(argString("pattern"), name), TitleChars), ""
	case "websearch", "webfetch":
		return ToolWeb, TruncateRunes(firstNonEmpty(argString("query"), argString("url"), name), TitleChars), ""
	case "todowrite", "todoread":
		return ToolTodo, TruncateRunes(name, TitleChars), ""
	case "task":
		return ToolAgent, TruncateRunes(firstNonEmpty(argString("description"), name), TitleChars), ""
	case "askuserquestion":
		return ToolAsk, TruncateRunes(name, TitleChars), ""
	default:
		return ToolOther, TruncateRunes(name, TitleChars), ""
	}
}
