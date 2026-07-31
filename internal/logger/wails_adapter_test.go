package logger

import (
	"strings"
	"testing"
	"time"
)

func TestWailsAdapterWritesFrontendLogsToApplicationLog(t *testing.T) {
	sink := &slowSyncSink{}
	installTestSink(t, sink, time.Hour)
	adapter := NewWailsAdapter()

	adapter.Info("[SQL美化] 成功：language=plsql")
	adapter.Warning("frontend warning")
	adapter.Error("[SQL美化] 失败：error=Parse error")

	contents, _, _, _ := sink.snapshot()
	for _, expected := range []string{
		"[INFO] [Wails] [SQL美化] 成功：language=plsql",
		"[WARN] [Wails] frontend warning",
		"[ERROR] [Wails] [SQL美化] 失败：error=Parse error",
	} {
		if !strings.Contains(contents, expected) {
			t.Fatalf("application log %q does not contain %q", contents, expected)
		}
	}
}
