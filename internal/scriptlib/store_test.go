package scriptlib

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/scriptlimits"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	return NewStore(t.TempDir())
}

func writer(name string) Actor {
	return Actor{Owner: name}
}

func mustSaveScript(t *testing.T, store *Store, actor Actor, input SaveScriptInput) Script {
	t.Helper()
	script, err := store.SaveScript(context.Background(), actor, input)
	if err != nil {
		t.Fatalf("SaveScript(%q) error = %v", input.Name, err)
	}
	return script
}

func baseScriptInput(name string) SaveScriptInput {
	return SaveScriptInput{
		Name: name,
		Code: "gonavi.log('hello');",
	}
}

func TestSaveScriptCreatesAndUpdatesWithRevision(t *testing.T) {
	store := newTestStore(t)
	actor := writer("alice")
	created := mustSaveScript(t, store, actor, baseScriptInput("nightly cleanup"))
	if created.ID == "" || created.Owner != "alice" || created.Visibility != VisibilityPrivate {
		t.Fatalf("created script = %+v", created)
	}
	if created.Revision != 1 || created.BatchSize != 500 || created.INListLimit != 1000 {
		t.Fatalf("created defaults = %+v", created)
	}
	if created.RunLimits != (RunLimits{}) {
		t.Fatalf("zero run limits must stay unset: %+v", created.RunLimits)
	}
	if created.CreatedAt <= 0 || created.UpdatedAt <= 0 {
		t.Fatalf("timestamps were not populated: %+v", created)
	}

	update := baseScriptInput("nightly cleanup v2")
	update.ID = created.ID
	update.Code = "gonavi.log('updated');"
	update.Revision = created.Revision
	updated, err := store.SaveScript(context.Background(), actor, update)
	if err != nil {
		t.Fatalf("update error = %v", err)
	}
	if updated.Revision != 2 || updated.Code != update.Code || updated.CreatedAt != created.CreatedAt {
		t.Fatalf("updated script = %+v", updated)
	}

	update.Revision = 1
	if _, err := store.SaveScript(context.Background(), actor, update); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale update error = %v, want ErrConflict", err)
	}

	update.ID = "missing"
	update.Revision = 0
	if _, err := store.SaveScript(context.Background(), actor, update); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing update error = %v, want ErrNotFound", err)
	}
}

func TestScriptValidationIsTableDriven(t *testing.T) {
	tests := []struct {
		name  string
		input SaveScriptInput
	}{
		{name: "empty name", input: SaveScriptInput{Code: "1"}},
		{name: "empty source", input: SaveScriptInput{Name: "empty"}},
		{name: "oversized source", input: SaveScriptInput{Name: "large", Code: strings.Repeat("a", MaxScriptBytes+1)}},
		{name: "invalid visibility", input: SaveScriptInput{Name: "v", Code: "1", Visibility: "public"}},
		{name: "duplicate connection alias", input: SaveScriptInput{
			Name: "c", Code: "1",
			Connections: []ConnectionBinding{{Alias: "prod"}, {Alias: "prod"}},
		}},
		{name: "invalid input alias", input: SaveScriptInput{
			Name: "i", Code: "1",
			Inputs: []InputBinding{{Alias: "bad alias"}},
		}},
		{name: "invalid header row", input: SaveScriptInput{
			Name: "h", Code: "1",
			Inputs: []InputBinding{{Alias: "rows", HeaderRow: -1}},
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newTestStore(t)
			if _, err := store.SaveScript(context.Background(), writer("alice"), test.input); !errors.Is(err, ErrInvalid) {
				t.Fatalf("SaveScript error = %v, want ErrInvalid", err)
			}
		})
	}
}

func TestSaveScriptClampsLimits(t *testing.T) {
	store := newTestStore(t)
	input := baseScriptInput("limits")
	input.BatchSize = 1
	input.INListLimit = -1
	input.RunLimits = RunLimits{
		TimeoutMs:        1,
		MaxDBCalls:       -1,
		MaxOutputRows:    -1,
		MemoryLimitBytes: 1,
	}
	script := mustSaveScript(t, store, writer("alice"), input)
	if script.BatchSize != 1 || script.INListLimit != 1 {
		t.Fatalf("minimum limits = %+v", script)
	}
	if script.RunLimits != (RunLimits{
		TimeoutMs:        scriptlimits.MinTimeoutMs,
		MaxDBCalls:       1,
		MaxOutputRows:    1,
		MemoryLimitBytes: scriptlimits.MinMemoryLimitBytes,
	}) {
		t.Fatalf("minimum run limits = %+v", script.RunLimits)
	}

	input = baseScriptInput("limits-high")
	input.BatchSize = 99_999
	input.INListLimit = 99_999
	input.RunLimits = RunLimits{
		TimeoutMs:        scriptlimits.MaxDesktopTimeoutMs * 2,
		MaxDBCalls:       scriptlimits.MaxDBCalls * 2,
		MaxOutputRows:    scriptlimits.MaxOutputRows * 2,
		MemoryLimitBytes: scriptlimits.MaxDesktopMemoryLimitBytes * 2,
	}
	script = mustSaveScript(t, store, writer("alice"), input)
	if script.BatchSize != 5000 || script.INListLimit != 1000 {
		t.Fatalf("maximum limits = %+v", script)
	}
	if script.RunLimits != (RunLimits{
		TimeoutMs:        scriptlimits.MaxDesktopTimeoutMs,
		MaxDBCalls:       scriptlimits.MaxDBCalls,
		MaxOutputRows:    scriptlimits.MaxOutputRows,
		MemoryLimitBytes: scriptlimits.MaxDesktopMemoryLimitBytes,
	}) {
		t.Fatalf("maximum run limits = %+v", script.RunLimits)
	}
}

func TestRunLimitsRoundTripAcrossStoreInstances(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)
	actor := writer("alice")
	limits := RunLimits{
		TimeoutMs:        5 * 60 * 1_000,
		MaxDBCalls:       25_000,
		MaxOutputRows:    75_000,
		MemoryLimitBytes: 768 << 20,
	}
	input := baseScriptInput("persisted limits")
	input.RunLimits = limits
	created := mustSaveScript(t, store, actor, input)
	if created.RunLimits != limits {
		t.Fatalf("saved run limits = %+v", created.RunLimits)
	}

	reloaded, err := NewStore(root).Get(actor, created.ID)
	if err != nil {
		t.Fatalf("reload script: %v", err)
	}
	if reloaded.RunLimits != limits {
		t.Fatalf("reloaded run limits = %+v, want %+v", reloaded.RunLimits, limits)
	}
}

func TestLegacyRunLimitsStayZeroAndStoredValuesAreClamped(t *testing.T) {
	store := newTestStore(t)
	if err := os.MkdirAll(filepath.Dir(store.path()), 0o700); err != nil {
		t.Fatalf("mkdir = %v", err)
	}
	payload := []byte(`{
	  "version": 1,
	  "scripts": [
	    {"id":"legacy","name":"legacy","code":"1","owner":"alice","visibility":"private","revision":1,"batchSize":500,"inListLimit":1000},
	    {"id":"low","name":"low","code":"1","owner":"alice","visibility":"private","revision":1,"batchSize":500,"inListLimit":1000,"runLimits":{"timeoutMs":1,"maxDbCalls":-1,"maxOutputRows":-1,"memoryLimitBytes":1}},
	    {"id":"high","name":"high","code":"1","owner":"alice","visibility":"private","revision":1,"batchSize":500,"inListLimit":1000,"runLimits":{"timeoutMs":999999999,"maxDbCalls":999999999,"maxOutputRows":999999999,"memoryLimitBytes":99999999999}}
	  ],
	  "folders": []
	}`)
	if err := os.WriteFile(store.path(), payload, 0o600); err != nil {
		t.Fatalf("write library = %v", err)
	}
	snapshot, err := store.Snapshot(writer("alice"))
	if err != nil {
		t.Fatalf("Snapshot error = %v", err)
	}
	byID := make(map[string]RunLimits, len(snapshot.Scripts))
	for _, script := range snapshot.Scripts {
		byID[script.ID] = script.RunLimits
	}
	if byID["legacy"] != (RunLimits{}) {
		t.Fatalf("legacy run limits = %+v, want zero", byID["legacy"])
	}
	if byID["low"] != (RunLimits{
		TimeoutMs:        scriptlimits.MinTimeoutMs,
		MaxDBCalls:       1,
		MaxOutputRows:    1,
		MemoryLimitBytes: scriptlimits.MinMemoryLimitBytes,
	}) {
		t.Fatalf("low run limits = %+v", byID["low"])
	}
	if byID["high"] != (RunLimits{
		TimeoutMs:        scriptlimits.MaxDesktopTimeoutMs,
		MaxDBCalls:       scriptlimits.MaxDBCalls,
		MaxOutputRows:    scriptlimits.MaxOutputRows,
		MemoryLimitBytes: scriptlimits.MaxDesktopMemoryLimitBytes,
	}) {
		t.Fatalf("high run limits = %+v", byID["high"])
	}
}

func TestSaveScriptAcceptsNilContext(t *testing.T) {
	store := newTestStore(t)
	if _, err := store.SaveScript(nil, writer("alice"), baseScriptInput("nil context")); err != nil {
		t.Fatalf("SaveScript(nil context) error = %v", err)
	}
}

func TestLoadRejectsUnsafeStoredDocument(t *testing.T) {
	validScript := func(id string) Script {
		return Script{
			ID:          id,
			Name:        "script",
			Code:        "gonavi.log('ok');",
			Owner:       "alice",
			Visibility:  VisibilityPrivate,
			BatchSize:   500,
			INListLimit: 1000,
			Revision:    1,
		}
	}
	tests := []struct {
		name string
		doc  diskDocument
	}{
		{
			name: "duplicate script ids",
			doc: diskDocument{Version: storeFormatVersion, Scripts: []Script{
				validScript("same"),
				validScript("same"),
			}},
		},
		{
			name: "oversized stored source",
			doc: diskDocument{Version: storeFormatVersion, Scripts: []Script{func() Script {
				script := validScript("large")
				script.Code = strings.Repeat("a", MaxScriptBytes+1)
				return script
			}()}},
		},
		{
			name: "duplicate folder ids",
			doc: diskDocument{Version: storeFormatVersion, Folders: []Folder{
				{ID: "same", Name: "one", Owner: "alice", Visibility: VisibilityPrivate, Revision: 1},
				{ID: "same", Name: "two", Owner: "alice", Visibility: VisibilityPrivate, Revision: 1},
			}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newTestStore(t)
			if err := os.MkdirAll(filepath.Dir(store.path()), 0o700); err != nil {
				t.Fatalf("mkdir = %v", err)
			}
			payload, err := json.Marshal(test.doc)
			if err != nil {
				t.Fatalf("marshal = %v", err)
			}
			if err := os.WriteFile(store.path(), payload, 0o600); err != nil {
				t.Fatalf("write = %v", err)
			}
			if _, err := store.Snapshot(writer("alice")); err == nil {
				t.Fatal("Snapshot accepted an unsafe stored document")
			}
		})
	}
}

func TestStoreWritesPrivateAtomicFile(t *testing.T) {
	store := newTestStore(t)
	mustSaveScript(t, store, writer("alice"), baseScriptInput("atomic"))

	info, err := os.Stat(store.path())
	if err != nil {
		t.Fatalf("stat library = %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("library mode = %o, want 600", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(filepath.Dir(store.path()))
	if err != nil {
		t.Fatalf("stat library dir = %v", err)
	}
	if runtime.GOOS != "windows" && dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("library dir mode = %o, want 700", dirInfo.Mode().Perm())
	}
	entries, err := os.ReadDir(filepath.Dir(store.path()))
	if err != nil {
		t.Fatalf("read library dir = %v", err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("temporary file was not cleaned up: %s", entry.Name())
		}
	}

	payload, err := os.ReadFile(store.path())
	if err != nil {
		t.Fatalf("read library = %v", err)
	}
	var doc diskDocument
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatalf("decode library = %v", err)
	}
	if doc.Version != storeFormatVersion || len(doc.Scripts) != 1 {
		t.Fatalf("disk document = %+v", doc)
	}
}

func TestStoreRejectsCorruptDocument(t *testing.T) {
	store := newTestStore(t)
	if err := os.MkdirAll(filepath.Dir(store.path()), 0o700); err != nil {
		t.Fatalf("mkdir = %v", err)
	}
	if err := os.WriteFile(store.path(), []byte("{not-json"), 0o600); err != nil {
		t.Fatalf("write corrupt library = %v", err)
	}
	if _, err := store.Snapshot(writer("alice")); err == nil {
		t.Fatal("Snapshot accepted a corrupt library")
	}
}

func TestWriteLockHonorsContextCancellation(t *testing.T) {
	store := newTestStore(t)
	if err := os.MkdirAll(filepath.Dir(store.path()), 0o700); err != nil {
		t.Fatalf("mkdir = %v", err)
	}
	lock, err := appdata.AcquireFileLock(store.lockPath())
	if err != nil {
		t.Fatalf("acquire external lock = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, saveErr := store.SaveScript(ctx, writer("alice"), baseScriptInput("blocked"))
	if !errors.Is(saveErr, context.DeadlineExceeded) {
		t.Fatalf("SaveScript error = %v, want context deadline", saveErr)
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("close external lock = %v", err)
	}
	if _, err := store.SaveScript(context.Background(), writer("alice"), baseScriptInput("unblocked")); err != nil {
		t.Fatalf("SaveScript after unlock = %v", err)
	}
}

func TestMultipleStoreInstancesRejectStaleRevision(t *testing.T) {
	root := t.TempDir()
	first := NewStore(root)
	second := NewStore(root)
	created := mustSaveScript(t, first, writer("alice"), baseScriptInput("shared store"))

	update := baseScriptInput("first write")
	update.ID = created.ID
	update.Revision = created.Revision
	if _, err := first.SaveScript(context.Background(), writer("alice"), update); err != nil {
		t.Fatalf("first update = %v", err)
	}

	update.Name = "stale write"
	if _, err := second.SaveScript(context.Background(), writer("alice"), update); !errors.Is(err, ErrConflict) {
		t.Fatalf("second update error = %v, want ErrConflict", err)
	}
}

func TestLoadRejectsOversizedFileBeforeDecode(t *testing.T) {
	store := newTestStore(t)
	if err := os.MkdirAll(filepath.Dir(store.path()), 0o700); err != nil {
		t.Fatalf("mkdir = %v", err)
	}
	file, err := os.Create(store.path())
	if err != nil {
		t.Fatalf("create library = %v", err)
	}
	if err := file.Truncate(MaxDiskBytes + 1); err != nil {
		_ = file.Close()
		t.Fatalf("truncate library = %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close library = %v", err)
	}
	if _, err := store.Snapshot(writer("alice")); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("Snapshot oversized library error = %v", err)
	}
}

func TestLoadRejectsTooManyItems(t *testing.T) {
	store := newTestStore(t)
	if err := os.MkdirAll(filepath.Dir(store.path()), 0o700); err != nil {
		t.Fatalf("mkdir = %v", err)
	}
	scripts := make([]Script, MaxItems+1)
	for index := range scripts {
		scripts[index] = Script{
			ID:          "script-" + strconv.Itoa(index),
			Name:        "script",
			Code:        "1",
			Owner:       WebOwner("alice"),
			Visibility:  VisibilityPrivate,
			Revision:    1,
			BatchSize:   500,
			INListLimit: 1000,
		}
	}
	payload, err := json.Marshal(diskDocument{
		Version: storeFormatVersion,
		Scripts: scripts,
		Folders: []Folder{},
	})
	if err != nil {
		t.Fatalf("marshal library = %v", err)
	}
	if err := os.WriteFile(store.path(), payload, 0o600); err != nil {
		t.Fatalf("write library = %v", err)
	}
	if _, err := store.Snapshot(writer("alice")); err == nil || !strings.Contains(err.Error(), "too many") {
		t.Fatalf("Snapshot too-many-items error = %v", err)
	}
}

func TestLegacyOwnersAreNamespacedOnLoad(t *testing.T) {
	store := newTestStore(t)
	if err := os.MkdirAll(filepath.Dir(store.path()), 0o700); err != nil {
		t.Fatalf("mkdir = %v", err)
	}
	payload, err := json.Marshal(diskDocument{
		Version: storeFormatVersion,
		Scripts: []Script{
			{
				ID: "desktop", Name: "desktop", Code: "1", Owner: "local",
				Visibility: VisibilityPrivate, Revision: 1, BatchSize: 500, INListLimit: 1000,
			},
			{
				ID: "web", Name: "web", Code: "1", Owner: "alice",
				Visibility: VisibilityPrivate, Revision: 1, BatchSize: 500, INListLimit: 1000,
			},
		},
		Folders: []Folder{},
	})
	if err != nil {
		t.Fatalf("marshal library = %v", err)
	}
	if err := os.WriteFile(store.path(), payload, 0o600); err != nil {
		t.Fatalf("write library = %v", err)
	}

	desktopSnapshot, err := store.Snapshot(Actor{Owner: "local"})
	if err != nil {
		t.Fatalf("desktop snapshot = %v", err)
	}
	if len(desktopSnapshot.Scripts) != 1 ||
		desktopSnapshot.Scripts[0].ID != "desktop" ||
		desktopSnapshot.Scripts[0].Owner != "local" {
		t.Fatalf("desktop migrated scripts = %+v", desktopSnapshot.Scripts)
	}

	webSnapshot, err := store.Snapshot(Actor{Owner: "alice"})
	if err != nil {
		t.Fatalf("web snapshot = %v", err)
	}
	if len(webSnapshot.Scripts) != 1 ||
		webSnapshot.Scripts[0].ID != "web" ||
		webSnapshot.Scripts[0].Owner != "alice" {
		t.Fatalf("web migrated scripts = %+v", webSnapshot.Scripts)
	}
}

func TestLegacyOwnerMigrationPersistsOnNextWrite(t *testing.T) {
	store := newTestStore(t)
	if err := os.MkdirAll(filepath.Dir(store.path()), 0o700); err != nil {
		t.Fatalf("mkdir = %v", err)
	}
	payload, err := json.Marshal(diskDocument{
		Version: storeFormatVersion,
		Scripts: []Script{
			{
				ID: "desktop", Name: "desktop", Code: "1", Owner: "local",
				Visibility: VisibilityPrivate, Revision: 1, BatchSize: 500, INListLimit: 1000,
			},
			{
				ID: "web", Name: "web", Code: "1", Owner: " Alice ",
				Visibility: VisibilityPrivate, Revision: 1, BatchSize: 500, INListLimit: 1000,
			},
		},
		Folders: []Folder{
			{ID: "desktop-folder", Name: "desktop", Owner: "local", Visibility: VisibilityPrivate, Revision: 1},
			{ID: "web-folder", Name: "web", Owner: "Alice", Visibility: VisibilityPrivate, Revision: 1},
		},
	})
	if err != nil {
		t.Fatalf("marshal library = %v", err)
	}
	if err := os.WriteFile(store.path(), payload, 0o600); err != nil {
		t.Fatalf("write library = %v", err)
	}

	if _, err := store.SaveScript(context.Background(), writer("local"), baseScriptInput("new desktop script")); err != nil {
		t.Fatalf("save desktop script: %v", err)
	}
	persisted, err := os.ReadFile(store.path())
	if err != nil {
		t.Fatalf("read library = %v", err)
	}
	text := string(persisted)
	for _, owner := range []string{`"owner": "desktop:local"`, `"owner": "web:alice"`} {
		if !strings.Contains(text, owner) {
			t.Fatalf("persisted library is missing %s: %s", owner, text)
		}
	}
	for _, owner := range []string{`"owner": "local"`, `"owner": "alice"`, `"owner": "Alice"`} {
		if strings.Contains(text, owner) {
			t.Fatalf("persisted library still contains legacy owner %s: %s", owner, text)
		}
	}
}
