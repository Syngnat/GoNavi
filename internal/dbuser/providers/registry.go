// Package providers 把连接类型映射到 dbuser 的各数据源族实现。
// 这是唯一同时引用所有族子包的地方，避免族子包之间互相依赖。
package providers

import (
	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/dbuser/clickhouse"
	"GoNavi-Wails/internal/dbuser/mongo"
	"GoNavi-Wails/internal/dbuser/mysql"
	"GoNavi-Wails/internal/dbuser/oracle"
	"GoNavi-Wails/internal/dbuser/postgres"
	"GoNavi-Wails/internal/dbuser/redisacl"
	"GoNavi-Wails/internal/dbuser/sqlserver"
	"GoNavi-Wails/internal/dbuser/tdengine"
)

// Resolve 按方言归一后的类型返回 Provider；不支持的类型返回 false。
// target.DBType 应为 resolveDDLDBType 的结果（goldendb 已归一为 mysql，
// OceanBase Oracle 租户已归一为 oracle）。
func Resolve(target dbuser.Target) (dbuser.Provider, bool) {
	switch target.DBType {
	case "mysql", "mariadb", "oceanbase":
		return mysql.New(), true
	case "postgres", "kingbase", "highgo":
		return postgres.New(), true
	case "opengauss", "gaussdb", "vastbase":
		return postgres.NewOpenGauss(), true
	case "sqlserver":
		return sqlserver.New(), true
	case "oracle":
		return oracle.New(), true
	case "dameng":
		return oracle.NewDameng(), true
	case "clickhouse":
		return clickhouse.New(), true
	case "tdengine":
		return tdengine.New(), true
	case "mongodb":
		return mongo.New(), true
	case "redis":
		return redisacl.New(), true
	default:
		return nil, false
	}
}
