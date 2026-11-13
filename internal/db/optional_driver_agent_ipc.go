package db

import (
	"bufio"
	"errors"
	"io"
)

// ErrOptionalDriverAgentJSONLineTooLarge 是旧版驱动代理在单帧超过 32 MiB 时返回的错误。
// 当前协议不再限制单帧大小。主进程仍识别该文案，避免旧代理写出的失败帧被当成传输损坏。
var ErrOptionalDriverAgentJSONLineTooLarge = errors.New("驱动代理 JSON Lines 单帧超过 32 MiB 上限")

// ReadOptionalDriverAgentJSONLine reads one JSON Lines frame. ReadSlice keeps
// bufio's own buffer fixed and this function accumulates fragments until a newline,
// so a large result is not rejected. The returned size includes the trailing
// newline when present. A missing newline is returned with io.EOF once the
// reader ends.
func ReadOptionalDriverAgentJSONLine(reader *bufio.Reader) ([]byte, error) {
	if reader == nil {
		return nil, io.EOF
	}

	line := make([]byte, 0, 16<<10)
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(fragment) > 0 {
			line = append(line, fragment...)
		}

		switch {
		case err == nil:
			return line, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF) && len(line) > 0:
			return line, io.EOF
		default:
			return line, err
		}
	}
}
