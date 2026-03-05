package app

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/mod/semver"
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
	Version        string `json:"version,omitempty"`
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
	InstalledVersion   string `json:"installedVersion,omitempty"`
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

type driverNetworkProbeItem struct {
	Name        string `json:"name"`
	URL         string `json:"url"`
	Reachable   bool   `json:"reachable"`
	HTTPStatus  int    `json:"httpStatus,omitempty"`
	LatencyMs   int64  `json:"latencyMs,omitempty"`
	TCPLatency  int64  `json:"tcpLatencyMs,omitempty"`
	HTTPLatency int64  `json:"httpLatencyMs,omitempty"`
	Method      string `json:"method,omitempty"`
	Error       string `json:"error,omitempty"`
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
	Version         string                      `json:"version"`
	DownloadURL     string                      `json:"downloadUrl"`
	DownloadURL2    string                      `json:"download_url"`
	SHA256          string                      `json:"sha256"`
	ChecksumPolicy  string                      `json:"checksumPolicy"`
	ChecksumPolicy2 string                      `json:"checksum_policy"`
	Engine          string                      `json:"engine"`
	Versions        []driverManifestVersionItem `json:"versions"`
	VersionList     []driverManifestVersionItem `json:"versionList"`
	VersionList2    []driverManifestVersionItem `json:"version_list"`
	VersionOptions  []driverManifestVersionItem `json:"versionOptions"`
	VersionOptions2 []driverManifestVersionItem `json:"version_options"`
}

type driverManifestVersionItem struct {
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
	Versions map[string][]pinnedDriverPackage
	Err      string
}

type driverVersionOptionItem struct {
	Version          string `json:"version"`
	DownloadURL      string `json:"downloadUrl"`
	SHA256           string `json:"sha256,omitempty"`
	PackageSizeBytes int64  `json:"packageSizeBytes,omitempty"`
	PackageSizeText  string `json:"packageSizeText,omitempty"`
	Recommended      bool   `json:"recommended,omitempty"`
	Source           string `json:"source,omitempty"`
	Year             string `json:"year,omitempty"`
	DisplayLabel     string `json:"displayLabel,omitempty"`
}

type driverReleaseAssetSizeCacheEntry struct {
	LoadedAt  time.Time
	SizeByKey map[string]int64
	Err       string
}

type goModuleLatestVersionCacheEntry struct {
	LoadedAt time.Time
	Version  string
	Err      string
}

type goModuleLatestVersionResponse struct {
	Version string `json:"Version"`
}

type goModuleVersionListCacheEntry struct {
	LoadedAt time.Time
	Versions []goModuleVersionMeta
	Err      string
}

type goModuleVersionMeta struct {
	Version string
	Year    string
}

type driverBundleAssetIndex struct {
	Assets map[string]int64 `json:"assets"`
}

const (
	// 默认使用内置 manifest，避免依赖网络与外部仓库 404。
	defaultDriverManifestURLValue       = "builtin://manifest"
	optionalDriverBundleAssetName       = "GoNavi-DriverAgents.zip"
	optionalDriverBundleIndexAssetName  = "GoNavi-DriverAgents-Index.json"
	driverManifestCacheTTL              = 5 * time.Minute
	driverReleaseAssetSizeCacheTTL      = 30 * time.Minute
	driverReleaseAssetSizeErrorCacheTTL = 30 * time.Second
	driverReleaseAssetSizeProbeTimeout  = 4 * time.Second
	driverReleaseListProbeTimeout       = 6 * time.Second
	driverModuleLatestCacheTTL          = 6 * time.Hour
	driverModuleLatestErrorCacheTTL     = 2 * time.Minute
	driverModuleLatestProbeTimeout      = 4 * time.Second
	driverModuleVersionInspectLimit     = 30
	driverModuleVersionListMaxSize      = 4 << 20
	driverRecentVersionLimit            = 5
	driverVersionWarmupMinInterval      = 30 * time.Second
	driverBundleIndexMaxSize            = 1 << 20
	driverManifestMaxSize               = 2 << 20
	driverNetworkProbeTimeout           = 4 * time.Second
	driverNetworkProbeTCPTimeout        = 3 * time.Second
	localDriverDirectoryScanMaxEntries  = 20000
	driverChecksumPolicyStrict          = "strict"
	driverChecksumPolicyWarn            = "warn"
	driverChecksumPolicyOff             = "off"
	driverEngineGo                      = "go"
	driverEngineExternal                = "external"
)

const builtinDriverManifestJSON = `{
  "engine": "go",
  "drivers": {
    "mysql":     { "engine": "go", "version": "1.9.3", "checksumPolicy": "off" },
    "mariadb":   { "engine": "go", "version": "1.9.3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/mariadb" },
    "doris":     { "engine": "go", "version": "1.9.3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/doris" },
    "sphinx":    { "engine": "go", "version": "1.9.3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/sphinx" },
    "sqlserver": { "engine": "go", "version": "1.9.6", "checksumPolicy": "off", "downloadUrl": "builtin://activate/sqlserver" },
    "sqlite":    { "engine": "go", "version": "1.44.3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/sqlite" },
    "duckdb":    { "engine": "go", "version": "2.5.6", "checksumPolicy": "off", "downloadUrl": "builtin://activate/duckdb" },
    "dameng":    { "engine": "go", "version": "1.8.22", "checksumPolicy": "off", "downloadUrl": "builtin://activate/dameng" },
    "kingbase":  { "engine": "go", "version": "0.0.0-20201021123113-29bd62a876c3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/kingbase" },
    "highgo":    { "engine": "go", "version": "0.0.0-local", "checksumPolicy": "off", "downloadUrl": "builtin://activate/highgo" },
    "vastbase":  { "engine": "go", "version": "1.11.1", "checksumPolicy": "off", "downloadUrl": "builtin://activate/vastbase" },
    "mongodb":   { "engine": "go", "version": "2.5.0", "checksumPolicy": "off", "downloadUrl": "builtin://activate/mongodb" },
    "tdengine":  { "engine": "go", "version": "3.7.8", "checksumPolicy": "off", "downloadUrl": "builtin://activate/tdengine" },
    "clickhouse": { "engine": "go", "version": "2.43.1", "checksumPolicy": "off", "downloadUrl": "builtin://activate/clickhouse" }
  }
}`

var (
	driverManifestCacheMu      sync.RWMutex
	driverManifestCache        = make(map[string]driverManifestCacheEntry)
	driverReleaseSizeMu        sync.RWMutex
	driverReleaseSizeMap       = make(map[string]driverReleaseAssetSizeCacheEntry)
	driverReleaseListMu        sync.RWMutex
	driverReleaseList          = driverManifestReleaseListCache{}
	driverModuleLatestMu       sync.RWMutex
	driverModuleLatestMap      = make(map[string]goModuleLatestVersionCacheEntry)
	driverModuleVersionMu      sync.RWMutex
	driverModuleVersionMap     = make(map[string]goModuleVersionListCacheEntry)
	driverVersionWarmupMu      sync.Mutex
	driverVersionWarmup        = driverVersionWarmupState{}
	errLocalDriverDirScanLimit = errors.New("local_driver_directory_scan_limit_exceeded")
)

type driverVersionWarmupState struct {
	Running     bool
	LastStarted time.Time
}

type driverManifestReleaseListCache struct {
	LoadedAt time.Time
	Releases []githubRelease
	Err      string
}

var pinnedDriverPackageMap = map[string]pinnedDriverPackage{
	"postgres": {
		Version: "go-embedded",
		Policy:  driverChecksumPolicyOff,
		Engine:  driverEngineGo,
	},
}

var latestDriverVersionMap = map[string]string{
	"mysql":      "1.9.3",
	"mariadb":    "1.9.3",
	"diros":      "1.9.3",
	"sphinx":     "1.9.3",
	"sqlserver":  "1.9.6",
	"sqlite":     "1.46.1",
	"duckdb":     "2.5.6",
	"dameng":     "1.8.22",
	"kingbase":   "0.0.0-20201021123113-29bd62a876c3",
	"highgo":     "0.0.0-local",
	"vastbase":   "1.11.2",
	"mongodb":    "2.5.0",
	"tdengine":   "3.7.8",
	"clickhouse": "2.43.1",
	"oracle":     "2.9.0",
	"postgres":   "1.11.2",
	"redis":      "9.17.3",
}

var driverGoModulePathMap = map[string]string{
	"mariadb":    "github.com/go-sql-driver/mysql",
	"diros":      "github.com/go-sql-driver/mysql",
	"sphinx":     "github.com/go-sql-driver/mysql",
	"sqlserver":  "github.com/microsoft/go-mssqldb",
	"sqlite":     "modernc.org/sqlite",
	"duckdb":     "github.com/duckdb/duckdb-go/v2",
	"dameng":     "gitee.com/chunanyong/dm",
	"kingbase":   "gitea.com/kingbase/gokb",
	"highgo":     "github.com/highgo/pq-sm3",
	"vastbase":   "github.com/lib/pq",
	"mongodb":    "go.mongodb.org/mongo-driver/v2",
	"tdengine":   "github.com/taosdata/driver-go/v3",
	"clickhouse": "github.com/ClickHouse/clickhouse-go/v2",
}

var fallbackRecentDriverVersionsMap = map[string][]goModuleVersionMeta{
	"mongodb": {
		{Version: "2.5.0"},
		{Version: "2.4.0"},
		{Version: "2.3.1"},
		{Version: "2.3.0"},
		{Version: "2.2.3"},
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

func (a *App) SelectDriverPackageDirectory(currentPath string) connection.QueryResult {
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

	selection, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "选择驱动包目录",
		DefaultDirectory: defaultDir,
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
			urlText = fmt.Sprintf("builtin://activate/%s", optionalDriverPublicTypeName(definition.Type))
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

func (a *App) GetDriverVersionList(driverType string, repositoryURL string) connection.QueryResult {
	effectivePackages, manifestErr := resolveEffectiveDriverPackages(repositoryURL)
	definition, ok := resolveDriverDefinitionWithPackages(driverType, effectivePackages)
	if !ok {
		return connection.QueryResult{Success: false, Message: "不支持的驱动类型"}
	}
	if definition.BuiltIn {
		return connection.QueryResult{Success: false, Message: "内置驱动无需选择版本"}
	}
	if err := ensureOptionalDriverBuildAvailable(definition); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	options, err := resolveDriverVersionOptions(definition, repositoryURL)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"driverType":    definition.Type,
			"driverName":    definition.Name,
			"pinnedVersion": definition.PinnedVersion,
			"manifestError": errorMessage(manifestErr),
			"versions":      options,
		},
	}
}

func (a *App) GetDriverVersionPackageSize(driverType string, version string) connection.QueryResult {
	definition, ok := resolveDriverDefinition(driverType)
	if !ok {
		return connection.QueryResult{Success: false, Message: "不支持的驱动类型"}
	}
	if definition.BuiltIn {
		return connection.QueryResult{Success: false, Message: "内置驱动无需安装包"}
	}

	normalizedType := normalizeDriverType(definition.Type)
	if normalizedType == "" || !db.IsOptionalGoDriver(normalizedType) {
		return connection.QueryResult{Success: false, Message: "当前驱动不支持安装包查询"}
	}

	normalizedVersion := normalizeVersion(strings.TrimSpace(version))
	if normalizedVersion == "" {
		return connection.QueryResult{Success: false, Message: "版本号为空"}
	}
	assetName := optionalDriverReleaseAssetName(normalizedType)
	if strings.TrimSpace(assetName) == "" {
		return connection.QueryResult{Success: false, Message: "驱动资产名称为空"}
	}

	tag := "v" + normalizedVersion
	sizeBytes := int64(0)
	sizeSource := ""
	if sizeByAsset, err := loadReleaseAssetSizesCached("tag:"+tag, func() (*githubRelease, error) {
		return fetchReleaseByTag(tag)
	}); err == nil {
		sizeBytes = resolveOptionalDriverAssetSize(sizeByAsset, normalizedType)
		if sizeBytes > 0 {
			sizeSource = "tag"
		}
	}
	if sizeBytes <= 0 {
		if sizeByAsset, err := loadReleaseAssetSizesCached("latest", fetchLatestReleaseForDriverAssets); err == nil {
			sizeBytes = resolveOptionalDriverAssetSize(sizeByAsset, normalizedType)
			if sizeBytes > 0 {
				sizeSource = "latest"
			}
		}
	}
	data := map[string]interface{}{
		"driverType":       normalizedType,
		"version":          normalizedVersion,
		"packageSizeBytes": sizeBytes,
		"packageSizeText":  "",
		"releaseAssetName": assetName,
		"releaseAssetTag":  tag,
		"sizeSource":       sizeSource,
	}
	if sizeBytes > 0 {
		data["packageSizeText"] = formatSizeMB(sizeBytes)
	}
	return connection.QueryResult{Success: true, Data: data}
}

func (a *App) GetDriverStatusList(downloadDir string, manifestURL string) connection.QueryResult {
	resolvedDir, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	db.SetExternalDriverDownloadDirectory(resolvedDir)

	effectivePackages, manifestErr := resolveEffectiveDriverPackages(manifestURL)
	definitions := allDriverDefinitionsWithPackages(effectivePackages)
	triggerDriverVersionMetadataWarmup(definitions)
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
			InstalledVersion:   strings.TrimSpace(pkg.Version),
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
			if item.InstalledVersion != "" {
				item.Message = fmt.Sprintf("驱动已安装（版本：%s），待生效", item.InstalledVersion)
			} else {
				item.Message = "驱动已安装，待生效"
			}
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

func (a *App) CheckDriverNetworkStatus() connection.QueryResult {
	checks := []driverNetworkProbeItem{
		{
			Name: "GitHub API",
			URL:  "https://api.github.com/rate_limit",
		},
		{
			Name: "GitHub 驱动发布",
			URL:  fmt.Sprintf("https://github.com/%s/releases/latest/download/%s", updateRepo, optionalDriverBundleAssetName),
		},
		{
			Name: "GitHub Release 资产域名",
			URL:  "https://release-assets.githubusercontent.com/",
		},
		{
			Name: "Go 模块代理",
			URL:  "https://proxy.golang.org/github.com/go-sql-driver/mysql/@v/list",
		},
	}

	client := newHTTPClientWithGlobalProxy(driverNetworkProbeTimeout)
	allReachable := true
	for index := range checks {
		checks[index] = probeDriverNetworkEndpoint(client, checks[index])
		if !checks[index].Reachable {
			allReachable = false
		}
	}
	findProbe := func(name string) (driverNetworkProbeItem, bool) {
		for _, item := range checks {
			if strings.EqualFold(strings.TrimSpace(item.Name), strings.TrimSpace(name)) {
				return item, true
			}
		}
		return driverNetworkProbeItem{}, false
	}
	githubAPICheck, _ := findProbe("GitHub API")
	githubReleaseCheck, _ := findProbe("GitHub 驱动发布")
	releaseAssetsCheck, _ := findProbe("GitHub Release 资产域名")
	downloadChainReachable := githubReleaseCheck.Reachable && releaseAssetsCheck.Reachable

	proxyEnv := collectDriverProxyEnv()
	proxyConfigured := len(proxyEnv) > 0
	summary := "驱动下载网络检测通过，可直接安装驱动。"
	if githubAPICheck.Reachable && !downloadChainReachable {
		summary = "重要提醒：GitHub API 可达，但驱动下载链路不可达。请优先在 GoNavi 启用全局代理（填写代理应用本地地址和端口），并在代理规则中放行 github.com、api.github.com、release-assets.githubusercontent.com、objects.githubusercontent.com、raw.githubusercontent.com；若仍失败，再考虑开启 TUN 模式。"
	} else if !allReachable {
		if proxyConfigured {
			summary = "检测到部分驱动下载地址不可达，请确认系统代理配置有效后重试。"
		} else {
			summary = "检测到部分驱动下载地址不可达，建议先配置 HTTP/HTTPS/SOCKS5 代理后再安装驱动。"
		}
	}

	data := map[string]interface{}{
		"reachable":              allReachable,
		"summary":                summary,
		"recommendedProxy":       !allReachable,
		"proxyConfigured":        proxyConfigured,
		"proxyEnv":               proxyEnv,
		"downloadChainReachable": downloadChainReachable,
		"downloadRequiredHosts": []string{
			"github.com",
			"api.github.com",
			"release-assets.githubusercontent.com",
			"objects.githubusercontent.com",
			"raw.githubusercontent.com",
		},
		"checkedAt": time.Now().Format(time.RFC3339),
		"checks":    checks,
	}
	if logPath := strings.TrimSpace(logger.Path()); logPath != "" {
		data["logPath"] = logPath
	}
	return connection.QueryResult{
		Success: true,
		Data:    data,
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

	a.emitDriverDownloadProgress(definition.Type, "start", 0, 100, "开始安装本地驱动包")
	selectedVersion := resolveDriverInstallVersion(definition.PinnedVersion, "local://manual", definition)
	meta, installErr := installOptionalDriverAgentFromLocalPath(definition, filePath, resolvedDir, selectedVersion)
	if installErr != nil {
		errText := normalizeErrorMessage(installErr)
		a.emitDriverDownloadProgress(definition.Type, "error", 0, 0, errText)
		return connection.QueryResult{
			Success: false,
			Message: logDriverOperationError(installErr, "导入本地驱动包失败，driver=%s file=%s", definition.Type, strings.TrimSpace(filePath)),
		}
	}
	a.emitDriverDownloadProgress(definition.Type, "downloading", 90, 100, "写入驱动元数据")
	if err := writeInstalledDriverPackage(resolvedDir, definition.Type, meta); err != nil {
		errText := normalizeErrorMessage(err)
		a.emitDriverDownloadProgress(definition.Type, "error", 0, 0, errText)
		return connection.QueryResult{
			Success: false,
			Message: logDriverOperationError(err, "写入本地驱动元数据失败，driver=%s", definition.Type),
		}
	}
	a.emitDriverDownloadProgress(definition.Type, "done", 100, 100, "本地驱动包导入完成")

	return connection.QueryResult{Success: true, Message: "驱动安装成功", Data: map[string]interface{}{
		"driverType": definition.Type,
		"driverName": definition.Name,
		"engine":     engine,
	}}
}

func (a *App) DownloadDriverPackage(driverType string, version string, downloadURL string, downloadDir string) connection.QueryResult {
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
		urlText = fmt.Sprintf("builtin://activate/%s", optionalDriverPublicTypeName(definition.Type))
	}
	selectedVersion := resolveDriverInstallVersion(version, urlText, definition)

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
		meta, installErr := installOptionalDriverAgentPackage(a, definition, selectedVersion, resolvedDir, urlText)
		if installErr != nil {
			errText := normalizeErrorMessage(installErr)
			a.emitDriverDownloadProgress(definition.Type, "error", 0, 0, errText)
			return connection.QueryResult{
				Success: false,
				Message: logDriverOperationError(installErr, "驱动下载安装失败，driver=%s version=%s url=%s", definition.Type, selectedVersion, urlText),
			}
		}
		a.emitDriverDownloadProgress(definition.Type, "downloading", 95, 100, "写入驱动元数据")
		if writeErr := writeInstalledDriverPackage(resolvedDir, definition.Type, meta); writeErr != nil {
			errText := normalizeErrorMessage(writeErr)
			a.emitDriverDownloadProgress(definition.Type, "error", 0, 0, errText)
			return connection.QueryResult{
				Success: false,
				Message: logDriverOperationError(writeErr, "写入驱动元数据失败，driver=%s version=%s", definition.Type, selectedVersion),
			}
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
		Version:      selectedVersion,
		FilePath:     "",
		FileName:     "embedded-go-driver",
		DownloadURL:  urlText,
		SHA256:       "",
		DownloadedAt: time.Now().Format(time.RFC3339),
	}
	if err := writeInstalledDriverPackage(resolvedDir, definition.Type, meta); err != nil {
		errText := normalizeErrorMessage(err)
		a.emitDriverDownloadProgress(definition.Type, "error", 0, 0, errText)
		return connection.QueryResult{
			Success: false,
			Message: logDriverOperationError(err, "写入驱动元数据失败，driver=%s version=%s", definition.Type, selectedVersion),
		}
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

func probeDriverNetworkEndpoint(client *http.Client, item driverNetworkProbeItem) driverNetworkProbeItem {
	probed := item
	probed.Reachable = false
	probed.HTTPStatus = 0
	probed.Error = ""
	probed.LatencyMs = 0
	probed.TCPLatency = 0
	probed.HTTPLatency = 0
	probed.Method = ""

	urlText := strings.TrimSpace(item.URL)
	if urlText == "" {
		probed.Error = "检测地址为空"
		return probed
	}

	if tcpLatency, tcpErr := probeDriverTCPLatency(urlText); tcpErr == nil {
		probed.TCPLatency = tcpLatency
		probed.LatencyMs = tcpLatency
	}

	if client == nil {
		client = newHTTPClientWithGlobalProxy(driverNetworkProbeTimeout)
	}
	start := time.Now()
	resp, method, err := doDriverProbeRequest(client, urlText, http.MethodGet)
	if err != nil || shouldFallbackHeadProbe(resp) {
		if resp != nil {
			_ = resp.Body.Close()
		}
		// 回退到 HEAD 时重置计时，避免把失败重试耗时累计到最终延迟指标里。
		start = time.Now()
		resp, method, err = doDriverProbeRequest(client, urlText, http.MethodHead)
	}
	probed.HTTPLatency = time.Since(start).Milliseconds()
	if probed.LatencyMs <= 0 {
		probed.LatencyMs = probed.HTTPLatency
	}
	if err != nil {
		probed.Error = normalizeDriverNetworkError(err)
		return probed
	}
	defer resp.Body.Close()
	probed.Method = method

	probed.HTTPStatus = resp.StatusCode
	if resp.StatusCode >= 500 {
		probed.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
		return probed
	}
	probed.Reachable = true
	return probed
}

func probeDriverTCPLatency(rawURL string) (int64, error) {
	dialAddr, err := resolveDriverProbeDialAddress(rawURL)
	if err != nil {
		return 0, err
	}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", dialAddr, driverNetworkProbeTCPTimeout)
	elapsed := time.Since(start)
	latency := elapsed.Milliseconds()
	if elapsed > 0 && latency <= 0 {
		latency = 1
	}
	if err != nil {
		return latency, err
	}
	_ = conn.Close()
	return latency, nil
}

func resolveDriverProbeDialAddress(rawURL string) (string, error) {
	urlText := strings.TrimSpace(rawURL)
	if urlText == "" {
		return "", fmt.Errorf("检测地址为空")
	}
	parsed, err := url.Parse(urlText)
	if err != nil {
		return "", err
	}

	targetHost := strings.TrimSpace(parsed.Hostname())
	if targetHost == "" {
		return "", fmt.Errorf("检测地址缺少主机")
	}
	targetPort := strings.TrimSpace(parsed.Port())
	if targetPort == "" {
		if strings.EqualFold(parsed.Scheme, "http") {
			targetPort = "80"
		} else {
			targetPort = "443"
		}
	}

	if proxyURL := resolveDriverProbeProxyURL(parsed); proxyURL != nil {
		proxyHost := strings.TrimSpace(proxyURL.Hostname())
		if proxyHost == "" {
			return net.JoinHostPort(targetHost, targetPort), nil
		}
		proxyPort := strings.TrimSpace(proxyURL.Port())
		if proxyPort == "" {
			proxyPort = defaultPortForScheme(proxyURL.Scheme)
		}
		return net.JoinHostPort(proxyHost, proxyPort), nil
	}

	return net.JoinHostPort(targetHost, targetPort), nil
}

func resolveDriverProbeProxyURL(target *url.URL) *url.URL {
	if target == nil {
		return nil
	}

	snapshot := currentGlobalProxyConfig()
	if snapshot.Enabled {
		proxyURL, err := buildProxyURLFromConfig(snapshot.Proxy)
		if err == nil {
			return proxyURL
		}
	}

	req := &http.Request{URL: target}
	proxyURL, err := http.ProxyFromEnvironment(req)
	if err != nil {
		return nil
	}
	return proxyURL
}

func defaultPortForScheme(scheme string) string {
	switch strings.ToLower(strings.TrimSpace(scheme)) {
	case "https":
		return "443"
	case "socks5", "socks5h":
		return "1080"
	case "http":
		fallthrough
	default:
		return "80"
	}
}

func doDriverProbeRequest(client *http.Client, urlText string, method string) (*http.Response, string, error) {
	req, err := http.NewRequest(method, urlText, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "GoNavi-DriverManager")
	// 用 GET+Range 探测可更接近真实下载链路，同时避免下载正文。
	if strings.EqualFold(method, http.MethodGet) {
		req.Header.Set("Range", "bytes=0-0")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, method, err
	}
	return resp, method, nil
}

func shouldFallbackHeadProbe(resp *http.Response) bool {
	if resp == nil {
		return false
	}
	return resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusNotImplemented
}

func normalizeDriverNetworkError(err error) string {
	if err == nil {
		return ""
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "网络连接超时"
	}
	return normalizeErrorMessage(err)
}

func collectDriverProxyEnv() map[string]string {
	keys := []string{
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "all_proxy", "no_proxy",
	}
	result := make(map[string]string)
	for _, key := range keys {
		value := strings.TrimSpace(os.Getenv(key))
		if value == "" {
			continue
		}
		result[key] = value
	}
	return result
}

func driverLogHint() string {
	path := strings.TrimSpace(logger.Path())
	if path == "" {
		return ""
	}
	return fmt.Sprintf("（详细日志：%s）", path)
}

func logDriverOperationError(err error, format string, args ...interface{}) string {
	message := normalizeErrorMessage(err)
	if strings.TrimSpace(message) == "" {
		message = "未知错误"
	}
	logger.Error(err, format, args...)
	return strings.TrimSpace(message) + driverLogHint()
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
		buildOptionalGoDriverDefinition("diros", "Doris", packages),
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
		buildOptionalGoDriverDefinition("clickhouse", "ClickHouse", packages),
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

func copyVersionPackageMap(source map[string][]pinnedDriverPackage) map[string][]pinnedDriverPackage {
	if len(source) == 0 {
		return map[string][]pinnedDriverPackage{}
	}
	result := make(map[string][]pinnedDriverPackage, len(source))
	for key, values := range source {
		if len(values) == 0 {
			result[key] = []pinnedDriverPackage{}
			continue
		}
		next := make([]pinnedDriverPackage, 0, len(values))
		for _, value := range values {
			next = append(next, pinnedDriverPackage{
				Version:     strings.TrimSpace(value.Version),
				DownloadURL: strings.TrimSpace(value.DownloadURL),
				SHA256:      strings.TrimSpace(value.SHA256),
				Policy:      normalizeDriverChecksumPolicy(value.Policy),
				Engine:      normalizeDriverEngine(value.Engine),
			})
		}
		result[key] = next
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

func resolveDriverVersionOptions(definition driverDefinition, repositoryURL string) ([]driverVersionOptionItem, error) {
	driverType := normalizeDriverType(definition.Type)
	if driverType == "" {
		return nil, fmt.Errorf("驱动类型为空")
	}

	optionMap := make(map[string]driverVersionOptionItem)
	optionKeys := make([]string, 0, 16)
	appendOption := func(version, downloadURL, sha256, source, year string) {
		versionText := strings.TrimSpace(version)
		urlText := strings.TrimSpace(downloadURL)
		if urlText == "" {
			urlText = strings.TrimSpace(definition.DefaultDownloadURL)
		}
		if urlText == "" && effectiveDriverEngine(definition) == driverEngineGo {
			urlText = fmt.Sprintf("builtin://activate/%s", optionalDriverPublicTypeName(driverType))
		}
		if versionText == "" {
			versionText = resolveDriverInstallVersion("", urlText, definition)
		}
		if versionText == "" && urlText == "" {
			return
		}
		versionKey := normalizeVersion(versionText)
		key := ""
		if versionKey != "" {
			key = "v:" + strings.ToLower(versionKey)
		} else {
			key = "u:" + urlText
		}
		if existing, ok := optionMap[key]; ok {
			if existing.Year == "" && strings.TrimSpace(year) != "" {
				existing.Year = strings.TrimSpace(year)
				optionMap[key] = existing
			}
			return
		}
		optionMap[key] = driverVersionOptionItem{
			Version:     versionText,
			DownloadURL: urlText,
			SHA256:      strings.TrimSpace(sha256),
			Source:      strings.TrimSpace(source),
			Year:        strings.TrimSpace(year),
		}
		optionKeys = append(optionKeys, key)
	}

	manifestVersions, _ := resolveManifestDriverVersionPackages(repositoryURL)
	if values := manifestVersions[driverType]; len(values) > 0 {
		expectedEngine := effectiveDriverEngine(definition)
		for _, value := range values {
			engine := normalizeDriverEngine(value.Engine)
			if engine != "" && expectedEngine != "" && engine != expectedEngine {
				continue
			}
			appendOption(value.Version, value.DownloadURL, value.SHA256, "manifest", "")
		}
	}

	appendOption(definition.PinnedVersion, definition.DefaultDownloadURL, definition.DownloadSHA256, "pinned", "")
	for _, recent := range resolveRecentDriverVersionOptions(definition, driverRecentVersionLimit) {
		if sameDriverVersion(recent.Version, definition.PinnedVersion) {
			continue
		}
		appendOption(recent.Version, recent.DownloadURL, recent.SHA256, recent.Source, recent.Year)
	}

	if len(optionKeys) == 0 {
		return nil, fmt.Errorf("未找到可用驱动版本")
	}

	recommendedVersion := strings.TrimSpace(definition.PinnedVersion)
	recommendedIndex := -1
	if recommendedVersion != "" {
		for index, key := range optionKeys {
			option := optionMap[key]
			if strings.EqualFold(strings.TrimSpace(option.Version), recommendedVersion) {
				recommendedIndex = index
				break
			}
		}
	}
	if recommendedIndex == -1 {
		recommendedIndex = 0
	}

	result := make([]driverVersionOptionItem, 0, len(optionKeys))
	for index, key := range optionKeys {
		option := optionMap[key]
		option.Recommended = index == recommendedIndex
		sizeBytes := resolveDriverVersionPackageSizeBytes(definition, option)
		if sizeBytes > 0 {
			option.PackageSizeBytes = sizeBytes
			option.PackageSizeText = formatSizeMB(sizeBytes)
		}
		option.DisplayLabel = buildDriverVersionDisplayLabel(option)
		result = append(result, option)
	}
	return result, nil
}

func buildDriverVersionDisplayLabel(option driverVersionOptionItem) string {
	label := strings.TrimSpace(option.Version)
	if label == "" {
		label = "未标注版本"
	}
	if strings.EqualFold(strings.TrimSpace(option.Source), "latest") {
		label += "（最新）"
	}
	if option.Recommended {
		label += "（推荐）"
	}
	return label
}

func resolveRecentDriverVersionOptions(definition driverDefinition, limit int) []driverVersionOptionItem {
	metas := resolveRecentDriverVersionMetas(definition.Type, limit)
	if len(metas) == 0 {
		return nil
	}
	result := make([]driverVersionOptionItem, 0, len(metas))
	for index, meta := range metas {
		source := "history"
		if index == 0 {
			source = "latest"
		}
		versionText, urlText, ok := resolveVersionedDriverOption(definition, meta.Version, source)
		if !ok {
			continue
		}
		result = append(result, driverVersionOptionItem{
			Version:     versionText,
			DownloadURL: urlText,
			Source:      source,
			Year:        strings.TrimSpace(meta.Year),
		})
	}
	return result
}

func resolveVersionedDriverOption(definition driverDefinition, version string, source string) (string, string, bool) {
	driverType := normalizeDriverType(definition.Type)
	if driverType == "" {
		return "", "", false
	}
	versionText := normalizeVersion(strings.TrimSpace(version))
	if versionText == "" {
		return "", "", false
	}

	urlText := strings.TrimSpace(definition.DefaultDownloadURL)
	if urlText == "" && effectiveDriverEngine(definition) == driverEngineGo {
		urlText = fmt.Sprintf("builtin://activate/%s", optionalDriverPublicTypeName(driverType))
	}
	if urlText == "" {
		return "", "", false
	}

	parsed, err := url.Parse(urlText)
	if err != nil || parsed == nil {
		return versionText, urlText, true
	}
	query := parsed.Query()
	channel := strings.TrimSpace(source)
	if channel == "" {
		channel = "history"
	}
	query.Set("channel", channel)
	query.Set("version", versionText)
	parsed.RawQuery = query.Encode()
	return versionText, parsed.String(), true
}

func sameDriverVersion(left, right string) bool {
	a := normalizeVersion(strings.TrimSpace(left))
	b := normalizeVersion(strings.TrimSpace(right))
	return a != "" && a == b
}

func resolveDriverVersionPackageSizeBytes(definition driverDefinition, option driverVersionOptionItem) int64 {
	driverType := normalizeDriverType(definition.Type)
	if driverType == "" || definition.BuiltIn {
		return 0
	}
	if !db.IsOptionalGoDriver(driverType) {
		return 0
	}

	version := normalizeVersion(strings.TrimSpace(option.Version))
	if version == "" {
		return 0
	}
	assetName := optionalDriverReleaseAssetName(driverType)
	if strings.TrimSpace(assetName) == "" {
		return 0
	}

	tag := "v" + version
	if sizeByAsset, ok := readReleaseAssetSizesFromCache("tag:" + tag); ok {
		return resolveOptionalDriverAssetSize(sizeByAsset, driverType)
	}

	// 下拉版本列表要求快速返回：仅复用已有缓存，不在这里触发网络请求。
	if strings.EqualFold(strings.TrimSpace(option.Source), "latest") {
		if sizeByAsset, ok := readReleaseAssetSizesFromCache("latest"); ok {
			return resolveOptionalDriverAssetSize(sizeByAsset, driverType)
		}
	}
	return 0
}

func resolveRecentDriverVersionMetas(driverType string, limit int) []goModuleVersionMeta {
	if limit <= 0 {
		limit = driverRecentVersionLimit
	}
	normalized := normalizeDriverType(driverType)
	if normalized == "" {
		return nil
	}
	if modulePath := strings.TrimSpace(driverGoModulePathMap[normalized]); modulePath != "" {
		if metas := fetchGoModuleVersionMetasCached(modulePath); len(metas) > 0 {
			if len(metas) > limit {
				return append([]goModuleVersionMeta(nil), metas[:limit]...)
			}
			return append([]goModuleVersionMeta(nil), metas...)
		}
	}
	if fallback := fallbackRecentDriverVersionsMap[normalized]; len(fallback) > 0 {
		if len(fallback) > limit {
			return append([]goModuleVersionMeta(nil), fallback[:limit]...)
		}
		return append([]goModuleVersionMeta(nil), fallback...)
	}
	if fallback := normalizeVersion(strings.TrimSpace(latestDriverVersionMap[normalized])); fallback != "" {
		return []goModuleVersionMeta{{Version: fallback}}
	}
	return nil
}

func triggerDriverVersionMetadataWarmup(definitions []driverDefinition) {
	if len(definitions) == 0 {
		return
	}

	modulePaths := make([]string, 0, len(definitions))
	seenModule := make(map[string]struct{}, len(definitions))
	for _, definition := range definitions {
		if definition.BuiltIn {
			continue
		}
		driverType := normalizeDriverType(definition.Type)
		if driverType == "" || !db.IsOptionalGoDriver(driverType) {
			continue
		}
		modulePath := strings.TrimSpace(driverGoModulePathMap[driverType])
		if modulePath == "" {
			continue
		}
		if _, ok := seenModule[modulePath]; ok {
			continue
		}
		seenModule[modulePath] = struct{}{}
		modulePaths = append(modulePaths, modulePath)
	}

	if len(modulePaths) == 0 {
		return
	}
	if !tryStartDriverVersionMetadataWarmup(time.Now()) {
		return
	}

	go func(paths []string) {
		defer finishDriverVersionMetadataWarmup()
		// 预热 latest 资产索引，便于版本列表命中大小缓存。
		_, _ = loadReleaseAssetSizesCached("latest", fetchLatestReleaseForDriverAssets)
		for _, modulePath := range paths {
			_ = fetchGoModuleVersionMetasCached(modulePath)
		}
	}(append([]string(nil), modulePaths...))
}

func tryStartDriverVersionMetadataWarmup(now time.Time) bool {
	driverVersionWarmupMu.Lock()
	defer driverVersionWarmupMu.Unlock()

	if driverVersionWarmup.Running {
		return false
	}
	if !driverVersionWarmup.LastStarted.IsZero() && now.Sub(driverVersionWarmup.LastStarted) < driverVersionWarmupMinInterval {
		return false
	}
	driverVersionWarmup.Running = true
	driverVersionWarmup.LastStarted = now
	return true
}

func finishDriverVersionMetadataWarmup() {
	driverVersionWarmupMu.Lock()
	driverVersionWarmup.Running = false
	driverVersionWarmupMu.Unlock()
}

func fetchGoModuleVersionMetasCached(modulePath string) []goModuleVersionMeta {
	key := strings.TrimSpace(modulePath)
	if key == "" {
		return nil
	}

	driverModuleVersionMu.RLock()
	cached, ok := driverModuleVersionMap[key]
	driverModuleVersionMu.RUnlock()
	if ok {
		ttl := driverModuleLatestCacheTTL
		if strings.TrimSpace(cached.Err) != "" {
			ttl = driverModuleLatestErrorCacheTTL
		}
		if time.Since(cached.LoadedAt) < ttl {
			if strings.TrimSpace(cached.Err) != "" {
				return nil
			}
			return append([]goModuleVersionMeta(nil), cached.Versions...)
		}
	}

	metas, err := fetchGoModuleVersionMetas(key)
	entry := goModuleVersionListCacheEntry{
		LoadedAt: time.Now(),
		Versions: append([]goModuleVersionMeta(nil), metas...),
	}
	if err != nil {
		entry.Err = err.Error()
	}

	driverModuleVersionMu.Lock()
	driverModuleVersionMap[key] = entry
	driverModuleVersionMu.Unlock()

	if err != nil {
		return nil
	}
	return append([]goModuleVersionMeta(nil), entry.Versions...)
}

func fetchGoModuleVersionMetas(modulePath string) ([]goModuleVersionMeta, error) {
	trimmed := strings.TrimSpace(modulePath)
	if trimmed == "" {
		return nil, fmt.Errorf("模块路径为空")
	}

	endpoint := fmt.Sprintf("https://proxy.golang.org/%s/@v/list", escapeGoModulePathForProxy(trimmed))
	client := newHTTPClientWithGlobalProxy(driverModuleLatestProbeTimeout)
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GoNavi-DriverManager")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("拉取模块版本列表失败：HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, driverModuleVersionListMaxSize))
	if err != nil {
		return nil, fmt.Errorf("读取模块版本列表失败：%w", err)
	}

	lines := strings.Split(strings.TrimSpace(string(body)), "\n")
	versions := make([]string, 0, len(lines))
	seen := make(map[string]struct{}, len(lines))
	for _, line := range lines {
		version := normalizeVersion(strings.TrimSpace(line))
		if version == "" {
			continue
		}
		normalizedSemver := "v" + version
		if !semver.IsValid(normalizedSemver) {
			continue
		}
		if semver.Prerelease(normalizedSemver) != "" {
			continue
		}
		if _, ok := seen[version]; ok {
			continue
		}
		seen[version] = struct{}{}
		versions = append(versions, version)
	}
	if len(versions) == 0 {
		return nil, fmt.Errorf("模块版本列表为空")
	}

	sort.SliceStable(versions, func(i, j int) bool {
		left := "v" + versions[i]
		right := "v" + versions[j]
		return semver.Compare(left, right) > 0
	})
	if len(versions) > driverRecentVersionLimit {
		versions = versions[:driverRecentVersionLimit]
	}

	metas := make([]goModuleVersionMeta, 0, len(versions))
	for _, version := range versions {
		metas = append(metas, goModuleVersionMeta{Version: version})
	}
	return metas, nil
}

func escapeGoModulePathForProxy(modulePath string) string {
	parts := strings.Split(modulePath, "/")
	for index, part := range parts {
		parts[index] = url.PathEscape(strings.TrimSpace(part))
	}
	return strings.Join(parts, "/")
}

func resolveDriverVersionOptionsFromReleases(definition driverDefinition) []driverVersionOptionItem {
	driverType := normalizeDriverType(definition.Type)
	if driverType == "" {
		return nil
	}

	releases, err := loadDriverReleaseListCached()
	if err != nil {
		return nil
	}

	assetName := optionalDriverReleaseAssetName(driverType)
	assetNames := optionalDriverReleaseAssetNames(driverType)
	result := make([]driverVersionOptionItem, 0, len(releases))
	for _, release := range releases {
		if release.Prerelease {
			continue
		}
		tag := strings.TrimSpace(release.TagName)
		if tag == "" || !releaseContainsAnyAsset(release, assetNames) {
			continue
		}
		result = append(result, driverVersionOptionItem{
			Version:     normalizeVersion(tag),
			DownloadURL: fmt.Sprintf("https://github.com/%s/releases/download/%s/%s", updateRepo, tag, assetName),
			Source:      "release",
		})
	}
	return result
}

func loadDriverReleaseListCached() ([]githubRelease, error) {
	driverReleaseListMu.RLock()
	cached := driverReleaseList
	driverReleaseListMu.RUnlock()
	if time.Since(cached.LoadedAt) < driverManifestCacheTTL {
		if strings.TrimSpace(cached.Err) != "" {
			return nil, errors.New(strings.TrimSpace(cached.Err))
		}
		return append([]githubRelease(nil), cached.Releases...), nil
	}

	driverReleaseListMu.Lock()
	defer driverReleaseListMu.Unlock()

	cached = driverReleaseList
	if time.Since(cached.LoadedAt) < driverManifestCacheTTL {
		if strings.TrimSpace(cached.Err) != "" {
			return nil, errors.New(strings.TrimSpace(cached.Err))
		}
		return append([]githubRelease(nil), cached.Releases...), nil
	}

	releases, err := fetchDriverReleaseList()
	entry := driverManifestReleaseListCache{
		LoadedAt: time.Now(),
		Releases: append([]githubRelease(nil), releases...),
	}
	if err != nil {
		entry.Err = err.Error()
	}
	driverReleaseList = entry

	if err != nil {
		return nil, err
	}
	return releases, nil
}

func fetchDriverReleaseList() ([]githubRelease, error) {
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases?per_page=30", updateRepo)
	client := newHTTPClientWithGlobalProxy(driverReleaseListProbeTimeout)
	req, err := http.NewRequest(http.MethodGet, apiURL, nil)
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
		return nil, fmt.Errorf("拉取驱动版本列表失败：HTTP %d", resp.StatusCode)
	}

	decoder := json.NewDecoder(io.LimitReader(resp.Body, 4<<20))
	var releases []githubRelease
	if err := decoder.Decode(&releases); err != nil {
		return nil, fmt.Errorf("解析驱动版本列表失败：%w", err)
	}
	return releases, nil
}

func releaseContainsAnyAsset(release githubRelease, assetNames []string) bool {
	normalizedNames := make([]string, 0, len(assetNames))
	for _, assetName := range assetNames {
		name := strings.TrimSpace(assetName)
		if name == "" {
			continue
		}
		normalizedNames = append(normalizedNames, name)
	}
	if len(normalizedNames) == 0 {
		return false
	}
	for _, asset := range release.Assets {
		assetName := strings.TrimSpace(asset.Name)
		for _, expected := range normalizedNames {
			if strings.EqualFold(assetName, expected) {
				return true
			}
		}
	}
	return false
}

func resolveDriverInstallVersion(version, downloadURL string, definition driverDefinition) string {
	if selected := strings.TrimSpace(version); selected != "" {
		return selected
	}

	if inferred := inferDriverInstallVersionByDownloadURL(downloadURL); inferred != "" {
		return inferred
	}

	if pinned := strings.TrimSpace(definition.PinnedVersion); pinned != "" {
		return pinned
	}
	if effectiveDriverEngine(definition) == driverEngineGo {
		return "go-embedded"
	}
	return "unknown"
}

func inferDriverInstallVersionByDownloadURL(downloadURL string) string {
	urlText := strings.TrimSpace(downloadURL)
	if urlText == "" {
		return ""
	}
	parsed, err := url.Parse(urlText)
	if err == nil && parsed != nil {
		switch strings.ToLower(strings.TrimSpace(parsed.Scheme)) {
		case "builtin":
			return "go-embedded"
		case "local":
			return "local"
		case "http", "https":
			if queryVersion := normalizeVersion(parsed.Query().Get("version")); queryVersion != "" {
				return queryVersion
			}
			if tag := extractReleaseTagFromPath(parsed.Path); tag != "" {
				return normalizeVersion(tag)
			}
		}
	}
	if tag := extractReleaseTagFromPath(urlText); tag != "" {
		return normalizeVersion(tag)
	}
	return ""
}

func extractReleaseTagFromPath(pathText string) string {
	segments := strings.Split(pathText, "/")
	for index := 0; index < len(segments)-1; index++ {
		if !strings.EqualFold(strings.TrimSpace(segments[index]), "download") {
			continue
		}
		tag := strings.TrimSpace(segments[index+1])
		if tag == "" || strings.EqualFold(tag, "latest") {
			continue
		}
		if decoded, err := url.PathUnescape(tag); err == nil && strings.TrimSpace(decoded) != "" {
			tag = strings.TrimSpace(decoded)
		}
		return tag
	}
	return ""
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

	packages, versions, loadErr := loadManifestPackageAndVersions(resolvedURL)
	entry := driverManifestCacheEntry{
		LoadedAt: time.Now(),
		Packages: copyPinnedPackageMap(packages),
		Versions: copyVersionPackageMap(versions),
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

func resolveManifestDriverVersionPackages(manifestURL string) (map[string][]pinnedDriverPackage, error) {
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
		return copyVersionPackageMap(cached.Versions), nil
	}

	packages, versions, loadErr := loadManifestPackageAndVersions(resolvedURL)
	entry := driverManifestCacheEntry{
		LoadedAt: time.Now(),
		Packages: copyPinnedPackageMap(packages),
		Versions: copyVersionPackageMap(versions),
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
	return versions, nil
}

func loadManifestPackageAndVersions(resolvedURL string) (map[string]pinnedDriverPackage, map[string][]pinnedDriverPackage, error) {
	content, err := loadManifestContent(resolvedURL)
	if err != nil {
		return nil, nil, err
	}

	var manifest driverManifestFile
	if err := json.Unmarshal(content, &manifest); err != nil {
		return nil, nil, fmt.Errorf("解析驱动清单失败：%w", err)
	}
	defaultEngine := normalizeDriverEngine(manifest.Engine)
	if defaultEngine == "" {
		defaultEngine = normalizeDriverEngine(manifest.DefaultEngine)
	}
	if defaultEngine == "" {
		defaultEngine = normalizeDriverEngine(manifest.DefaultEngine2)
	}

	result := make(map[string]pinnedDriverPackage)
	versionResult := make(map[string][]pinnedDriverPackage)
	for driverType, item := range manifest.Drivers {
		normalizedType := normalizeDriverType(driverType)
		if normalizedType == "" {
			continue
		}
		base := normalizeManifestDriverPackage(item.Version, item.DownloadURL, item.DownloadURL2, item.SHA256, item.ChecksumPolicy, item.ChecksumPolicy2, item.Engine, defaultEngine)
		result[normalizedType] = base
		versions := normalizeManifestDriverVersionList(item, base, defaultEngine)
		if len(versions) == 0 {
			versions = append(versions, base)
		}
		versionResult[normalizedType] = versions
	}
	return result, versionResult, nil
}

func normalizeManifestDriverPackage(version, downloadURL, downloadURL2, sha256, policy, policy2, engine, defaultEngine string) pinnedDriverPackage {
	urlText := strings.TrimSpace(downloadURL)
	if urlText == "" {
		urlText = strings.TrimSpace(downloadURL2)
	}
	policyText := strings.TrimSpace(policy)
	if policyText == "" {
		policyText = strings.TrimSpace(policy2)
	}
	engineText := normalizeDriverEngine(engine)
	if engineText == "" {
		engineText = defaultEngine
	}
	return pinnedDriverPackage{
		Version:     strings.TrimSpace(version),
		DownloadURL: urlText,
		SHA256:      strings.TrimSpace(sha256),
		Policy:      normalizeDriverChecksumPolicy(policyText),
		Engine:      engineText,
	}
}

func normalizeManifestDriverVersionList(item driverManifestItem, fallback pinnedDriverPackage, defaultEngine string) []pinnedDriverPackage {
	rawVersions := make([]driverManifestVersionItem, 0, len(item.Versions)+len(item.VersionList)+len(item.VersionList2)+len(item.VersionOptions)+len(item.VersionOptions2))
	rawVersions = append(rawVersions, item.Versions...)
	rawVersions = append(rawVersions, item.VersionList...)
	rawVersions = append(rawVersions, item.VersionList2...)
	rawVersions = append(rawVersions, item.VersionOptions...)
	rawVersions = append(rawVersions, item.VersionOptions2...)
	if len(rawVersions) == 0 {
		return nil
	}

	result := make([]pinnedDriverPackage, 0, len(rawVersions))
	seen := make(map[string]struct{}, len(rawVersions))
	for _, versionItem := range rawVersions {
		pkg := normalizeManifestDriverPackage(
			versionItem.Version,
			versionItem.DownloadURL,
			versionItem.DownloadURL2,
			versionItem.SHA256,
			versionItem.ChecksumPolicy,
			versionItem.ChecksumPolicy2,
			versionItem.Engine,
			defaultEngine,
		)
		if pkg.Version == "" {
			pkg.Version = fallback.Version
		}
		if pkg.DownloadURL == "" {
			pkg.DownloadURL = fallback.DownloadURL
		}
		if pkg.SHA256 == "" {
			pkg.SHA256 = fallback.SHA256
		}
		if pkg.Policy == "" {
			pkg.Policy = fallback.Policy
		}
		if pkg.Engine == "" {
			pkg.Engine = fallback.Engine
		}
		if pkg.Version == "" && pkg.DownloadURL == "" {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(pkg.Version)) + "|" + strings.TrimSpace(pkg.DownloadURL)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, pkg)
	}
	return result
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
			client := newHTTPClientWithGlobalProxy(12 * time.Second)
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

func installOptionalDriverAgentPackage(a *App, definition driverDefinition, selectedVersion string, resolvedDir string, downloadURL string) (installedDriverPackage, error) {
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
		Version:        strings.TrimSpace(selectedVersion),
		FilePath:       executablePath,
		FileName:       filepath.Base(executablePath),
		ExecutablePath: executablePath,
		DownloadURL:    strings.TrimSpace(downloadSource),
		SHA256:         hash,
		DownloadedAt:   time.Now().Format(time.RFC3339),
	}, nil
}

func installOptionalDriverAgentFromLocalPath(definition driverDefinition, filePath string, resolvedDir string, selectedVersion string) (installedDriverPackage, error) {
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)
	pathText := strings.TrimSpace(filePath)
	if pathText == "" {
		return installedDriverPackage{}, fmt.Errorf("本地驱动包路径为空")
	}
	if absPath, absErr := filepath.Abs(pathText); absErr == nil {
		pathText = absPath
	}
	info, statErr := os.Stat(pathText)
	if statErr != nil {
		return installedDriverPackage{}, fmt.Errorf("读取本地驱动包失败：%w", statErr)
	}

	executablePath, err := db.ResolveOptionalDriverAgentExecutablePath(resolvedDir, driverType)
	if err != nil {
		return installedDriverPackage{}, err
	}
	if mkErr := os.MkdirAll(filepath.Dir(executablePath), 0o755); mkErr != nil {
		return installedDriverPackage{}, fmt.Errorf("创建 %s 驱动目录失败：%w", displayName, mkErr)
	}

	sourcePath := pathText
	sourceName := filepath.Base(pathText)
	downloadSource := fmt.Sprintf("local://manual/%s", filepath.Base(pathText))
	if info.IsDir() {
		matchedPath, matchedEntry, resolveErr := resolveLocalDriverAgentFromDirectory(pathText, driverType)
		if resolveErr != nil {
			return installedDriverPackage{}, resolveErr
		}
		sourcePath = matchedPath
		sourceName = filepath.Base(matchedPath)
		downloadSource = fmt.Sprintf("local://manual-dir/%s", filepath.Base(pathText))
		if strings.TrimSpace(matchedEntry) != "" {
			downloadSource = downloadSource + "#" + matchedEntry
		}
	}

	if !info.IsDir() && strings.EqualFold(filepath.Ext(pathText), ".zip") {
		entryName, extractErr := installOptionalDriverAgentFromLocalZip(pathText, definition, executablePath)
		if extractErr != nil {
			return installedDriverPackage{}, extractErr
		}
		if strings.TrimSpace(entryName) != "" {
			downloadSource = downloadSource + "#" + entryName
		}
	} else {
		if copyErr := copyAgentBinary(sourcePath, executablePath); copyErr != nil {
			return installedDriverPackage{}, fmt.Errorf("导入本地驱动代理失败：%w", copyErr)
		}
	}

	hash, hashErr := hashFileSHA256(executablePath)
	if hashErr != nil {
		return installedDriverPackage{}, fmt.Errorf("计算 %s 驱动代理摘要失败：%w", displayName, hashErr)
	}
	return installedDriverPackage{
		DriverType:     driverType,
		Version:        strings.TrimSpace(selectedVersion),
		FilePath:       sourcePath,
		FileName:       sourceName,
		ExecutablePath: executablePath,
		DownloadURL:    downloadSource,
		SHA256:         hash,
		DownloadedAt:   time.Now().Format(time.RFC3339),
	}, nil
}

type localDriverCandidate struct {
	absPath       string
	relativePath  string
	depth         int
	inPlatformDir bool
}

func resolveLocalDriverAgentFromDirectory(directoryPath string, driverType string) (string, string, error) {
	root := strings.TrimSpace(directoryPath)
	if root == "" {
		return "", "", fmt.Errorf("本地驱动目录路径为空")
	}
	if absPath, absErr := filepath.Abs(root); absErr == nil {
		root = absPath
	}
	info, statErr := os.Stat(root)
	if statErr != nil {
		return "", "", fmt.Errorf("读取本地驱动目录失败：%w", statErr)
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("本地驱动目录路径不是目录：%s", root)
	}

	normalizedType := normalizeDriverType(driverType)
	displayDefinition, found := resolveDriverDefinition(normalizedType)
	if !found {
		displayDefinition = driverDefinition{Type: normalizedType, Name: normalizedType}
	}
	displayName := resolveDriverDisplayName(displayDefinition)
	platformDir := optionalDriverBundlePlatformDir(stdRuntime.GOOS)
	assetNameCandidates := optionalDriverReleaseAssetNames(normalizedType)
	baseNameCandidates := optionalDriverExecutableBaseNames(normalizedType)
	assetName := optionalDriverReleaseAssetName(normalizedType)

	exactRelativePath := filepath.ToSlash(filepath.Join(platformDir, assetName))
	for _, candidateName := range assetNameCandidates {
		exactPath := filepath.Join(root, platformDir, candidateName)
		if exactInfo, err := os.Stat(exactPath); err == nil && !exactInfo.IsDir() {
			return exactPath, filepath.ToSlash(filepath.Join(platformDir, candidateName)), nil
		}
	}

	for _, candidateName := range assetNameCandidates {
		rootAssetPath := filepath.Join(root, candidateName)
		if rootAssetInfo, err := os.Stat(rootAssetPath); err == nil && !rootAssetInfo.IsDir() {
			return rootAssetPath, filepath.ToSlash(candidateName), nil
		}
	}

	assetCandidates := make([]localDriverCandidate, 0, 8)
	baseCandidates := make([]localDriverCandidate, 0, 8)
	visited := 0
	walkErr := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		visited++
		if visited > localDriverDirectoryScanMaxEntries {
			return errLocalDriverDirScanLimit
		}
		if d.IsDir() {
			return nil
		}
		name := strings.TrimSpace(d.Name())
		if name == "" {
			return nil
		}

		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			relative = name
		}
		normalizedRelative := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(relative), "./"))
		if normalizedRelative == "" {
			normalizedRelative = name
		}
		normalizedLower := strings.ToLower(normalizedRelative)
		platformPrefix := strings.ToLower(platformDir) + "/"
		inPlatformDir := normalizedLower == strings.ToLower(platformDir) || strings.HasPrefix(normalizedLower, platformPrefix)
		depth := strings.Count(normalizedRelative, "/")
		candidate := localDriverCandidate{
			absPath:       path,
			relativePath:  normalizedRelative,
			depth:         depth,
			inPlatformDir: inPlatformDir,
		}

		for _, candidateName := range assetNameCandidates {
			if strings.EqualFold(name, candidateName) {
				assetCandidates = append(assetCandidates, candidate)
				return nil
			}
		}
		for _, candidateName := range baseNameCandidates {
			if strings.EqualFold(name, candidateName) {
				baseCandidates = append(baseCandidates, candidate)
				return nil
			}
		}
		return nil
	})
	if errors.Is(walkErr, errLocalDriverDirScanLimit) {
		return "", "", fmt.Errorf("本地驱动目录条目过多（超过 %d），请缩小目录范围或直接选择 zip/单文件", localDriverDirectoryScanMaxEntries)
	}
	if walkErr != nil {
		return "", "", fmt.Errorf("扫描本地驱动目录失败：%w", walkErr)
	}

	selectBest := func(candidates []localDriverCandidate) (localDriverCandidate, bool) {
		if len(candidates) == 0 {
			return localDriverCandidate{}, false
		}
		sort.Slice(candidates, func(i, j int) bool {
			left := candidates[i]
			right := candidates[j]
			if left.inPlatformDir != right.inPlatformDir {
				return left.inPlatformDir
			}
			if left.depth != right.depth {
				return left.depth < right.depth
			}
			leftRelative := strings.ToLower(left.relativePath)
			rightRelative := strings.ToLower(right.relativePath)
			if leftRelative != rightRelative {
				return leftRelative < rightRelative
			}
			return strings.ToLower(left.absPath) < strings.ToLower(right.absPath)
		})
		return candidates[0], true
	}

	if candidate, ok := selectBest(assetCandidates); ok {
		return candidate.absPath, candidate.relativePath, nil
	}
	if candidate, ok := selectBest(baseCandidates); ok {
		return candidate.absPath, candidate.relativePath, nil
	}

	return "", "", fmt.Errorf(
		"目录中未找到 %s 代理文件（优先路径 %s，候选文件名 %s / %s）",
		displayName,
		exactRelativePath,
		strings.Join(assetNameCandidates, " | "),
		strings.Join(baseNameCandidates, " | "),
	)
}

func installOptionalDriverAgentFromLocalZip(zipPath string, definition driverDefinition, executablePath string) (string, error) {
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return "", fmt.Errorf("打开本地驱动包失败：%w", err)
	}
	defer reader.Close()

	entryPath := optionalDriverBundleEntryPath(driverType)
	entryPaths := optionalDriverBundleEntryPaths(driverType)
	expectedBaseNames := optionalDriverReleaseAssetNames(driverType)
	findEntry := func() *zip.File {
		for _, file := range reader.File {
			name := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(file.Name), "./"))
			for _, expectedPath := range entryPaths {
				if name == expectedPath {
					return file
				}
			}
		}
		for _, file := range reader.File {
			name := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(file.Name), "./"))
			for _, expectedPath := range entryPaths {
				if strings.EqualFold(name, expectedPath) {
					return file
				}
			}
		}
		for _, file := range reader.File {
			name := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(file.Name), "./"))
			for _, expectedName := range expectedBaseNames {
				if strings.EqualFold(filepath.Base(name), expectedName) {
					return file
				}
			}
		}
		return nil
	}

	entry := findEntry()
	if entry == nil {
		return "", fmt.Errorf("本地驱动包内未找到 %s 代理文件（期望路径 %s）", displayName, entryPath)
	}

	src, err := entry.Open()
	if err != nil {
		return "", fmt.Errorf("读取本地驱动包条目失败：%w", err)
	}
	defer src.Close()

	tempPath := executablePath + ".tmp"
	_ = os.Remove(tempPath)
	dst, err := os.Create(tempPath)
	if err != nil {
		return "", fmt.Errorf("创建驱动代理临时文件失败：%w", err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("写入驱动代理失败：%w", err)
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("落盘驱动代理失败：%w", err)
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("关闭驱动代理文件失败：%w", err)
	}
	if chmodErr := os.Chmod(tempPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("设置驱动代理权限失败：%w", chmodErr)
	}
	if err := os.Rename(tempPath, executablePath); err != nil {
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("替换驱动代理失败：%w", err)
	}
	if chmodErr := os.Chmod(executablePath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		return "", fmt.Errorf("设置驱动代理权限失败：%w", chmodErr)
	}
	return filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(entry.Name), "./")), nil
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
	bundleURLs := resolveOptionalDriverBundleDownloadURLs()
	if len(bundleURLs) > 0 {
		for _, bundleURL := range bundleURLs {
			if a != nil {
				a.emitDriverDownloadProgress(driverType, "downloading", 20, 100, fmt.Sprintf("从驱动总包提取 %s 代理", displayName))
			}
			source, hash, bundleErr := downloadOptionalDriverAgentFromBundle(a, definition, bundleURL, executablePath)
			if bundleErr == nil {
				return source, hash, nil
			}
			downloadErrs = append(downloadErrs, fmt.Sprintf("%s: %s", bundleURL, strings.TrimSpace(bundleErr.Error())))
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

func downloadOptionalDriverAgentFromBundle(a *App, definition driverDefinition, bundleURL, executablePath string) (string, string, error) {
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)
	trimmedURL := strings.TrimSpace(bundleURL)
	if trimmedURL == "" {
		return "", "", fmt.Errorf("驱动总包下载地址为空")
	}

	bundleTempPath := executablePath + ".bundle.zip.tmp"
	_ = os.Remove(bundleTempPath)
	_, err := downloadFileWithHash(trimmedURL, bundleTempPath, func(downloaded, total int64) {
		if a == nil {
			return
		}
		scaledDownloaded, scaledTotal := scaleProgress(downloaded, total, 20, 78)
		a.emitDriverDownloadProgress(driverType, "downloading", scaledDownloaded, scaledTotal, fmt.Sprintf("下载 %s 驱动总包", displayName))
	})
	if err != nil {
		_ = os.Remove(bundleTempPath)
		return "", "", fmt.Errorf("下载驱动总包失败：%w", err)
	}
	defer func() { _ = os.Remove(bundleTempPath) }()

	reader, err := zip.OpenReader(bundleTempPath)
	if err != nil {
		return "", "", fmt.Errorf("打开驱动总包失败：%w", err)
	}
	defer reader.Close()

	entryPath := optionalDriverBundleEntryPath(driverType)
	entryPaths := optionalDriverBundleEntryPaths(driverType)
	expectedBaseNames := optionalDriverReleaseAssetNames(driverType)
	findEntry := func() *zip.File {
		for _, file := range reader.File {
			name := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(file.Name), "./"))
			for _, expectedPath := range entryPaths {
				if name == expectedPath {
					return file
				}
			}
		}
		for _, file := range reader.File {
			name := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(file.Name), "./"))
			for _, expectedPath := range entryPaths {
				if strings.EqualFold(name, expectedPath) {
					return file
				}
			}
		}
		for _, file := range reader.File {
			name := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(file.Name), "./"))
			for _, expectedName := range expectedBaseNames {
				if strings.EqualFold(filepath.Base(name), expectedName) {
					return file
				}
			}
		}
		return nil
	}

	entry := findEntry()
	if entry == nil {
		return "", "", fmt.Errorf("驱动总包内未找到 %s（期望路径 %s）", displayName, entryPath)
	}
	if a != nil {
		a.emitDriverDownloadProgress(driverType, "downloading", 84, 100, fmt.Sprintf("解压 %s 驱动代理", displayName))
	}

	src, err := entry.Open()
	if err != nil {
		return "", "", fmt.Errorf("读取驱动总包条目失败：%w", err)
	}
	defer src.Close()

	tempPath := executablePath + ".tmp"
	_ = os.Remove(tempPath)
	dst, err := os.Create(tempPath)
	if err != nil {
		return "", "", fmt.Errorf("创建驱动代理临时文件失败：%w", err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return "", "", fmt.Errorf("写入驱动代理失败：%w", err)
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return "", "", fmt.Errorf("落盘驱动代理失败：%w", err)
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tempPath)
		return "", "", fmt.Errorf("关闭驱动代理文件失败：%w", err)
	}
	if chmodErr := os.Chmod(tempPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		_ = os.Remove(tempPath)
		return "", "", fmt.Errorf("设置驱动代理权限失败：%w", chmodErr)
	}
	if err := os.Rename(tempPath, executablePath); err != nil {
		_ = os.Remove(tempPath)
		return "", "", fmt.Errorf("替换驱动代理失败：%w", err)
	}
	if chmodErr := os.Chmod(executablePath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		return "", "", fmt.Errorf("设置驱动代理权限失败：%w", chmodErr)
	}
	hash, err := hashFileSHA256(executablePath)
	if err != nil {
		return "", "", fmt.Errorf("计算驱动代理摘要失败：%w", err)
	}
	source := fmt.Sprintf("%s#%s", trimmedURL, filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(entry.Name), "./")))
	return source, hash, nil
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
	case "clickhouse":
		return "gonavi_clickhouse_driver", nil
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

func optionalDriverPublicTypeName(driverType string) string {
	switch normalizeDriverType(driverType) {
	case "diros":
		return "doris"
	default:
		return normalizeDriverType(driverType)
	}
}

func optionalDriverExecutableBaseNameForType(typeName string) string {
	base := strings.TrimSpace(typeName)
	if base == "" {
		base = "unknown"
	}
	name := fmt.Sprintf("%s-driver-agent", base)
	if stdRuntime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func optionalDriverReleaseAssetNameForType(typeName string, goos string, goarch string) string {
	base := strings.TrimSpace(typeName)
	if base == "" {
		base = "unknown"
	}
	name := fmt.Sprintf("%s-driver-agent-%s-%s", base, goos, goarch)
	if strings.EqualFold(goos, "windows") {
		return name + ".exe"
	}
	return name
}

func optionalDriverExecutableBaseNames(driverType string) []string {
	names := make([]string, 0, 2)
	seen := make(map[string]struct{}, 2)
	appendName := func(typeName string) {
		name := optionalDriverExecutableBaseNameForType(typeName)
		if strings.TrimSpace(name) == "" {
			return
		}
		if _, ok := seen[name]; ok {
			return
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}

	appendName(optionalDriverPublicTypeName(driverType))
	return names
}

func optionalDriverReleaseAssetNames(driverType string) []string {
	names := make([]string, 0, 2)
	seen := make(map[string]struct{}, 2)
	appendName := func(typeName string) {
		name := optionalDriverReleaseAssetNameForType(typeName, stdRuntime.GOOS, stdRuntime.GOARCH)
		if strings.TrimSpace(name) == "" {
			return
		}
		if _, ok := seen[name]; ok {
			return
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}

	appendName(optionalDriverPublicTypeName(driverType))
	return names
}

func optionalDriverExecutableBaseName(driverType string) string {
	names := optionalDriverExecutableBaseNames(driverType)
	if len(names) == 0 {
		return optionalDriverExecutableBaseNameForType("")
	}
	return names[0]
}

func optionalDriverReleaseAssetName(driverType string) string {
	names := optionalDriverReleaseAssetNames(driverType)
	if len(names) == 0 {
		return optionalDriverReleaseAssetNameForType("", stdRuntime.GOOS, stdRuntime.GOARCH)
	}
	return names[0]
}

func optionalDriverBundlePlatformDir(goos string) string {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "windows":
		return "Windows"
	case "darwin":
		return "MacOS"
	case "linux":
		return "Linux"
	default:
		return "Unknown"
	}
}

func optionalDriverBundleEntryPaths(driverType string) []string {
	platformDir := optionalDriverBundlePlatformDir(stdRuntime.GOOS)
	assetNames := optionalDriverReleaseAssetNames(driverType)
	result := make([]string, 0, len(assetNames))
	seen := make(map[string]struct{}, len(assetNames))
	for _, assetName := range assetNames {
		entry := filepath.ToSlash(filepath.Join(platformDir, assetName))
		if _, ok := seen[entry]; ok {
			continue
		}
		seen[entry] = struct{}{}
		result = append(result, entry)
	}
	return result
}

func optionalDriverBundleEntryPath(driverType string) string {
	paths := optionalDriverBundleEntryPaths(driverType)
	if len(paths) == 0 {
		return filepath.ToSlash(filepath.Join(optionalDriverBundlePlatformDir(stdRuntime.GOOS), optionalDriverReleaseAssetName(driverType)))
	}
	return paths[0]
}

func resolveOptionalDriverAssetSize(sizeByAsset map[string]int64, driverType string) int64 {
	if len(sizeByAsset) == 0 {
		return 0
	}
	for _, assetName := range optionalDriverReleaseAssetNames(driverType) {
		sizeBytes := sizeByAsset[assetName]
		if sizeBytes > 0 {
			return sizeBytes
		}
	}
	return 0
}

func resolveOptionalDriverBundleDownloadURLs() []string {
	candidates := make([]string, 0, 2)
	seen := make(map[string]struct{}, 2)
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

	currentVersion := normalizeVersion(getCurrentVersion())
	if currentVersion != "" && currentVersion != "0.0.0" {
		appendURL(fmt.Sprintf("https://github.com/Syngnat/GoNavi/releases/download/v%s/%s", currentVersion, optionalDriverBundleAssetName))
	}
	appendURL(fmt.Sprintf("https://github.com/Syngnat/GoNavi/releases/latest/download/%s", optionalDriverBundleAssetName))
	return candidates
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

	assetNames := optionalDriverReleaseAssetNames(driverType)
	currentVersion := normalizeVersion(getCurrentVersion())
	if currentVersion != "" && currentVersion != "0.0.0" {
		for _, assetName := range assetNames {
			appendURL(fmt.Sprintf("https://github.com/Syngnat/GoNavi/releases/download/v%s/%s", currentVersion, assetName))
		}
	}
	for _, assetName := range assetNames {
		appendURL(fmt.Sprintf("https://github.com/Syngnat/GoNavi/releases/latest/download/%s", assetName))
	}
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
	names := optionalDriverExecutableBaseNames(driverType)
	assetNames := optionalDriverReleaseAssetNames(driverType)
	pathTypeNames := make([]string, 0, 2)
	seenPathType := make(map[string]struct{}, 2)
	appendPathType := func(typeName string) {
		trimmed := strings.TrimSpace(typeName)
		if trimmed == "" {
			return
		}
		if _, ok := seenPathType[trimmed]; ok {
			return
		}
		seenPathType[trimmed] = struct{}{}
		pathTypeNames = append(pathTypeNames, trimmed)
	}
	appendPathType(optionalDriverPublicTypeName(driverType))

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
		for _, name := range names {
			appendPath(filepath.Join(exeDir, name))
		}
		for _, assetName := range assetNames {
			appendPath(filepath.Join(exeDir, assetName))
		}
		for _, typeName := range pathTypeNames {
			for _, name := range names {
				appendPath(filepath.Join(exeDir, "drivers", typeName, name))
			}
			for _, assetName := range assetNames {
				appendPath(filepath.Join(exeDir, "drivers", typeName, assetName))
			}
		}

		resourcesDir := filepath.Clean(filepath.Join(exeDir, "..", "Resources"))
		for _, typeName := range pathTypeNames {
			for _, name := range names {
				appendPath(filepath.Join(resourcesDir, "drivers", typeName, name))
			}
			for _, assetName := range assetNames {
				appendPath(filepath.Join(resourcesDir, "drivers", typeName, assetName))
			}
		}
	}
	if wd, err := os.Getwd(); err == nil && strings.TrimSpace(wd) != "" {
		for _, assetName := range assetNames {
			appendPath(filepath.Join(wd, "dist", assetName))
			appendPath(filepath.Join(wd, assetName))
		}
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
			sizeBytes := resolveOptionalDriverAssetSize(sizeByAsset, driverType)
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
		if indexSizes, indexErr := fetchDriverBundleAssetSizeIndex(release); indexErr == nil {
			for name, size := range indexSizes {
				trimmedName := strings.TrimSpace(name)
				if trimmedName == "" || size <= 0 {
					continue
				}
				entry.SizeByKey[trimmedName] = size
			}
		}
	}

	driverReleaseSizeMu.Lock()
	driverReleaseSizeMap[key] = entry
	driverReleaseSizeMu.Unlock()

	if err != nil {
		return nil, err
	}
	return entry.SizeByKey, nil
}

func readReleaseAssetSizesFromCache(cacheKey string) (map[string]int64, bool) {
	key := strings.TrimSpace(cacheKey)
	if key == "" {
		return nil, false
	}

	driverReleaseSizeMu.RLock()
	cached, ok := driverReleaseSizeMap[key]
	driverReleaseSizeMu.RUnlock()
	if !ok {
		return nil, false
	}

	ttl := driverReleaseAssetSizeCacheTTL
	if strings.TrimSpace(cached.Err) != "" {
		ttl = driverReleaseAssetSizeErrorCacheTTL
	}
	if time.Since(cached.LoadedAt) >= ttl {
		return nil, false
	}
	if strings.TrimSpace(cached.Err) != "" {
		return nil, false
	}
	return cached.SizeByKey, true
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

func fetchDriverBundleAssetSizeIndex(release *githubRelease) (map[string]int64, error) {
	if release == nil {
		return nil, fmt.Errorf("release 为空")
	}
	indexURL := ""
	for _, asset := range release.Assets {
		if strings.EqualFold(strings.TrimSpace(asset.Name), optionalDriverBundleIndexAssetName) {
			indexURL = strings.TrimSpace(asset.BrowserDownloadURL)
			break
		}
	}
	if indexURL == "" {
		return nil, fmt.Errorf("未找到驱动总包索引资产")
	}

	client := newHTTPClientWithGlobalProxy(driverReleaseAssetSizeProbeTimeout)
	req, err := http.NewRequest(http.MethodGet, indexURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GoNavi-DriverManager")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("拉取驱动总包索引失败：HTTP %d", resp.StatusCode)
	}

	limited := io.LimitReader(resp.Body, driverBundleIndexMaxSize)
	decoder := json.NewDecoder(limited)
	var index driverBundleAssetIndex
	if err := decoder.Decode(&index); err != nil {
		return nil, fmt.Errorf("解析驱动总包索引失败：%w", err)
	}
	if len(index.Assets) == 0 {
		return nil, fmt.Errorf("驱动总包索引为空")
	}
	return index.Assets, nil
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

	client := newHTTPClientWithGlobalProxy(driverReleaseAssetSizeProbeTimeout)
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
