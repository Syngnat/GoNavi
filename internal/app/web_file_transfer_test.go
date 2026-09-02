package app

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/importjob"

	"github.com/google/uuid"
)

type webTransferZeroReader struct{}

func (webTransferZeroReader) Read(buffer []byte) (int, error) {
	for index := range buffer {
		buffer[index] = 0
	}
	return len(buffer), nil
}

func newWebTransferTestApp(t *testing.T) *App {
	t.Helper()
	application := NewWebApp()
	application.configDir = t.TempDir()
	return application
}

func TestNormalizeWebTransferFileNameSanitizesWindowsInvalidCharacters(t *testing.T) {
	fileName, err := normalizeWebTransferFileName(`C:\fakepath\report:2026*?"<>|.csv`)
	if err != nil {
		t.Fatalf("normalize file name: %v", err)
	}
	if fileName != "report_2026______.csv" {
		t.Fatalf("normalized file name = %q, want %q", fileName, "report_2026______.csv")
	}
}

func TestWebUploadPreservesLongSQLGzipFileNameSuffix(t *testing.T) {
	application := newWebTransferTestApp(t)
	upload, err := StageWebUploadForEntryPoint(
		application,
		webUploadPurposeSQLExecution,
		strings.Repeat("a", 200)+".sql.gz",
		strings.NewReader("SELECT 1;"),
	)
	if err != nil {
		t.Fatalf("stage long SQL upload: %v", err)
	}
	if len([]rune(upload.Name)) != 180 {
		t.Fatalf("normalized upload name length = %d, want 180", len([]rune(upload.Name)))
	}
	if !strings.HasSuffix(strings.ToLower(upload.Name), ".sql.gz") {
		t.Fatalf("normalized upload name = %q, want .sql.gz suffix", upload.Name)
	}
	path, err := application.resolveWebUploadReference(upload.FilePath, webUploadPurposeSQLExecution)
	if err != nil {
		t.Fatalf("resolve long SQL upload: %v", err)
	}
	if !strings.HasSuffix(strings.ToLower(path), ".sql.gz") {
		t.Fatalf("resolved upload path = %q, want .sql.gz suffix", path)
	}
}

func TestWebDownloadBudgetRejectsOversizeWriteAndCleansTarget(t *testing.T) {
	application := newWebTransferTestApp(t)
	target, err := application.newWebDownloadTarget("report.csv", "text/csv")
	if err != nil {
		t.Fatalf("create web download target: %v", err)
	}
	target.budget.maxBytes = 3
	file, err := target.openFile()
	if err != nil {
		t.Fatalf("open web download target: %v", err)
	}
	if _, err := file.Write([]byte("four")); !errors.Is(err, ErrWebDownloadTooLarge) {
		t.Fatalf("oversize write error = %v, want %v", err, ErrWebDownloadTooLarge)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close web download target: %v", err)
	}
	target.abort()
	if _, err := os.Stat(target.dir); !os.IsNotExist(err) {
		t.Fatalf("oversize download target still exists: %v", err)
	}
}

func TestWebDownloadBudgetRejectsStorageQuotaBeforeWrite(t *testing.T) {
	application := newWebTransferTestApp(t)
	target, err := application.newWebDownloadTarget("report.csv", "text/csv")
	if err != nil {
		t.Fatalf("create web download target: %v", err)
	}
	target.budget.maxBytes = 10
	target.budget.storageLimit = 3
	file, err := target.openFile()
	if err != nil {
		t.Fatalf("open web download target: %v", err)
	}
	if _, err := file.Write([]byte("four")); !errors.Is(err, ErrWebTransferStorageFull) {
		t.Fatalf("storage quota write error = %v, want %v", err, ErrWebTransferStorageFull)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close web download target: %v", err)
	}
	target.abort()
}

func TestWebTransferBudgetRefreshKeepsUnwrittenReservations(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "retained.bin"), []byte("retained"), 0o600); err != nil {
		t.Fatalf("write retained transfer: %v", err)
	}
	first, err := newWebTransferBudget(root, 10, ErrWebDownloadTooLarge)
	if err != nil {
		t.Fatalf("create first transfer budget: %v", err)
	}
	defer first.abort()
	if err := first.reserve(4); err != nil {
		t.Fatalf("reserve first transfer: %v", err)
	}
	refreshWebTransferBudget(root)

	second, err := newWebTransferBudget(root, 10, ErrWebDownloadTooLarge)
	if err != nil {
		t.Fatalf("create second transfer budget: %v", err)
	}
	defer second.abort()
	second.storageLimit = 14
	if err := second.reserve(3); !errors.Is(err, ErrWebTransferStorageFull) {
		t.Fatalf("concurrent reservation error = %v, want %v", err, ErrWebTransferStorageFull)
	}
}

func TestWebTransferBudgetLimitsEmptyTransferCount(t *testing.T) {
	root := t.TempDir()
	budget, err := newWebTransferBudget(root, 10, ErrWebDownloadTooLarge)
	if err != nil {
		t.Fatalf("create transfer budget: %v", err)
	}
	budget.abort()

	root, err = filepath.Abs(root)
	if err != nil {
		t.Fatalf("resolve transfer root: %v", err)
	}
	webTransferBudgetRegistry.Lock()
	webTransferBudgetRegistry.roots[filepath.Clean(root)].storedTransfers = MaxWebTransferCount
	webTransferBudgetRegistry.Unlock()
	if _, err := newWebTransferBudget(root, 10, ErrWebDownloadTooLarge); !errors.Is(err, ErrWebTransferStorageFull) {
		t.Fatalf("transfer count error = %v, want %v", err, ErrWebTransferStorageFull)
	}
}

func TestWebTransferBudgetAccountsEmptyUploadAndTokenResidue(t *testing.T) {
	application := newWebTransferTestApp(t)
	if _, err := StageWebUploadForEntryPoint(application, webUploadPurposeDataImport, "empty.csv", strings.NewReader("")); err != nil {
		t.Fatalf("stage empty upload: %v", err)
	}

	target, err := application.newWebDownloadTarget("report.csv", "text/csv")
	if err != nil {
		t.Fatalf("create web download target: %v", err)
	}
	if err := os.WriteFile(target.path, []byte("report"), 0o600); err != nil {
		t.Fatalf("write web download: %v", err)
	}
	residueDir := filepath.Join(target.dir, "batch")
	if err := os.MkdirAll(residueDir, 0o700); err != nil {
		t.Fatalf("create residue directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(residueDir, "residue.sql"), []byte("residue"), 0o600); err != nil {
		t.Fatalf("write residue: %v", err)
	}
	if result := target.finish(connection.QueryResult{Success: true}); !result.Success {
		t.Fatalf("finish web download: %s", result.Message)
	}

	root, err := filepath.Abs(application.webTransferRoot())
	if err != nil {
		t.Fatalf("resolve transfer root: %v", err)
	}
	webTransferBudgetRegistry.Lock()
	state := webTransferBudgetRegistry.roots[filepath.Clean(root)]
	storedBytes, storedTransfers := state.storedBytes, state.storedTransfers
	webTransferBudgetRegistry.Unlock()
	if storedTransfers != 2 {
		t.Fatalf("stored transfer count = %d, want 2", storedTransfers)
	}
	if storedBytes < int64(len("report")+len("residue")) {
		t.Fatalf("stored transfer bytes = %d, want token residue included", storedBytes)
	}
}

func TestWebDownloadBudgetAppliesToAtomicExportTarget(t *testing.T) {
	application := newWebTransferTestApp(t)
	target, err := application.newWebDownloadTarget("report.sql", "application/sql")
	if err != nil {
		t.Fatalf("create web download target: %v", err)
	}
	target.budget.maxBytes = 3
	atomicTarget, err := createAtomicExportTarget(target.path, target.budget)
	if err != nil {
		t.Fatalf("create atomic export target: %v", err)
	}
	defer atomicTarget.abort()
	if _, err := atomicTarget.file.Write([]byte("four")); !errors.Is(err, ErrWebDownloadTooLarge) {
		t.Fatalf("atomic oversize write error = %v, want %v", err, ErrWebDownloadTooLarge)
	}
	target.abort()
}

func TestWebXLSXExportUsesTransferDirectoryAndBudget(t *testing.T) {
	application := newWebTransferTestApp(t)
	target, err := application.newWebDownloadTarget("report.xlsx", webDownloadMIMEForFormat("xlsx"))
	if err != nil {
		t.Fatalf("create web download target: %v", err)
	}
	target.budget.maxBytes = 1
	file, err := target.openFile()
	if err != nil {
		t.Fatalf("open web download target: %v", err)
	}
	defer file.Close()
	writer, err := newExportFileWriter(file, ExportFileOptions{Format: "xlsx"})
	if err != nil {
		t.Fatalf("create XLSX writer: %v", err)
	}
	xlsxWriter, ok := writer.(*xlsxExportFileWriter)
	if !ok {
		t.Fatalf("XLSX writer type = %T", writer)
	}
	if xlsxWriter.tempDir != target.dir {
		t.Fatalf("XLSX temp dir = %q, want %q", xlsxWriter.tempDir, target.dir)
	}
	if err := writer.SetColumns([]string{"id"}); err != nil {
		t.Fatalf("initialize XLSX writer: %v", err)
	}
	if err := writer.Close(); !errors.Is(err, ErrWebDownloadTooLarge) {
		t.Fatalf("XLSX budget error = %v, want %v", err, ErrWebDownloadTooLarge)
	}
	target.abort()
}

func TestWebUploadTokenResolvesOnlyForItsPurposeAndPreviewDoesNotLeakPath(t *testing.T) {
	application := newWebTransferTestApp(t)
	upload, err := StageWebUploadForEntryPoint(
		application,
		webUploadPurposeDataImport,
		`C:\fakepath\customers.csv`,
		strings.NewReader("id,name\n1,Ada\n"),
	)
	if err != nil {
		t.Fatalf("stage web upload: %v", err)
	}
	if _, err := uuid.Parse(upload.FilePath); err != nil {
		t.Fatalf("upload filePath must be an opaque UUID token, got %q", upload.FilePath)
	}
	if upload.Name != "customers.csv" || upload.FileSize == 0 {
		t.Fatalf("unexpected upload metadata: %+v", upload)
	}
	resolvedPath, err := application.resolveWebUploadReference(upload.FilePath, webUploadPurposeDataImport)
	if err != nil {
		t.Fatalf("resolve upload: %v", err)
	}
	if !strings.HasPrefix(resolvedPath, application.configDir+string(filepath.Separator)) {
		t.Fatalf("resolved upload path %q is outside config root", resolvedPath)
	}
	if _, err := application.resolveWebUploadReference(upload.FilePath, webUploadPurposeSQLExecution); !errors.Is(err, ErrWebTransferNotFound) {
		t.Fatalf("wrong-purpose resolve error = %v, want not found", err)
	}
	if _, err := application.resolveWebUploadReference(resolvedPath, webUploadPurposeDataImport); !errors.Is(err, ErrInvalidWebTransferToken) {
		t.Fatalf("raw path resolve error = %v, want invalid token", err)
	}
	if rawPreview := application.PreviewImportFileWithOptions(resolvedPath, ImportFileOptions{}); rawPreview.Success || !strings.Contains(rawPreview.Message, ErrInvalidWebTransferToken.Error()) {
		t.Fatalf("raw path preview result = %+v, want opaque-token rejection", rawPreview)
	}

	preview := application.PreviewImportFileWithOptions(upload.FilePath, ImportFileOptions{})
	if !preview.Success {
		t.Fatalf("preview staged upload failed: %s", preview.Message)
	}
	data, ok := preview.Data.(map[string]interface{})
	if !ok || data["filePath"] != upload.FilePath {
		t.Fatalf("preview filePath = %#v, want opaque token %q", data["filePath"], upload.FilePath)
	}
	payload, err := json.Marshal(preview)
	if err != nil {
		t.Fatalf("marshal preview: %v", err)
	}
	if strings.Contains(string(payload), application.configDir) {
		t.Fatalf("preview leaked managed server path: %s", payload)
	}
}

func TestWebBatchDatabaseExportProducesZipDownload(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	fakeDB := &fakeSQLDumpExportDB{
		tables:    []string{"users"},
		createSQL: "CREATE TABLE `users` (`id` BIGINT)",
	}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }

	application := newWebTransferTestApp(t)
	result := application.ExportDatabasesSQLWithOptions(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
		[]string{"alpha", "beta"},
		false,
		ExportFileOptions{Format: "sql"},
	)
	if !result.Success {
		t.Fatalf("web batch export failed: %+v", result)
	}
	data := result.Data.(map[string]interface{})
	download := data["webDownload"].(WebDownloadInfo)
	if !strings.HasSuffix(download.FileName, ".zip") || download.FileSize == 0 {
		t.Fatalf("unexpected batch download metadata: %+v", download)
	}
	file, _, err := OpenWebDownloadForEntryPoint(application, download.Token)
	if err != nil {
		t.Fatalf("open batch download: %v", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		t.Fatalf("stat batch download: %v", err)
	}
	archive, err := zip.NewReader(file, info.Size())
	if err != nil {
		t.Fatalf("open batch zip: %v", err)
	}
	if len(archive.File) != 2 || !strings.HasSuffix(archive.File[0].Name, "alpha_schema.sql") || !strings.HasSuffix(archive.File[1].Name, "beta_schema.sql") {
		names := make([]string, 0, len(archive.File))
		for _, entry := range archive.File {
			names = append(names, entry.Name)
		}
		t.Fatalf("unexpected batch zip entries: %v", names)
	}
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal batch export: %v", err)
	}
	if strings.Contains(string(payload), application.configDir) {
		t.Fatalf("batch export leaked managed path: %s", payload)
	}
}

func TestWebUploadRejectsOversizeAndRemovesPartialFile(t *testing.T) {
	application := newWebTransferTestApp(t)
	_, err := StageWebUploadForEntryPoint(
		application,
		webUploadPurposeSQLExecution,
		"backup.sql",
		io.LimitReader(webTransferZeroReader{}, MaxWebUploadBytes+1),
	)
	if !errors.Is(err, ErrWebUploadTooLarge) {
		t.Fatalf("oversize upload error = %v, want %v", err, ErrWebUploadTooLarge)
	}
	root := application.webTransferRoot(webTransferUploadsDir, webUploadPurposeSQLExecution)
	entries, readErr := os.ReadDir(root)
	if readErr != nil {
		t.Fatalf("read upload root: %v", readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("oversize upload left partial token directories: %v", entries)
	}
}

func TestWebUploadResolverRejectsSymlinkReplacement(t *testing.T) {
	application := newWebTransferTestApp(t)
	upload, err := StageWebUploadForEntryPoint(application, webUploadPurposeDataImport, "rows.json", strings.NewReader("[]"))
	if err != nil {
		t.Fatalf("stage upload: %v", err)
	}
	managed, err := application.resolveWebManagedFile(webTransferUploadsDir, webUploadPurposeDataImport, upload.FilePath)
	if err != nil {
		t.Fatalf("resolve managed upload: %v", err)
	}
	external := filepath.Join(t.TempDir(), "external.json")
	if err := os.WriteFile(external, []byte("[]"), 0o600); err != nil {
		t.Fatalf("write external file: %v", err)
	}
	if err := os.Remove(managed.path); err != nil {
		t.Fatalf("remove managed file: %v", err)
	}
	if err := os.Symlink(external, managed.path); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := application.resolveWebUploadReference(upload.FilePath, webUploadPurposeDataImport); !errors.Is(err, ErrWebTransferNotFound) {
		t.Fatalf("symlink replacement error = %v, want not found", err)
	}
}

func TestWebDownloadResultUsesSidecarAndCleansFailedTarget(t *testing.T) {
	application := newWebTransferTestApp(t)
	result := application.ExportDataWithOptions(
		[]map[string]interface{}{{"id": 1, "name": "Ada"}},
		[]string{"id", "name"},
		"customers",
		ExportFileOptions{Format: "csv"},
	)
	if !result.Success {
		t.Fatalf("web export failed: %s", result.Message)
	}
	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("web export data type = %T", result.Data)
	}
	download, ok := data["webDownload"].(WebDownloadInfo)
	if !ok {
		t.Fatalf("web download metadata = %#v", data["webDownload"])
	}
	if download.FileName != "customers.csv" || download.FileSize == 0 {
		t.Fatalf("unexpected web download metadata: %+v", download)
	}
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal export result: %v", err)
	}
	if strings.Contains(string(payload), application.configDir) {
		t.Fatalf("export result leaked managed path: %s", payload)
	}
	file, opened, err := OpenWebDownloadForEntryPoint(application, download.Token)
	if err != nil {
		t.Fatalf("open web download: %v", err)
	}
	content, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil {
		t.Fatalf("read web download: %v", err)
	}
	if opened.FileName != download.FileName || !strings.Contains(string(content), "Ada") {
		t.Fatalf("unexpected opened download: metadata=%+v content=%q", opened, content)
	}

	failedTarget, err := application.newWebDownloadTarget("failed.csv", "text/csv")
	if err != nil {
		t.Fatalf("create failed target: %v", err)
	}
	failedDir := failedTarget.dir
	failedTarget.finish(connection.QueryResult{Success: false, Message: failedTarget.path + ": failed"})
	if _, err := os.Stat(failedDir); !os.IsNotExist(err) {
		t.Fatalf("failed web target still exists: %v", err)
	}
}

func TestWebTransferCleanupExpiresDownloadsButPreservesImportJobSources(t *testing.T) {
	application := newWebTransferTestApp(t)
	oldTarget, err := application.newWebDownloadTarget("old.csv", "text/csv")
	if err != nil {
		t.Fatalf("create old target: %v", err)
	}
	if err := os.WriteFile(oldTarget.path, []byte("old"), 0o600); err != nil {
		t.Fatalf("write old target: %v", err)
	}
	oldResult := oldTarget.finish(connection.QueryResult{Success: true})
	if !oldResult.Success {
		t.Fatalf("finish old target: %s", oldResult.Message)
	}
	oldTarget.metadata.CreatedAt = time.Now().Add(-webDownloadRetention - time.Hour).UnixMilli()
	if err := writeWebTransferMetadata(oldTarget.dir, oldTarget.metadata); err != nil {
		t.Fatalf("age old download: %v", err)
	}
	newTarget, err := application.newWebDownloadTarget("new.csv", "text/csv")
	if err != nil {
		t.Fatalf("create new target: %v", err)
	}
	newTarget.abort()
	if _, err := os.Stat(oldTarget.dir); !os.IsNotExist(err) {
		t.Fatalf("stale download was not removed: %v", err)
	}

	upload, err := StageWebUploadForEntryPoint(application, webUploadPurposeDataImport, "resume.csv", strings.NewReader("id\n1\n"))
	if err != nil {
		t.Fatalf("stage resumable upload: %v", err)
	}
	managed, err := application.resolveWebManagedFile(webTransferUploadsDir, webUploadPurposeDataImport, upload.FilePath)
	if err != nil {
		t.Fatalf("resolve resumable upload: %v", err)
	}
	managed.metadata.CreatedAt = time.Now().Add(-webUploadRetention - time.Hour).UnixMilli()
	if err := writeWebTransferMetadata(managed.dir, managed.metadata); err != nil {
		t.Fatalf("age resumable upload: %v", err)
	}
	store, err := application.ensureImportJobStore()
	if err != nil {
		t.Fatalf("open import job store: %v", err)
	}
	if _, err := store.Put(importjob.Job{
		ID:                  "import-" + uuid.NewString(),
		Kind:                importjob.KindTable,
		Status:              importjob.StatusInterrupted,
		SourcePath:          managed.path,
		SourceIdentityToken: "identity",
		TargetFingerprint:   "target",
		OptionsHash:         "options",
	}); err != nil {
		t.Fatalf("persist import job: %v", err)
	}
	second, err := StageWebUploadForEntryPoint(application, webUploadPurposeDataImport, "next.csv", strings.NewReader("id\n2\n"))
	if err != nil {
		t.Fatalf("stage second upload: %v", err)
	}
	if _, err := application.resolveWebUploadReference(second.FilePath, webUploadPurposeDataImport); err != nil {
		t.Fatalf("resolve second upload: %v", err)
	}
	if _, err := os.Stat(managed.path); err != nil {
		t.Fatalf("referenced stale upload was removed: %v", err)
	}
}

func TestWebImportJobViewsRemoveServerSourcePath(t *testing.T) {
	application := newWebTransferTestApp(t)
	job := importjob.Job{
		ID:         "import-view",
		SourcePath: filepath.Join(application.configDir, "web-file-transfer", "uploads", "secret.csv"),
		Message:    "failed reading " + filepath.Join(application.configDir, "web-file-transfer", "uploads", "secret.csv"),
	}
	view := application.webImportJobView(job)
	if view.SourcePath != "" {
		t.Fatalf("web job view leaked source path %q", view.SourcePath)
	}
	if strings.Contains(view.Message, application.configDir) {
		t.Fatalf("web job message leaked config root: %q", view.Message)
	}
	if job.SourcePath == "" {
		t.Fatal("web job sanitization mutated stored job")
	}
}
