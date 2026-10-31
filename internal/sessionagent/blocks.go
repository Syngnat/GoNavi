package sessionagent

// 本文件是各工具适配器共用的块构造与截断工具。常量与规则参考
// cc-switch session_manager/providers/blocks.rs。

import (
	"strings"
)

// ─── 预览截断 ───

// Preview 是文本截断结果。
type Preview struct {
	Text      string
	TotalLen  uint32
	LineCount uint32
	Truncated bool
}

// MakePreview 按“先切 PreviewLines 行、再切 PreviewChars 字符”生成
// 预览：与 cc-switch preview_with 的双预算规则一致。
func MakePreview(text string) Preview {
	lineCount := uint32(strings.Count(text, "\n") + 1)
	if text == "" {
		lineCount = 0
	}
	totalLen := uint32(len([]rune(text)))
	cut := text
	truncated := false

	// 先在第 PreviewLines 个换行处切。
	if idx := indexNthNewline(cut, PreviewLines); idx >= 0 {
		cut = cut[:idx]
		truncated = true
	}
	// 再按字符数切。
	runes := []rune(cut)
	if len(runes) > PreviewChars {
		cut = string(runes[:PreviewChars])
		truncated = true
	}
	cut = strings.TrimRight(cut, "\r\n")
	if cut == "" && !truncated {
		cut = strings.TrimRight(text, "\r\n")
	}
	return Preview{Text: cut, TotalLen: totalLen, LineCount: lineCount, Truncated: truncated}
}

// indexNthNewline 返回第 n 个换行符的下标（1-based 计数），不足返回 -1。
func indexNthNewline(s string, n int) int {
	count := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			count++
			if count == n {
				return i
			}
		}
	}
	return -1
}

// OneLineTitle 取首行作单行标题：超 TitleChars 或有后续行时加省略号。
func OneLineTitle(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}
	first := trimmed
	hasMore := false
	if i := strings.IndexAny(first, "\r\n"); i >= 0 {
		first = first[:i]
		hasMore = true
	}
	runes := []rune(first)
	if len(runes) > TitleChars {
		return string(runes[:TitleChars]) + "…"
	}
	if hasMore {
		return first + "…"
	}
	return first
}

// TruncateRunes 按字符数截断并加省略号；空输入返回空串。
func TruncateRunes(text string, max int) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= max {
		return string(runes)
	}
	return string(runes[:max]) + "…"
}

// FoldWhitespace 把连续空白折叠成单个空格并修剪两端。
func FoldWhitespace(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

// ─── diff 统计 ───

// CountDiffLines 统计 diff 文本的新增/删除行数（跳过 +++/--- 头行，
// `+`/`-` 开头计数；`+12 ` 编号形态同样计数）。
func CountDiffLines(diff string) (added, removed uint32) {
	for _, line := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "---"):
			continue
		case strings.HasPrefix(line, "+"):
			added++
		case strings.HasPrefix(line, "-"):
			removed++
		}
	}
	return added, removed
}

// DiffKind 按增删统计推断改动类型：全新增视为 Add，否则 Update。
func DiffKind(added, removed uint32) DiffOp {
	if added > 0 && removed == 0 {
		return DiffAdd
	}
	return DiffUpdate
}

// DiffTitle 单文件给路径，多文件给“首路径 等 N 个文件”。
func DiffTitle(files []DiffFile) string {
	if len(files) == 0 {
		return ""
	}
	if len(files) == 1 {
		return TruncateRunes(files[0].Path, TitleChars)
	}
	return TruncateRunes(files[0].Path, TitleChars-16) + " 等 " + itoa(len(files)) + " 个文件"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// ─── 轮次构建 ───

// BuildTurns 按消息流生成轮次索引。规则与 cc-switch build_turns 一致：
//   - 消息有 TurnID 用之；否则“真实提问”（user、非注入、非空）开新轮
//     t{n}；其余沿用当前轮。
//   - questionPreview 取该轮首个非注入提问文本，空白折叠、80 字符封顶。
//   - stepCount = ToolCall 数；errorCount = Error 结果数；
//     hasFinalReply 由消息级状态机决定（非空 assistant Text 置位、
//     ToolCall 复位，最后消息状态为准）；aborted = Aborted 事件。
//   - 全注入的轮次从索引剔除。
func BuildTurns(messages []SessionMessage) []TurnIndex {
	type turnAcc struct {
		first, last int
		turnID      string
		question    string
		ts          int64
		steps       uint32
		errors      uint32
		hasFinal    bool
		aborted     bool
		allInjected bool
	}
	var turns []*turnAcc
	turnOf := map[int]int{} // 消息下标 → turns 下标
	counter := 0

	for i, msg := range messages {
		key := msg.TurnID
		if key == "" {
			if msg.Role == RoleUser && !msg.Injected && strings.TrimSpace(msg.Content) != "" {
				counter++
				key = "t" + itoa(counter)
			} else if len(turns) > 0 {
				key = turns[len(turns)-1].turnID
			} else {
				key = "t0"
			}
		}
		if len(turns) == 0 || turns[len(turns)-1].turnID != key {
			turns = append(turns, &turnAcc{
				first: i, last: i, turnID: key,
				ts: msg.Timestamp, allInjected: true,
			})
		}
		acc := turns[len(turns)-1]
		acc.last = i
		turnOf[i] = len(turns) - 1
		if acc.ts == 0 {
			acc.ts = msg.Timestamp
		}
		if !msg.Injected {
			acc.allInjected = false
		}
		isQuestion := msg.Role == RoleUser && !msg.Injected && strings.TrimSpace(msg.Content) != ""
		if isQuestion && acc.question == "" {
			acc.question = TruncateRunes(FoldWhitespace(msg.Content), QuestionPreviewChars)
		}
		for _, block := range msg.Blocks {
			switch block.Type {
			case BlockToolCall:
				acc.steps++
				acc.hasFinal = false
			case BlockToolResult:
				if block.ToolResult != nil && block.ToolResult.Status == ToolStatusError {
					acc.errors++
				}
			case BlockEvent:
				if block.Event != nil && block.Event.Kind == EventAborted {
					acc.aborted = true
				}
			case BlockText:
				if msg.Role == RoleAssistant && block.Text != nil && strings.TrimSpace(block.Text.Text) != "" {
					acc.hasFinal = true
				}
			}
		}
		// 助手正文无论以块还是以 Content 承载，都算「有最终回复」：
		// 解析器会把助手正文并进已有 thinking/tool_call 块的那条消息，
		// 这时块数不为 0，旧的 len(Blocks)==0 判断会漏判，轮次索引里
		// hasFinalReply 几乎恒为 false。
		if msg.Role == RoleAssistant && strings.TrimSpace(msg.Content) != "" {
			acc.hasFinal = true
		}
	}

	indices := make([]TurnIndex, 0, len(turns))
	for _, acc := range turns {
		if acc.allInjected {
			continue
		}
		indices = append(indices, TurnIndex{
			TurnID:          acc.turnID,
			FirstMessageIdx: acc.first,
			LastMessageIdx:  acc.last,
			QuestionPreview: acc.question,
			Timestamp:       acc.ts,
			StepCount:       acc.steps,
			ErrorCount:      acc.errors,
			HasFinalReply:   acc.hasFinal,
			Aborted:         acc.aborted,
		})
	}
	return indices
}
