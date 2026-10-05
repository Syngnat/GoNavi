package app

import (
	"errors"
	"sync"
	"time"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
)

const (
	// 默认使用内置 manifest，避免依赖网络与外部仓库 404。
	defaultDriverManifestURLValue        = "builtin://manifest"
	driverReleaseRepo                    = "Syngnat/GoNavi-DriverAgents"
	driverReleaseMirrorBaseURL           = "https://download.syngnat.top/drivers/releases/download"
	driverReleaseMirrorLatestIndexURL    = "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fdrivers%2Freleases%2Flatest%2FGoNavi-DriverAgents-Index.json"
	driverReleaseMirrorDevBaseURL        = "https://download.syngnat.top/drivers/dev/releases/download"
	driverReleaseMirrorDevLatestIndexURL = "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fdrivers%2Fdev%2Freleases%2Flatest%2FGoNavi-DriverAgents-Index.json"
	driverReleaseLatestAPIURL            = "https://api.github.com/repos/" + driverReleaseRepo + "/releases/latest"
	driverReleaseDevTag                  = "dev-latest"
	// 总包自 v1.0.2 起为 LZMA2 固实 7z（ZIP 总包已逼近 GitHub 单资产 2 GiB 上限）。
	optionalDriverBundleAssetName       = "GoNavi-DriverAgents.7z"
	optionalDriverBundleIndexAssetName  = "GoNavi-DriverAgents-Index.json"
	optionalDriverBundleDownloadTimeout = 15 * time.Minute
	optionalDriverBundleCacheMaxAge     = 7 * 24 * time.Hour
	optionalDriverBundleCacheMaxFiles   = 4
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
	driverModuleVersionFetchLimit       = 64
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
	duckDBWindowsLibraryVersion         = "v1.4.4"
	duckDBWindowsLibraryArchiveURL      = "https://github.com/duckdb/duckdb/releases/download/" + duckDBWindowsLibraryVersion + "/libduckdb-windows-amd64.zip"
	duckDBWindowsSupportDLLName         = "duckdb.dll"
)

const builtinDriverManifestJSON = `{
  "engine": "go",
  "drivers": {
    "mysql":     { "engine": "go", "version": "1.9.3", "checksumPolicy": "off" },
    "goldendb":  { "engine": "go", "version": "1.9.3", "checksumPolicy": "off" },
    "mariadb":   { "engine": "go", "version": "1.9.3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/mariadb" },
    "oceanbase": { "engine": "go", "version": "1.9.3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/oceanbase" },
    "doris":     { "engine": "go", "version": "1.9.3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/doris" },
    "starrocks": { "engine": "go", "version": "1.9.3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/starrocks" },
    "sphinx":    { "engine": "go", "version": "1.9.3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/sphinx" },
    "sqlserver": { "engine": "go", "version": "1.9.6", "checksumPolicy": "off", "downloadUrl": "builtin://activate/sqlserver" },
    "sqlite":    { "engine": "go", "version": "1.44.3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/sqlite" },
    "duckdb":    { "engine": "go", "version": "2.5.6", "checksumPolicy": "off", "downloadUrl": "builtin://activate/duckdb" },
    "dameng":    { "engine": "go", "version": "1.8.22", "checksumPolicy": "off", "downloadUrl": "builtin://activate/dameng" },
    "kingbase":  { "engine": "go", "version": "0.0.0-20201021123113-29bd62a876c3", "checksumPolicy": "off", "downloadUrl": "builtin://activate/kingbase" },
    "highgo":    { "engine": "go", "version": "0.0.0-local", "checksumPolicy": "off", "downloadUrl": "builtin://activate/highgo" },
    "vastbase":  { "engine": "go", "version": "1.11.1", "checksumPolicy": "off", "downloadUrl": "builtin://activate/vastbase" },
    "opengauss": { "engine": "go", "version": "1.11.1", "checksumPolicy": "off", "downloadUrl": "builtin://activate/opengauss" },
    "gaussdb":   { "engine": "go", "version": "v1.0.0-rc1", "checksumPolicy": "off", "downloadUrl": "builtin://activate/gaussdb" },
    "iris":      { "engine": "go", "version": "0.2.1", "checksumPolicy": "off", "downloadUrl": "builtin://activate/iris" },
    "cache":     { "engine": "go", "version": "0.2.1", "checksumPolicy": "off", "downloadUrl": "builtin://activate/cache" },
    "mongodb":   { "engine": "go", "version": "1.17.9", "checksumPolicy": "off", "downloadUrl": "builtin://activate/mongodb" },
    "tdengine":  { "engine": "go", "version": "3.7.8", "checksumPolicy": "off", "downloadUrl": "builtin://activate/tdengine" },
    "iotdb":     { "engine": "go", "version": "1.3.7", "checksumPolicy": "off", "downloadUrl": "builtin://activate/iotdb" },
    "clickhouse": { "engine": "go", "version": "2.43.1", "checksumPolicy": "off", "downloadUrl": "builtin://activate/clickhouse" },
    "elasticsearch": { "engine": "go", "version": "8.19.6", "checksumPolicy": "off", "downloadUrl": "builtin://activate/elasticsearch" },
    "trino": { "engine": "go", "version": "0.333.0", "checksumPolicy": "off", "downloadUrl": "builtin://activate/trino" },
    "kafka": { "engine": "go", "version": "0.4.51", "checksumPolicy": "off", "downloadUrl": "builtin://activate/kafka" },
    "rocketmq": { "engine": "go", "version": "2.1.2", "checksumPolicy": "off", "downloadUrl": "builtin://activate/rocketmq" },
    "pulsar": { "engine": "go", "version": "0.21.0", "checksumPolicy": "off", "downloadUrl": "builtin://activate/pulsar" }
  }
}`

var (
	driverManifestCacheMu        sync.RWMutex
	driverManifestCache          = make(map[string]driverManifestCacheEntry)
	driverReleaseSizeMu          sync.RWMutex
	driverReleaseSizeMap         = make(map[string]driverReleaseAssetSizeCacheEntry)
	driverReleaseListMu          sync.RWMutex
	driverReleaseList            = driverManifestReleaseListCache{}
	driverModuleLatestMu         sync.RWMutex
	driverModuleLatestMap        = make(map[string]goModuleLatestVersionCacheEntry)
	driverModuleVersionMu        sync.RWMutex
	driverModuleVersionMap       = make(map[string]goModuleVersionListCacheEntry)
	driverVersionWarmupMu        sync.Mutex
	driverVersionWarmup          = driverVersionWarmupState{}
	errLocalDriverDirScanLimit   = errors.New("local_driver_directory_scan_limit_exceeded")
	legacyDriverRuntimeTextOnce  sync.Once
	legacyDriverRuntimeLocalizer *i18n.Localizer
)

var optionalDriverSourceBuildTimeout = 8 * time.Minute

var validateOptionalDriverAgentExecutableFunc = db.ValidateOptionalDriverAgentExecutable

var resolveOptionalDriverAgentExecutablePathFunc = db.ResolveOptionalDriverAgentExecutablePath

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
	"mysql":         "1.9.3",
	"goldendb":      "1.9.3",
	"mariadb":       "1.9.3",
	"oceanbase":     "1.9.3",
	"diros":         "1.9.3",
	"starrocks":     "1.9.3",
	"sphinx":        "1.9.3",
	"sqlserver":     "1.9.6",
	"sqlite":        "1.46.1",
	"duckdb":        "2.5.6",
	"dameng":        "1.8.22",
	"kingbase":      "0.0.0-20201021123113-29bd62a876c3",
	"highgo":        "0.0.0-local",
	"vastbase":      "1.11.2",
	"opengauss":     "1.11.1",
	"gaussdb":       "v1.0.0-rc1",
	"iris":          "0.2.1",
	"cache":         "0.2.1",
	"mongodb":       "2.5.0",
	"tdengine":      "3.7.8",
	"iotdb":         "1.3.7",
	"clickhouse":    "2.43.1",
	"elasticsearch": "8.19.6",
	"trino":         "0.333.0",
	"kafka":         "0.4.51",
	"rocketmq":      "2.1.2",
	"pulsar":        "0.21.0",
	"oracle":        "2.9.0",
	"postgres":      "1.11.2",
	"redis":         "9.17.3",
}

var driverGoModulePathMap = map[string]string{
	"goldendb":      "github.com/go-sql-driver/mysql",
	"mariadb":       "github.com/go-sql-driver/mysql",
	"oceanbase":     "github.com/go-sql-driver/mysql",
	"diros":         "github.com/go-sql-driver/mysql",
	"starrocks":     "github.com/go-sql-driver/mysql",
	"sphinx":        "github.com/go-sql-driver/mysql",
	"sqlserver":     "github.com/microsoft/go-mssqldb",
	"sqlite":        "modernc.org/sqlite",
	"duckdb":        "github.com/duckdb/duckdb-go/v2",
	"dameng":        "gitee.com/chunanyong/dm",
	"kingbase":      "gitea.com/kingbase/gokb",
	"highgo":        "github.com/highgo/pq-sm3",
	"vastbase":      "github.com/lib/pq",
	"opengauss":     "github.com/lib/pq",
	"gaussdb":       "github.com/HuaweiCloudDeveloper/gaussdb-go",
	"iris":          "github.com/caretdev/go-irisnative",
	"cache":         "github.com/caretdev/go-irisnative",
	"mongodb":       "go.mongodb.org/mongo-driver/v2",
	"tdengine":      "github.com/taosdata/driver-go/v3",
	"iotdb":         "github.com/apache/iotdb-client-go",
	"clickhouse":    "github.com/ClickHouse/clickhouse-go/v2",
	"elasticsearch": "github.com/elastic/go-elasticsearch/v8",
	"trino":         "github.com/trinodb/trino-go-client",
	"kafka":         "github.com/segmentio/kafka-go",
	"rocketmq":      "github.com/apache/rocketmq-client-go/v2",
	"pulsar":        "github.com/apache/pulsar-client-go",
}

var driverGoModuleAliasPathMap = map[string][]string{
	"oceanbase": {
		"github.com/sijms/go-ora/v2",
	},
	"mongodb": {
		"go.mongodb.org/mongo-driver",
	},
}

var driverExtraHistoryLimitMap = map[string]int{
	"mongodb":  10,
	"tdengine": 30,
}

var fallbackRecentDriverVersionsMap = map[string][]goModuleVersionMeta{
	"mongodb": {
		{Version: "2.5.0"},
		{Version: "2.4.2"},
		{Version: "2.4.1"},
		{Version: "2.4.0"},
		{Version: "2.3.1"},
		{Version: "1.17.9"},
		{Version: "1.17.8"},
		{Version: "1.17.7"},
		{Version: "1.17.6"},
		{Version: "1.17.4"},
		{Version: "1.17.3"},
		{Version: "1.17.2"},
		{Version: "1.17.1"},
		{Version: "1.17.0"},
		{Version: "1.16.1"},
	},
	"tdengine": {
		{Version: "3.8.0"},
		{Version: "3.7.8"},
		{Version: "3.7.7"},
		{Version: "3.7.6"},
		{Version: "3.7.5"},
		{Version: "3.7.4"},
		{Version: "3.7.3"},
		{Version: "3.7.2"},
		{Version: "3.7.1"},
		{Version: "3.7.0"},
		{Version: "3.6.0"},
		{Version: "3.5.8"},
		{Version: "3.5.7"},
		{Version: "3.5.6"},
		{Version: "3.5.5"},
		{Version: "3.5.4"},
		{Version: "3.5.3"},
		{Version: "3.5.2"},
		{Version: "3.5.1"},
		{Version: "3.5.0"},
		{Version: "3.3.1"},
		{Version: "3.1.0"},
		{Version: "3.0.4"},
		{Version: "3.0.3"},
		{Version: "3.0.2"},
		{Version: "3.0.1"},
		{Version: "3.0.0"},
	},
}
