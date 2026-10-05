package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/jvm"
)

func TestJVMApplyChangeRequiresConfirmationTokenForHighRiskPreview(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	app.configDir = t.TempDir()
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
			previewSet: true,
			preview: jvm.ChangePreview{
				Allowed:   true,
				Summary:   "risky change",
				RiskLevel: "high",
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
		t.Fatalf("expected missing confirmation token to fail, got %+v", res)
	}
	assertEnglishJVMConfirmationMessage(t, res.Message, "Confirmation token is missing. Complete preview confirmation first.")
	if applyReq.ResourceID != "" {
		t.Fatalf("expected provider ApplyChange not to run, got %#v", applyReq)
	}
}

func TestJVMApplyChangeReturnsProviderPayload(t *testing.T) {
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
			apply: jvm.ApplyResult{
				Status:  "applied",
				Message: "ok",
				UpdatedValue: jvm.ValueSnapshot{
					ResourceID: "/cache/orders",
					Kind:       "entry",
					Format:     "json",
					Value: map[string]any{
						"status": "ready",
					},
				},
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
		t.Fatalf("expected success, got %+v", res)
	}
	result, ok := res.Data.(jvm.ApplyResult)
	if !ok {
		t.Fatalf("expected apply result, got %#v", res.Data)
	}
	if result.Status != "applied" {
		t.Fatalf("expected status %q, got %#v", "applied", result)
	}
	if result.UpdatedValue.ResourceID != "/cache/orders" {
		t.Fatalf("expected updated resource id %q, got %#v", "/cache/orders", result.UpdatedValue)
	}
}

func TestJVMApplyChangeUsesEnglishGuardFallbackWhenBlockingReasonEmpty(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	app.configDir = t.TempDir()
	readOnly := false
	var applyReq jvm.ChangeRequest

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{
				ResourceID: "/cache/orders",
				Kind:       "entry",
				Format:     "json",
			},
			previewSet: true,
			preview: jvm.ChangePreview{
				Allowed: false,
			},
			applyReq: &applyReq,
			apply:    jvm.ApplyResult{Status: "applied"},
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
		Payload:      map[string]any{"status": "ready"},
	})

	if res.Success {
		t.Fatalf("expected guard-blocked apply to fail, got %+v", res)
	}
	if res.Message != "The current change was blocked by Guard" {
		t.Fatalf("expected English guard fallback message, got %q", res.Message)
	}
	if applyReq.ResourceID != "" {
		t.Fatalf("expected provider ApplyChange not to run, got %#v", applyReq)
	}
}

func TestJVMProviderBlockingReasonThatLooksLikeCatalogKeyStaysRaw(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	app.configDir = t.TempDir()
	readOnly := false
	providerReason := "jvm.backend.error.change_blocked_read_only"
	var applyReq jvm.ChangeRequest

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			previewSet: true,
			preview: jvm.ChangePreview{
				Allowed:        false,
				BlockingReason: providerReason,
			},
			applyReq: &applyReq,
			apply:    jvm.ApplyResult{Status: "applied"},
		}, nil
	})
	defer restore()

	cfg := connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-provider-reason",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	}
	req := jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload:      map[string]any{"status": "ready"},
	}

	previewRes := app.JVMPreviewChange(cfg, req)
	if !previewRes.Success {
		t.Fatalf("expected blocked preview result, got %+v", previewRes)
	}
	preview, ok := previewRes.Data.(jvm.ChangePreview)
	if !ok {
		t.Fatalf("expected preview data, got %#v", previewRes.Data)
	}
	if preview.BlockingReason != providerReason {
		t.Fatalf("expected provider blocking reason to stay raw, got %q", preview.BlockingReason)
	}

	applyRes := app.JVMApplyChange(cfg, req)
	if applyRes.Success {
		t.Fatalf("expected provider-blocked apply to fail, got %+v", applyRes)
	}
	if applyRes.Message != providerReason {
		t.Fatalf("expected provider blocking message to stay raw, got %q", applyRes.Message)
	}
	if applyReq.ResourceID != "" {
		t.Fatalf("expected provider ApplyChange not to run, got %#v", applyReq)
	}
}

func TestJVMPreviewChange(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	readOnly := true

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{}, nil
	})
	defer restore()

	res := app.JVMPreviewChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-readonly",
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
		Payload:      map[string]any{"status": "ready"},
	})

	if !res.Success {
		t.Fatalf("expected read-only preview to return blocked preview, got %+v", res)
	}
	preview, ok := res.Data.(jvm.ChangePreview)
	if !ok {
		t.Fatalf("expected preview data, got %#v", res.Data)
	}
	if preview.Allowed {
		t.Fatalf("expected preview to be blocked, got %#v", preview)
	}
	if preview.BlockingReason != "Current connection is read-only, so writes are blocked" {
		t.Fatalf("expected localized read-only blocking reason, got %#v", preview)
	}
	if strings.Contains(preview.BlockingReason, "jvm.backend.") || strings.Contains(preview.BlockingReason, "只读") {
		t.Fatalf("expected app boundary to localize blocking reason, got %q", preview.BlockingReason)
	}
}

func TestJVMApplyChange(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	app.configDir = t.TempDir()
	readOnly := true
	var applyReq jvm.ChangeRequest

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			applyReq: &applyReq,
			apply:    jvm.ApplyResult{Status: "applied"},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-readonly",
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
		Payload:      map[string]any{"status": "ready"},
	})

	if res.Success {
		t.Fatalf("expected read-only apply to fail, got %+v", res)
	}
	if res.Message != "Current connection is read-only, so writes are blocked" {
		t.Fatalf("expected localized read-only blocking reason, got %q", res.Message)
	}
	if strings.Contains(res.Message, "jvm.backend.") || strings.Contains(res.Message, "只读") {
		t.Fatalf("expected app boundary to localize blocking reason, got %q", res.Message)
	}
	if applyReq.ResourceID != "" {
		t.Fatalf("expected provider ApplyChange not to run, got %#v", applyReq)
	}
}

func TestJVMApplyChangePreviewTokenAllowsConfirmedApply(t *testing.T) {
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
			previewSet: true,
			preview: jvm.ChangePreview{
				Allowed:              true,
				RequiresConfirmation: true,
				Summary:              "risky change",
				RiskLevel:            "high",
			},
			apply: jvm.ApplyResult{
				Status: "applied",
				UpdatedValue: jvm.ValueSnapshot{
					ResourceID: "/cache/orders",
					Kind:       "entry",
					Format:     "json",
					Value: map[string]any{
						"status": "ready",
					},
				},
			},
		}, nil
	})
	defer restore()

	cfg := connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			Environment:   jvm.EnvPROD,
			ReadOnly:      &readOnly,
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	}

	req := jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Payload: map[string]any{
			"status": "ready",
		},
	}

	previewRes := app.JVMPreviewChange(cfg, req)
	if !previewRes.Success {
		t.Fatalf("expected preview success, got %+v", previewRes)
	}
	preview, ok := previewRes.Data.(jvm.ChangePreview)
	if !ok {
		t.Fatalf("expected preview payload, got %#v", previewRes.Data)
	}
	if strings.TrimSpace(preview.ConfirmationToken) == "" {
		t.Fatalf("expected confirmation token, got %#v", preview)
	}

	req.ConfirmationToken = preview.ConfirmationToken
	applyRes := app.JVMApplyChange(cfg, req)
	if !applyRes.Success {
		t.Fatalf("expected apply success with confirmation token, got %+v", applyRes)
	}

	listRes := app.JVMListAuditRecords("conn-orders", 10)
	if !listRes.Success {
		t.Fatalf("expected audit list success, got %+v", listRes)
	}
	records, ok := listRes.Data.([]jvm.AuditRecord)
	if !ok {
		t.Fatalf("expected audit record slice, got %#v", listRes.Data)
	}
	var hasPending, hasApplied bool
	for _, record := range records {
		switch record.Result {
		case "pending":
			hasPending = true
		case "applied":
			hasApplied = true
		}
	}
	if !hasPending || !hasApplied {
		t.Fatalf("expected pending+applied records, got %#v", records)
	}
}
