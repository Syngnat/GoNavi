package app

import (
	"errors"
	"strings"
	"testing"
)

func TestWebScriptUploadRecordsOwnerAndRejectsOtherUsers(t *testing.T) {
	application := newWebTransferTestApp(t)
	upload, err := StageWebUploadForEntryPointForOwner(
		application,
		webUploadPurposeScriptInput,
		"ids.csv",
		strings.NewReader("id\n1\n"),
		" Alice ",
	)
	if err != nil {
		t.Fatalf("stage script upload: %v", err)
	}

	managed, err := application.resolveWebManagedFile(webTransferUploadsDir, webUploadPurposeScriptInput, upload.FilePath)
	if err != nil {
		t.Fatalf("resolve script upload metadata: %v", err)
	}
	if managed.metadata.OwnerUsername != "alice" {
		t.Fatalf("owner username = %q, want alice", managed.metadata.OwnerUsername)
	}
	if _, err := application.resolveWebUploadReferenceForOwner(upload.FilePath, webUploadPurposeScriptInput, "alice"); err != nil {
		t.Fatalf("resolve owner upload: %v", err)
	}
	for _, owner := range []string{"", "bob"} {
		if _, err := application.resolveWebUploadReferenceForOwner(upload.FilePath, webUploadPurposeScriptInput, owner); !errors.Is(err, ErrWebTransferNotFound) {
			t.Fatalf("owner %q resolve error = %v, want not found", owner, err)
		}
	}
}

func TestWebScriptUploadRequiresAuthenticatedOwner(t *testing.T) {
	application := newWebTransferTestApp(t)
	_, err := StageWebUploadForEntryPointForOwner(
		application,
		webUploadPurposeScriptInput,
		"ids.json",
		strings.NewReader("[]"),
		"",
	)
	if !errors.Is(err, ErrInvalidWebUpload) {
		t.Fatalf("unowned script upload error = %v, want invalid upload", err)
	}
}
