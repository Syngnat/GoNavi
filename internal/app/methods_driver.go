package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type driverDefinition struct {
	Type               string `json:"type"`
	Name               string `json:"name"`
	Engine             string `json:"engine,omitempty"`
	BuiltIn            bool   `json:"builtIn"`
	PinnedVersion      string `json:"pinnedVersion,omitempty"`
	DefaultDownloadURL string `json:"defaultDownloadUrl,omitempty"`
	DownloadSHA256     string `json:"downloadSha256,omitempty"`
	ChecksumPolicy     string `json:"checksumPolicy,omitempty"`
}

type installedDriverPackage struct {
	DriverType     string `json:"driverType"`
	FilePath       string `json:"filePath"`
	FileName       string `json:"fileName"`
	ExecutablePath string `json:"executablePath,omitempty"`
	DownloadURL    string `json:"downloadUrl,omitempty"`
	SHA256         string `json:"sha256,omitempty"`
	DownloadedAt   string `json:"downloadedAt"`
}

type driverStatusItem struct {
	Type               string `json:"type"`
	Name               string `json:"name"`
	Engine             string `json:"engine,omitempty"`
	BuiltIn            bool   `json:"builtIn"`
	PinnedVersion      string `json:"pinnedVersion,omitempty"`
	PackageSizeText    string `json:"packageSizeText,omitempty"`
	RuntimeAvailable   bool   `json:"runtimeAvailable"`
	PackageInstalled   bool   `json:"packageInstalled"`
	Connectable        bool   `json:"connectable"`
	DefaultDownloadURL string `json:"defaultDownloadUrl,omitempty"`
	InstallDir         string `json:"installDir,omitempty"`
	PackagePath        string `json:"packagePath,omitempty"`
	PackageFileName    string `json:"packageFileName,omitempty"`
	ExecutablePath     string `json:"executablePath,omitempty"`
	DownloadedAt       string `json:"downloadedAt,omitempty"`
	Message            string `json:"message,omitempty"`
}

const driverDownloadProgressEvent = "driver:download-progress"

type driverDownloadProgressPayload struct {
	DriverType string  `json:"driverType"`
	Status     string  `json:"status"`
	Percent    float64 `json:"percent"`
	Downloaded int64   `json:"downloaded"`
	Total      int64   `json:"total"`
	Message    string  `json:"message,omitempty"`
}

type pinnedDriverPackage struct {
	Version     string
	DownloadURL string
	SHA256      string
	Policy      string
	Engine      string
}

type driverManifestFile struct {
	Engine         string                        `json:"engine"`
	DefaultEngine  string                        `json:"defaultEngine"`
	DefaultEngine2 string                        `json:"default_engine"`
	Drivers        map[string]driverManifestItem `json:"drivers"`
}

type driverManifestItem struct {
	Version         string `json:"version"`
	DownloadURL     string `json:"downloadUrl"`
	DownloadURL2    string `json:"download_url"`
	SHA256          string `json:"sha256"`
	ChecksumPolicy  string `json:"checksumPolicy"`
	ChecksumPolicy2 string `json:"checksum_policy"`
	Engine          string `json:"engine"`
}

type driverManifestCacheEntry struct {
	LoadedAt time.Time
	Packages map[string]pinnedDriverPackage
	Err      string
}

type driverReleaseAssetSizeCacheEntry struct {
	LoadedAt  time.Time
	SizeByKey map[string]int64
	Err       string
}

const (
	// 默认使用内置 manifest，避免依赖网络与外部仓库 404。
	defaultDriverManifestURLValue       = "builtin://manifest"
	driverManifestCacheTTL              = 5 * time.Minute
	driverReleaseAssetSizeCacheTTL      = 30 * time.Minute
	driverReleaseAssetSizeErrorCacheTTL = 30 * time.Second
	driverReleaseAssetSizeProbeTimeout  = 4 * time.Second
	driverManifestMaxSize               = 2 << 20
	driverChecksumPolicyStrict          = "strict"
	driverChecksumPolicyWarn            = "warn"
	driverChecksumPolicyOff             = "off"
	driverEngineGo                      = "go"
	driverEngineExternal                = "external"
)

const builtinDriverManifestJSON = `{
  "engine": "go",
  "drivers": {
    "mysql":     { "engine": "go", "version": "go-embedded", "checksumPolicy": "off" },
    "mariadb":   { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/mariadb" },
    "diros":     { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/diros" },
    "sphinx":    { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/sphinx" },
    "sqlserver": { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/sqlserver" },
    "sqlite":    { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/sqlite" },
    "duckdb":    { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/duckdb" },
    "dameng":    { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/dameng" },
    "kingbase":  { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/kingbase" },
    "highgo":    { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/highgo" },
    "vastbase":  { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/vastbase" },
    "mongodb":   { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/mongodb" },
    "tdengine":  { "engine": "go", "version": "go-embedded", "checksumPolicy": "off", "downloadUrl": "builtin://activate/tdengine" }
  }
}`

var (
	driverManifestCacheMu sync.RWMutex
	driverManifestCache   = make(map[string]driverManifestCacheEntry)
	driverReleaseSizeMu   sync.RWMutex
	driverReleaseSizeMap  = make(map[string]driverReleaseAssetSizeCacheEntry)
)

var pinnedDriverPackageMap = map[string]pinnedDriverPackage{
	"postgres": {
		Version: "go-embedded",
		Policy:  driverChecksumPolicyOff,
		Engine:  driverEngineGo,
	},
}

func (a *App) SelectDriverDownloadDirectory(currentDir string) connection.QueryResult {
	defaultDir := strings.TrimSpace(currentDir)
	if defaultDir == "" {
		defaultDir = defaultDriverDownloadDirectory()
	} else if !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}

	selection, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                "选择驱动下载目录",
		DefaultDirectory:     defaultDir,
		CanCreateDirectories: true,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}

	resolved, err := resolveDriverDownloadDirectory(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"path":          resolved,
			"defaultPath":   defaultDriverDownloadDirectory(),
			"isDefaultPath": false,
		},
	}
}

func (a *App) SelectDriverPackageFile(currentPath string) connection.QueryResult {
	defaultDir := strings.TrimSpace(currentPath)
	if defaultDir == "" {
		defaultDir = defaultDriverDownloadDirectory()
	}
	if filepath.Ext(defaultDir) != "" {
		defaultDir = filepath.Dir(defaultDir)
	}
	if !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}

	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "选择驱动包文件",
		DefaultDirectory: defaultDir,
		Filters: []runtime.FileFilter{
			{DisplayName: "所有文件", Pattern: "*"},
		},
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}

	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

func (a *App) ResolveDriverDownloadDirectory(directory string) connection.QueryResult {
	resolved, err := resolveDriverDownloadDirectory(directory)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": resolved}}
}

func (a *App) ConfigureDriverRuntimeDirectory(directory string) connection.QueryResult {
	resolved, err := resolveDriverDownloadDirectory(directory)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	db.SetExternalDriverDownloadDirectory(resolved)
	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"path":          resolved,
			"defaultPath":   defaultDriverDownloadDirectory(),
			"isDefaultPath": strings.TrimSpace(directory) == "",
		},
		Message: "驱动运行时目录已生效",
	}
}

func (a *App) ResolveDriverRepositoryURL(repositoryURL string) connection.QueryResult {
	resolved, err := resolveDriverRepositoryURL(repositoryURL)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"url": resolved}}
}

func (a *App) ResolveDriverPackageDownloadURL(driverType string, repositoryURL string) connection.QueryResult {
	effectivePackages, manifestErr := resolveEffectiveDriverPackages(repositoryURL)
	definition, ok := resolveDriverDefinitionWithPackages(driverType, effectivePackages)
	if !ok {
		return connection.QueryResult{Success: false, Message: "不支持的驱动类型"}
	}
	engine := effectiveDriverEngine(definition)
	if definition.BuiltIn {
		return connection.QueryResult{Success: false, Message: "内置驱动无需下载扩展包"}
	}
	if err := ensureOptionalDriverBuildAvailable(definition); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if engine == driverEngineGo && !definition.BuiltIn {
		urlText := strings.TrimSpace(definition.DefaultDownloadURL)
		if urlText == "" {
			urlText = fmt.Sprintf("builtin://activate/%s", definition.Type)
		}
		data := map[string]interface{}{
			"url":           urlText,
			"driverType":    definition.Type,
			"driverName":    definition.Name,
			"engine":        engine,
			"manifestError": errorMessage(manifestErr),
		}
		if strings.TrimSpace(definition.DownloadSHA256) != "" {
			data["sha256"] = strings.TrimSpace(definition.DownloadSHA256)
		}
		return connection.QueryResult{Success: true, Data: data}
	}
	return connection.QueryResult{Success: false, Message: "当前仅支持纯 Go 可选驱动的安装启用"}
}

func (a *App) GetDriverStatusList(downloadDir string, manifestURL string) connection.QueryResult {
	resolvedDir, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	db.SetExternalDriverDownloadDirectory(resolvedDir)

	effectivePackages, manifestErr := resolveEffectiveDriverPackages(manifestURL)
	definitions := allDriverDefinitionsWithPackages(effectivePackages)
	packageSizeBytesMap := preloadOptionalDriverPackageSizes(definitions)
	items := make([]driverStatusItem, 0, len(definitions))
	for _, definition := range definitions {
		engine := effectiveDriverEngine(definition)
		runtimeAvailable, runtimeReason := db.DriverRuntimeSupportStatus(definition.Type)
		pkg, packageMetaExists := readInstalledDriverPackage(resolvedDir, definition.Type)
		packageInstalled := definition.BuiltIn || packageMetaExists
		if runtimeAvailable && db.IsOptionalGoDriver(definition.Type) {
			packageInstalled = true
		}

		item := driverStatusItem{
			Type:               definition.Type,
			Name:               definition.Name,
			Engine:             engine,
			BuiltIn:            definition.BuiltIn,
			PinnedVersion:      definition.PinnedVersion,
			PackageSizeText:    resolveDriverPackageSizeText(definition, pkg, packageMetaExists, packageSizeBytesMap),
			RuntimeAvailable:   runtimeAvailable,
			PackageInstalled:   packageInstalled,
			Connectable:        runtimeAvailable,
			DefaultDownloadURL: definition.DefaultDownloadURL,
			InstallDir:         driverInstallDir(resolvedDir, definition.Type),
		}
		if packageMetaExists {
			item.PackagePath = pkg.FilePath
			item.PackageFileName = pkg.FileName
			item.DownloadedAt = pkg.DownloadedAt
			item.ExecutablePath = pkg.ExecutablePath
		}

		switch {
		case definition.BuiltIn:
			item.Message = "内置驱动，可直接连接"
		case runtimeAvailable:
			item.Message = "纯 Go 驱动已启用，可直接连接"
		case packageInstalled && strings.TrimSpace(runtimeReason) != "":
			item.Message = runtimeReason
		case packageInstalled:
			item.Message = "驱动已安装，待生效"
		case strings.TrimSpace(runtimeReason) != "":
			item.Message = runtimeReason
		default:
			if strings.TrimSpace(definition.PinnedVersion) != "" {
				item.Message = fmt.Sprintf("未启用（版本：%s）", strings.TrimSpace(definition.PinnedVersion))
			} else {
				item.Message = "未启用"
			}
		}

		items = append(items, item)
	}

	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"downloadDir":   resolvedDir,
			"drivers":       items,
			"manifestURL":   resolveManifestURLForView(manifestURL),
			"manifestError": errorMessage(manifestErr),
		},
	}
}

func (a *App) InstallLocalDriverPackage(driverType string, filePath string, downloadDir string) connection.QueryResult {
	definition, ok := resolveDriverDefinition(driverType)
	if !ok {
		return connection.QueryResult{Success: false, Message: "不支持的驱动类型"}
	}
	if definition.BuiltIn {
		return connection.QueryResult{Success: false, Message: "内置驱动无需安装扩展包"}
	}
	if err := ensureOptionalDriverBuildAvailable(definition); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	engine := effectiveDriverEngine(definition)
	if !(engine == driverEngineGo && !definition.BuiltIn) {
		return connection.QueryResult{Success: false, Message: "当前仅支持纯 Go 可选驱动的安装启用"}
	}

	resolvedDir, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	db.SetExternalDriverDownloadDirectory(resolvedDir)

	hash := ""
	if pathText := strings.TrimSpace(filePath); pathText != "" {
		if fileHash, hashErr := hashFileSHA256(pathText); hashErr == nil {
			hash = fileHash
		}
	}

	a.emitDriverDownloadProgress(definition.Type, "start", 0, 0, "开始安装")
	meta := installedDriverPackage{
		DriverType:   definition.Type,
		FilePath:     "",
		FileName:     "embedded-go-driver",
		DownloadURL:  "local://activate",
		SHA256:       hash,
		DownloadedAt: time.Now().Format(time.RFC3339),
	}
	if err := writeInstalledDriverPackage(resolvedDir, definition.Type, meta); err != nil {
		a.emitDriverDownloadProgress(definition.Type, "error", 0, 0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	a.emitDriverDownloadProgress(definition.Type, "done", 1, 1, "安装完成（纯 Go 驱动已启用）")

	return connection.QueryResult{Success: true, Message: "驱动安装成功", Data: map[string]interface{}{
		"driverType": definition.Type,
		"driverName": definition.Name,
		"engine":     engine,
	}}
}

func (a *App) DownloadDriverPackage(driverType string, downloadURL string, downloadDir string) connection.QueryResult {
	definition, ok := resolveDriverDefinition(driverType)
	if !ok {
		return connection.QueryResult{Success: false, Message: "不支持的驱动类型"}
	}
	engine := effectiveDriverEngine(definition)
	if definition.BuiltIn {
		return connection.QueryResult{Success: false, Message: "内置驱动无需下载扩展包"}
	}
	if err := ensureOptionalDriverBuildAvailable(definition); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if !(engine == driverEngineGo && !definition.BuiltIn) {
		return connection.QueryResult{Success: false, Message: "当前仅支持纯 Go 可选驱动的安装启用"}
	}

	urlText := strings.TrimSpace(downloadURL)
	if urlText == "" {
		urlText = strings.TrimSpace(definition.DefaultDownloadURL)
	}
	if urlText == "" {
		urlText = fmt.Sprintf("builtin://activate/%s", definition.Type)
	}

	resolvedDir, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	db.SetExternalDriverDownloadDirectory(resolvedDir)

	if db.IsOptionalGoDriver(definition.Type) {
		displayName := strings.TrimSpace(definition.Name)
		if displayName == "" {
			displayName = strings.TrimSpace(definition.Type)
		}
		a.emitDriverDownloadProgress(definition.Type, "start", 0, 100, fmt.Sprintf("开始安装 %s 驱动代理", displayName))
		meta, installErr := installOptionalDriverAgentPackage(a, definition, resolvedDir, urlText)
		if installErr != nil {
			a.emitDriverDownloadProgress(definition.Type, "error", 0, 0, installErr.Error())
			return connection.QueryResult{Success: false, Message: installErr.Error()}
		}
		a.emitDriverDownloadProgress(definition.Type, "downloading", 95, 100, "写入驱动元数据")
		if writeErr := writeInstalledDriverPackage(resolvedDir, definition.Type, meta); writeErr != nil {
			a.emitDriverDownloadProgress(definition.Type, "error", 0, 0, writeErr.Error())
			return connection.QueryResult{Success: false, Message: writeErr.Error()}
		}
		a.emitDriverDownloadProgress(definition.Type, "done", 100, 100, fmt.Sprintf("%s 驱动代理安装完成", displayName))
		return connection.QueryResult{Success: true, Message: "驱动安装成功", Data: map[string]interface{}{
			"driverType": definition.Type,
			"driverName": definition.Name,
			"engine":     engine,
		}}
	}

	a.emitDriverDownloadProgress(definition.Type, "start", 0, 0, "开始安装")
	meta := installedDriverPackage{
		DriverType:   definition.Type,
		FilePath:     "",
		FileName:     "embedded-go-driver",
		DownloadURL:  urlText,
		SHA256:       "",
		DownloadedAt: time.Now().Format(time.RFC3339),
	}
	if err := writeInstalledDriverPackage(resolvedDir, definition.Type, meta); err != nil {
		a.emitDriverDownloadProgress(definition.Type, "error", 0, 0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	a.emitDriverDownloadProgress(definition.Type, "done", 1, 1, "安装完成（纯 Go 驱动已启用）")

	return connection.QueryResult{Success: true, Message: "驱动安装成功", Data: map[string]interface{}{
		"driverType": definition.Type,
		"driverName": definition.Name,
		"engine":     engine,
	}}
}

func (a *App) RemoveDriverPackage(driverType string, downloadDir string) connection.QueryResult {
	definition, ok := resolveDriverDefinition(driverType)
	if !ok {
		return connection.QueryResult{Success: false, Message: "不支持的驱动类型"}
	}
	if definition.BuiltIn {
		return connection.QueryResult{Success: false, Message: "内置驱动不可移除"}
	}

	resolvedDir, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	db.SetExternalDriverDownloadDirectory(resolvedDir)

	driverDir := driverInstallDir(resolvedDir, definition.Type)
	if err := os.RemoveAll(driverDir); err != nil {
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("移除驱动包失败：%v", err)}
	}

	return connection.QueryResult{Success: true, Message: "驱动包已移除", Data: map[string]interface{}{
		"driverType": definition.Type,
		"driverName": definition.Name,
	}}
}

func (a *App) emitDriverDownloadProgress(driverType string, status string, downloaded, total int64, message string) {
	if a.ctx == nil {
		return
	}
	payload := driverDownloadProgressPayload{
		DriverType: normalizeDriverType(driverType),
		Status:     strings.TrimSpace(status),
		Percent:    0,
		Downloaded: downloaded,
		Total:      total,
		Message:    strings.TrimSpace(message),
	}
	if payload.DriverType == "" {
		payload.DriverType = "unknown"
	}
	if payload.Status == "" {
		payload.Status = "downloading"
	}
	if total > 0 {
		payload.Percent = (float64(downloaded) / float64(total)) * 100
		if payload.Percent < 0 {
			payload.Percent = 0
		}
		if payload.Percent > 100 {
			payload.Percent = 100
		}
	}
	if payload.Status == "done" && payload.Percent < 100 {
		payload.Percent = 100
	}
	runtime.EventsEmit(a.ctx, driverDownloadProgressEvent, payload)
}

func defaultDriverDownloadDirectory() string {
	root, err := db.ResolveExternalDriverRoot("")
	if err == nil && strings.TrimSpace(root) != "" {
		return root
	}
	return filepath.Join(os.TempDir(), "gonavi-drivers")
}

func resolveDriverDownloadDirectory(directory string) (string, error) {
	return db.ResolveExternalDriverRoot(directory)
}

func normalizeDriverType(driverType string) string {
	normalized := strings.ToLower(strings.TrimSpace(driverType))
	switch normalized {
	case "doris":
		return "diros"
	case "postgresql":
		return "postgres"
	default:
		return normalized
	}
}

func normalizeDriverEngine(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case driverEngineGo:
		return driverEngineGo
	case "jdbc":
		return driverEngineExternal
	case driverEngineExternal, "exec", "binary":
		return driverEngineExternal
	default:
		return ""
	}
}

func normalizeDriverChecksumPolicy(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case driverChecksumPolicyStrict:
		return driverChecksumPolicyStrict
	case driverChecksumPolicyOff:
		return driverChecksumPolicyOff
	case driverChecksumPolicyWarn:
		return driverChecksumPolicyWarn
	default:
		return driverChecksumPolicyWarn
	}
}

func effectiveDriverEngine(definition driverDefinition) string {
	if definition.BuiltIn {
		return driverEngineGo
	}
	engine := normalizeDriverEngine(definition.Engine)
	if engine == "" {
		return driverEngineExternal
	}
	return engine
}

func resolveDriverDefinition(driverType string) (driverDefinition, bool) {
	return resolveDriverDefinitionWithPackages(driverType, nil)
}

func resolveDriverDefinitionWithPackages(driverType string, packages map[string]pinnedDriverPackage) (driverDefinition, bool) {
	normalized := normalizeDriverType(driverType)
	for _, definition := range allDriverDefinitionsWithPackages(packages) {
		if normalizeDriverType(definition.Type) == normalized {
			return definition, true
		}
	}
	return driverDefinition{}, false
}

func allDriverDefinitionsWithPackages(packages map[string]pinnedDriverPackage) []driverDefinition {
	return []driverDefinition{
		{Type: "mysql", Name: "MySQL", Engine: driverEngineGo, BuiltIn: true},
		{Type: "oracle", Name: "Oracle", Engine: driverEngineGo, BuiltIn: true},
		{Type: "redis", Name: "Redis", Engine: driverEngineGo, BuiltIn: true},
		{Type: "postgres", Name: "PostgreSQL", Engine: driverEngineGo, BuiltIn: true},

		// 其他数据源需要先在驱动管理中“安装启用”。
		buildOptionalGoDriverDefinition("mariadb", "MariaDB", packages),
		buildOptionalGoDriverDefinition("diros", "Diros", packages),
		buildOptionalGoDriverDefinition("sphinx", "Sphinx", packages),
		buildOptionalGoDriverDefinition("sqlserver", "SQL Server", packages),
		buildOptionalGoDriverDefinition("sqlite", "SQLite", packages),
		buildOptionalGoDriverDefinition("duckdb", "DuckDB", packages),
		buildOptionalGoDriverDefinition("dameng", "Dameng", packages),
		buildOptionalGoDriverDefinition("kingbase", "Kingbase", packages),
		buildOptionalGoDriverDefinition("highgo", "HighGo", packages),
		buildOptionalGoDriverDefinition("vastbase", "Vastbase", packages),
		buildOptionalGoDriverDefinition("mongodb", "MongoDB", packages),
		buildOptionalGoDriverDefinition("tdengine", "TDengine", packages),
	}
}

func buildOptionalGoDriverDefinition(driverType string, driverName string, packages map[string]pinnedDriverPackage) driverDefinition {
	spec := resolvedPinnedPackage(driverType, packages)
	return driverDefinition{
		Type:               normalizeDriverType(driverType),
		Name:               driverName,
		Engine:             driverEngineGo,
		BuiltIn:            false,
		PinnedVersion:      strings.TrimSpace(spec.Version),
		DefaultDownloadURL: strings.TrimSpace(spec.DownloadURL),
		DownloadSHA256:     strings.TrimSpace(spec.SHA256),
		ChecksumPolicy:     normalizeDriverChecksumPolicy(spec.Policy),
	}
}

func ensureOptionalDriverBuildAvailable(definition driverDefinition) error {
	driverType := normalizeDriverType(definition.Type)
	if !db.IsOptionalGoDriver(driverType) {
		return nil
	}
	if db.IsOptionalGoDriverBuildIncluded(driverType) {
		return nil
	}
	driverName := strings.TrimSpace(definition.Name)
	if driverName == "" {
		driverName = strings.TrimSpace(definition.Type)
	}
	return fmt.Errorf("%s 当前发行包为精简构建，未内置该驱动；如需使用请安装 Full 版", driverName)
}

func driverPinnedPackage(driverType string) pinnedDriverPackage {
	spec, ok := pinnedDriverPackageMap[normalizeDriverType(driverType)]
	if !ok {
		return pinnedDriverPackage{}
	}
	spec.Version = strings.TrimSpace(spec.Version)
	spec.DownloadURL = strings.TrimSpace(spec.DownloadURL)
	spec.SHA256 = strings.TrimSpace(spec.SHA256)
	spec.Policy = normalizeDriverChecksumPolicy(spec.Policy)
	spec.Engine = normalizeDriverEngine(spec.Engine)
	return spec
}

func resolvedPinnedPackage(driverType string, packages map[string]pinnedDriverPackage) pinnedDriverPackage {
	normalizedType := normalizeDriverType(driverType)
	spec := driverPinnedPackage(normalizedType)
	if packages != nil {
		override, ok := packages[normalizedType]
		if ok {
			if strings.TrimSpace(override.Version) != "" {
				spec.Version = strings.TrimSpace(override.Version)
			}
			if strings.TrimSpace(override.DownloadURL) != "" {
				spec.DownloadURL = strings.TrimSpace(override.DownloadURL)
			}
			if strings.TrimSpace(override.SHA256) != "" {
				spec.SHA256 = strings.TrimSpace(override.SHA256)
			}
			if strings.TrimSpace(override.Policy) != "" {
				spec.Policy = normalizeDriverChecksumPolicy(override.Policy)
			}
			if strings.TrimSpace(override.Engine) != "" {
				spec.Engine = normalizeDriverEngine(override.Engine)
			}
		}
	}
	if normalizedType == "postgres" {
		spec.Engine = driverEngineGo
		if strings.TrimSpace(spec.Version) == "" {
			spec.Version = "go-embedded"
		}
		if strings.TrimSpace(spec.Policy) == "" {
			spec.Policy = driverChecksumPolicyOff
		}
	}
	return spec
}

func copyPinnedPackageMap(source map[string]pinnedDriverPackage) map[string]pinnedDriverPackage {
	if len(source) == 0 {
		return map[string]pinnedDriverPackage{}
	}
	result := make(map[string]pinnedDriverPackage, len(source))
	for key, value := range source {
		result[key] = pinnedDriverPackage{
			Version:     strings.TrimSpace(value.Version),
			DownloadURL: strings.TrimSpace(value.DownloadURL),
			SHA256:      strings.TrimSpace(value.SHA256),
			Policy:      normalizeDriverChecksumPolicy(value.Policy),
			Engine:      normalizeDriverEngine(value.Engine),
		}
	}
	return result
}

func resolveEffectiveDriverPackages(manifestURL string) (map[string]pinnedDriverPackage, error) {
	effective := copyPinnedPackageMap(pinnedDriverPackageMap)
	manifestPackages, err := resolveManifestDriverPackages(manifestURL)
	if err != nil {
		return effective, err
	}
	for driverType, item := range manifestPackages {
		normalizedType := normalizeDriverType(driverType)
		base := effective[normalizedType]
		if strings.TrimSpace(item.Version) != "" {
			base.Version = strings.TrimSpace(item.Version)
		}
		if strings.TrimSpace(item.DownloadURL) != "" {
			base.DownloadURL = strings.TrimSpace(item.DownloadURL)
		}
		if strings.TrimSpace(item.SHA256) != "" {
			base.SHA256 = strings.TrimSpace(item.SHA256)
		}
		if strings.TrimSpace(item.Policy) != "" {
			base.Policy = normalizeDriverChecksumPolicy(item.Policy)
		}
		if strings.TrimSpace(item.Engine) != "" {
			base.Engine = normalizeDriverEngine(item.Engine)
		}
		effective[normalizedType] = base
	}
	return effective, nil
}

func resolveDriverRepositoryURL(repositoryURL string) (string, error) {
	urlText := strings.TrimSpace(repositoryURL)
	if urlText == "" {
		return defaultDriverManifestURLValue, nil
	}
	parsed, err := url.Parse(urlText)
	if err == nil && parsed.Scheme != "" {
		switch strings.ToLower(parsed.Scheme) {
		case "http", "https":
			return parsed.String(), nil
		case "file":
			if parsed.Path == "" {
				return "", fmt.Errorf("无效的文件清单地址")
			}
			return urlText, nil
		case "builtin":
			if isBuiltinManifestURL(parsed) {
				return defaultDriverManifestURLValue, nil
			}
			return "", fmt.Errorf("不支持的内置清单地址：%s", parsed.String())
		default:
			return "", fmt.Errorf("不支持的清单地址协议：%s", parsed.Scheme)
		}
	}
	absPath, absErr := filepath.Abs(urlText)
	if absErr != nil {
		return "", absErr
	}
	return absPath, nil
}

func resolveManifestURLForView(manifestURL string) string {
	resolved, err := resolveDriverRepositoryURL(manifestURL)
	if err != nil {
		return strings.TrimSpace(manifestURL)
	}
	return resolved
}

func resolveManifestDriverPackages(manifestURL string) (map[string]pinnedDriverPackage, error) {
	resolvedURL, err := resolveDriverRepositoryURL(manifestURL)
	if err != nil {
		return nil, err
	}

	driverManifestCacheMu.RLock()
	cached, ok := driverManifestCache[resolvedURL]
	driverManifestCacheMu.RUnlock()
	if ok && time.Since(cached.LoadedAt) < driverManifestCacheTTL {
		if strings.TrimSpace(cached.Err) != "" {
			return nil, errors.New(cached.Err)
		}
		return copyPinnedPackageMap(cached.Packages), nil
	}

	packages, loadErr := loadManifestPackages(resolvedURL)
	entry := driverManifestCacheEntry{
		LoadedAt: time.Now(),
		Packages: copyPinnedPackageMap(packages),
	}
	if loadErr != nil {
		entry.Err = loadErr.Error()
	}
	driverManifestCacheMu.Lock()
	driverManifestCache[resolvedURL] = entry
	driverManifestCacheMu.Unlock()

	if loadErr != nil {
		return nil, loadErr
	}
	return packages, nil
}

func loadManifestPackages(resolvedURL string) (map[string]pinnedDriverPackage, error) {
	content, err := loadManifestContent(resolvedURL)
	if err != nil {
		return nil, err
	}

	var manifest driverManifestFile
	if err := json.Unmarshal(content, &manifest); err != nil {
		return nil, fmt.Errorf("解析驱动清单失败：%w", err)
	}
	defaultEngine := normalizeDriverEngine(manifest.Engine)
	if defaultEngine == "" {
		defaultEngine = normalizeDriverEngine(manifest.DefaultEngine)
	}
	if defaultEngine == "" {
		defaultEngine = normalizeDriverEngine(manifest.DefaultEngine2)
	}

	result := make(map[string]pinnedDriverPackage)
	for driverType, item := range manifest.Drivers {
		normalizedType := normalizeDriverType(driverType)
		if normalizedType == "" {
			continue
		}
		downloadURL := strings.TrimSpace(item.DownloadURL)
		if downloadURL == "" {
			downloadURL = strings.TrimSpace(item.DownloadURL2)
		}
		policy := strings.TrimSpace(item.ChecksumPolicy)
		if policy == "" {
			policy = strings.TrimSpace(item.ChecksumPolicy2)
		}
		engine := normalizeDriverEngine(item.Engine)
		if engine == "" {
			engine = defaultEngine
		}
		result[normalizedType] = pinnedDriverPackage{
			Version:     strings.TrimSpace(item.Version),
			DownloadURL: downloadURL,
			SHA256:      strings.TrimSpace(item.SHA256),
			Policy:      normalizeDriverChecksumPolicy(policy),
			Engine:      engine,
		}
	}
	return result, nil
}

func loadManifestContent(resolvedURL string) ([]byte, error) {
	trimmed := strings.TrimSpace(resolvedURL)
	if trimmed == "" {
		return nil, fmt.Errorf("驱动清单地址为空")
	}
	parsed, err := url.Parse(trimmed)
	if err == nil {
		scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
		switch scheme {
		case "http", "https":
			client := &http.Client{Timeout: 12 * time.Second}
			req, reqErr := http.NewRequest(http.MethodGet, parsed.String(), nil)
			if reqErr != nil {
				return nil, reqErr
			}
			req.Header.Set("User-Agent", "GoNavi-DriverManifest")
			resp, doErr := client.Do(req)
			if doErr != nil {
				return nil, doErr
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return nil, fmt.Errorf("拉取驱动清单失败：HTTP %d", resp.StatusCode)
			}
			limited := io.LimitReader(resp.Body, driverManifestMaxSize+1)
			body, readErr := io.ReadAll(limited)
			if readErr != nil {
				return nil, readErr
			}
			if int64(len(body)) > driverManifestMaxSize {
				return nil, fmt.Errorf("驱动清单超过大小限制")
			}
			return body, nil
		case "file":
			pathText := strings.TrimSpace(parsed.Path)
			if pathText == "" {
				return nil, fmt.Errorf("无效的本地驱动清单地址")
			}
			body, readErr := os.ReadFile(pathText)
			if readErr != nil {
				return nil, readErr
			}
			if int64(len(body)) > driverManifestMaxSize {
				return nil, fmt.Errorf("驱动清单超过大小限制")
			}
			return body, nil
		case "builtin":
			if isBuiltinManifestURL(parsed) {
				return []byte(builtinDriverManifestJSON), nil
			}
			return nil, fmt.Errorf("不支持的内置清单地址：%s", parsed.String())
		}
	}
	body, readErr := os.ReadFile(trimmed)
	if readErr != nil {
		return nil, readErr
	}
	if int64(len(body)) > driverManifestMaxSize {
		return nil, fmt.Errorf("驱动清单超过大小限制")
	}
	return body, nil
}

func isBuiltinManifestURL(parsed *url.URL) bool {
	if parsed == nil {
		return false
	}
	if strings.ToLower(strings.TrimSpace(parsed.Scheme)) != "builtin" {
		return false
	}
	if strings.ToLower(strings.TrimSpace(parsed.Host)) != "manifest" {
		return false
	}
	pathText := strings.TrimSpace(parsed.Path)
	return pathText == "" || pathText == "/"
}

func errorMessage(err error) string {
	if err == nil {
		return ""
	}
	return strings.TrimSpace(err.Error())
}

func driverInstallDir(downloadDir string, driverType string) string {
	root, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		root = defaultDriverDownloadDirectory()
	}
	return filepath.Join(root, normalizeDriverType(driverType))
}

func installedDriverMetaPath(downloadDir string, driverType string) string {
	return filepath.Join(driverInstallDir(downloadDir, driverType), "installed.json")
}

func readInstalledDriverPackage(downloadDir string, driverType string) (installedDriverPackage, bool) {
	metaPath := installedDriverMetaPath(downloadDir, driverType)
	content, err := os.ReadFile(metaPath)
	if err != nil {
		return installedDriverPackage{}, false
	}
	var meta installedDriverPackage
	if err := json.Unmarshal(content, &meta); err != nil {
		return installedDriverPackage{}, false
	}
	meta.DriverType = normalizeDriverType(meta.DriverType)
	if strings.TrimSpace(meta.DriverType) == "" {
		meta.DriverType = normalizeDriverType(driverType)
	}
	return meta, true
}

func writeInstalledDriverPackage(downloadDir string, driverType string, meta installedDriverPackage) error {
	driverDir := driverInstallDir(downloadDir, driverType)
	if err := os.MkdirAll(driverDir, 0o755); err != nil {
		return fmt.Errorf("创建驱动目录失败：%w", err)
	}
	meta.DriverType = normalizeDriverType(driverType)
	if meta.DownloadedAt == "" {
		meta.DownloadedAt = time.Now().Format(time.RFC3339)
	}
	payload, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("写入驱动元数据失败：%w", err)
	}
	if err := os.WriteFile(installedDriverMetaPath(downloadDir, driverType), payload, 0o644); err != nil {
		return fmt.Errorf("写入驱动元数据失败：%w", err)
	}
	return nil
}

func hashFileSHA256(filePath string) (string, error) {
	pathText := strings.TrimSpace(filePath)
	if pathText == "" {
		return "", fmt.Errorf("文件路径为空")
	}
	file, err := os.Open(pathText)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func installOptionalDriverAgentPackage(a *App, definition driverDefinition, resolvedDir string, downloadURL string) (installedDriverPackage, error) {
	driverType := normalizeDriverType(definition.Type)
	executablePath, err := db.ResolveOptionalDriverAgentExecutablePath(resolvedDir, driverType)
	if err != nil {
		return installedDriverPackage{}, err
	}
	downloadSource, hash, err := ensureOptionalDriverAgentBinary(a, definition, executablePath, downloadURL)
	if err != nil {
		return installedDriverPackage{}, err
	}
	if strings.TrimSpace(hash) == "" {
		hash, err = hashFileSHA256(executablePath)
		if err != nil {
			return installedDriverPackage{}, fmt.Errorf("计算 %s 驱动代理摘要失败：%w", resolveDriverDisplayName(definition), err)
		}
	}
	if strings.TrimSpace(downloadSource) == "" {
		downloadSource = strings.TrimSpace(downloadURL)
	}
	return installedDriverPackage{
		DriverType:     driverType,
		FilePath:       executablePath,
		FileName:       filepath.Base(executablePath),
		ExecutablePath: executablePath,
		DownloadURL:    strings.TrimSpace(downloadSource),
		SHA256:         hash,
		DownloadedAt:   time.Now().Format(time.RFC3339),
	}, nil
}

func ensureOptionalDriverAgentBinary(a *App, definition driverDefinition, executablePath string, downloadURL string) (string, string, error) {
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)

	info, err := os.Stat(executablePath)
	if err == nil && !info.IsDir() {
		hash, hashErr := hashFileSHA256(executablePath)
		if hashErr != nil {
			return "", "", fmt.Errorf("读取已安装 %s 驱动代理摘要失败：%w", displayName, hashErr)
		}
		return fmt.Sprintf("local://existing/%s-driver-agent", driverType), hash, nil
	}
	if err == nil && info.IsDir() {
		return "", "", fmt.Errorf("%s 驱动代理路径被目录占用：%s", displayName, executablePath)
	}

	if mkErr := os.MkdirAll(filepath.Dir(executablePath), 0o755); mkErr != nil {
		return "", "", fmt.Errorf("创建 %s 驱动目录失败：%w", displayName, mkErr)
	}
	if a != nil {
		a.emitDriverDownloadProgress(driverType, "downloading", 10, 100, "检查本地驱动代理缓存")
	}
	if sourcePath, ok := findExistingOptionalDriverAgentCandidate(definition, executablePath); ok {
		if copyErr := copyAgentBinary(sourcePath, executablePath); copyErr != nil {
			return "", "", fmt.Errorf("复制预置 %s 驱动代理失败：%w", displayName, copyErr)
		}
		hash, hashErr := hashFileSHA256(executablePath)
		if hashErr != nil {
			return "", "", fmt.Errorf("计算预置 %s 驱动代理摘要失败：%w", displayName, hashErr)
		}
		return "file://" + sourcePath, hash, nil
	}

	downloadURLs := resolveOptionalDriverAgentDownloadURLs(definition, downloadURL)
	var downloadErrs []string
	if len(downloadURLs) > 0 {
		for _, candidateURL := range downloadURLs {
			if a != nil {
				a.emitDriverDownloadProgress(driverType, "downloading", 20, 100, fmt.Sprintf("下载预编译 %s 驱动代理", displayName))
			}
			hash, dlErr := downloadOptionalDriverAgentBinary(a, definition, candidateURL, executablePath)
			if dlErr == nil {
				return candidateURL, hash, nil
			}
			downloadErrs = append(downloadErrs, fmt.Sprintf("%s: %s", candidateURL, strings.TrimSpace(dlErr.Error())))
		}
	}
	if a != nil {
		a.emitDriverDownloadProgress(driverType, "downloading", 92, 100, "未命中预编译包，尝试开发态本地构建")
	}

	hash, buildErr := buildOptionalDriverAgentFromSource(definition, executablePath)
	if buildErr == nil {
		return fmt.Sprintf("local://go-build/%s-driver-agent", driverType), hash, nil
	}

	var parts []string
	if len(downloadErrs) > 0 {
		parts = append(parts, "预编译包下载失败："+strings.Join(downloadErrs, "；"))
	}
	parts = append(parts, "本地构建失败："+strings.TrimSpace(buildErr.Error()))
	return "", "", errors.New(strings.Join(parts, "；"))
}

func downloadOptionalDriverAgentBinary(a *App, definition driverDefinition, urlText string, executablePath string) (string, error) {
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)
	trimmedURL := strings.TrimSpace(urlText)
	if trimmedURL == "" {
		return "", fmt.Errorf("下载地址为空")
	}
	tempPath := executablePath + ".tmp"
	_ = os.Remove(tempPath)

	hash, err := downloadFileWithHash(trimmedURL, tempPath, func(downloaded, total int64) {
		if a == nil {
			return
		}
		scaledDownloaded, scaledTotal := scaleProgress(downloaded, total, 20, 90)
		a.emitDriverDownloadProgress(driverType, "downloading", scaledDownloaded, scaledTotal, fmt.Sprintf("下载预编译 %s 驱动代理", displayName))
	})
	if err != nil {
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("下载失败：%w", err)
	}

	if chmodErr := os.Chmod(tempPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("设置代理权限失败：%w", chmodErr)
	}
	if renameErr := os.Rename(tempPath, executablePath); renameErr != nil {
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("落地代理文件失败：%w", renameErr)
	}
	if chmodErr := os.Chmod(executablePath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		return "", fmt.Errorf("设置代理权限失败：%w", chmodErr)
	}
	return hash, nil
}

func buildOptionalDriverAgentFromSource(definition driverDefinition, executablePath string) (string, error) {
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)
	goPath, lookErr := exec.LookPath("go")
	if lookErr != nil {
		return "", fmt.Errorf("当前环境未安装 Go，且未找到可用的 %s 预编译代理包", displayName)
	}

	tagName, tagErr := optionalDriverBuildTag(driverType)
	if tagErr != nil {
		return "", tagErr
	}

	projectRoot, rootErr := locateProjectRootForAgentBuild()
	if rootErr != nil {
		return "", rootErr
	}
	cmd := exec.Command(goPath, "build", "-tags", tagName, "-trimpath", "-ldflags", "-s -w", "-o", executablePath, "./cmd/optional-driver-agent")
	cmd.Dir = projectRoot
	output, buildErr := cmd.CombinedOutput()
	if buildErr != nil {
		return "", fmt.Errorf("构建 %s 驱动代理失败：%v，输出：%s", displayName, buildErr, strings.TrimSpace(string(output)))
	}
	if chmodErr := os.Chmod(executablePath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		return "", fmt.Errorf("设置 %s 驱动代理权限失败：%w", displayName, chmodErr)
	}
	hash, hashErr := hashFileSHA256(executablePath)
	if hashErr != nil {
		return "", fmt.Errorf("计算 %s 驱动代理摘要失败：%w", displayName, hashErr)
	}
	return hash, nil
}

func optionalDriverBuildTag(driverType string) (string, error) {
	switch normalizeDriverType(driverType) {
	case "mysql":
		return "gonavi_mysql_driver", nil
	case "mariadb":
		return "gonavi_mariadb_driver", nil
	case "diros":
		return "gonavi_diros_driver", nil
	case "sphinx":
		return "gonavi_sphinx_driver", nil
	case "sqlserver":
		return "gonavi_sqlserver_driver", nil
	case "sqlite":
		return "gonavi_sqlite_driver", nil
	case "duckdb":
		return "gonavi_duckdb_driver", nil
	case "dameng":
		return "gonavi_dameng_driver", nil
	case "kingbase":
		return "gonavi_kingbase_driver", nil
	case "highgo":
		return "gonavi_highgo_driver", nil
	case "vastbase":
		return "gonavi_vastbase_driver", nil
	case "mongodb":
		return "gonavi_mongodb_driver", nil
	case "tdengine":
		return "gonavi_tdengine_driver", nil
	default:
		return "", fmt.Errorf("未配置驱动构建标签：%s", driverType)
	}
}

func locateProjectRootForAgentBuild() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("获取当前目录失败：%w", err)
	}
	dir := wd
	for {
		if fileExists(filepath.Join(dir, "go.mod")) && fileExists(filepath.Join(dir, "cmd", "optional-driver-agent", "main.go")) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("未找到通用驱动代理源码，无法自动构建；请使用已发布版本")
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func optionalDriverExecutableBaseName(driverType string) string {
	name := fmt.Sprintf("%s-driver-agent", normalizeDriverType(driverType))
	if stdRuntime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func optionalDriverReleaseAssetName(driverType string) string {
	name := fmt.Sprintf("%s-driver-agent-%s-%s", normalizeDriverType(driverType), stdRuntime.GOOS, stdRuntime.GOARCH)
	if stdRuntime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func resolveOptionalDriverAgentDownloadURLs(definition driverDefinition, rawURL string) []string {
	driverType := normalizeDriverType(definition.Type)
	candidates := make([]string, 0, 3)
	seen := make(map[string]struct{}, 3)
	appendURL := func(value string) {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return
		}
		if _, ok := seen[trimmed]; ok {
			return
		}
		seen[trimmed] = struct{}{}
		candidates = append(candidates, trimmed)
	}

	if parsed, err := url.Parse(strings.TrimSpace(rawURL)); err == nil {
		switch strings.ToLower(strings.TrimSpace(parsed.Scheme)) {
		case "http", "https":
			appendURL(parsed.String())
		}
	}

	assetName := optionalDriverReleaseAssetName(driverType)
	currentVersion := normalizeVersion(getCurrentVersion())
	if currentVersion != "" && currentVersion != "0.0.0" {
		appendURL(fmt.Sprintf("https://github.com/Syngnat/GoNavi/releases/download/v%s/%s", currentVersion, assetName))
	}
	appendURL(fmt.Sprintf("https://github.com/Syngnat/GoNavi/releases/latest/download/%s", assetName))
	return candidates
}

func findExistingOptionalDriverAgentCandidate(definition driverDefinition, targetPath string) (string, bool) {
	targetAbs, _ := filepath.Abs(targetPath)
	candidates := resolveOptionalDriverAgentCandidatePaths(definition)
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		absPath, err := filepath.Abs(candidate)
		if err != nil || absPath == "" {
			continue
		}
		if targetAbs != "" && absPath == targetAbs {
			continue
		}
		info, statErr := os.Stat(absPath)
		if statErr == nil && !info.IsDir() {
			return absPath, true
		}
	}
	return "", false
}

func resolveOptionalDriverAgentCandidatePaths(definition driverDefinition) []string {
	driverType := normalizeDriverType(definition.Type)
	name := optionalDriverExecutableBaseName(driverType)
	assetName := optionalDriverReleaseAssetName(driverType)
	candidates := make([]string, 0, 12)
	appendPath := func(pathText string) {
		trimmed := strings.TrimSpace(pathText)
		if trimmed != "" {
			candidates = append(candidates, trimmed)
		}
	}

	if exePath, err := os.Executable(); err == nil && strings.TrimSpace(exePath) != "" {
		resolved := exePath
		if evalPath, evalErr := filepath.EvalSymlinks(exePath); evalErr == nil && strings.TrimSpace(evalPath) != "" {
			resolved = evalPath
		}
		exeDir := filepath.Dir(resolved)
		appendPath(filepath.Join(exeDir, name))
		appendPath(filepath.Join(exeDir, assetName))
		appendPath(filepath.Join(exeDir, "drivers", driverType, name))
		appendPath(filepath.Join(exeDir, "drivers", driverType, assetName))

		resourcesDir := filepath.Clean(filepath.Join(exeDir, "..", "Resources"))
		appendPath(filepath.Join(resourcesDir, "drivers", driverType, name))
		appendPath(filepath.Join(resourcesDir, "drivers", driverType, assetName))
	}
	if wd, err := os.Getwd(); err == nil && strings.TrimSpace(wd) != "" {
		appendPath(filepath.Join(wd, "dist", assetName))
		appendPath(filepath.Join(wd, assetName))
	}

	unique := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, item := range candidates {
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		unique = append(unique, item)
	}
	return unique
}

func resolveDriverDisplayName(definition driverDefinition) string {
	if strings.TrimSpace(definition.Name) != "" {
		return strings.TrimSpace(definition.Name)
	}
	if strings.TrimSpace(definition.Type) != "" {
		return strings.TrimSpace(definition.Type)
	}
	return "未知"
}

func copyAgentBinary(sourcePath, targetPath string) error {
	src, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer src.Close()

	tempPath := targetPath + ".tmp"
	_ = os.Remove(tempPath)
	dst, err := os.Create(tempPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
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
	if chmodErr := os.Chmod(tempPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		_ = os.Remove(tempPath)
		return chmodErr
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if chmodErr := os.Chmod(targetPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		return chmodErr
	}
	return nil
}

func scaleProgress(downloaded, total, start, end int64) (int64, int64) {
	if end <= start {
		return end, 100
	}
	if total <= 0 {
		return start, 100
	}
	if downloaded < 0 {
		downloaded = 0
	}
	if downloaded > total {
		downloaded = total
	}
	span := end - start
	return start + ((downloaded * span) / total), 100
}

func preloadOptionalDriverPackageSizes(definitions []driverDefinition) map[string]int64 {
	result := make(map[string]int64)
	if len(definitions) == 0 {
		return result
	}

	needed := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		normalizedType := normalizeDriverType(definition.Type)
		if normalizedType == "" || definition.BuiltIn {
			continue
		}
		if !db.IsOptionalGoDriver(normalizedType) {
			continue
		}
		if !db.IsOptionalGoDriverBuildIncluded(normalizedType) {
			continue
		}
		needed = append(needed, normalizedType)
	}
	if len(needed) == 0 {
		return result
	}

	currentVersion := normalizeVersion(getCurrentVersion())
	tag := ""
	if currentVersion != "" && currentVersion != "0.0.0" {
		tag = "v" + currentVersion
	}

	fillFromSizes := func(sizeByAsset map[string]int64, driverTypes []string) []string {
		missing := make([]string, 0, len(driverTypes))
		for _, driverType := range driverTypes {
			assetName := optionalDriverReleaseAssetName(driverType)
			sizeBytes := sizeByAsset[assetName]
			if sizeBytes > 0 {
				result[driverType] = sizeBytes
				continue
			}
			missing = append(missing, driverType)
		}
		return missing
	}

	pending := needed
	if tag != "" {
		if sizeByAsset, err := loadReleaseAssetSizesCached("tag:"+tag, func() (*githubRelease, error) {
			return fetchReleaseByTag(tag)
		}); err == nil {
			pending = fillFromSizes(sizeByAsset, pending)
		}
	}
	if len(pending) == 0 {
		return result
	}
	if sizeByAsset, err := loadReleaseAssetSizesCached("latest", fetchLatestReleaseForDriverAssets); err == nil {
		_ = fillFromSizes(sizeByAsset, pending)
	}
	return result
}

func loadReleaseAssetSizesCached(cacheKey string, fetch func() (*githubRelease, error)) (map[string]int64, error) {
	key := strings.TrimSpace(cacheKey)
	if key == "" {
		return nil, fmt.Errorf("缓存 key 为空")
	}

	driverReleaseSizeMu.RLock()
	cached, ok := driverReleaseSizeMap[key]
	driverReleaseSizeMu.RUnlock()
	if ok {
		ttl := driverReleaseAssetSizeCacheTTL
		if strings.TrimSpace(cached.Err) != "" {
			ttl = driverReleaseAssetSizeErrorCacheTTL
		}
		if time.Since(cached.LoadedAt) < ttl {
			if strings.TrimSpace(cached.Err) != "" {
				return nil, errors.New(strings.TrimSpace(cached.Err))
			}
			return cached.SizeByKey, nil
		}
	}

	release, err := fetch()
	entry := driverReleaseAssetSizeCacheEntry{
		LoadedAt:  time.Now(),
		SizeByKey: map[string]int64{},
	}
	if err != nil {
		entry.Err = err.Error()
	} else {
		entry.SizeByKey = buildReleaseAssetSizeMap(release)
	}

	driverReleaseSizeMu.Lock()
	driverReleaseSizeMap[key] = entry
	driverReleaseSizeMu.Unlock()

	if err != nil {
		return nil, err
	}
	return entry.SizeByKey, nil
}

func buildReleaseAssetSizeMap(release *githubRelease) map[string]int64 {
	sizes := make(map[string]int64)
	if release == nil {
		return sizes
	}
	for _, asset := range release.Assets {
		name := strings.TrimSpace(asset.Name)
		if name == "" || asset.Size <= 0 {
			continue
		}
		sizes[name] = asset.Size
	}
	return sizes
}

func fetchLatestReleaseForDriverAssets() (*githubRelease, error) {
	return fetchDriverReleaseByURL(updateAPIURL)
}

func fetchReleaseByTag(tag string) (*githubRelease, error) {
	tagName := strings.TrimSpace(tag)
	if tagName == "" {
		return nil, fmt.Errorf("Tag 为空")
	}
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases/tags/%s", updateRepo, url.PathEscape(tagName))
	return fetchDriverReleaseByURL(apiURL)
}

func fetchDriverReleaseByURL(apiURL string) (*githubRelease, error) {
	urlText := strings.TrimSpace(apiURL)
	if urlText == "" {
		return nil, fmt.Errorf("API 地址为空")
	}

	client := &http.Client{Timeout: driverReleaseAssetSizeProbeTimeout}
	req, err := http.NewRequest(http.MethodGet, urlText, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GoNavi-DriverManager")
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("拉取 Release 信息失败：HTTP %d", resp.StatusCode)
	}

	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, err
	}
	return &release, nil
}

func resolveDriverPackageSizeText(definition driverDefinition, pkg installedDriverPackage, packageMetaExists bool, packageSizeBytesMap map[string]int64) string {
	if definition.BuiltIn {
		return "内置"
	}

	normalizedType := normalizeDriverType(definition.Type)
	if packageMetaExists {
		sizeBytes := readInstalledPackageSizeBytes(pkg)
		if sizeBytes > 0 {
			return formatSizeMB(sizeBytes)
		}
	}
	if sizeBytes, ok := packageSizeBytesMap[normalizedType]; ok && sizeBytes > 0 {
		return formatSizeMB(sizeBytes)
	}

	if !db.IsOptionalGoDriverBuildIncluded(normalizedType) {
		return "待发布"
	}
	return "-"
}

func readInstalledPackageSizeBytes(pkg installedDriverPackage) int64 {
	pathText := strings.TrimSpace(pkg.ExecutablePath)
	if pathText == "" {
		pathText = strings.TrimSpace(pkg.FilePath)
	}
	if pathText == "" {
		return 0
	}
	info, err := os.Stat(pathText)
	if err != nil || info.IsDir() {
		return 0
	}
	return info.Size()
}

func formatSizeMB(sizeBytes int64) string {
	if sizeBytes <= 0 {
		return "-"
	}
	sizeMB := float64(sizeBytes) / (1024 * 1024)
	return fmt.Sprintf("%.2f MB", sizeMB)
}
