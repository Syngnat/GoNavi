package app

import (
	"fmt"
	"strconv"
	"strings"
)

const windowsRestartParentPIDArgument = "--gonavi-restart-parent-pid="

func parseRestartParentPID(args []string) (uint32, bool, error) {
	for _, arg := range args {
		trimmed := strings.TrimSpace(arg)
		if !strings.HasPrefix(strings.ToLower(trimmed), windowsRestartParentPIDArgument) {
			continue
		}
		pidText := strings.TrimSpace(trimmed[len(windowsRestartParentPIDArgument):])
		pid, err := strconv.ParseUint(pidText, 10, 32)
		if err != nil || pid <= 1 {
			return 0, false, fmt.Errorf("invalid restart parent process ID %q", pidText)
		}
		return uint32(pid), true, nil
	}
	return 0, false, nil
}
