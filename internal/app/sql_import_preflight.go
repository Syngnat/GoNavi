package app

import (
	"errors"
	"io"
	"strings"
)

type SQLImportPreflightReasonCode string

const (
	SQLImportPreflightPostgresCopyFromStdin SQLImportPreflightReasonCode = "postgres_copy_from_stdin"
	SQLImportPreflightPsqlMetaCommand       SQLImportPreflightReasonCode = "psql_meta_command"
	SQLImportPreflightSQLCmdCommand         SQLImportPreflightReasonCode = "sqlcmd_command"
	SQLImportPreflightMySQLClientCommand    SQLImportPreflightReasonCode = "mysql_client_command"
	SQLImportPreflightSQLPlusCommand        SQLImportPreflightReasonCode = "sqlplus_command"
	SQLImportPreflightSQLiteClientCommand   SQLImportPreflightReasonCode = "sqlite_client_command"
)

type SQLImportPreflightReason struct {
	Code           SQLImportPreflightReasonCode `json:"code"`
	DBType         string                       `json:"dbType"`
	StatementIndex int                          `json:"statementIndex"`
	SourceByte     int64                        `json:"sourceByte,omitempty"`
	Directive      string                       `json:"directive,omitempty"`
}

type SQLImportPreflightResult struct {
	Safe   bool                      `json:"safe"`
	Reason *SQLImportPreflightReason `json:"reason,omitempty"`
}

var errSQLImportPreflightRejected = errors.New("SQL import preflight rejected the source")

func PreflightSQLImport(reader io.Reader, dbType string) (SQLImportPreflightResult, error) {
	return PreflightSQLImportWithOptions(reader, SQLStreamOptions{
		DBType:            dbType,
		MaxStatementBytes: DefaultSQLImportMaxStatementBytes,
	})
}

func PreflightSQLImportWithOptions(reader io.Reader, options SQLStreamOptions) (SQLImportPreflightResult, error) {
	result := SQLImportPreflightResult{Safe: true}
	normalizedType := normalizeExplainLexicalDBType(options.DBType)
	maxStatementBytes := options.MaxStatementBytes
	if maxStatementBytes <= 0 {
		maxStatementBytes = DefaultSQLImportMaxStatementBytes
	}
	_, err := StreamSQLFileWithOptions(reader, SQLStreamOptions{
		DBType:            normalizedType,
		MaxStatementBytes: maxStatementBytes,
	}, func(index int, stmt string) error {
		statementResult := PreflightSQLStatement(stmt, normalizedType, index)
		if !statementResult.Safe {
			result = statementResult
			return errSQLImportPreflightRejected
		}
		return nil
	})
	if errors.Is(err, errSQLImportPreflightRejected) {
		return result, nil
	}
	if err != nil {
		return SQLImportPreflightResult{}, err
	}
	return result, nil
}

// PreflightSQLStatement classifies one already-split statement without
// allocating another streaming splitter. statementIndex is zero-based.
func PreflightSQLStatement(stmt, dbType string, statementIndex int) SQLImportPreflightResult {
	normalizedType := normalizeExplainLexicalDBType(dbType)
	if isSQLImportPostgresDialect(normalizedType) && isPostgresCopyFromStdinStatement(stmt) {
		return SQLImportPreflightResult{
			Safe: false,
			Reason: &SQLImportPreflightReason{
				Code:           SQLImportPreflightPostgresCopyFromStdin,
				DBType:         normalizedType,
				StatementIndex: statementIndex,
				Directive:      "COPY FROM STDIN",
			},
		}
	}
	if code, directive := findSQLImportClientCommand(stmt, normalizedType); code != "" {
		return SQLImportPreflightResult{
			Safe: false,
			Reason: &SQLImportPreflightReason{
				Code:           code,
				DBType:         normalizedType,
				StatementIndex: statementIndex,
				Directive:      directive,
			},
		}
	}
	return SQLImportPreflightResult{Safe: true}
}

func isSQLImportPostgresDialect(dbType string) bool {
	switch normalizeExplainLexicalDBType(dbType) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return true
	default:
		return false
	}
}

func isPostgresCopyFromStdinStatement(stmt string) bool {
	keyword, position := nextSQLKeyword(stmt, 0)
	if keyword != "copy" {
		return false
	}
	parenDepth := 0
	for position < len(stmt) {
		position = skipSQLTrivia(stmt, position)
		if position >= len(stmt) {
			break
		}
		switch stmt[position] {
		case '\'', '"', '`':
			position = skipSQLImportQuotedValue(stmt, position, stmt[position])
			continue
		case '(':
			parenDepth++
			position++
			continue
		case ')':
			if parenDepth > 0 {
				parenDepth--
			}
			position++
			continue
		case '$':
			if tag := parseSQLDollarTagAt(stmt, position); tag != "" {
				position += len(tag)
				if closeOffset := strings.Index(stmt[position:], tag); closeOffset >= 0 {
					position += closeOffset + len(tag)
				} else {
					return false
				}
				continue
			}
		}
		if !isSQLIdentifierStart(stmt[position]) {
			position++
			continue
		}
		end := position + 1
		for end < len(stmt) && isSQLIdentifierPart(stmt[end]) {
			end++
		}
		if parenDepth == 0 && strings.EqualFold(stmt[position:end], "from") {
			nextPosition := skipSQLTrivia(stmt, end)
			next, _ := nextSQLKeyword(stmt, nextPosition)
			return next == "stdin"
		}
		position = end
	}
	return false
}

func skipSQLImportQuotedValue(text string, start int, quote byte) int {
	for position := start + 1; position < len(text); position++ {
		if text[position] == '\\' {
			position++
			continue
		}
		if text[position] != quote {
			continue
		}
		if position+1 < len(text) && text[position+1] == quote {
			position++
			continue
		}
		return position + 1
	}
	return len(text)
}

func normalizeSQLImportDirective(raw string) string {
	return strings.TrimSpace(raw)
}

func findSQLImportClientCommand(statement, dbType string) (SQLImportPreflightReasonCode, string) {
	state := sqlImportPreflightLexicalState{}
	for lineStart := 0; lineStart <= len(statement); {
		lineEnd := strings.IndexByte(statement[lineStart:], '\n')
		if lineEnd < 0 {
			lineEnd = len(statement)
		} else {
			lineEnd += lineStart
		}
		line := statement[lineStart:lineEnd]
		if state.acceptsClientCommandLine() {
			trimmed := normalizeSQLImportDirective(line)
			switch normalizeExplainLexicalDBType(dbType) {
			case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
				if strings.HasPrefix(trimmed, "\\") {
					return SQLImportPreflightPsqlMetaCommand, firstSQLImportDirectiveToken(trimmed)
				}
			case "sqlserver":
				if strings.HasPrefix(trimmed, ":") || strings.HasPrefix(trimmed, "!!") {
					return SQLImportPreflightSQLCmdCommand, firstSQLImportDirectiveToken(trimmed)
				}
			case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "goldendb", "sphinx", "tidb":
				token := firstSQLImportDirectiveToken(trimmed)
				if strings.EqualFold(token, "source") || strings.HasPrefix(token, "\\.") || strings.HasPrefix(token, "\\!") {
					return SQLImportPreflightMySQLClientCommand, token
				}
			case "oracle", "dameng":
				token := firstSQLImportDirectiveToken(trimmed)
				if isSQLPlusClientDirective(token) {
					if strings.HasPrefix(token, "@@") {
						return SQLImportPreflightSQLPlusCommand, "@@"
					}
					if strings.HasPrefix(token, "@") {
						return SQLImportPreflightSQLPlusCommand, "@"
					}
					return SQLImportPreflightSQLPlusCommand, token
				}
			case "sqlite":
				token := firstSQLImportDirectiveToken(trimmed)
				if strings.HasPrefix(token, ".") {
					return SQLImportPreflightSQLiteClientCommand, token
				}
			}
		}
		state.consume(line, dbType)
		if state.clientCommand != "" {
			return state.clientCommandCode, state.clientCommand
		}
		if lineEnd >= len(statement) {
			break
		}
		state.consume("\n", dbType)
		lineStart = lineEnd + 1
	}
	return "", ""
}

func firstSQLImportDirectiveToken(line string) string {
	if end := strings.IndexAny(line, " \t\r\n;"); end >= 0 {
		return line[:end]
	}
	return line
}

func isSQLPlusClientDirective(token string) bool {
	if strings.HasPrefix(token, "@") {
		return true
	}
	switch strings.ToLower(strings.TrimSuffix(token, ";")) {
	case "accept", "btitle", "break", "column", "compute", "connect", "define", "disconnect", "exit", "host", "print", "prompt", "quit", "remark", "spool", "start", "ttitle", "undefine", "variable", "whenever":
		return true
	default:
		return false
	}
}

type sqlImportPreflightLexicalState struct {
	inSingle          bool
	inDouble          bool
	inBacktick        bool
	inLineComment     bool
	inBlockComment    bool
	escaped           bool
	dollarTag         string
	clientCommand     string
	clientCommandCode SQLImportPreflightReasonCode
}

func (state *sqlImportPreflightLexicalState) acceptsClientCommandLine() bool {
	return !state.inSingle && !state.inDouble && !state.inBacktick && !state.inBlockComment && state.dollarTag == ""
}

func (state *sqlImportPreflightLexicalState) consume(text, dbType string) {
	for index := 0; index < len(text); index++ {
		ch := text[index]
		next := byte(0)
		if index+1 < len(text) {
			next = text[index+1]
		}
		if state.inLineComment {
			if ch == '\n' {
				state.inLineComment = false
			}
			continue
		}
		if state.inBlockComment {
			if ch == '*' && next == '/' {
				state.inBlockComment = false
				index++
			}
			continue
		}
		if state.dollarTag != "" {
			if strings.HasPrefix(text[index:], state.dollarTag) {
				index += len(state.dollarTag) - 1
				state.dollarTag = ""
			}
			continue
		}
		if state.escaped {
			state.escaped = false
			continue
		}
		if (state.inSingle || state.inDouble) && ch == '\\' {
			state.escaped = true
			continue
		}
		if !state.inDouble && !state.inBacktick && ch == '\'' {
			if state.inSingle && next == '\'' {
				index++
				continue
			}
			state.inSingle = !state.inSingle
			continue
		}
		if !state.inSingle && !state.inBacktick && ch == '"' {
			state.inDouble = !state.inDouble
			continue
		}
		if !state.inSingle && !state.inDouble && ch == '`' {
			state.inBacktick = !state.inBacktick
			continue
		}
		if state.inSingle || state.inDouble || state.inBacktick {
			continue
		}
		if ch == '\\' {
			switch {
			case isSQLImportPostgresDialect(dbType):
				state.clientCommandCode = SQLImportPreflightPsqlMetaCommand
			case isSQLImportMySQLClientDialect(dbType):
				state.clientCommandCode = SQLImportPreflightMySQLClientCommand
			default:
				continue
			}
			state.clientCommand = firstSQLImportDirectiveToken(text[index:])
			return
		}
		if ch == '-' && next == '-' && isSQLDashLineCommentStart(dbType, text, index) {
			state.inLineComment = true
			index++
			continue
		}
		if ch == '#' && supportsSQLHashLineComment(dbType) {
			state.inLineComment = true
			continue
		}
		if ch == '/' && next == '*' {
			state.inBlockComment = true
			index++
			continue
		}
		if ch == '$' && supportsSQLDollarQuote(dbType) {
			if tag := parseSQLDollarTagAt(text, index); tag != "" {
				state.dollarTag = tag
				index += len(tag) - 1
			}
		}
	}
}

func isSQLImportMySQLClientDialect(dbType string) bool {
	switch normalizeExplainLexicalDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "goldendb", "sphinx", "tidb":
		return true
	default:
		return false
	}
}
