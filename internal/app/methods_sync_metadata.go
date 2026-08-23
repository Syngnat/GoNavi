package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sync"
)

// DataSyncDatabaseList resolves a saved connection inside the backend before
// loading metadata. Credentials never cross the Wails boundary.
func (a *App) DataSyncDatabaseList(connectionID string) connection.QueryResult {
	endpoint, err := a.resolveDataSyncJobEndpoint(connectionID, "", "")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return a.DBGetDatabases(endpoint.Config)
}

// DataSyncObjectList lists source/target objects using an ID-scoped saved
// connection. Schema remains a UI selection and is applied when the driver
// uses a schema-qualified namespace.
func (a *App) DataSyncObjectList(connectionID, database, schema string) connection.QueryResult {
	endpoint, err := a.resolveDataSyncJobEndpoint(connectionID, database, schema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return a.DBGetTables(endpoint.Config, endpoint.Database)
}

// DataSyncFieldList resolves metadata without exposing the editable saved
// connection (and therefore without exposing resolved secret material).
func (a *App) DataSyncFieldList(connectionID, database, schema, objectName string) connection.QueryResult {
	endpoint, err := a.resolveDataSyncJobEndpoint(connectionID, database, schema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	objectName = strings.TrimSpace(objectName)
	if objectName == "" {
		return connection.QueryResult{Success: false, Message: "data sync object name is required"}
	}
	return a.DBGetColumns(endpoint.Config, endpoint.Database, qualifyDataSyncJobObject(schema, objectName))
}

// DataSyncCapabilityResolve returns the route capability for two saved
// endpoints. The response contains capability metadata only, never configs.
func (a *App) DataSyncCapabilityResolve(sourceConnectionID, sourceDatabase, sourceSchema, targetConnectionID, targetDatabase, targetSchema string) connection.QueryResult {
	source, err := a.resolveDataSyncJobEndpoint(sourceConnectionID, sourceDatabase, sourceSchema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target, err := a.resolveDataSyncJobEndpoint(targetConnectionID, targetDatabase, targetSchema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: sync.ResolveMigrationCapability(source.Config, target.Config)}
}
