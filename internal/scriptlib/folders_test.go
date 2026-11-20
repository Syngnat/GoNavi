package scriptlib

import (
	"context"
	"errors"
	"testing"
)

func TestFolderCrudRevisionAndCycles(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	parent, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{Name: "nightly"})
	if err != nil {
		t.Fatalf("create parent folder = %v", err)
	}
	child, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{
		Name:     "orders",
		ParentID: parent.ID,
	})
	if err != nil {
		t.Fatalf("create child folder = %v", err)
	}
	if child.ParentID != parent.ID || child.Revision != 1 {
		t.Fatalf("child folder = %+v", child)
	}

	rename := SaveFolderInput{ID: child.ID, Name: "orders-v2", ParentID: parent.ID, Revision: child.Revision}
	renamed, err := store.SaveFolder(context.Background(), alice, rename)
	if err != nil {
		t.Fatalf("rename folder = %v", err)
	}
	if renamed.Revision != 2 {
		t.Fatalf("renamed revision = %d, want 2", renamed.Revision)
	}

	rename.Revision = child.Revision
	if _, err := store.SaveFolder(context.Background(), alice, rename); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale folder update error = %v, want ErrConflict", err)
	}

	cycle := SaveFolderInput{ID: parent.ID, Name: parent.Name, ParentID: child.ID, Revision: parent.Revision}
	if _, err := store.SaveFolder(context.Background(), alice, cycle); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cycle update error = %v, want ErrInvalid", err)
	}
}

func TestFolderParentVisibilityAndOwnership(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	privateParent, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{Name: "private"})
	if err != nil {
		t.Fatalf("private parent = %v", err)
	}
	if _, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{
		Name:       "shared child",
		ParentID:   privateParent.ID,
		Visibility: VisibilityShared,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("mixed visibility parent error = %v, want ErrInvalid", err)
	}

	sharedParent, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{
		Name:       "shared",
		Visibility: VisibilityShared,
	})
	if err != nil {
		t.Fatalf("shared parent = %v", err)
	}
	if _, err := store.SaveFolder(context.Background(), writer("bob"), SaveFolderInput{
		Name:       "private under shared",
		ParentID:   sharedParent.ID,
		Visibility: VisibilityPrivate,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("private child under shared error = %v, want ErrInvalid", err)
	}
}

func TestFolderDeleteRequiresEmptyAndEditPermission(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	folder, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{Name: "non-empty"})
	if err != nil {
		t.Fatalf("create folder = %v", err)
	}
	input := baseScriptInput("grouped")
	input.FolderID = folder.ID
	script := mustSaveScript(t, store, alice, input)

	if err := store.DeleteFolder(context.Background(), writer("bob"), DeleteInput{ID: folder.ID, Revision: folder.Revision}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-owner delete error = %v, want ErrForbidden", err)
	}
	if err := store.DeleteFolder(context.Background(), alice, DeleteInput{ID: folder.ID, Revision: folder.Revision}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("non-empty delete error = %v, want ErrInvalid", err)
	}
	if err := store.DeleteScript(context.Background(), alice, DeleteInput{ID: script.ID, Revision: script.Revision}); err != nil {
		t.Fatalf("delete script = %v", err)
	}
	if err := store.DeleteFolder(context.Background(), alice, DeleteInput{ID: folder.ID, Revision: folder.Revision}); err != nil {
		t.Fatalf("delete empty folder = %v", err)
	}
}

func TestFolderVisibilityChangeRejectsIncompatibleContents(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	folder, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{Name: "private scripts"})
	if err != nil {
		t.Fatalf("create folder = %v", err)
	}
	input := baseScriptInput("private in folder")
	input.FolderID = folder.ID
	mustSaveScript(t, store, alice, input)

	if _, err := store.SetFolderVisibility(context.Background(), alice, ShareInput{
		ID:         folder.ID,
		Revision:   folder.Revision,
		Visibility: VisibilityShared,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("share non-empty private folder error = %v, want ErrInvalid", err)
	}

	sharedFolder, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{
		Name:       "team folder",
		Visibility: VisibilityShared,
	})
	if err != nil {
		t.Fatalf("create shared folder = %v", err)
	}
	sharedInput := baseScriptInput("shared in folder")
	sharedInput.Visibility = VisibilityShared
	sharedInput.FolderID = sharedFolder.ID
	sharedScript := mustSaveScript(t, store, alice, sharedInput)
	if sharedScript.FolderID != sharedFolder.ID {
		t.Fatalf("shared script folder = %q", sharedScript.FolderID)
	}
	if _, err := store.SetFolderVisibility(context.Background(), alice, ShareInput{
		ID:         sharedFolder.ID,
		Revision:   sharedFolder.Revision,
		Visibility: VisibilityPrivate,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unshare non-empty folder error = %v, want ErrInvalid", err)
	}
}

func TestSharingScriptDetachesPrivateFolderAndEmptyFolderCanChangeVisibility(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	privateFolder, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{Name: "private grouping"})
	if err != nil {
		t.Fatalf("create private folder = %v", err)
	}
	input := baseScriptInput("grouped private")
	input.FolderID = privateFolder.ID
	script := mustSaveScript(t, store, alice, input)
	shared, err := store.SetScriptVisibility(context.Background(), alice, ShareInput{
		ID:         script.ID,
		Revision:   script.Revision,
		Visibility: VisibilityShared,
	})
	if err != nil {
		t.Fatalf("share script = %v", err)
	}
	if shared.FolderID != "" {
		t.Fatalf("shared script remained in private folder: %+v", shared)
	}

	emptyFolder, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{Name: "empty"})
	if err != nil {
		t.Fatalf("create empty folder = %v", err)
	}
	sharedFolder, err := store.SetFolderVisibility(context.Background(), alice, ShareInput{
		ID:         emptyFolder.ID,
		Revision:   emptyFolder.Revision,
		Visibility: VisibilityShared,
	})
	if err != nil {
		t.Fatalf("share empty folder = %v", err)
	}
	if sharedFolder.Visibility != VisibilityShared || sharedFolder.Revision != 2 {
		t.Fatalf("shared empty folder = %+v", sharedFolder)
	}
	privateFolderAgain, err := store.SetFolderVisibility(context.Background(), alice, ShareInput{
		ID:         sharedFolder.ID,
		Revision:   sharedFolder.Revision,
		Visibility: VisibilityPrivate,
	})
	if err != nil {
		t.Fatalf("unshare empty folder = %v", err)
	}
	if privateFolderAgain.Visibility != VisibilityPrivate || privateFolderAgain.Revision != 3 {
		t.Fatalf("unshared empty folder = %+v", privateFolderAgain)
	}
}

func TestScriptAndFolderVisibilityMustMatch(t *testing.T) {
	store := newTestStore(t)
	alice := writer("alice")
	privateFolder, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{Name: "private"})
	if err != nil {
		t.Fatalf("private folder = %v", err)
	}
	sharedInput := baseScriptInput("shared into private")
	sharedInput.Visibility = VisibilityShared
	sharedInput.FolderID = privateFolder.ID
	if _, err := store.SaveScript(context.Background(), alice, sharedInput); !errors.Is(err, ErrInvalid) {
		t.Fatalf("shared script in private folder error = %v, want ErrInvalid", err)
	}

	sharedFolder, err := store.SaveFolder(context.Background(), alice, SaveFolderInput{
		Name:       "shared",
		Visibility: VisibilityShared,
	})
	if err != nil {
		t.Fatalf("shared folder = %v", err)
	}
	privateInput := baseScriptInput("private into shared")
	privateInput.FolderID = sharedFolder.ID
	if _, err := store.SaveScript(context.Background(), alice, privateInput); !errors.Is(err, ErrInvalid) {
		t.Fatalf("private script in shared folder error = %v, want ErrInvalid", err)
	}
}
