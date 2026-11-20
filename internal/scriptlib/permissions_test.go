package scriptlib

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestPrivateAndSharedPermissions(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	bob := writer("bob")
	admin := Actor{Owner: "admin", CanManageShared: true}
	viewer := Actor{Owner: "viewer", ReadOnly: true}

	private := mustSaveScript(t, store, alice, baseScriptInput("alice private"))
	sharedInput := baseScriptInput("team script")
	sharedInput.Visibility = VisibilityShared
	shared := mustSaveScript(t, store, alice, sharedInput)

	if _, err := store.Get(bob, private.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bob read private error = %v, want ErrNotFound", err)
	}
	if _, err := store.Get(admin, private.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("admin read private error = %v, want ErrNotFound", err)
	}
	if _, err := store.Get(alice, private.ID); err != nil {
		t.Fatalf("owner read private error = %v", err)
	}

	for _, actor := range []Actor{alice, bob, admin, viewer} {
		if _, err := store.Get(actor, shared.ID); err != nil {
			t.Fatalf("%s read shared error = %v", actor.Owner, err)
		}
	}

	bobSnapshot, err := store.Snapshot(bob)
	if err != nil {
		t.Fatalf("bob snapshot = %v", err)
	}
	if containsScript(bobSnapshot.Scripts, private.ID) || !containsScript(bobSnapshot.Scripts, shared.ID) {
		t.Fatalf("bob snapshot = %+v", bobSnapshot.Scripts)
	}
	if bobSnapshot.CanWrite != true || bobSnapshot.CanShare != true || bobSnapshot.ReadOnly {
		t.Fatalf("bob capabilities = %+v", bobSnapshot)
	}

	viewerSnapshot, err := store.Snapshot(viewer)
	if err != nil {
		t.Fatalf("viewer snapshot = %v", err)
	}
	if viewerSnapshot.CanWrite || viewerSnapshot.CanShare || !viewerSnapshot.ReadOnly {
		t.Fatalf("viewer capabilities = %+v", viewerSnapshot)
	}
	if containsScript(viewerSnapshot.Scripts, private.ID) || !containsScript(viewerSnapshot.Scripts, shared.ID) {
		t.Fatalf("viewer snapshot scripts = %+v", viewerSnapshot.Scripts)
	}

	update := baseScriptInput("team script v2")
	update.ID = shared.ID
	update.Visibility = VisibilityShared
	update.Revision = shared.Revision
	if _, err := store.SaveScript(context.Background(), bob, update); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-owner update error = %v, want ErrForbidden", err)
	}
	updatedByOwner, err := store.SaveScript(context.Background(), alice, update)
	if err != nil {
		t.Fatalf("owner update error = %v", err)
	}
	if updatedByOwner.Revision != shared.Revision+1 {
		t.Fatalf("owner update revision = %d", updatedByOwner.Revision)
	}

	update.Name = "admin curated"
	update.Revision = updatedByOwner.Revision
	updatedByAdmin, err := store.SaveScript(context.Background(), admin, update)
	if err != nil {
		t.Fatalf("admin update error = %v", err)
	}
	if updatedByAdmin.Owner != "alice" || updatedByAdmin.Revision != updatedByOwner.Revision+1 {
		t.Fatalf("admin update = %+v", updatedByAdmin)
	}

	if _, err := store.SaveScript(context.Background(), viewer, baseScriptInput("viewer write")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer create error = %v, want ErrForbidden", err)
	}
	if err := store.DeleteScript(context.Background(), bob, DeleteInput{ID: shared.ID, Revision: updatedByAdmin.Revision}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-owner delete error = %v, want ErrForbidden", err)
	}
	if err := store.DeleteScript(context.Background(), viewer, DeleteInput{ID: shared.ID, Revision: updatedByAdmin.Revision}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer delete error = %v, want ErrForbidden", err)
	}
	if err := store.DeleteScript(context.Background(), alice, DeleteInput{ID: shared.ID, Revision: updatedByAdmin.Revision}); err != nil {
		t.Fatalf("owner delete error = %v", err)
	}
}

func TestSharedAdminCanDeleteOwnedScript(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	admin := Actor{Owner: "admin", CanManageShared: true}
	sharedInput := baseScriptInput("admin deletes")
	sharedInput.Visibility = VisibilityShared
	shared := mustSaveScript(t, store, alice, sharedInput)
	if err := store.DeleteScript(context.Background(), admin, DeleteInput{ID: shared.ID, Revision: shared.Revision}); err != nil {
		t.Fatalf("admin delete error = %v", err)
	}
}

func TestSharedOwnerCanEditScriptInSharedFolder(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	admin := Actor{Owner: "admin", CanManageShared: true}
	folder, err := store.SaveFolder(context.Background(), admin, SaveFolderInput{
		Name:       "admin managed shared folder",
		Visibility: VisibilityShared,
	})
	if err != nil {
		t.Fatalf("create shared folder = %v", err)
	}
	input := baseScriptInput("shared in admin folder")
	input.Visibility = VisibilityShared
	input.FolderID = folder.ID
	script := mustSaveScript(t, store, alice, input)

	update := input
	update.ID = script.ID
	update.Name = "shared edited by owner"
	update.Revision = script.Revision
	updated, err := store.SaveScript(context.Background(), alice, update)
	if err != nil {
		t.Fatalf("owner update in shared folder = %v", err)
	}
	if updated.FolderID != folder.ID {
		t.Fatalf("owner update detached shared folder: %+v", updated)
	}
}

func TestSharingStripsConnectionIdentifiersPathsAndTokens(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	input := baseScriptInput("contains bindings")
	input.Connections = []ConnectionBinding{{
		Alias:        "prod",
		ConnectionID: "connection-secret-id",
		Database:     "orders",
	}}
	input.Inputs = []InputBinding{{
		Alias:     "ids",
		Path:      "/Users/alice/private/ids.xlsx",
		Reference: "upload-token-secret",
		Name:      "ids.xlsx",
		HeaderRow: 1,
	}}
	private := mustSaveScript(t, store, alice, input)

	shared, err := store.SetScriptVisibility(context.Background(), alice, ShareInput{
		ID:         private.ID,
		Revision:   private.Revision,
		Visibility: VisibilityShared,
	})
	if err != nil {
		t.Fatalf("SetScriptVisibility error = %v", err)
	}
	if shared.Connections[0].ConnectionID != "" || shared.Inputs[0].Path != "" || shared.Inputs[0].Reference != "" {
		t.Fatalf("shared script was not sanitized: %+v", shared)
	}
	if shared.Connections[0].Alias != "prod" || shared.Inputs[0].Alias != "ids" || shared.Inputs[0].Name != "ids.xlsx" {
		t.Fatalf("non-sensitive binding metadata was lost: %+v", shared)
	}
	assertFileOmits(t, store.path(),
		"connection-secret-id",
		"/Users/alice/private/ids.xlsx",
		"upload-token-secret",
	)

	direct := input
	direct.Name = "direct shared"
	direct.Visibility = VisibilityShared
	directScript := mustSaveScript(t, store, alice, direct)
	if directScript.Connections[0].ConnectionID != "" || directScript.Inputs[0].Path != "" || directScript.Inputs[0].Reference != "" {
		t.Fatalf("direct shared script was not sanitized: %+v", directScript)
	}
	assertFileOmits(t, store.path(),
		"connection-secret-id",
		"/Users/alice/private/ids.xlsx",
		"upload-token-secret",
	)
}

func TestReadOnlyActorCanReadOwnPrivateScriptButCannotWrite(t *testing.T) {
	store := newTestStore(t)
	private := mustSaveScript(t, store, writer("viewer"), baseScriptInput("viewer private"))
	readOnlyViewer := Actor{Owner: "viewer", ReadOnly: true}
	if _, err := store.Get(readOnlyViewer, private.ID); err != nil {
		t.Fatalf("viewer read own private error = %v", err)
	}
	if _, err := store.SaveScript(context.Background(), readOnlyViewer, baseScriptInput("blocked")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer write error = %v, want ErrForbidden", err)
	}
}

func TestWebLocalOwnerCannotReadDesktopPrivateScript(t *testing.T) {
	if WebOwner(strings.ToLower(strings.TrimSpace(DesktopOwner()))) == DesktopOwner() {
		t.Fatal("web owner helper must not preserve a desktop principal")
	}
	store := newTestStore(t)
	desktop := writer("local")
	private := mustSaveScript(t, store, desktop, baseScriptInput("desktop private"))
	if normalizeOwner(private.Owner) != DesktopOwner() {
		t.Fatalf("desktop owner = %q, want internal %q", private.Owner, DesktopOwner())
	}
	webLocal := Actor{Owner: WebOwner("local")}
	if _, err := store.Get(webLocal, private.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("web local read desktop private error = %v, want ErrNotFound", err)
	}
	if _, err := store.Get(desktop, private.ID); err != nil {
		t.Fatalf("desktop read own private error = %v", err)
	}
}

func TestOwnerNamespaceNormalizationAndDisplay(t *testing.T) {
	tests := []struct {
		name    string
		owner   string
		want    string
		display string
	}{
		{name: "desktop legacy", owner: "LOCAL", want: DesktopOwner(), display: "local"},
		{name: "desktop namespaced", owner: DesktopOwner(), want: DesktopOwner(), display: "local"},
		{name: "web legacy", owner: " Alice ", want: WebOwner("alice"), display: "alice"},
		{name: "web namespaced", owner: WebOwner("alice"), want: WebOwner("alice"), display: "alice"},
		{name: "empty", owner: " ", want: "", display: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := normalizeOwner(test.owner); got != test.want {
				t.Fatalf("normalizeOwner(%q) = %q, want %q", test.owner, got, test.want)
			}
			if got := displayOwner(test.owner); got != test.display {
				t.Fatalf("displayOwner(%q) = %q, want %q", test.owner, got, test.display)
			}
		})
	}
	if WebOwner("local") == DesktopOwner() {
		t.Fatal("web local principal must not collide with desktop local")
	}
}

func TestVisibleItemsExposePerItemEditCapabilities(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	bob := writer("bob")
	admin := Actor{Owner: "admin", CanManageShared: true}
	viewer := Actor{Owner: "viewer", ReadOnly: true}

	sharedInput := baseScriptInput("shared permissions")
	sharedInput.Visibility = VisibilityShared
	shared := mustSaveScript(t, store, alice, sharedInput)
	private := mustSaveScript(t, store, alice, baseScriptInput("private permissions"))

	ownerView, err := store.Get(alice, shared.ID)
	if err != nil {
		t.Fatalf("owner shared view = %v", err)
	}
	if !ownerView.CanEdit || !ownerView.CanShare {
		t.Fatalf("owner shared capabilities = %+v", ownerView)
	}
	bobView, err := store.Get(bob, shared.ID)
	if err != nil {
		t.Fatalf("bob shared view = %v", err)
	}
	if bobView.CanEdit || bobView.CanShare {
		t.Fatalf("bob shared capabilities = %+v", bobView)
	}
	adminView, err := store.Get(admin, shared.ID)
	if err != nil {
		t.Fatalf("admin shared view = %v", err)
	}
	if !adminView.CanEdit || !adminView.CanShare {
		t.Fatalf("admin shared capabilities = %+v", adminView)
	}
	viewerView, err := store.Get(viewer, shared.ID)
	if err != nil {
		t.Fatalf("viewer shared view = %v", err)
	}
	if viewerView.CanEdit || viewerView.CanShare {
		t.Fatalf("viewer shared capabilities = %+v", viewerView)
	}
	privateView, err := store.Get(alice, private.ID)
	if err != nil {
		t.Fatalf("owner private view = %v", err)
	}
	if !privateView.CanEdit || !privateView.CanShare {
		t.Fatalf("owner private capabilities = %+v", privateView)
	}

	folder, err := store.SaveFolder(context.Background(), admin, SaveFolderInput{
		Name:       "shared folder permissions",
		Visibility: VisibilityShared,
	})
	if err != nil {
		t.Fatalf("save shared folder = %v", err)
	}
	snapshot, err := store.Snapshot(bob)
	if err != nil {
		t.Fatalf("bob snapshot = %v", err)
	}
	found := false
	for _, item := range snapshot.Folders {
		if item.ID != folder.ID {
			continue
		}
		found = true
		if item.CanEdit || item.CanShare {
			t.Fatalf("bob shared folder capabilities = %+v", item)
		}
	}
	if !found {
		t.Fatal("shared folder missing from bob snapshot")
	}
}

func containsScript(items []Script, id string) bool {
	return findScript(items, id) >= 0
}

func assertFileOmits(t *testing.T, path string, values ...string) {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s = %v", path, err)
	}
	text := string(payload)
	for _, value := range values {
		if strings.Contains(text, value) {
			t.Fatalf("%s still contains sensitive value %q", path, value)
		}
	}
}
