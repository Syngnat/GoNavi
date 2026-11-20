//go:build !windows

package scriptengine

import "os"

func workerExitIndicatesMemoryLimit(*os.ProcessState, string) bool {
	return false
}
