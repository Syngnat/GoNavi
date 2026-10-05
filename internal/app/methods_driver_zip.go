package app

// 驱动包（ZIP / 7z）的条目定位与解压原语；归档的打开与格式识别见 methods_driver_archive.go。
//
// 从 methods_driver.go / methods_driver_assets.go 抽出：这两个文件均已超出行数上限，
// 且本文件是 zip 解压的唯一出口，把体积护栏集中在这里可一次覆盖所有调用点。

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
)

// guardDriverPackageFile 在解压单个条目之前检查其声明体积与压缩比。
//
// 只信任 zip 中央目录里声明的 UncompressedSize64 / CompressedSize64：
// 这是解压前唯一可得的信号，用于阻止 zip bomb 把磁盘打满。
// 声明值说谎（声明小、实际大）时由下方 copyDriverZipEntry 的限额读取兜底。
func guardDriverPackageFile(file *zip.File) error {
	if file == nil {
		return nil
	}
	if file.UncompressedSize64 > driverPackageMaxEntryUncompressedBytes {
		return newLocalizedDriverBackendError("driver_manager.backend.error.package_entry_limit_exceeded", map[string]any{
			"name": file.Name,
		}, nil)
	}
	if file.UncompressedSize64 == 0 {
		return nil
	}
	compressed := file.CompressedSize64
	if compressed == 0 {
		return newLocalizedDriverBackendError("driver_manager.backend.error.package_entry_limit_exceeded", map[string]any{
			"name": file.Name,
		}, nil)
	}
	quotient := file.UncompressedSize64 / compressed
	if quotient > driverPackageMaxCompressionRatio ||
		(quotient == driverPackageMaxCompressionRatio && file.UncompressedSize64%compressed > 0) {
		return newLocalizedDriverBackendError("driver_manager.backend.error.package_entry_limit_exceeded", map[string]any{
			"name": file.Name,
		}, nil)
	}
	return nil
}

// copyDriverZipEntry 把条目内容写入 dst，并强制不超过 driverPackageMaxEntryUncompressedBytes。
//
// 多读 1 字节用于区分「刚好等于上限」与「超过上限」，与 readDriverPackageEntry 同口径。
func copyDriverZipEntry(dst io.Writer, src io.Reader, name string) error {
	written, err := io.Copy(dst, io.LimitReader(src, int64(driverPackageMaxEntryUncompressedBytes)+1))
	if err != nil {
		return err
	}
	if written > int64(driverPackageMaxEntryUncompressedBytes) {
		return newLocalizedDriverBackendError("driver_manager.backend.error.package_entry_limit_exceeded", map[string]any{
			"name": name,
		}, nil)
	}
	return nil
}

func installOptionalDriverAgentFromLocalArchive(archivePath string, definition driverDefinition, executablePath string, selectedVersion string) (string, error) {
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)
	archive, err := openDriverPackageArchive(archivePath)
	if err != nil {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.open_local_package_failed", nil, err)
	}
	defer archive.Close()

	entryPath := optionalDriverBundleEntryPathForVersion(driverType, selectedVersion)
	entryPaths := optionalDriverBundleEntryPathsForVersion(driverType, selectedVersion)
	expectedBaseNames := optionalDriverReleaseAssetNamesForVersion(driverType, selectedVersion)
	entry := findDriverPackageArchiveEntry(archive.Entries, entryPaths, expectedBaseNames)
	if entry == nil {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.local_package_entry_missing", map[string]any{"name": displayName, "path": entryPath}, nil)
	}
	// 与解析侧同口径：命中条目后、解压前先按声明体积（ZIP 另加压缩比）拦一道。
	if guardErr := entry.guard(); guardErr != nil {
		return "", guardErr
	}

	src, err := entry.Open()
	if err != nil {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.read_local_package_entry_failed", nil, err)
	}
	defer src.Close()

	tempPath := executablePath + ".tmp"
	_ = os.Remove(tempPath)
	dst, err := os.Create(tempPath)
	if err != nil {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.create_agent_temp_file_failed", nil, err)
	}
	if err := copyDriverZipEntry(dst, src, entry.Name); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.write_agent_failed", nil, err)
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.sync_agent_failed", nil, err)
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tempPath)
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.close_agent_file_failed", nil, err)
	}
	if chmodErr := os.Chmod(tempPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		_ = os.Remove(tempPath)
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.chmod_agent_failed", nil, chmodErr)
	}
	if err := os.Rename(tempPath, executablePath); err != nil {
		_ = os.Remove(tempPath)
		return "", wrapDriverInstallReplaceErrorOr(err, "driver_manager.backend.error.replace_agent_failed")
	}
	if chmodErr := os.Chmod(executablePath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.chmod_agent_failed", nil, chmodErr)
	}
	if supportErr := extractOptionalDriverSupportFilesFromArchive(archive.Entries, driverType, entry.Name, filepath.Dir(executablePath)); supportErr != nil {
		return "", supportErr
	}
	return normalizeDriverPackageArchiveName(entry.Name), nil
}

func extractZipFileToPath(file *zip.File, targetPath string) error {
	if file == nil {
		return newLocalizedDriverBackendError("driver_manager.backend.error.zip_entry_empty", nil, nil)
	}
	return extractDriverPackageEntryToPath(newZipDriverPackageArchiveEntry(file), targetPath)
}

func extractDriverPackageEntryToPath(entry *driverPackageArchiveEntry, targetPath string) error {
	if entry == nil {
		return newLocalizedDriverBackendError("driver_manager.backend.error.zip_entry_empty", nil, nil)
	}
	if err := entry.guard(); err != nil {
		return err
	}
	src, err := entry.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	tempPath := targetPath + ".tmp"
	_ = os.Remove(tempPath)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	dst, err := os.Create(tempPath)
	if err != nil {
		return err
	}
	if err := copyDriverZipEntry(dst, src, entry.Name); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := renameTempFileOverTarget(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}

func findOptionalDriverSupportFileInArchive(entries []*driverPackageArchiveEntry, agentEntryName string, supportName string) *driverPackageArchiveEntry {
	normalizedAgent := normalizeDriverPackageArchiveName(agentEntryName)
	agentDir := filepath.ToSlash(filepath.Dir(normalizedAgent))
	if agentDir == "." {
		agentDir = ""
	}
	candidatePaths := []string{}
	if agentDir != "" {
		candidatePaths = append(candidatePaths, filepath.ToSlash(filepath.Join(agentDir, supportName)))
	}
	candidatePaths = append(candidatePaths, supportName)

	for _, candidate := range candidatePaths {
		for _, entry := range entries {
			if normalizeDriverPackageArchiveName(entry.Name) == candidate {
				return entry
			}
		}
		for _, entry := range entries {
			if strings.EqualFold(normalizeDriverPackageArchiveName(entry.Name), candidate) {
				return entry
			}
		}
	}
	for _, entry := range entries {
		if strings.EqualFold(filepath.Base(normalizeDriverPackageArchiveName(entry.Name)), supportName) {
			return entry
		}
	}
	return nil
}

func extractOptionalDriverSupportFilesFromArchive(entries []*driverPackageArchiveEntry, driverType string, agentEntryName string, targetDir string) error {
	names := optionalDriverSupportFileNames(driverType)
	if len(names) == 0 {
		return nil
	}
	targetRoot := strings.TrimSpace(targetDir)
	if targetRoot == "" {
		return newLocalizedDriverBackendError("driver_manager.backend.error.runtime_dependency_target_directory_empty", nil, nil)
	}
	for _, name := range names {
		entry := findOptionalDriverSupportFileInArchive(entries, agentEntryName, name)
		if entry == nil {
			return newLocalizedDriverBackendError("driver_manager.backend.error.runtime_dependency_entry_missing", map[string]any{"name": name}, nil)
		}
		if err := extractDriverPackageEntryToPath(entry, filepath.Join(targetRoot, name)); err != nil {
			return newLocalizedDriverBackendError("driver_manager.backend.error.extract_runtime_dependency_failed", map[string]any{"name": name}, err)
		}
	}
	return nil
}
