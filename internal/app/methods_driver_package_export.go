package app

// 驱动包（ZIP）导出。
//
// 把本机已安装的可选驱动打包成一个 zip，条目布局与发布总包
// GoNavi-DriverAgents.7z（v1.0.2 前为 .zip）保持一致（{Platform}/{type}-driver-agent-{goos}-{goarch}[.exe]），
// 因此导出的包既能被 methods_driver_package.go 的解析回放，也能被既有单驱动导入路径
// installOptionalDriverAgentFromLocalArchive 直接安装。
//
// 进度上报见 methods_driver_package_progress.go（独立事件，不复用下载进度）。

import (
	"archive/zip"
	"compress/flate"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

const driverPackageDefaultFileNamePrefix = "GoNavi-Drivers-"

// defaultDriverPackageExportDirectory 给出导出保存对话框的默认目录。
//
// 刻意不复用 defaultDriverDownloadDirectory()：那个返回的是驱动安装根
// （~/.gonavi/drivers），而导出产物是给用户拿去分享/备份的 ZIP。两者混在
// 一起会让「打开驱动目录」里堆满导出包，安装根也混进非驱动条目。
//
// 优先用户下载目录（导出物的常规去处，用户好找），不可用时退回数据根下的
// exports 子目录，最后兜底系统临时目录。返回值不保证已存在 —— 保存对话框
// 允许用户改路径，真正写入前由 ensureDriverPackageZipExtension 一侧兜底。
func defaultDriverPackageExportDirectory() string {
	if home, err := os.UserHomeDir(); err == nil {
		downloads := filepath.Join(home, "Downloads")
		if info, statErr := os.Stat(downloads); statErr == nil && info.IsDir() {
			return downloads
		}
	}
	if root := appdata.MustResolveActiveRoot(); strings.TrimSpace(root) != "" {
		return filepath.Join(root, "exports")
	}
	return os.TempDir()
}

// driverPackageExportCandidate 是待打包的单个驱动。
type driverPackageExportCandidate struct {
	definition    driverDefinition
	entryName     string
	version       string
	agentRevision string
	sha256        string
	binaryPath    string
	supportFiles  []driverPackageSupportFile
}

type driverPackageSupportFile struct {
	name string
	path string
}

// ExportDriverPackage 把本机已安装的全部可选驱动打包成一个 zip 并写入用户选择的位置。
//
// jobID 由前端生成，用于把进度事件归属到本次导出并支持运行期取消；为空时
// 退化为不可取消（beginCancelableExportTask 的既有约定）。
func (a *App) ExportDriverPackage(downloadDir string, jobID string) connection.QueryResult {
	return a.exportDriverPackage(downloadDir, jobID, nil)
}

// ExportDriverPackageSelection 只打包 driverTypes 里的已安装驱动。
// 空列表与 ExportDriverPackage 相同，表示导出全部。
func (a *App) ExportDriverPackageSelection(downloadDir string, jobID string, driverTypes []string) connection.QueryResult {
	return a.exportDriverPackage(downloadDir, jobID, driverTypes)
}

// exportDriverPackage 执行导出。driverTypes 为空时导出全部已安装可选驱动。
//
// 保存对话框刻意放在锁之外：全类型排他锁一旦持有，安装/删除/下载全部阻塞，
// 用户在模态框停留多久就会阻塞它们多久。代价是对话框期间驱动可能被增删，
// 因此在锁内重新收集一次候选，以锁内快照为准。
func (a *App) exportDriverPackage(downloadDir string, jobID string, driverTypes []string) connection.QueryResult {
	resolvedDir, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	// 先做一次无锁探测：没有可导出驱动时直接失败，不让用户白填一遍保存对话框。
	if candidates, _, _ := loadDriverPackageExportSet(resolvedDir, driverTypes); len(candidates) == 0 {
		return a.driverPackageExportEmptyResult(driverTypes)
	}

	targetPath, err := a.showSaveFileDialog(wailsRuntime.SaveDialogOptions{
		Title:            a.appText("driver_manager.backend.dialog.export_package", nil),
		DefaultDirectory: defaultDriverPackageExportDirectory(),
		DefaultFilename:  driverPackageDefaultFileNamePrefix + time.Now().Format("20060102-150405") + ".zip",
		Filters:          []wailsRuntime.FileFilter{{DisplayName: "ZIP (*.zip)", Pattern: "*.zip"}},
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(targetPath) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	targetPath = ensureDriverPackageZipExtension(targetPath)

	ctx, finish := a.beginCancelableExportTask(jobID)
	defer finish()

	// 取全类型排他锁：导出打包的是全部已装驱动，必须与任意类型的安装/删除互斥，
	// 避免打包过程中二进制正被原子替换，或目录被删除。
	releaseExport := a.driverInstallLock.lockAll()
	defer releaseExport()

	// 锁内重收集：对话框可能开了很久，期间的增删以此处为准。
	candidates, skipped, totalBytes := loadDriverPackageExportSet(resolvedDir, driverTypes)
	if len(candidates) == 0 {
		return a.driverPackageExportEmptyResult(driverTypes)
	}

	reporter := newDriverPackageExportReporter(a, jobID, totalBytes)
	totalBytes, writeErr := writeDriverPackageArchive(ctx, targetPath, candidates, reporter)
	if writeErr != nil {
		// 取消与失败在底层都表现为 error，用 ctx 归一化，避免依赖错误文本比对。
		result := a.classifyExportTaskResult(ctx, connection.QueryResult{
			Success: false,
			Message: a.appText("driver_manager.backend.message.package_export_failed_detail", map[string]any{
				"detail": a.driverOperationErrorMessage(writeErr, "failed to export driver package to %s", targetPath),
			}),
		})
		if !result.Success && ctx.Err() != nil {
			reporter.Canceled()
		} else {
			reporter.Error(result.Message)
		}
		return result
	}

	reporter.Done()
	return connection.QueryResult{
		Success: true,
		Message: a.appText("driver_manager.backend.message.package_export_success", nil),
		Data: map[string]interface{}{
			"path":        targetPath,
			"driverCount": len(candidates),
			"skipped":     skipped,
			"totalBytes":  totalBytes,
		},
	}
}

// collectDriverPackageCandidates 枚举本机已安装且二进制可用的可选驱动。
// 元数据存在但二进制缺失（例如 embedded-go-driver 这类无二进制的残留记录）
// 只计入 skipped，不中断整体导出。
//
// 同时返回未压缩总字节数：它就是导出进度条的分母，用循环里已有的 Stat 结果
// 累加即可，不必为了进度再扫一遍盘。
func collectDriverPackageCandidates(resolvedDir string) ([]driverPackageExportCandidate, []string, int64) {
	candidates := make([]driverPackageExportCandidate, 0, 8)
	skipped := make([]string, 0)
	var totalBytes int64
	for _, definition := range allDriverDefinitionsWithPackages(nil) {
		driverType := normalizeDriverType(definition.Type)
		if definition.BuiltIn || !db.IsOptionalGoDriver(driverType) {
			continue
		}
		pkg, ok := readInstalledDriverPackage(resolvedDir, driverType)
		if !ok {
			continue
		}
		binaryPath, err := db.ResolveOptionalDriverAgentExecutablePathForVersion(resolvedDir, driverType, pkg.Version)
		if err != nil {
			skipped = append(skipped, driverType)
			continue
		}
		info, statErr := os.Stat(binaryPath)
		if statErr != nil || info.IsDir() {
			skipped = append(skipped, driverType)
			continue
		}
		entryPaths := optionalDriverBundleEntryPathsForVersion(driverType, pkg.Version)
		if len(entryPaths) == 0 {
			skipped = append(skipped, driverType)
			continue
		}
		supportFiles := collectDriverPackageSupportFiles(driverType, filepath.Dir(binaryPath))
		totalBytes += info.Size()
		for _, support := range supportFiles {
			if supportInfo, supportErr := os.Stat(support.path); supportErr == nil && !supportInfo.IsDir() {
				totalBytes += supportInfo.Size()
			}
		}
		candidates = append(candidates, driverPackageExportCandidate{
			definition:    definition,
			entryName:     entryPaths[0],
			version:       strings.TrimSpace(pkg.Version),
			agentRevision: strings.TrimSpace(pkg.AgentRevision),
			sha256:        strings.TrimSpace(pkg.SHA256),
			binaryPath:    binaryPath,
			supportFiles:  supportFiles,
		})
	}
	return candidates, skipped, totalBytes
}

// collectDriverPackageSupportFiles 收集需要与 agent 一同打包的运行时依赖
// （目前只有 DuckDB Windows 的 duckdb.dll）。条目与 agent 同目录，才能命中
// findOptionalDriverSupportFileInArchive 的一级匹配。
func collectDriverPackageSupportFiles(driverType string, binaryDir string) []driverPackageSupportFile {
	names := optionalDriverSupportFileNames(driverType)
	if len(names) == 0 {
		return nil
	}
	files := make([]driverPackageSupportFile, 0, len(names))
	for _, name := range names {
		path := filepath.Join(binaryDir, name)
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			continue
		}
		files = append(files, driverPackageSupportFile{name: name, path: path})
	}
	return files
}

func ensureDriverPackageZipExtension(targetPath string) string {
	trimmed := strings.TrimSpace(targetPath)
	if trimmed == "" || strings.EqualFold(filepath.Ext(trimmed), ".zip") {
		return trimmed
	}
	return trimmed + ".zip"
}

// writeDriverPackageArchive 以原子方式写出 zip：全程写同目录 .part 临时文件，
// 成功后 fsync + 改名，失败或中断则删除临时文件。
// ctx 取消会中断写入，abort 路径随即清掉临时文件，目标位置不留半成品。
func writeDriverPackageArchive(
	ctx context.Context,
	targetPath string,
	candidates []driverPackageExportCandidate,
	reporter *driverPackageExportReporter,
) (int64, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	// 保存对话框可能返回尚未创建的深层目录，先补齐再建临时文件。
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return 0, err
	}
	target, err := createAtomicExportTarget(targetPath)
	if err != nil {
		return 0, err
	}
	defer target.abort()

	archive := zip.NewWriter(target.file)
	// 固定压缩级别与条目时间戳，让二进制部分（二进制 + 支持文件 + 清单）可复现。
	// 级别取 Default 而非 BestCompression：后者为省约 1.2% 体积要多花约 25 倍时间
	// （实测 44MB 驱动：Default 0.38s/15.9MB vs Best 9.61s/15.7MB），导出因此长时间
	// 无响应。仓库既有的 xlsx 导出同样使用低压缩级别（xlsx_stream_writer.go 用 BestSpeed）。
	// 注意：清单里的 exportedAt 仍是导出时刻，因此整包字节不保证跨次一致 ——
	// 如需严格字节级复现，应把 exportedAt 也固定或改为可注入时钟。
	archive.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flate.DefaultCompression)
	})
	fixedTime := time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)

	if reporter != nil {
		reporter.Start()
	}
	written, err := writeDriverPackageEntries(ctx, archive, fixedTime, candidates, reporter)
	if err != nil {
		_ = archive.Close()
		return 0, err
	}
	if err := archive.Close(); err != nil {
		return 0, err
	}
	if err := target.commit(ctx); err != nil {
		return 0, err
	}
	return written, nil
}

func writeDriverPackageEntries(
	ctx context.Context,
	archive *zip.Writer,
	fixedTime time.Time,
	candidates []driverPackageExportCandidate,
	reporter *driverPackageExportReporter,
) (int64, error) {
	manifest := driverPackageManifest{
		Kind:          driverPackageKind,
		SchemaVersion: driverPackageSchemaVersion,
		ExportedAt:    time.Now().Format(time.RFC3339),
		AppVersion:    strings.TrimSpace(getCurrentVersion()),
		GOOS:          runtime.GOOS,
		GOARCH:        runtime.GOARCH,
		Drivers:       make([]driverPackageManifestEntryItem, 0, len(candidates)),
	}

	var total int64
	for _, candidate := range candidates {
		driverType := normalizeDriverType(candidate.definition.Type)
		if _, err := appendDriverPackageFile(ctx, archive, fixedTime, candidate.entryName, candidate.binaryPath, &total, driverType, reporter); err != nil {
			return 0, err
		}
		// 支持文件与 agent 同目录，才能命中导入侧的优先匹配。
		platformDir := filepath.ToSlash(filepath.Dir(candidate.entryName))
		for _, support := range candidate.supportFiles {
			if _, err := appendDriverPackageFile(ctx, archive, fixedTime, platformDir+"/"+support.name, support.path, &total, driverType, reporter); err != nil {
				return 0, err
			}
		}
		manifest.Drivers = append(manifest.Drivers, driverPackageManifestEntryItem{
			DriverType:    driverType,
			Version:       candidate.version,
			AgentRevision: candidate.agentRevision,
			SHA256:        candidate.sha256,
			Entry:         candidate.entryName,
		})
	}

	payload, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return 0, newLocalizedDriverBackendError("driver_manager.backend.error.package_manifest_encode_failed", nil, err)
	}
	header := &zip.FileHeader{Name: driverPackageManifestEntry, Method: zip.Deflate, Modified: fixedTime}
	entry, err := archive.CreateHeader(header)
	if err != nil {
		return 0, err
	}
	if _, err := entry.Write(payload); err != nil {
		return 0, err
	}
	return total, nil
}

// driverPackageProgressWriter 在写入途中累加字节数并上报，同时兼作取消检查点。
//
// 只在文件之间查 ctx 是不够的：单个驱动二进制可达数百 MB，取消会延迟到秒级。
// 这里每写一块就查一次，让取消立即生效。
type driverPackageProgressWriter struct {
	ctx        context.Context
	writer     io.Writer
	written    *int64
	driverType string
	reporter   *driverPackageExportReporter
}

func (w *driverPackageProgressWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := w.writer.Write(p)
	if n > 0 {
		*w.written += int64(n)
		if w.reporter != nil {
			w.reporter.Progress(*w.written, w.driverType)
		}
	}
	return n, err
}

// appendDriverPackageFile 把源文件写入 zip 条目，并把已写字节累加进 written。
func appendDriverPackageFile(
	ctx context.Context,
	archive *zip.Writer,
	fixedTime time.Time,
	entryName string,
	sourcePath string,
	written *int64,
	driverType string,
	reporter *driverPackageExportReporter,
) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return 0, fmt.Errorf("open %s: %w", filepath.Base(sourcePath), err)
	}
	defer source.Close()

	header := &zip.FileHeader{Name: entryName, Method: zip.Deflate, Modified: fixedTime}
	writer, err := archive.CreateHeader(header)
	if err != nil {
		return 0, err
	}

	before := *written
	target := &driverPackageProgressWriter{
		ctx:        ctx,
		writer:     writer,
		written:    written,
		driverType: driverType,
		reporter:   reporter,
	}
	if _, err := io.Copy(target, source); err != nil {
		return 0, err
	}
	return *written - before, nil
}
