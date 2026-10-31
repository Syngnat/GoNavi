package sessionagent

// 本文件是 Codex 会话扫描与元数据提取。规则参考 cc-switch
// session_manager/providers/codex.rs：列表只读 head/tail 少量行，
// 标题双来源（state_5.sqlite threads 表 + session_index.jsonl）。

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	codexProviderID = "codex"
	// codexTitleMaxChars 线程标题的截断长度。
	codexTitleMaxChars = 200
	// codexHeadLines 列表元数据扫描读取的头部行数。Codex 会话头部
	// 集中放置 AGENTS.md、environment_context、apps 上下文等注入块，
	// 真实首条用户消息实测落在第 9~19 行，行数不足会取不到。
	codexHeadLines = 32
)

// uuidRe 从文件名兜底提取会话 ID。
var uuidRe = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

// CodexSessionRoots 返回 Codex 会话目录（sessions + archived_sessions）。
func CodexSessionRoots(dataDir string) []string {
	if strings.TrimSpace(dataDir) == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil
		}
		dataDir = filepath.Join(home, ".codex")
	}
	return []string{
		filepath.Join(dataDir, "sessions"),
		filepath.Join(dataDir, "archived_sessions"),
	}
}

// codexParseCache 是列表级增量缓存（mtime+len 判活）。
var codexParseCache = NewFileParseCache()

// ScanCodexSessions 扫描 Codex 数据目录的全部会话记录，按最后活跃
// 时间倒序返回。titles 为空时从数据目录读取标题来源。
func ScanCodexSessions(dataDir string) []SessionMeta {
	roots := CodexSessionRoots(dataDir)
	var files []string
	for _, root := range roots {
		files = append(files, CollectRolloutFiles(root)...)
	}
	if len(files) == 0 {
		return nil
	}
	// 归档根目录是副本，跨根去重避免同一会话出现两行。
	files = DedupeRolloutCopies(files)
	titles := loadCodexThreadTitles(dataDir)
	metas := codexParseCache.Scan(files, func(path string) (*SessionMeta, error) {
		return parseCodexSessionMeta(path, titles)
	})
	result := make([]SessionMeta, 0, len(metas))
	for _, meta := range metas {
		result = append(result, *meta)
	}
	sortSessionsDesc(result)
	return result
}

// sortSessionsDesc 按最后活跃时间倒序（缺失按 0）。
func sortSessionsDesc(sessions []SessionMeta) {
	sort.SliceStable(sessions, func(i, j int) bool {
		return sessionTime(sessions[i]) > sessionTime(sessions[j])
	})
}

func sessionTime(meta SessionMeta) int64 {
	if meta.LastActiveAt > 0 {
		return meta.LastActiveAt
	}
	return meta.CreatedAt
}

// rolloutLine 是 rollout 行的最小结构（头尾扫描只看少量字段）。
type rolloutLine struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// rolloutSessionMeta 是 session_meta 的最小结构。Source 用 RawMessage
// 承接：Codex 的 source 字段有三种形态（字符串 "vscode"、对象
// {"subagent":{...}}、旧版 {"subagent":true}），用固定类型反序列化会
// 直接报错，连带丢掉 cwd 与 timestamp。
type rolloutSessionMeta struct {
	ID           string          `json:"id"`
	SessionID    string          `json:"session_id"`
	Cwd          string          `json:"cwd"`
	Timestamp    any             `json:"timestamp"`
	Source       json.RawMessage `json:"source"`
	ThreadSource string          `json:"thread_source"`
	// ForkedFromID 标记该会话是另一个会话的 fork 分支。
	ForkedFromID string `json:"forked_from_id"`
}

// codexSubagentMarker 是 session_meta 里的子代理标记。
type codexSubagentMarker struct {
	Subagent bool
	// ParentThreadID 子代理的父线程 ID（仅 thread_spawn 形态有）。
	ParentThreadID string
}

// parseCodexSubagentMarker 解析子代理标记。判定信号有三：source 内含
// subagent 对象（旧版为 true 布尔）、thread_source="subagent"。
func parseCodexSubagentMarker(source json.RawMessage, threadSource string) codexSubagentMarker {
	marker := codexSubagentMarker{}
	if strings.EqualFold(strings.TrimSpace(threadSource), "subagent") {
		marker.Subagent = true
	}
	trimmed := strings.TrimSpace(string(source))
	if trimmed == "" || trimmed == "null" || !strings.HasPrefix(trimmed, "{") {
		return marker
	}
	var payload struct {
		Subagent json.RawMessage `json:"subagent"`
	}
	if err := json.Unmarshal(source, &payload); err != nil {
		return marker
	}
	inner := strings.TrimSpace(string(payload.Subagent))
	if inner == "" || inner == "null" {
		return marker
	}
	marker.Subagent = true
	if !strings.HasPrefix(inner, "{") {
		return marker
	}
	var spawn struct {
		ThreadSpawn *struct {
			ParentThreadID string `json:"parent_thread_id"`
		} `json:"thread_spawn"`
	}
	if err := json.Unmarshal(payload.Subagent, &spawn); err == nil && spawn.ThreadSpawn != nil {
		marker.ParentThreadID = strings.TrimSpace(spawn.ThreadSpawn.ParentThreadID)
	}
	return marker
}

// codexFilenameIsSubagent 判断文件名是否为子代理 rollout：Codex 把子
// 代理会话写成 rollout-<时间>-<父ID>_<子ID>.jsonl。旧版本没有
// session_meta 标记，只能靠文件名识别。
func codexFilenameIsSubagent(path string) bool {
	base := filepath.Base(path)
	trimmed := strings.TrimSuffix(strings.TrimSuffix(base, plainSuffix), compressedSuffix)
	index := strings.LastIndex(trimmed, "_")
	if index < 0 {
		return false
	}
	return uuidRe.MatchString(trimmed[index+1:])
}

// lastUUIDFromName 从文件名取最后一个 UUID。子代理文件名带父 ID 前缀，
// 取最后一个才是子会话自身。
func lastUUIDFromName(path string) string {
	base := filepath.Base(path)
	trimmed := strings.TrimSuffix(strings.TrimSuffix(base, plainSuffix), compressedSuffix)
	matches := uuidRe.FindAllString(trimmed, -1)
	if len(matches) == 0 {
		return ""
	}
	return matches[len(matches)-1]
}

// parseCodexSessionMeta 从 rollout 文件提取列表元数据：只读 head/tail
// 少量行。取不到的字段留空，不从文件名猜测（ID 例外：UUID 兜底）。
func parseCodexSessionMeta(path string, titles map[string]string) (*SessionMeta, error) {
	lines, err := ReadSessionLines(path, codexHeadLines, TailLines)
	if err != nil {
		return nil, err
	}

	meta := &SessionMeta{
		ProviderID:    codexProviderID,
		SourcePath:    path,
		ResumeCommand: "",
	}

	// 旧版本子代理会话没有 session_meta 标记，只能靠文件名识别。
	if codexFilenameIsSubagent(path) {
		return nil, nil
	}

	// head 解析：session_meta + 首条真实用户消息。
	for _, line := range lines.Head {
		var item rolloutLine
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			continue
		}
		if item.Type != "session_meta" {
			continue
		}
		var payload rolloutSessionMeta
		if err := json.Unmarshal(item.Payload, &payload); err != nil {
			continue
		}
		if parseCodexSubagentMarker(payload.Source, payload.ThreadSource).Subagent {
			// 子代理线程不进列表。
			return nil, nil
		}
		meta.SessionID = firstNonEmpty(payload.ID, payload.SessionID)
		meta.ProjectDir = strings.TrimSpace(payload.Cwd)
		meta.CreatedAt = ParseTimestampMs(payload.Timestamp)
		meta.ForkedFrom = strings.TrimSpace(payload.ForkedFromID)
		break
	}
	if meta.SessionID == "" {
		// 文件名 UUID 兜底。
		meta.SessionID = lastUUIDFromName(path)
	}
	if meta.SessionID == "" {
		return nil, nil
	}
	meta.ResumeCommand = "codex resume " + meta.SessionID

	// 首条真实用户消息 → FirstMessage 与标题候选。
	for _, line := range lines.Head {
		if text := codexUserMessageText(line); text != "" {
			meta.FirstMessage = TruncateRunes(FoldWhitespace(text), SummaryChars)
			meta.Title = TruncateRunes(text, codexTitleMaxChars)
			break
		}
	}

	// tail 解析：最后活跃时间 + 摘要。
	for i := len(lines.Tail) - 1; i >= 0; i-- {
		var item rolloutLine
		if err := json.Unmarshal([]byte(lines.Tail[i]), &item); err != nil {
			continue
		}
		var payload struct {
			Timestamp any    `json:"timestamp"`
			Type      string `json:"type"`
			Role      string `json:"role"`
			Content   []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(item.Payload, &payload); err == nil && item.Type == "response_item" {
			if meta.Summary == "" && payload.Type == "message" && payload.Role != "" {
				for _, c := range payload.Content {
					text := strings.TrimSpace(c.Text)
					if text == "" {
						continue
					}
					if payload.Role == "developer" {
						// harness 注入的上下文（app-context、
						// turn_aborted、recommended_plugins 等）不进摘要。
						continue
					}
					if payload.Role == "user" && isInjectedUserText(text) {
						// 用户位上的注入块不进摘要；助手消息不做注入
						// 判定，正文里的 HTML 不是注入包装。
						continue
					}
					meta.Summary = TruncateRunes(FoldWhitespace(text), SummaryChars)
					break
				}
			}
		}
		// 时间戳：行自带 timestamp 优先。
		var tsLine struct {
			Timestamp any `json:"timestamp"`
		}
		if err := json.Unmarshal([]byte(lines.Tail[i]), &tsLine); err == nil && meta.LastActiveAt == 0 {
			if ts := ParseTimestampMs(tsLine.Timestamp); ts > 0 {
				meta.LastActiveAt = ts
			}
		}
	}
	if meta.LastActiveAt == 0 {
		meta.LastActiveAt = lines.FallbackLastActive
	}

	// 标题优先级：线程表 → 首条用户消息（已有）→ 项目目录名。
	if title := titles[meta.SessionID]; title != "" {
		meta.Title = TruncateRunes(title, codexTitleMaxChars)
	}
	if meta.Title == "" && meta.ProjectDir != "" {
		meta.Title = TruncateRunes(PathBasename(meta.ProjectDir), codexTitleMaxChars)
	}
	return meta, nil
}

// codexUserMessageText 从一行提取真实用户输入（跳过注入包装）。
func codexUserMessageText(line string) string {
	var item rolloutLine
	if err := json.Unmarshal([]byte(line), &item); err != nil {
		return ""
	}
	if item.Type != "response_item" {
		return ""
	}
	var payload struct {
		Type    string `json:"type"`
		Role    string `json:"role"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(item.Payload, &payload); err != nil {
		return ""
	}
	if payload.Type != "message" || payload.Role != "user" {
		return ""
	}
	for _, c := range payload.Content {
		text := strings.TrimSpace(c.Text)
		if text == "" || isInjectedUserText(text) {
			continue
		}
		return FoldWhitespace(text)
	}
	return ""
}

// isInjectedUserText 判断文本是否为工具注入的包装（与 rollout 解析共
// 享同一清单）。首条用户消息与尾部摘要都用它过滤注入块。
func isInjectedUserText(text string) bool {
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "# AGENTS.md instructions") ||
		(strings.HasPrefix(trimmed, "# ") && strings.Contains(trimmed, "AGENTS.md")) {
		return true
	}
	if strings.HasPrefix(trimmed, "<environment_context>") ||
		strings.HasPrefix(trimmed, "<user_instructions>") ||
		strings.HasPrefix(trimmed, "<turn_aborted>") {
		return true
	}
	// 单标签包裹（recommended_plugins、in-app-browser-context 等）：
	// 标签名取到首个空白或 > 为止，防属性里的 > 干扰（如 source="x">）。
	if strings.HasPrefix(trimmed, "<image") {
		return true
	}
	if strings.HasPrefix(trimmed, "<") {
		rest := trimmed[1:]
		nameEnd := len(rest)
		for i := 0; i < len(rest); i++ {
			if rest[i] == ' ' || rest[i] == '\t' || rest[i] == '>' || rest[i] == '/' {
				nameEnd = i
				break
			}
		}
		name := rest[:nameEnd]
		if name != "" {
			// 闭合标签可能带属性（如 <permissions instructions> 的
			// </permissions instructions>），只比前缀即可。
			if strings.Contains(trimmed, "</"+name) {
				return true
			}
		}
	}
	return false
}

// ─── 标题双来源 ───

// codexTitlesMu 保护标题缓存（按需加锁）。
var codexTitlesMu sync.Mutex

// codexTitlesCacheTTL 是标题来源的缓存时长。state_5.sqlite 在 Codex
// 运行时可能被锁（busy_timeout 会等 2 秒），而列表搜索每敲一个键就要
// 重扫一次，不缓存的话搜索会明显卡住。
const codexTitlesCacheTTL = 10 * time.Second

// codexTitlesCache 缓存最近一次读到的线程标题。
var codexTitlesCache = struct {
	mu        sync.Mutex
	dataDir   string
	titles    map[string]string
	fetchedAt time.Time
}{}

// loadCodexThreadTitles 合并两个标题来源（DB 覆盖 index）：
// session_index.jsonl（每 id 末条胜）+ state_5.sqlite threads 表
// （仅用户显式改过名的行）。来源读取失败时返回空表，不中断扫描。
func loadCodexThreadTitles(dataDir string) map[string]string {
	codexTitlesMu.Lock()
	defer codexTitlesMu.Unlock()

	titles := map[string]string{}
	if strings.TrimSpace(dataDir) == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return titles
		}
		dataDir = filepath.Join(home, ".codex")
	}

	codexTitlesCache.mu.Lock()
	if codexTitlesCache.dataDir == dataDir &&
		codexTitlesCache.titles != nil &&
		time.Since(codexTitlesCache.fetchedAt) < codexTitlesCacheTTL {
		cached := codexTitlesCache.titles
		codexTitlesCache.mu.Unlock()
		return cached
	}
	codexTitlesCache.mu.Unlock()

	// 来源一：session_index.jsonl。
	if file, err := os.Open(filepath.Join(dataDir, "session_index.jsonl")); err == nil {
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for scanner.Scan() {
			var entry struct {
				ID         string `json:"id"`
				ThreadName string `json:"thread_name"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
				continue
			}
			name := strings.TrimSpace(entry.ThreadName)
			if entry.ID != "" && name != "" {
				titles[entry.ID] = name
			}
		}
		file.Close()
	}

	// 来源二：state_5.sqlite threads 表（只取显式改名的行，DB 覆盖
	// index）。Codex 持写锁，这里只读 + busy_timeout 短超时。
	dbPath := filepath.Join(dataDir, "state_5.sqlite")
	if _, err := os.Stat(dbPath); err == nil {
		db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro&_pragma=busy_timeout(2000)&_pragma=query_only(1)")
		if err == nil {
			rows, err := db.Query(`SELECT id, title FROM threads
				WHERE title <> ''
				  AND (first_user_message IS NULL OR TRIM(title) <> TRIM(first_user_message))`)
			if err == nil {
				for rows.Next() {
					var id, title string
					if rows.Scan(&id, &title) == nil && strings.TrimSpace(title) != "" {
						titles[id] = strings.TrimSpace(title)
					}
				}
				rows.Close()
			}
			db.Close()
		}
	}
	// 写回缓存：短时间内重复扫描（搜索输入）不再重读 sqlite。
	codexTitlesCache.mu.Lock()
	codexTitlesCache.dataDir = dataDir
	codexTitlesCache.titles = titles
	codexTitlesCache.fetchedAt = time.Now()
	codexTitlesCache.mu.Unlock()
	return titles
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
