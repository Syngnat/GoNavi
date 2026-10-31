package sync

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

func isHiveMigrationPair(source, target string) bool {
	return normalizeMigrationDBType(source) == "hive" || normalizeMigrationDBType(target) == "hive"
}

func hiveTypeError(column connection.ColumnDefinition, source, target, detail string) error {
	return syncTextError("data_sync.backend.error.hive_type_unsupported", map[string]any{
		"column": column.Name, "sourceType": source + ":" + column.Type,
		"targetType": target, "detail": detail,
	})
}

// mapHiveMigrationType never uses the legacy TEXT fallback: complex values,
// decimal overflow and timestamp precision loss must be explicit decisions.
func mapHiveMigrationType(source, target string, column connection.ColumnDefinition) (string, error) {
	source, target = normalizeMigrationDBType(source), normalizeMigrationDBType(target)
	if target == "hive" {
		if source == "hive" {
			normalized, err := hivesql.NormalizeType(column.Type)
			if err != nil {
				return "", hiveTypeError(column, source, target, err.Error())
			}
			return normalized, nil
		}
		return mapColumnToHiveType(source, column)
	}
	typ, err := hivesql.ParseType(column.Type)
	if err != nil {
		return "", hiveTypeError(column, source, target, err.Error())
	}
	return mapHiveTypeToTarget(target, column, typ)
}

func mapColumnToHiveType(source string, column connection.ColumnDefinition) (string, error) {
	raw := strings.ToLower(strings.TrimSpace(column.Type))
	if source == "sqlserver" {
		if raw == "tinyint" {
			return "SMALLINT", nil
		}
		if raw == "timestamp" || raw == "rowversion" {
			return "BINARY", nil
		}
	}
	if strings.Contains(raw, "time zone") || raw == "timestamptz" || raw == "timetz" || strings.HasPrefix(raw, "timestamp with local") {
		return "", hiveTypeError(column, source, "hive", "timezone-bearing values need an explicit conversion")
	}
	intermediate, _ := toMySQLColumnType(source, "hive", column)
	base := intermediateMySQLTypeBase(intermediate)
	var result string
	switch base {
	case "bool", "boolean":
		result = "BOOLEAN"
	case "tinyint":
		if strings.Contains(intermediate, "unsigned") {
			result = "SMALLINT"
		} else {
			result = "TINYINT"
		}
	case "smallint":
		if strings.Contains(intermediate, "unsigned") {
			result = "INT"
		} else {
			result = "SMALLINT"
		}
	case "int", "integer", "mediumint":
		if strings.Contains(intermediate, "unsigned") {
			result = "BIGINT"
		} else {
			result = "INT"
		}
	case "bigint":
		if strings.Contains(intermediate, "unsigned") {
			result = "DECIMAL(20,0)"
		} else {
			result = "BIGINT"
		}
	case "decimal", "numeric":
		// An unbounded numeric cannot be represented by Hive DECIMAL(38,s).
		if !strings.Contains(raw, "(") {
			return "", hiveTypeError(column, source, "hive", "unbounded decimal requires an explicit precision and scale")
		}
		result = strings.ToUpper(strings.TrimSuffix(intermediate, " unsigned"))
	case "float":
		result = "FLOAT"
	case "double", "real":
		result = "DOUBLE"
	case "char", "varchar", "text", "tinytext", "mediumtext", "longtext", "enum", "set", "json":
		result = "STRING"
	case "binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob":
		result = "BINARY"
	case "date":
		result = "DATE"
	case "datetime", "timestamp":
		result = "TIMESTAMP"
	default:
		return "", hiveTypeError(column, source, "hive", "no lossless Hive type mapping; provide a converted SQL source")
	}
	if raw == "boolean" || raw == "bool" {
		result = "BOOLEAN"
	}
	normalized, err := hivesql.NormalizeType(result)
	if err != nil {
		return "", hiveTypeError(column, source, "hive", err.Error())
	}
	return normalized, nil
}

func mapHiveTypeToTarget(target string, column connection.ColumnDefinition, typ hivesql.Type) (string, error) {
	if target == "duckdb" {
		switch typ.Kind {
		case "string":
			return "VARCHAR", nil
		case "binary":
			return "BLOB", nil
		case "timestamp":
			return "TIMESTAMP_NS", nil
		}
	}
	if typ.Kind == "array" || typ.Kind == "map" || typ.Kind == "struct" || typ.Kind == "uniontype" {
		return "", hiveTypeError(column, "hive", target, "complex values require an explicit typed conversion; TEXT fallback is disabled")
	}
	switch typ.Kind {
	case "timestamp":
		if isOracleLikeTargetType(target) {
			return "TIMESTAMP(9)", nil
		}
		return "", hiveTypeError(column, "hive", target, "Hive timestamps carry nanoseconds; the target timestamp would lose precision")
	case "string", "varchar", "char":
		switch {
		case isMySQLLikeWritableTargetType(target):
			return "LONGTEXT", nil
		case isPGLikeTarget(target):
			return "TEXT", nil
		case isOracleLikeTargetType(target):
			return "CLOB", nil
		case target == "sqlserver":
			return "NVARCHAR(MAX)", nil
		case target == "sqlite":
			return "TEXT", nil
		}
	case "binary":
		switch {
		case isMySQLLikeWritableTargetType(target):
			return "LONGBLOB", nil
		case isPGLikeTarget(target):
			return "BYTEA", nil
		case isOracleLikeTargetType(target), target == "sqlite":
			return "BLOB", nil
		case target == "sqlserver":
			return "VARBINARY(MAX)", nil
		}
	case "decimal":
		if target == "sqlite" {
			return "", hiveTypeError(column, "hive", target, "SQLite numeric affinity can round exact decimals")
		}
		return fmt.Sprintf("DECIMAL(%d,%d)", typ.Precision, typ.Scale), nil
	case "boolean":
		if isOracleLikeTargetType(target) {
			return "NUMBER(1)", nil
		}
		if target == "sqlserver" {
			return "BIT", nil
		}
		return "BOOLEAN", nil
	case "tinyint", "smallint", "int", "bigint", "float", "double", "date":
		if isOracleLikeTargetType(target) {
			switch typ.Kind {
			case "tinyint":
				return "NUMBER(3)", nil
			case "smallint":
				return "NUMBER(5)", nil
			case "int":
				return "NUMBER(10)", nil
			case "bigint":
				return "NUMBER(19)", nil
			case "float":
				return "BINARY_FLOAT", nil
			case "double":
				return "BINARY_DOUBLE", nil
			}
		}
		if typ.Kind == "tinyint" && (isPGLikeTarget(target) || target == "sqlserver") {
			return "SMALLINT", nil
		}
		if typ.Kind == "double" && isPGLikeTarget(target) {
			return "DOUBLE PRECISION", nil
		}
		if typ.Kind == "double" && target == "sqlserver" {
			return "FLOAT(53)", nil
		}
		if typ.Kind == "float" && (isPGLikeTarget(target) || target == "sqlserver") {
			return "REAL", nil
		}
		return strings.ToUpper(typ.Kind), nil
	}
	return "", hiveTypeError(column, "hive", target, "no lossless target type mapping")
}

func isHivePartitionColumn(column connection.ColumnDefinition) bool {
	for _, marker := range strings.Fields(strings.ToLower(column.Extra)) {
		if marker == "partition" {
			return true
		}
	}
	return false
}
