package db

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"GoNavi-Wails/internal/appdata"
)

// coreBuiltinDrivers 是始终内置可用的核心驱动，无需额外安装即可使用。
var coreBuiltinDrivers = map[string]struct{}{
	"mysql":    {},
	"goldendb": {},
	"redis":    {},
	"oracle":   {},
	"postgres": {},
	"chroma":   {},
	"qdrant":   {},
	"milvus":   {},
	"rocketmq": {},
	"mqtt":     {},
	"kafka":    {},
	"rabbitmq": {},
}

// optionalGoDrivers 表示需要用户“安装启用”后才能使用的纯 Go 驱动。
// 注意：这是一种运行时门控（installed.json 标记），并不减少主二进制体积。
var optionalGoDrivers = map[string]struct{}{
	"mariadb":       {},
	"oceanbase":     {},
	"diros":         {},
	"starrocks":     {},
	"sphinx":        {},
	"sqlserver":     {},
	"sqlite":        {},
	"duckdb":        {},
	"dameng":        {},
	"kingbase":      {},
	"highgo":        {},
	"vastbase":      {},
	"opengauss":     {},
	"gaussdb":       {},
	"iris":          {},
	"mongodb":       {},
	"tdengine":      {},
	"iotdb":         {},
	"clickhouse":    {},
	"elasticsearch": {},
	"trino":         {},
}

// optionalDriverAgentRevisions 记录 GoNavi 对各可选 driver-agent 包装逻辑的兼容版本。
// 该 map 由 tools/generate-driver-agent-revisions.sh 按 driver-agent 源码依赖自动生成，
// 避免人工判断需要 bump 哪个驱动 revision。
var optionalDriverAgentRevisions = map[string]string{}

var (
	externalDriverDirMu sync.RWMutex
	externalDriverDir   string
)

func normalizeRuntimeDriverType(driverType string) string {
	normalized := strings.ToLower(strings.TrimSpace(driverType))
	switch normalized {
	case "doris":
		return "diros"
	case "postgresql", "pg", "pq", "pgx":
		return "postgres"
	case "mssql", "sql_server", "sql-server":
		return "sqlserver"
	case "sqlite3":
		return "sqlite"
	case "dm", "dm8":
		return "dameng"
	case "sphinxql":
		return "sphinx"
	case "kingbase8", "kingbasees", "kingbasev8":
		return "kingbase"
	case "opengauss", "open_gauss", "open-gauss":
		return "opengauss"
	case "gaussdb", "gauss_db", "gauss-db":
		return "gaussdb"
	case "goldendb", "greatdb", "gdb":
		return "goldendb"
	case "intersystems", "intersystemsiris", "inter-systems-iris", "inter-systems":
		return "iris"
	case "elastic":
		return "elasticsearch"
	case "chromadb", "chroma-db":
		return "chroma"
	case "qdrantdb", "qdrant-db":
		return "qdrant"
	case "milvusdb", "milvus-db":
		return "milvus"
	case "rocketmq", "rocket-mq", "rocket_mq", "apache-rocketmq", "apache_rocketmq", "rmq":
		return "rocketmq"
	case "mqtt", "mqtts":
		return "mqtt"
	case "apache-iotdb", "apache_iotdb", "iotdb":
		return "iotdb"
	case "kafka", "apache-kafka", "apache_kafka":
		return "kafka"
	case "rabbitmq", "rabbit-mq", "rabbit_mq":
		return "rabbitmq"
	default:
		return normalized
	}
}

func driverDisplayName(driverType string) string {
	switch normalizeRuntimeDriverType(driverType) {
	case "mysql":
		return "MySQL"
	case "goldendb":
		return "GoldenDB"
	case "oracle":
		return "Oracle"
	case "redis":
		return "Redis"
	case "mariadb":
		return "MariaDB"
	case "oceanbase":
		return "OceanBase"
	case "diros":
		return "Doris"
	case "starrocks":
		return "StarRocks"
	case "sphinx":
		return "Sphinx"
	case "postgres":
		return "PostgreSQL"
	case "sqlserver":
		return "SQL Server"
	case "sqlite":
		return "SQLite"
	case "duckdb":
		return "DuckDB"
	case "dameng":
		return "Dameng"
	case "kingbase":
		return "Kingbase"
	case "highgo":
		return "HighGo"
	case "vastbase":
		return "Vastbase"
	case "opengauss":
		return "OpenGauss"
	case "gaussdb":
		return "GaussDB"
	case "iris":
		return "InterSystems IRIS"
	case "mongodb":
		return "MongoDB"
	case "tdengine":
		return "TDengine"
	case "iotdb":
		return "Apache IoTDB"
	case "clickhouse":
		return "ClickHouse"
	case "elasticsearch":
		return "Elasticsearch"
	case "trino":
		return "Trino"
	case "chroma":
		return "Chroma"
	case "qdrant":
		return "Qdrant"
	case "milvus":
		return "Milvus"
	case "rocketmq":
		return "RocketMQ"
	case "mqtt":
		return "MQTT"
	case "kafka":
		return "Kafka"
	case "rabbitmq":
		return "RabbitMQ"
	default:
		return strings.ToUpper(strings.TrimSpace(driverType))
	}
}

// IsOptionalGoDriver 返回指定驱动类型是否为可选的纯 Go 驱动。
// 可选驱动需要用户在驱动管理界面点击“安装启用”后才能使用。
func IsOptionalGoDriver(driverType string) bool {
	_, ok := optionalGoDrivers[normalizeRuntimeDriverType(driverType)]
	return ok
}

func IsOptionalGoDriverBuildIncluded(driverType string) bool {
	return optionalGoDriverBuildIncluded(normalizeRuntimeDriverType(driverType))
}

func OptionalDriverAgentRevision(driverType string) string {
	return strings.TrimSpace(optionalDriverAgentRevisions[normalizeRuntimeDriverType(driverType)])
}

// IsBuiltinDriver 返回指定驱动类型是否为核心内置驱动（始终可用，无需安装）。
func IsBuiltinDriver(driverType string) bool {
	_, ok := coreBuiltinDrivers[normalizeRuntimeDriverType(driverType)]
	return ok
}

func defaultExternalDriverDownloadDirectory() string {
	return appdata.DriverRoot("")
}

func resolveExternalDriverRoot(downloadDir string) (string, error) {
	root := strings.TrimSpace(downloadDir)
	if root == "" {
		root = currentExternalDriverDownloadDirectory()
	}
	if root == "" {
		root = defaultExternalDriverDownloadDirectory()
	}
	if !filepath.IsAbs(root) {
		abs, err := filepath.Abs(root)
		if err != nil {
			return "", err
		}
		root = abs
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", fmt.Errorf("%s%w", localizedDriverRuntimeText("driver_manager.backend.error.create_directory_failed", map[string]any{
			"detail": "",
		}), err)
	}
	return root, nil
}

func currentExternalDriverDownloadDirectory() string {
	externalDriverDirMu.RLock()
	current := strings.TrimSpace(externalDriverDir)
	externalDriverDirMu.RUnlock()
	if current != "" {
		return current
	}
	return defaultExternalDriverDownloadDirectory()
}

// SetExternalDriverDownloadDirectory 设置可选驱动的下载存储目录。
// 如果路径解析失败，会回退到默认目录（~/.gonavi/drivers）。
func SetExternalDriverDownloadDirectory(downloadDir string) {
	root, err := resolveExternalDriverRoot(downloadDir)
	if err != nil {
		root = defaultExternalDriverDownloadDirectory()
	}
	externalDriverDirMu.Lock()
	externalDriverDir = root
	externalDriverDirMu.Unlock()
}

func ResolveExternalDriverRoot(downloadDir string) (string, error) {
	return resolveExternalDriverRoot(downloadDir)
}

func ResolveOptionalGoDriverMarkerPath(downloadDir string, driverType string) (string, error) {
	normalized := normalizeRuntimeDriverType(driverType)
	if !IsOptionalGoDriver(normalized) {
		return "", fmt.Errorf("%s 不是可选 Go 驱动", driverDisplayName(normalized))
	}
	root, err := resolveExternalDriverRoot(downloadDir)
	if err != nil {
		return "", err
	}
	return filepath.Join(root, normalized, "installed.json"), nil
}

func optionalGoDriverInstalled(driverType string) bool {
	markerPath, err := ResolveOptionalGoDriverMarkerPath("", driverType)
	if err != nil {
		return false
	}
	info, statErr := os.Stat(markerPath)
	return statErr == nil && !info.IsDir()
}

func optionalGoDriverRuntimeReady(driverType string) (bool, string) {
	normalized := normalizeRuntimeDriverType(driverType)
	if !IsOptionalGoDriver(normalized) {
		return true, ""
	}
	displayName := driverDisplayName(normalized)
	executablePath, err := ResolveOptionalDriverAgentExecutablePath("", normalized)
	if err != nil {
		return false, localizedDriverRuntimeText("driver_manager.backend.status.agent_path_failed", map[string]any{"name": displayName})
	}
	info, statErr := os.Stat(executablePath)
	if statErr != nil || info.IsDir() {
		return false, localizedDriverRuntimeText("driver_manager.backend.status.agent_missing", map[string]any{"name": displayName})
	}
	if validateErr := ValidateOptionalDriverAgentExecutable(normalized, executablePath); validateErr != nil {
		var archErr *driverAgentArchMismatchError
		if errors.As(validateErr, &archErr) {
			return false, localizedDriverRuntimeText("driver_manager.backend.status.agent_arch_incompatible_detail", map[string]any{
				"name":    displayName,
				"file":    archErr.fileLabel,
				"process": archErr.processLabel,
			})
		}
		return false, localizedDriverRuntimeText("driver_manager.backend.status.agent_unavailable_reinstall", map[string]any{
			"name":   displayName,
			"detail": validateErr.Error(),
		})
	}
	return true, ""
}

// DriverRuntimeSupportStatus 返回当前构建下驱动是否可用（可直接用于连接）。
func DriverRuntimeSupportStatus(driverType string) (bool, string) {
	normalized := normalizeRuntimeDriverType(driverType)
	if normalized == "" {
		return false, localizedDriverRuntimeText("driver_manager.backend.status.unrecognized_driver_type", nil)
	}
	if normalized == "custom" {
		return true, ""
	}
	if IsBuiltinDriver(normalized) {
		return true, ""
	}
	if IsOptionalGoDriver(normalized) {
		displayName := driverDisplayName(normalized)
		if !IsOptionalGoDriverBuildIncluded(normalized) {
			return false, localizedDriverRuntimeText("driver_manager.backend.status.slim_build_required", map[string]any{"name": displayName})
		}
		if optionalGoDriverInstalled(normalized) {
			if ready, reason := optionalGoDriverRuntimeReady(normalized); !ready {
				return false, reason
			}
			return true, ""
		}
		return false, localizedDriverRuntimeText("driver_manager.backend.status.optional_disabled", map[string]any{"name": displayName})
	}
	return true, ""
}
