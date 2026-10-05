package db

import (
	"strings"
)

type databaseFactory func() Database

var databaseFactories = map[string]databaseFactory{
	"mysql": func() Database {
		return &MySQLDB{}
	},
	"goldendb": func() Database {
		return &MySQLDB{}
	},
	"postgres": func() Database {
		return &PostgresDB{}
	},
	"oracle": func() Database {
		return &OracleDB{}
	},
	"custom": func() Database {
		return &CustomDB{}
	},
	"chroma": func() Database {
		return &ChromaDB{}
	},
	"qdrant": func() Database {
		return &QdrantDB{}
	},
	"milvus": func() Database {
		return &MilvusDB{}
	},
}

func init() {
	registerMessageDatabaseFactories()
	registerOptionalDatabaseFactories()
}

func registerDatabaseFactory(factory databaseFactory, dbTypes ...string) {
	if factory == nil || len(dbTypes) == 0 {
		return
	}
	for _, dbType := range dbTypes {
		normalized := normalizeDatabaseType(dbType)
		if normalized == "" {
			continue
		}
		databaseFactories[normalized] = factory
	}
}

func normalizeDatabaseType(dbType string) string {
	normalized := strings.ToLower(strings.TrimSpace(dbType))
	switch normalized {
	case "doris":
		return "diros"
	case "postgresql":
		return "postgres"
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
	case "cache", "caché", "intersystems cache", "intersystems caché", "intersystems-cache", "intersystems-caché", "intersystemscache", "intersystemscaché", "inter-systems-cache", "inter-systems-caché", "intersystems-cache-database", "cache-db", "cachedb":
		return "cache"
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
	case "kafka", "apache-kafka", "apache_kafka":
		return "kafka"
	case "rabbitmq", "rabbit-mq", "rabbit_mq":
		return "rabbitmq"
	case "pulsar", "apache-pulsar", "apache_pulsar":
		return "pulsar"
	default:
		return normalized
	}
}

// NewDatabase 根据数据库类型创建对应的 Database 实例。
// dbType 为数据库类型标识（如 "mysql"、"postgres"、"oracle" 等），大小写不敏感。
// 如果指定类型未注册，返回错误。
func NewDatabase(dbType string) (Database, error) {
	normalized := normalizeDatabaseType(dbType)
	if normalized == "" {
		normalized = "mysql"
	}
	factory, ok := databaseFactories[normalized]
	if !ok {
		return nil, localizedDatabaseRuntimeError("db.backend.error.unsupported_database_type", map[string]any{"dbType": dbType})
	}
	return factory(), nil
}
