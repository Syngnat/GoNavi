package app

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/jvm"
)

func TestJVMProbeCapabilitiesReturnsCapabilityArray(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			probe: []jvm.Capability{{Mode: jvm.ModeJMX, CanBrowse: true, CanWrite: false, CanPreview: false, DisplayLabel: "JMX"}},
		}, nil
	})
	defer restore()

	res := app.JVMProbeCapabilities(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	})

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	items, ok := res.Data.([]jvm.Capability)
	if !ok || len(items) != 1 {
		t.Fatalf("expected one capability, got %#v", res.Data)
	}
}

func TestJVMProbeCapabilitiesIncludesReasonWhenProbeFails(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			probeErr: errors.New("probe failed"),
		}, nil
	})
	defer restore()

	res := app.JVMProbeCapabilities(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	})

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	items, ok := res.Data.([]jvm.Capability)
	if !ok || len(items) != 1 {
		t.Fatalf("expected one capability, got %#v", res.Data)
	}
	if items[0].Reason != "probe failed" {
		t.Fatalf("expected reason %q, got %#v", "probe failed", items[0])
	}
}

func TestJVMProbeCapabilitiesLocalizesBuiltInReadOnlyReasons(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	restore := swapJVMProviderFactory(jvm.NewProvider)
	defer restore()

	readOnly := true
	res := app.JVMProbeCapabilities(connection.ConnectionConfig{
		Type:    "jvm",
		Host:    "orders.internal",
		Timeout: 3,
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx", "endpoint", "agent"},
			JMX: connection.JVMJMXConfig{
				Host: "127.0.0.1",
				Port: 9010,
			},
			Endpoint: connection.JVMEndpointConfig{
				BaseURL:        "https://orders.internal/manage/jvm",
				TimeoutSeconds: 3,
			},
			Agent: connection.JVMAgentConfig{
				BaseURL:        "https://orders.internal/agent",
				TimeoutSeconds: 3,
			},
		},
	})

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	items, ok := res.Data.([]jvm.Capability)
	if !ok || len(items) != 3 {
		t.Fatalf("expected three capabilities, got %#v", res.Data)
	}
	for _, item := range items {
		if item.CanWrite {
			t.Fatalf("expected read-only capability for %s, got %#v", item.Mode, item)
		}
		if item.Reason != "Current connection is read-only, so writes are blocked" {
			t.Fatalf("expected localized read-only reason for %s, got %#v", item.Mode, item)
		}
		if strings.Contains(item.Reason, "jvm.backend.") || strings.Contains(item.Reason, "只读") {
			t.Fatalf("expected no key or Chinese text in reason for %s, got %q", item.Mode, item.Reason)
		}
	}
}

func TestJVMProbeCapabilitiesKeepsProviderReasonThatLooksLikeCatalogKeyRaw(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "en-US")
	providerReason := "jvm.backend.error.change_blocked_read_only"
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			probe: []jvm.Capability{{
				Mode:         jvm.ModeJMX,
				CanBrowse:    true,
				CanWrite:     false,
				CanPreview:   true,
				DisplayLabel: "JMX",
				Reason:       providerReason,
			}},
		}, nil
	})
	defer restore()

	res := app.JVMProbeCapabilities(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	})

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	items, ok := res.Data.([]jvm.Capability)
	if !ok || len(items) != 1 {
		t.Fatalf("expected one capability, got %#v", res.Data)
	}
	if items[0].Reason != providerReason {
		t.Fatalf("expected provider reason to stay raw, got %#v", items[0])
	}
}

func TestJVMProbeCapabilitiesTranslatesJMXProbeErrorUsingCurrentMode(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "zh-CN")
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			probeErr: errors.New("jmx test connection failed: jmx helper ping failed for localhost:18080: JMX command ping failed for localhost:18080: Failed to retrieve RMIServer stub: javax.naming.CommunicationException [Root exception is java.rmi.ConnectIOException: non-JRMP server at remote endpoint]; details={\"exception\":\"java.lang.IllegalStateException\"}"),
		}, nil
	})
	defer restore()

	res := app.JVMProbeCapabilities(connection.ConnectionConfig{
		Type: "jvm",
		Host: "localhost",
		Port: 18080,
		JVM: connection.JVMConfig{
			PreferredMode: "endpoint",
			AllowedModes:  []string{"jmx"},
		},
	})

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	items, ok := res.Data.([]jvm.Capability)
	if !ok || len(items) != 1 {
		t.Fatalf("expected one capability, got %#v", res.Data)
	}
	if !strings.Contains(items[0].Reason, "不是标准 JMX 远程管理端口") {
		t.Fatalf("expected translated JMX reason, got %#v", items[0])
	}
}

func TestJVMProbeCapabilitiesIncludesReasonWhenProviderFactoryFails(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return nil, errors.New("provider disabled")
	})
	defer restore()

	res := app.JVMProbeCapabilities(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "endpoint",
			AllowedModes:  []string{"endpoint"},
		},
	})

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	items, ok := res.Data.([]jvm.Capability)
	if !ok || len(items) != 1 {
		t.Fatalf("expected one capability, got %#v", res.Data)
	}
	if items[0].Reason != "provider disabled" {
		t.Fatalf("expected reason %q, got %#v", "provider disabled", items[0])
	}
	if items[0].DisplayLabel != "Endpoint" {
		t.Fatalf("expected display label %q, got %#v", "Endpoint", items[0])
	}
}

func TestJVMProbeCapabilitiesUsesReadableLabelForAgentValidationError(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "zh-CN")
	restore := swapJVMProviderFactory(jvm.NewProvider)
	defer restore()

	res := app.JVMProbeCapabilities(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "agent",
			AllowedModes:  []string{"agent"},
		},
	})

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	items, ok := res.Data.([]jvm.Capability)
	if !ok || len(items) != 1 {
		t.Fatalf("expected one capability, got %#v", res.Data)
	}
	if items[0].DisplayLabel != "Agent" {
		t.Fatalf("expected display label %q, got %#v", "Agent", items[0])
	}
	if !strings.Contains(items[0].Reason, "未填写 Agent Base URL") {
		t.Fatalf("expected agent validation error, got %#v", items[0])
	}
}

func TestJVMProbeCapabilitiesUsesReadableLabelForEndpointValidationError(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	setJVMTestLanguage(t, app, "zh-CN")
	restore := swapJVMProviderFactory(jvm.NewProvider)
	defer restore()

	res := app.JVMProbeCapabilities(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "endpoint",
			AllowedModes:  []string{"endpoint"},
		},
	})

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	items, ok := res.Data.([]jvm.Capability)
	if !ok || len(items) != 1 {
		t.Fatalf("expected one capability, got %#v", res.Data)
	}
	if items[0].DisplayLabel != "Endpoint" {
		t.Fatalf("expected display label %q, got %#v", "Endpoint", items[0])
	}
	if !strings.Contains(items[0].Reason, "未填写 Endpoint Base URL") {
		t.Fatalf("expected endpoint validation error, got %#v", items[0])
	}
}

func TestJVMListResourcesReturnsProviderPayload(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			list: []jvm.ResourceSummary{
				{
					ID:           "memory.heap",
					Kind:         "folder",
					Name:         "Heap",
					Path:         "/memory/heap",
					ProviderMode: jvm.ModeJMX,
					CanRead:      true,
					HasChildren:  true,
				},
			},
		}, nil
	})
	defer restore()

	res := app.JVMListResources(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	}, "/memory")

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	items, ok := res.Data.([]jvm.ResourceSummary)
	if !ok || len(items) != 1 {
		t.Fatalf("expected one resource summary, got %#v", res.Data)
	}
	if items[0].Path != "/memory/heap" {
		t.Fatalf("expected resource path %q, got %#v", "/memory/heap", items[0])
	}
}

func TestJVMGetValueReturnsProviderPayload(t *testing.T) {
	app := NewAppWithSecretStore(nil)
	restore := swapJVMProviderFactory(func(mode string) (jvm.Provider, error) {
		return fakeJVMProvider{
			value: jvm.ValueSnapshot{
				ResourceID: "memory.heap.used",
				Kind:       "metric",
				Format:     "number",
				Value:      128,
				Metadata: map[string]any{
					"unit": "MiB",
				},
			},
		}, nil
	})
	defer restore()

	res := app.JVMGetValue(connection.ConnectionConfig{
		Type: "jvm",
		Host: "orders.internal",
		JVM: connection.JVMConfig{
			PreferredMode: "jmx",
			AllowedModes:  []string{"jmx"},
		},
	}, "/memory/heap/used")

	if !res.Success {
		t.Fatalf("expected success, got %+v", res)
	}
	snapshot, ok := res.Data.(jvm.ValueSnapshot)
	if !ok {
		t.Fatalf("expected value snapshot, got %#v", res.Data)
	}
	if snapshot.ResourceID != "memory.heap.used" {
		t.Fatalf("expected resource id %q, got %#v", "memory.heap.used", snapshot)
	}
	if snapshot.Metadata["unit"] != "MiB" {
		t.Fatalf("expected unit metadata %q, got %#v", "MiB", snapshot.Metadata)
	}
}
