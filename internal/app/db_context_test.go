package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestNormalizeSchemaAndTable_SQLServerKeepsDatabaseAndQualifiedTable(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type:     "sqlserver",
		Database: "master",
	}, "biz_db", "dbo.users")

	if schemaOrDb != "biz_db" {
		t.Fatalf("expected sqlserver first return value as database name, got %q", schemaOrDb)
	}
	if table != "dbo.users" {
		t.Fatalf("expected sqlserver table name keep qualified form, got %q", table)
	}
}

func TestNormalizeSchemaAndTable_SQLServerFallbackToConfigDatabase(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type:     "sqlserver",
		Database: "biz_db",
	}, "", "dbo.users")

	if schemaOrDb != "biz_db" {
		t.Fatalf("expected sqlserver fallback database from config, got %q", schemaOrDb)
	}
	if table != "dbo.users" {
		t.Fatalf("expected sqlserver table name keep qualified form, got %q", table)
	}
}

func TestNormalizeSchemaAndTable_PostgresStillSplitsQualifiedName(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "postgres",
	}, "demo_db", "public.orders")

	if schema != "public" || table != "orders" {
		t.Fatalf("expected postgres qualified split to public.orders, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_PostgresReturnsLogicalQuotedDottedParts(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "postgres",
	}, "demo_db", `"sales.schema"."order.items"`)

	if schema != "sales.schema" || table != "order.items" {
		t.Fatalf("expected logical PostgreSQL identifier parts, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_PostgresReturnsLogicalQuotedTableOnly(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "postgres",
	}, "demo_db", `"order.items"`)

	if schema != "public" || table != "order.items" {
		t.Fatalf("expected logical PostgreSQL table-only identifier, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_TrinoPreservesDottedTableName(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "trino",
	}, "hive.default", "daily.events.v1")

	if schema != "hive.default" || table != "daily.events.v1" {
		t.Fatalf("expected trino table name to stay intact, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_KingbaseNormalizesEscapedQualifiedName(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "kingbase",
	}, "demo_db", `\"Idf_server\".\"mes_bip_wip_finished\"`)

	if schema != "Idf_server" || table != "mes_bip_wip_finished" {
		t.Fatalf("expected kingbase qualified split to Idf_server.mes_bip_wip_finished, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_KingbasePureTableUsesCurrentSearchPath(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "kingbase",
	}, "demo_db", "users")

	if schema != "" || table != "users" {
		t.Fatalf("expected kingbase pure table to use current search_path, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_PGLikePureTableKeepsPublicFallback(t *testing.T) {
	t.Parallel()

	for _, dbType := range []string{"postgres", "highgo", "vastbase", "opengauss", "gaussdb"} {
		t.Run(dbType, func(t *testing.T) {
			t.Parallel()

			schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
				Type: dbType,
			}, "demo_db", "users")

			if schema != "public" || table != "users" {
				t.Fatalf("expected %s pure table to keep public fallback, got %q.%q", dbType, schema, table)
			}
		})
	}
}

func TestNormalizeMetadataSchemaAndTable_PGLikePureTableUsesSearchPath(t *testing.T) {
	t.Parallel()

	for _, dbType := range []string{"postgres", "highgo", "vastbase", "opengauss", "gaussdb", "kingbase"} {
		t.Run(dbType, func(t *testing.T) {
			t.Parallel()

			schema, table := normalizeMetadataSchemaAndTable(connection.ConnectionConfig{
				Type: dbType,
			}, "demo_db", "users")

			if schema != "" || table != "users" {
				t.Fatalf("expected %s metadata pure table to use search_path, got %q.%q", dbType, schema, table)
			}
		})
	}
}

func TestNormalizeMetadataSchemaAndTable_PGLikeQualifiedTableKeepsSchema(t *testing.T) {
	t.Parallel()

	schema, table := normalizeMetadataSchemaAndTable(connection.ConnectionConfig{
		Type: "postgres",
	}, "demo_db", `"audit.schema"."order.items"`)

	if schema != "audit.schema" || table != `"order.items"` {
		t.Fatalf("expected metadata qualified table to keep schema/table, got %q.%q", schema, table)
	}
}

func TestNormalizeMetadataSchemaAndTable_PGLikeDottedUnquotedTableKeepsFallback(t *testing.T) {
	t.Parallel()

	schema, table := normalizeMetadataSchemaAndTable(connection.ConnectionConfig{
		Type: "postgres",
	}, "demo_db", "audit.users")

	if schema != "audit" || table != "users" {
		t.Fatalf("expected metadata dotted table to keep explicit schema, got %q.%q", schema, table)
	}
}

func TestNormalizeMetadataSchemaAndTable_PGLikeQuotedDottedTableUsesSearchPath(t *testing.T) {
	t.Parallel()

	schema, table := normalizeMetadataSchemaAndTable(connection.ConnectionConfig{
		Type: "postgres",
	}, "demo_db", `"order.items"`)

	if schema != "" || table != `"order.items"` {
		t.Fatalf("expected quoted dotted metadata table to use search_path, got %q.%q", schema, table)
	}
}

func TestNormalizeMetadataSchemaAndTable_NonPGLikeKeepsNormalBehavior(t *testing.T) {
	t.Parallel()

	schema, table := normalizeMetadataSchemaAndTable(connection.ConnectionConfig{
		Type: "mysql",
	}, "demo_db", "users")

	if schema != "demo_db" || table != "users" {
		t.Fatalf("expected mysql metadata to keep db/table behavior, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_MySQLPreservesQuotedDottedTable(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "mysql",
	}, "demo_db", "demo_db.`order.items`")
	if schema != "demo_db" || table != "`order.items`" {
		t.Fatalf("expected quoted dotted MySQL table to remain one identifier, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_SQLitePreservesPlainDottedTable(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{Type: "sqlite"}, "main", "order.items")
	if schema != "main" || table != "order.items" {
		t.Fatalf("expected plain dotted SQLite table to stay intact, got %q.%q", schema, table)
	}

	schema, table = normalizeSchemaAndTable(connection.ConnectionConfig{Type: "sqlite"}, "main", "main.`order.items`")
	if schema != "main" || table != "order.items" {
		t.Fatalf("expected explicit SQLite database prefix to normalize, got %q.%q", schema, table)
	}

	schema, table = normalizeSchemaAndTable(connection.ConnectionConfig{Type: "sqlite"}, "main", "[order.items]")
	if schema != "main" || table != "order.items" {
		t.Fatalf("expected SQLite bracketed dotted table to normalize, got %q.%q", schema, table)
	}

	schema, table = normalizeSchemaAndTable(connection.ConnectionConfig{Type: "sqlite"}, "main", "order.[order.items]")
	if schema != "main" || table != "order.items" {
		t.Fatalf("expected SQLite schema-prefixed bracketed dotted table to normalize, got %q.%q", schema, table)
	}
}

func TestNormalizeMetadataSchemaAndTable_TrinoPreservesDottedTableName(t *testing.T) {
	t.Parallel()

	schema, table := normalizeMetadataSchemaAndTable(connection.ConnectionConfig{
		Type: "trino",
	}, "iceberg.analytics", "ods.orders.v1")

	if schema != "iceberg.analytics" || table != "ods.orders.v1" {
		t.Fatalf("expected trino metadata table to stay intact, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_PGLikePureTableStillSplitsKingbaseSearchPathOnlyInMetadata(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "kingbase",
	}, "demo_db", "users")

	if schema != "" || table != "users" {
		t.Fatalf("expected kingbase normal path to keep existing search_path behavior, got %q.%q", schema, table)
	}
}

func TestNormalizeMetadataSchemaAndTable_PGLikePreservesNormalFallbackForQuotedQualifiedTable(t *testing.T) {
	t.Parallel()

	for _, dbType := range []string{"highgo", "vastbase", "opengauss", "gaussdb"} {
		t.Run(dbType, func(t *testing.T) {
			t.Parallel()

			schema, table := normalizeMetadataSchemaAndTable(connection.ConnectionConfig{
				Type: dbType,
			}, "demo_db", `"audit"."users"`)

			if schema != "audit" || table != "users" {
				t.Fatalf("expected %s metadata qualified table to keep schema, got %q.%q", dbType, schema, table)
			}
		})
	}
}

func TestNormalizeRunConfig_OceanBaseOracleKeepsServiceName(t *testing.T) {
	t.Parallel()

	config := connection.ConnectionConfig{
		Type:              "oceanbase",
		Database:          "OBORCL",
		OceanBaseProtocol: "oracle",
	}
	runConfig := normalizeRunConfig(config, "SYS")

	if runConfig.Database != "OBORCL" {
		t.Fatalf("expected OceanBase Oracle service name to stay OBORCL, got %q", runConfig.Database)
	}
}

func TestNormalizeRunConfig_StarRocksUsesDatabaseFromTree(t *testing.T) {
	t.Parallel()

	runConfig := normalizeRunConfig(connection.ConnectionConfig{
		Type:     "starrocks",
		Database: "default_cluster",
	}, "analytics")

	if runConfig.Database != "analytics" {
		t.Fatalf("expected StarRocks database from tree, got %q", runConfig.Database)
	}
}

func TestNormalizeRunConfig_TrinoUsesNamespaceFromTree(t *testing.T) {
	t.Parallel()

	runConfig := normalizeRunConfig(connection.ConnectionConfig{
		Type:     "trino",
		Database: "hive.default",
	}, "iceberg.analytics")

	if runConfig.Database != "iceberg.analytics" {
		t.Fatalf("expected trino namespace from tree, got %q", runConfig.Database)
	}
}

func TestNormalizeRunConfig_MilvusUsesDatabaseFromTree(t *testing.T) {
	t.Parallel()

	runConfig := normalizeRunConfig(connection.ConnectionConfig{
		Type:     "milvus",
		Database: "default",
	}, "analytics")

	if runConfig.Database != "analytics" {
		t.Fatalf("expected Milvus database from tree, got %q", runConfig.Database)
	}
}

func TestNormalizeRunConfig_GoldenDBUsesDatabaseFromTree(t *testing.T) {
	t.Parallel()

	runConfig := normalizeRunConfig(connection.ConnectionConfig{
		Type:     "goldendb",
		Database: "legacy_default",
	}, "finance_core")

	if runConfig.Database != "finance_core" {
		t.Fatalf("expected GoldenDB database from tree, got %q", runConfig.Database)
	}
}

func TestNormalizeRunConfig_IRISUsesNamespaceFromTree(t *testing.T) {
	t.Parallel()

	runConfig := normalizeRunConfig(connection.ConnectionConfig{
		Type:     "iris",
		Database: "USER",
	}, "APP")

	if runConfig.Database != "APP" {
		t.Fatalf("expected IRIS namespace from tree, got %q", runConfig.Database)
	}
}

func TestNormalizeRunConfig_RedisAllowsDatabaseIndexAboveDefault(t *testing.T) {
	t.Parallel()

	runConfig := normalizeRunConfig(connection.ConnectionConfig{
		Type:    "redis",
		RedisDB: 0,
	}, "31")

	if runConfig.Database != "31" || runConfig.RedisDB != 31 {
		t.Fatalf("expected Redis db31 from tree, got database=%q redisDB=%d", runConfig.Database, runConfig.RedisDB)
	}
}

func TestNormalizeRunConfig_KafkaKeepsDefaultTopic(t *testing.T) {
	t.Parallel()

	runConfig := normalizeRunConfig(connection.ConnectionConfig{
		Type:     "kafka",
		Database: "orders.events",
	}, "topics")

	if runConfig.Database != "orders.events" {
		t.Fatalf("expected Kafka default topic to stay orders.events, got %q", runConfig.Database)
	}
}

func TestNormalizeSchemaAndTable_IRISDoesNotTreatNamespaceAsSchema(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "iris",
	}, "USER", "Person")

	if schema != "" || table != "Person" {
		t.Fatalf("expected IRIS pure table to omit schema, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_IRISSplitsQualifiedTable(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "iris",
	}, "USER", `"Sample.Schema"."Person.Table"`)

	if schema != "Sample.Schema" || table != "Person.Table" {
		t.Fatalf("expected IRIS qualified table split, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_OceanBaseOracleUsesSchemaFromDatabaseTree(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type:              "oceanbase",
		OceanBaseProtocol: "oracle",
	}, "SYS", "ORDERS")

	if schema != "SYS" || table != "ORDERS" {
		t.Fatalf("expected OceanBase Oracle schema/table SYS.ORDERS, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTable_DuckDBPreservesQuotedQualifiedName(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "duckdb",
	}, `"analytics.catalog"."main.schema"`, `"daily.events"."2026.06"`)

	if schemaOrDb != `"analytics.catalog"."main.schema"` {
		t.Fatalf("expected duckdb dbName/catalog path preserved, got %q", schemaOrDb)
	}
	if table != `"daily.events"."2026.06"` {
		t.Fatalf("expected duckdb qualified table preserved, got %q", table)
	}
}

func TestNormalizeSchemaAndTable_KafkaPreservesDottedTopicName(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "kafka",
	}, "topics", "orders.events.v1")

	if schemaOrDb != "topics" || table != "orders.events.v1" {
		t.Fatalf("expected kafka topic to stay intact, got %q.%q", schemaOrDb, table)
	}
}

func TestNormalizeSchemaAndTable_MQTTPreservesTopicFilter(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "mqtt",
	}, "topics", "devices/floor1.sensor.v1")

	if schemaOrDb != "topics" || table != "devices/floor1.sensor.v1" {
		t.Fatalf("expected mqtt topic filter to stay intact, got %q.%q", schemaOrDb, table)
	}
}

func TestNormalizeSchemaAndTable_RocketMQPreservesTopicName(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "rocketmq",
	}, "topics", "orders.events.v1")

	if schemaOrDb != "topics" || table != "orders.events.v1" {
		t.Fatalf("expected rocketmq topic name to stay intact, got %q.%q", schemaOrDb, table)
	}
}

func TestNormalizeSchemaAndTable_RabbitMQPreservesDottedQueueName(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "rabbitmq",
	}, "/", "orders.events.v1")

	if schemaOrDb != "/" || table != "orders.events.v1" {
		t.Fatalf("expected rabbitmq queue to stay intact, got %q.%q", schemaOrDb, table)
	}
}

func TestNormalizeMetadataSchemaAndTable_KafkaPreservesDottedTopicName(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeMetadataSchemaAndTable(connection.ConnectionConfig{
		Type: "kafka",
	}, "topics", "logs.app-1")

	if schemaOrDb != "topics" || table != "logs.app-1" {
		t.Fatalf("expected kafka metadata topic to stay intact, got %q.%q", schemaOrDb, table)
	}
}

func TestNormalizeMetadataSchemaAndTable_MQTTPreservesTopicFilter(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeMetadataSchemaAndTable(connection.ConnectionConfig{
		Type: "mqtt",
	}, "topics", "devices/floor1.sensor.v1")

	if schemaOrDb != "topics" || table != "devices/floor1.sensor.v1" {
		t.Fatalf("expected mqtt metadata topic filter to stay intact, got %q.%q", schemaOrDb, table)
	}
}

func TestNormalizeMetadataSchemaAndTable_RocketMQPreservesTopicName(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeMetadataSchemaAndTable(connection.ConnectionConfig{
		Type: "rocketmq",
	}, "topics", "orders.events.v1")

	if schemaOrDb != "topics" || table != "orders.events.v1" {
		t.Fatalf("expected rocketmq metadata topic name to stay intact, got %q.%q", schemaOrDb, table)
	}
}

func TestNormalizeMetadataSchemaAndTable_RabbitMQPreservesDottedQueueName(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeMetadataSchemaAndTable(connection.ConnectionConfig{
		Type: "rabbitmq",
	}, "/", "logs.app-1")

	if schemaOrDb != "/" || table != "logs.app-1" {
		t.Fatalf("expected rabbitmq metadata queue to stay intact, got %q.%q", schemaOrDb, table)
	}
}

func TestQuoteTableIdentByType_KingbaseNormalizesQuotedQualifiedTable(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTableByType("kingbase", "", `\"Idf_server\".\"mes_bip_wip_finished\"`)
	if schema != "Idf_server" || table != "mes_bip_wip_finished" {
		t.Fatalf("expected kingbase qualified split to Idf_server.mes_bip_wip_finished, got %q.%q", schema, table)
	}

	if got := quoteTableIdentByType("kingbase", schema, table); got != `"Idf_server".mes_bip_wip_finished` {
		t.Fatalf("unexpected kingbase table identifier: %s", got)
	}
}
