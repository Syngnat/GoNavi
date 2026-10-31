package app

import (
	"strings"

	"GoNavi-Wails/internal/hivesql"
)

// SQLImportPreflightHiveClientCommand identifies Beeline/Hive CLI-only commands.
const SQLImportPreflightHiveClientCommand SQLImportPreflightReasonCode = "hive_client_command"

// SQLImportPreflightHiveVariableSubstitution rejects server-expanded script text.
const SQLImportPreflightHiveVariableSubstitution SQLImportPreflightReasonCode = "hive_variable_substitution"

// SQLImportPreflightHiveTransactionControl rejects transactions Hive cannot open.
const SQLImportPreflightHiveTransactionControl SQLImportPreflightReasonCode = "hive_transaction_control"

func hiveImportHasVariableSubstitution(statement string) bool {
	// Hive substitutes before SQL parsing, including inside quoted literals.
	// Scan without allocating tokens: import statements can be tens of MB.
	for pos := 0; pos < len(statement); {
		if strings.HasPrefix(statement[pos:], "--") {
			end := strings.IndexByte(statement[pos:], '\n')
			if end < 0 {
				return false
			}
			pos += end + 1
			continue
		}
		if strings.HasPrefix(statement[pos:], "/*") {
			end := strings.Index(statement[pos+2:], "*/")
			if end < 0 {
				return false
			}
			pos += end + 4
			continue
		}
		if statement[pos] == '\'' || statement[pos] == '"' || statement[pos] == 96 {
			end := skipHivePolicyQuote(statement, pos)
			if strings.Contains(statement[pos:end], "${") {
				return true
			}
			pos = end
			continue
		}
		if strings.HasPrefix(statement[pos:], "${") {
			return true
		}
		pos++
	}
	return false
}

func hiveImportTransactionControl(statement string) bool {
	keyword, end := nextSQLKeyword(statement, 0)
	switch keyword {
	case "begin", "commit", "rollback", "savepoint":
		return true
	case "start":
		next, _ := nextSQLKeyword(statement, end)
		return next == "transaction"
	case "set":
		next, _ := nextSQLKeyword(statement, end)
		return next == "autocommit" || next == "transaction"
	default:
		return false
	}
}

func pinHiveCreateDatabase(statement, database string) string {
	tokens, err := hiveBackupTokens(statement)
	if err != nil {
		return statement
	}
	if len(tokens) > 0 && tokens[len(tokens)-1].text == ";" {
		tokens = tokens[:len(tokens)-1]
	}
	if len(tokens) != 3 && len(tokens) != 6 {
		return statement
	}
	if !strings.EqualFold(tokens[0].text, "create") || !strings.EqualFold(tokens[1].text, "database") || tokens[len(tokens)-1].kind != 'i' {
		return statement
	}
	prefix := "CREATE DATABASE "
	if len(tokens) == 6 {
		if !strings.EqualFold(tokens[2].text, "if") || !strings.EqualFold(tokens[3].text, "not") || !strings.EqualFold(tokens[4].text, "exists") {
			return statement
		}
		prefix += "IF NOT EXISTS "
	}
	return prefix + hivesql.QuoteIdentifier(database)
}

func hiveBackupCreatesDatabase(preamble []byte) bool {
	text := strings.TrimPrefix(string(preamble), "\ufeff")
	if !strings.HasPrefix(strings.TrimSpace(text), "-- GoNavi SQL Export") || !strings.Contains(text, "-- Dialect: hive") {
		return false
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "CREATE DATABASE IF NOT EXISTS ") {
			return true
		}
	}
	return false
}
