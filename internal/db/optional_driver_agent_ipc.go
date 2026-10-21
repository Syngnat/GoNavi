package db

import (
	"bufio"
	"errors"
	"fmt"
	"io"
)

// 单帧上限：消息队列的 value 常是大 JSON 或二进制（JSON 里按 base64 编码后还会再涨三分之一），
// 单条十几 MB 的消息在 32 MiB 上限下会连「2 行一批」都发不出去。放宽到 64 MiB 后，
// 十几 MB 的消息能按 2 行一批传输，同时仍是一个明确的硬上限，不会被无界帧撑爆内存。
const OptionalDriverAgentMaxJSONLineBytes = 64 << 20

// OptionalDriverAgentJSONLineTooLargePrefix 用于跨版本识别单帧超限：上限调整后文案里的
// MiB 数字会变，只比较前缀才能同时认出旧 agent（32 MiB）与新 agent（128 MiB）报来的错误。
const OptionalDriverAgentJSONLineTooLargePrefix = "驱动代理 JSON Lines 单帧超过"

var ErrOptionalDriverAgentJSONLineTooLarge = fmt.Errorf(
	"%s %d MiB 上限", OptionalDriverAgentJSONLineTooLargePrefix, OptionalDriverAgentMaxJSONLineBytes>>20,
)

// ReadOptionalDriverAgentJSONLine reads one JSON Lines frame without allowing
// bufio.Reader to grow an unbounded buffer for a missing newline. The returned
// size includes the trailing newline when present.
func ReadOptionalDriverAgentJSONLine(reader *bufio.Reader) ([]byte, error) {
	if reader == nil {
		return nil, io.EOF
	}

	line := make([]byte, 0, 16<<10)
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(fragment) > 0 {
			if len(line) > OptionalDriverAgentMaxJSONLineBytes-len(fragment) {
				return nil, ErrOptionalDriverAgentJSONLineTooLarge
			}
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
