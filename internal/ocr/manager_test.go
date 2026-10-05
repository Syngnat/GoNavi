package ocr

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeFiles are the bytes the test sources serve.
var fakeFiles = map[string]string{
	"worker.min.js":           strings.Repeat("worker;", 200),
	"core/engine.wasm.js":     strings.Repeat("engine;", 500),
	"lang/eng.traineddata.gz": strings.Repeat("english;", 300),
}

func componentFor(version string, content map[string]string, sources ...string) Component {
	component := Component{Version: version, Languages: []string{"eng"}}
	for _, path := range []string{"worker.min.js", "core/engine.wasm.js", "lang/eng.traineddata.gz"} {
		sum := sha256.Sum256([]byte(content[path]))
		file := File{Path: path, Size: int64(len(content[path])), SHA256: hex.EncodeToString(sum[:])}
		for _, source := range sources {
			file.URLs = append(file.URLs, source+"/"+path)
		}
		component.Files = append(component.Files, file)
	}
	return component
}

// serveBytes answers /<path> with content[path], counting requests; mutate may
// change what is served (for the bad-source cases).
func serveBytes(t *testing.T, content map[string]string, requests *atomic.Int64, mutate func(path, body string) string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		path := strings.TrimPrefix(r.URL.Path, "/")
		body, ok := content[path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if mutate != nil {
			body = mutate(path, body)
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

func leftovers(t *testing.T, root string) []string {
	t.Helper()
	var names []string
	entries, _ := os.ReadDir(root)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), stagingPrefix) || strings.HasPrefix(entry.Name(), previousPrefix) {
			names = append(names, entry.Name())
		}
	}
	return names
}

func TestInstallDownloadsVerifiesAndActivates(t *testing.T) {
	var requests atomic.Int64
	server := serveBytes(t, fakeFiles, &requests, nil)
	root := filepath.Join(t.TempDir(), "ocr")
	manager := NewManager(root, componentFor("v1", fakeFiles, server.URL), nil)

	if manager.Status().Installed {
		t.Fatal("nothing is installed yet")
	}
	var reports []Progress
	if err := manager.Install(context.Background(), func(p Progress) { reports = append(reports, p) }); err != nil {
		t.Fatalf("install: %v", err)
	}
	status := manager.Status()
	if !status.Installed || status.Installing || status.Version != "v1" || status.SizeBytes != manager.component.TotalSize() {
		t.Fatalf("status = %+v", status)
	}
	for path, want := range fakeFiles {
		got, err := os.ReadFile(filepath.Join(root, currentDir, filepath.FromSlash(path)))
		if err != nil || string(got) != want {
			t.Fatalf("%s not installed correctly: %v", path, err)
		}
	}
	if names := leftovers(t, root); len(names) != 0 {
		t.Fatalf("staging left behind: %v", names)
	}
	last := reports[len(reports)-1]
	if last.Phase != PhaseDone || last.Downloaded != last.Total || last.Total != manager.component.TotalSize() {
		t.Fatalf("last report = %+v", last)
	}
	var previous int64
	for _, report := range reports {
		if report.Downloaded < previous || report.Downloaded > report.Total {
			t.Fatalf("progress went backwards or past the total: %+v after %d", report, previous)
		}
		previous = report.Downloaded
	}
}

func TestInstallingWhatIsInstalledDoesNothing(t *testing.T) {
	var requests atomic.Int64
	server := serveBytes(t, fakeFiles, &requests, nil)
	manager := NewManager(filepath.Join(t.TempDir(), "ocr"), componentFor("v1", fakeFiles, server.URL), nil)
	if err := manager.Install(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	first := requests.Load()
	var done bool
	if err := manager.Install(context.Background(), func(p Progress) { done = done || p.Phase == PhaseDone }); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != first || !done {
		t.Fatalf("a second install must not download again (requests %d -> %d, done=%v)", first, requests.Load(), done)
	}
}

func TestABadSourceIsSkippedForTheNextOne(t *testing.T) {
	var badRequests, goodRequests atomic.Int64
	// Same size, wrong bytes: only the checksum can tell.
	bad := serveBytes(t, fakeFiles, &badRequests, func(_, body string) string { return strings.ToUpper(body) })
	good := serveBytes(t, fakeFiles, &goodRequests, nil)
	manager := NewManager(filepath.Join(t.TempDir(), "ocr"), componentFor("v1", fakeFiles, bad.URL, good.URL), nil)

	var maxDownloaded, total int64
	err := manager.Install(context.Background(), func(p Progress) {
		total = p.Total
		if p.Downloaded > maxDownloaded {
			maxDownloaded = p.Downloaded
		}
	})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if badRequests.Load() == 0 || goodRequests.Load() == 0 || !manager.Status().Installed {
		t.Fatalf("bad %d good %d installed %v", badRequests.Load(), goodRequests.Load(), manager.Status().Installed)
	}
	if maxDownloaded > total {
		t.Fatalf("bytes from the rejected source were counted: %d of %d", maxDownloaded, total)
	}
}

func TestEverySourceBeingBadInstallsNothing(t *testing.T) {
	for name, mutate := range map[string]func(string, string) string{
		"wrong bytes": func(_, body string) string { return strings.ToUpper(body) },
		"too short":   func(_, body string) string { return body[:len(body)-1] },
		"too long":    func(_, body string) string { return body + "x" },
		"empty":       func(_, _ string) string { return "" },
	} {
		t.Run(name, func(t *testing.T) {
			var requests atomic.Int64
			server := serveBytes(t, fakeFiles, &requests, mutate)
			root := filepath.Join(t.TempDir(), "ocr")
			manager := NewManager(root, componentFor("v1", fakeFiles, server.URL), nil)
			if err := manager.Install(context.Background(), nil); err == nil {
				t.Fatal("a source that does not deliver the pinned bytes must fail the install")
			}
			if manager.Status().Installed {
				t.Fatal("nothing may be installed")
			}
			if _, err := os.Stat(filepath.Join(root, currentDir)); !os.IsNotExist(err) {
				t.Fatalf("current must not exist: %v", err)
			}
			if names := leftovers(t, root); len(names) != 0 {
				t.Fatalf("staging left behind: %v", names)
			}
		})
	}
}

func TestAnHTTPErrorFromEverySourceFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) }))
	t.Cleanup(server.Close)
	manager := NewManager(filepath.Join(t.TempDir(), "ocr"), componentFor("v1", fakeFiles, server.URL), nil)
	err := manager.Install(context.Background(), nil)
	if err == nil || strings.Contains(err.Error(), server.URL) {
		t.Fatalf("want a failure that does not repeat the URL: %v", err)
	}
}

// blockingServer holds every request until released or the client goes away.
func blockingServer(t *testing.T) (*httptest.Server, chan struct{}) {
	t.Helper()
	started := make(chan struct{}, 16)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started <- struct{}{}
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	return server, started
}

func TestCancellingStopsTheInstallAndLeavesNothing(t *testing.T) {
	server, started := blockingServer(t)
	root := filepath.Join(t.TempDir(), "ocr")
	manager := NewManager(root, componentFor("v1", fakeFiles, server.URL), nil)

	result := make(chan error, 1)
	go func() { result <- manager.Install(context.Background(), nil) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the download never started")
	}
	if !manager.Status().Installing {
		t.Fatal("status should say an install is running")
	}
	manager.CancelInstall()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("want context.Canceled, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel did not stop the install")
	}
	if manager.Status().Installing || manager.Status().Installed {
		t.Fatalf("status = %+v", manager.Status())
	}
	if names := leftovers(t, root); len(names) != 0 {
		t.Fatalf("staging left behind: %v", names)
	}
}

func TestOnlyOneInstallRunsAtATime(t *testing.T) {
	server, started := blockingServer(t)
	manager := NewManager(filepath.Join(t.TempDir(), "ocr"), componentFor("v1", fakeFiles, server.URL), nil)
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Go(func() { _ = manager.Install(ctx, nil) })
	<-started

	if err := manager.Install(context.Background(), nil); !errors.Is(err, ErrInstallInProgress) {
		t.Fatalf("second install = %v", err)
	}
	if err := manager.Remove(); !errors.Is(err, ErrInstallInProgress) {
		t.Fatalf("remove during install = %v", err)
	}
	cancel()
	wg.Wait()
}

func TestAnotherVersionOrADamagedFileMeansNotInstalled(t *testing.T) {
	var requests atomic.Int64
	server := serveBytes(t, fakeFiles, &requests, nil)
	root := filepath.Join(t.TempDir(), "ocr")
	manager := NewManager(root, componentFor("v1", fakeFiles, server.URL), nil)
	if err := manager.Install(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if NewManager(root, componentFor("v2", fakeFiles, server.URL), nil).Status().Installed {
		t.Fatal("a component of another version has to be installed again")
	}
	damaged := filepath.Join(root, currentDir, "core", "engine.wasm.js")
	if err := os.WriteFile(damaged, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if manager.Status().Installed {
		t.Fatal("a file of the wrong size means the component is broken")
	}
	if err := manager.Install(context.Background(), nil); err != nil {
		t.Fatalf("repair: %v", err)
	}
	if got, _ := os.ReadFile(damaged); string(got) != fakeFiles["core/engine.wasm.js"] || !manager.Status().Installed {
		t.Fatal("installing again must repair it")
	}
}

func TestANewVersionReplacesTheOldOneCleanly(t *testing.T) {
	var requests atomic.Int64
	next := map[string]string{}
	for path, body := range fakeFiles {
		next[path] = body + "-v2"
	}
	v1 := serveBytes(t, fakeFiles, &requests, nil)
	v2 := serveBytes(t, next, &requests, nil)
	root := filepath.Join(t.TempDir(), "ocr")
	if err := NewManager(root, componentFor("v1", fakeFiles, v1.URL), nil).Install(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(root, componentFor("v2", next, v2.URL), nil)
	if err := manager.Install(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, currentDir, "worker.min.js")); string(got) != next["worker.min.js"] {
		t.Fatal("the new files must be in place")
	}
	if names := leftovers(t, root); len(names) != 0 {
		t.Fatalf("the old component was not cleaned up: %v", names)
	}
}

func TestRemoveDeletesOnlyWhatTheComponentOwns(t *testing.T) {
	var requests atomic.Int64
	server := serveBytes(t, fakeFiles, &requests, nil)
	root := filepath.Join(t.TempDir(), "ocr")
	manager := NewManager(root, componentFor("v1", fakeFiles, server.URL), nil)
	if err := manager.Install(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{stagingPrefix + "abc", previousPrefix + "def", "keep-me"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := manager.Serve(); err != nil {
		t.Fatal(err)
	}
	if err := manager.Remove(); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if manager.Status().Installed {
		t.Fatal("still installed")
	}
	if _, err := os.Stat(filepath.Join(root, currentDir)); !os.IsNotExist(err) {
		t.Fatal("current must be gone")
	}
	if names := leftovers(t, root); len(names) != 0 {
		t.Fatalf("leftovers survived: %v", names)
	}
	if _, err := os.Stat(filepath.Join(root, "keep-me")); err != nil {
		t.Fatal("something that is not the component's own was deleted")
	}
	if _, err := manager.Serve(); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("serve after remove = %v", err)
	}
	if err := manager.Remove(); err != nil {
		t.Fatalf("removing what is not there is not an error: %v", err)
	}
}

func TestTheDefaultComponentIsPinned(t *testing.T) {
	component := DefaultComponent()
	if len(component.Files) != 5 || len(component.Languages) < 2 || component.Version == "" {
		t.Fatalf("component = %+v", component)
	}
	seen := map[string]bool{}
	for _, file := range component.Files {
		if !validRelativePath(file.Path) || seen[file.Path] {
			t.Errorf("bad or repeated path %q", file.Path)
		}
		seen[file.Path] = true
		if file.Size <= 0 || len(file.SHA256) != 64 || strings.Trim(file.SHA256, "0123456789abcdef") != "" {
			t.Errorf("%s: size %d sha256 %q", file.Path, file.Size, file.SHA256)
		}
		if len(file.URLs) < 2 {
			t.Errorf("%s needs more than one source", file.Path)
		}
		for _, url := range file.URLs {
			if !strings.HasPrefix(url, "https://") {
				t.Errorf("%s: %s is not https", file.Path, url)
			}
		}
	}
	// Roughly 13 MB: the figure the approval prompt shows.
	if total := component.TotalSize(); total < 12_000_000 || total > 14_000_000 {
		t.Errorf("total size %d is not what the prompt promises", total)
	}
	if _, ok := component.file("worker.min.js"); !ok {
		t.Error("the worker script is part of the component")
	}
}

func TestOnlyCleanRelativePathsAreAccepted(t *testing.T) {
	for path, want := range map[string]bool{
		"worker.min.js": true, "core/a.js": true, "lang/eng.traineddata.gz": true,
		"": false, "/etc/passwd": false, "../x": false, "a/../b": false, "a//b": false, "a/./b": false,
		"..\\x": false, "C:/x": false, "a/": false,
	} {
		if got := validRelativePath(path); got != want {
			t.Errorf("validRelativePath(%q) = %v, want %v", path, got, want)
		}
	}
}
