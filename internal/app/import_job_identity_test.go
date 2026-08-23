package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestImportTargetFingerprintDoesNotDependOnCredentials(t *testing.T) {
	first := connection.ConnectionConfig{Type: "mysql", Host: "db.example", Port: 3306, User: "operator", Password: "secret-a"}
	second := first
	second.Password = "secret-b"
	if got, want := buildImportTargetFingerprint(first, "app", "users"), buildImportTargetFingerprint(second, "app", "users"); got != want {
		t.Fatalf("credential rotation changed target fingerprint: %q != %q", got, want)
	}
	if buildImportTargetFingerprint(first, "app", "users") == buildImportTargetFingerprint(first, "app", "orders") {
		t.Fatal("different target tables must not share a fingerprint")
	}
}

func TestImportOptionsHashIgnoresRuntimeJobID(t *testing.T) {
	stop := false
	first := ImportFileOptions{JobID: "job-a", ContinueOnError: &stop, ColumnMappings: map[string]string{"id": "id"}}
	second := first
	second.JobID = "job-b"
	if got, want := buildImportFileOptionsHash(first), buildImportFileOptionsHash(second); got != want {
		t.Fatalf("job id changed semantic options hash: %q != %q", got, want)
	}
}

func TestImportOptionsHashCanonicalizesEquivalentDefaults(t *testing.T) {
	implicit := ImportFileOptions{}
	explicit := ImportFileOptions{
		Encoding:       "auto",
		Delimiter:      "auto",
		HeaderRow:      1,
		ConflictPolicy: "stop",
	}
	if got, want := buildImportFileOptionsHash(implicit), buildImportFileOptionsHash(explicit); got != want {
		t.Fatalf("equivalent defaults changed semantic options hash: %q != %q", got, want)
	}
}

func TestImportOptionsHashPreservesExactSheetName(t *testing.T) {
	plain := ImportFileOptions{SheetName: "Sheet"}
	spaced := ImportFileOptions{SheetName: " Sheet "}
	if buildImportFileOptionsHash(plain) == buildImportFileOptionsHash(spaced) {
		t.Fatal("distinct workbook sheet names must not share an options hash")
	}
}
