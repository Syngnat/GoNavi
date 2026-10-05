package app

import (
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/db"
)

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
	case "opengauss", "open_gauss", "open-gauss":
		return "opengauss"
	case "gaussdb", "gauss_db", "gauss-db":
		return "gaussdb"
	case "goldendb", "greatdb", "gdb":
		return "goldendb"
	case "rocketmq", "rocket-mq", "rocket_mq", "apache-rocketmq", "apache_rocketmq", "rmq":
		return "rocketmq"
	case "mqtt", "mqtts":
		return "mqtt"
	case "kafka", "apache-kafka", "apache_kafka":
		return "kafka"
	case "pulsar", "apache-pulsar", "apache_pulsar":
		return "pulsar"
	case "rabbitmq", "rabbit-mq", "rabbit_mq":
		return "rabbitmq"
	case "intersystems", "intersystemsiris", "inter-systems-iris", "inter-systems":
		return "iris"
	case "cache", "caché", "intersystems cache", "intersystems caché", "intersystems-cache", "intersystems-caché", "intersystemscache", "intersystemscaché", "inter-systems-cache", "inter-systems-caché", "intersystems-cache-database", "cache-db", "cachedb":
		return "cache"
	case "milvusdb", "milvus-db":
		return "milvus"
	default:
		if canonical, ok := registryCanonicalDriverType(normalized); ok {
			return canonical
		}
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
	effectivePackages, err := resolveEffectiveDriverPackages("")
	if err == nil {
		return resolveDriverDefinitionWithPackages(driverType, effectivePackages)
	}
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
	return append(append(builtInDriverDefinitions(), []driverDefinition{
		// 其他数据源需要先在驱动管理中“安装启用”。
		buildOptionalGoDriverDefinition("mariadb", "MariaDB", packages),
		buildOptionalGoDriverDefinition("oceanbase", "OceanBase", packages),
		buildOptionalGoDriverDefinition("diros", "Doris", packages),
		buildOptionalGoDriverDefinition("starrocks", "StarRocks", packages),
		buildOptionalGoDriverDefinition("sphinx", "Sphinx", packages),
		buildOptionalGoDriverDefinition("sqlserver", "SQL Server", packages),
		buildOptionalGoDriverDefinition("sqlite", "SQLite", packages),
		buildOptionalGoDriverDefinition("duckdb", "DuckDB", packages),
		buildOptionalGoDriverDefinition("dameng", "Dameng", packages),
		buildOptionalGoDriverDefinition("kingbase", "Kingbase", packages),
		buildOptionalGoDriverDefinition("highgo", "HighGo", packages),
		buildOptionalGoDriverDefinition("vastbase", "Vastbase", packages),
		buildOptionalGoDriverDefinition("opengauss", "OpenGauss", packages),
		buildOptionalGoDriverDefinition("gaussdb", "GaussDB", packages),
		buildOptionalGoDriverDefinition("iris", "InterSystems IRIS", packages),
		buildOptionalGoDriverDefinition("cache", "InterSystems Caché", packages),
		buildOptionalGoDriverDefinition("mongodb", "MongoDB", packages),
		buildOptionalGoDriverDefinition("tdengine", "TDengine", packages),
		buildOptionalGoDriverDefinition("iotdb", "Apache IoTDB", packages),
		buildOptionalGoDriverDefinition("clickhouse", "ClickHouse", packages),
		buildOptionalGoDriverDefinition("elasticsearch", "Elasticsearch", packages),
		buildOptionalGoDriverDefinition("trino", "Trino", packages),
		// 消息队列客户端体积大（Pulsar 连带 k8s/athenz/prometheus），同样按需下载驱动代理。
		buildOptionalGoDriverDefinition("kafka", "Kafka", packages),
		buildOptionalGoDriverDefinition("rocketmq", "RocketMQ", packages),
		buildOptionalGoDriverDefinition("pulsar", "Apache Pulsar", packages),
	}...), registryDriverDefinitions(packages)...)
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
	return &driverBuildUnavailableError{Name: driverName}
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
