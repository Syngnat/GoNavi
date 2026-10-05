package app

import (
	"bufio"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func quoteIdentByType(dbType string, ident string) string {
	if strings.TrimSpace(ident) == "" {
		return ""
	}

	dbType = resolveDDLDBType(connection.ConnectionConfig{Type: dbType})
	if segments := db.SplitSQLIdentifierPathForDialect(ident, dbType); len(segments) == 1 && segments[0].Quoted {
		ident = segments[0].Value
	}

	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "tdengine", "clickhouse":
		return "`" + strings.ReplaceAll(ident, "`", "``") + "`"
	case "kingbase":
		return db.QuoteKingbaseIdentifier(ident)
	case "sqlserver":
		escaped := strings.ReplaceAll(ident, "]", "]]")
		return "[" + escaped + "]"
	default:
		return `"` + strings.ReplaceAll(ident, `"`, `""`) + `"`
	}
}

func quoteQualifiedIdentByType(dbType string, ident string) string {
	raw := strings.TrimSpace(ident)
	if raw == "" {
		return raw
	}

	dbType = resolveDDLDBType(connection.ConnectionConfig{Type: dbType})
	if registryUsesFlatObjectNames(dbType) {
		// etcd 键路径、znode 路径整体是一个标识符，路径里的点不是限定符。
		return quoteIdentByType(dbType, raw)
	}
	if dbType == "trino" {
		segments := db.SplitSQLIdentifierPathForDialect(raw, dbType)
		parts := make([]string, 0, len(segments))
		for _, segment := range segments {
			parts = append(parts, segment.Value)
		}
		switch {
		case len(parts) >= 3:
			catalog := strings.TrimSpace(parts[0])
			schema := strings.TrimSpace(parts[1])
			table := strings.TrimSpace(strings.Join(parts[2:], "."))
			if catalog != "" && schema != "" && table != "" {
				return quoteIdentByType(dbType, catalog) + "." + quoteIdentByType(dbType, schema) + "." + quoteIdentByType(dbType, table)
			}
		case len(parts) <= 2:
			return quoteIdentByType(dbType, raw)
		}
	}
	if dbType == "kingbase" {
		schema, table := db.SplitKingbaseQualifiedName(raw)
		if table == "" {
			return quoteIdentByType(dbType, raw)
		}
		if schema == "" {
			return quoteIdentByType(dbType, table)
		}
		return quoteIdentByType(dbType, schema) + "." + quoteIdentByType(dbType, table)
	}
	if dbType == "dameng" {
		schema, table := db.SplitSQLQualifiedNameForDialect(raw, dbType)
		if table == "" {
			return quoteIdentByType(dbType, raw)
		}
		if schema == "" {
			return quoteIdentByType(dbType, table)
		}
		return quoteIdentByType(dbType, schema) + "." + quoteIdentByType(dbType, table)
	}

	segments := db.SplitSQLIdentifierPathForDialect(raw, dbType)
	if len(segments) <= 1 {
		return quoteIdentByType(dbType, raw)
	}

	quotedParts := make([]string, 0, len(segments))
	for _, segment := range segments {
		part := strings.TrimSpace(segment.Value)
		if part == "" {
			continue
		}
		quotedParts = append(quotedParts, quoteIdentByType(dbType, part))
	}

	if len(quotedParts) == 0 {
		return quoteIdentByType(dbType, raw)
	}
	return strings.Join(quotedParts, ".")
}

func writeSQLHeader(w *bufio.Writer, config connection.ConnectionConfig, dbName string) error {
	return writeSQLHeaderWithDatabaseBootstrap(w, config, dbName, true, false)
}

func writeSQLSchemaExportHeader(
	w *bufio.Writer,
	config connection.ConnectionConfig,
	dbName string,
	schemaName string,
) error {
	safeSchemaName := strings.TrimSpace(schemaName)
	if safeSchemaName == "" {
		return errors.New("schema name is required")
	}
	if err := writeSQLHeader(w, config, dbName); err != nil {
		return err
	}
	if _, err := w.WriteString(fmt.Sprintf("-- Schema: %s\n\n", safeSchemaName)); err != nil {
		return err
	}
	dbType := resolveDDLDBType(config)
	if isPostgresSchemaDDLDBType(dbType) {
		_, err := w.WriteString(fmt.Sprintf(
			"CREATE SCHEMA IF NOT EXISTS %s;\n\n",
			quoteIdentByType(dbType, safeSchemaName),
		))
		return err
	}
	return nil
}

func writeSQLDatabaseBackupHeader(w *bufio.Writer, config connection.ConnectionConfig, dbName string) error {
	return writeSQLHeaderWithDatabaseBootstrap(w, config, dbName, true, true)
}

func writeSQLDatabaseExportHeader(
	w *bufio.Writer,
	config connection.ConnectionConfig,
	dbName string,
	includeDatabaseContext bool,
) error {
	return writeSQLHeaderWithDatabaseBootstrap(
		w,
		config,
		dbName,
		includeDatabaseContext,
		includeDatabaseContext,
	)
}

func writeSQLHeaderWithDatabaseBootstrap(
	w *bufio.Writer,
	config connection.ConnectionConfig,
	dbName string,
	includeDatabaseContext bool,
	createDatabase bool,
) error {
	now := time.Now().Format("2006-01-02 15:04:05")
	if _, err := w.WriteString(fmt.Sprintf("-- GoNavi SQL Export\n-- Time: %s\n", now)); err != nil {
		return err
	}
	if strings.TrimSpace(dbName) != "" {
		if _, err := w.WriteString(fmt.Sprintf("-- Database: %s\n\n", dbName)); err != nil {
			return err
		}
	}

	if supportsMySQLDatabaseContext(config) && strings.TrimSpace(dbName) != "" {
		if includeDatabaseContext && createDatabase {
			if _, err := w.WriteString(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s;\n\n", quoteIdentByType("mysql", dbName))); err != nil {
				return err
			}
		}
		if includeDatabaseContext {
			if _, err := w.WriteString(fmt.Sprintf("USE %s;\n\n", quoteIdentByType("mysql", dbName))); err != nil {
				return err
			}
		}
		if _, err := w.WriteString("SET FOREIGN_KEY_CHECKS=0;\n\n"); err != nil {
			return err
		}
	}

	return nil
}

// supportsMySQLDatabaseContext 报告 SQL 导出能否写 USE / CREATE DATABASE：MySQL 与借用 MySQL 方言的描述表类型。
func supportsMySQLDatabaseContext(config connection.ConnectionConfig) bool {
	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	if dbType == "mysql" {
		return true
	}
	dialect, ok := registryDDLDialect(dbType)
	return ok && dialect == "mysql"
}

func writeSQLFooter(w *bufio.Writer, config connection.ConnectionConfig) error {
	if supportsMySQLDatabaseContext(config) {
		if _, err := w.WriteString("\nSET FOREIGN_KEY_CHECKS=1;\n"); err != nil {
			return err
		}
	}
	return nil
}

func buildSQLDropIfExistsStatement(
	config connection.ConnectionConfig,
	dbName string,
	objectName string,
	isView bool,
) string {
	return buildSQLDropIfExistsStatementWithDatabaseContext(config, dbName, objectName, isView, true)
}

func buildSQLDropIfExistsStatementWithDatabaseContext(
	config connection.ConnectionConfig,
	dbName string,
	objectName string,
	isView bool,
	includeDatabaseContext bool,
) string {
	dbType := resolveDDLDBType(config)
	schemaName, pureObjectName := normalizeSchemaAndTableByType(dbType, dbName, objectName)
	if strings.TrimSpace(pureObjectName) == "" {
		return ""
	}

	objectType := "TABLE"
	// ClickHouse exposes views (including materialized views) through the table
	// namespace and removes them with DROP TABLE.
	if isView && dbType != "clickhouse" {
		objectType = "VIEW"
	}
	qualifiedObject := quoteTableIdentByType(dbType, schemaName, pureObjectName)
	if supportsMySQLDatabaseContext(config) && !includeDatabaseContext {
		qualifiedObject = quoteIdentByType(dbType, pureObjectName)
	}
	if strings.TrimSpace(qualifiedObject) == "" {
		return ""
	}

	// Not every supported Oracle version has native DROP ... IF EXISTS.
	// Use a PL/SQL guard so exported SQL remains backward compatible.
	if dbType == "oracle" {
		dropSQL := fmt.Sprintf("DROP %s %s", objectType, qualifiedObject)
		return fmt.Sprintf(
			"BEGIN\n  EXECUTE IMMEDIATE '%s';\nEXCEPTION\n  WHEN OTHERS THEN\n    IF SQLCODE != %d THEN\n      RAISE;\n    END IF;\nEND;\n/",
			escapeSQLLiteral(dropSQL),
			oracleObjectMissingSQLCode(config),
		)
	}

	// Firebird（6.0 之前）没有 DROP ... IF EXISTS：用 EXECUTE BLOCK 先查 RDB$RELATIONS（表与视图都在这里）。
	if dbType == "firebird" {
		return firebirdDropBlockPrefix + firebirdDropGuard(objectType, qualifiedObject, pureObjectName) + firebirdDropBlockSuffix
	}

	return fmt.Sprintf("DROP %s IF EXISTS %s;", objectType, qualifiedObject)
}

func writeSQLDropIfExistsPreamble(
	w *bufio.Writer,
	config connection.ConnectionConfig,
	dbName string,
	objects []string,
	viewLookup map[string]string,
	includeSchema bool,
	options ExportFileOptions,
) error {
	return writeSQLDropIfExistsPreambleWithDatabaseContext(
		w,
		config,
		dbName,
		objects,
		viewLookup,
		includeSchema,
		options,
		true,
	)
}

func writeSQLDropIfExistsPreambleWithDatabaseContext(
	w *bufio.Writer,
	config connection.ConnectionConfig,
	dbName string,
	objects []string,
	viewLookup map[string]string,
	includeSchema bool,
	options ExportFileOptions,
	includeDatabaseContext bool,
) error {
	if !includeSchema || !options.IncludeDropIfExists || len(objects) == 0 {
		return nil
	}

	// Firebird 的 DDL 是事务性的：所有删除放进同一个 EXECUTE BLOCK，任一对象因依赖（存储过程、触发器引用）
	// 删不掉时整块回滚，不会删到一半就停下。
	firebird := resolveDDLDBType(config) == "firebird"
	var firebirdGuards []string
	wroteStatement := false
	for index := len(objects) - 1; index >= 0; index-- {
		objectName := strings.TrimSpace(objects[index])
		if objectName == "" {
			continue
		}
		objectKey := normalizeExportObjectKey(config, dbName, objectName)
		_, isView := viewLookup[objectKey]
		statement := buildSQLDropIfExistsStatementWithDatabaseContext(
			config,
			dbName,
			objectName,
			isView,
			includeDatabaseContext,
		)
		if statement == "" {
			continue
		}
		if firebird {
			firebirdGuards = append(firebirdGuards, strings.TrimSuffix(strings.TrimPrefix(statement, firebirdDropBlockPrefix), firebirdDropBlockSuffix))
			continue
		}
		if !wroteStatement {
			if _, err := w.WriteString("\n-- Drop existing objects before recreation\n"); err != nil {
				return err
			}
			wroteStatement = true
		}
		if _, err := w.WriteString(statement + "\n"); err != nil {
			return err
		}
	}
	if len(firebirdGuards) > 0 {
		block := "\n-- Drop existing objects before recreation\nEXECUTE BLOCK AS BEGIN\n  " + strings.Join(firebirdGuards, "\n  ") + "\nEND;\n"
		if _, err := w.WriteString(block); err != nil {
			return err
		}
		wroteStatement = true
	}
	if wroteStatement {
		_, err := w.WriteString("\n")
		return err
	}
	return nil
}

const (
	firebirdDropBlockPrefix = "EXECUTE BLOCK AS BEGIN "
	firebirdDropBlockSuffix = " END;"
)

// firebirdDropGuard 是 Firebird 删除保护块里的一条：对象存在时才执行 DROP。
func firebirdDropGuard(objectType, qualifiedObject, pureObjectName string) string {
	return fmt.Sprintf(
		"IF (EXISTS(SELECT 1 FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = '%s')) THEN EXECUTE STATEMENT '%s';",
		escapeSQLLiteral(pureObjectName),
		escapeSQLLiteral(fmt.Sprintf("DROP %s %s", objectType, qualifiedObject)),
	)
}

func qualifyTable(schemaName, tableName string) string {
	schemaName = strings.TrimSpace(schemaName)
	tableName = strings.TrimSpace(tableName)
	if schemaName == "" {
		return tableName
	}
	return schemaName + "." + tableName
}

func ensureSQLTerminator(sql string) string {
	trimmed := strings.TrimSpace(sql)
	if trimmed == "" {
		return sql
	}
	if strings.HasSuffix(trimmed, ";") {
		return sql
	}
	return sql + ";"
}
