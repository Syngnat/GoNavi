package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/jvm"
)

func TestIssueJVMPreviewConfirmationTokenLocalizesPayloadHashError(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	readOnly := false

	_, err := app.issueJVMPreviewConfirmationToken(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			Environment:   jvm.EnvPROD,
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
			"callback": func() {},
		},
	}, jvm.ChangePreview{
		Allowed:              true,
		RequiresConfirmation: true,
		ConfirmationToken:    "preview-token",
		Summary:              "risky change",
		RiskLevel:            "high",
	})
	if err == nil {
		t.Fatalf("expected payload hash error")
	}

	got := err.Error()
	want := "Failed to generate JVM preview payload digest: json: unsupported type: func()"
	if got != want {
		t.Fatalf("expected localized payload hash error %q, got %q", want, got)
	}
	if strings.Contains(got, "生成 JVM 预览载荷摘要失败") {
		t.Fatalf("expected no Chinese payload hash prefix in message %q", got)
	}
}

func TestJVMPreviewChangeLocalizesConfirmationTokenFailure(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	readOnly := false

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			previewSet: true,
			preview: jvm.ChangePreview{
				Allowed:              true,
				RequiresConfirmation: true,
				Summary:              "risky change",
				RiskLevel:            "high",
			},
		}, nil
	})
	defer restore()

	res := app.JVMPreviewChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			Environment:   jvm.EnvPROD,
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
			"callback": func() {},
		},
	})
	if res.Success {
		t.Fatalf("expected preview failure, got %+v", res)
	}

	want := "Failed to generate JVM change confirmation token: json: unsupported type: func()"
	if res.Message != want {
		t.Fatalf("expected localized confirmation token error %q, got %q", want, res.Message)
	}
	if strings.Contains(res.Message, "生成 JVM 变更确认令牌失败") {
		t.Fatalf("expected no Chinese confirmation token prefix in message %q", res.Message)
	}
}

func TestJVMApplyChangeLocalizesConfirmationTokenFailure(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	readOnly := false

	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			previewSet: true,
			preview: jvm.ChangePreview{
				Allowed:              true,
				RequiresConfirmation: true,
				Summary:              "risky change",
				RiskLevel:            "high",
			},
		}, nil
	})
	defer restore()

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			Environment:   jvm.EnvPROD,
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
			"callback": func() {},
		},
	})
	if res.Success {
		t.Fatalf("expected apply preview failure, got %+v", res)
	}

	want := "Failed to generate JVM change confirmation token: json: unsupported type: func()"
	if res.Message != want {
		t.Fatalf("expected localized confirmation token error %q, got %q", want, res.Message)
	}
	if strings.Contains(res.Message, "生成 JVM 变更确认令牌失败") {
		t.Fatalf("expected no Chinese confirmation token prefix in message %q", res.Message)
	}
}

func TestJVMApplyChangeRejectsUnissuedDeterministicConfirmationToken(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	app.configDir = t.TempDir()
	readOnly := false
	var applyReq jvm.ChangeRequest

	provider := fakeJVMProvider{
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
		applyReq: &applyReq,
		apply: jvm.ApplyResult{
			Status: "applied",
		},
	}
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return provider, nil
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

	preview, err := jvm.BuildChangePreview(context.Background(), provider, cfg, req)
	if err != nil {
		t.Fatalf("BuildChangePreview returned error: %v", err)
	}
	if strings.TrimSpace(preview.ConfirmationToken) == "" {
		t.Fatalf("expected deterministic preview token, got %#v", preview)
	}

	req.ConfirmationToken = preview.ConfirmationToken
	res := app.JVMApplyChange(cfg, req)
	if res.Success {
		t.Fatalf("expected unissued confirmation token to fail, got %+v", res)
	}
	assertEnglishJVMConfirmationMessage(t, res.Message, "Confirmation token is invalid. Preview and confirm again.")
	if applyReq.ResourceID != "" {
		t.Fatalf("expected provider ApplyChange not to run, got %#v", applyReq)
	}
}

func TestJVMApplyChangeRejectsMismatchedPreviewConfirmationContext(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	app.configDir = t.TempDir()
	readOnly := false
	applyCalls := 0

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
			applyFn: func(context.Context, connection.ConnectionConfig, jvm.ChangeRequest) (jvm.ApplyResult, error) {
				applyCalls++
				return jvm.ApplyResult{Status: "applied"}, nil
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

	req.ConfirmationToken = preview.ConfirmationToken
	req.ResourceID = "/cache/customers"
	res := app.JVMApplyChange(cfg, req)
	if res.Success {
		t.Fatalf("expected mismatched confirmation context to fail, got %+v", res)
	}
	assertEnglishJVMConfirmationMessage(t, res.Message, "Confirmation token is invalid. Preview and confirm again.")
	if applyCalls != 0 {
		t.Fatalf("expected provider ApplyChange not to run, got %d calls", applyCalls)
	}
}

func TestJVMApplyChangeRejectsReplayedPreviewConfirmationToken(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	app.configDir = t.TempDir()
	readOnly := false
	applyCalls := 0

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
			applyFn: func(context.Context, connection.ConnectionConfig, jvm.ChangeRequest) (jvm.ApplyResult, error) {
				applyCalls++
				return jvm.ApplyResult{Status: "applied"}, nil
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
	req.ConfirmationToken = preview.ConfirmationToken

	firstRes := app.JVMApplyChange(cfg, req)
	if !firstRes.Success {
		t.Fatalf("expected first apply success, got %+v", firstRes)
	}
	secondRes := app.JVMApplyChange(cfg, req)
	if secondRes.Success {
		t.Fatalf("expected replayed confirmation token to fail, got %+v", secondRes)
	}
	if applyCalls != 1 {
		t.Fatalf("expected exactly one provider ApplyChange call, got %d", applyCalls)
	}
}

func TestJVMApplyChangeRejectsExpiredPreviewConfirmationToken(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	app.configDir = t.TempDir()
	app.jvmPreviewTokenTTL = time.Nanosecond
	readOnly := false
	applyCalls := 0

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
			applyFn: func(context.Context, connection.ConnectionConfig, jvm.ChangeRequest) (jvm.ApplyResult, error) {
				applyCalls++
				return jvm.ApplyResult{Status: "applied"}, nil
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
	time.Sleep(time.Millisecond)
	req.ConfirmationToken = preview.ConfirmationToken

	res := app.JVMApplyChange(cfg, req)
	if res.Success {
		t.Fatalf("expected expired confirmation token to fail, got %+v", res)
	}
	assertEnglishJVMConfirmationMessage(t, res.Message, "Confirmation token expired. Preview and confirm again.")
	if applyCalls != 0 {
		t.Fatalf("expected provider ApplyChange not to run, got %d calls", applyCalls)
	}
}

func TestJVMApplyChangePersistsAuditSource(t *testing.T) {
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

	res := app.JVMApplyChange(connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			PreferredMode: "endpoint",
			AllowedModes:  []string{"endpoint"},
		},
	}, jvm.ChangeRequest{
		ProviderMode: "endpoint",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
		Source:       "ai-plan",
		Payload: map[string]any{
			"status": "ready",
		},
	})
	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}

	listRes := app.JVMListAuditRecords("conn-orders", 10)
	if !listRes.Success {
		t.Fatalf("expected audit list success, got %+v", listRes)
	}
	records, ok := listRes.Data.([]jvm.AuditRecord)
	if !ok || len(records) < 2 {
		t.Fatalf("expected at least two audit records (pending+terminal), got %#v", listRes.Data)
	}
	var hasPending, hasApplied bool
	for _, record := range records {
		if record.Source != "ai-plan" {
			t.Fatalf("expected audit source %q, got %#v", "ai-plan", record)
		}
		switch record.Result {
		case "pending":
			hasPending = true
		case "applied":
			hasApplied = true
		}
	}
	if !hasPending || !hasApplied {
		t.Fatalf("expected pending and applied audit records, got %#v", records)
	}
}

func TestJVMApplyChangeNormalizesRequestBeforeProviderAndAudit(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	app.configDir = t.TempDir()
	readOnly := false
	var previewReq jvm.ChangeRequest
	var applyReq jvm.ChangeRequest
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{
				ResourceID: "/cache/orders",
				Kind:       "entry",
				Format:     "json",
			},
			previewReq: &previewReq,
			applyReq:   &applyReq,
			apply: jvm.ApplyResult{
				Status: "applied",
				UpdatedValue: jvm.ValueSnapshot{
					ResourceID: "/cache/orders",
					Kind:       "entry",
					Format:     "json",
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
			PreferredMode: "endpoint",
			AllowedModes:  []string{"endpoint"},
		},
	}, jvm.ChangeRequest{
		ProviderMode: " endpoint ",
		ResourceID:   " /cache/orders ",
		Action:       " put ",
		Reason:       " repair cache ",
		Source:       " manual ",
		Payload: map[string]any{
			"status": "ready",
		},
	})
	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	if previewReq.ProviderMode != "endpoint" || previewReq.ResourceID != "/cache/orders" || previewReq.Action != "put" || previewReq.Reason != "repair cache" {
		t.Fatalf("expected normalized preview request, got %#v", previewReq)
	}
	if applyReq.ProviderMode != "endpoint" || applyReq.ResourceID != "/cache/orders" || applyReq.Action != "put" || applyReq.Reason != "repair cache" || applyReq.Source != "manual" {
		t.Fatalf("expected normalized apply request, got %#v", applyReq)
	}

	listRes := app.JVMListAuditRecords("conn-orders", 10)
	if !listRes.Success {
		t.Fatalf("expected audit list success, got %+v", listRes)
	}
	records, ok := listRes.Data.([]jvm.AuditRecord)
	if !ok || len(records) < 2 {
		t.Fatalf("expected at least two audit records (pending+terminal), got %#v", listRes.Data)
	}
	var matchedTerminal bool
	for _, record := range records {
		if record.ProviderMode != "endpoint" || record.ResourceID != "/cache/orders" || record.Action != "put" || record.Reason != "repair cache" || record.Source != "manual" {
			t.Fatalf("expected normalized audit record, got %#v", record)
		}
		if record.Result == "applied" {
			matchedTerminal = true
		}
	}
	if !matchedTerminal {
		t.Fatalf("expected applied terminal audit record, got %#v", records)
	}
}

func TestJVMPreviewChangeRejectsDisallowedProviderMode(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")

	cfg := connection.ConnectionConfig{
		Type: "jvm",
		ID:   "conn-orders",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "endpoint",
			AllowedModes:  []string{"endpoint"},
		},
	}
	req := jvm.ChangeRequest{
		ProviderMode: "jmx",
		ResourceID:   "/cache/orders",
		Action:       "put",
		Reason:       "repair cache",
	}

	res := app.JVMPreviewChange(cfg, req)

	if res.Success {
		t.Fatalf("expected preview request to be rejected, got %+v", res)
	}
	want := "Current connection does not allow jmx mode"
	if res.Message != want {
		t.Fatalf("expected localized disallowed mode error %q, got %+v", want, res)
	}
	if strings.Contains(res.Message, "不允许使用") || strings.Contains(res.Message, "jvm.backend.") {
		t.Fatalf("expected no Chinese or raw key in disallowed mode error, got %q", res.Message)
	}

	applyRes := app.JVMApplyChange(cfg, req)
	if applyRes.Success {
		t.Fatalf("expected apply request to be rejected, got %+v", applyRes)
	}
	if applyRes.Message != want {
		t.Fatalf("expected localized apply disallowed mode error %q, got %+v", want, applyRes)
	}
}
