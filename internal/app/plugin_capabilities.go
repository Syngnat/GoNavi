package app

import (
	"context"
	"time"

	"GoNavi-Wails/internal/plugin"
)

// defaultPluginCapabilities is the single registry for page, window and
// backend capabilities. The page bridge migrates the historical seven methods
// through adapters so existing packages keep working; new methods are added
// here and become visible through app.capabilities automatically.
func defaultPluginCapabilities() pluginCapabilities {
	page := pluginCapabilityChannelPage
	shared := page | pluginCapabilityChannelWindow | pluginCapabilityChannelBackend
	desktopWeb := pluginCapabilityRuntimeDesktop | pluginCapabilityRuntimeWeb
	desktop := pluginCapabilityRuntimeDesktop
	dataTimeout := 30 * time.Second
	textResult := 16 << 10
	dataResult := 256 << 10
	defaultArgs := 64 << 10

	capabilities := pluginCapabilities{}
	add := func(spec pluginCapabilitySpec) {
		capabilities[spec.Name] = spec
	}

	add(pluginCapabilitySpec{
		Name:           "plugin.invoke",
		Permission:     plugin.PagesPermission,
		Description:    "Invoke a command declared by the calling plugin; the page never receives credentials.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   1 << 20,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityInvoke,
	})
	add(pluginCapabilitySpec{
		Name:           "app.info",
		Description:    "Plugin and host identity for the calling page.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: textResult,
		Timeout:        5 * time.Second,
		Handler:        adaptPluginPageCapability(pluginPageAppInfo),
	})
	add(pluginCapabilitySpec{
		Name:           "app.capabilities",
		Description:    "Registered host capabilities and whether this plugin holds each permission.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: dataResult,
		Timeout:        5 * time.Second,
		Handler:        pluginCapabilityCatalogHandler,
	})
	add(pluginCapabilitySpec{
		Name:           "connections.list",
		Permission:     plugin.ConnectionsReadPermission,
		Description:    "Saved connection summaries without credentials.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        adaptPluginPageCapability(pluginPageConnectionsList),
	})
	add(pluginCapabilitySpec{
		Name:           "connections.capabilities",
		Permission:     plugin.ConnectionsReadPermission,
		Description:    "Driver and UI capabilities for a saved connection, without opening it.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: textResult,
		Timeout:        5 * time.Second,
		Handler:        pluginCapabilityConnectionCapabilities,
	})
	add(pluginCapabilitySpec{
		Name:           "connections.health",
		Permission:     plugin.ConnectionsReadPermission,
		Description:    "Bounded health checks for a saved connection, without credentials.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityConnectionHealth,
	})
	add(pluginCapabilitySpec{
		Name:           "connections.test",
		Permission:     plugin.ConnectionsReadPermission,
		Description:    "Test a saved connection through the host driver.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: textResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityConnectionTest,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.databases",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Database names for a saved connection.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        adaptPluginPageCapability(pluginPageMetadataDatabases),
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.tables",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Table summaries for one database.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        adaptPluginPageCapability(pluginPageMetadataTables),
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.columns",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Column summaries for one table.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        adaptPluginPageCapability(pluginPageMetadataColumns),
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.views",
		Permission:     plugin.MetadataReadPermission,
		Description:    "View names for one database.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataViews,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.objects",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Typed database objects for one database.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataObjects,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.allColumns",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Bounded column metadata for every table in one database.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataAllColumns,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.indexes",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Index definitions for one table.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataIndexes,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.foreignKeys",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Foreign key definitions for one table.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataForeignKeys,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.triggers",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Trigger definitions for one table.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataTriggers,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.createStatement",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Create statement or equivalent DDL for one table.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataCreateStatement,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.savedQueries",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Saved SQL snippets and their groups without credentials or filesystem paths.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: dataResult,
		Timeout:        10 * time.Second,
		Handler:        pluginCapabilitySavedQueries,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.tableInfo",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Table details such as row count, size and engine when supported.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataTableInfo,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.serverVersion",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Driver-reported server version for a saved connection.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataServerVersion,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.tableExists",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Exact table/key existence check for one connection.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: textResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataTableExists,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.databaseForeignKeys",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Foreign keys for every table in one database when the driver supports it.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataDatabaseForeignKeys,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.charsets",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Server character sets for drivers that expose them.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataCharsets,
	})
	add(pluginCapabilitySpec{
		Name:           "metadata.collations",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Server collations for drivers that expose them.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMetadataCollations,
	})
	add(pluginCapabilitySpec{
		Name:           "sync.jobs",
		Permission:     plugin.MetadataReadPermission,
		Description:    "List saved data-sync jobs with public, redacted definitions.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilitySyncJobs,
	})
	add(pluginCapabilitySpec{
		Name:           "schema.preview",
		Permission:     plugin.SchemaWritePermission,
		Description:    "Validate and stage up to 8 explicit DDL statements; never executes them.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   128 << 10,
		MaxResultBytes: 32 << 10,
		Timeout:        10 * time.Second,
		Handler:        pluginCapabilitySchemaPreview,
	})
	add(pluginCapabilitySpec{
		Name:           "schema.apply",
		Permission:     plugin.SchemaWritePermission,
		Description:    "Execute a previewed DDL plan after a host-native confirmation dialog.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: 64 << 10,
		Timeout:        120 * time.Second,
		Handler:        pluginCapabilitySchemaApply,
	})
	add(pluginCapabilitySpec{
		Name:           "ai.providers",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Configured AI provider metadata without secrets, headers or CLI environment.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: 64 << 10,
		Timeout:        5 * time.Second,
		Handler:        pluginCapabilityAIProviders,
	})
	add(pluginCapabilitySpec{
		Name:           "driver.status",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Local driver readiness summary without paths, URLs or credentials.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: 64 << 10,
		Timeout:        10 * time.Second,
		Handler:        pluginCapabilityDriverStatus,
	})
	add(pluginCapabilitySpec{
		Name:           "backup.status",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Local cloud-backup scheduler status without endpoints or credentials.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: 16 << 10,
		Timeout:        5 * time.Second,
		Handler:        pluginCapabilityBackupStatus,
	})
	add(pluginCapabilitySpec{
		Name:           "sync.runs",
		Permission:     plugin.MetadataReadPermission,
		Description:    "List bounded data-sync run history with public, redacted records.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilitySyncRuns,
	})
	add(pluginCapabilitySpec{
		Name:           "sync.run",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Read one data-sync run with a public, redacted definition snapshot.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilitySyncRun,
	})
	add(pluginCapabilitySpec{
		Name:           "sync.job",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Read one saved data-sync job with a public, redacted definition.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilitySyncJob,
	})
	add(pluginCapabilitySpec{
		Name:           "nacos.services",
		Permission:     plugin.MetadataReadPermission,
		Description:    "List Nacos services in a namespace without registering or changing them.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityNacosServices,
	})
	add(pluginCapabilitySpec{
		Name:           "nacos.service",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Read one Nacos service declaration.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityNacosService,
	})
	add(pluginCapabilitySpec{
		Name:           "nacos.instances",
		Permission:     plugin.MetadataReadPermission,
		Description:    "List Nacos service instances, optionally healthy only.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityNacosInstances,
	})
	add(pluginCapabilitySpec{
		Name:           "nacos.instance",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Read one Nacos instance without registering or changing it.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityNacosInstance,
	})
	add(pluginCapabilitySpec{
		Name:           "jvm.capabilities",
		Permission:     plugin.QueryReadPermission,
		Description:    "Probe read-only JVM monitoring capabilities for a saved connection.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityJVMCapabilities,
	})
	add(pluginCapabilitySpec{
		Name:           "jvm.resources",
		Permission:     plugin.QueryReadPermission,
		Description:    "List read-only JVM resource paths under a node.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityJVMResources,
	})
	add(pluginCapabilitySpec{
		Name:           "jvm.value",
		Permission:     plugin.QueryReadPermission,
		Description:    "Read one JVM monitoring value without changing it.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   8 << 10,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityJVMValue,
	})
	add(pluginCapabilitySpec{
		Name:           "jvm.audit",
		Permission:     plugin.QueryReadPermission,
		Description:    "Read bounded local JVM change audit records.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        10 * time.Second,
		Handler:        pluginCapabilityJVMAudit,
	})
	add(pluginCapabilitySpec{
		Name:           "mongo.discoverMembers",
		Permission:     plugin.MetadataReadPermission,
		Description:    "Read-only MongoDB replica-set/cluster topology for a saved connection.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityMongoDiscoverMembers,
	})
	add(pluginCapabilitySpec{
		Name:           "redis.scan",
		Permission:     plugin.QueryReadPermission,
		Description:    "Scan Redis keys with a bounded count and cursor.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   8 << 10,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityRedisScan,
	})
	add(pluginCapabilitySpec{
		Name:           "redis.value",
		Permission:     plugin.QueryReadPermission,
		Description:    "Read one Redis key value without writing it.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityRedisValue,
	})
	add(pluginCapabilitySpec{
		Name:           "redis.serverInfo",
		Permission:     plugin.QueryReadPermission,
		Description:    "Read Redis server information.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityRedisServerInfo,
	})
	add(pluginCapabilitySpec{
		Name:           "redis.databases",
		Permission:     plugin.QueryReadPermission,
		Description:    "List Redis databases with key counts.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityRedisDatabases,
	})
	add(pluginCapabilitySpec{
		Name:           "sessions.list",
		Permission:     plugin.QueryReadPermission,
		Description:    "Normalized server sessions for a saved connection.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilitySessionsList,
	})
	add(pluginCapabilitySpec{
		Name:           "sessions.databases",
		Permission:     plugin.QueryReadPermission,
		Description:    "Databases the saved connection can list server sessions from.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilitySessionsDatabases,
	})
	add(pluginCapabilitySpec{
		Name:           "sessions.longTransactions",
		Permission:     plugin.QueryReadPermission,
		Description:    "Sessions holding an open transaction, oldest first.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilitySessionsLongTransactions,
	})
	add(pluginCapabilitySpec{
		Name:           "sessions.lockWaits",
		Permission:     plugin.QueryReadPermission,
		Description:    "Sessions waiting for a lock and the sessions holding it.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilitySessionsLockWaits,
	})
	add(pluginCapabilitySpec{
		Name:           "sessions.capabilities",
		Permission:     plugin.QueryReadPermission,
		Description:    "Which session and lock checks a saved connection supports.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: textResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilitySessionsCapabilities,
	})
	add(pluginCapabilitySpec{
		Name:           "sql.classify",
		Permission:     plugin.QueryReadPermission,
		Description:    "Classify one SQL statement as query/DML/DDL without executing it.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   64 << 10,
		MaxResultBytes: 4 << 10,
		Timeout:        5 * time.Second,
		Handler:        pluginCapabilitySQLClassify,
	})
	add(pluginCapabilitySpec{
		Name:           "query.explain",
		Permission:     plugin.QueryReadPermission,
		Description:    "Estimated EXPLAIN plan for one read-only SELECT/WITH statement; never executes ANALYZE.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   64 << 10,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        pluginCapabilityExplain,
	})
	add(pluginCapabilitySpec{
		Name:           "query.read",
		Permission:     plugin.QueryReadPermission,
		Description:    "One read-only statement on a saved connection.",
		Channels:       shared,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   defaultArgs,
		MaxResultBytes: dataResult,
		Timeout:        dataTimeout,
		Handler:        adaptPluginPageCapability(pluginPageQueryRead),
	})
	add(pluginCapabilitySpec{
		Name:           "ui.notify",
		Description:    "Show one host notification from a plugin page.",
		Channels:       page,
		Runtimes:       desktopWeb,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: 1 << 10,
		Timeout:        5 * time.Second,
		Handler:        adaptPluginPageCapability(pluginPageNotify),
	})
	add(pluginCapabilitySpec{
		Name:           "system.open-external",
		Permission:     plugin.OpenExternalPermission,
		Description:    "Open one http(s) link in the user's default browser; never navigates a host WebView.",
		Channels:       page | pluginCapabilityChannelWindow,
		Runtimes:       desktop,
		MaxArgsBytes:   4 << 10,
		MaxResultBytes: 1 << 10,
		Timeout:        5 * time.Second,
		Handler:        pluginCapabilityOpenExternal,
	})
	return capabilities
}

// adaptPluginPageCapability keeps the historical page handlers untouched while
// the registry supplies identity, permissions, limits and timeouts.
func adaptPluginPageCapability(handler pluginPageHandler) pluginCapabilityHandler {
	return func(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
		return handler(ctx, a, pluginPageRequest{
			pluginID:  request.Caller.PluginID,
			pageID:    request.Caller.PageID,
			method:    request.Method,
			status:    request.Status,
			arguments: request.Arguments,
		})
	}
}
