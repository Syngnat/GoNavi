package app

import (
	"GoNavi-Wails/internal/datasource"
	"GoNavi-Wails/internal/db"
)

// 驱动管理读取的几张包级表（固定版本、最新版本、Go module 路径）在这里补齐描述表的代理键，
// 历史驱动的条目保持原样；描述表类型与历史类型互不重叠（internal/db 单测保证）。
// 独立构建的驱动版本档位（如 cassandra_legacy）是独立的代理键，与默认代理并排安装。
func init() {
	for _, spec := range datasource.All() {
		for _, agent := range spec.Agents() {
			registerRegistryAgentPackage(spec, agent)
		}
	}
}

func registerRegistryAgentPackage(spec datasource.Spec, agent datasource.AgentSpec) {
	pinnedDriverPackageMap[agent.Key] = pinnedDriverPackage{
		Version:     agent.Version,
		DownloadURL: "builtin://activate/" + agent.Key,
		Policy:      driverChecksumPolicyOff,
		Engine:      driverEngineGo,
	}
	if agent.Version != "" {
		latestDriverVersionMap[agent.Key] = agent.Version
	}
	if agent.GoModule != "" {
		driverGoModulePathMap[agent.Key] = agent.GoModule
	}
	if agent.Key == spec.Type && len(spec.ModuleAliases) > 0 {
		driverGoModuleAliasPathMap[agent.Key] = append([]string(nil), spec.ModuleAliases...)
	}
}

// registryDriverDefinitions 返回描述表代理在驱动管理里的定义，排在历史可选驱动之后。
func registryDriverDefinitions(packages map[string]pinnedDriverPackage) []driverDefinition {
	keys := datasource.AgentKeys()
	definitions := make([]driverDefinition, 0, len(keys))
	for _, spec := range datasource.All() {
		for _, agent := range spec.Agents() {
			definitions = append(definitions, buildOptionalGoDriverDefinition(agent.Key, db.DriverDisplayName(agent.Key), packages))
		}
	}
	return definitions
}

// registryDriverBuildTag 返回源码构建描述表代理所用的构建标签（按代理键）。
func registryDriverBuildTag(agentKey string) (string, bool) {
	_, agent, _, ok := datasource.LookupAgent(agentKey)
	if !ok {
		return "", false
	}
	return agent.BuildTag, true
}

// registryDDLDialect 返回描述表类型借用的既有方言（如 TiDB → mysql）。
func registryDDLDialect(driverType string) (string, bool) {
	spec, ok := datasource.Lookup(driverType)
	if !ok || spec.DDLDialect == "" {
		return "", false
	}
	return spec.DDLDialect, true
}

// registryCanonicalDriverType 把描述表别名归一为规范类型名。
func registryCanonicalDriverType(driverType string) (string, bool) {
	return datasource.Canonical(driverType)
}
