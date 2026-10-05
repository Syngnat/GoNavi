package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
)

func downloadOptionalDriverAgentBinary(a *App, definition driverDefinition, urlText string, executablePath string, selectedVersion string) (string, error) {
	return downloadOptionalDriverAgentBinaryWithMetadata(context.Background(), a, definition, urlText, urlText, executablePath, selectedVersion)
}

func downloadOptionalDriverAgentBinaryWithMetadata(ctx context.Context, a *App, definition driverDefinition, urlText string, metadataURL string, executablePath string, selectedVersion string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)
	trimmedURL := strings.TrimSpace(urlText)
	if trimmedURL == "" {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.download_url_empty", nil, nil)
	}
	if isOptionalDriverDownloadZipURL(trimmedURL) {
		tempPath := executablePath + ".download.zip"
		_ = os.Remove(tempPath)

		downloadHash, err := downloadFileWithHashPreferredForAppContext(ctx, a, trimmedURL, tempPath, func(downloaded, total int64) {
			if a == nil {
				return
			}
			scaledDownloaded, scaledTotal := scaleProgress(downloaded, total, 20, 90)
			a.emitDriverDownloadProgressContext(ctx, driverType, "downloading", scaledDownloaded, scaledTotal, a.appText("driver_manager.progress.download_prebuilt_package", map[string]any{"name": displayName}))
		})
		if err != nil {
			_ = os.Remove(tempPath)
			if ctx.Err() != nil {
				return "", driverDownloadCanceledError(ctx)
			}
			return "", newLocalizedDriverBackendError("driver_manager.backend.error.download_failed", nil, err)
		}
		metadataSource := strings.TrimSpace(metadataURL)
		if metadataSource == "" {
			metadataSource = trimmedURL
		}
		if expectedSize, expectedHash, ok := expectedDriverReleaseAssetMetadata(metadataSource); ok {
			if metadataErr := validateDownloadedDriverAssetMetadata(tempPath, downloadHash, expectedSize, expectedHash); metadataErr != nil {
				_ = os.Remove(tempPath)
				return "", newLocalizedDriverBackendError(
					"driver_manager.backend.error.download_failed",
					nil,
					metadataErr,
				)
			}
		}

		if _, err := installOptionalDriverAgentFromLocalArchive(tempPath, definition, executablePath, selectedVersion); err != nil {
			_ = os.Remove(tempPath)
			_ = os.Remove(executablePath)
			for _, supportName := range optionalDriverSupportFileNames(driverType) {
				_ = os.Remove(filepath.Join(filepath.Dir(executablePath), supportName))
			}
			return "", newLocalizedDriverBackendError("driver_manager.backend.error.install_prebuilt_package_failed", nil, err)
		}
		_ = os.Remove(tempPath)

		if validateErr := validateOptionalDriverAgentExecutableFunc(driverType, executablePath); validateErr != nil {
			_ = os.Remove(executablePath)
			for _, supportName := range optionalDriverSupportFileNames(driverType) {
				_ = os.Remove(filepath.Join(filepath.Dir(executablePath), supportName))
			}
			return "", validateErr
		}
		hash, hashErr := hashFileSHA256(executablePath)
		if hashErr != nil {
			return "", newLocalizedDriverBackendError("driver_manager.backend.error.agent_hash_failed", nil, hashErr)
		}
		return hash, nil
	}
	if len(optionalDriverSupportFileNames(driverType)) > 0 {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.runtime_dependency_required", map[string]any{
			"name":  displayName,
			"files": strings.Join(optionalDriverSupportFileNames(driverType), ", "),
		}, nil)
	}
	tempPath := executablePath + ".tmp"
	_ = os.Remove(tempPath)

	hash, err := downloadFileWithHashPreferredForAppContext(ctx, a, trimmedURL, tempPath, func(downloaded, total int64) {
		if a == nil {
			return
		}
		scaledDownloaded, scaledTotal := scaleProgress(downloaded, total, 20, 90)
		a.emitDriverDownloadProgressContext(ctx, driverType, "downloading", scaledDownloaded, scaledTotal, a.appText("driver_manager.progress.download_prebuilt_agent", map[string]any{"name": displayName}))
	})
	if err != nil {
		_ = os.Remove(tempPath)
		if ctx.Err() != nil {
			return "", driverDownloadCanceledError(ctx)
		}
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.download_failed", nil, err)
	}

	if chmodErr := os.Chmod(tempPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		_ = os.Remove(tempPath)
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.chmod_agent_failed", nil, chmodErr)
	}
	if renameErr := os.Rename(tempPath, executablePath); renameErr != nil {
		_ = os.Remove(tempPath)
		return "", wrapDriverInstallReplaceErrorOr(renameErr, "driver_manager.backend.error.replace_agent_failed")
	}
	if chmodErr := os.Chmod(executablePath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.chmod_agent_failed", nil, chmodErr)
	}
	if validateErr := validateOptionalDriverAgentExecutableFunc(driverType, executablePath); validateErr != nil {
		_ = os.Remove(executablePath)
		return "", validateErr
	}
	return hash, nil
}

func validateDownloadedDriverAssetMetadata(filePath string, actualHash string, expectedSize int64, expectedHash string) error {
	stat, err := os.Stat(filePath)
	if err != nil {
		return err
	}
	if expectedSize > 0 && stat.Size() != expectedSize {
		return fmt.Errorf("driver archive size mismatch: expected=%d actual=%d", expectedSize, stat.Size())
	}
	if normalized := normalizeGitHubAssetSHA256(expectedHash); normalized != "" && !strings.EqualFold(actualHash, normalized) {
		return errors.New("driver archive SHA256 mismatch")
	}
	return nil
}

func downloadOptionalDriverAgentFromBundle(a *App, definition driverDefinition, bundleURL, executablePath string) (string, string, error) {
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)
	trimmedURL := strings.TrimSpace(bundleURL)
	if trimmedURL == "" {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.bundle_url_empty", nil, nil)
	}

	preferredSource := DownloadSourceCst
	if a != nil {
		preferredSource = a.preferredDownloadSource()
	}
	bundlePath, err := acquireOptionalDriverBundlePathPreferred(trimmedURL, func(downloaded, total int64) {
		if a == nil {
			return
		}
		scaledDownloaded, scaledTotal := scaleProgress(downloaded, total, 20, 78)
		a.emitDriverDownloadProgress(driverType, "downloading", scaledDownloaded, scaledTotal, a.appText("driver_manager.progress.download_bundle", map[string]any{"name": displayName}))
	}, func() {
		if a == nil {
			return
		}
		a.emitDriverDownloadProgress(driverType, "downloading", 20, 100, a.appText("driver_manager.progress.wait_bundle", map[string]any{"name": displayName}))
	}, preferredSource)
	if err != nil {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.bundle_download_failed", nil, err)
	}

	archive, err := openDriverPackageArchive(bundlePath)
	if err != nil {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.open_bundle_failed", nil, err)
	}
	defer archive.Close()

	entryPath := optionalDriverBundleEntryPath(driverType)
	entryPaths := optionalDriverBundleEntryPaths(driverType)
	expectedBaseNames := optionalDriverReleaseAssetNames(driverType)
	entry := findDriverPackageArchiveEntry(archive.Entries, entryPaths, expectedBaseNames)
	if entry == nil {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.bundle_entry_missing", map[string]any{
			"name": displayName,
			"path": entryPath,
		}, nil)
	}
	if a != nil {
		a.emitDriverDownloadProgress(driverType, "downloading", 84, 100, a.appText("driver_manager.progress.unzip_agent", map[string]any{"name": displayName}))
	}

	src, err := entry.Open()
	if err != nil {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.read_bundle_entry_failed", nil, err)
	}
	defer src.Close()

	tempPath := executablePath + ".tmp"
	_ = os.Remove(tempPath)
	dst, err := os.Create(tempPath)
	if err != nil {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.create_agent_temp_file_failed", nil, err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.write_agent_failed", nil, err)
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.sync_agent_failed", nil, err)
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tempPath)
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.close_agent_file_failed", nil, err)
	}
	if chmodErr := os.Chmod(tempPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		_ = os.Remove(tempPath)
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.chmod_agent_failed", nil, chmodErr)
	}
	if err := os.Rename(tempPath, executablePath); err != nil {
		_ = os.Remove(tempPath)
		return "", "", wrapDriverInstallReplaceErrorOr(err, "driver_manager.backend.error.replace_agent_failed")
	}
	if chmodErr := os.Chmod(executablePath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.chmod_agent_failed", nil, chmodErr)
	}
	if supportErr := extractOptionalDriverSupportFilesFromArchive(archive.Entries, driverType, entry.Name, filepath.Dir(executablePath)); supportErr != nil {
		_ = os.Remove(executablePath)
		return "", "", supportErr
	}
	if validateErr := validateOptionalDriverAgentExecutableFunc(driverType, executablePath); validateErr != nil {
		_ = os.Remove(executablePath)
		return "", "", validateErr
	}
	hash, err := hashFileSHA256(executablePath)
	if err != nil {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.agent_hash_failed", nil, err)
	}
	source := fmt.Sprintf("%s#%s", trimmedURL, filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(entry.Name), "./")))
	return source, hash, nil
}
