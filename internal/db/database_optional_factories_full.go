//go:build gonavi_full_drivers

package db

func registerOptionalDatabaseFactories() {
	registerDatabaseFactory(newOptionalDriverAgentDatabase("mariadb"), "mariadb")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("oceanbase"), "oceanbase")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("diros"), "diros", "doris")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("starrocks"), "starrocks")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("sphinx"), "sphinx")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("sqlserver"), "sqlserver")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("sqlite"), "sqlite")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("duckdb"), "duckdb")
	registerDatabaseFactory(newOptionalDriverAgentTransactionalDatabase("dameng"), "dameng")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("kingbase"), "kingbase")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("highgo"), "highgo")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("vastbase"), "vastbase")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("opengauss"), "opengauss", "open_gauss", "open-gauss")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("gaussdb"), "gaussdb", "gauss_db", "gauss-db")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("iris"), "iris", "intersystems")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("cache"), "cache", "intersystems-cache", "intersystemscache", "intersystems-cache-database")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("mongodb"), "mongodb")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("tdengine"), "tdengine")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("iotdb"), "iotdb", "apache-iotdb", "apache_iotdb")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("clickhouse"), "clickhouse")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("elasticsearch"), "elasticsearch", "elastic")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("trino"), "trino")
}
