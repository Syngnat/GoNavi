package sync

import (
	"regexp"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

func hiveSyncFamily(config connection.ConnectionConfig) string {
	family, err := db.HiveConnectionFamily(config)
	if err != nil {
		return "unknown"
	}
	return family
}

// Existing native metadata proves type availability even when DriverVariant
// names an older compatibility profile. New DDL must not assume that proof.
func validateHiveTargetTypeSupport(config connection.ConnectionConfig, columns []connection.ColumnDefinition, creating bool) error {
	if resolveMigrationDBType(config) != "hive" {
		return nil
	}
	family := hiveSyncFamily(config)
	version := strings.ToLower(strings.TrimSpace(config.DriverVariant))
	for _, column := range columns {
		typ, err := hivesql.ParseType(column.Type)
		if err != nil {
			return hiveTypeError(column, "hive", "hive", err.Error())
		}
		if err := validateHiveFamilyType(column, typ, family, version, creating); err != nil {
			return err
		}
	}
	return nil
}

func validateHiveFamilyType(column connection.ColumnDefinition, typ hivesql.Type, family, version string, creating bool) error {
	kind := typ.Kind
	unsupported := func(detail string) error { return hiveTypeError(column, "hive", "hive/"+family, detail) }
	if kind == "void" {
		return unsupported("VOID is not a writable table column type")
	}
	interval := strings.HasPrefix(kind, "interval")
	if family == "impala" && typ.Complex() {
		return unsupported("Impala does not support portable INSERT constructors for complex columns")
	}
	if (family == "spark" || family == "spark-sql" || family == "impala") && (kind == "uniontype" || interval || kind == "timestamp_local_tz") {
		return unsupported("this Hive type has no portable writable representation for the selected protocol family")
	}
	if creating && (version == "hive1" && interval || kind == "timestamp_local_tz" && version != "hive3" && version != "hive4") {
		return unsupported("the selected Hive version does not guarantee this type; select a compatible version or create a verified target explicitly")
	}
	for _, member := range []*hivesql.Type{typ.Element, typ.Key, typ.Value} {
		if member != nil {
			if err := validateHiveFamilyType(column, *member, family, version, creating); err != nil {
				return err
			}
		}
	}
	for _, member := range typ.Members {
		if err := validateHiveFamilyType(column, member, family, version, creating); err != nil {
			return err
		}
	}
	for _, field := range typ.Fields {
		if err := validateHiveFamilyType(column, field.Type, family, version, creating); err != nil {
			return err
		}
	}
	return nil
}

var hiveTemporalPrecisionPattern = regexp.MustCompile("(?i)(?:timestamp|datetime2)[[:space:]]*[(][[:space:]]*([0-9]+)[[:space:]]*[)]")

func validateHivePairTypeSemantics(config SyncConfig, columns []connection.ColumnDefinition) error {
	if resolveMigrationDBType(config.TargetConfig) != "hive" || (!config.hiveMicrosecondTarget && hiveSyncFamily(config.TargetConfig) != "spark") {
		return nil
	}
	source := resolveMigrationDBType(config.SourceConfig)
	if source == "hive" && hiveSyncFamily(config.SourceConfig) == "spark" {
		return nil
	}
	for _, column := range columns {
		typ, err := mapHiveMigrationType(source, "hive", column)
		if err != nil {
			return err
		}
		if !strings.Contains(typ, "TIMESTAMP") {
			continue
		}
		if !hiveSourceTimestampNeedsNanoseconds(config.SourceConfig, column.Type) {
			continue
		}
		return hiveTypeError(column, source, "hive/"+hiveSyncFamily(config.TargetConfig), "target timestamps preserve only microseconds; use an explicit precision conversion or a STRING representation")
	}
	return nil
}

func hiveSourceTimestampNeedsNanoseconds(config connection.ConnectionConfig, raw string) bool {
	source := resolveMigrationDBType(config)
	switch source {
	case "mysql", "mariadb", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return false
	case "hive":
		return hiveSyncFamily(config) != "spark"
	case "duckdb":
		return strings.Contains(strings.ToLower(raw), "_ns")
	case "oracle", "dameng", "sqlserver":
		if match := hiveTemporalPrecisionPattern.FindStringSubmatch(raw); len(match) == 2 {
			precision, err := strconv.Atoi(match[1])
			return err != nil || precision > 6
		}
		return false
	default:
		return true
	}
}

func hiveMappedTargetDefinitions(source, target string, columns []connection.ColumnDefinition) ([]connection.ColumnDefinition, error) {
	mapped := make([]connection.ColumnDefinition, 0, len(columns))
	for _, column := range columns {
		typ, err := mapHiveMigrationType(source, target, column)
		if err != nil {
			return nil, err
		}
		column.Type = typ
		mapped = append(mapped, column)
	}
	return mapped, nil
}
