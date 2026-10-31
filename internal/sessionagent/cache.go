package sessionagent

// 本文件是详情层缓存与大内容按需读取。规则参考 cc-switch
// session_manager/cache.rs 与 content.rs：进程内 LRU（8 条 / 96MB），
// 指纹判活；大内容按 ContentRef 字节定位读取，512K 字符分页。

import (
	"container/list"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ─── 详情缓存 ───

// Transcript 是一个会话的完整解析结果。
type Transcript struct {
	Messages []SessionMessage
	Turns    []TurnIndex
	// ApproxBytes 估算占用字节，供 LRU 容量控制。
	ApproxBytes int
}

// transcriptFingerprint 是源文件判活指纹。
type transcriptFingerprint struct {
	Modified time.Time
	Size     int64
}

// TranscriptCache 是“会话源 → Transcript”的进程内 LRU。
type TranscriptCache struct {
	mu         sync.Mutex
	entries    *list.List // *transcriptEntry，队首最久未用
	maxEntries int
	maxBytes   int
}

type transcriptEntry struct {
	key         string
	fingerprint transcriptFingerprint
	transcript  *Transcript
}

const (
	// maxTranscriptEntries LRU 条目上限。
	maxTranscriptEntries = 8
	// maxTranscriptBytes LRU 总字节上限（96MB，照抄 cc-switch）。
	maxTranscriptBytes = 96 * 1024 * 1024
)

// globalTranscript 是全局详情缓存单例。
var globalTranscript = NewTranscriptCache(maxTranscriptEntries, maxTranscriptBytes)

// NewTranscriptCache 构造缓存。
func NewTranscriptCache(maxEntries, maxBytes int) *TranscriptCache {
	return &TranscriptCache{
		entries:    list.New(),
		maxEntries: maxEntries,
		maxBytes:   maxBytes,
	}
}

// GetOrLoad 命中且指纹一致时直接复用；未命中执行 load（锁外解析）。
// 返回 cached 标记与解析耗时（毫秒）。
func (c *TranscriptCache) GetOrLoad(key string, fingerprint transcriptFingerprint, load func() (*Transcript, error)) (*Transcript, bool, int64, error) {
	c.mu.Lock()
	for elem := c.entries.Front(); elem != nil; elem = elem.Next() {
		entry := elem.Value.(*transcriptEntry)
		if entry.key != key {
			continue
		}
		if entry.fingerprint != fingerprint {
			c.entries.Remove(elem)
			break
		}
		c.entries.MoveToBack(elem)
		c.mu.Unlock()
		return entry.transcript, true, 0, nil
	}
	c.mu.Unlock()

	// 锁外解析：同会话并发可解析两次，但互不阻塞。
	start := time.Now()
	transcript, err := load()
	parseMs := time.Since(start).Milliseconds()
	if err != nil {
		return nil, false, parseMs, err
	}
	c.insert(key, fingerprint, transcript)
	return transcript, false, parseMs, nil
}

func (c *TranscriptCache) insert(key string, fingerprint transcriptFingerprint, transcript *Transcript) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// 同 key 旧条目先删。
	for elem := c.entries.Front(); elem != nil; elem = elem.Next() {
		if elem.Value.(*transcriptEntry).key == key {
			c.entries.Remove(elem)
			break
		}
	}
	// 超大 transcript 不缓存。
	if transcript.ApproxBytes > c.maxBytes {
		return
	}
	c.entries.PushBack(&transcriptEntry{
		key:         key,
		fingerprint: fingerprint,
		transcript:  transcript,
	})
	for c.entries.Len() > c.maxEntries || c.totalBytesLocked() > c.maxBytes {
		front := c.entries.Front()
		if front == nil {
			break
		}
		c.entries.Remove(front)
	}
}

func (c *TranscriptCache) totalBytesLocked() int {
	total := 0
	for elem := c.entries.Front(); elem != nil; elem = elem.Next() {
		total += elem.Value.(*transcriptEntry).transcript.ApproxBytes
	}
	return total
}

// Remove 主动逐出（删除会话时调用）。
func (c *TranscriptCache) Remove(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for elem := c.entries.Front(); elem != nil; elem = elem.Next() {
		if elem.Value.(*transcriptEntry).key == key {
			c.entries.Remove(elem)
			return
		}
	}
}

// fileFingerprintOf 计算源文件指纹（mtime+len；目录合并子项）。
func fileFingerprintOf(path string) (transcriptFingerprint, error) {
	info, err := os.Stat(path)
	if err != nil {
		return transcriptFingerprint{}, err
	}
	fp := transcriptFingerprint{Modified: info.ModTime(), Size: info.Size()}
	if info.IsDir() {
		entries, err := os.ReadDir(path)
		if err != nil {
			return fp, nil
		}
		for _, entry := range entries {
			if sub, err := entry.Info(); err == nil {
				if sub.ModTime().After(fp.Modified) {
					fp.Modified = sub.ModTime()
				}
				// 每子项 +1 防「删一加一同大小」漏检。
				fp.Size += sub.Size() + 1
			}
		}
	}
	// SQLite 的 WAL 旁路文件也纳入指纹。
	if strings.HasSuffix(path, ".sqlite") || strings.HasSuffix(path, ".db") {
		if wal, err := os.Stat(path + "-wal"); err == nil {
			if wal.ModTime().After(fp.Modified) {
				fp.Modified = wal.ModTime()
			}
			fp.Size += wal.Size()
		}
	}
	return fp, nil
}

// ─── 按需内容读取 ───

// BlockContent 是按需取全文的一页结果。
type BlockContent struct {
	Text       string `json:"text"`
	TotalLen   int    `json:"totalLen"`
	Truncated  bool   `json:"truncated"`
	NextOffset *int   `json:"nextOffset,omitempty"`
}

// ResolveContent 按 ContentRef 读取全文并分页。source 是会话源文件/
// 目录；offset/limit 按字符计（limit 为 0 时用 MaxPageChars）。
func ResolveContent(source string, ref ContentRef, offset, limit int) (BlockContent, error) {
	if limit <= 0 || limit > MaxPageChars {
		limit = MaxPageChars
	}
	full, err := resolveContentFull(source, ref)
	if err != nil {
		return BlockContent{}, err
	}
	total := len([]rune(full))
	if offset < 0 {
		offset = 0
	}
	if offset >= total {
		return BlockContent{Text: "", TotalLen: total}, nil
	}
	runes := []rune(full)
	end := offset + limit
	truncated := end < total
	page := string(runes[offset:min(end, total)])
	result := BlockContent{
		Text:      page,
		TotalLen:  total,
		Truncated: truncated,
	}
	if truncated {
		next := end
		result.NextOffset = &next
	}
	return result, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// resolveContentFull 读取引用指向的完整文本。
func resolveContentFull(source string, ref ContentRef) (string, error) {
	switch ref.Kind {
	case ContentJSONL:
		text, err := readJSONLLine(source, ref.Offset, int64(ref.Length))
		if err != nil {
			return "", err
		}
		if ref.Pointer == "" {
			return text, nil
		}
		return pointerText(text, ref.Pointer)
	case ContentFile:
		base := source
		if info, err := os.Stat(source); err == nil && !info.IsDir() {
			base = filepath.Dir(source)
		}
		full := filepath.Join(base, filepath.FromSlash(ref.RelPath))
		ok, err := UnderRoots(full, []string{base})
		if err != nil || !ok {
			return "", fmt.Errorf("引用的路径不在会话目录内")
		}
		data, err := os.ReadFile(full)
		if err != nil {
			return "", err
		}
		if int64(len(data)) > MaxTextBytes {
			return "", fmt.Errorf("内容超过 %dMB，请直接打开源文件查看", MaxTextBytes/1024/1024)
		}
		text := string(data)
		if ref.Pointer == "" {
			return text, nil
		}
		return pointerText(text, ref.Pointer)
	case ContentSidecar:
		base := source
		if info, err := os.Stat(source); err == nil && !info.IsDir() {
			base = filepath.Dir(source)
		}
		full := filepath.Join(base, filepath.FromSlash(ref.RelPath))
		ok, err := UnderRoots(full, []string{base})
		if err != nil || !ok {
			return "", fmt.Errorf("引用的路径不在会话目录内")
		}
		data, err := os.ReadFile(full)
		if err != nil {
			return "", err
		}
		if int64(len(data)) > MaxTextBytes {
			return "", fmt.Errorf("内容超过 %dMB，请直接打开源文件查看", MaxTextBytes/1024/1024)
		}
		return string(data), nil
	default:
		return "", fmt.Errorf("引用的内容不是文本")
	}
}

// readJSONLLine 按字节区间读取单行；校验行界（前一字节是换行、行内
// 无换行），源已更新时返回 stale 错误。
func readJSONLLine(path string, offset, length int64) (string, error) {
	if length <= 0 {
		return "", fmt.Errorf("会话已更新，请重新读取")
	}
	if IsCompressedRollout(path) {
		return readJSONLLineCompressed(path, offset, length)
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	if offset+length > info.Size() {
		return "", fmt.Errorf("会话已更新，请重新读取")
	}
	// 校验前一字节是换行（offset=0 除外）。
	if offset > 0 {
		var prev [1]byte
		if _, err := file.ReadAt(prev[:], offset-1); err == nil && prev[0] != '\n' && prev[0] != '\r' {
			return "", fmt.Errorf("会话已更新，请重新读取")
		}
	}
	buf := make([]byte, length)
	if _, err := file.ReadAt(buf, offset); err != nil {
		return "", err
	}
	text := strings.TrimRight(string(buf), "\r\n")
	if strings.ContainsAny(text, "\n\r") {
		// 行内出现换行说明区间错位。
		return "", fmt.Errorf("会话已更新，请重新读取")
	}
	return text, nil
}

// readJSONLLineCompressed 从压缩形态会话里按字节区间取单行。ContentRef
// 的偏移是在**解压后**的字节流上算出来的（解析时经 OpenRollout 解压），
// 这里必须同样走解压流——zstd 流不可 seek，且压缩文件的字节偏移与解压
// 后的偏移不是一回事，直接在压缩文件上 seek 会取到错位的字节。
func readJSONLLineCompressed(path string, offset, length int64) (string, error) {
	reader, err := OpenRollout(path)
	if err != nil {
		return "", err
	}
	defer reader.Close()
	if offset > 0 {
		// 跳过前一字节，单独读它做行界校验。
		if _, err := io.CopyN(io.Discard, reader, offset-1); err != nil {
			return "", fmt.Errorf("会话已更新，请重新读取")
		}
		var prev [1]byte
		if _, err := io.ReadFull(reader, prev[:]); err != nil {
			return "", fmt.Errorf("会话已更新，请重新读取")
		}
		if prev[0] != '\n' && prev[0] != '\r' {
			return "", fmt.Errorf("会话已更新，请重新读取")
		}
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(reader, buf); err != nil {
		return "", fmt.Errorf("会话已更新，请重新读取")
	}
	text := strings.TrimRight(string(buf), "\r\n")
	if strings.ContainsAny(text, "\n\r") {
		// 行内出现换行说明区间错位。
		return "", fmt.Errorf("会话已更新，请重新读取")
	}
	return text, nil
}

// pointerText 按 RFC 6901 JSON Pointer 从 JSON 文本取值并转纯文本。
func pointerText(jsonText, pointer string) (string, error) {
	var value any
	if err := json.Unmarshal([]byte(jsonText), &value); err != nil {
		return "", fmt.Errorf("引用的内容不是文本")
	}
	current := value
	for _, token := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		token = strings.ReplaceAll(strings.ReplaceAll(token, "~1", "/"), "~0", "~")
		if token == "" {
			continue
		}
		switch node := current.(type) {
		case map[string]any:
			current = node[token]
		case []any:
			idx := 0
			for _, ch := range token {
				if ch < '0' || ch > '9' {
					return "", fmt.Errorf("引用的内容不是文本")
				}
				idx = idx*10 + int(ch-'0')
			}
			if idx >= len(node) {
				return "", fmt.Errorf("引用的内容不是文本")
			}
			current = node[idx]
		default:
			return "", fmt.Errorf("引用的内容不是文本")
		}
	}
	return extractTextValue(current)
}

// extractTextValue 把 JSON 值投影为纯文本（字符串原样、数组取字符串
// 项连接、对象走 pretty JSON、其他标量拒绝）。
func extractTextValue(value any) (string, error) {
	switch v := value.(type) {
	case string:
		return v, nil
	case []any:
		var parts []string
		for _, item := range v {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
				continue
			}
			if obj, ok := item.(map[string]any); ok {
				if s, ok := obj["text"].(string); ok {
					parts = append(parts, s)
				}
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n"), nil
		}
		return prettyJSON(v)
	case map[string]any:
		return prettyJSON(v)
	default:
		return "", fmt.Errorf("引用的内容不是文本")
	}
}

func prettyJSON(value any) (string, error) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return "", fmt.Errorf("引用的内容不是文本")
	}
	return string(data), nil
}
