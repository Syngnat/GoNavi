package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/datasource"
)

// 描述表里的数据源全部走可选驱动代理：主进程只登记代理工厂与安装门控，
// 驱动实现编译进各自的 optional-driver-agent。历史类型仍走原有清单，
// 这里只处理描述表声明的类型，二者的类型名与别名互不重叠（由单测保证）。
//
// 独立构建的驱动版本档位（如 cassandra_legacy）作为独立的可选驱动键登记，
// 安装、卸载、更新、修订号校验都按代理键进行，与默认代理并排存在。
func init() {
	for _, key := range datasource.AgentKeys() {
		optionalGoDrivers[key] = struct{}{}
	}
	for _, spec := range datasource.All() {
		names := make([]string, 0, len(spec.Aliases)+1)
		names = append(names, spec.Type)
		names = append(names, spec.Aliases...)
		factory := newOptionalDriverAgentDatabase(spec.Type)
		if spec.DriverTransactions {
			factory = newOptionalDriverAgentTransactionalDatabase(spec.Type)
		}
		registerDatabaseFactory(factory, names...)
	}
}

// registryRuntimeDriverType 把描述表别名归一为规范类型名；代理键与其他类型原样返回。
func registryRuntimeDriverType(normalized string) string {
	if canonical, ok := datasource.Canonical(normalized); ok {
		return canonical
	}
	return normalized
}

// registryDriverDisplayName 返回描述表声明的显示名；独立构建档位的代理键带上档位标签。
func registryDriverDisplayName(driverType string) (string, bool) {
	if spec, _, variantID, ok := datasource.LookupAgent(driverType); ok {
		if variant, found := spec.Variants.Item(variantID); found && variantID != "" {
			return fmt.Sprintf("%s (%s)", spec.DisplayName, variant.Label), true
		}
		return spec.DisplayName, true
	}
	spec, ok := datasource.Lookup(driverType)
	if !ok {
		return "", false
	}
	return spec.DisplayName, true
}

// DataSourceSpec 返回描述表里的数据源声明，供 app 层与同步、MCP 等领域包读取。
func DataSourceSpec(driverType string) (datasource.Spec, bool) {
	return datasource.Lookup(strings.TrimSpace(driverType))
}

// IsElasticsearchFamily 报告驱动是否走 Elasticsearch 实现：Elasticsearch 本身，或借用其方言的描述表类型（如 OpenSearch），
// 这些驱动都提供 Elasticsearch Console 与服务端主版本。
func IsElasticsearchFamily(driverType string) bool {
	normalized := normalizeRuntimeDriverType(driverType)
	if normalized == "elasticsearch" {
		return true
	}
	spec, ok := datasource.Lookup(normalized)
	return ok && spec.DDLDialect == "elasticsearch"
}

// RegistryAgentKeyForConfig 返回连接要启动的代理驱动键：描述表类型按连接上选择的驱动版本档位
// 决定（独立构建档位对应独立的代理键），其他类型返回原类型。
func RegistryAgentKeyForConfig(driverType, requestedVariant string) string {
	spec, ok := datasource.Lookup(driverType)
	if !ok {
		return driverType
	}
	return spec.AgentKeyFor(requestedVariant)
}

// DriverDisplayName 返回驱动类型（含描述表代理键）在界面与日志中使用的显示名。
func DriverDisplayName(driverType string) string {
	return driverDisplayName(driverType)
}
