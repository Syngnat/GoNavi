package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 过期清单：声明 pages 却没有 ui.pages 权限，正是已安装插件在宿主升级后出现的样子。
const expiredPersistedManifest = `{"schemaVersion":1,"apiVersion":1,"id":"test.expired","name":"Expired","version":"1.0.0","permissions":[],"contributes":{"pages":[{"id":"main","title":"Main","body":{"type":"text","text":"ok"}}]}}`

func persistedStateFixture(t *testing.T, records map[string]record) string {
	t.Helper()
	root := t.TempDir()
	content, err := json.Marshal(diskState{SchemaVersion: 1, Generation: 2, Records: records})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "state.json"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func persistedRecord(id, digest string) record {
	return record{Status: Status{
		Manifest:   Manifest{SchemaVersion: 1, APIVersion: 1, ID: id, Name: id, Version: "1.0.0", Permissions: []string{}},
		Digest:     digest,
		State:      StateDisabled,
		Generation: 1,
	}}
}

func expiredPersistedRecord(t *testing.T, id, digest string) record {
	t.Helper()
	r := persistedRecord(id, digest)
	if err := json.Unmarshal([]byte(expiredPersistedManifest), &r.Manifest); err != nil {
		t.Fatal(err)
	}
	return r
}

// 一条过期清单只能隔离它自己：既不能让整个插件运行时不可用，也不能顺手跳过结构性校验。
func TestPersistedManifestRejectionIsolatesOnlyTheBrokenPlugin(t *testing.T) {
	healthy, expired := "test.healthy", "test.expired"
	root := persistedStateFixture(t, map[string]record{
		healthy: persistedRecord(healthy, strings.Repeat("a", 64)),
		expired: expiredPersistedRecord(t, expired, strings.Repeat("b", 64)),
	})
	manager, err := NewManager(Options{Root: root, HostVersion: "1.0.0", ReconcileInterval: 10 * time.Millisecond})
	if err != nil {
		t.Fatalf("one expired manifest must not close the whole plugin runtime: %v", err)
	}
	statuses := manager.List()
	if len(statuses) != 2 {
		t.Fatalf("list returned %d entries, want 2", len(statuses))
	}
	byID := map[string]Status{}
	for _, status := range statuses {
		byID[status.Manifest.ID] = status
	}
	broken, ok := byID[expired]
	if !ok {
		t.Fatal("expired plugin disappeared from the list")
	}
	if broken.State != StateBlocked || broken.DesiredEnabled {
		t.Fatalf("expired plugin state = %s desired = %v, want blocked and disabled", broken.State, broken.DesiredEnabled)
	}
	if !strings.Contains(broken.LastError, "invalid persisted manifest") {
		t.Fatalf("expired plugin reason = %q, want an invalid persisted manifest reason", broken.LastError)
	}
	if intact := byID[healthy]; intact.State != StateDisabled {
		t.Fatalf("healthy plugin state = %s, want disabled", intact.State)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err = manager.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer manager.Close(ctx)
	manager.mu.Lock()
	_, launched := manager.instances[expired]
	manager.mu.Unlock()
	if launched {
		t.Fatal("expired plugin was launched despite an invalid persisted manifest")
	}
	if err = manager.Remove(ctx, expired, false); err != nil {
		t.Fatalf("expired plugin must stay removable: %v", err)
	}
}

func TestPersistedStateKeepsStructuralRejection(t *testing.T) {
	invalidGeneration := persistedRecord("test.a", strings.Repeat("a", 64))
	invalidGeneration.Generation = 0
	unknownState := persistedRecord("test.a", strings.Repeat("a", 64))
	unknownState.State = State("nonsense")
	cases := []struct {
		name    string
		records map[string]record
	}{
		{"identity mismatch", map[string]record{"test.a": persistedRecord("test.b", strings.Repeat("a", 64))}},
		{"digest is not hex", map[string]record{"test.a": persistedRecord("test.a", "zz")}},
		{"unknown lifecycle state", map[string]record{"test.a": unknownState}},
		{"zero generation", map[string]record{"test.a": invalidGeneration}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := persistedStateFixture(t, tc.records)
			if _, err := NewManager(Options{Root: root, HostVersion: "1.0.0"}); err == nil {
				t.Fatalf("%s: untrustworthy persisted state was accepted", tc.name)
			}
		})
	}
}
