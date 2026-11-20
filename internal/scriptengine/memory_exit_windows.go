//go:build windows

package scriptengine

import (
	"os"
	"strings"
)

func workerExitIndicatesMemoryLimit(state *os.ProcessState, stderr string) bool {
	if state != nil {
		switch uint32(state.ExitCode()) {
		case 0xC0000017, // STATUS_NO_MEMORY
			0xC000012D: // STATUS_COMMITMENT_LIMIT
			return true
		}
	}
	lower := strings.ToLower(stderr)
	return strings.Contains(lower, "out of memory") ||
		strings.Contains(lower, "commitment limit")
}
