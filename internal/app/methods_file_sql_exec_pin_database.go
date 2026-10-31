package app

import "strings"

// pinSQLFileImportDatabase 在导入已指定目标库时，把纯 USE 语句改写到该库。
// 连接虽然按目标库打开，但 mysqldump / Navicat 脚本里的 USE `其他库` 会把同一会话切走，
// 后续建表和写入就会落到文件里的库。只改写整句都是 USE 的语句，过程体里的 USE 不动。
func pinSQLFileImportDatabase(dbType, statement, database string) string {
	pinned := strings.TrimSpace(database)
	if pinned != "" && normalizeInsertSQLDialect(dbType) == "hive" {
		statement = pinHiveCreateDatabase(statement, pinned)
	}
	if pinned == "" || !sqlFileDialectHonorsUseDatabase(dbType) || !isSQLUseDatabaseStatement(dbType, statement) {
		return statement
	}
	return "USE " + quoteIdentByType(dbType, pinned)
}

func sqlFileDialectHonorsUseDatabase(dbType string) bool {
	switch normalizeSQLClassifierDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "tdengine", "clickhouse", "sqlserver", "hive":
		return true
	default:
		return false
	}
}

func isSQLUseDatabaseStatement(dbType, statement string) bool {
	keyword, end := nextSQLKeyword(statement, 0)
	if keyword != "use" {
		return false
	}
	pos := skipSQLTrivia(statement, end)
	next, ok := skipSQLIdentifierToken(statement, pos, dbType)
	if !ok || next <= pos {
		return false
	}
	pos = skipSQLTrivia(statement, next)
	if pos < len(statement) && statement[pos] == ';' {
		pos = skipSQLTrivia(statement, pos+1)
	}
	return pos >= len(statement)
}
