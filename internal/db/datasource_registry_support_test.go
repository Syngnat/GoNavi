package db

import (
	"testing"

	"GoNavi-Wails/internal/datasource"
)

// legacyDriverTypeNames 是不经描述表维护的历史类型与别名；描述表不得复用这些名字，
// 否则 normalizeRuntimeDriverType 的历史分支会抢先返回，描述表条目永远不可达。
var legacyDriverTypeNames = []string{
	"mysql", "goldendb", "greatdb", "gdb", "mariadb", "oceanbase", "doris", "diros", "starrocks",
	"sphinx", "sphinxql", "postgres", "postgresql", "pg", "pq", "pgx", "sqlserver", "mssql",
	"sql_server", "sql-server", "sqlite", "sqlite3", "duckdb", "dameng", "dm", "dm8", "kingbase",
	"kingbase8", "kingbasees", "kingbasev8", "highgo", "vastbase", "opengauss", "open_gauss",
	"open-gauss", "gaussdb", "gauss_db", "gauss-db", "iris", "intersystems", "cache", "mongodb",
	"tdengine", "iotdb", "apache-iotdb", "apache_iotdb", "clickhouse", "elasticsearch", "elastic",
	"trino", "chroma", "chromadb", "qdrant", "milvus", "rocketmq", "rmq", "mqtt", "mqtts", "kafka",
	"rabbitmq", "pulsar", "redis", "oracle", "custom", "nacos", "jvm",
}

func TestRegistryTypesDoNotShadowLegacyDrivers(t *testing.T) {
	for _, name := range legacyDriverTypeNames {
		if spec, ok := datasource.Lookup(name); ok {
			t.Fatalf("registry type %q reuses legacy driver name %q", spec.Type, name)
		}
	}
}

func TestRegistryTypesAreOptionalAgentDrivers(t *testing.T) {
	for _, spec := range datasource.All() {
		names := append([]string{spec.Type}, spec.Aliases...)
		for _, name := range names {
			if got := normalizeRuntimeDriverType(name); got != spec.Type {
				t.Fatalf("normalizeRuntimeDriverType(%q) = %q, want %q", name, got, spec.Type)
			}
			if !IsOptionalGoDriver(name) {
				t.Fatalf("%q must be gated as an optional driver", name)
			}
			inst, err := NewDatabase(name)
			if err != nil {
				t.Fatalf("NewDatabase(%q): %v", name, err)
			}
			var agent *OptionalDriverAgentDB
			switch typed := inst.(type) {
			case *OptionalDriverAgentDB:
				agent = typed
			case *optionalDriverAgentTransactionalDB:
				agent = typed.OptionalDriverAgentDB
			}
			if agent == nil || agent.driverType != spec.Type {
				t.Fatalf("NewDatabase(%q) = %T, want agent proxy for %q", name, inst, spec.Type)
			}
			// 声明了驱动事务的类型（如 GBase 8a）用带托管事务接口的代理，其余类型不带。
			if _, transactional := inst.(TransactionExecerProvider); transactional != spec.DriverTransactions {
				t.Fatalf("NewDatabase(%q) transactional = %v, want %v", name, transactional, spec.DriverTransactions)
			}
		}
		if got := driverDisplayName(spec.Type); got != spec.DisplayName {
			t.Fatalf("driverDisplayName(%q) = %q, want %q", spec.Type, got, spec.DisplayName)
		}
		if !IsDataSourceCapabilityDeclared(spec.Type) {
			t.Fatalf("registry type %q has no capability profile in the contract", spec.Type)
		}
	}
}
