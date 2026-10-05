package app

import (
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"time"
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
