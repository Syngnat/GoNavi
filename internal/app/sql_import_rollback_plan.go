package app

import (
	"errors"
	"io"
	"strings"
)

// sqlImportRollbackPlan describes what a SQL file can change. A whole-database
// snapshot is the safe fallback for unknown statements, but dumping every table
// for a 14-statement CREATE-only script makes a small import wait on unrelated
// data. Known statements are narrowed to the tables they actually touch.
type sqlImportRollbackPlan struct {
	Tables        []string
	WholeDatabase bool
	AdditiveOnly  bool
}

var errSQLImportRollbackPlanWholeDatabase = errors.New("SQL import rollback plan requires a whole database snapshot")

func planSQLImportRollbackFile(filePath, dbType string, maxStatementBytes int64) (sqlImportRollbackPlan, error) {
	source, err := OpenSQLImportSource(filePath, SQLImportSourceOptions{})
	if err != nil {
		return sqlImportRollbackPlan{}, err
	}
	defer source.Close()
	return planSQLImportRollbackReader(source, dbType, maxStatementBytes)
}

func planSQLImportRollbackReader(reader io.Reader, dbType string, maxStatementBytes int64) (sqlImportRollbackPlan, error) {
	plan := sqlImportRollbackPlan{AdditiveOnly: true}
	normalizedType := normalizeExplainLexicalDBType(dbType)
	_, err := StreamSQLFileWithOptions(reader, SQLStreamOptions{
		DBType:            normalizedType,
		MaxStatementBytes: maxStatementBytes,
	}, func(_ int, statement string) error {
		if err := addSQLImportRollbackStatement(&plan, statement, normalizedType); err != nil {
			if errors.Is(err, errSQLImportRollbackPlanWholeDatabase) {
				plan.WholeDatabase = true
				plan.AdditiveOnly = false
			}
			return err
		}
		return nil
	})
	if errors.Is(err, errSQLImportRollbackPlanWholeDatabase) {
		return plan, nil
	}
	if err != nil {
		return sqlImportRollbackPlan{}, err
	}
	return plan, nil
}

func addSQLImportRollbackStatement(plan *sqlImportRollbackPlan, statement, dbType string) error {
	keyword, position := nextSQLKeyword(statement, 0)
	switch keyword {
	case "create":
		return addSQLImportCreateRollbackPlan(plan, statement, position, dbType)
	case "insert", "replace":
		plan.AdditiveOnly = false
		position = skipSQLImportModifiers(statement, position, "low_priority", "delayed", "high_priority", "ignore")
		next, end := nextSQLKeyword(statement, position)
		if next != "into" {
			return errSQLImportRollbackPlanWholeDatabase
		}
		return addSQLImportRollbackTable(plan, statement, end, dbType)
	case "update":
		plan.AdditiveOnly = false
		position = skipSQLImportModifiers(statement, position, "low_priority", "ignore")
		if hasSQLImportTopLevelJoin(statement) {
			return errSQLImportRollbackPlanWholeDatabase
		}
		return addSQLImportRollbackTable(plan, statement, position, dbType)
	case "delete":
		plan.AdditiveOnly = false
		next, end := nextSQLKeyword(statement, position)
		if next != "from" {
			return errSQLImportRollbackPlanWholeDatabase
		}
		return addSQLImportRollbackTable(plan, statement, end, dbType)
	case "alter":
		next, end := nextSQLKeyword(statement, position)
		switch next {
		case "table", "view":
			plan.AdditiveOnly = false
			return addSQLImportRollbackTable(plan, statement, end, dbType)
		case "database", "schema":
			return errSQLImportRollbackPlanWholeDatabase
		default:
			return nil
		}
	case "drop":
		next, end := nextSQLKeyword(statement, position)
		switch next {
		case "table", "view":
			plan.AdditiveOnly = false
			return addSQLImportRollbackTableList(plan, statement, end, dbType)
		case "database", "schema":
			return errSQLImportRollbackPlanWholeDatabase
		default:
			return nil
		}
	case "truncate":
		plan.AdditiveOnly = false
		next, end := nextSQLKeyword(statement, position)
		if next == "table" {
			return addSQLImportRollbackTable(plan, statement, end, dbType)
		}
		return addSQLImportRollbackTable(plan, statement, position, dbType)
	case "load":
		plan.AdditiveOnly = false
		position = skipSQLImportThroughKeyword(statement, position, "into")
		if position < 0 {
			return errSQLImportRollbackPlanWholeDatabase
		}
		next, end := nextSQLKeyword(statement, position)
		if next == "table" {
			position = end
		}
		return addSQLImportRollbackTable(plan, statement, position, dbType)
	case "rename":
		return errSQLImportRollbackPlanWholeDatabase
	case "call", "execute", "do", "merge", "handler", "with":
		return errSQLImportRollbackPlanWholeDatabase
	case "set", "use", "start", "begin", "commit", "rollback", "savepoint", "release",
		"lock", "unlock", "select", "show", "describe", "desc", "explain",
		"analyze", "optimise", "optimize", "repair", "flush", "check", "checksum",
		"grant", "revoke":
		return nil
	default:
		return errSQLImportRollbackPlanWholeDatabase
	}
}

func addSQLImportCreateRollbackPlan(plan *sqlImportRollbackPlan, statement string, position int, dbType string) error {
	next, end := nextSQLKeyword(statement, position)
	if next == "or" {
		return errSQLImportRollbackPlanWholeDatabase
	}
	if next == "temporary" {
		next, end = nextSQLKeyword(statement, end)
	}
	switch next {
	case "table":
		position = skipSQLImportIfNotExists(statement, end)
		return addSQLImportRollbackTable(plan, statement, position, dbType)
	case "view":
		position = skipSQLImportIfNotExists(statement, end)
		return addSQLImportRollbackTable(plan, statement, position, dbType)
	case "database", "schema", "index", "unique", "fulltext", "spatial",
		"sequence", "trigger", "procedure", "function", "user", "role", "tablespace":
		return nil
	default:
		return errSQLImportRollbackPlanWholeDatabase
	}
}

func addSQLImportRollbackTable(plan *sqlImportRollbackPlan, statement string, position int, dbType string) error {
	name, _, ok := readSQLImportTableName(statement, position, dbType)
	if !ok || name == "" {
		return errSQLImportRollbackPlanWholeDatabase
	}
	plan.addTable(name)
	return nil
}

func addSQLImportRollbackTableList(plan *sqlImportRollbackPlan, statement string, position int, dbType string) error {
	position = skipSQLImportIfExists(statement, position)
	for {
		position = skipSQLTrivia(statement, position)
		if position >= len(statement) {
			return nil
		}
		name, end, ok := readSQLImportTableName(statement, position, dbType)
		if !ok || name == "" {
			return errSQLImportRollbackPlanWholeDatabase
		}
		plan.addTable(name)
		position = skipSQLTrivia(statement, end)
		if position >= len(statement) || statement[position] != ',' {
			return nil
		}
		position++
	}
}

func (plan *sqlImportRollbackPlan) addTable(name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	for _, existing := range plan.Tables {
		if strings.EqualFold(existing, name) {
			return
		}
	}
	plan.Tables = append(plan.Tables, name)
}

func readSQLImportTableName(statement string, position int, dbType string) (string, int, bool) {
	name, end, ok := readSQLIdentifierName(statement, position, dbType)
	if !ok || name == "" {
		return "", position, false
	}
	position = skipSQLTrivia(statement, end)
	if position >= len(statement) || statement[position] != '.' {
		return name, end, true
	}
	next, nextEnd, ok := readSQLIdentifierName(statement, position+1, dbType)
	if !ok || next == "" {
		return name, end, true
	}
	return name + "." + next, nextEnd, true
}

func skipSQLImportModifiers(statement string, position int, modifiers ...string) int {
	for {
		next, end := nextSQLKeyword(statement, position)
		matched := false
		for _, modifier := range modifiers {
			if next == modifier {
				position = end
				matched = true
				break
			}
		}
		if !matched {
			return position
		}
	}
}

func skipSQLImportIfNotExists(statement string, position int) int {
	next, end := nextSQLKeyword(statement, position)
	if next != "if" {
		return position
	}
	next, end = nextSQLKeyword(statement, end)
	if next == "not" {
		next, end = nextSQLKeyword(statement, end)
	}
	if next == "exists" {
		return end
	}
	return position
}

func skipSQLImportIfExists(statement string, position int) int {
	next, end := nextSQLKeyword(statement, position)
	if next != "if" {
		return position
	}
	next, end = nextSQLKeyword(statement, end)
	if next == "exists" {
		return end
	}
	return position
}

func skipSQLImportThroughKeyword(statement string, position int, target string) int {
	for position < len(statement) {
		next, end := nextSQLKeyword(statement, position)
		if next == target {
			return end
		}
		if end <= position {
			return -1
		}
		position = end
	}
	return -1
}

func hasSQLImportTopLevelJoin(statement string) bool {
	position := 0
	for position < len(statement) {
		next, end := nextSQLKeyword(statement, position)
		if next == "join" {
			return true
		}
		if end <= position {
			return false
		}
		position = end
	}
	return false
}
