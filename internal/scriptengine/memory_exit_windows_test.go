//go:build windows

package scriptengine

import "testing"

func TestWorkerExitIndicatesMemoryLimitFromStderr(t *testing.T) {
	if !workerExitIndicatesMemoryLimit(nil, "fatal error: out of memory") {
		t.Fatal("expected Windows out-of-memory stderr to be classified")
	}
	if workerExitIndicatesMemoryLimit(nil, "unrelated stderr") {
		t.Fatal("unrelated stderr must not be classified as a memory limit")
	}
}
