//go:build windows

package singleinstance

import (
	"bytes"
	"os"
	"os/exec"
	"testing"
	"time"
)

const windowsDelayedListenerHelperEnvironment = "GONAVI_SINGLEINSTANCE_DELAYED_HELPER"

func TestWindowsSecondProcessWaitsForDelayedPrimaryListener(t *testing.T) {
	if os.Getenv(windowsDelayedListenerHelperEnvironment) == "1" {
		name := os.Getenv("GONAVI_SINGLEINSTANCE_TEST_NAME")
		result := Acquire(name)
		if result.Acquired {
			t.Fatal("helper unexpectedly became the primary instance")
		}
		if result.AcquireErr != nil {
			t.Fatalf("helper lock error: %v", result.AcquireErr)
		}
		if result.NotifyErr != nil {
			t.Fatalf("helper notification error: %v", result.NotifyErr)
		}
		return
	}

	name := uniqueName(t) + "-process"
	_ = os.Remove(endpointFilePath(name))
	primary := Acquire(name)
	if !primary.Acquired {
		t.Fatalf("primary acquire failed: %v", primary.AcquireErr)
	}
	defer primary.Handle.Close()

	command := exec.Command(os.Args[0], "-test.run=^TestWindowsSecondProcessWaitsForDelayedPrimaryListener$")
	command.Env = append(os.Environ(),
		windowsDelayedListenerHelperEnvironment+"=1",
		"GONAVI_SINGLEINSTANCE_TEST_NAME="+name,
	)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Start(); err != nil {
		t.Fatalf("start helper process: %v", err)
	}

	// 故意扩大 Acquire -> Listen 的冷启动窗口，证明第二进程会等待 IPC
	// 就绪，而不是通知失败后成为新主实例或直接丢失激活请求。
	time.Sleep(150 * time.Millisecond)
	received := make(chan struct{}, 1)
	if err := primary.Handle.Listen(name, func() error {
		received <- struct{}{}
		return nil
	}); err != nil {
		_ = command.Process.Kill()
		t.Fatalf("listen failed: %v", err)
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("helper process failed: %v\n%s", err, output.String())
	}

	select {
	case <-received:
	case <-time.After(2 * time.Second):
		t.Fatal("primary did not receive the helper activation message")
	}
}
