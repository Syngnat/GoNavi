package jvm

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

type stubJMXHelper struct {
	lastRequest jmxHelperRequest
	response    jmxHelperResponse
	err         error
}

func withStubJMXHelper(
	t *testing.T,
	fn func(context.Context, connection.ConnectionConfig, string, *jmxResourceTarget, *ChangeRequest) (jmxHelperResponse, error),
) {
	t.Helper()
	prev := jmxHelperRunner
	jmxHelperRunner = fn
	t.Cleanup(func() {
		jmxHelperRunner = prev
	})
}

func (s *stubJMXHelper) run(_ context.Context, cfg connection.ConnectionConfig, command string, target *jmxResourceTarget, change *ChangeRequest) (jmxHelperResponse, error) {
	s.lastRequest = jmxHelperRequest{
		Command: command,
		Connection: jmxHelperConnection{
			Host:            resolveJMXHost(cfg),
			Port:            resolveJMXPort(cfg),
			Username:        strings.TrimSpace(cfg.JVM.JMX.Username),
			Password:        cfg.JVM.JMX.Password,
			DomainAllowlist: normalizeJMXAllowlist(cfg.JVM.JMX.DomainAllowlist),
			TimeoutSeconds:  int(resolveJMXTimeout(cfg).Seconds()),
		},
	}
	if target != nil {
		s.lastRequest.Target = helperTargetFromResource(*target)
	}
	if change != nil {
		s.lastRequest.Change = &jmxHelperChangePlan{
			Action:          change.Action,
			Reason:          change.Reason,
			ExpectedVersion: change.ExpectedVersion,
			Payload:         change.Payload,
		}
	}
	if s.err != nil {
		return jmxHelperResponse{}, s.err
	}
	return s.response, nil
}

func newJMXProviderTestConfig() connection.ConnectionConfig {
	readOnly := false
	return connection.ConnectionConfig{
		Type:    "jvm",
		Host:    "127.0.0.1",
		Timeout: 5,
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			AllowedModes:  []string{ModeJMX},
			PreferredMode: ModeJMX,
			JMX: connection.JVMJMXConfig{
				Host: "127.0.0.1",
				Port: 9010,
			},
		},
	}
}

func TestJMXProviderListResourcesUsesHelperResponse(t *testing.T) {
	helper := &stubJMXHelper{
		response: jmxHelperResponse{
			Resources: []jmxHelperResource{
				{
					Kind:        "domain",
					Name:        "java.lang",
					CanRead:     true,
					HasChildren: true,
					Domain:      "java.lang",
				},
			},
		},
	}
	withStubJMXHelper(t, helper.run)
	provider := &JMXProvider{}

	items, err := provider.ListResources(context.Background(), newJMXProviderTestConfig(), "")
	if err != nil {
		t.Fatalf("ListResources returned error: %v", err)
	}
	if helper.lastRequest.Command != jmxHelperCommandList {
		t.Fatalf("expected helper command %q, got %#v", jmxHelperCommandList, helper.lastRequest)
	}
	if len(items) != 1 || items[0].Kind != "domain" || items[0].Path == "" {
		t.Fatalf("unexpected resources: %#v", items)
	}
}

func TestJMXProviderGetValueUsesHelperSnapshot(t *testing.T) {
	helper := &stubJMXHelper{
		response: jmxHelperResponse{
			Snapshot: &jmxHelperSnapshot{
				Kind:   "attribute",
				Format: "string",
				Value:  "READY",
			},
		},
	}
	withStubJMXHelper(t, helper.run)
	provider := &JMXProvider{}

	snapshot, err := provider.GetValue(context.Background(), newJMXProviderTestConfig(), "jmx:/attribute/bean/State")
	if err != nil {
		t.Fatalf("GetValue returned error: %v", err)
	}
	if helper.lastRequest.Command != jmxHelperCommandGet {
		t.Fatalf("expected helper command %q, got %#v", jmxHelperCommandGet, helper.lastRequest)
	}
	if snapshot.ResourceID != "jmx:/attribute/bean/State" || snapshot.Value != "READY" || snapshot.Version == "" {
		t.Fatalf("unexpected snapshot: %#v", snapshot)
	}
}

func TestJMXProviderGetMonitoringSnapshotUsesHelperMonitorCommand(t *testing.T) {
	helper := &stubJMXHelper{
		response: jmxHelperResponse{
			MonitoringSnapshot: &jmxHelperMonitoringSnapshot{
				Point: jmxHelperMonitoringPoint{
					Timestamp:                   1713945600000,
					ThreadCount:                 33,
					HeapUsedBytes:               536870912,
					ProcessCpuLoad:              0.37,
					LoadedClassCount:            2048,
					ProcessRssBytes:             1610612736,
					CommittedVirtualMemoryBytes: 2147483648,
				},
				RecentGCEvents: []RecentGCEvent{{
					Timestamp:  1713945600000,
					Name:       "G1 Young Generation",
					Cause:      "G1 Evacuation Pause",
					DurationMs: 18,
				}},
				AvailableMetrics: []string{"thread.count", "heap.used", "class.loading", "memory.rss"},
				MissingMetrics:   []string{"cpu.system"},
			},
		},
	}
	withStubJMXHelper(t, helper.run)
	provider := &JMXProvider{}

	snapshot, err := provider.GetMonitoringSnapshot(context.Background(), newJMXProviderTestConfig(), nil)
	if err != nil {
		t.Fatalf("GetMonitoringSnapshot returned error: %v", err)
	}
	if helper.lastRequest.Command != jmxHelperCommandMonitor {
		t.Fatalf("expected helper command %q, got %#v", jmxHelperCommandMonitor, helper.lastRequest)
	}
	if snapshot.Point.ThreadCount != 33 || snapshot.Point.HeapUsedBytes != 536870912 || snapshot.Point.LoadedClassCount != 2048 {
		t.Fatalf("unexpected monitoring snapshot: %#v", snapshot)
	}
	if len(snapshot.RecentGCEvents) != 1 || snapshot.RecentGCEvents[0].DurationMs != 18 {
		t.Fatalf("unexpected recent gc events: %#v", snapshot.RecentGCEvents)
	}
	if len(snapshot.MissingMetrics) != 1 || snapshot.MissingMetrics[0] != "cpu.system" {
		t.Fatalf("unexpected missing metrics: %#v", snapshot)
	}
}

func TestJMXProviderPreviewAndApplyUseHelperPayload(t *testing.T) {
	request := ChangeRequest{
		ProviderMode: ModeJMX,
		ResourceID:   "jmx:/attribute/bean/State",
		Action:       "set",
		Reason:       "repair state",
		Payload: map[string]any{
			"value": "READY",
		},
	}

	previewHelper := &stubJMXHelper{
		response: jmxHelperResponse{
			Preview: &jmxHelperPreview{
				Allowed:   true,
				Summary:   "preview ok",
				RiskLevel: "low",
				Before: &jmxHelperSnapshot{
					Kind:   "attribute",
					Format: "string",
					Value:  "STALE",
				},
				After: &jmxHelperSnapshot{
					Kind:   "attribute",
					Format: "string",
					Value:  "READY",
				},
			},
		},
	}
	withStubJMXHelper(t, previewHelper.run)
	provider := &JMXProvider{}

	preview, err := provider.PreviewChange(context.Background(), newJMXProviderTestConfig(), request)
	if err != nil {
		t.Fatalf("PreviewChange returned error: %v", err)
	}
	if previewHelper.lastRequest.Command != jmxHelperCommandPreview {
		t.Fatalf("expected helper command %q, got %#v", jmxHelperCommandPreview, previewHelper.lastRequest)
	}
	if previewHelper.lastRequest.Change.Action != "set" || preview.Summary != "preview ok" {
		t.Fatalf("unexpected preview response: %#v / %#v", preview, previewHelper.lastRequest)
	}

	applyHelper := &stubJMXHelper{
		response: jmxHelperResponse{
			ApplyResult: &jmxHelperApplyResponse{
				Status:  "applied",
				Message: "updated",
				UpdatedValue: &jmxHelperSnapshot{
					Kind:   "attribute",
					Format: "string",
					Value:  "READY",
				},
			},
		},
	}
	withStubJMXHelper(t, applyHelper.run)
	provider = &JMXProvider{}

	result, err := provider.ApplyChange(context.Background(), newJMXProviderTestConfig(), request)
	if err != nil {
		t.Fatalf("ApplyChange returned error: %v", err)
	}
	if applyHelper.lastRequest.Command != jmxHelperCommandApply {
		t.Fatalf("expected helper command %q, got %#v", jmxHelperCommandApply, applyHelper.lastRequest)
	}
	if result.Status != "applied" || result.UpdatedValue.Value != "READY" {
		t.Fatalf("unexpected apply result: %#v", result)
	}
}

func TestJMXProviderWrapsHelperErrors(t *testing.T) {
	helper := &stubJMXHelper{err: errors.New("helper failed")}
	withStubJMXHelper(t, helper.run)
	provider := &JMXProvider{}

	_, err := provider.ListResources(context.Background(), newJMXProviderTestConfig(), "")
	if err == nil {
		t.Fatal("expected helper error")
	}
	if got := err.Error(); got == "" || !containsAll(got, "list", "helper failed") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestJMXProviderGetValueRejectsUnknownResourcePath(t *testing.T) {
	provider := NewJMXProvider()

	_, err := provider.GetValue(context.Background(), newJMXProviderTestConfig(), "bad-path")
	if err == nil {
		t.Fatal("expected invalid resource path to fail")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "resource path") {
		t.Fatalf("expected resource path context, got %v", err)
	}
}

func TestJMXProviderRealJMXRoundTrip(t *testing.T) {
	provider := NewJMXProvider()
	monitoringProvider, ok := provider.(MonitoringCapableProvider)
	if !ok {
		t.Fatal("expected JMX provider to implement monitoring snapshots")
	}
	fixture := startJMXFixture(t)
	readOnly := false
	cfg := connection.ConnectionConfig{
		Type:    "jvm",
		Host:    "127.0.0.1",
		Timeout: 8,
		JVM: connection.JVMConfig{
			ReadOnly:      &readOnly,
			PreferredMode: ModeJMX,
			AllowedModes:  []string{ModeJMX},
			JMX: connection.JVMJMXConfig{
				Host:            "127.0.0.1",
				Port:            fixture.port,
				DomainAllowlist: []string{"com.gonavi.fixture"},
			},
		},
	}
	t.Setenv("GONAVI_JMX_HELPER_CACHE_DIR", filepath.Join(t.TempDir(), "helper-cache"))

	waitForTest(t, 20*time.Second, func() error {
		return provider.TestConnection(context.Background(), cfg)
	})

	caps, err := provider.ProbeCapabilities(context.Background(), cfg)
	if err != nil {
		t.Fatalf("ProbeCapabilities returned error: %v", err)
	}
	if len(caps) != 1 || !caps[0].CanBrowse || !caps[0].CanWrite || !caps[0].CanPreview {
		t.Fatalf("unexpected capabilities: %#v", caps)
	}

	domains, err := provider.ListResources(context.Background(), cfg, "")
	if err != nil {
		t.Fatalf("ListResources(root) returned error: %v", err)
	}
	if len(domains) != 1 || domains[0].Name != "com.gonavi.fixture" {
		t.Fatalf("unexpected root resources: %#v", domains)
	}

	mbeans, err := provider.ListResources(context.Background(), cfg, domains[0].Path)
	if err != nil {
		t.Fatalf("ListResources(domain) returned error: %v", err)
	}
	if len(mbeans) != 1 {
		t.Fatalf("expected one mbean under test domain, got %#v", mbeans)
	}
	mbean := mbeans[0]

	blockedDomainPath := buildJMXResourcePath(jmxResourceTarget{
		Kind:   jmxResourceKindDomain,
		Domain: "java.lang",
	})
	_, err = provider.ListResources(context.Background(), cfg, blockedDomainPath)
	if err == nil {
		t.Fatal("expected list on blocked domain to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "java.lang") {
		t.Fatalf("expected blocked domain list context, got %v", err)
	}

	_, err = provider.GetValue(context.Background(), cfg, blockedDomainPath)
	if err == nil {
		t.Fatal("expected get on blocked domain to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "java.lang") {
		t.Fatalf("expected blocked domain get context, got %v", err)
	}

	blockedMBeanPath := buildJMXResourcePath(jmxResourceTarget{
		Kind:       jmxResourceKindMBean,
		ObjectName: "java.lang:type=Memory",
	})
	_, err = provider.ListResources(context.Background(), cfg, blockedMBeanPath)
	if err == nil {
		t.Fatal("expected list on blocked domain mbean to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "java.lang") {
		t.Fatalf("expected blocked domain mbean list context, got %v", err)
	}

	_, err = provider.GetValue(context.Background(), cfg, blockedMBeanPath)
	if err == nil {
		t.Fatal("expected direct mbean get on blocked domain to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "java.lang") {
		t.Fatalf("expected blocked domain mbean get context, got %v", err)
	}

	blockedAttributePath := buildJMXResourcePath(jmxResourceTarget{
		Kind:       jmxResourceKindAttribute,
		ObjectName: "java.lang:type=Memory",
		Attribute:  "HeapMemoryUsage",
	})
	_, err = provider.GetValue(context.Background(), cfg, blockedAttributePath)
	if err == nil {
		t.Fatal("expected direct attribute get on blocked domain to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "java.lang") {
		t.Fatalf("expected blocked domain attribute get context, got %v", err)
	}

	blockedOperationPath := buildJMXResourcePath(jmxResourceTarget{
		Kind:       jmxResourceKindOperation,
		ObjectName: "java.lang:type=Memory",
		Operation:  "gc",
	})
	_, err = provider.GetValue(context.Background(), cfg, blockedOperationPath)
	if err == nil {
		t.Fatal("expected direct operation get on blocked domain to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "java.lang") {
		t.Fatalf("expected blocked domain operation get context, got %v", err)
	}

	_, err = provider.PreviewChange(context.Background(), cfg, ChangeRequest{
		ProviderMode: ModeJMX,
		ResourceID:   blockedOperationPath,
		Action:       "invoke",
		Reason:       "尝试跨域操作预览",
	})
	if err == nil {
		t.Fatal("expected preview on blocked domain operation to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "java.lang") {
		t.Fatalf("expected blocked domain operation preview context, got %v", err)
	}

	_, err = provider.ApplyChange(context.Background(), cfg, ChangeRequest{
		ProviderMode: ModeJMX,
		ResourceID:   blockedOperationPath,
		Action:       "invoke",
		Reason:       "尝试跨域操作调用",
	})
	if err == nil {
		t.Fatal("expected apply on blocked domain operation to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "java.lang") {
		t.Fatalf("expected blocked domain operation apply context, got %v", err)
	}

	_, err = provider.PreviewChange(context.Background(), cfg, ChangeRequest{
		ProviderMode: ModeJMX,
		ResourceID:   blockedAttributePath,
		Action:       "update",
		Reason:       "尝试跨域属性预览",
		Payload: map[string]any{
			"value": "blocked",
		},
	})
	if err == nil {
		t.Fatal("expected preview on blocked domain attribute to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "java.lang") {
		t.Fatalf("expected blocked domain attribute preview context, got %v", err)
	}

	_, err = provider.ApplyChange(context.Background(), cfg, ChangeRequest{
		ProviderMode: ModeJMX,
		ResourceID:   blockedAttributePath,
		Action:       "update",
		Reason:       "尝试跨域属性修改",
		Payload: map[string]any{
			"value": "blocked",
		},
	})
	if err == nil {
		t.Fatal("expected apply on blocked domain attribute to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "java.lang") {
		t.Fatalf("expected blocked domain attribute apply context, got %v", err)
	}

	defaultDomainMBeanPath := buildJMXResourcePath(jmxResourceTarget{
		Kind:       jmxResourceKindMBean,
		ObjectName: ":type=CacheSettings,name=DefaultDomainCache",
	})
	_, err = provider.ListResources(context.Background(), cfg, defaultDomainMBeanPath)
	if err == nil {
		t.Fatal("expected list on default domain alias mbean to fail")
	}
	if got := err.Error(); !containsAll(got, "domain") {
		t.Fatalf("expected default domain alias mbean list context, got %v", err)
	}

	defaultDomainAttributePath := buildJMXResourcePath(jmxResourceTarget{
		Kind:       jmxResourceKindAttribute,
		ObjectName: ":type=CacheSettings,name=DefaultDomainCache",
		Attribute:  "Mode",
	})
	_, err = provider.GetValue(context.Background(), cfg, defaultDomainAttributePath)
	if err == nil {
		t.Fatal("expected get on default domain alias attribute to fail")
	}
	if got := err.Error(); !containsAll(got, "domain") {
		t.Fatalf("expected default domain alias attribute get context, got %v", err)
	}

	defaultDomainOperationPath := buildJMXResourcePath(jmxResourceTarget{
		Kind:       jmxResourceKindOperation,
		ObjectName: ":type=CacheSettings,name=DefaultDomainCache",
		Operation:  "resize",
		Signature:  []string{"int", "boolean"},
	})
	_, err = provider.PreviewChange(context.Background(), cfg, ChangeRequest{
		ProviderMode: ModeJMX,
		ResourceID:   defaultDomainOperationPath,
		Action:       "invoke",
		Reason:       "尝试默认域别名操作预览",
		Payload: map[string]any{
			"args": []any{3, true},
		},
	})
	if err == nil {
		t.Fatal("expected preview on default domain alias operation to fail")
	}
	if got := err.Error(); !containsAll(got, "domain") {
		t.Fatalf("expected default domain alias operation preview context, got %v", err)
	}

	_, err = provider.ApplyChange(context.Background(), cfg, ChangeRequest{
		ProviderMode: ModeJMX,
		ResourceID:   defaultDomainOperationPath,
		Action:       "invoke",
		Reason:       "尝试默认域别名操作调用",
		Payload: map[string]any{
			"args": []any{3, true},
		},
	})
	if err == nil {
		t.Fatal("expected apply on default domain alias operation to fail")
	}
	if got := err.Error(); !containsAll(got, "domain") {
		t.Fatalf("expected default domain alias operation apply context, got %v", err)
	}

	whitespaceDomainMBeanPath := buildJMXResourcePath(jmxResourceTarget{
		Kind:       jmxResourceKindMBean,
		ObjectName: "com.gonavi.fixture :type=CacheSettings,name=WhitespaceDomainCache",
	})
	_, err = provider.ListResources(context.Background(), cfg, whitespaceDomainMBeanPath)
	if err == nil {
		t.Fatal("expected list on whitespace-suffixed domain mbean to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "com.gonavi.fixture") {
		t.Fatalf("expected whitespace-suffixed domain mbean list context, got %v", err)
	}

	whitespaceDomainAttributePath := buildJMXResourcePath(jmxResourceTarget{
		Kind:       jmxResourceKindAttribute,
		ObjectName: "com.gonavi.fixture :type=CacheSettings,name=WhitespaceDomainCache",
		Attribute:  "Mode",
	})
	_, err = provider.GetValue(context.Background(), cfg, whitespaceDomainAttributePath)
	if err == nil {
		t.Fatal("expected get on whitespace-suffixed domain attribute to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "com.gonavi.fixture") {
		t.Fatalf("expected whitespace-suffixed domain attribute get context, got %v", err)
	}

	whitespaceDomainOperationPath := buildJMXResourcePath(jmxResourceTarget{
		Kind:       jmxResourceKindOperation,
		ObjectName: "com.gonavi.fixture :type=CacheSettings,name=WhitespaceDomainCache",
		Operation:  "resize",
		Signature:  []string{"int", "boolean"},
	})
	_, err = provider.PreviewChange(context.Background(), cfg, ChangeRequest{
		ProviderMode: ModeJMX,
		ResourceID:   whitespaceDomainOperationPath,
		Action:       "invoke",
		Reason:       "尝试空白后缀域操作预览",
		Payload: map[string]any{
			"args": []any{4, true},
		},
	})
	if err == nil {
		t.Fatal("expected preview on whitespace-suffixed domain operation to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "com.gonavi.fixture") {
		t.Fatalf("expected whitespace-suffixed domain operation preview context, got %v", err)
	}

	_, err = provider.ApplyChange(context.Background(), cfg, ChangeRequest{
		ProviderMode: ModeJMX,
		ResourceID:   whitespaceDomainOperationPath,
		Action:       "invoke",
		Reason:       "尝试空白后缀域操作调用",
		Payload: map[string]any{
			"args": []any{4, true},
		},
	})
	if err == nil {
		t.Fatal("expected apply on whitespace-suffixed domain operation to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "com.gonavi.fixture") {
		t.Fatalf("expected whitespace-suffixed domain operation apply context, got %v", err)
	}

	_, err = monitoringProvider.GetMonitoringSnapshot(context.Background(), cfg, nil)
	if err == nil {
		t.Fatal("expected monitor on blocked domain allowlist to fail")
	}
	if got := err.Error(); !containsAll(got, "domain", "java.lang") {
		t.Fatalf("expected blocked domain monitor context, got %v", err)
	}

	monitoringCfg := cfg
	monitoringCfg.JVM.JMX.DomainAllowlist = []string{"com.gonavi.fixture", "java.lang"}
	monitoringSnapshot, err := monitoringProvider.GetMonitoringSnapshot(context.Background(), monitoringCfg, nil)
	if err != nil {
		t.Fatalf("expected monitor with java.lang allowlist to succeed: %v", err)
	}
	if monitoringSnapshot.Point.Timestamp <= 0 {
		t.Fatalf("unexpected monitor snapshot point: %#v", monitoringSnapshot.Point)
	}

	children, err := provider.ListResources(context.Background(), cfg, mbean.Path)
	if err != nil {
		t.Fatalf("ListResources(mbean) returned error: %v", err)
	}
	modeAttr := findResourceByName(t, children, "Mode")
	passwordAttr := findResourceByName(t, children, "Password")
	apiKeyAttr := findResourceByName(t, children, "ApiKey")
	lastInvocationAttr := findResourceByName(t, children, "LastInvocation")
	resizeOp := findResourceByName(t, children, "resize(int,boolean)")

	passwordSnapshot, err := provider.GetValue(context.Background(), cfg, passwordAttr.Path)
	if err != nil {
		t.Fatalf("GetValue(password) returned error: %v", err)
	}
	if !passwordSnapshot.Sensitive {
		t.Fatalf("expected password snapshot to be sensitive: %#v", passwordSnapshot)
	}
	for _, action := range passwordSnapshot.SupportedActions {
		if payloadValue, ok := action.PayloadExample["value"]; ok && payloadValue == "secret-token" {
			t.Fatalf("sensitive payload example leaked raw password: %#v", action.PayloadExample)
		}
	}

	apiKeySnapshot, err := provider.GetValue(context.Background(), cfg, apiKeyAttr.Path)
	if err != nil {
		t.Fatalf("GetValue(api key) returned error: %v", err)
	}
	if !apiKeySnapshot.Sensitive {
		t.Fatalf("expected api key snapshot to be sensitive: %#v", apiKeySnapshot)
	}
	for _, action := range apiKeySnapshot.SupportedActions {
		if payloadValue, ok := action.PayloadExample["value"]; ok && payloadValue == "api-key-secret" {
			t.Fatalf("sensitive payload example leaked raw api key: %#v", action.PayloadExample)
		}
	}

	modeBefore, err := provider.GetValue(context.Background(), cfg, modeAttr.Path)
	if err != nil {
		t.Fatalf("GetValue(mode before) returned error: %v", err)
	}
	if modeBefore.Value != "warm" {
		t.Fatalf("expected initial mode warm, got %#v", modeBefore)
	}
	if strings.TrimSpace(modeBefore.Version) == "" {
		t.Fatalf("expected initial mode version, got %#v", modeBefore)
	}

	attrPreview, err := provider.PreviewChange(context.Background(), cfg, ChangeRequest{
		ProviderMode:    ModeJMX,
		ResourceID:      modeAttr.Path,
		Action:          "update",
		Reason:          "切换缓存模式",
		ExpectedVersion: modeBefore.Version,
		Payload: map[string]any{
			"value": "hot",
		},
	})
	if err != nil {
		t.Fatalf("PreviewChange(attribute) returned error: %v", err)
	}
	if !attrPreview.Allowed {
		t.Fatalf("expected attribute preview allowed, got %#v", attrPreview)
	}
	if attrPreview.Before.Value != "warm" || attrPreview.After.Value != "hot" {
		t.Fatalf("unexpected attribute preview diff: %#v", attrPreview)
	}

	attrApply, err := provider.ApplyChange(context.Background(), cfg, ChangeRequest{
		ProviderMode:    ModeJMX,
		ResourceID:      modeAttr.Path,
		Action:          "update",
		Reason:          "切换缓存模式",
		ExpectedVersion: modeBefore.Version,
		Payload: map[string]any{
			"value": "hot",
		},
	})
	if err != nil {
		t.Fatalf("ApplyChange(attribute) returned error: %v", err)
	}
	if strings.TrimSpace(attrApply.Status) == "" || attrApply.UpdatedValue.Value != "hot" {
		t.Fatalf("unexpected attribute apply result: %#v", attrApply)
	}

	modeAfter, err := provider.GetValue(context.Background(), cfg, modeAttr.Path)
	if err != nil {
		t.Fatalf("GetValue(mode after) returned error: %v", err)
	}
	if modeAfter.Value != "hot" {
		t.Fatalf("expected mode hot after apply, got %#v", modeAfter)
	}

	_, err = provider.ApplyChange(context.Background(), cfg, ChangeRequest{
		ProviderMode:    ModeJMX,
		ResourceID:      modeAttr.Path,
		Action:          "update",
		Reason:          "尝试使用过期版本",
		ExpectedVersion: modeBefore.Version,
		Payload: map[string]any{
			"value": "cold",
		},
	})
	if err == nil {
		t.Fatal("expected stale version apply to fail")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "version") {
		t.Fatalf("expected version mismatch context, got %v", err)
	}

	opPreview, err := provider.PreviewChange(context.Background(), cfg, ChangeRequest{
		ProviderMode: ModeJMX,
		ResourceID:   resizeOp.Path,
		Action:       "invoke",
		Reason:       "执行 resize 操作",
		Payload: map[string]any{
			"args": []any{128, true},
		},
	})
	if err != nil {
		t.Fatalf("PreviewChange(operation) returned error: %v", err)
	}
	if !opPreview.Allowed || !strings.Contains(opPreview.Summary, "resize") {
		t.Fatalf("unexpected operation preview: %#v", opPreview)
	}

	opApply, err := provider.ApplyChange(context.Background(), cfg, ChangeRequest{
		ProviderMode: ModeJMX,
		ResourceID:   resizeOp.Path,
		Action:       "invoke",
		Reason:       "执行 resize 操作",
		Payload: map[string]any{
			"args": []any{128, true},
		},
	})
	if err != nil {
		t.Fatalf("ApplyChange(operation) returned error: %v", err)
	}
	if strings.TrimSpace(opApply.Status) == "" {
		t.Fatalf("expected operation apply status, got %#v", opApply)
	}

	lastInvocation, err := provider.GetValue(context.Background(), cfg, lastInvocationAttr.Path)
	if err != nil {
		t.Fatalf("GetValue(last invocation) returned error: %v", err)
	}
	if lastInvocation.Value != "capacity=128,enabled=true" {
		t.Fatalf("unexpected operation side effect snapshot: %#v", lastInvocation)
	}
}

type jmxFixtureProcess struct {
	port int
}

func startJMXFixture(t *testing.T) jmxFixtureProcess {
	t.Helper()

	toolchain := requireJVMFixtureToolchain(t, false)

	classesDir := filepath.Join(t.TempDir(), "fixture-classes")
	if err := os.MkdirAll(classesDir, 0o755); err != nil {
		t.Fatalf("create JMX fixture classes directory failed: %v", err)
	}
	sourceRoot := filepath.Join(testRepoRoot(t), "internal", "jvm", "testdata", "jmxfixture", "src")
	javaFiles, err := filepath.Glob(filepath.Join(sourceRoot, "com", "gonavi", "fixture", "*.java"))
	if err != nil {
		t.Fatalf("glob fixture sources failed: %v", err)
	}
	if len(javaFiles) == 0 {
		t.Fatalf("expected fixture java files under %s", sourceRoot)
	}

	compileJVMFixture(t, toolchain, "JMX", classesDir, javaFiles)

	port := reserveTCPPort(t)
	process, stdout := startJVMFixtureCommand(t, toolchain, "JMX",
		fmt.Sprintf("-Dcom.sun.management.jmxremote.port=%d", port),
		fmt.Sprintf("-Dcom.sun.management.jmxremote.rmi.port=%d", port),
		"-Dcom.sun.management.jmxremote.authenticate=false",
		"-Dcom.sun.management.jmxremote.ssl=false",
		"-Dcom.sun.management.jmxremote.local.only=false",
		"-Dcom.sun.management.jmxremote.host=127.0.0.1",
		"-Djava.rmi.server.hostname=127.0.0.1",
		"-cp", classesDir,
		"com.gonavi.fixture.JMXTestServer",
	)
	waitForJVMFixtureReady(t, process, stdout, toolchain, "JMX", "READY", 20*time.Second)

	waitForTest(t, 10*time.Second, func() error {
		conn, dialErr := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 500*time.Millisecond)
		if dialErr != nil {
			return dialErr
		}
		_ = conn.Close()
		return nil
	})

	return jmxFixtureProcess{port: port}
}

func waitForTest(t *testing.T, timeout time.Duration, fn func() error) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		if err := fn(); err == nil {
			return
		} else {
			lastErr = err
		}
		time.Sleep(200 * time.Millisecond)
	}
	if lastErr == nil {
		lastErr = errors.New("condition not satisfied before timeout")
	}
	t.Fatalf("condition not met within %s: %v", timeout, lastErr)
}

func reserveTCPPort(t *testing.T) int {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve TCP port failed: %v", err)
	}
	defer listener.Close()

	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("unexpected TCP addr type: %T", listener.Addr())
	}
	return addr.Port
}

func findResourceByName(t *testing.T, items []ResourceSummary, name string) ResourceSummary {
	t.Helper()

	for _, item := range items {
		if item.Name == name {
			return item
		}
	}
	t.Fatalf("resource %q not found in %#v", name, items)
	return ResourceSummary{}
}

func testRepoRoot(t *testing.T) string {
	t.Helper()

	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(filename), "..", ".."))
}

func containsAll(source string, fragments ...string) bool {
	for _, fragment := range fragments {
		if !strings.Contains(source, fragment) {
			return false
		}
	}
	return true
}
