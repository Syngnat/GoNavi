package sessionagent

// 本文件是 Codex rollout 消息解析：逐行把 response_item / event_msg
// 等记录映射为统一消息块。映射表与容错边界参考 cc-switch
// session_manager/providers/codex.rs 状态机，简化为 Go 版：
//   - call → output → item_completed 三态：工具调用先记位置，输出到达
//     后配对产出 ToolResult，结构化项（item_completed）回填标题/改动；
//   - 迟到 item_completed 只补字段，不重复出块；
//   - 文件尾截断的调用不出假结果（前端显示进行中）。

import (
	"encoding/json"
	"strconv"
	"strings"
)

// codexParser 是 rollout 解析状态机。
type codexParser struct {
	messages []SessionMessage
	// pendingCalls：等待输出的工具调用（callID → 消息下标/块下标）。
	pendingCalls map[string]callSite
	// finishedCalls：已有结果的调用，迟到 item 只补字段。
	finishedCalls map[string]callSite
	turnID        string
	lastModel     string
	turnModels    map[string]string
	lastWebSearch string
	// lineSpan 是当前处理行的字节区间，构造 ContentRef 时写入。
	lineSpan LineSpan
}

type callSite struct {
	msgIdx   int
	blockIdx int
	flavor   string // shell / mcp / patch / web / other
	command  string
	outputs  int // 已产出的结果块个数（多命令拆分用）
}

// ParseCodexMessages 把 rollout 文件解析为统一消息流（含块与轮次）。
// 坏行静默跳过，未知类型忽略，不中断整体解析。
func ParseCodexMessages(path string) ([]SessionMessage, []TurnIndex, error) {
	reader, err := OpenRollout(path)
	if err != nil {
		return nil, nil, err
	}
	defer reader.Close()

	p := &codexParser{
		pendingCalls:  map[string]callSite{},
		finishedCalls: map[string]callSite{},
		turnModels:    map[string]string{},
	}
	// LineSpans 记录每行的字节区间：解析时即写入 ContentRef 的
	// Offset/Length，前端按需取全文时 O(1) seek（cc-switch 方案核心）。
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
	p.flushPending("finished")
	return p.messages, BuildTurns(p.messages), nil
}

// lineRef 构造指向当前行内 pointer 的内容引用（携带字节区间）。
func (p *codexParser) lineRef(pointer string) *ContentRef {
	ref := p.lineSpan.ContentRef(pointer)
	return &ref
}

// processLine 处理单行 rollout 记录；span 是该行的字节区间，供
// ContentRef 精确定位。
func (p *codexParser) processLine(line string, span LineSpan) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return
	}
	p.lineSpan = span
	var item rolloutLine
	if err := json.Unmarshal([]byte(trimmed), &item); err != nil {
		return // 坏行静默跳过
	}
	switch item.Type {
	case "response_item":
		p.onResponseItem(item.Payload)
	case "event_msg":
		p.onEventMsg(item.Payload)
	case "turn_context":
		p.onTurnContext(item.Payload)
	case "compacted":
		p.appendEvent(EventCompaction, "上下文已压缩", "")
	}
}

func (p *codexParser) onTurnContext(raw json.RawMessage) {
	var payload struct {
		TurnID string `json:"turn_id"`
		Model  string `json:"model"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return
	}
	if payload.TurnID != "" {
		p.flushPending("turn")
		p.turnID = payload.TurnID
	}
	if payload.Model != "" {
		p.lastModel = payload.Model
	}
}

func (p *codexParser) onEventMsg(raw json.RawMessage) {
	var payload struct {
		Type string `json:"type"`
		Info struct {
			Model string `json:"model"`
		} `json:"info"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return
	}
	switch payload.Type {
	case "turn_aborted":
		p.flushPending("aborted")
	case "task_complete":
		p.flushPending("task")
	}
}

// onResponseItem 分发 response_item payload 的 type。
func (p *codexParser) onResponseItem(raw json.RawMessage) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return
	}
	switch head.Type {
	case "message":
		p.onMessage(raw)
	case "reasoning":
		p.onReasoning(raw)
	case "function_call":
		p.onFunctionCall(raw)
	case "custom_tool_call":
		p.onCustomToolCall(raw)
	case "function_call_output", "custom_tool_call_output":
		p.onOutput(raw)
	case "web_search_call":
		p.onWebSearch(raw)
	case "compaction":
		p.appendEvent(EventCompaction, "上下文已压缩", "")
	}
}

// ─── message ───

func (p *codexParser) onMessage(raw json.RawMessage) {
	var payload struct {
		Role    string `json:"role"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return
	}
	var realText, injectedText strings.Builder
	for _, c := range payload.Content {
		text := strings.TrimSpace(c.Text)
		if text == "" {
			continue
		}
		if isInjectedUserText(text) {
			if injectedText.Len() > 0 {
				injectedText.WriteString("\n\n")
			}
			injectedText.WriteString(text)
		} else {
			if realText.Len() > 0 {
				realText.WriteString("\n\n")
			}
			realText.WriteString(text)
		}
	}

	role := RoleUser
	// Codex 的 developer/system 消息装的是工具链自己的上下文（skills 指令、
	// 权限说明、审批记录「Approved command prefix saved」、hook 事件、工具
	// 目录更新等），不是对话内容。一律按注入隐藏，否则会话详情会被这些
	// harness 噪音淹没。
	alwaysInjected := false
	switch payload.Role {
	case "assistant":
		role = RoleAssistant
	case "developer", "system":
		role = RoleSystem
		alwaysInjected = true
	case "tool":
		role = RoleTool
	}

	// 真实内容与注入内容分成两条消息。
	if realText.Len() > 0 && !alwaysInjected {
		p.pushMessage(role, realText.String(), false)
	}
	if alwaysInjected {
		if realText.Len() > 0 {
			if injectedText.Len() > 0 {
				injectedText.WriteString("\n\n")
			}
			injectedText.WriteString(realText.String())
		}
	}
	if injectedText.Len() > 0 {
		p.pushMessage(role, injectedText.String(), true)
	}
}

func (p *codexParser) pushMessage(role MessageRole, text string, injected bool) {
	msg := SessionMessage{
		Role:      role,
		Content:   text,
		TurnID:    p.turnID,
		Injected:  injected,
		Timestamp: 0,
	}
	// 超长折叠文本改预览 + ContentRef（只对注入内容；真实正文渲染完整）。
	if injected && len([]rune(text)) > InlineTextMaxChars {
		preview := MakePreview(text)
		msg.Blocks = []SessionBlock{{
			Type: BlockText,
			Text: &TextBlock{
				Text: preview.Text,
				Full: p.lineRef("/payload/content"),
			},
		}}
		msg.Content = preview.Text
	}
	// 整条正文是 JSON 对象时（子 Agent 的结构化结论）拆出正文与字段摘要。
	if !injected {
		msg.Structured = splitStructuredBody(text)
	}
	// assistant 纯思考消息合并进上一条。
	if role == RoleAssistant && !injected && len(p.messages) > 0 {
		last := &p.messages[len(p.messages)-1]
		if last.Role == RoleAssistant && strings.TrimSpace(last.Content) == "" && len(last.Blocks) > 0 {
			last.Content = text
			last.Structured = splitStructuredBody(text)
			return
		}
	}
	p.messages = append(p.messages, msg)
}

// ─── reasoning ───

func (p *codexParser) onReasoning(raw json.RawMessage) {
	var payload struct {
		Summary []struct {
			Text string `json:"text"`
		} `json:"summary"`
		Content          string `json:"content"`
		EncryptedContent string `json:"encrypted_content"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return
	}
	var summaryParts []string
	for _, s := range payload.Summary {
		if t := strings.TrimSpace(s.Text); t != "" {
			summaryParts = append(summaryParts, t)
		}
	}
	summary := strings.Join(summaryParts, "\n\n")
	body := strings.TrimSpace(payload.Content)
	redacted := summary == "" && body == ""
	if redacted && payload.EncryptedContent != "" {
		redacted = true
	}

	block := ThinkingBlock{
		Summary:  summary,
		Redacted: redacted,
	}
	if body != "" {
		block.Text = TruncateRunes(body, ThinkingPreviewChars)
		if len([]rune(body)) > ThinkingPreviewChars {
			block.Full = p.lineRef("/payload/content")
		}
	}
	// 连续 redacted 思考去重。
	if redacted && len(p.messages) > 0 {
		last := &p.messages[len(p.messages)-1]
		for _, b := range last.Blocks {
			if b.Type == BlockThinking && b.Thinking != nil && b.Thinking.Redacted {
				return
			}
		}
	}
	p.pushBlock(SessionBlock{Type: BlockThinking, Thinking: &block})
}

// ─── 工具调用 ───

func (p *codexParser) onFunctionCall(raw json.RawMessage) {
	var payload struct {
		Name      string          `json:"name"`
		Namespace string          `json:"namespace"`
		CallID    string          `json:"call_id"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return
	}
	name := strings.TrimSpace(payload.Name)
	kind, title, detail := classifyCodexTool(name, payload.Namespace, payload.Arguments)
	site := callSite{flavor: string(kind), command: detail}

	// 预览用剥壳后的参数文本：原始 arguments 是「JSON 字符串里套 JSON」，
	// 直接展示会是一整屏转义引号。
	argsText := codexToolArgsText(payload.Arguments)
	block := ToolCallBlock{
		ID:            firstNonEmpty(payload.CallID, name),
		RawName:       name,
		Kind:          kind,
		Title:         title,
		Detail:        detail,
		InputPreview:  TruncateRunes(argsText, InputPreviewChars),
		InputTotalLen: uint32(len([]rune(argsText))),
	}
	if block.InputTotalLen > uint32(len([]rune(block.InputPreview))) {
		block.InputFull = p.lineRef("/payload/arguments")
	}
	idx := p.pushBlock(SessionBlock{Type: BlockToolCall, ToolCall: &block})
	p.pendingCalls[block.ID] = callSite{
		msgIdx:   len(p.messages) - 1,
		blockIdx: idx,
		flavor:   site.flavor,
		command:  site.command,
	}
}

func (p *codexParser) onCustomToolCall(raw json.RawMessage) {
	var payload struct {
		Name   string          `json:"name"`
		CallID string          `json:"call_id"`
		Input  json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return
	}
	name := strings.TrimSpace(payload.Name)
	if name == "apply_patch" {
		p.onApplyPatch(payload.CallID, string(payload.Input))
		return
	}
	// 新版 Codex 常把 apply_patch 包在 exec 自由文本里。能抽出真实 patch
	// 时按 diff 处理；抽不出时仍走普通 shell/exec 分类。
	if patch := codexExtractApplyPatch(codexToolArgsText(payload.Input)); patch != "" {
		p.onApplyPatch(payload.CallID, patch)
		return
	}
	kind, title, detail := classifyCodexTool(name, "", payload.Input)
	inputText := codexToolArgsText(payload.Input)
	block := ToolCallBlock{
		ID:            firstNonEmpty(payload.CallID, name),
		RawName:       name,
		Kind:          kind,
		Title:         title,
		Detail:        detail,
		InputPreview:  TruncateRunes(inputText, InputPreviewChars),
		InputTotalLen: uint32(len([]rune(inputText))),
	}
	if block.InputTotalLen > uint32(len([]rune(block.InputPreview))) {
		block.InputFull = p.lineRef("/payload/input")
	}
	idx := p.pushBlock(SessionBlock{Type: BlockToolCall, ToolCall: &block})
	p.pendingCalls[block.ID] = callSite{
		msgIdx:   len(p.messages) - 1,
		blockIdx: idx,
		flavor:   string(kind),
	}
}

func (p *codexParser) onApplyPatch(callID, input string) {
	files := ParseApplyPatchFiles(input)
	added, removed := CountDiffLines(input)
	// patch 文本既是 diff 也是工具输入：给改动页一份预览，截断时挂
	// 全文引用供展开加载。
	preview := MakePreview(input)
	diff := &DiffSummary{
		Files:   files,
		Added:   added,
		Removed: removed,
		Full:    p.lineRef("/payload/input"),
	}
	block := ToolCallBlock{
		ID:            firstNonEmpty(callID, "apply_patch"),
		RawName:       "apply_patch",
		Kind:          ToolDiff,
		Title:         DiffTitle(files),
		InputPreview:  preview.Text,
		InputTotalLen: preview.TotalLen,
		Diff:          diff,
	}
	if len([]rune(input)) <= MaxInlineTextChars {
		// patch 文本就是改动内容本身，直接内联给改动页完整渲染；
		// 不内联会话源里的 exec 包装脚本，避免展示多余包装。
		block.InputText = input
	} else {
		block.InputFull = p.lineRef("/payload/input")
	}
	if added > 0 && removed == 0 {
		block.Kind = ToolWrite
	}
	idx := p.pushBlock(SessionBlock{Type: BlockToolCall, ToolCall: &block})
	p.pendingCalls[block.ID] = callSite{
		msgIdx:   len(p.messages) - 1,
		blockIdx: idx,
		flavor:   "patch",
	}
}

// ParseApplyPatchFiles 从 apply_patch 输入提取改动文件列表，并按文件
// 统计 +/- 行数（文件头之后、下一文件头之前，以 + / - 开头的行）。
func ParseApplyPatchFiles(input string) []DiffFile {
	var files []DiffFile
	var current *DiffFile
	addFile := func(path string, op DiffOp) {
		if path == "" || path == "/dev/null" {
			return
		}
		files = append(files, DiffFile{Path: path, Op: op})
		current = &files[len(files)-1]
	}
	for _, line := range strings.Split(input, "\n") {
		switch {
		case strings.HasPrefix(line, "+++ "):
			addFile(strings.TrimSpace(strings.TrimPrefix(line, "+++ ")), DiffUpdate)
		case strings.HasPrefix(line, "*** Add File: "):
			addFile(strings.TrimSpace(strings.TrimPrefix(line, "*** Add File: ")), DiffAdd)
		case strings.HasPrefix(line, "*** Update File: "):
			addFile(strings.TrimSpace(strings.TrimPrefix(line, "*** Update File: ")), DiffUpdate)
		case strings.HasPrefix(line, "*** Delete File: "):
			addFile(strings.TrimSpace(strings.TrimPrefix(line, "*** Delete File: ")), DiffDelete)
		case strings.HasPrefix(line, "*** Move to: "):
			// rename 的目标路径，不新增条目。
		default:
			if current == nil {
				continue
			}
			switch {
			case strings.HasPrefix(line, "+"):
				current.Added++
			case strings.HasPrefix(line, "-"):
				current.Removed++
			}
		}
	}
	return files
}

// ─── 输出 ───

func (p *codexParser) onOutput(raw json.RawMessage) {
	var payload struct {
		CallID string          `json:"call_id"`
		Output json.RawMessage `json:"output"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return
	}
	text := extractOutputText(payload.Output)
	preview := MakePreview(text)

	result := ToolResultBlock{
		CallID:    payload.CallID,
		Status:    ToolStatusSuccess,
		Preview:   preview.Text,
		TotalLen:  preview.TotalLen,
		LineCount: preview.LineCount,
		Truncated: preview.Truncated,
	}
	if preview.Truncated {
		result.Full = p.lineRef("/payload/output")
	}
	if code, ok := extractExitCode(payload.Output); ok {
		result.ExitCode = &code
		if code != 0 {
			result.Status = ToolStatusError
		}
	}

	site, ok := p.pendingCalls[payload.CallID]
	if !ok {
		// 无对应调用：独立结果块（role=tool）。
		p.pushMessage(RoleTool, "", false)
		p.messages[len(p.messages)-1].Blocks = append(
			p.messages[len(p.messages)-1].Blocks,
			SessionBlock{Type: BlockToolResult, ToolResult: &result},
		)
		return
	}
	// 配对产出：结果块紧跟调用块（同一条消息内）。
	msg := &p.messages[site.msgIdx]
	msg.Blocks = append(msg.Blocks, SessionBlock{Type: BlockToolResult, ToolResult: &result})
	delete(p.pendingCalls, payload.CallID)
	p.finishedCalls[payload.CallID] = site
}

// extractOutputText 把 output（字符串或内容项数组）提取为纯文本。
func extractOutputText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return stripOutputHeader(text)
	}
	var items []struct {
		Text  string `json:"text"`
		Image string `json:"image_url"`
	}
	if err := json.Unmarshal(raw, &items); err == nil {
		var parts []string
		for _, item := range items {
			if t := strings.TrimSpace(item.Text); t != "" {
				parts = append(parts, stripOutputHeader(t))
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// stripOutputHeader 剥离命令输出头部（"Script completed" / "Wall time" /
// "Process exited with code N" 等）。
func stripOutputHeader(text string) string {
	lines := strings.Split(text, "\n")
	cut := 0
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "Output:" {
			cut = i + 1
			break
		}
		if strings.HasPrefix(trimmed, "Script completed") ||
			strings.HasPrefix(trimmed, "Script failed") ||
			strings.HasPrefix(trimmed, "Wall time") ||
			strings.HasPrefix(trimmed, "Process exited with code") ||
			strings.HasPrefix(trimmed, "Exit code") {
			cut = i + 1
			continue
		}
		if i < 8 {
			continue // 头部区域只看前若干行
		}
		break
	}
	return strings.TrimSpace(strings.Join(lines[cut:], "\n"))
}

func extractExitCode(raw json.RawMessage) (int, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var legacy struct {
		Metadata struct {
			ExitCode int `json:"exit_code"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(raw, &legacy); err == nil && legacy.Metadata.ExitCode != 0 {
		return legacy.Metadata.ExitCode, true
	}
	return 0, false
}

// ─── web search / 事件 ───

func (p *codexParser) onWebSearch(raw json.RawMessage) {
	var payload struct {
		ID    string `json:"id"`
		Query string `json:"query"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return
	}
	id := payload.ID
	if id == "" {
		id = p.lastWebSearch
	}
	p.lastWebSearch = id
	call := ToolCallBlock{
		ID:      firstNonEmpty(id, "web_search"),
		RawName: "web_search",
		Kind:    ToolWeb,
		Title:   TruncateRunes(payload.Query, TitleChars),
	}
	idx := p.pushBlock(SessionBlock{Type: BlockToolCall, ToolCall: &call})
	result := ToolResultBlock{CallID: call.ID, Status: ToolStatusSuccess}
	p.messages[len(p.messages)-1].Blocks = append(
		p.messages[len(p.messages)-1].Blocks,
		SessionBlock{Type: BlockToolResult, ToolResult: &result},
	)
	_ = idx
}

func (p *codexParser) appendEvent(kind EventKind, text, url string) {
	p.pushBlock(SessionBlock{Type: BlockEvent, Event: &EventBlock{Kind: kind, Text: text, URL: url}})
}

// pushBlock 把块追加到当前消息流：assistant 语义的块进 assistant 消息。
func (p *codexParser) pushBlock(block SessionBlock) int {
	role := RoleAssistant
	if len(p.messages) > 0 {
		last := p.messages[len(p.messages)-1]
		if last.Role == role && last.TurnID == p.turnID {
			p.messages[len(p.messages)-1].Blocks = append(last.Blocks, block)
			return len(p.messages[len(p.messages)-1].Blocks) - 1
		}
	}
	p.messages = append(p.messages, SessionMessage{
		Role:   role,
		TurnID: p.turnID,
		Blocks: []SessionBlock{block},
	})
	return 0
}

// flushPending 处理未完成的工具调用：aborted → Interrupted 结果，
// 其余保持原状（前端显示进行中，不出假结果）。
func (p *codexParser) flushPending(reason string) {
	for id, site := range p.pendingCalls {
		if reason != "aborted" {
			continue
		}
		result := ToolResultBlock{CallID: id, Status: ToolStatusInterrupted}
		msg := &p.messages[site.msgIdx]
		msg.Blocks = append(msg.Blocks, SessionBlock{Type: BlockToolResult, ToolResult: &result})
		delete(p.pendingCalls, id)
	}
}

// ─── 工具分类 ───

// classifyCodexTool 按工具名、命名空间与参数推断分类、标题与详情。
//
// namespace 单独成字段（"namespace":"mcp__cua_repl"），只按 name 前缀
// 判 MCP 会漏掉全部 MCP 工具——真实记录里 name 往往只是 "js" 这类短名。
// 参数解码见 codex_tool_args.go。
func classifyCodexTool(name, namespace string, args json.RawMessage) (ToolKind, string, string) {
	lower := strings.ToLower(name)
	parsed := codexToolArgsMap(args)

	argString := func(key string) string {
		if raw, ok := parsed[key]; ok {
			var s string
			if json.Unmarshal(raw, &s) == nil {
				return strings.TrimSpace(s)
			}
		}
		return ""
	}

	ns := strings.ToLower(strings.TrimSpace(namespace))
	isMCP := strings.HasPrefix(ns, "mcp__") || strings.HasPrefix(lower, "mcp__") ||
		strings.Contains(lower, ".")

	switch {
	case lower == "exec" || lower == "exec_command" || lower == "shell" || lower == "local_shell":
		cmd := firstNonEmpty(argString("cmd"), argString("command"))
		detail := argString("workdir")
		if cmd == "" {
			// custom_tool_call 的 input 是自由文本，不是 JSON：从脚本里抠命令。
			cmds := codexCustomToolCmds(codexToolArgsText(args))
			switch len(cmds) {
			case 1:
				cmd = cmds[0]
			case 0:
				// 没有 cmd 的调用（write_stdin 之类）：标题退回被调工具名。
				if called := codexCustomToolName(codexToolArgsText(args)); called != "" {
					return ToolShell, TruncateRunes(called, TitleChars), detail
				}
			default:
				cmd = cmds[0] + " （+" + strconv.Itoa(len(cmds)-1) + " 条命令）"
			}
		}
		title := OneLineTitle(cmd)
		if title == "" {
			title = name
		}
		// 程序名是搜索类工具 → search。
		fields := strings.Fields(cmd)
		if len(fields) > 0 {
			switch fields[0] {
			case "rg", "grep", "fd", "find", "ls":
				return ToolSearch, title, detail
			}
		}
		return ToolShell, title, detail
	case isMCP:
		// MCP 工具的标题优先取参数里的 title（真实记录用它描述这次调用），
		// 其次回落到「namespace.name」。
		label := name
		if ns != "" {
			label = ns + "." + name
		}
		title := firstNonEmpty(argString("title"), label)
		detail := firstNonEmpty(argString("code"), argString("command"), argString("cmd"))
		return ToolMcp, TruncateRunes(title, TitleChars), TruncateRunes(detail, TitleChars)
	case lower == "apply_patch" || lower == "edit":
		return ToolEdit, TruncateRunes(firstNonEmpty(argString("path"), argString("file_path"), name), TitleChars), ""
	case lower == "read" || lower == "view":
		return ToolRead, TruncateRunes(firstNonEmpty(argString("path"), argString("file_path"), name), TitleChars), ""
	case lower == "write" || lower == "create_file":
		return ToolWrite, TruncateRunes(firstNonEmpty(argString("path"), argString("file_path"), name), TitleChars), ""
	case lower == "web_search" || lower == "search":
		return ToolWeb, TruncateRunes(firstNonEmpty(argString("query"), argString("url"), argString("q"), name), TitleChars), ""
	case lower == "todo" || lower == "plan":
		return ToolTodo, TruncateRunes(name, TitleChars), ""
	default:
		return ToolOther, TruncateRunes(firstNonEmpty(argString("task_name"), argString("description"), name), TitleChars), ""
	}
}
