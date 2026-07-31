package app

import (
	"fmt"
	stdRuntime "runtime"
	"runtime/debug"
	"sort"
	"strings"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/logger"
)

type startupDriverVersion struct {
	Driver        string
	Source        string
	Version       string
	Module        string
	AgentRevision string
}

var startupDriverModuleNames = map[string]string{
	"gitea.com/kingbase/gokb":                    "kingbase",
	"gitee.com/chunanyong/dm":                    "dameng",
	"github.com/ClickHouse/clickhouse-go/v2":     "clickhouse",
	"github.com/HuaweiCloudDeveloper/gaussdb-go": "gaussdb",
	"github.com/apache/iotdb-client-go":          "iotdb",
	"github.com/apache/rocketmq-client-go/v2":    "rocketmq",
	"github.com/caretdev/go-irisnative":          "iris",
	"github.com/duckdb/duckdb-go/v2":             "duckdb",
	"github.com/eclipse/paho.mqtt.golang":        "mqtt",
	"github.com/elastic/go-elasticsearch/v8":     "elasticsearch",
	"github.com/go-sql-driver/mysql":             "mysql-compatible",
	"github.com/helingjun/obconnector-go":        "oceanbase-oracle",
	"github.com/highgo/pq-sm3":                   "highgo",
	"github.com/lib/pq":                          "postgres-compatible",
	"github.com/microsoft/go-mssqldb":            "sqlserver",
	"github.com/redis/go-redis/v9":               "redis",
	"github.com/segmentio/kafka-go":              "kafka",
	"github.com/sijms/go-ora/v2":                 "oracle",
	"github.com/taosdata/driver-go/v3":           "tdengine",
	"github.com/trinodb/trino-go-client":         "trino",
	"go.mongodb.org/mongo-driver":                "mongodb-v1",
	"go.mongodb.org/mongo-driver/v2":             "mongodb",
	"modernc.org/sqlite":                         "sqlite",
}

func logStartupDiagnostics(configDir string) {
	buildInfo, _ := debug.ReadBuildInfo()
	logger.Infof("%s", buildStartupVersionLog(
		getCurrentVersion(),
		strings.TrimSpace(AppBuildTime),
		stdRuntime.GOOS,
		stdRuntime.GOARCH,
		buildInfo,
	))

	driverRoot := appdata.DriverRoot(configDir)
	versions := collectStartupDriverVersions(buildInfo, driverRoot)
	if len(versions) == 0 {
		logger.Warnf("数据库驱动版本：未从当前二进制或已安装驱动代理中解析到版本")
		return
	}
	for _, item := range versions {
		logger.Infof("%s", formatStartupDriverVersionLog(item))
	}
}

func buildStartupVersionLog(version string, buildTime string, goos string, goarch string, buildInfo *debug.BuildInfo) string {
	version = strings.TrimSpace(version)
	if version == "" {
		version = "(unknown)"
	}
	goVersion := stdRuntime.Version()
	if buildInfo != nil && strings.TrimSpace(buildInfo.GoVersion) != "" {
		goVersion = strings.TrimSpace(buildInfo.GoVersion)
	}

	parts := []string{
		fmt.Sprintf("version=%s", version),
		fmt.Sprintf("go=%s", strings.TrimSpace(goVersion)),
		fmt.Sprintf("os=%s", strings.TrimSpace(goos)),
		fmt.Sprintf("arch=%s", strings.TrimSpace(goarch)),
	}
	if buildTime = strings.TrimSpace(buildTime); buildTime != "" {
		parts = append(parts, "buildTime="+buildTime)
	}
	if revision := startupBuildRevision(buildInfo); revision != "" {
		parts = append(parts, "revision="+revision)
	}
	return "GoNavi 启动信息：" + strings.Join(parts, " ")
}

func startupBuildRevision(buildInfo *debug.BuildInfo) string {
	if buildInfo == nil {
		return ""
	}
	for _, setting := range buildInfo.Settings {
		if setting.Key != "vcs.revision" {
			continue
		}
		revision := strings.TrimSpace(setting.Value)
		if len(revision) > 12 {
			revision = revision[:12]
		}
		return revision
	}
	return ""
}

func collectStartupDriverVersions(buildInfo *debug.BuildInfo, driverRoot string) []startupDriverVersion {
	result := make([]startupDriverVersion, 0, len(startupDriverModuleNames))
	if buildInfo != nil {
		for _, dependency := range buildInfo.Deps {
			if dependency == nil {
				continue
			}
			modulePath := strings.TrimSpace(dependency.Path)
			driverName, ok := startupDriverModuleNames[modulePath]
			if !ok {
				continue
			}
			result = append(result, startupDriverVersion{
				Driver:  driverName,
				Source:  "go-module",
				Version: startupBuildModuleVersion(dependency),
				Module:  modulePath,
			})
		}
	}

	for _, definition := range allDriverDefinitionsWithPackages(nil) {
		if definition.BuiltIn {
			continue
		}
		pkg, ok := readInstalledDriverPackage(driverRoot, definition.Type)
		if !ok {
			continue
		}
		version := strings.TrimSpace(pkg.Version)
		if version == "" {
			version = "(unknown)"
		}
		result = append(result, startupDriverVersion{
			Driver:        normalizeDriverType(definition.Type),
			Source:        "driver-agent",
			Version:       version,
			AgentRevision: strings.TrimSpace(pkg.AgentRevision),
		})
	}

	sort.Slice(result, func(left int, right int) bool {
		leftOrder := startupDriverSourceOrder(result[left].Source)
		rightOrder := startupDriverSourceOrder(result[right].Source)
		if leftOrder != rightOrder {
			return leftOrder < rightOrder
		}
		if result[left].Driver != result[right].Driver {
			return result[left].Driver < result[right].Driver
		}
		return result[left].Module < result[right].Module
	})
	return result
}

func startupDriverSourceOrder(source string) int {
	if source == "go-module" {
		return 0
	}
	return 1
}

func startupBuildModuleVersion(module *debug.Module) string {
	if module == nil {
		return "(unknown)"
	}
	version := strings.TrimSpace(module.Version)
	if module.Replace != nil {
		replacementVersion := strings.TrimSpace(module.Replace.Version)
		if replacementVersion != "" && replacementVersion != "(devel)" {
			version = replacementVersion
		} else if version != "" {
			version += "+local-replace"
		}
	}
	if version == "" || version == "(devel)" {
		return "(unknown)"
	}
	return version
}

func formatStartupDriverVersionLog(item startupDriverVersion) string {
	parts := []string{
		fmt.Sprintf("driver=%s", strings.TrimSpace(item.Driver)),
		fmt.Sprintf("source=%s", strings.TrimSpace(item.Source)),
		fmt.Sprintf("version=%s", strings.TrimSpace(item.Version)),
	}
	if modulePath := strings.TrimSpace(item.Module); modulePath != "" {
		parts = append(parts, "module="+modulePath)
	}
	if revision := strings.TrimSpace(item.AgentRevision); revision != "" {
		parts = append(parts, "agentRevision="+revision)
	}
	return "数据库驱动版本：" + strings.Join(parts, " ")
}
