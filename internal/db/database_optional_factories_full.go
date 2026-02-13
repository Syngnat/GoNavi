//go:build gonavi_full_drivers

package db

func registerOptionalDatabaseFactories() {
	registerDatabaseFactory(newOptionalDriverAgentDatabase("mariadb"), "mariadb")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("diros"), "diros", "doris")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("sphinx"), "sphinx")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("sqlserver"), "sqlserver")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("sqlite"), "sqlite")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("duckdb"), "duckdb")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("dameng"), "dameng")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("kingbase"), "kingbase")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("highgo"), "highgo")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("vastbase"), "vastbase")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("mongodb"), "mongodb")
	registerDatabaseFactory(newOptionalDriverAgentDatabase("tdengine"), "tdengine")
}
