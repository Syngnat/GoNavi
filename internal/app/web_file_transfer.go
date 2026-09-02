package app

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"GoNavi-Wails/internal/connection"

	"github.com/google/uuid"
)

const (
	MaxWebUploadBytes          int64 = 50 << 20
	MaxWebDownloadBytes        int64 = 512 << 20
	MaxWebTransferStorageBytes int64 = 1 << 30
	MaxWebTransferCount              = 4096

	webTransferDirName      = "web-file-transfer"
	webTransferUploadsDir   = "uploads"
	webTransferDownloadsDir = "downloads"
	webTransferMetadataName = ".metadata.json"
	webTransferCleanupLimit = 64

	webUploadPurposeDataImport   = "data-import"
	webUploadPurposeSQLExecution = "sql-execution"
)

const (
	webUploadRetention   = 7 * 24 * time.Hour
	webDownloadRetention = 24 * time.Hour
)

var (
	ErrWebUploadTooLarge         = errors.New("web upload exceeds the 50 MiB limit")
	ErrInvalidWebUpload          = errors.New("invalid web upload")
	ErrWebTransferNotFound       = errors.New("web file transfer not found")
	ErrInvalidWebTransferToken   = errors.New("invalid web file transfer token")
	ErrWebDownloadTooLarge       = errors.New("web download exceeds the 512 MiB limit")
	ErrWebTransferStorageFull    = errors.New("web file transfer storage quota exceeded")
	webTransferFileNameSanitizer = strings.NewReplacer(
		":", "_",
		"*", "_",
		"?", "_",
		"\"", "_",
		"<", "_",
		">", "_",
		"|", "_",
	)
	webTransferBudgetRegistry = struct {
		sync.Mutex
		roots map[string]*webTransferStorageState
	}{
		roots: make(map[string]*webTransferStorageState),
	}
)

type WebUploadInfo struct {
	FilePath   string `json:"filePath"`
	Name       string `json:"name"`
	FileSize   int64  `json:"fileSize"`
	FileSizeMB string `json:"fileSizeMB"`
}

type WebDownloadInfo struct {
	Token    string `json:"token"`
	FileName string `json:"fileName"`
	MimeType string `json:"mimeType"`
	FileSize int64  `json:"fileSize"`
}

type webTransferMetadata struct {
	Kind      string `json:"kind"`
	Purpose   string `json:"purpose,omitempty"`
	FileName  string `json:"fileName"`
	MimeType  string `json:"mimeType,omitempty"`
	FileSize  int64  `json:"fileSize"`
	CreatedAt int64  `json:"createdAt"`
}

type webManagedFile struct {
	token    string
	dir      string
	path     string
	metadata webTransferMetadata
}

type webDownloadTarget struct {
	webManagedFile
	budget   *webTransferBudget
	finished bool
}

type webDownloadZipEntry struct {
	Name string
	Path string
}

type webTransferStorageState struct {
	storedBytes     int64
	activeBytes     int64
	storedTransfers int
	activeTransfers int
}

type webTransferBudget struct {
	root         string
	maxBytes     int64
	storageLimit int64
	limitErr     error
	bytes        int64
	transfer     bool
	closed       bool
}

type webTransferStorageUsage struct {
	bytes     int64
	transfers int
}

type webTransferOutputFile interface {
	io.Writer
	io.Closer
	Sync() error
	Truncate(size int64) error
	Seek(offset int64, whence int) (int64, error)
}

type webTransferFile struct {
	file   *os.File
	budget *webTransferBudget
	offset int64
	size   int64
}

func newWebTransferBudget(root string, maxBytes int64, limitErr error) (*webTransferBudget, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	root = filepath.Clean(root)

	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	state, ok := webTransferBudgetRegistry.roots[root]
	if !ok {
		usage, err := readWebTransferStorageUsage(root)
		if err != nil {
			return nil, err
		}
		state = &webTransferStorageState{storedBytes: usage.bytes, storedTransfers: usage.transfers}
		webTransferBudgetRegistry.roots[root] = state
	}
	if state.storedBytes+state.activeBytes >= MaxWebTransferStorageBytes || state.storedTransfers+state.activeTransfers >= MaxWebTransferCount {
		return nil, ErrWebTransferStorageFull
	}
	state.activeTransfers++
	return &webTransferBudget{
		root:         root,
		maxBytes:     maxBytes,
		storageLimit: MaxWebTransferStorageBytes,
		limitErr:     limitErr,
		transfer:     true,
	}, nil
}

func refreshWebTransferBudget(root string) {
	root, err := filepath.Abs(root)
	if err != nil {
		return
	}
	root = filepath.Clean(root)

	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	state, ok := webTransferBudgetRegistry.roots[root]
	if !ok {
		return
	}
	if state.activeBytes > 0 || state.activeTransfers > 0 {
		return
	}
	usage, err := readWebTransferStorageUsage(root)
	if err != nil {
		return
	}
	state.storedBytes = usage.bytes
	state.storedTransfers = usage.transfers
}

func readWebTransferStorageUsage(root string) (webTransferStorageUsage, error) {
	var usage webTransferStorageUsage
	err := filepath.Walk(root, func(_ string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.Mode().IsRegular() {
			usage.bytes += info.Size()
		}
		if info.IsDir() {
			if _, err := uuid.Parse(info.Name()); err == nil {
				usage.transfers++
			}
		}
		return nil
	})
	if os.IsNotExist(err) {
		return webTransferStorageUsage{}, nil
	}
	return usage, err
}

func (budget *webTransferBudget) reserve(bytes int64) error {
	if budget == nil || bytes <= 0 {
		return nil
	}
	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	if budget.closed {
		return errors.New("web download is no longer writable")
	}
	state := webTransferBudgetRegistry.roots[budget.root]
	if state == nil {
		state = &webTransferStorageState{}
		webTransferBudgetRegistry.roots[budget.root] = state
	}
	if budget.bytes+bytes > budget.maxBytes {
		if budget.limitErr != nil {
			return budget.limitErr
		}
		return ErrWebDownloadTooLarge
	}
	if state.storedBytes+state.activeBytes+bytes > budget.storageLimit {
		return ErrWebTransferStorageFull
	}
	budget.bytes += bytes
	state.activeBytes += bytes
	return nil
}

func (budget *webTransferBudget) release(bytes int64) {
	if budget == nil || bytes <= 0 {
		return
	}
	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	if bytes > budget.bytes {
		bytes = budget.bytes
	}
	budget.bytes -= bytes
	if state := webTransferBudgetRegistry.roots[budget.root]; state != nil {
		state.activeBytes -= bytes
		if state.activeBytes < 0 {
			state.activeBytes = 0
		}
	}
}

func (budget *webTransferBudget) abort(directories ...string) {
	if budget == nil {
		return
	}
	remaining := webTransferStorageUsage{}
	if len(directories) > 0 && directories[0] != "" {
		remaining, _ = readWebTransferStorageUsage(directories[0])
	}
	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	if budget.closed {
		return
	}
	if state := webTransferBudgetRegistry.roots[budget.root]; state != nil {
		state.activeBytes -= budget.bytes
		if state.activeBytes < 0 {
			state.activeBytes = 0
		}
		if budget.transfer {
			state.activeTransfers--
			if state.activeTransfers < 0 {
				state.activeTransfers = 0
			}
		}
		if remaining.transfers > 0 {
			state.storedBytes += remaining.bytes
			state.storedTransfers += remaining.transfers
		}
		if state.activeBytes == 0 && state.activeTransfers == 0 {
			if usage, err := readWebTransferStorageUsage(budget.root); err == nil {
				state.storedBytes = usage.bytes
				state.storedTransfers = usage.transfers
			}
		}
	}
	budget.bytes = 0
	budget.transfer = false
	budget.closed = true
}

func (budget *webTransferBudget) commit(directory string, fallbackBytes int64) {
	if budget == nil {
		return
	}
	if fallbackBytes < 0 {
		fallbackBytes = 0
	}
	stored := webTransferStorageUsage{bytes: fallbackBytes, transfers: 1}
	if usage, err := readWebTransferStorageUsage(directory); err == nil {
		stored = usage
	}
	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	if budget.closed {
		return
	}
	state := webTransferBudgetRegistry.roots[budget.root]
	if state == nil {
		state = &webTransferStorageState{}
		webTransferBudgetRegistry.roots[budget.root] = state
	}
	state.activeBytes -= budget.bytes
	if state.activeBytes < 0 {
		state.activeBytes = 0
	}
	if budget.transfer {
		state.activeTransfers--
		if state.activeTransfers < 0 {
			state.activeTransfers = 0
		}
	}
	if state.activeBytes == 0 && state.activeTransfers == 0 {
		if usage, err := readWebTransferStorageUsage(budget.root); err == nil {
			state.storedBytes = usage.bytes
			state.storedTransfers = usage.transfers
		} else {
			state.storedBytes += stored.bytes
			state.storedTransfers += stored.transfers
		}
	} else {
		state.storedBytes += stored.bytes
		state.storedTransfers += stored.transfers
	}
	budget.bytes = 0
	budget.transfer = false
	budget.closed = true
}

func newWebTransferFile(file *os.File, budget *webTransferBudget) (*webTransferFile, error) {
	if file == nil {
		return nil, errors.New("web download file is required")
	}
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	offset, err := file.Seek(0, io.SeekCurrent)
	if err != nil {
		return nil, err
	}
	return &webTransferFile{file: file, budget: budget, offset: offset, size: info.Size()}, nil
}

func (file *webTransferFile) Write(payload []byte) (int, error) {
	if file == nil || file.file == nil {
		return 0, errors.New("web download file is unavailable")
	}
	if len(payload) == 0 {
		return 0, nil
	}
	end := file.offset + int64(len(payload))
	growth := end - file.size
	if growth > 0 {
		if err := file.budget.reserve(growth); err != nil {
			return 0, err
		}
	}
	written, writeErr := file.file.Write(payload)
	file.offset += int64(written)
	actualSize := file.size
	if file.offset > actualSize {
		actualSize = file.offset
	}
	actualGrowth := actualSize - file.size
	if growth > actualGrowth {
		file.budget.release(growth - actualGrowth)
	}
	file.size = actualSize
	if writeErr == nil && written != len(payload) {
		writeErr = io.ErrShortWrite
	}
	return written, writeErr
}

func (file *webTransferFile) Close() error {
	if file == nil || file.file == nil {
		return nil
	}
	return file.file.Close()
}

func (file *webTransferFile) Sync() error {
	if file == nil || file.file == nil {
		return errors.New("web download file is unavailable")
	}
	return file.file.Sync()
}

func (file *webTransferFile) Seek(offset int64, whence int) (int64, error) {
	if file == nil || file.file == nil {
		return 0, errors.New("web download file is unavailable")
	}
	position, err := file.file.Seek(offset, whence)
	if err == nil {
		file.offset = position
	}
	return position, err
}

func (file *webTransferFile) Truncate(size int64) error {
	if file == nil || file.file == nil {
		return errors.New("web download file is unavailable")
	}
	growth := size - file.size
	if growth > 0 {
		if err := file.budget.reserve(growth); err != nil {
			return err
		}
	}
	if err := file.file.Truncate(size); err != nil {
		if growth > 0 {
			file.budget.release(growth)
		}
		return err
	}
	if growth < 0 {
		file.budget.release(-growth)
	}
	file.size = size
	return nil
}

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

func (a *App) newWebDownloadTarget(fileName string, mimeType string) (*webDownloadTarget, error) {
	if a == nil || !a.webRuntime {
		return nil, errors.New("web download is unavailable outside web runtime")
	}
	fileName, err := normalizeWebTransferFileName(fileName)
	if err != nil {
		return nil, err
	}
	root := a.webTransferRoot(webTransferDownloadsDir)
	a.cleanupStaleWebTransfers(root, time.Now().Add(-webDownloadRetention), false)
	refreshWebTransferBudget(a.webTransferRoot())
	budget, err := newWebTransferBudget(a.webTransferRoot(), MaxWebDownloadBytes, ErrWebDownloadTooLarge)
	if err != nil {
		return nil, err
	}
	managed, err := createWebManagedFile(root, fileName, webTransferMetadata{
		Kind:     webTransferDownloadsDir,
		FileName: fileName,
		MimeType: strings.TrimSpace(mimeType),
	})
	if err != nil {
		budget.abort()
		return nil, err
	}
	return &webDownloadTarget{webManagedFile: managed, budget: budget}, nil
}

func (target *webDownloadTarget) abort() {
	if target == nil || target.finished {
		return
	}
	_ = os.RemoveAll(target.dir)
	target.budget.abort(target.dir)
}

func (target *webDownloadTarget) openFile() (webTransferOutputFile, error) {
	if target == nil || target.budget == nil {
		return nil, errors.New("web download target is unavailable")
	}
	file, err := os.OpenFile(target.path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	managed, err := newWebTransferFile(file, target.budget)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	return managed, nil
}

func openExportFileForTarget(target *webDownloadTarget, filename string) (io.WriteCloser, error) {
	if target != nil {
		return target.openFile()
	}
	return os.Create(filename)
}

func webDownloadBudgetForTarget(target *webDownloadTarget) *webTransferBudget {
	if target == nil {
		return nil
	}
	return target.budget
}

func (target *webDownloadTarget) finish(result connection.QueryResult) connection.QueryResult {
	if target == nil {
		return result
	}
	if !result.Success {
		result.Message = sanitizeWebTransferResultMessage(result.Message, target)
		target.abort()
		return result
	}
	info, err := os.Stat(target.path)
	if err != nil || !info.Mode().IsRegular() {
		target.abort()
		if err == nil {
			err = errors.New("web download output is not a regular file")
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if info.Size() > MaxWebDownloadBytes {
		target.abort()
		return connection.QueryResult{Success: false, Message: ErrWebDownloadTooLarge.Error()}
	}
	target.metadata.FileSize = info.Size()
	target.metadata.CreatedAt = time.Now().UnixMilli()
	if err := writeWebTransferMetadata(target.dir, target.metadata); err != nil {
		target.abort()
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target.budget.commit(target.dir, info.Size())
	target.finished = true
	data := map[string]interface{}{}
	if existing, ok := result.Data.(map[string]interface{}); ok {
		for key, value := range existing {
			switch key {
			case "filePath", "directoryPath", "file", "path":
				continue
			default:
				data[key] = value
			}
		}
	}
	data["webDownload"] = WebDownloadInfo{
		Token:    target.token,
		FileName: target.metadata.FileName,
		MimeType: target.metadata.MimeType,
		FileSize: info.Size(),
	}
	result.Data = data
	result.Message = sanitizeWebTransferResultMessage(result.Message, target)
	return result
}

func sanitizeWebTransferResultMessage(message string, target *webDownloadTarget) string {
	if target == nil || message == "" {
		return message
	}
	message = strings.ReplaceAll(message, target.path, target.metadata.FileName)
	message = strings.ReplaceAll(message, target.dir, "web export")
	return message
}

func sanitizeWebManagedResult(result connection.QueryResult, managedPath string) connection.QueryResult {
	managedPath = strings.TrimSpace(managedPath)
	if managedPath == "" || result.Message == "" {
		return result
	}
	result.Message = strings.ReplaceAll(result.Message, managedPath, filepath.Base(managedPath))
	result.Message = strings.ReplaceAll(result.Message, filepath.Dir(managedPath), "uploaded file")
	return result
}

func (a *App) cleanupStaleWebTransfers(root string, cutoff time.Time, preserveImportSources bool) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	referenced := map[string]struct{}{}
	if preserveImportSources {
		if store, storeErr := a.ensureImportJobStore(); storeErr == nil {
			jobs, _ := store.List()
			for _, job := range jobs {
				path := strings.TrimSpace(job.SourcePath)
				if path != "" {
					referenced[filepath.Clean(path)] = struct{}{}
				}
			}
		}
	}
	removed := 0
	for _, entry := range entries {
		if removed >= webTransferCleanupLimit || !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		if preserveImportSources && webTransferDirContainsReferencedPath(dir, referenced) {
			continue
		}
		createdAt := time.Time{}
		if payload, readErr := os.ReadFile(filepath.Join(dir, webTransferMetadataName)); readErr == nil {
			var metadata webTransferMetadata
			if json.Unmarshal(payload, &metadata) == nil && metadata.CreatedAt > 0 {
				createdAt = time.UnixMilli(metadata.CreatedAt)
			}
		}
		if createdAt.IsZero() {
			if info, infoErr := entry.Info(); infoErr == nil {
				createdAt = info.ModTime()
			}
		}
		if createdAt.IsZero() || !createdAt.Before(cutoff) {
			continue
		}
		if os.RemoveAll(dir) == nil {
			removed++
		}
	}
}

func webTransferDirContainsReferencedPath(dir string, referenced map[string]struct{}) bool {
	dir = filepath.Clean(dir)
	prefix := dir + string(filepath.Separator)
	for path := range referenced {
		if path == dir || strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func webDownloadMIMEForFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "csv":
		return "text/csv; charset=utf-8"
	case "json":
		return "application/json"
	case "md":
		return "text/markdown; charset=utf-8"
	case "html":
		return "text/html; charset=utf-8"
	case "xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case "sql":
		return "application/sql; charset=utf-8"
	case "jsonl":
		return "application/x-ndjson"
	case "zip":
		return "application/zip"
	default:
		if detected := mime.TypeByExtension("." + strings.TrimPrefix(format, ".")); detected != "" {
			return detected
		}
		return "application/octet-stream"
	}
}

func writeWebDownloadZip(targetPath string, entries []webDownloadZipEntry, budgets ...*webTransferBudget) error {
	target, err := createAtomicExportTarget(targetPath, budgets...)
	if err != nil {
		return err
	}
	defer target.abort()
	archive := zip.NewWriter(target.file)
	for _, entry := range entries {
		name, err := normalizeWebTransferFileName(entry.Name)
		if err != nil {
			_ = archive.Close()
			return err
		}
		source, err := os.Open(entry.Path)
		if err != nil {
			_ = archive.Close()
			return err
		}
		writer, createErr := archive.Create(name)
		if createErr == nil {
			_, createErr = io.Copy(writer, source)
		}
		closeErr := source.Close()
		if createErr == nil {
			createErr = closeErr
		}
		if createErr != nil {
			_ = archive.Close()
			return createErr
		}
	}
	if err := archive.Close(); err != nil {
		return err
	}
	return target.commit()
}
