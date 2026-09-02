package app

import (
	"errors"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// DataSourceOperationCapability is the Wails-facing form of one shared
// data-source operation boundary. The values originate in internal/db's
// embedded registry; this package only exposes them to application callers.
type DataSourceOperationCapability struct {
	Supported    bool   `json:"supported"`
	RuntimeProbe bool   `json:"runtimeProbe,omitempty"`
	Reason       string `json:"reason,omitempty"`
	Alternative  string `json:"alternative,omitempty"`
	MessageKey   string `json:"messageKey,omitempty"`
}

// DataSourceUICapabilities is the Wails-facing subset of UI affordances that
// shares the same source contract as backend operation gates.
type DataSourceUICapabilities struct {
	ExplainDiagnosis               bool `json:"explainDiagnosis"`
	SQLQueryExport                 bool `json:"sqlQueryExport"`
	CopyInsert                     bool `json:"copyInsert"`
	CopyTable                      bool `json:"copyTable"`
	CreateDatabase                 bool `json:"createDatabase"`
	CreateDatabaseCharset          bool `json:"createDatabaseCharset"`
	RenameDatabase                 bool `json:"renameDatabase"`
	DropDatabase                   bool `json:"dropDatabase"`
	MessagePublish                 bool `json:"messagePublish"`
	ForceReadOnlyQueryResult       bool `json:"forceReadOnlyQueryResult"`
	ForceReadOnlyStructureDesigner bool `json:"forceReadOnlyStructureDesigner"`
	PreferManualTotalCount         bool `json:"preferManualTotalCount"`
	SupportsApproximateTableCount  bool `json:"supportsApproximateTableCount"`
	SupportsApproximateTotalPages  bool `json:"supportsApproximateTotalPages"`
}

// DataSourceNavigationCapabilities exposes the navigation filtering contract
// declared by internal/db to Wails callers.
type DataSourceNavigationCapabilities struct {
	PrimaryVisibilitySupported         bool   `json:"primaryVisibilitySupported"`
	PrimaryKind                        string `json:"primaryKind"`
	SecondarySchemaVisibilitySupported bool   `json:"secondarySchemaVisibilitySupported"`
	SchemaIdentifierCaseSensitive      bool   `json:"schemaIdentifierCaseSensitive"`
}

// DataSourceCapability is the backend-authoritative Wails DTO for the shared
// data-source capability registry.
type DataSourceCapability struct {
	DatabaseType        string                           `json:"databaseType"`
	Query               DataSourceOperationCapability    `json:"query"`
	Metadata            DataSourceOperationCapability    `json:"metadata"`
	Transaction         DataSourceOperationCapability    `json:"transaction"`
	Pagination          DataSourceOperationCapability    `json:"pagination"`
	Cancel              DataSourceOperationCapability    `json:"cancel"`
	Schema              DataSourceOperationCapability    `json:"schema"`
	Sampling            DataSourceOperationCapability    `json:"sampling"`
	Streaming           DataSourceOperationCapability    `json:"streaming"`
	DangerousOperations DataSourceOperationCapability    `json:"dangerousOperations"`
	UI                  DataSourceUICapabilities         `json:"ui"`
	Navigation          DataSourceNavigationCapabilities `json:"navigation"`
}

// DataSourceCapability resolves a saved connection to its explicit capability
// declaration. It does not create a connection, so callers can gate an entry
// point before asking a driver to perform work that is guaranteed to fail.
func (a *App) DataSourceCapability(config connection.ConnectionConfig) DataSourceCapability {
	sourceType := strings.TrimSpace(config.Type)
	customDriver := strings.EqualFold(sourceType, "custom")
	if customDriver {
		sourceType = strings.TrimSpace(config.Driver)
	}

	if strings.EqualFold(sourceType, "oceanbase") {
		protocol := normalizeOceanBaseProtocolForApp(config.OceanBaseProtocol)
		if (!customDriver && isOceanBaseOracleProtocol(config)) || (customDriver && protocol == "oracle") {
			customDriver = false
			sourceType = "oracle"
		}
	}

	if customDriver {
		return dataSourceCapabilityFromDB(db.ResolveCustomDataSourceCapability(sourceType))
	}
	return dataSourceCapabilityFromDB(db.ResolveDataSourceCapability(sourceType))
}

func dataSourceCapabilityFromDB(capability db.DataSourceCapability) DataSourceCapability {
	return DataSourceCapability{
		DatabaseType:        capability.Type,
		Query:               dataSourceOperationCapabilityFromDB(capability.Query),
		Metadata:            dataSourceOperationCapabilityFromDB(capability.Metadata),
		Transaction:         dataSourceOperationCapabilityFromDB(capability.Transaction),
		Pagination:          dataSourceOperationCapabilityFromDB(capability.Pagination),
		Cancel:              dataSourceOperationCapabilityFromDB(capability.Cancel),
		Schema:              dataSourceOperationCapabilityFromDB(capability.Schema),
		Sampling:            dataSourceOperationCapabilityFromDB(capability.Sampling),
		Streaming:           dataSourceOperationCapabilityFromDB(capability.Streaming),
		DangerousOperations: dataSourceOperationCapabilityFromDB(capability.DangerousOperations),
		UI: DataSourceUICapabilities{
			ExplainDiagnosis:               capability.UI.ExplainDiagnosis,
			SQLQueryExport:                 capability.UI.SQLQueryExport,
			CopyInsert:                     capability.UI.CopyInsert,
			CopyTable:                      capability.UI.CopyTable,
			CreateDatabase:                 capability.UI.CreateDatabase,
			CreateDatabaseCharset:          capability.UI.CreateDatabaseCharset,
			RenameDatabase:                 capability.UI.RenameDatabase,
			DropDatabase:                   capability.UI.DropDatabase,
			MessagePublish:                 capability.UI.MessagePublish,
			ForceReadOnlyQueryResult:       capability.UI.ForceReadOnlyQueryResult,
			ForceReadOnlyStructureDesigner: capability.UI.ForceReadOnlyStructureDesigner,
			PreferManualTotalCount:         capability.UI.PreferManualTotalCount,
			SupportsApproximateTableCount:  capability.UI.SupportsApproximateTableCount,
			SupportsApproximateTotalPages:  capability.UI.SupportsApproximateTotalPages,
		},
		Navigation: DataSourceNavigationCapabilities{
			PrimaryVisibilitySupported:         capability.Navigation.PrimaryVisibilitySupported,
			PrimaryKind:                        capability.Navigation.PrimaryKind,
			SecondarySchemaVisibilitySupported: capability.Navigation.SecondarySchemaVisibilitySupported,
			SchemaIdentifierCaseSensitive:      capability.Navigation.SchemaIdentifierCaseSensitive,
		},
	}
}

func dataSourceOperationCapabilityFromDB(capability db.DataSourceOperationCapability) DataSourceOperationCapability {
	return DataSourceOperationCapability{
		Supported:    capability.Supported,
		RuntimeProbe: capability.RuntimeProbe,
		Reason:       capability.Reason,
		Alternative:  capability.Alternative,
		MessageKey:   capability.MessageKey,
	}
}

func (a *App) ensureDataSourceQueryCapability(config connection.ConnectionConfig) error {
	capability := a.DataSourceCapability(config)
	if capability.Query.Supported {
		return nil
	}
	messageKey := strings.TrimSpace(capability.Query.MessageKey)
	if messageKey == "" {
		messageKey = "query_editor.message.unsupported_source"
	}
	return errors.New(a.appText(messageKey, nil))
}
