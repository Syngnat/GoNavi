package app

import (
	"errors"
	"strings"
	"testing"
)

func TestWebUploadsAreOwnerScopedForEveryPurpose(t *testing.T) {
	application := NewWebApp()
	application.configDir = t.TempDir()
	cases := []struct {
		purpose string
		name    string
		content string
	}{
		{purpose: webUploadPurposeDataImport, name: "rows.csv", content: "id\n1\n"},
		{purpose: webUploadPurposeSQLExecution, name: "backup.sql", content: "SELECT 1;"},
		{purpose: webUploadPurposeScriptInput, name: "ids.csv", content: "id\n1\n"},
	}
	for _, testCase := range cases {
		t.Run(testCase.purpose, func(t *testing.T) {
			upload, err := StageWebUploadForEntryPointForOwner(
				application,
				testCase.purpose,
				testCase.name,
				strings.NewReader(testCase.content),
				"alice",
			)
			if err != nil {
				t.Fatalf("stage upload: %v", err)
			}
			if _, err := application.resolveWebUploadReferenceForOwner(upload.FilePath, testCase.purpose, "alice"); err != nil {
				t.Fatalf("owner resolve failed: %v", err)
			}
			if _, err := application.resolveWebUploadReferenceForOwner(upload.FilePath, testCase.purpose, "bob"); !errors.Is(err, ErrWebTransferNotFound) {
				t.Fatalf("cross-user resolve error = %v, want not found", err)
			}
			if _, err := application.resolveWebUploadReference(upload.FilePath, testCase.purpose); !errors.Is(err, ErrWebTransferNotFound) {
				t.Fatalf("unscoped resolve error = %v, want not found", err)
			}
		})
	}
}

func TestWebDownloadOwnerIsClaimedAndEnforced(t *testing.T) {
	application := NewWebApp()
	application.configDir = t.TempDir()
	result := application.ExportDataWithOptions(
		[]map[string]interface{}{{"id": 1}},
		[]string{"id"},
		"report",
		ExportFileOptions{Format: "csv"},
	)
	if !result.Success {
		t.Fatalf("export failed: %s", result.Message)
	}
	fields := result.Data.(map[string]interface{})
	download := fields["webDownload"].(WebDownloadInfo)
	if _, _, err := OpenWebDownloadForOwner(application, download.Token, "alice"); !errors.Is(err, ErrWebTransferNotFound) {
		t.Fatalf("unclaimed download error = %v, want not found", err)
	}
	if err := ClaimWebDownloadOwnerForResult(application, result, "alice"); err != nil {
		t.Fatalf("claim download result: %v", err)
	}
	file, info, err := OpenWebDownloadForOwner(application, download.Token, "alice")
	if err != nil {
		t.Fatalf("owner download failed: %v", err)
	}
	_ = file.Close()
	if info.FileName != "report.csv" {
		t.Fatalf("download file name = %q", info.FileName)
	}
	if _, _, err := OpenWebDownloadForOwner(application, download.Token, "bob"); !errors.Is(err, ErrWebTransferNotFound) {
		t.Fatalf("cross-user download error = %v, want not found", err)
	}
	if err := application.claimWebDownloadOwner(download.Token, "bob"); !errors.Is(err, ErrWebTransferNotFound) {
		t.Fatalf("cross-user claim error = %v, want not found", err)
	}
}
