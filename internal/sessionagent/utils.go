package sessionagent

// 本文件是文件读取与解析缓存工具。规则参考 cc-switch
// session_manager/providers/utils.rs。

import (
	"bufio"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 头尾扫描常量（照抄 cc-switch）。
const (
	// HeadLines 元数据扫描读取的头部行数。
	HeadLines = 10
	// TailLines 元数据扫描读取的尾部行数。
	TailLines = 30
	// tailWindowBytes 文件较大时尾部窗口的字节数。
	tailWindowBytes = 16 * 1024
	// smallFileBytes 小于该大小的文件一次性整读。
	smallFileBytes = 16 * 1024
	// SniffBytes 行类型嗅探的字节数上限。
	SniffBytes = 512
	// headReadLimitBytes 头部扫描的字节上限。Codex 头部含大段注入块
	//（单条 developer 消息可达 20KB+），上限过小会把行截断在半路。
	headReadLimitBytes = 1024 * 1024
)

// SessionLines 是一次头尾扫描的结果。
type SessionLines struct {
	Head []string
	Tail []string
	// FallbackLastActive 尾部无时间戳时的兜底活跃时间（文件 mtime）。
	FallbackLastActive int64
}

// ReadHeadTailLines 读取文件头 HeadLines 行与尾 TailLines 行。
func ReadHeadTailLines(path string) (SessionLines, error) {
	return ReadSessionLines(path, HeadLines, TailLines)
}

// ReadSessionLines 读取文件头 headLines 行与尾 tailLines 行：小文件
// 整读；大文件读头部，再取尾部 tailWindowBytes 窗口并跳过可能的半行。
// 压缩形态（.jsonl.zst）不可 seek，改走流式顺序扫描。
func ReadSessionLines(path string, headLines, tailLines int) (SessionLines, error) {
	result := SessionLines{}
	if IsCompressedRollout(path) {
		return readHeadTailLinesStream(path, headLines, tailLines)
	}
	file, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return result, err
	}
	result.FallbackLastActive = info.ModTime().UnixMilli()

	if info.Size() <= smallFileBytes {
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		var lines []string
		for scanner.Scan() {
			lines = append(lines, scanner.Text())
		}
		if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
			return result, err
		}
		result.Head = firstN(lines, headLines)
		result.Tail = lastN(lines, tailLines)
		return result, nil
	}

	// 头部：直接扫前若干行。
	headScanner := bufio.NewScanner(io.LimitReader(file, headReadLimitBytes))
	headScanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for headScanner.Scan() && len(result.Head) < headLines {
		result.Head = append(result.Head, headScanner.Text())
	}

	// 尾部：seek 到末尾窗口，跳过首个可能的半行。
	windowStart := info.Size() - tailWindowBytes
	if windowStart < 0 {
		windowStart = 0
	}
	if _, err := file.Seek(windowStart, io.SeekStart); err != nil {
		return result, err
	}
	tailScanner := bufio.NewScanner(io.LimitReader(file, tailWindowBytes+1))
	tailScanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	skipPartial := windowStart > 0
	for tailScanner.Scan() {
		if skipPartial {
			skipPartial = false
			continue
		}
		result.Tail = append(result.Tail, tailScanner.Text())
	}
	result.Tail = lastN(result.Tail, tailLines)
	return result, nil
}

// readHeadTailLinesStream 流式读取压缩形态：zstd 流不可 seek，一次顺序
// 扫描同时保留头部前 headLines 行与尾部 tailLines 行。
func readHeadTailLinesStream(path string, headLines, tailLines int) (SessionLines, error) {
	result := SessionLines{}
	if info, err := os.Stat(path); err == nil {
		result.FallbackLastActive = info.ModTime().UnixMilli()
	}
	reader, err := OpenRollout(path)
	if err != nil {
		return result, err
	}
	defer reader.Close()
	scanner := readScanner(reader)
	tail := make([]string, 0, tailLines)
	for scanner.Scan() {
		line := scanner.Text()
		if len(result.Head) < headLines {
			result.Head = append(result.Head, line)
		}
		if tailLines <= 0 {
			continue
		}
		if len(tail) == tailLines {
			tail = tail[1:]
		}
		tail = append(tail, line)
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}
	result.Tail = tail
	return result, nil
}

func firstN(lines []string, n int) []string {
	if len(lines) <= n {
		return lines
	}
	return lines[:n]
}

func lastN(lines []string, n int) []string {
	if len(lines) <= n {
		return lines
	}
	return lines[len(lines)-n:]
}

// ─── jsonl 字节定位 ───

// LineSpan 是一行在文件中的字节区间（含行尾换行）。
type LineSpan struct {
	Offset int64
	Length uint32
}

// ContentRef 返回该行的 JSONL 内容引用。
func (s LineSpan) ContentRef(pointer string) ContentRef {
	return ContentRef{
		Kind:    ContentJSONL,
		Offset:  s.Offset,
		Length:  s.Length,
		Pointer: pointer,
	}
}

// LineSpans 逐行读取并记录每行的字节区间，供 ContentRef 精确定位。
// 用 bufio.Reader 读原始行尾字节，Length 含真实行尾（LF 或 CRLF），
// CRLF 文件的区间不会漂移（P2-3）。
type LineSpans struct {
	reader  *bufio.Reader
	offset  int64
	lastErr error
}

// NewLineSpans 从 r 构造逐行扫描器。
func NewLineSpans(r io.Reader) *LineSpans {
	return &LineSpans{reader: bufio.NewReaderSize(r, 64*1024)}
}

// Next 读下一行，返回行文本（已剥行尾）与原始字节区间；到文件尾返回 ok=false。
func (l *LineSpans) Next() (string, LineSpan, bool) {
	raw, err := l.reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) && len(raw) == 0 {
		// 真实读错误：保留错误供 Err() 上报。
		l.lastErr = err
		return "", LineSpan{}, false
	}
	if len(raw) == 0 {
		return "", LineSpan{}, false
	}
	total := len(raw)
	// 剥行尾：LF 或 CRLF。
	text := raw
	if n := len(text); n > 0 && text[n-1] == '\n' {
		text = text[:n-1]
		if n > 1 && text[n-2] == '\r' {
			text = text[:n-2]
		}
	}
	span := LineSpan{Offset: l.offset, Length: uint32(total)}
	l.offset += int64(total)
	_ = err // EOF 时 raw 为最后一行，仍正常返回
	return string(text), span, true
}

// Err 返回扫描错误。
func (l *LineSpans) Err() error { return l.lastErr }

// ─── 时间戳解析 ───

// ParseTimestampMs 解析时间戳为 Unix 毫秒：整数 >1e12 视为毫秒否则
// 按秒换算；字符串尝试 RFC3339 与常见布局。取不到返回 0。
func ParseTimestampMs(raw any) int64 {
	switch v := raw.(type) {
	case float64:
		return intToMs(int64(v))
	case int64:
		return intToMs(v)
	case int:
		return intToMs(int64(v))
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			return 0
		}
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return intToMs(n)
		}
		if ts, err := time.Parse(time.RFC3339, s); err == nil {
			return ts.UnixMilli()
		}
		if ts, err := time.Parse("2006-01-02T15-04-05", s); err == nil {
			return ts.UnixMilli()
		}
	}
	return 0
}

func intToMs(n int64) int64 {
	if n <= 0 {
		return 0
	}
	if n > 1_000_000_000_000 {
		return n
	}
	return n * 1000
}

// ─── 路径工具 ───

// PathBasename 兼容 Windows 与 POSIX 分隔符取末段。
func PathBasename(p string) string {
	normalized := strings.ReplaceAll(p, "\\", "/")
	segments := strings.Split(normalized, "/")
	for i := len(segments) - 1; i >= 0; i-- {
		if segments[i] != "" {
			return segments[i]
		}
	}
	return ""
}

// UnderRoots 校验 path 在某个根目录之下（canonicalize 后比较，防符号
// 链接逃逸）；根为空列表时不做限制。
func UnderRoots(path string, roots []string) (bool, error) {
	if len(roots) == 0 {
		return true, nil
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		resolved, err = filepath.Abs(path)
		if err != nil {
			return false, err
		}
	}
	for _, root := range roots {
		rootResolved, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(rootResolved, resolved)
		if err != nil {
			continue
		}
		if rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true, nil
		}
	}
	return false, nil
}

// ─── 文件解析缓存 ───

// fileFingerprint 是文件判活指纹（mtime + size，不哈希内容）。
type fileFingerprint struct {
	Modified time.Time
	Size     int64
}

type cachedParse struct {
	fingerprint fileFingerprint
	meta        *SessionMeta
}

// FileParseCache 是“文件 → SessionMeta”的进程内增量缓存：mtime+len
// 未变化的文件直接复用上次解析结果；解析错误不缓存，下轮重试。
type FileParseCache struct {
	mu      sync.Mutex
	entries map[string]cachedParse
}

// NewFileParseCache 构造缓存。
func NewFileParseCache() *FileParseCache {
	return &FileParseCache{entries: map[string]cachedParse{}}
}

// Scan 增量刷新缓存：指纹未变的文件直接复用上次解析结果（读旧表），
// 变化/新增的文件重新解析；解析错误不缓存（防永久负缓存）。已删除的
// 文件自动淘汰（本轮未命中的旧条目不再写回）。并发安全：旧表快照在
// 锁内取出后只读，新表写入在锁内完成，两个并发 Scan 互不干扰。
func (c *FileParseCache) Scan(paths []string, fn func(string) (*SessionMeta, error)) []*SessionMeta {
	c.mu.Lock()
	old := c.entries
	c.entries = map[string]cachedParse{}
	c.mu.Unlock()

	results := make([]*SessionMeta, 0, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		fingerprint := fileFingerprint{Modified: info.ModTime(), Size: info.Size()}
		c.mu.Lock()
		hit, hitOk := old[path]
		if hitOk && hit.fingerprint == fingerprint {
			c.entries[path] = hit
			c.mu.Unlock()
			if hit.meta != nil {
				results = append(results, hit.meta)
			}
			continue
		}
		c.mu.Unlock()
		meta, err := fn(path)
		if err != nil {
			continue
		}
		c.mu.Lock()
		c.entries[path] = cachedParse{fingerprint: fingerprint, meta: meta}
		c.mu.Unlock()
		if meta != nil {
			results = append(results, meta)
		}
	}
	return results
}
