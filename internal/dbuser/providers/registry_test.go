package providers

import (
	"testing"

	"GoNavi-Wails/internal/dbuser"
)

func TestResolveMapsEverySupportedTypeToItsFamily(t *testing.T) {
	cases := map[string]dbuser.Family{
		"mysql": dbuser.FamilyMySQL, "mariadb": dbuser.FamilyMySQL, "oceanbase": dbuser.FamilyMySQL,
		"postgres": dbuser.FamilyPostgres, "kingbase": dbuser.FamilyPostgres, "highgo": dbuser.FamilyPostgres,
		"opengauss": dbuser.FamilyOpenGauss, "gaussdb": dbuser.FamilyOpenGauss, "vastbase": dbuser.FamilyOpenGauss,
		"sqlserver": dbuser.FamilySQLServer, "oracle": dbuser.FamilyOracle, "dameng": dbuser.FamilyDameng,
		"clickhouse": dbuser.FamilyClickHouse, "tdengine": dbuser.FamilyTDengine, "mongodb": dbuser.FamilyMongo, "redis": dbuser.FamilyRedis,
	}
	for dbType, family := range cases {
		provider, ok := Resolve(dbuser.Target{DBType: dbType})
		if !ok || provider.Family() != family {
			t.Fatalf("%s resolved to %v (ok=%v), want %s", dbType, provider, ok, family)
		}
	}
	for _, dbType := range []string{"sqlite", "duckdb", "sphinx", "trino", "iris", "diros", "starrocks", "iotdb", "elasticsearch", "custom", "kafka", ""} {
		if _, ok := Resolve(dbuser.Target{DBType: dbType}); ok {
			t.Fatalf("%s must not be supported", dbType)
		}
	}
}
