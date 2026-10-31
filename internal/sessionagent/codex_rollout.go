package sessionagent

// 本文件是 Codex rollout 文件的透明读取层：.jsonl 与 .jsonl.zst 双形态
// 处理。参考 cc-switch src-tauri/src/codex_rollout_file.rs。

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/klauspost/compress/zstd"
)

const (
	plainSuffix      = ".jsonl"
	compressedSuffix = ".jsonl.zst"
)

// IsRolloutFile 判断文件名是否为 rollout 会话文件（.jsonl 或
// .jsonl.zst；裸 .zst 不认）。
func IsRolloutFile(name string) bool {
	return strings.HasSuffix(name, plainSuffix) || strings.HasSuffix(name, compressedSuffix)
}

// IsCompressedRollout 判断文件名是否为 zstd 压缩形态。
func IsCompressedRollout(name string) bool {
	return strings.HasSuffix(name, compressedSuffix)
}

// RolloutSibling 返回同名另一形态路径（.jsonl ↔ .jsonl.zst）。
// 双形态并存时压缩/未压缩是同一逻辑会话，删除需联动。
func RolloutSibling(path string) string {
	if IsCompressedRollout(path) {
		return strings.TrimSuffix(path, compressedSuffix) + plainSuffix
	}
	return path + compressedSuffix
}

// OpenRollout 返回 rollout 文件的逐行读取器：.jsonl.zst 走 zstd 流式
// 解压（1MiB 缓冲），普通文件直读。
func OpenRollout(path string) (io.ReadCloser, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	if !IsCompressedRollout(path) {
		return file, nil
	}
	decoder, err := zstd.NewReader(file)
	if err != nil {
		file.Close()
		return nil, err
	}
	return &zstdReadCloser{Reader: decoder, closer: file}, nil
}

type zstdReadCloser struct {
	io.Reader
	closer io.Closer
}

func (z *zstdReadCloser) Close() error {
	if closer, ok := z.Reader.(io.Closer); ok {
		closer.Close()
	}
	return z.closer.Close()
}

// DedupeRolloutSiblings 去重双形态：同一逻辑名保留 .jsonl（Codex 正在
// 写、内容更全），保持输入顺序。
func DedupeRolloutSiblings(paths []string) []string {
	hasPlain := map[string]bool{}
	for _, p := range paths {
		if !IsCompressedRollout(p) {
			hasPlain[logicalName(p)] = true
		}
	}
	seen := map[string]bool{}
	result := make([]string, 0, len(paths))
	for _, p := range paths {
		name := logicalName(p)
		if seen[name] {
			continue
		}
		if IsCompressedRollout(p) && hasPlain[name] {
			continue
		}
		seen[name] = true
		result = append(result, p)
	}
	return result
}

func logicalName(path string) string {
	if IsCompressedRollout(path) {
		return strings.TrimSuffix(path, compressedSuffix)
	}
	return strings.TrimSuffix(path, plainSuffix)
}

// rolloutLogicalKey 返回跨根可比的逻辑键：去掉目录与形态后缀的文件名。
// 同一会话在 sessions 与 archived_sessions 下的路径不同但文件名相同，
// 只有按文件名比对才能跨根识别为同一会话。
func rolloutLogicalKey(path string) string {
	base := filepath.Base(path)
	if IsCompressedRollout(base) {
		return strings.TrimSuffix(base, compressedSuffix)
	}
	return strings.TrimSuffix(base, plainSuffix)
}

// RolloutCopies 返回同一逻辑会话在各处的全部副本路径：同目录的压缩/
// 未压缩双形态，以及各归档根目录下的同逻辑副本。Codex 归档是复制而
// 非移动，只删一份的话另一份会重新出现在列表里。
func RolloutCopies(path string, roots []string) []string {
	candidates := []string{path, RolloutSibling(path)}
	base := rolloutLogicalKey(path)
	for _, root := range roots {
		_ = filepath.WalkDir(root, func(current string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			if rolloutLogicalKey(current) == base {
				candidates = append(candidates, current)
			}
			return nil
		})
	}
	return candidates
}

// DedupeRolloutCopies 跨根去重：Codex 归档是复制而非移动，同一会话会
// 同时存在于 sessions 与 archived_sessions（文件名相同）。保留先出现
// 的那个——根目录顺序即优先级（sessions 在前，archived_sessions 在后）。
func DedupeRolloutCopies(paths []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(paths))
	for _, path := range paths {
		name := rolloutLogicalKey(path)
		if seen[name] {
			continue
		}
		seen[name] = true
		result = append(result, path)
	}
	return result
}

// CollectRolloutFiles 递归收集目录下全部 rollout 文件并去重双形态。
func CollectRolloutFiles(root string) []string {
	var files []string
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil // 单个目录/文件不可读不中断整体扫描
		}
		if entry.IsDir() {
			return nil
		}
		if IsRolloutFile(entry.Name()) {
			files = append(files, path)
		}
		return nil
	})
	return DedupeRolloutSiblings(files)
}

// readScanner 是 bufio.Scanner 的公共构造（行上限与 codex 历史读取一致）。
func readScanner(r io.Reader) *bufio.Scanner {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 32*1024*1024)
	return scanner
}
