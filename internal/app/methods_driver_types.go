package app

import (
	"time"
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
	AgentRevision  string `json:"agentRevision,omitempty"`
	FilePath       string `json:"filePath"`
	FileName       string `json:"fileName"`
	ExecutablePath string `json:"executablePath,omitempty"`
	DownloadURL    string `json:"downloadUrl,omitempty"`
	SHA256         string `json:"sha256,omitempty"`
	DownloadedAt   string `json:"downloadedAt"`
}

type driverStatusItem struct {
	Type                string `json:"type"`
	Name                string `json:"name"`
	Engine              string `json:"engine,omitempty"`
	BuiltIn             bool   `json:"builtIn"`
	PinnedVersion       string `json:"pinnedVersion,omitempty"`
	InstalledVersion    string `json:"installedVersion,omitempty"`
	PackageSizeText     string `json:"packageSizeText,omitempty"`
	RuntimeAvailable    bool   `json:"runtimeAvailable"`
	PackageInstalled    bool   `json:"packageInstalled"`
	Connectable         bool   `json:"connectable"`
	DefaultDownloadURL  string `json:"defaultDownloadUrl,omitempty"`
	InstallDir          string `json:"installDir,omitempty"`
	PackagePath         string `json:"packagePath,omitempty"`
	PackageFileName     string `json:"packageFileName,omitempty"`
	ExecutablePath      string `json:"executablePath,omitempty"`
	DownloadedAt        string `json:"downloadedAt,omitempty"`
	AgentRevision       string `json:"agentRevision,omitempty"`
	ExpectedRevision    string `json:"expectedRevision,omitempty"`
	NeedsUpdate         bool   `json:"needsUpdate,omitempty"`
	OptionalUpdate      bool   `json:"optionalUpdate,omitempty"`
	UpdateReason        string `json:"updateReason,omitempty"`
	AffectedConnections int    `json:"affectedConnections,omitempty"`
	ActiveConnections   int    `json:"activeConnections,omitempty"`
	ReasonCode          string `json:"reasonCode,omitempty"`
	Message             string `json:"message,omitempty"`
}

type driverNetworkProbeItem struct {
	ProbeCode   string `json:"probeCode,omitempty"`
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

const (
	driverStatusReasonSlimBuildMissingDriver = "slim_build_missing_driver"
	driverNetworkProbeCodeDownloadMirror     = "download_mirror"
	driverNetworkProbeNameDownloadMirror     = "GoNavi Mirror"
	driverNetworkProbeCodeGitHubAPI          = "github_api"
	driverNetworkProbeCodeGitHubRelease      = "github_release"
	driverNetworkProbeCodeGitHubReleaseAsset = "github_release_asset"
	driverNetworkProbeCodeGoModuleProxy      = "go_module_proxy"
)

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
	LoadErr  error
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
	LoadedAt           time.Time
	SizeByKey          map[string]int64
	SHA256ByKey        map[string]string
	PublishedAssets    map[string]bool
	MirrorDownloadURLs map[string]string
	Err                string
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
	TagName       string            `json:"tagName,omitempty"`
	MirrorTagName string            `json:"mirrorTagName,omitempty"`
	Assets        map[string]int64  `json:"assets"`
	AssetSHA256   map[string]string `json:"assetSha256,omitempty"`
}
