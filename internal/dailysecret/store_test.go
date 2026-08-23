package dailysecret

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/appdata"
)

func TestStorePutGetDeleteConnectionSecret(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)

	bundle := ConnectionBundle{
		Password:            "postgres-secret",
		OpaqueDSN:           "postgres://user:pass@db.local/app",
		SSHPassword:         "ssh-secret",
		JVMJMXPassword:      "jmx-secret",
		JVMEndpointAPIKey:   "endpoint-key",
		JVMAgentAPIKey:      "agent-key",
		JVMDiagnosticAPIKey: "diagnostic-key",
		SensitiveParams:     "accessToken=param-secret",
	}
	if err := store.PutConnection("conn-1", bundle); err != nil {
		t.Fatalf("PutConnection returned error: %v", err)
	}

	got, ok, err := store.GetConnection("conn-1")
	if err != nil {
		t.Fatalf("GetConnection returned error: %v", err)
	}
	if !ok {
		t.Fatal("expected connection bundle to exist")
	}
	if !reflect.DeepEqual(got, bundle) {
		t.Fatalf("unexpected bundle: %#v", got)
	}

	if err := store.DeleteConnection("conn-1"); err != nil {
		t.Fatalf("DeleteConnection returned error: %v", err)
	}
	got, ok, err = store.GetConnection("conn-1")
	if err != nil {
		t.Fatalf("GetConnection after delete returned error: %v", err)
	}
	if ok {
		t.Fatalf("expected missing connection bundle after delete, got %#v", got)
	}
}

func TestStorePutGetDeleteGlobalProxySecret(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)

	if err := store.PutGlobalProxy(GlobalProxyBundle{Password: "proxy-secret"}); err != nil {
		t.Fatalf("PutGlobalProxy returned error: %v", err)
	}

	got, ok, err := store.GetGlobalProxy()
	if err != nil {
		t.Fatalf("GetGlobalProxy returned error: %v", err)
	}
	if !ok || got.Password != "proxy-secret" {
		t.Fatalf("unexpected global proxy bundle: %#v ok=%v", got, ok)
	}

	if err := store.DeleteGlobalProxy(); err != nil {
		t.Fatalf("DeleteGlobalProxy returned error: %v", err)
	}
	_, ok, err = store.GetGlobalProxy()
	if err != nil {
		t.Fatalf("GetGlobalProxy after delete returned error: %v", err)
	}
	if ok {
		t.Fatal("expected global proxy bundle to be deleted")
	}
}

func TestStorePutGetDeleteMCPHTTPServerSecret(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)

	if err := store.PutMCPHTTPServer(MCPHTTPServerBundle{Token: "gnv_mcp_http_test"}); err != nil {
		t.Fatalf("PutMCPHTTPServer returned error: %v", err)
	}

	got, ok, err := store.GetMCPHTTPServer()
	if err != nil {
		t.Fatalf("GetMCPHTTPServer returned error: %v", err)
	}
	if !ok || got.Token != "gnv_mcp_http_test" {
		t.Fatalf("unexpected MCP HTTP bundle: %#v ok=%v", got, ok)
	}

	if err := store.DeleteMCPHTTPServer(); err != nil {
		t.Fatalf("DeleteMCPHTTPServer returned error: %v", err)
	}
	_, ok, err = store.GetMCPHTTPServer()
	if err != nil {
		t.Fatalf("GetMCPHTTPServer after delete returned error: %v", err)
	}
	if ok {
		t.Fatal("expected MCP HTTP bundle to be deleted")
	}
}

func TestStorePutGetDeleteAIProviderSecret(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)

	bundle := ProviderBundle{
		APIKey: "sk-test",
		SensitiveHeaders: map[string]string{
			"Authorization": "Bearer test",
		},
	}
	if err := store.PutAIProvider("openai-main", bundle); err != nil {
		t.Fatalf("PutAIProvider returned error: %v", err)
	}

	got, ok, err := store.GetAIProvider("openai-main")
	if err != nil {
		t.Fatalf("GetAIProvider returned error: %v", err)
	}
	if !ok {
		t.Fatal("expected provider bundle to exist")
	}
	if got.APIKey != "sk-test" || got.SensitiveHeaders["Authorization"] != "Bearer test" {
		t.Fatalf("unexpected provider bundle: %#v", got)
	}

	if err := store.DeleteAIProvider("openai-main"); err != nil {
		t.Fatalf("DeleteAIProvider returned error: %v", err)
	}
	_, ok, err = store.GetAIProvider("openai-main")
	if err != nil {
		t.Fatalf("GetAIProvider after delete returned error: %v", err)
	}
	if ok {
		t.Fatal("expected provider bundle to be deleted")
	}
}

func TestStoreConcurrentWritersDoNotLoseConnectionBundles(t *testing.T) {
	root := t.TempDir()
	const total = 16
	var wg sync.WaitGroup
	wg.Add(total)
	for index := 0; index < total; index++ {
		go func(index int) {
			defer wg.Done()
			store := NewStore(root)
			id := "conn-" + string(rune('a'+index))
			if err := store.PutConnection(id, ConnectionBundle{Password: id + "-secret"}); err != nil {
				t.Errorf("PutConnection(%s): %v", id, err)
			}
		}(index)
	}
	wg.Wait()

	payload, err := os.ReadFile(filepath.Join(root, fileName))
	if err != nil {
		t.Fatalf("read daily secret file: %v", err)
	}
	var file File
	if err := json.Unmarshal(payload, &file); err != nil {
		t.Fatalf("daily secret file is not valid JSON: %v", err)
	}
	if len(file.Connections) != total {
		t.Fatalf("connection bundle count = %d, want %d: %#v", len(file.Connections), total, file.Connections)
	}
	for index := 0; index < total; index++ {
		id := "conn-" + string(rune('a'+index))
		if bundle, ok := file.Connections[id]; !ok || bundle.Password != id+"-secret" {
			t.Errorf("bundle %s missing or changed: %#v ok=%v", id, bundle, ok)
		}
	}
}

func TestStoreSaveUsesAtomicReplacementWithoutTemporaryFiles(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)
	if err := store.Save(File{Connections: map[string]ConnectionBundle{"conn": {Password: "secret"}}}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".tmp" {
			t.Fatalf("temporary daily secret file left behind: %s", entry.Name())
		}
	}
}

func TestStorePutConnectionWaitsForExternalFileLock(t *testing.T) {
	store := NewStore(t.TempDir())
	if err := os.MkdirAll(filepath.Dir(store.Path()), 0o700); err != nil {
		t.Fatalf("create store directory: %v", err)
	}
	externalLock, err := appdata.AcquireFileLock(store.Path() + ".lock")
	if err != nil {
		t.Fatalf("acquire external daily-secret lock: %v", err)
	}
	defer externalLock.Close()

	finished := make(chan error, 1)
	go func() {
		finished <- store.PutConnection("locked", ConnectionBundle{Password: "secret"})
	}()
	select {
	case err := <-finished:
		t.Fatalf("PutConnection acquired lock before external release: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := externalLock.Close(); err != nil {
		t.Fatalf("release external daily-secret lock: %v", err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("PutConnection after external lock release: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("PutConnection did not acquire lock after external release")
	}
}

func TestStorePutConnectionWaitsForSharedStorageLock(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)
	sharedLock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(root))
	if err != nil {
		t.Fatalf("acquire shared storage lock: %v", err)
	}

	finished := make(chan error, 1)
	go func() {
		finished <- store.PutConnection("shared-locked", ConnectionBundle{Password: "secret"})
	}()
	select {
	case err := <-finished:
		t.Fatalf("PutConnection acquired shared lock before external release: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := sharedLock.Close(); err != nil {
		t.Fatalf("release shared storage lock: %v", err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("PutConnection after shared lock release: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("PutConnection did not acquire shared lock after external release")
	}
}
