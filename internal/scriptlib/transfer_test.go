package scriptlib

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestExportSanitizesAndOnlyIncludesVisibleItems(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	sharedFolder, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{
		Name:       "shared folder",
		Visibility: VisibilityShared,
	})
	if err != nil {
		t.Fatalf("shared folder = %v", err)
	}
	privateInput := baseScriptInput("private export")
	privateInput.Connections = []ConnectionBinding{{Alias: "prod", ConnectionID: "private-connection", Database: "orders"}}
	privateInput.Inputs = []InputBinding{{Alias: "ids", Path: "/tmp/private.xlsx", Reference: "private-token", Name: "private.xlsx"}}
	mustSaveScript(t, store, alice, privateInput)
	sharedInput := baseScriptInput("shared export")
	sharedInput.Visibility = VisibilityShared
	sharedInput.FolderID = sharedFolder.ID
	sharedInput.Connections = []ConnectionBinding{{Alias: "prod", Database: "orders"}}
	sharedInput.AllowWrite = true
	sharedInput.BatchSize = 1200
	sharedInput.INListLimit = 300
	sharedInput.RunLimits = RunLimits{
		TimeoutMs:        12 * 60 * 1_000,
		MaxDBCalls:       12_000,
		MaxOutputRows:    60_000,
		MemoryLimitBytes: 640 << 20,
	}
	mustSaveScript(t, store, alice, sharedInput)
	mustSaveScript(t, store, writer("bob"), baseScriptInput("bob private"))

	document, err := store.Export(alice)
	if err != nil {
		t.Fatalf("Export error = %v", err)
	}
	if document.Version != transferFormatVersion || len(document.Scripts) != 2 || len(document.Folders) != 1 {
		t.Fatalf("export document = %+v", document)
	}
	for _, script := range document.Scripts {
		for _, connection := range script.Connections {
			if connection.ConnectionID != "" {
				t.Fatalf("export leaked connection id: %+v", connection)
			}
		}
		for _, input := range script.Inputs {
			if input.Path != "" || input.Reference != "" {
				t.Fatalf("export leaked input location: %+v", input)
			}
		}
		if script.Name == "bob private" {
			t.Fatal("export included another user's private script")
		}
		if script.Name == "shared export" && script.RunLimits != sharedInput.RunLimits {
			t.Fatalf("exported run limits = %+v, want %+v", script.RunLimits, sharedInput.RunLimits)
		}
	}

	payload, err := store.ExportJSON(alice)
	if err != nil {
		t.Fatalf("ExportJSON error = %v", err)
	}
	assertBytesOmit(t, payload, "private-connection", "/tmp/private.xlsx", "private-token", "bob private")
}

func TestImportRegeneratesIdentityAndPreservesFolderTree(t *testing.T) {
	source := newTestStore(t)
	alice := writer("alice")
	root, err := source.SaveFolder(context.Background(), alice, SaveFolderInput{Name: "root"})
	if err != nil {
		t.Fatalf("root folder = %v", err)
	}
	child, err := source.SaveFolder(context.Background(), alice, SaveFolderInput{
		Name:     "child",
		ParentID: root.ID,
	})
	if err != nil {
		t.Fatalf("child folder = %v", err)
	}
	input := baseScriptInput("import me")
	input.FolderID = child.ID
	input.Description = "portable"
	input.Connections = []ConnectionBinding{{Alias: "prod", ConnectionID: "connection-to-drop", Database: "orders"}}
	input.Inputs = []InputBinding{{Alias: "ids", Path: "/tmp/ids.xlsx", Reference: "token-to-drop", Name: "ids.xlsx"}}
	input.AllowWrite = true
	input.BatchSize = 750
	input.INListLimit = 250
	input.RunLimits = RunLimits{
		TimeoutMs:        15 * 60 * 1_000,
		MaxDBCalls:       15_000,
		MaxOutputRows:    70_000,
		MemoryLimitBytes: 700 << 20,
	}
	original := mustSaveScript(t, source, alice, input)
	document, err := source.Export(alice)
	if err != nil {
		t.Fatalf("export = %v", err)
	}
	// Reverse the folder order to prove the importer resolves parents
	// independently of JSON order.
	document.Folders[0], document.Folders[1] = document.Folders[1], document.Folders[0]

	target := newTestStore(t)
	bob := writer("bob")
	importedSnapshot, err := target.Import(context.Background(), bob, document)
	if err != nil {
		t.Fatalf("Import error = %v", err)
	}
	if len(importedSnapshot.Scripts) != 1 || len(importedSnapshot.Folders) != 2 {
		t.Fatalf("imported snapshot = %+v", importedSnapshot)
	}
	imported := importedSnapshot.Scripts[0]
	if imported.ID == original.ID || imported.Owner != "bob" || imported.Revision != 1 {
		t.Fatalf("imported identity = %+v", imported)
	}
	if imported.Description != "portable" || !imported.AllowWrite || imported.BatchSize != 750 || imported.INListLimit != 250 {
		t.Fatalf("imported metadata = %+v", imported)
	}
	if imported.RunLimits != input.RunLimits {
		t.Fatalf("imported run limits = %+v, want %+v", imported.RunLimits, input.RunLimits)
	}
	if imported.Connections[0].ConnectionID != "" || imported.Inputs[0].Path != "" || imported.Inputs[0].Reference != "" {
		t.Fatalf("imported bindings leaked sensitive values: %+v", imported)
	}

	var importedRoot, importedChild Folder
	for _, folder := range importedSnapshot.Folders {
		switch folder.Name {
		case "root":
			importedRoot = folder
		case "child":
			importedChild = folder
		}
	}
	if importedRoot.ID == "" || importedChild.ParentID != importedRoot.ID {
		t.Fatalf("imported folders = %+v", importedSnapshot.Folders)
	}
	if imported.FolderID != importedChild.ID {
		t.Fatalf("imported script folder = %q, want %q", imported.FolderID, importedChild.ID)
	}
}

func TestImportJSONRejectsInvalidPayloadWithoutMutation(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	mustSaveScript(t, store, alice, baseScriptInput("existing"))
	before, err := store.Snapshot(alice)
	if err != nil {
		t.Fatalf("snapshot before = %v", err)
	}

	cycle := TransferDocument{
		Version: transferFormatVersion,
		Folders: []Folder{
			{ID: "a", Name: "a", ParentID: "b"},
			{ID: "b", Name: "b", ParentID: "a"},
		},
	}
	payload, err := json.Marshal(cycle)
	if err != nil {
		t.Fatalf("marshal cycle = %v", err)
	}
	if _, err := store.ImportJSON(context.Background(), alice, payload); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cycle import error = %v, want ErrInvalid", err)
	}
	if _, err := store.ImportJSON(context.Background(), alice, []byte("{bad-json")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid JSON error = %v, want ErrInvalid", err)
	}
	if _, err := store.ImportJSON(context.Background(), alice, nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty JSON error = %v, want ErrInvalid", err)
	}
	after, err := store.Snapshot(alice)
	if err != nil {
		t.Fatalf("snapshot after = %v", err)
	}
	if len(after.Scripts) != len(before.Scripts) || len(after.Folders) != len(before.Folders) {
		t.Fatalf("invalid import mutated library: before=%+v after=%+v", before, after)
	}
}

func TestImportRequiresWriteAccess(t *testing.T) {
	store := newTestStore(t)
	document := TransferDocument{Version: transferFormatVersion}
	if _, err := store.Import(context.Background(), Actor{Owner: "viewer", ReadOnly: true}, document); !errors.Is(err, ErrForbidden) {
		t.Fatalf("read-only import error = %v, want ErrForbidden", err)
	}
}

func TestImportRejectsMixedVisibilityFolderTree(t *testing.T) {
	store := newTestStore(t)
	document := TransferDocument{
		Version: transferFormatVersion,
		Folders: []Folder{
			{ID: "private", Name: "private", Visibility: VisibilityPrivate},
			{ID: "child", Name: "child", ParentID: "private", Visibility: VisibilityShared},
		},
	}
	if _, err := store.Import(context.Background(), writer("alice"), document); !errors.Is(err, ErrInvalid) {
		t.Fatalf("mixed visibility import error = %v, want ErrInvalid", err)
	}
}

func TestImportStripsBindingsFromPrivateTransportScripts(t *testing.T) {
	store := newTestStore(t)
	document := TransferDocument{
		Version: transferFormatVersion,
		Scripts: []Script{{
			Name:       "untrusted private",
			Code:       "1",
			Visibility: VisibilityPrivate,
			Connections: []ConnectionBinding{{
				Alias:        "prod",
				ConnectionID: "stolen-connection",
				Database:     "orders",
			}},
			Inputs: []InputBinding{{
				Alias:     "ids",
				Path:      "/etc/passwd",
				Reference: "stolen-upload",
				Name:      "ids.csv",
			}},
		}},
	}
	snapshot, err := store.Import(context.Background(), writer("alice"), document)
	if err != nil {
		t.Fatalf("Import error = %v", err)
	}
	imported := snapshot.Scripts[0]
	if imported.Connections[0].ConnectionID != "" ||
		imported.Inputs[0].Path != "" ||
		imported.Inputs[0].Reference != "" {
		t.Fatalf("imported private bindings were not sanitized: %+v", imported)
	}
}

func assertBytesOmit(t *testing.T, payload []byte, values ...string) {
	t.Helper()
	text := string(payload)
	for _, value := range values {
		if strings.Contains(text, value) {
			t.Fatalf("payload still contains %q", value)
		}
	}
}
