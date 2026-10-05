package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
)

func StageWebUploadForEntryPoint(a *App, purpose string, fileName string, source io.Reader) (WebUploadInfo, error) {
	if a == nil || !a.webRuntime {
		return WebUploadInfo{}, errors.New("web upload is unavailable outside web runtime")
	}
	if source == nil {
		return WebUploadInfo{}, fmt.Errorf("%w: upload file is required", ErrInvalidWebUpload)
	}
	purpose, err := normalizeWebUploadPurpose(purpose)
	if err != nil {
		return WebUploadInfo{}, fmt.Errorf("%w: %v", ErrInvalidWebUpload, err)
	}
	fileName, err = normalizeWebTransferFileName(fileName)
	if err != nil {
		return WebUploadInfo{}, fmt.Errorf("%w: %v", ErrInvalidWebUpload, err)
	}
	if err := validateWebUploadFileName(purpose, fileName); err != nil {
		return WebUploadInfo{}, fmt.Errorf("%w: %v", ErrInvalidWebUpload, err)
	}

	root := a.webTransferRoot(webTransferUploadsDir, purpose)
	a.cleanupStaleWebTransfers(root, time.Now().Add(-webUploadRetention), true)
	refreshWebTransferBudget(a.webTransferRoot())
	budget, err := newWebTransferBudget(a.webTransferRoot(), MaxWebUploadBytes, ErrWebUploadTooLarge)
	if err != nil {
		return WebUploadInfo{}, err
	}
	managed, err := createWebManagedFile(root, fileName, webTransferMetadata{
		Kind:     webTransferUploadsDir,
		Purpose:  purpose,
		FileName: fileName,
	})
	if err != nil {
		budget.abort()
		return WebUploadInfo{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(managed.dir)
			budget.abort(managed.dir)
		}
	}()

	rawTarget, err := os.OpenFile(managed.path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return WebUploadInfo{}, err
	}
	target, err := newWebTransferFile(rawTarget, budget)
	if err != nil {
		_ = rawTarget.Close()
		return WebUploadInfo{}, err
	}
	written, copyErr := io.Copy(target, io.LimitReader(source, MaxWebUploadBytes+1))
	if copyErr == nil && written > MaxWebUploadBytes {
		copyErr = ErrWebUploadTooLarge
	}
	if copyErr == nil {
		copyErr = target.Sync()
	}
	closeErr := target.Close()
	if copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return WebUploadInfo{}, copyErr
	}

	managed.metadata.FileSize = written
	managed.metadata.CreatedAt = time.Now().UnixMilli()
	if err := writeWebTransferMetadata(managed.dir, managed.metadata); err != nil {
		return WebUploadInfo{}, err
	}
	budget.commit(managed.dir, written)
	cleanup = false
	return WebUploadInfo{
		FilePath:   managed.token,
		Name:       fileName,
		FileSize:   written,
		FileSizeMB: fmt.Sprintf("%.1f", float64(written)/(1024*1024)),
	}, nil
}

func OpenWebDownloadForEntryPoint(a *App, token string) (*os.File, WebDownloadInfo, error) {
	if a == nil || !a.webRuntime {
		return nil, WebDownloadInfo{}, ErrWebTransferNotFound
	}
	managed, err := a.resolveWebManagedFile(webTransferDownloadsDir, "", token)
	if err != nil {
		return nil, WebDownloadInfo{}, err
	}
	file, err := os.Open(managed.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, WebDownloadInfo{}, ErrWebTransferNotFound
		}
		return nil, WebDownloadInfo{}, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		if err != nil {
			return nil, WebDownloadInfo{}, err
		}
		return nil, WebDownloadInfo{}, ErrWebTransferNotFound
	}
	return file, WebDownloadInfo{
		Token:    managed.token,
		FileName: managed.metadata.FileName,
		MimeType: managed.metadata.MimeType,
		FileSize: info.Size(),
	}, nil
}

func normalizeWebUploadPurpose(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case webUploadPurposeDataImport:
		return webUploadPurposeDataImport, nil
	case webUploadPurposeSQLExecution:
		return webUploadPurposeSQLExecution, nil
	default:
		return "", errors.New("unsupported web upload purpose")
	}
}

func validateWebUploadFileName(purpose string, fileName string) error {
	lower := strings.ToLower(fileName)
	allowed := false
	switch purpose {
	case webUploadPurposeDataImport:
		allowed = strings.HasSuffix(lower, ".csv") || strings.HasSuffix(lower, ".json") || strings.HasSuffix(lower, ".xlsx")
	case webUploadPurposeSQLExecution:
		allowed = strings.HasSuffix(lower, ".sql") || strings.HasSuffix(lower, ".sql.gz")
	}
	if !allowed {
		return errors.New("unsupported upload file type")
	}
	return nil
}

func normalizeWebTransferFileName(raw string) (string, error) {
	name := strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/"))
	if slash := strings.LastIndex(name, "/"); slash >= 0 {
		name = name[slash+1:]
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	name = webTransferFileNameSanitizer.Replace(name)
	if name == "" || name == "." || name == ".." {
		return "", errors.New("upload file name is required")
	}
	runes := []rune(name)
	if len(runes) > 180 {
		suffix := webTransferFileNameSuffix(name)
		suffixRunes := []rune(suffix)
		if len(suffixRunes) < 180 {
			name = string(runes[:180-len(suffixRunes)]) + suffix
		} else {
			name = string(runes[:180])
		}
	}
	return name, nil
}

func webTransferFileNameSuffix(name string) string {
	lower := strings.ToLower(name)
	for _, suffix := range []string{".sql.gz", ".xlsx", ".json", ".csv", ".sql"} {
		if strings.HasSuffix(lower, suffix) {
			return name[len(name)-len(suffix):]
		}
	}
	return filepath.Ext(name)
}

func normalizeWebTransferToken(raw string) (string, error) {
	token := strings.ToLower(strings.TrimSpace(raw))
	parsed, err := uuid.Parse(token)
	if err != nil || parsed.String() != token {
		return "", ErrInvalidWebTransferToken
	}
	return token, nil
}

func (a *App) webTransferRoot(parts ...string) string {
	root := strings.TrimSpace(a.configDir)
	if root == "" {
		root = resolveAppConfigDir()
	}
	joined := []string{root, webTransferDirName}
	joined = append(joined, parts...)
	return filepath.Join(joined...)
}

func createWebManagedFile(root string, fileName string, metadata webTransferMetadata) (webManagedFile, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return webManagedFile{}, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		token := uuid.NewString()
		dir := filepath.Join(root, token)
		if err := os.Mkdir(dir, 0o700); err != nil {
			if os.IsExist(err) {
				continue
			}
			return webManagedFile{}, err
		}
		return webManagedFile{
			token: token,
			dir:   dir,
			path:  filepath.Join(dir, fileName),
			metadata: webTransferMetadata{
				Kind:      metadata.Kind,
				Purpose:   metadata.Purpose,
				FileName:  fileName,
				MimeType:  metadata.MimeType,
				FileSize:  metadata.FileSize,
				CreatedAt: metadata.CreatedAt,
			},
		}, nil
	}
	return webManagedFile{}, errors.New("allocate web file transfer token failed")
}

func writeWebTransferMetadata(dir string, metadata webTransferMetadata) error {
	payload, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, ".metadata-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, filepath.Join(dir, webTransferMetadataName)); err != nil {
		return err
	}
	committed = true
	return nil
}

func (a *App) resolveWebManagedFile(kind string, purpose string, rawToken string) (webManagedFile, error) {
	token, err := normalizeWebTransferToken(rawToken)
	if err != nil {
		return webManagedFile{}, err
	}
	rootParts := []string{kind}
	if purpose != "" {
		rootParts = append(rootParts, purpose)
	}
	root := a.webTransferRoot(rootParts...)
	dir := filepath.Join(root, token)
	payload, err := os.ReadFile(filepath.Join(dir, webTransferMetadataName))
	if err != nil {
		if os.IsNotExist(err) {
			return webManagedFile{}, ErrWebTransferNotFound
		}
		return webManagedFile{}, err
	}
	var metadata webTransferMetadata
	if err := json.Unmarshal(payload, &metadata); err != nil {
		return webManagedFile{}, ErrWebTransferNotFound
	}
	if metadata.Kind != kind || (purpose != "" && metadata.Purpose != purpose) {
		return webManagedFile{}, ErrWebTransferNotFound
	}
	fileName, err := normalizeWebTransferFileName(metadata.FileName)
	if err != nil || fileName != metadata.FileName {
		return webManagedFile{}, ErrWebTransferNotFound
	}
	path := filepath.Join(dir, fileName)
	if err := validateWebManagedPath(root, path); err != nil {
		return webManagedFile{}, ErrWebTransferNotFound
	}
	return webManagedFile{token: token, dir: dir, path: path, metadata: metadata}, nil
}

func validateWebManagedPath(root string, path string) error {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(rootAbs, pathAbs)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("managed file escapes transfer root")
	}
	info, err := os.Lstat(pathAbs)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("managed file is not a regular file")
	}
	resolvedRoot, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return err
	}
	resolvedPath, err := filepath.EvalSymlinks(pathAbs)
	if err != nil {
		return err
	}
	resolvedRelative, err := filepath.Rel(resolvedRoot, resolvedPath)
	if err != nil || resolvedRelative == ".." || strings.HasPrefix(resolvedRelative, ".."+string(filepath.Separator)) {
		return errors.New("managed file resolves outside transfer root")
	}
	return nil
}

func (a *App) resolveWebUploadReference(reference string, purpose string) (string, error) {
	if a == nil || !a.webRuntime {
		return reference, nil
	}
	if strings.TrimSpace(reference) == "" {
		return reference, nil
	}
	managed, err := a.resolveWebManagedFile(webTransferUploadsDir, purpose, reference)
	if err != nil {
		return "", err
	}
	return managed.path, nil
}

func (a *App) validateWebManagedUploadPath(path string, purpose string) error {
	if a == nil || !a.webRuntime {
		return nil
	}
	root := a.webTransferRoot(webTransferUploadsDir, purpose)
	return validateWebManagedPath(root, path)
}
