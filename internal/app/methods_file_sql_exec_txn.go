package app

import (
	"strings"
)

func updateSQLFileTransactionDepth(dbType string, depth int, stmt string) int {
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch keyword {
	case "begin":
		if sqlBeginStartsTransactionForDialect(dbType, stmt, keywordEnd) {
			if normalizeSQLClassifierDBType(dbType) == "sqlserver" {
				return depth + 1
			}
			return 1
		}
		return depth
	case "start":
		if second, _ := nextSQLKeyword(stmt, keywordEnd); second == "transaction" {
			return 1
		}
		return depth
	case "commit":
		if sqlFileTransactionCommandUsesChain(stmt, keywordEnd) {
			return 1
		}
		if normalizeSQLClassifierDBType(dbType) == "sqlserver" && depth > 0 {
			return depth - 1
		}
		return 0
	case "rollback":
		if sqlFileRollbackTargetsSavepoint(stmt, keywordEnd) {
			return depth
		}
		if sqlFileSQLServerRollbackHasNamedTarget(dbType, stmt, keywordEnd) {
			if depth > 0 {
				return depth
			}
			// SQL Server uses the same syntax for transaction names and savepoints.
			// A successful named rollback without tracked depth therefore leaves the
			// session state uncertain; keep cleanup active rather than reusing it.
			return 1
		}
		if sqlFileTransactionCommandUsesChain(stmt, keywordEnd) {
			return 1
		}
		return 0
	case "end":
		if !sqlFileStatementIsTransactionEndAlias(dbType, stmt, keywordEnd) {
			return depth
		}
		if sqlFileTransactionCommandUsesChain(stmt, keywordEnd) {
			return 1
		}
		return 0
	case "abort":
		switch normalizeSQLClassifierDBType(dbType) {
		case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb":
			if sqlFileTransactionCommandUsesChain(stmt, keywordEnd) {
				return 1
			}
			return 0
		default:
			return depth
		}
	default:
		return depth
	}
}

type sqlFileSQLServerTransactionTracker struct {
	depth                int
	outerTransactionName string
	savepointNames       map[string]struct{}
}

func (tracker sqlFileSQLServerTransactionTracker) reset() sqlFileSQLServerTransactionTracker {
	return sqlFileSQLServerTransactionTracker{}
}

func updateSQLFileSQLServerTransactionTracker(tracker sqlFileSQLServerTransactionTracker, stmt string) sqlFileSQLServerTransactionTracker {
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch keyword {
	case "begin":
		if !sqlBeginStartsTransactionForDialect("sqlserver", stmt, keywordEnd) {
			return tracker
		}
		if tracker.depth == 0 {
			tracker.outerTransactionName, _ = sqlFileSQLServerBeginTransactionName(stmt, keywordEnd)
			tracker.savepointNames = nil
		}
		tracker.depth++
		return tracker
	case "save":
		if tracker.depth == 0 {
			return tracker
		}
		if name, ok := sqlFileSQLServerTransactionNameAfterCommand(stmt, keywordEnd); ok {
			if tracker.savepointNames == nil {
				tracker.savepointNames = make(map[string]struct{})
			}
			tracker.savepointNames[name] = struct{}{}
		}
		return tracker
	case "commit":
		if tracker.depth > 0 {
			tracker.depth--
		}
		if tracker.depth == 0 {
			return tracker.reset()
		}
		return tracker
	case "rollback":
		name, named := sqlFileSQLServerTransactionNameAfterCommand(stmt, keywordEnd)
		if !named {
			return tracker.reset()
		}
		if tracker.outerTransactionName != "" && name == tracker.outerTransactionName {
			return tracker.reset()
		}
		if _, isSavepoint := tracker.savepointNames[name]; isSavepoint {
			return tracker
		}
		// SQL Server uses identical syntax for outer transaction names and
		// savepoints. An unrecognised successful target is therefore uncertain;
		// retain the depth so EOF cleanup discards rather than reuses the session.
		if tracker.depth == 0 {
			tracker.depth = 1
		}
		return tracker
	default:
		return tracker
	}
}

func sqlFileSQLServerBeginTransactionName(stmt string, keywordEnd int) (string, bool) {
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token == "distributed" {
		token, tokenEnd = nextSQLKeyword(stmt, tokenEnd)
	}
	if token != "transaction" && token != "tran" {
		return "", false
	}
	name, ok := sqlFileSQLServerIdentifierAt(stmt, tokenEnd)
	if !ok || strings.EqualFold(name, "with") {
		return "", false
	}
	return name, true
}

func sqlFileSQLServerTransactionNameAfterCommand(stmt string, keywordEnd int) (string, bool) {
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token != "transaction" && token != "tran" {
		return "", false
	}
	return sqlFileSQLServerIdentifierAt(stmt, tokenEnd)
}

func sqlFileSQLServerIdentifierAt(stmt string, start int) (string, bool) {
	start = skipSQLTrivia(stmt, start)
	if start >= len(stmt) {
		return "", false
	}
	if stmt[start] == '@' {
		end := start + 1
		for end < len(stmt) && isSQLKeywordByte(stmt[end]) {
			end++
		}
		if end == start+1 {
			return "", false
		}
		return stmt[start:end], true
	}
	end, ok := skipSQLIdentifierToken(stmt, start, "sqlserver")
	if !ok {
		return "", false
	}
	name := strings.TrimSpace(stmt[start:end])
	if len(name) >= 2 {
		switch {
		case name[0] == '[' && name[len(name)-1] == ']':
			name = strings.ReplaceAll(name[1:len(name)-1], "]]", "]")
		case (name[0] == '"' && name[len(name)-1] == '"') || (name[0] == '`' && name[len(name)-1] == '`'):
			quote := string(name[0])
			name = strings.ReplaceAll(name[1:len(name)-1], quote+quote, quote)
		}
	}
	if name == "" {
		return "", false
	}
	// SQL Server transaction and savepoint names are case-sensitive even on
	// case-insensitive servers, so preserve their spelling for matching.
	return name, true
}

func isSQLFileMySQLCompatibleDialect(dbType string) bool {
	switch normalizeSQLClassifierDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx":
		return true
	default:
		return false
	}
}

func sqlFileMySQLAutocommitAssignment(dbType string, stmt string) (disabled bool, known bool, assigned bool) {
	if !isSQLFileMySQLCompatibleDialect(dbType) {
		return false, false, false
	}
	start := skipSQLTrivia(stmt, 0)
	if start >= len(stmt) {
		return false, false, false
	}
	keyword, keywordEnd := nextSQLKeyword(stmt, start)
	if keyword != "set" {
		return false, false, false
	}
	matches := sqlFileMySQLAutocommitAssignmentPattern.FindAllStringSubmatch(stmt[keywordEnd:], -1)
	if len(matches) == 0 || len(matches[len(matches)-1]) != 2 {
		return false, false, false
	}
	switch strings.ToLower(strings.TrimSpace(matches[len(matches)-1][1])) {
	case "0", "off", "false":
		return true, true, true
	case "1", "on", "true":
		return false, true, true
	default:
		return false, false, true
	}
}

func sqlFileMySQLImplicitCommitBeforeStatement(dbType string, stmt string) bool {
	if !isSQLFileMySQLCompatibleDialect(dbType) {
		return false
	}
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch keyword {
	case "create", "drop":
		return !sqlFileMySQLTemporaryTableDDL(stmt, keywordEnd)
	case "alter", "analyze", "cache", "check", "flush", "grant", "install", "optimize", "rename", "repair", "revoke", "truncate", "uninstall":
		return true
	case "reset":
		second, _ := nextSQLKeyword(stmt, keywordEnd)
		return second != "persist"
	case "set":
		second, _ := nextSQLKeyword(stmt, keywordEnd)
		return second == "password"
	case "begin":
		return sqlBeginStartsTransactionForDialect(dbType, stmt, keywordEnd)
	case "start":
		second, _ := nextSQLKeyword(stmt, keywordEnd)
		return second == "transaction" || second == "replica" || second == "slave"
	case "stop":
		second, _ := nextSQLKeyword(stmt, keywordEnd)
		return second == "replica" || second == "slave"
	case "lock":
		second, _ := nextSQLKeyword(stmt, keywordEnd)
		return second == "tables"
	default:
		return false
	}
}

func sqlFileMySQLTableLockCommand(dbType string, stmt string) (locks bool, unlocks bool) {
	if !isSQLFileMySQLCompatibleDialect(dbType) {
		return false, false
	}
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	second, _ := nextSQLKeyword(stmt, keywordEnd)
	if second != "tables" {
		return false, false
	}
	return keyword == "lock", keyword == "unlock"
}

func sqlFileMySQLTemporaryTableDDL(stmt string, keywordEnd int) bool {
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token == "or" {
		if next, nextEnd := nextSQLKeyword(stmt, tokenEnd); next == "replace" {
			token, _ = nextSQLKeyword(stmt, nextEnd)
		}
	}
	return token == "temporary"
}

func sqlFileTransactionCommandUsesChain(stmt string, keywordEnd int) bool {
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token == "work" || token == "transaction" {
		token, tokenEnd = nextSQLKeyword(stmt, tokenEnd)
	}
	if token != "and" {
		return false
	}
	token, tokenEnd = nextSQLKeyword(stmt, tokenEnd)
	if token == "no" {
		return false
	}
	return token == "chain"
}

func sqlFileRollbackTargetsSavepoint(stmt string, keywordEnd int) bool {
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token == "work" || token == "transaction" {
		token, _ = nextSQLKeyword(stmt, tokenEnd)
	}
	return token == "to"
}

func sqlFileSQLServerRollbackHasNamedTarget(dbType string, stmt string, keywordEnd int) bool {
	if normalizeSQLClassifierDBType(dbType) != "sqlserver" {
		return false
	}
	token, tokenEnd := nextSQLKeyword(stmt, keywordEnd)
	if token != "transaction" && token != "tran" {
		return false
	}
	return skipSQLTrivia(stmt, tokenEnd) < len(stmt)
}

func sqlFileStatementIsTransactionEndAlias(dbType string, stmt string, keywordEnd int) bool {
	next, _ := nextSQLKeyword(stmt, keywordEnd)
	switch normalizeSQLClassifierDBType(dbType) {
	case "sqlite":
		return next == "" || next == "transaction"
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return next == "" || next == "work" || next == "transaction" || next == "and"
	default:
		return false
	}
}

func sqlFileStatementFinishesTransaction(stmt string) bool {
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch keyword {
	case "commit":
		return true
	case "rollback":
		return !sqlFileRollbackTargetsSavepoint(stmt, keywordEnd)
	default:
		return false
	}
}
