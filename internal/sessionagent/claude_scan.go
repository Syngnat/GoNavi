package sessionagent

// 本文件是 Claude Code 会话扫描与元数据提取。规则参考 cc-switch
// session_manager/providers/claude.rs：~/.claude/projects/ 递归 *.jsonl，
// 标题优先级 custom-title 记录 → 首条真实用户消息 → 项目目录名。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const claudeProviderID = "claude"

// ClaudeSessionRoots 返回 Claude Code 会话目录。
func ClaudeSessionRoots(dataDir string) []string {
	if strings.TrimSpace(dataDir) == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil
		}
		dataDir = filepath.Join(home, ".claude")
	}
	return []string{filepath.Join(dataDir, "projects")}
}

// claudeParseCache 是列表级增量缓存。
var claudeParseCache = NewFileParseCache()

// ScanClaudeSessions 扫描 Claude Code 的全部会话记录，按最后活跃时间
// 倒序返回。
func ScanClaudeSessions(dataDir string) []SessionMeta {
	roots := ClaudeSessionRoots(dataDir)
	var files []string
	for _, root := range roots {
		files = append(files, collectClaudeFiles(root)...)
	}
	if len(files) == 0 {
		return nil
	}
	metas := claudeParseCache.Scan(files, parseClaudeSessionMeta)
	result := make([]SessionMeta, 0, len(metas))
	for _, meta := range metas {
		result = append(result, *meta)
	}
	sort.Slice(result, func(i, j int) bool {
		return sessionTime(result[i]) > sessionTime(result[j])
	})
	return result
}

// collectClaudeFiles 递归收集会话文件，排除 agent-* 与 journal.jsonl。
func collectClaudeFiles(root string) []string {
	var files []string
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".jsonl") {
			return nil
		}
		if strings.HasPrefix(name, "agent-") || name == "journal.jsonl" {
			return nil
		}
		files = append(files, path)
		return nil
	})
	return files
}

// claudeLine 是 Claude Code jsonl 行的最小结构。
type claudeLine struct {
	Type        string          `json:"type"`
	SessionID   string          `json:"sessionId"`
	Cwd         string          `json:"cwd"`
	Timestamp   string          `json:"timestamp"`
	IsMeta      bool            `json:"isMeta"`
	IsSidechain bool            `json:"isSidechain"`
	CustomTitle string          `json:"customTitle"`
	Message     json.RawMessage `json:"message"`
}

// claudeMessageContent 兼容两种形态：真实数据里 user 消息的 content
// 常是纯字符串，assistant/tool 结果多为内容项数组。
type claudeMessageContent struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	ToolUseID string          `json:"tool_use_id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	Content   json.RawMessage `json:"content"`
	// Source 是图片块的载荷（base64 或文件路径）。旧实现只读 Text，
	// 图片正文与路径都取不到。
	Source json.RawMessage `json:"source"`
}

// claudeImageSource 是图片块的 source 载荷。
type claudeImageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
	Path      string `json:"path"`
	URL       string `json:"url"`
}

// claudeMessageContentItems 把 message.content（字符串或数组）归一为
// 内容项列表：字符串形态转为单个 text 项。
func claudeMessageContentItems(raw json.RawMessage) []claudeMessageContent {
	if len(raw) == 0 {
		return nil
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return []claudeMessageContent{{Type: "text", Text: text}}
	}
	var items []claudeMessageContent
	if err := json.Unmarshal(raw, &items); err == nil {
		return items
	}
	return nil
}

type claudeMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// parseClaudeSessionMeta 提取列表元数据（只读头尾少量行）。
func parseClaudeSessionMeta(path string) (*SessionMeta, error) {
	lines, err := ReadHeadTailLines(path)
	if err != nil {
		return nil, err
	}
	meta := &SessionMeta{
		ProviderID: claudeProviderID,
		SourcePath: path,
	}

	// head：sessionId / cwd / custom-title / 首条用户消息。
	for _, line := range lines.Head {
		var item claudeLine
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			continue
		}
		if meta.SessionID == "" && item.SessionID != "" {
			meta.SessionID = item.SessionID
		}
		if meta.ProjectDir == "" && strings.TrimSpace(item.Cwd) != "" {
			meta.ProjectDir = strings.TrimSpace(item.Cwd)
		}
		if item.CustomTitle != "" {
			meta.Title = TruncateRunes(item.CustomTitle, TitleChars)
		}
		if meta.CreatedAt == 0 && item.Timestamp != "" {
			meta.CreatedAt = ParseTimestampMs(item.Timestamp)
		}
	}
	if meta.SessionID == "" {
		meta.SessionID = strings.TrimSuffix(filepath.Base(path), ".jsonl")
	}
	meta.ResumeCommand = "claude --resume " + meta.SessionID

	// 首条真实用户消息（跳过包装）→ FirstMessage 与标题候选。
	for _, line := range lines.Head {
		var item claudeLine
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			continue
		}
		if item.IsMeta || item.IsSidechain {
			continue
		}
		if text := claudeUserMessageText(item); text != "" {
			if meta.FirstMessage == "" {
				meta.FirstMessage = TruncateRunes(FoldWhitespace(text), SummaryChars)
			}
			if meta.Title == "" {
				meta.Title = TruncateRunes(text, TitleChars)
				break
			}
		}
	}
	if meta.Title == "" && meta.ProjectDir != "" {
		meta.Title = TruncateRunes(PathBasename(meta.ProjectDir), TitleChars)
	}

	// tail：最后活跃时间 + 摘要。
	for i := len(lines.Tail) - 1; i >= 0; i-- {
		var item claudeLine
		if err := json.Unmarshal([]byte(lines.Tail[i]), &item); err != nil {
			continue
		}
		if meta.LastActiveAt == 0 && item.Timestamp != "" {
			meta.LastActiveAt = ParseTimestampMs(item.Timestamp)
		}
		if meta.Summary == "" && item.Message != nil && !item.IsMeta {
			var msg claudeMessage
			if err := json.Unmarshal(item.Message, &msg); err == nil {
				for _, c := range claudeMessageContentItems(msg.Content) {
					text := strings.TrimSpace(c.Text)
					if text == "" || claudeIsInjectedText(text) {
						continue
					}
					meta.Summary = TruncateRunes(FoldWhitespace(text), SummaryChars)
					break
				}
			}
		}
		if meta.Summary != "" && meta.LastActiveAt != 0 {
			break
		}
	}
	if meta.LastActiveAt == 0 {
		meta.LastActiveAt = lines.FallbackLastActive
	}
	return meta, nil
}

// claudeUserMessageText 提取一行的真实用户输入。
func claudeUserMessageText(item claudeLine) string {
	if item.Message == nil || item.IsMeta {
		return ""
	}
	var msg claudeMessage
	if err := json.Unmarshal(item.Message, &msg); err != nil {
		return ""
	}
	if msg.Role != "user" {
		return ""
	}
	for _, c := range claudeMessageContentItems(msg.Content) {
		text := strings.TrimSpace(c.Text)
		if text == "" || claudeIsInjectedText(text) {
			continue
		}
		return FoldWhitespace(text)
	}
	return ""
}

// claudeIsInjectedText 判断 Claude 用户消息是否为注入包装。
func claudeIsInjectedText(text string) bool {
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "<local-command-caveat>") ||
		strings.HasPrefix(trimmed, "<local-command-stdout>") ||
		strings.HasPrefix(trimmed, "<local-command-stderr>") ||
		strings.HasPrefix(trimmed, "<task-notification>") ||
		strings.HasPrefix(trimmed, "<command-name>") ||
		strings.HasPrefix(trimmed, "<command-message>") {
		return true
	}
	return isInjectedUserText(trimmed)
}
