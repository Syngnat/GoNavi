//go:build gonavi_full_drivers || gonavi_yashandb_driver

package db

import (
	"fmt"
	"regexp"
	"strings"
)

// yashanDDLObjectTypes 把 ALL_OBJECTS.OBJECT_TYPE 映射为 DBMS_METADATA.GET_DDL 认识的类型：崖山把函数登记为 UDF，
// 包的 GET_DDL 一次给出包头与包体（PACKAGE BODY 不是合法的 GET_DDL 类型）。
var yashanDDLObjectTypes = map[string]string{
	"VIEW":         "VIEW",
	"UDF":          "FUNCTION",
	"FUNCTION":     "FUNCTION",
	"PROCEDURE":    "PROCEDURE",
	"TRIGGER":      "TRIGGER",
	"PACKAGE":      "PACKAGE",
	"PACKAGE BODY": "PACKAGE",
}

var yashanTriggerEnablePattern = regexp.MustCompile(`(?i)\r?\n\s*ALTER\s+TRIGGER\s+[^\r\n]+?\s+ENABLE\s*;?\s*$`)

// GetCreateStatement 表沿用 OracleDB（DBMS_METADATA 加注释）；视图、函数、存储过程、触发器与包按 ALL_OBJECTS 查出对象类型后
// 取 DBMS_METADATA.GET_DDL 原文——崖山的 ALL_SOURCE 一个对象只有一行、没有 LINE 列，Oracle 按行拼源码的查询用不了。
func (y *YashanDB) GetCreateStatement(dbName, objectName string) (string, error) {
	schema, name := yashanObjectOwnerAndName(dbName, objectName)
	ddlType, exactName, err := y.lookupDDLObjectType(schema, name)
	if err != nil || ddlType == "" {
		return y.OracleDB.GetCreateStatement(dbName, objectName)
	}
	owner := "USER"
	if schema != "" {
		owner = "'" + escapeOracleMetadataLiteralExact(schema) + "'"
	}
	rows, _, err := y.queryUnbounded(fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('%s', '%s', %s) AS ddl FROM dual",
		ddlType, escapeOracleMetadataLiteralExact(exactName), owner))
	if err != nil {
		return "", err
	}
	ddl := strings.TrimSpace(FirstQueryRowValue(rows))
	if ddlType == "TRIGGER" {
		// GET_DDL 在触发器定义后另起一行附带 ALTER TRIGGER ... ENABLE，它不属于定义本身（定义末尾的 END; 要保留）。
		ddl = strings.TrimSpace(yashanTriggerEnablePattern.ReplaceAllString(ddl, ""))
	}
	if ddl == "" {
		return "", oracleRuntimeError("db.backend.error.create_table_statement_not_found", nil)
	}
	return ddl, nil
}

// yashanObjectOwnerAndName 拆出对象所属 Schema 与对象名：对象名带 Schema 前缀时以前缀为准。
func yashanObjectOwnerAndName(dbName, objectName string) (string, string) {
	schema, name := splitOracleQualifiedTableName(strings.TrimSpace(objectName))
	if schema == "" {
		schema = strings.TrimSpace(dbName)
	}
	return strings.Trim(schema, `"`), strings.Trim(name, `"`)
}

// lookupDDLObjectType 返回对象的 GET_DDL 类型与库里的精确名字；对象是表或查不到时返回空类型，交给 Oracle 的建表语句逻辑。
// 名字先按原样匹配，再按大写匹配（未加引号创建的对象名是大写）。
func (y *YashanDB) lookupDDLObjectType(schema, name string) (string, string, error) {
	owner := "USER"
	if schema != "" {
		owner = "'" + escapeOracleMetadataLiteralExact(schema) + "'"
	}
	candidates := []string{name}
	if upper := strings.ToUpper(name); upper != name {
		candidates = append(candidates, upper)
	}
	for _, candidate := range candidates {
		rows, _, err := y.Query(fmt.Sprintf("SELECT object_type AS object_type FROM all_objects WHERE owner = %s AND object_name = '%s'",
			owner, escapeOracleMetadataLiteralExact(candidate)))
		if err != nil {
			return "", "", err
		}
		ddlType := ""
		for _, row := range rows {
			objectType := strings.ToUpper(strings.TrimSpace(fmt.Sprint(row["OBJECT_TYPE"])))
			if objectType == "TABLE" {
				return "", candidate, nil
			}
			if mapped, ok := yashanDDLObjectTypes[objectType]; ok && ddlType == "" {
				ddlType = mapped
			}
		}
		if ddlType != "" {
			return ddlType, candidate, nil
		}
	}
	return "", name, nil
}
