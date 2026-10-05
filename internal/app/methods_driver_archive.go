package app

// 驱动包归档（ZIP / 7z）的统一读取入口。
//
// 单驱动包、导出包与旧版总包是 ZIP；新版总包 GoNavi-DriverAgents.7z 用 LZMA2 固实压缩
// 以绕开 GitHub Release 单资产 2 GiB 上限。格式按文件头魔数识别，扩展名只作入口提示，
// 改名后的包不会被误判。体积护栏仍复用 methods_driver_zip.go 的同一套限值。

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/bodgit/sevenzip"
)

var sevenZipSignature = []byte{'7', 'z', 0xBC, 0xAF, 0x27, 0x1C}

// driverPackageArchiveEntry 是归档内的单个文件条目。
type driverPackageArchiveEntry struct {
	Name             string
	UncompressedSize uint64
	zipFile          *zip.File
	sevenZipFile     *sevenzip.File
}

// driverPackageArchive 是已打开的驱动包归档；用完必须 Close。
type driverPackageArchive struct {
	Entries []*driverPackageArchiveEntry
	closer  io.Closer
}

func (a *driverPackageArchive) Close() error {
	if a == nil || a.closer == nil {
		return nil
	}
	return a.closer.Close()
}

func (e *driverPackageArchiveEntry) Open() (io.ReadCloser, error) {
	if e.sevenZipFile != nil {
		return e.sevenZipFile.Open()
	}
	return e.zipFile.Open()
}

// guard 在解压前按声明体积拦截。ZIP 额外按压缩比拦截；7z 固实块不提供逐条目压缩体积，
// 只能按声明体积拦，实际读取由 copyDriverZipEntry 的限额读取兜底。
func (e *driverPackageArchiveEntry) guard() error {
	if e == nil {
		return nil
	}
	if e.zipFile != nil {
		return guardDriverPackageFile(e.zipFile)
	}
	if e.UncompressedSize > driverPackageMaxEntryUncompressedBytes {
		return newLocalizedDriverBackendError("driver_manager.backend.error.package_entry_limit_exceeded", map[string]any{
			"name": e.Name,
		}, nil)
	}
	return nil
}

func newZipDriverPackageArchiveEntry(file *zip.File) *driverPackageArchiveEntry {
	return &driverPackageArchiveEntry{Name: file.Name, UncompressedSize: file.UncompressedSize64, zipFile: file}
}

// findDriverPackageArchiveEntry 按「完整路径 → 忽略大小写的完整路径 → 文件名」三级定位驱动条目。
func findDriverPackageArchiveEntry(entries []*driverPackageArchiveEntry, entryPaths []string, expectedBaseNames []string) *driverPackageArchiveEntry {
	for _, entry := range entries {
		name := normalizeDriverPackageArchiveName(entry.Name)
		for _, expectedPath := range entryPaths {
			if name == expectedPath {
				return entry
			}
		}
	}
	for _, entry := range entries {
		name := normalizeDriverPackageArchiveName(entry.Name)
		for _, expectedPath := range entryPaths {
			if strings.EqualFold(name, expectedPath) {
				return entry
			}
		}
	}
	for _, entry := range entries {
		name := normalizeDriverPackageArchiveName(entry.Name)
		for _, expectedName := range expectedBaseNames {
			if strings.EqualFold(filepath.Base(name), expectedName) {
				return entry
			}
		}
	}
	return nil
}

func normalizeDriverPackageArchiveName(name string) string {
	return filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(name), "./"))
}

// isDriverPackageArchivePath 判断本地路径是否按驱动包归档处理（ZIP 或 7z）。
func isDriverPackageArchivePath(pathText string) bool {
	ext := strings.ToLower(filepath.Ext(strings.TrimSpace(pathText)))
	return ext == ".zip" || ext == ".7z"
}

func isSevenZipFile(pathText string) (bool, error) {
	file, err := os.Open(pathText)
	if err != nil {
		return false, err
	}
	defer file.Close()
	header := make([]byte, len(sevenZipSignature))
	if _, err := io.ReadFull(file, header); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return false, nil
		}
		return false, err
	}
	return bytes.Equal(header, sevenZipSignature), nil
}

// openDriverPackageArchive 打开驱动包归档，目录条目不会出现在 Entries 中。
func openDriverPackageArchive(pathText string) (*driverPackageArchive, error) {
	sevenZip, err := isSevenZipFile(pathText)
	if err != nil {
		return nil, err
	}
	if sevenZip {
		reader, err := sevenzip.OpenReader(pathText)
		if err != nil {
			return nil, err
		}
		entries := make([]*driverPackageArchiveEntry, 0, len(reader.File))
		for _, file := range reader.File {
			if file.FileInfo().IsDir() {
				continue
			}
			entries = append(entries, &driverPackageArchiveEntry{Name: file.Name, UncompressedSize: file.UncompressedSize, sevenZipFile: file})
		}
		return &driverPackageArchive{Entries: entries, closer: reader}, nil
	}
	reader, err := zip.OpenReader(pathText)
	if err != nil {
		return nil, err
	}
	entries := make([]*driverPackageArchiveEntry, 0, len(reader.File))
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		entries = append(entries, newZipDriverPackageArchiveEntry(file))
	}
	return &driverPackageArchive{Entries: entries, closer: reader}, nil
}
