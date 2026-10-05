package app

// 驱动包（ZIP / 7z）解析。
//
// 解析只读，返回包内可安装的驱动清单与本机状态（是否已装、revision/平台是否匹配），
// 不执行任何安装；真正的安装仍由 InstallLocalDriverPackage 逐个驱动完成。
//
// 导出侧（含条目布局约定与进度上报）见 methods_driver_package_export.go。

import (
	"encoding/json"
	"io"
	"path/filepath"
	"runtime"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

const (
	// driverPackageManifestEntry 是导出包内的清单条目名。既有导入路径只按目标
	// entry 名查找、忽略未知条目，因此该文件不会干扰单驱动导入。
	driverPackageManifestEntry = "gonavi-driver-package.json"
	driverPackageKind          = "gonavi_driver_package"
	driverPackageSchemaVersion = 1

	// 解析阶段的资源护栏：这是 zip bomb 的唯一防线，必须先于任何解压执行。
	driverPackageMaxEntryUncompressedBytes = 512 << 20 // 512 MiB
	driverPackageMaxTotalUncompressedBytes = 4 << 30   // 4 GiB
	driverPackageMaxCompressionRatio       = 50
)

// driverPackageManifest 是导出包内的元数据清单。
type driverPackageManifest struct {
	Kind          string                           `json:"kind"`
	SchemaVersion int                              `json:"schemaVersion"`
	ExportedAt    string                           `json:"exportedAt"`
	AppVersion    string                           `json:"appVersion,omitempty"`
	GOOS          string                           `json:"goos"`
	GOARCH        string                           `json:"goarch"`
	Drivers       []driverPackageManifestEntryItem `json:"drivers"`
}

type driverPackageManifestEntryItem struct {
	DriverType    string `json:"driverType"`
	Version       string `json:"version,omitempty"`
	AgentRevision string `json:"agentRevision,omitempty"`
	SHA256        string `json:"sha256,omitempty"`
	Entry         string `json:"entry"`
}

// driverPackageInspectItem 是解析结果里的单个驱动。
type driverPackageInspectItem struct {
	DriverType       string `json:"driverType"`
	DriverName       string `json:"driverName"`
	Version          string `json:"version,omitempty"`
	Entry            string `json:"entry"`
	GOOS             string `json:"goos,omitempty"`
	GOARCH           string `json:"goarch,omitempty"`
	Installed        bool   `json:"installed"`
	InstalledVersion string `json:"installedVersion,omitempty"`
	RevisionMismatch bool   `json:"revisionMismatch,omitempty"`
	PackageRevision  string `json:"packageRevision,omitempty"`
	ExpectedRevision string `json:"expectedRevision,omitempty"`
	PlatformMismatch bool   `json:"platformMismatch,omitempty"`
}

// InspectDriverPackage 解析驱动包（ZIP / 7z），返回包内可安装的驱动清单与本机状态，不做任何安装。
func (a *App) InspectDriverPackage(zipPath string, downloadDir string) connection.QueryResult {
	pathText := strings.TrimSpace(zipPath)
	if pathText == "" {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.package_open_failed", nil)}
	}
	if abs, err := filepath.Abs(pathText); err == nil {
		pathText = abs
	}

	resolvedDir, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	archive, err := openDriverPackageArchive(pathText)
	if err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("driver_manager.backend.error.package_open_failed", nil),
		}
	}
	defer archive.Close()

	if guardErr := guardDriverPackageEntries(archive.Entries); guardErr != nil {
		return connection.QueryResult{Success: false, Message: localizedDriverBackendErrorMessage(a, guardErr)}
	}

	manifest, manifestErr := readDriverPackageManifest(archive.Entries)
	items := buildDriverPackageInspectItems(a, archive.Entries, manifest, manifestErr, resolvedDir)
	if len(items) == 0 {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("driver_manager.backend.error.package_empty", nil),
		}
	}

	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"path":            pathText,
			"manifestPresent": manifestErr == nil && manifest != nil,
			"drivers":         items,
		},
	}
}

// guardDriverPackageEntries 在解压任何条目之前检查体积（ZIP 另查压缩比），
// 阻止 zip bomb 把磁盘或内存打满。
func guardDriverPackageEntries(entries []*driverPackageArchiveEntry) error {
	var total uint64
	for _, entry := range entries {
		if err := entry.guard(); err != nil {
			return err
		}
		if total > driverPackageMaxTotalUncompressedBytes ||
			entry.UncompressedSize > driverPackageMaxTotalUncompressedBytes-total {
			return newLocalizedDriverBackendError("driver_manager.backend.error.package_entry_limit_exceeded", map[string]any{
				"name": entry.Name,
			}, nil)
		}
		total += entry.UncompressedSize
	}
	return nil
}

// readDriverPackageManifest 读取可选清单；包内没有清单时返回 (nil, nil)。
func readDriverPackageManifest(entries []*driverPackageArchiveEntry) (*driverPackageManifest, error) {
	for _, file := range entries {
		name := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(file.Name), "./"))
		if !strings.EqualFold(name, driverPackageManifestEntry) {
			continue
		}
		payload, err := readDriverPackageEntry(file, driverPackageMaxEntryUncompressedBytes)
		if err != nil {
			return nil, newLocalizedDriverBackendError("driver_manager.backend.error.package_manifest_parse_failed", nil, err)
		}
		var manifest driverPackageManifest
		if err := json.Unmarshal(payload, &manifest); err != nil {
			return nil, newLocalizedDriverBackendError("driver_manager.backend.error.package_manifest_parse_failed", nil, err)
		}
		if !strings.EqualFold(strings.TrimSpace(manifest.Kind), driverPackageKind) {
			return nil, newLocalizedDriverBackendError("driver_manager.backend.error.package_manifest_parse_failed", nil, nil)
		}
		return &manifest, nil
	}
	return nil, nil
}

func readDriverPackageEntry(file *driverPackageArchiveEntry, limit uint64) ([]byte, error) {
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	if limit == 0 {
		return io.ReadAll(reader)
	}
	return io.ReadAll(io.LimitReader(reader, int64(limit)+1))
}

// buildDriverPackageInspectItems 汇总解析结果：优先信任包内清单，缺失时回退到条目名反解。
func buildDriverPackageInspectItems(a *App, files []*driverPackageArchiveEntry, manifest *driverPackageManifest, manifestErr error, resolvedDir string) []driverPackageInspectItem {
	if manifestErr == nil && manifest != nil && len(manifest.Drivers) > 0 {
		return buildDriverPackageItemsFromManifest(a, files, manifest, resolvedDir)
	}
	return buildDriverPackageItemsFromEntries(a, files, resolvedDir)
}

func buildDriverPackageItemsFromManifest(a *App, files []*driverPackageArchiveEntry, manifest *driverPackageManifest, resolvedDir string) []driverPackageInspectItem {
	available := make(map[string]struct{}, len(files))
	for _, file := range files {
		available[normalizeDriverPackageEntryName(file.Name)] = struct{}{}
	}

	items := make([]driverPackageInspectItem, 0, len(manifest.Drivers))
	seen := make(map[string]struct{}, len(manifest.Drivers))
	for _, record := range manifest.Drivers {
		driverType := normalizeDriverType(record.DriverType)
		if driverType == "" || !db.IsOptionalGoDriver(driverType) {
			continue
		}
		if _, duplicated := seen[driverType]; duplicated {
			continue
		}
		entry := normalizeDriverPackageEntryName(record.Entry)
		if _, ok := available[entry]; !ok {
			continue
		}
		seen[driverType] = struct{}{}
		item := newDriverPackageInspectItem(driverType, entry)
		item.Version = strings.TrimSpace(record.Version)
		item.PackageRevision = strings.TrimSpace(record.AgentRevision)
		applyDriverPackageHostState(&item, resolvedDir)
		applyDriverPackageRevisionState(&item)
		items = append(items, item)
	}
	return items
}

// buildDriverPackageItemsFromEntries 回退路径：从条目名反解驱动类型。
//
// 这里刻意不使用 optionalDriverBundleEntryPathsForVersion —— 该函数内部绑定
// stdRuntime.GOOS/GOARCH，只能生成宿主平台路径，在 macOS 上解析 Windows 导出的包
// 会永远匹配不到 Windows/... 条目。改为平台无关的 basename 反解。
func buildDriverPackageItemsFromEntries(a *App, files []*driverPackageArchiveEntry, resolvedDir string) []driverPackageInspectItem {
	items := make([]driverPackageInspectItem, 0, 8)
	seen := make(map[string]struct{}, 8)
	for _, file := range files {
		entryName := normalizeDriverPackageEntryName(file.Name)
		if entryName == "" || strings.HasSuffix(entryName, "/") {
			continue
		}
		stem, goos, goarch, ok := parseDriverPackageEntryName(entryName)
		if !ok {
			continue
		}
		driverType, version := resolveDriverTypeForPackageStem(stem, resolvedDir)
		if driverType == "" {
			continue
		}
		if _, duplicated := seen[driverType]; duplicated {
			continue
		}
		seen[driverType] = struct{}{}
		item := newDriverPackageInspectItem(driverType, entryName)
		item.Version = version
		item.GOOS = goos
		item.GOARCH = goarch
		applyDriverPackageHostState(&item, resolvedDir)
		applyDriverPackageRevisionState(&item)
		items = append(items, item)
	}
	return items
}

func newDriverPackageInspectItem(driverType string, entryName string) driverPackageInspectItem {
	definition, _ := resolveDriverDefinition(driverType)
	return driverPackageInspectItem{
		DriverType: driverType,
		DriverName: resolveDriverDisplayName(definition),
		Entry:      entryName,
	}
}

// applyDriverPackageHostState 标注本机是否已安装该驱动，以及包内平台是否与宿主一致。
func applyDriverPackageHostState(item *driverPackageInspectItem, resolvedDir string) {
	if pkg, ok := readInstalledDriverPackage(resolvedDir, item.DriverType); ok {
		item.Installed = true
		item.InstalledVersion = strings.TrimSpace(pkg.Version)
	}
	if strings.TrimSpace(item.GOOS) == "" {
		return
	}
	item.PlatformMismatch = !strings.EqualFold(item.GOOS, runtime.GOOS) ||
		!strings.EqualFold(item.GOARCH, runtime.GOARCH)
}

// applyDriverPackageRevisionState 标注包内 revision 与当前构建期望是否一致。
// 校验本身不放松：这里只是把失败提前到解析阶段展示。
func applyDriverPackageRevisionState(item *driverPackageInspectItem) {
	expected := strings.TrimSpace(db.OptionalDriverAgentRevision(item.DriverType))
	item.ExpectedRevision = expected
	if expected == "" || !shouldVerifyOptionalDriverAgentRevision(item.DriverType, item.Version) {
		return
	}
	pkgRevision := strings.TrimSpace(item.PackageRevision)
	if pkgRevision == "" {
		// 无清单的包无从提前判定，交给安装时的实际探测。
		return
	}
	item.RevisionMismatch = pkgRevision != expected
}

func normalizeDriverPackageEntryName(name string) string {
	return filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(name), "./"))
}

// parseDriverPackageEntryName 从条目名反解平台与 stem：
// {Platform}/{stem}-{goos}-{goarch}[.exe] → stem, goos, goarch。
func parseDriverPackageEntryName(entryName string) (string, string, string, bool) {
	base := filepath.Base(entryName)
	if strings.EqualFold(filepath.Ext(base), ".exe") {
		base = base[:len(base)-len(filepath.Ext(base))]
	}
	parts := strings.Split(base, "-")
	if len(parts) < 3 {
		return "", "", "", false
	}
	goarch := strings.ToLower(parts[len(parts)-1])
	goos := strings.ToLower(parts[len(parts)-2])
	if !isKnownDriverPackagePlatform(goos, goarch) {
		return "", "", "", false
	}
	stem := strings.TrimSuffix(strings.Join(parts[:len(parts)-2], "-"), "-")
	if stem == "" {
		return "", "", "", false
	}
	return stem, goos, goarch, true
}

func isKnownDriverPackagePlatform(goos string, goarch string) bool {
	switch goos {
	case "windows", "darwin", "linux":
	default:
		return false
	}
	switch goarch {
	case "amd64", "arm64", "386":
		return true
	default:
		return false
	}
}

// resolveDriverTypeForPackageStem 把包内 stem 还原为驱动类型。
// stem 候选由 optionalDriverNameStemCandidates 生成（平台无关，含 mongodb v1/v2 分支）。
func resolveDriverTypeForPackageStem(stem string, resolvedDir string) (string, string) {
	target := strings.ToLower(strings.TrimSpace(stem))
	if target == "" {
		return "", ""
	}
	for _, definition := range allDriverDefinitionsWithPackages(nil) {
		driverType := normalizeDriverType(definition.Type)
		if definition.BuiltIn || !db.IsOptionalGoDriver(driverType) {
			continue
		}
		for _, version := range driverPackageVersionCandidates(driverType, definition, resolvedDir) {
			for _, candidate := range optionalDriverNameStemCandidates(driverType, version) {
				if strings.EqualFold(strings.TrimSpace(candidate), target) {
					return driverType, strings.TrimSpace(version)
				}
			}
		}
	}
	return "", ""
}

// driverPackageVersionCandidates 覆盖 mongodb 两种主版本形态：空版本只产出
// -v2/无后缀 stem，必须补上 pinned（1.17.9）才能命中 -v1 条目。
func driverPackageVersionCandidates(driverType string, definition driverDefinition, resolvedDir string) []string {
	candidates := make([]string, 0, 3)
	seen := make(map[string]struct{}, 3)
	appendVersion := func(version string) {
		trimmed := strings.TrimSpace(version)
		if _, ok := seen[trimmed]; ok {
			return
		}
		seen[trimmed] = struct{}{}
		candidates = append(candidates, trimmed)
	}
	appendVersion("")
	appendVersion(definition.PinnedVersion)
	if pkg, ok := readInstalledDriverPackage(resolvedDir, driverType); ok {
		appendVersion(pkg.Version)
	}
	return candidates
}
