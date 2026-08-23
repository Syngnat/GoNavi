package app

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

const (
	DataImportReasonDatabaseUnsupported      = "database_type_unsupported"
	DataImportReasonPinnedSessionUnavailable = "pinned_session_unavailable"
	DataImportReasonRestricted               = "data_import_restricted"
	DataImportReasonRuntimeUnavailable       = "database_runtime_unavailable"
	DataImportReasonSQLFileRestricted        = "sql_file_import_restricted"
	DataImportReasonTableRuntimeUnavailable  = "table_import_runtime_unavailable"
)

// DataImportCapability is the backend-authoritative contract for import entry points.
type DataImportCapability struct {
	DatabaseType  string                   `json:"databaseType"`
	TableImport   DataImportModeCapability `json:"tableImport"`
	SQLFileImport DataImportModeCapability `json:"sqlFileImport"`
}

// DataImportModeCapability describes one import mode without requiring the
// frontend to infer support from a database type.
type DataImportModeCapability struct {
	Supported                  bool     `json:"supported"`
	Reason                     string   `json:"reason"`
	RequiresPinnedSession      bool     `json:"requiresPinnedSession"`
	SupportsTransactionalBatch bool     `json:"supportsTransactionalBatch"`
	SupportsContinue           bool     `json:"supportsContinue"`
	SupportedFormats           []string `json:"supportedFormats"`
	SupportedEncodings         []string `json:"supportedEncodings"`
	SupportedCompressions      []string `json:"supportedCompressions"`
	SupportedClientDirectives  []string `json:"supportedClientDirectives"`
	SupportedConflictPolicies  []string `json:"supportedConflictPolicies"`
}

// DataImportCapability returns the effective import contract for the live
// driver instance. Connection failures are represented as a fail-closed DTO so
// callers never need database-type heuristics as a fallback.
func (a *App) DataImportCapability(config connection.ConnectionConfig) DataImportCapability {
	if dataImportCapabilityRestricted(config) {
		return ResolveDataImportCapability(config, nil)
	}
	runtime, err := a.getDatabase(config)
	if err == nil {
		return ResolveDataImportCapability(config, runtime)
	}

	capability := ResolveDataImportCapability(config, nil)
	if capability.TableImport.Reason == DataImportReasonTableRuntimeUnavailable {
		capability.TableImport.Reason = DataImportReasonRuntimeUnavailable
	}
	if capability.SQLFileImport.Reason == DataImportReasonPinnedSessionUnavailable {
		capability.SQLFileImport.Reason = DataImportReasonRuntimeUnavailable
	}
	return capability
}

// ResolveDataImportCapability derives import support from both the normalized
// dialect and runtime interfaces. A dialect name alone never proves that SQL
// file execution can preserve session state.
func ResolveDataImportCapability(config connection.ConnectionConfig, runtime db.Database) DataImportCapability {
	dbType := normalizeDataImportDatabaseType(config)
	capability := DataImportCapability{
		DatabaseType: dbType,
		TableImport: DataImportModeCapability{
			Reason:                    DataImportReasonDatabaseUnsupported,
			SupportedFormats:          []string{},
			SupportedEncodings:        []string{},
			SupportedCompressions:     []string{},
			SupportedClientDirectives: []string{},
			SupportedConflictPolicies: []string{},
		},
		SQLFileImport: DataImportModeCapability{
			Reason:                    DataImportReasonDatabaseUnsupported,
			RequiresPinnedSession:     true,
			SupportedFormats:          []string{},
			SupportedEncodings:        []string{},
			SupportedCompressions:     []string{},
			SupportedClientDirectives: []string{},
			SupportedConflictPolicies: []string{},
		},
	}
	if dataImportCapabilityRestricted(config) {
		capability.TableImport.Reason = DataImportReasonRestricted
		capability.SQLFileImport.Reason = DataImportReasonRestricted
		return capability
	}
	if dbType == "dameng" || dbType == "tdengine" || dbType == "clickhouse" {
		capability.TableImport.Reason = DataImportReasonTableRuntimeUnavailable
		if _, ok := runtime.(db.BatchApplierContext); ok {
			capability.TableImport = DataImportModeCapability{
				Supported:                  true,
				SupportsTransactionalBatch: dbType == "dameng",
				SupportsContinue:           true,
				SupportedFormats:           []string{"csv", "json", "xlsx"},
				SupportedEncodings:         []string{"auto", "utf-8", "utf-16le", "utf-16be", "gb18030"},
				SupportedCompressions:      []string{},
				SupportedClientDirectives:  []string{},
				SupportedConflictPolicies:  dataImportTableConflictPolicies(dbType),
			}
		}
		if sqlFileImportCapabilityRestricted(config) {
			capability.SQLFileImport.Reason = DataImportReasonSQLFileRestricted
		} else {
			capability.SQLFileImport.Reason = DataImportReasonPinnedSessionUnavailable
		}
		return capability
	}

	if !isDataImportMySQLFamilyDialect(dbType) && dbType != "postgres" && dbType != "sqlite" && dbType != "oracle" && dbType != "sqlserver" {
		return capability
	}
	capability.TableImport.Reason = DataImportReasonTableRuntimeUnavailable
	if _, ok := runtime.(db.BatchApplierContext); ok {
		capability.TableImport = DataImportModeCapability{
			Supported:                  true,
			SupportsTransactionalBatch: dataImportTableSupportsTransactionalBatch(dbType),
			SupportsContinue:           true,
			SupportedFormats:           []string{"csv", "json", "xlsx"},
			SupportedEncodings:         []string{"auto", "utf-8", "utf-16le", "utf-16be", "gb18030"},
			SupportedCompressions:      []string{},
			SupportedClientDirectives:  []string{},
			SupportedConflictPolicies:  dataImportTableConflictPolicies(dbType),
		}
	}
	if sqlFileImportCapabilityRestricted(config) {
		capability.SQLFileImport.Reason = DataImportReasonSQLFileRestricted
		return capability
	}
	if _, ok := runtime.(db.SessionExecerProvider); !ok {
		capability.SQLFileImport.Reason = DataImportReasonPinnedSessionUnavailable
		return capability
	}
	_, supportsBatch := runtime.(db.BatchWriteExecer)
	if conditional, ok := runtime.(db.BatchWriteCapability); ok {
		supportsBatch = supportsBatch && conditional.SupportsBatchWrites()
	}
	clientDirectives := []string{}
	if isDataImportMySQLFamilyDialect(dbType) {
		clientDirectives = []string{"delimiter"}
	} else if dbType == "oracle" {
		clientDirectives = []string{"sqlplus-slash"}
	} else if dbType == "sqlserver" {
		clientDirectives = []string{"go"}
	}
	capability.SQLFileImport = DataImportModeCapability{
		Supported:                  true,
		RequiresPinnedSession:      true,
		SupportsTransactionalBatch: supportsBatch && dataImportTableSupportsTransactionalBatch(dbType),
		SupportsContinue:           true,
		SupportedFormats:           []string{"sql"},
		SupportedEncodings:         []string{"auto", "utf-8", "utf-16le", "utf-16be"},
		SupportedCompressions:      []string{"gzip"},
		SupportedClientDirectives:  clientDirectives,
		SupportedConflictPolicies:  []string{},
	}
	return capability
}

func dataImportTableSupportsTransactionalBatch(dbType string) bool {
	switch dbType {
	case "mysql", "mariadb":
		return false
	default:
		return true
	}
}

func dataImportTableConflictPolicies(dbType string) []string {
	if dbType == "postgres" || dbType == "sqlite" {
		return []string{"stop", "skip_duplicates", "upsert"}
	}
	if isDataImportMySQLFamilyDialect(dbType) {
		return []string{"stop", "skip_duplicates"}
	}
	return []string{"stop"}
}

func isDataImportMySQLFamilyDialect(dbType string) bool {
	switch dbType {
	case "mysql", "mariadb", "oceanbase":
		return true
	default:
		return false
	}
}

func isDataImportSQLDialectSupported(config connection.ConnectionConfig) bool {
	switch normalizeDataImportDatabaseType(config) {
	case "mysql", "mariadb", "oceanbase", "postgres", "sqlite", "oracle", "sqlserver":
		return true
	default:
		return false
	}
}

func sqlFileImportCapabilityRestricted(config connection.ConnectionConfig) bool {
	return config.Protection.RestrictScriptExecution || config.Protection.RestrictStructureEdit
}

func dataImportCapabilityRestricted(config connection.ConnectionConfig) bool {
	protection := config.Protection
	if protection.RestrictDataEdit || protection.RestrictStructureEdit || protection.RestrictScriptExecution || protection.RestrictDataImport {
		return protection.RestrictDataImport
	}
	return config.ReadOnly
}

func normalizeDataImportDatabaseType(config connection.ConnectionConfig) string {
	return resolveDDLDBType(config)
}
