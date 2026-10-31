package app

import (
	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/esconsole"
	"GoNavi-Wails/internal/hivesql"
)

func isReadOnlySQLQuery(dbType string, query string) bool {
	switch normalizeSQLClassifierDBType(dbType) {
	case "hive":
		if hiveQueryMayRunExternalCode(query) {
			return false
		}
		if keyword, _ := nextSQLKeyword(query, 0); keyword == "select" || keyword == "with" {
			return hivesql.ValidateReadOnlySourceQuery(query) == nil
		}
		if isHiveSettingReadQuery(query) {
			return true
		}
	case "redis":
		return redisCommandOperation(parseRedisCommand(query)) == ai.SQLOpQuery
	case "mongodb":
		return isReadOnlyMongoCommand(query)
	case "milvus":
		return isReadOnlyMilvusCommand(query)
	case "elasticsearch":
		batch, err := esconsole.ParseSource(query, "gonavi-default-index")
		return err == nil && !batch.Blocked && !batch.ContainsWrite && !batch.ContainsScript
	case "weaviate":
		return db.IsWeaviateReadCommand(query)
	case "meilisearch":
		return db.IsMeilisearchReadCommand(query)
	case "typesense":
		return db.IsTypesenseReadCommand(query)
	case "etcd":
		return db.IsEtcdReadCommand(query)
	case "zookeeper":
		return db.IsZooKeeperReadCommand(query)
	case "influxdb":
		// Flux 按 to() 判写；InfluxQL 与 3.x 的 SQL 继续走下面的通用规则（SELECT ... INTO 视为写）。
		if db.IsInfluxFluxQuery(query) {
			return !db.InfluxFluxQueryWrites(query)
		}
	}
	if hasExecutableSQLComment(dbType, query) || hasDatabaseJobMutationSQL(dbType, query) {
		return false
	}

	keyword, withHasWrite := sqlDataOperationInfo(query, dbType)
	if withHasWrite {
		return false
	}
	if keyword == "select" && isSQLSelectIntoStatement(query, dbType) {
		return false
	}
	if keyword == "explain" && explainAnalyzeMayWrite(query, dbType) {
		return false
	}
	if keyword == "pragma" {
		// PRAGMA 本身可能写（如 PRAGMA journal_mode=WAL），其参数解析由
		// pragmaMayWrite 负责；此外仍需扫描体内是否尾随了缺分号的写语句。
		return !pragmaMayWrite(query, dbType) && !containsEmbeddedWriteStatement(dbType, query)
	}
	// 首关键字为读关键字时，语句体内仍可能内嵌写语句：当语句之间缺少分号时，
	// 切分器无法切出边界，整段会被当成一条只读语句（issue #1308）。这里追加一次
	// 词法扫描，只有确认体内不含写语句才判定为只读。
	switch keyword {
	case "select", "with", "show", "describe", "desc", "explain", "values", "consume":
		return !containsEmbeddedWriteStatement(dbType, query)
	default:
		return false
	}
}
