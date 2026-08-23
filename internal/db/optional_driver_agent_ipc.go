package db

import (
	"bufio"
	"errors"
	"io"
)

const OptionalDriverAgentMaxJSONLineBytes = 32 << 20

var ErrOptionalDriverAgentJSONLineTooLarge = errors.New("驱动代理 JSON Lines 单帧超过 32 MiB 上限")

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
