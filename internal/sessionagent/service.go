package sessionagent

// 本文件是会话浏览的服务门面：多工具扫描调度、详情加载（带缓存）、
// 删除与导出。对外只暴露此文件的方法，绑定层保持薄。

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ProviderID 是工具类型键。
type ProviderID = string

const (
	ProviderCodex  ProviderID = "codex"
	ProviderClaude ProviderID = "claude"
)

// Service 是会话浏览服务。CodexDir/ClaudeDir 为各工具数据目录；绑定层
// 按已添加实例注入（未添加的工具不设目录），enabled 集标记哪些工具
// 已被用户添加——扫描与详情只对已添加工具生效。
type Service struct {
	CodexDir  string
	ClaudeDir string
	// Enabled 标记已添加的工具；nil 视为「全部启用」（测试直接构造
	// Service 时的宽松行为，绑定层必须显式设置）。
	Enabled map[ProviderID]bool
}

// SetEnabled 按已添加实例标记启用工具。
func (s *Service) SetEnabled(kinds ...ProviderID) {
	s.Enabled = make(map[ProviderID]bool, len(kinds))
	for _, kind := range kinds {
		s.Enabled[kind] = true
	}
}

// isEnabled 工具是否已添加（Enabled 为 nil 视为全部启用，兼容测试）。
func (s *Service) isEnabled(kind ProviderID) bool {
	if s.Enabled == nil {
		return true
	}
	return s.Enabled[kind]
}

// New 构造服务。调用方（绑定层）按已添加实例注入 CodexDir/ClaudeDir；
// 未注入的字段保持空串，Scan 会按各工具默认目录解析——绑定层保证
// 只有已添加的工具才有非空目录，从而只扫已添加工具。
func New() *Service {
	return &Service{}
}

// List 返回全部工具的会话（按最后活跃时间倒序）。provider 为空返回
// 全部；search 对标题/摘要/项目目录/提问做大小写不敏感子串匹配。
func (s *Service) List(provider, search string) []SessionMeta {
	var result []SessionMeta
	if (provider == "" || provider == ProviderCodex) && s.isEnabled(ProviderCodex) {
		result = append(result, ScanCodexSessions(s.CodexDir)...)
	}
	if (provider == "" || provider == ProviderClaude) && s.isEnabled(ProviderClaude) {
		result = append(result, ScanClaudeSessions(s.ClaudeDir)...)
	}
	if needle := strings.ToLower(strings.TrimSpace(search)); needle != "" {
		filtered := result[:0]
		for _, meta := range result {
			if strings.Contains(strings.ToLower(meta.Title), needle) ||
				strings.Contains(strings.ToLower(meta.Summary), needle) ||
				strings.Contains(strings.ToLower(meta.FirstMessage), needle) ||
				strings.Contains(strings.ToLower(meta.ProjectDir), needle) ||
				strings.Contains(strings.ToLower(meta.SessionID), needle) {
				filtered = append(filtered, meta)
			}
		}
		result = filtered
	}
	sort.Slice(result, func(i, j int) bool {
		return sessionTime(result[i]) > sessionTime(result[j])
	})
	return result
}

// LoadTranscript 加载会话详情（带 LRU 缓存）。返回消息、轮次索引与
// 是否缓存命中。
func (s *Service) LoadTranscript(provider ProviderID, sourcePath string) (*Transcript, bool, error) {
	if !s.isEnabled(ProviderID(provider)) {
		return nil, false, fmt.Errorf("agent %s is not added", provider)
	}
	roots := s.rootsFor(provider)
	ok, err := UnderRoots(sourcePath, roots)
	if err != nil {
		return nil, false, fmt.Errorf("定位会话文件失败: %w", err)
	}
	if !ok {
		return nil, false, fmt.Errorf("引用的路径不在会话目录内")
	}
	fingerprint, err := fileFingerprintOf(sourcePath)
	if err != nil {
		return nil, false, fmt.Errorf("读取会话文件失败: %w", err)
	}
	key := provider + "|" + sourcePath
	transcript, cached, _, err := globalTranscript.GetOrLoad(key, fingerprint, func() (*Transcript, error) {
		return loadTranscriptMessages(provider, sourcePath)
	})
	return transcript, cached, err
}

func loadTranscriptMessages(provider ProviderID, sourcePath string) (*Transcript, error) {
	var messages []SessionMessage
	var err error
	switch provider {
	case ProviderCodex:
		messages, _, err = ParseCodexMessages(sourcePath)
	case ProviderClaude:
		messages, _, err = ParseClaudeMessages(sourcePath)
	default:
		return nil, fmt.Errorf("不支持的工具类型: %s", provider)
	}
	if err != nil {
		return nil, err
	}
	turns := BuildTurns(messages)
	bytes := 0
	for _, msg := range messages {
		bytes += len(msg.Content) + len(msg.ID) + len(msg.TurnID)
		for _, block := range msg.Blocks {
			if block.Text != nil {
				bytes += len(block.Text.Text)
			}
			if block.Thinking != nil {
				bytes += len(block.Thinking.Text) + len(block.Thinking.Summary)
			}
			if block.ToolCall != nil {
				bytes += len(block.ToolCall.InputPreview) + len(block.ToolCall.Title)
			}
			if block.ToolResult != nil {
				bytes += len(block.ToolResult.Preview)
			}
			if block.Event != nil {
				bytes += len(block.Event.Text)
			}
		}
	}
	return &Transcript{Messages: messages, Turns: turns, ApproxBytes: bytes}, nil
}

// ReadPage 按消息下标分页读取（前端首次渲染后按需加载）。
func (s *Service) ReadPage(provider ProviderID, sourcePath string, offset, limit int) ([]SessionMessage, error) {
	transcript, _, err := s.LoadTranscript(provider, sourcePath)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	total := len(transcript.Messages)
	if offset < 0 {
		offset = 0
	}
	if offset >= total {
		return nil, nil
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return transcript.Messages[offset:end], nil
}

// BlockContent 按需取大内容（分页）。
func (s *Service) BlockContent(provider ProviderID, sourcePath string, ref ContentRef, offset, limit int) (BlockContent, error) {
	if !s.isEnabled(provider) {
		return BlockContent{}, fmt.Errorf("agent %s is not added", provider)
	}
	roots := s.rootsFor(provider)
	ok, err := UnderRoots(sourcePath, roots)
	if err != nil || !ok {
		return BlockContent{}, fmt.Errorf("引用的路径不在会话目录内")
	}
	return ResolveContent(sourcePath, ref, offset, limit)
}

// InlineImageDataURL 读取内联图片（Claude 的 base64 图片块）的完整载荷并
// 拼成 data URL。图片不走分页：base64 被截断就渲染不出来。
func (s *Service) InlineImageDataURL(provider ProviderID, sourcePath string, ref ContentRef, mediaType string) (string, error) {
	if !s.isEnabled(provider) {
		return "", fmt.Errorf("agent %s is not added", provider)
	}
	roots := s.rootsFor(provider)
	ok, err := UnderRoots(sourcePath, roots)
	if err != nil || !ok {
		return "", fmt.Errorf("引用的路径不在会话目录内")
	}
	if ref.Kind != ContentJSONL {
		return "", fmt.Errorf("引用的内容不是内联图片")
	}
	full, err := resolveContentFull(sourcePath, ref)
	if err != nil {
		return "", err
	}
	if int64(len(full)) > MaxTextBytes {
		return "", fmt.Errorf("图片超过大小上限 %d 字节", MaxTextBytes)
	}
	mime := strings.TrimSpace(mediaType)
	if mime == "" {
		mime = "image/png"
	}
	return "data:" + mime + ";base64," + full, nil
}

// ExportMarkdown 把会话导出为 Markdown 文本（时间线 + 轮次标题）。
func (s *Service) ExportMarkdown(provider ProviderID, sourcePath string) (string, error) {
	transcript, _, err := s.LoadTranscript(provider, sourcePath)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("# 会话记录\n\n")
	for _, turn := range transcript.Turns {
		if turn.QuestionPreview != "" {
			b.WriteString("## " + turn.QuestionPreview + "\n\n")
		}
		for i := turn.FirstMessageIdx; i <= turn.LastMessageIdx && i < len(transcript.Messages); i++ {
			msg := transcript.Messages[i]
			if msg.Injected {
				continue
			}
			switch msg.Role {
			case RoleUser:
				if strings.TrimSpace(msg.Content) != "" {
					b.WriteString("**用户**：" + msg.Content + "\n\n")
				}
			case RoleAssistant:
				if strings.TrimSpace(msg.Content) != "" {
					b.WriteString("**助手**：" + msg.Content + "\n\n")
				}
				for _, block := range msg.Blocks {
					if block.Type == BlockText && block.Text != nil && strings.TrimSpace(block.Text.Text) != "" {
						b.WriteString(block.Text.Text + "\n\n")
					}
					if block.Type == BlockToolCall && block.ToolCall != nil {
						b.WriteString("> 工具调用：" + block.ToolCall.Title + "\n\n")
					}
				}
			}
		}
	}
	return b.String(), nil
}

// Delete 删除会话源文件（校验归属 + 身份）。只读浏览语义：删除是唯
// 一的写操作，仅删用户指定的记录文件（含 sibling 双形态）。
func (s *Service) Delete(provider ProviderID, sourcePath, sessionID string) error {
	if !s.isEnabled(provider) {
		return fmt.Errorf("agent %s is not added", provider)
	}
	roots := s.rootsFor(provider)
	ok, err := UnderRoots(sourcePath, roots)
	if err != nil || !ok {
		return fmt.Errorf("引用的路径不在会话目录内")
	}
	switch provider {
	case ProviderCodex:
		// 身份校验：重新解析确认 session_id 匹配。
		meta, err := parseCodexSessionMeta(sourcePath, nil)
		if err != nil {
			return fmt.Errorf("读取会话文件失败: %w", err)
		}
		if meta == nil || meta.SessionID != sessionID {
			return fmt.Errorf("会话标识不匹配，已取消删除")
		}
	case ProviderClaude:
		// Claude 删除同样做身份校验（复用元数据解析）。
		meta, err := parseClaudeSessionMeta(sourcePath)
		if err != nil {
			return fmt.Errorf("读取会话文件失败: %w", err)
		}
		if meta.SessionID != sessionID {
			return fmt.Errorf("会话标识不匹配，已取消删除")
		}
	}
	if provider == ProviderCodex {
		// 压缩/未压缩双形态 + 归档副本联动删除：Codex 归档是复制，
		// 只删一份的话另一份会重新出现在列表里。
		for _, candidate := range RolloutCopies(sourcePath, roots) {
			if err := os.Remove(candidate); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("删除会话文件失败: %w", err)
			}
			globalTranscript.Remove(provider + "|" + candidate)
		}
	} else if err := os.Remove(sourcePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("删除会话文件失败: %w", err)
	}
	globalTranscript.Remove(provider + "|" + sourcePath)
	return nil
}

// ResumeCommand 返回恢复命令（前端复制到剪贴板 / 终端启动）。
func (s *Service) ResumeCommand(provider ProviderID, sessionID string) string {
	if !s.isEnabled(provider) {
		return ""
	}
	switch provider {
	case ProviderCodex:
		return "codex resume " + sessionID
	case ProviderClaude:
		return "claude --resume " + sessionID
	}
	return ""
}

// ListProviders 返回已配置工具（当前固定 Codex + Claude）。
func (s *Service) ListProviders() []map[string]string {
	return []map[string]string{
		{"id": ProviderCodex, "name": "ChatGPT"},
		{"id": ProviderClaude, "name": "Claude Code"},
	}
}

func (s *Service) rootsFor(provider ProviderID) []string {
	switch provider {
	case ProviderCodex:
		return CodexSessionRoots(s.CodexDir)
	case ProviderClaude:
		return ClaudeSessionRoots(s.ClaudeDir)
	}
	return nil
}

// GroupByTime 把会话按时间段分组（今天/昨天/本周/更早），返回分组键
// 与各组会话。用于前端分组展示。
func GroupByTime(sessions []SessionMeta, now time.Time) map[string][]SessionMeta {
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	yesterday := today.AddDate(0, 0, -1)
	weekStart := today.AddDate(0, 0, -int(now.Weekday()))
	groups := map[string][]SessionMeta{}
	for _, session := range sessions {
		ts := sessionTime(session)
		if ts == 0 {
			groups["older"] = append(groups["older"], session)
			continue
		}
		moment := time.UnixMilli(ts)
		switch {
		case !moment.Before(today):
			groups["today"] = append(groups["today"], session)
		case !moment.Before(yesterday):
			groups["yesterday"] = append(groups["yesterday"], session)
		case !moment.Before(weekStart):
			groups["week"] = append(groups["week"], session)
		default:
			groups["older"] = append(groups["older"], session)
		}
	}
	return groups
}

// ProjectName 提取项目目录末段（列表展示用）。
func ProjectName(projectDir string) string {
	return PathBasename(strings.TrimSpace(projectDir))
}

// RevealPath 返回文件所在目录（前端打开资源管理器）。
func RevealPath(path string) string {
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		return path
	}
	return filepath.Dir(path)
}
