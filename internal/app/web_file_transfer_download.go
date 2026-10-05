package app

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

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

// openExportFileForTarget 打开导出目标。桌面目标改走同目录临时文件的原子
// 替换（第二返回值非 nil）：查询、编码、取消或落盘失败时调用方 abort 清理
// 临时文件，既有目标文件在成功提交前保持不变；Web 下载目标行为不变
// （第二返回值恒为 nil，无提交/回滚语义）。
func openExportFileForTarget(target *webDownloadTarget, filename string) (io.WriteCloser, *atomicExportTarget, error) {
	if target != nil {
		f, err := target.openFile()
		return f, nil, err
	}
	atomic, err := createAtomicExportTarget(filename)
	if err != nil {
		return nil, nil, err
	}
	return atomic.file, atomic, nil
}

// finishExportFileTarget 提交导出结果：桌面原子目标 Sync+Close 后原子替换
// 既有文件；Web 目标仅关闭。与 openExportFileForTarget 成对使用。
func finishExportFileTarget(f io.WriteCloser, atomic *atomicExportTarget) error {
	if atomic != nil {
		return atomic.commit(context.Background())
	}
	return closeExportFile(f)
}

// cleanupExportFileTarget 清理未提交的导出句柄：原子目标删除临时文件
// （已提交时为 no-op），Web 目标与桌面裸句柄直接关闭。
func cleanupExportFileTarget(f io.WriteCloser, atomic *atomicExportTarget) {
	if atomic != nil {
		atomic.abort()
		return
	}
	_ = f.Close()
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
	return target.commit(context.Background())
}
