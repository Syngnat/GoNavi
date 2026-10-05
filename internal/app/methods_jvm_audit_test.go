package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/jvm"
)

func TestJVMListAuditRecordsReturnsLatestRecords(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	app.configDir = t.TempDir()
	store := jvm.NewAuditStore(filepath.Join(app.configDir, "jvm_audit.jsonl"))
	for _, record := range []jvm.AuditRecord{
		{Timestamp: 100, ConnectionID: "conn-orders", ProviderMode: "jmx", ResourceID: "/cache/orders", Action: "put", Reason: "first", Result: "applied"},
		{Timestamp: 200, ConnectionID: "conn-other", ProviderMode: "jmx", ResourceID: "/cache/other", Action: "put", Reason: "other", Result: "applied"},
		{Timestamp: 300, ConnectionID: "conn-orders", ProviderMode: "jmx", ResourceID: "/cache/orders", Action: "put", Reason: "latest", Result: "applied"},
	} {
		if err := store.Append(record); err != nil {
			t.Fatalf("Append returned error: %v", err)
		}
	}

	res := app.JVMListAuditRecords("conn-orders", 1)
	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	records, ok := res.Data.([]jvm.AuditRecord)
	if !ok {
		t.Fatalf("expected audit record slice, got %#v", res.Data)
	}
	if len(records) != 1 {
		t.Fatalf("expected one audit record, got %#v", records)
	}
	if records[0].Timestamp != 300 {
		t.Fatalf("expected latest timestamp %d, got %#v", 300, records[0])
	}
}

func TestJVMApplyChangeFailsClosedWhenInitialAuditWriteFails(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	tempDir := t.TempDir()
	blockerPath := filepath.Join(tempDir, "audit-blocker")
	if err := os.WriteFile(blockerPath, []byte("blocker"), 0o600); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	app.configDir = blockerPath
	expectedDetail := expectedAuditAppendError(t, blockerPath)

	readOnly := false
	var applyReq jvm.ChangeRequest
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{
				ResourceID: "/cache/orders",
				Kind:       "entry",
				Format:     "json",
				Value: map[string]any{
					"status": "stale",
				},
			},
			applyReq: &applyReq,
			apply: jvm.ApplyResult{
				Status: "applied",
			},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload: map[string]any{
			"status": "ready",
		},
	})

	if res.Success {
		t.Fatalf("expected fail-closed when initial audit write fails, got %+v", res)
	}
	want := "Failed to write audit record, JVM change was blocked: " + expectedDetail
	if res.Message != want {
		t.Fatalf("expected English audit failure message %q, got %q", want, res.Message)
	}
	if applyReq.ResourceID != "" {
		t.Fatalf("expected provider ApplyChange not to run, got %#v", applyReq)
	}
}

func TestJVMApplyChangeLatestAuditRecordIsTerminal(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	app.configDir = t.TempDir()
	readOnly := false

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{
				ResourceID: "/cache/orders",
				Kind:       "entry",
				Format:     "json",
				Value: map[string]any{
					"status": "stale",
				},
			},
			apply: jvm.ApplyResult{Status: "applied"},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload: map[string]any{
			"status": "ready",
		},
	})
	if !res.Success {
		t.Fatalf("expected apply success, got %+v", res)
	}

	latestRes := app.JVMListAuditRecords("conn-orders", 1)
	if !latestRes.Success {
		t.Fatalf("expected list success, got %+v", latestRes)
	}
	latestRecords, ok := latestRes.Data.([]jvm.AuditRecord)
	if !ok || len(latestRecords) != 1 {
		t.Fatalf("expected one latest audit record, got %#v", latestRes.Data)
	}
	if latestRecords[0].Result != "applied" {
		t.Fatalf("expected latest record applied, got %#v", latestRecords[0])
	}
}

func TestJVMApplyChangeApplySuccessKeepsSuccessWhenTerminalAuditFails(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	tempDir := t.TempDir()
	auditDir := filepath.Join(tempDir, "audit")
	if err := os.MkdirAll(auditDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	app.configDir = auditDir

	readOnly := false
	terminalAuditFailed := false
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{
				ResourceID: "/cache/orders",
				Kind:       "entry",
				Format:     "json",
			},
			applyFn: func(_ context.Context, _ connection.ConnectionConfig, _ jvm.ChangeRequest) (jvm.ApplyResult, error) {
				if !terminalAuditFailed {
					terminalAuditFailed = true
					forceAuditAppendFailureAfterPending(t, auditDir)
				}
				return jvm.ApplyResult{Status: "applied", Message: "ok"}, nil
			},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload: map[string]any{
			"status": "ready",
		},
	})

	if !res.Success {
		t.Fatalf("expected success when apply succeeded, got %+v", res)
	}
	result, ok := res.Data.(jvm.ApplyResult)
	if !ok {
		t.Fatalf("expected apply result data, got %#v", res.Data)
	}
	if result.Status != "applied" {
		t.Fatalf("expected applied status, got %#v", result)
	}
	expectedDetail := expectedAuditAppendError(t, auditDir)
	want := "ok; Failed to write terminal audit record: " + expectedDetail
	if result.Message != want {
		t.Fatalf("expected terminal audit warning %q, got %#v", want, result)
	}
}

func TestJVMApplyChangeApplyFailureReportsFailedAuditWriteError(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	tempDir := t.TempDir()
	auditDir := filepath.Join(tempDir, "audit")
	if err := os.MkdirAll(auditDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	app.configDir = auditDir

	readOnly := false
	failedAuditBlocked := false
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{
				ResourceID: "/cache/orders",
				Kind:       "entry",
				Format:     "json",
			},
			applyFn: func(_ context.Context, _ connection.ConnectionConfig, _ jvm.ChangeRequest) (jvm.ApplyResult, error) {
				if !failedAuditBlocked {
					failedAuditBlocked = true
					forceAuditAppendFailureAfterPending(t, auditDir)
				}
				return jvm.ApplyResult{}, errors.New("provider apply failed")
			},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload: map[string]any{
			"status": "ready",
		},
	})

	if res.Success {
		t.Fatalf("expected failure when apply fails, got %+v", res)
	}
	expectedDetail := expectedAuditAppendError(t, auditDir)
	want := "provider apply failed; Failed to write failure audit record: " + expectedDetail
	if res.Message != want {
		t.Fatalf("expected provider failure with failed audit warning %q, got %q", want, res.Message)
	}
}

func TestJVMApplyChangeApplyFailureKeepsProviderErrorWhenFailedAuditSucceeds(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	app.configDir = t.TempDir()
	readOnly := false

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{
				ResourceID: "/cache/orders",
				Kind:       "entry",
				Format:     "json",
			},
			applyErr: errors.New("provider apply failed"),
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload: map[string]any{
			"status": "ready",
		},
	})

	if res.Success {
		t.Fatalf("expected failure when provider apply fails, got %+v", res)
	}
	if res.Message != "provider apply failed" {
		t.Fatalf("expected provider failure only when failed audit succeeds, got %q", res.Message)
	}
}

func TestJVMApplyChangeUsesProviderErrorWhenFailedAuditAlsoFails(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	tempDir := t.TempDir()
	auditDir := filepath.Join(tempDir, "audit")
	if err := os.MkdirAll(auditDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	app.configDir = auditDir

	readOnly := false
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{
				ResourceID: "/cache/orders",
				Kind:       "entry",
				Format:     "json",
			},
			applyFn: func(_ context.Context, _ connection.ConnectionConfig, _ jvm.ChangeRequest) (jvm.ApplyResult, error) {
				forceAuditAppendFailureAfterPending(t, auditDir)
				return jvm.ApplyResult{}, errors.New("provider apply failed")
			},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload: map[string]any{
			"status": "ready",
		},
	})

	if res.Success {
		t.Fatalf("expected failure when provider apply fails, got %+v", res)
	}
	expectedDetail := expectedAuditAppendError(t, auditDir)
	want := "provider apply failed; Failed to write failure audit record: " + expectedDetail
	if res.Message != want {
		t.Fatalf("expected provider error with English failed audit warning %q, got %q", want, res.Message)
	}
}

func TestJVMApplyChangeTerminalAuditWarningAppendsToExistingResultMessage(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	tempDir := t.TempDir()
	auditDir := filepath.Join(tempDir, "audit")
	if err := os.MkdirAll(auditDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	app.configDir = auditDir

	readOnly := false
	terminalAuditFailed := false
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{ResourceID: "/cache/orders", Kind: "entry", Format: "json"},
			applyFn: func(_ context.Context, _ connection.ConnectionConfig, _ jvm.ChangeRequest) (jvm.ApplyResult, error) {
				if !terminalAuditFailed {
					terminalAuditFailed = true
					forceAuditAppendFailureAfterPending(t, auditDir)
				}
				return jvm.ApplyResult{Status: "applied", Message: "provider message"}, nil
			},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM:  connection.JVMConfig{ReadOnly: &readOnly, PreferredMode: "jmx", AllowedModes: []string{"jmx"}},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload:      map[string]any{"status": "ready"},
	})
	if !res.Success {
		t.Fatalf("expected success when apply succeeded, got %+v", res)
	}
	result, ok := res.Data.(jvm.ApplyResult)
	if !ok {
		t.Fatalf("expected apply result data, got %#v", res.Data)
	}
	expectedDetail := expectedAuditAppendError(t, auditDir)
	want := "provider message; Failed to write terminal audit record: " + expectedDetail
	if result.Message != want {
		t.Fatalf("expected provider message with English terminal audit warning %q, got %#v", want, result)
	}
}

func TestJVMApplyChangeTerminalAuditWarningUsesStandaloneMessageWhenResultMessageEmpty(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	tempDir := t.TempDir()
	auditDir := filepath.Join(tempDir, "audit")
	if err := os.MkdirAll(auditDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	app.configDir = auditDir

	readOnly := false
	terminalAuditFailed := false
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{ResourceID: "/cache/orders", Kind: "entry", Format: "json"},
			applyFn: func(_ context.Context, _ connection.ConnectionConfig, _ jvm.ChangeRequest) (jvm.ApplyResult, error) {
				if !terminalAuditFailed {
					terminalAuditFailed = true
					forceAuditAppendFailureAfterPending(t, auditDir)
				}
				return jvm.ApplyResult{Status: "applied"}, nil
			},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM:  connection.JVMConfig{ReadOnly: &readOnly, PreferredMode: "jmx", AllowedModes: []string{"jmx"}},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload:      map[string]any{"status": "ready"},
	})
	if !res.Success {
		t.Fatalf("expected success when apply succeeded, got %+v", res)
	}
	result, ok := res.Data.(jvm.ApplyResult)
	if !ok {
		t.Fatalf("expected apply result data, got %#v", res.Data)
	}
	expectedDetail := expectedAuditAppendError(t, auditDir)
	want := "Failed to write terminal audit record: " + expectedDetail
	if result.Message != want {
		t.Fatalf("expected standalone English terminal audit warning %q, got %#v", want, result)
	}
}

func TestJVMApplyChangeFailedAuditFailureMessageIncludesUnderlyingError(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	tempDir := t.TempDir()
	auditDir := filepath.Join(tempDir, "audit")
	if err := os.MkdirAll(auditDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	app.configDir = auditDir

	readOnly := false
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{ResourceID: "/cache/orders", Kind: "entry", Format: "json"},
			applyFn: func(_ context.Context, _ connection.ConnectionConfig, _ jvm.ChangeRequest) (jvm.ApplyResult, error) {
				forceAuditAppendFailureAfterPending(t, auditDir)
				return jvm.ApplyResult{}, errors.New("provider apply failed")
			},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM:  connection.JVMConfig{ReadOnly: &readOnly, PreferredMode: "jmx", AllowedModes: []string{"jmx"}},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload:      map[string]any{"status": "ready"},
	})
	if res.Success {
		t.Fatalf("expected failure when apply fails, got %+v", res)
	}
	expectedDetail := expectedAuditAppendError(t, auditDir)
	if !strings.Contains(res.Message, "Failed to write failure audit record: "+expectedDetail) {
		t.Fatalf("expected underlying audit failure detail %q in message, got %q", expectedDetail, res.Message)
	}
}

func TestJVMApplyChangeFailureMessageSeparatorUsesLocalizedEnglishSeparator(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	tempDir := t.TempDir()
	auditDir := filepath.Join(tempDir, "audit")
	if err := os.MkdirAll(auditDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	app.configDir = auditDir

	readOnly := false
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{ResourceID: "/cache/orders", Kind: "entry", Format: "json"},
			applyFn: func(_ context.Context, _ connection.ConnectionConfig, _ jvm.ChangeRequest) (jvm.ApplyResult, error) {
				forceAuditAppendFailureAfterPending(t, auditDir)
				return jvm.ApplyResult{}, errors.New("provider apply failed")
			},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM:  connection.JVMConfig{ReadOnly: &readOnly, PreferredMode: "jmx", AllowedModes: []string{"jmx"}},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload:      map[string]any{"status": "ready"},
	})
	if res.Success {
		t.Fatalf("expected failure when apply fails, got %+v", res)
	}
	if !strings.Contains(res.Message, "; Failed to write failure audit record: ") {
		t.Fatalf("expected English separator in failure message, got %q", res.Message)
	}
	if strings.Contains(res.Message, "；") {
		t.Fatalf("expected no Chinese semicolon separator in failure message, got %q", res.Message)
	}
}

func TestJVMApplyChangeLatestAuditRecordIsFailedWhenApplyFails(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	app.configDir = t.TempDir()
	readOnly := false

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value:    jvm.ValueSnapshot{ResourceID: "/cache/orders", Kind: "entry", Format: "json"},
			applyErr: errors.New("provider apply failed"),
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM:  connection.JVMConfig{ReadOnly: &readOnly, PreferredMode: "jmx", AllowedModes: []string{"jmx"}},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload:      map[string]any{"status": "ready"},
	})
	if res.Success {
		t.Fatalf("expected apply failure, got %+v", res)
	}

	latestRes := app.JVMListAuditRecords("conn-orders", 10)
	if !latestRes.Success {
		t.Fatalf("expected list success, got %+v", latestRes)
	}
	records, ok := latestRes.Data.([]jvm.AuditRecord)
	if !ok {
		t.Fatalf("expected records slice, got %#v", latestRes.Data)
	}
	if len(records) < 2 {
		t.Fatalf("expected at least pending and failed records, got %#v", records)
	}
	if records[0].Result != "failed" {
		t.Fatalf("expected latest record failed, got %#v", records[0])
	}

	var pendingTs, failedTs int64
	for _, record := range records {
		switch record.Result {
		case "pending":
			pendingTs = record.Timestamp
		case "failed":
			failedTs = record.Timestamp
		}
	}
	if pendingTs == 0 || failedTs == 0 {
		t.Fatalf("expected pending and failed records, got %#v", records)
	}
	if failedTs <= pendingTs {
		t.Fatalf("expected failed timestamp > pending timestamp, pending=%d failed=%d records=%#v", pendingTs, failedTs, records)
	}
}

func TestJVMApplyChangePendingAndTerminalAuditTimestampsAreStrictlyIncreasing(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	app.configDir = t.TempDir()
	readOnly := false

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{ResourceID: "/cache/orders", Kind: "entry", Format: "json"},
			apply: jvm.ApplyResult{Status: "applied"},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM:  connection.JVMConfig{ReadOnly: &readOnly, PreferredMode: "jmx", AllowedModes: []string{"jmx"}},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload:      map[string]any{"status": "ready"},
	})
	if !res.Success {
		t.Fatalf("expected apply success, got %+v", res)
	}

	listRes := app.JVMListAuditRecords("conn-orders", 10)
	if !listRes.Success {
		t.Fatalf("expected list success, got %+v", listRes)
	}
	records, ok := listRes.Data.([]jvm.AuditRecord)
	if !ok {
		t.Fatalf("expected records slice, got %#v", listRes.Data)
	}
	var pendingTs, terminalTs int64
	for _, record := range records {
		switch record.Result {
		case "pending":
			pendingTs = record.Timestamp
		case "applied":
			terminalTs = record.Timestamp
		}
	}
	if pendingTs == 0 || terminalTs == 0 {
		t.Fatalf("expected pending and applied records, got %#v", records)
	}
	if terminalTs <= pendingTs {
		t.Fatalf("expected terminal timestamp > pending timestamp, pending=%d terminal=%d records=%#v", pendingTs, terminalTs, records)
	}
}

func TestJVMApplyChangeTerminalAuditTimestampReflectsApplyCompletion(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	app.configDir = t.TempDir()
	readOnly := false

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{ResourceID: "/cache/orders", Kind: "entry", Format: "json"},
			applyFn: func(_ context.Context, _ connection.ConnectionConfig, _ jvm.ChangeRequest) (jvm.ApplyResult, error) {
				time.Sleep(15 * time.Millisecond)
				return jvm.ApplyResult{Status: "applied"}, nil
			},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM:  connection.JVMConfig{ReadOnly: &readOnly, PreferredMode: "jmx", AllowedModes: []string{"jmx"}},
	}, jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache delayed",
		Payload:      map[string]any{"status": "ready"},
	})
	if !res.Success {
		t.Fatalf("expected apply success, got %+v", res)
	}

	listRes := app.JVMListAuditRecords("conn-orders", 10)
	if !listRes.Success {
		t.Fatalf("expected list success, got %+v", listRes)
	}
	records, ok := listRes.Data.([]jvm.AuditRecord)
	if !ok {
		t.Fatalf("expected records slice, got %#v", listRes.Data)
	}
	var pendingTs, terminalTs int64
	for _, record := range records {
		if record.Reason != "repair cache delayed" {
			continue
		}
		switch record.Result {
		case "pending":
			pendingTs = record.Timestamp
		case "applied":
			terminalTs = record.Timestamp
		}
	}
	if pendingTs == 0 || terminalTs == 0 {
		t.Fatalf("expected pending and applied records for delayed apply, got %#v", records)
	}
	if terminalTs <= pendingTs+1 {
		t.Fatalf("expected delayed terminal timestamp to be strictly greater than pending+1, pending=%d terminal=%d records=%#v", pendingTs, terminalTs, records)
	}
}

func TestJVMApplyChangeTimestampGuaranteeHoldsAcrossMultipleApplies(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	app.configDir = t.TempDir()
	readOnly := false

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{ResourceID: "/cache/orders", Kind: "entry", Format: "json"},
			apply: jvm.ApplyResult{Status: "applied"},
		}, nil
	})
	defer restore()

	cfg := connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM:  connection.JVMConfig{ReadOnly: &readOnly, PreferredMode: "jmx", AllowedModes: []string{"jmx"}},
	}
	for i := 0; i < 3; i++ {
		res := app.JVMApplyChange(cfg, jvm.ChangeRequest{
			ProviderMode: "jmx",
			ResourceID:   "/cache/orders",
			Action:       "put",
			Reason:       fmt.Sprintf("repair cache %d", i),
			Payload:      map[string]any{"status": "ready"},
		})
		if !res.Success {
			t.Fatalf("apply %d expected success, got %+v", i, res)
		}
	}

	listRes := app.JVMListAuditRecords("conn-orders", 20)
	if !listRes.Success {
		t.Fatalf("expected list success, got %+v", listRes)
	}
	records, ok := listRes.Data.([]jvm.AuditRecord)
	if !ok {
		t.Fatalf("expected records slice, got %#v", listRes.Data)
	}
	reasonLatestTs := map[string]int64{}
	for _, record := range records {
		if strings.HasPrefix(record.Reason, "repair cache ") {
			reasonLatestTs[record.Reason+":"+record.Result] = record.Timestamp
		}
	}
	for i := 0; i < 3; i++ {
		reason := fmt.Sprintf("repair cache %d", i)
		pendingTs := reasonLatestTs[reason+":pending"]
		appliedTs := reasonLatestTs[reason+":applied"]
		if pendingTs == 0 || appliedTs == 0 {
			t.Fatalf("expected pending+applied for %s, got %#v", reason, records)
		}
		if appliedTs <= pendingTs {
			t.Fatalf("expected applied ts > pending ts for %s, pending=%d applied=%d", reason, pendingTs, appliedTs)
		}
	}
}
