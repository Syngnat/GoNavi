export const enUSMessages: Record<string, string> = {
  "common.action.cancel": "Cancel",
  "common.action.save": "Save",
  "common.action.close": "Close",
  "common.action.back": "Back",
  "connection.action.test": "Test connection",
  "connection.modal.action.cancel_test": "Cancel test",
  "connection.action.viewDetails": "View details",
  "connection.status.success": "Connection successful",
  "connection.status.failure": "Connection failed",
  "connection.sidebar.group.untitled": "Untitled group",
  "connection.sidebar.group.meta": "{count} connections · Connection group",
  "connection.sidebar.group.badge": "GROUP",
  "connection.sidebar.group.edit": "Edit group",
  "connection.sidebar.group.delete": "Delete group",
  "connection.sidebar.group.deleteConfirmTitle": "Confirm deletion",
  "connection.sidebar.group.deleteConfirmContent":
    "Delete group \"{name}\"? Connections inside it will not be removed.",
  "connection.sidebar.group.expandAria": "Expand connection group {name}",
  "connection.sidebar.group.collapseAria": "Collapse connection group {name}",
  "connection.sidebar.menu.section": "Connection",
  "connection.sidebar.menu.groupSection": "Connection groups",
  "connection.sidebar.menu.copy": "Copy connection",
  "connection.sidebar.menu.disconnect": "Disconnect",
  "connection.sidebar.menu.delete": "Delete connection",
  "connection.sidebar.menu.hostFallback": "Address not configured",
  "connection.sidebar.menu.hostBadge": "HOST",
  "connection.sidebar.menu.moveToTag": "Move to tag",
  "connection.sidebar.menu.moveOutTag": "Remove from tag",
  "connection.sidebar.menu.moveToUngrouped": "Remove from group",
  "connection.sidebar.menu.createDatabase": "New database",
  "connection.sidebar.menu.refresh": "Refresh connection",
  "connection.sidebar.menu.current": "Current",
  "database.unnamed": "Unnamed Database",
  "database.label": "Database",
  "sidebar.active_connection.no_host_selected": "No host selected",
  "sidebar.modal.tag.create_title": "New group",
  "connection.sidebar.duplicate.backendUnavailable":
    "Copy connection failed: backend unavailable",
  "connection.sidebar.duplicate.noResult":
    "Copy connection failed: backend returned no result",
  "connection.sidebar.duplicate.success": "Connection copied: {name}",
  "connection.sidebar.duplicate.failureFallback":
    "Copy connection failed",
  "connection.sidebar.disconnect.success": "Disconnected",
  "connection.sidebar.delete.confirmTitle": "Confirm deletion",
  "connection.sidebar.delete.confirmContent":
    "Are you sure you want to delete connection \"{name}\"?",
  "connection.sidebar.delete.backendUnavailable":
    "Delete connection failed: backend unavailable",
  "connection.sidebar.delete.success": "Connection deleted",
  "connection.sidebar.delete.failureFallback":
    "Delete connection failed",
  "sidebar.message.jvm_provider_probe_failed_with_diagnostic":
    "JVM provider probe failed: {error}. Diagnostic enhancement entry remains available.",
  "sidebar.message.jvm_provider_probe_exception_with_diagnostic":
    "JVM provider probe exception: {error}. Diagnostic enhancement entry remains available.",
  "sidebar.error.unknown": "Unknown error",
  "sidebar.message.connection_failed": "Connection failed: {error}",
  "sidebar.message.no_visible_databases":
    "No visible databases or schemas were returned. Check account permissions or refresh from the context menu.",
  "sidebar.message.jvm_resources_backend_unavailable":
    "JVM resource browsing is not available in this build.",
  "sidebar.message.load_jvm_resources_failed":
    "Failed to load JVM resources: {error}",
  "connection.modal.title.step1": "Select connection type",
  "connection.modal.description.step1":
    "Choose a database, middleware, or file source to open the matching connection flow.",
  "connection.modal.step1.sectionTitle": "Choose data source",
  "connection.modal.step1.sectionDescription":
    "Start by selecting the target database or middleware, then continue with detailed connection settings.",
  "connection.modal.step1.group.relational": "Relational databases",
  "connection.modal.step1.group.domestic": "Domestic databases",
  "connection.modal.step1.group.timeseries": "Time-series databases",
  "connection.modal.step1.group.other": "Other",
  "connection.modal.step1.hint.jvm": "JMX / Endpoint / Agent",
  "connection.modal.step1.hint.custom": "Custom driver and DSN",
  "connection.modal.step1.hint.redis": "Single node / cluster",
  "connection.modal.step1.hint.mongodb": "Single node / replica set",
  "connection.modal.step1.hint.oceanBase": "MySQL / Oracle tenant",
  "connection.modal.step1.hint.file": "Local file connection",
  "connection.modal.step1.hint.standard":
    "Standard connection configuration",
  "connection.modal.title.create": "New {type} connection",
  "connection.modal.description.create":
    "Enter the connection settings, test connectivity, and save it to the connection tree.",
  "connection.modal.title.edit": "Edit connection",
  "connection.modal.description.edit":
    "Update the {type} connection settings, authentication, and network options.",
  "connection.modal.failureDialog.title": "Connection test failure details",
  "connection.modal.failureDialog.description":
    "Review the full error context from the latest connection test to diagnose the configuration issue.",
  "connection.modal.failureDialog.emptyLog": "No failure log available",
  "connection.modal.test.validation":
    "Connection test failed: complete the required fields before retrying.",
  "connection.modal.test.failure": "Connection test failed: {reason}",
  "connection.modal.secret.placeholder.retained":
    "•••••• (leave blank to keep the {retainedLabel})",
  "connection.modal.secret.draftReplacement":
    "A new value has been entered. It will replace the saved value when saved.",
  "connection.modal.error.savedConnectionNotFound":
    "The saved secret for this connection was not found. Enter the password again and save before retrying.",
  "connection.modal.error.secretStoreUnavailable":
    "The system secret store is unavailable. Check the keychain or credentials manager and retry.",
  "connection.modal.layoutKind.mysqlCompatible": "MySQL-compatible",
  "connection.modal.layoutKind.mongodb": "Document database",
  "connection.modal.layoutKind.redis": "Key-value database",
  "connection.modal.layoutKind.postgresCompatible": "PostgreSQL-compatible",
  "connection.modal.layoutKind.oracle": "Oracle service",
  "connection.modal.layoutKind.file": "File-based database",
  "connection.modal.layoutKind.custom": "Custom connection",
  "connection.modal.layoutKind.jvm": "JVM runtime",
  "connection.modal.layoutKind.nacos": "Nacos config center",
  "connection.modal.layoutKind.genericSql": "Standard SQL",
  "connection.modal.section.identity.title": "Connection identity",
  "connection.modal.section.identity.description":
    "Name the connection and define the basic metadata shown in the connection tree.",
  "connection.modal.section.uri.title": "Connection URI",
  "connection.modal.section.uri.description":
    "Paste a complete connection string here, or generate and parse it together with the fields below.",
  "connection.modal.section.target.title": "Target address",
  "connection.modal.section.target.description":
    "The host, port, or gateway entry point of the database service and the primary connectivity target.",
  "connection.modal.section.fileTarget.title": "Database file",
  "connection.modal.section.fileTarget.description":
    "SQLite and DuckDB use a local database file path, without ports or network tunnels.",
  "connection.modal.section.connectionMode.title": "Connection mode",
  "connection.modal.section.connectionMode.description":
    "Choose the topology mode such as single instance, primary-replica, replica set, or cluster.",
  "connection.modal.section.oceanBaseProtocol.title":
    "OceanBase protocol",
  "connection.modal.section.oceanBaseProtocol.description":
    "Explicitly choose the MySQL or Oracle tenant-compatible protocol.",
  "connection.modal.section.mongoDiscovery.title": "MongoDB discovery",
  "connection.modal.section.mongoDiscovery.description":
    "Choose between standard host:port addressing and mongodb+srv DNS discovery.",
  "connection.modal.section.replica.title": "Multi-node settings",
  "connection.modal.section.replica.description":
    "Add replica hosts, seed nodes, replica set members, or separate authentication settings.",
  "connection.modal.section.service.title": "Database service",
  "connection.modal.section.service.description":
    "Service-level routing such as the default database or Oracle Service Name.",
  "connection.modal.section.mongoPolicy.title": "MongoDB policy",
  "connection.modal.section.mongoPolicy.description":
    "MongoDB-specific policies such as auth database and read preference.",
  "connection.modal.section.credentials.title": "Credentials",
  "connection.modal.section.credentials.description":
    "Username, password, and saved-secret retention rules. Leaving it blank follows the stored-secret behavior.",
  "connection.modal.section.databaseScope.title": "Database scope",
  "connection.modal.section.databaseScope.description":
    "Limit which databases or Redis DBs appear in the connection tree after a successful connection.",
  "connection.modal.section.customDriver.title": "Custom driver",
  "connection.modal.section.customDriver.description":
    "Specify the driver name to match an installed or dynamically imported database driver.",
  "connection.modal.section.customDsn.title": "Connection string",
  "connection.modal.section.customDsn.description":
    "Enter the DSN required by the driver directly for non-built-in data sources or special parameters.",
  "connection.modal.section.jvmRuntime.title": "JVM runtime",
  "connection.modal.section.jvmRuntime.description":
    "JVM target settings, access modes, JMX, Endpoint, Agent, and diagnostic enhancements.",
  "connection.modal.uri.label": "Connection URI (copy and paste)",
  "connection.modal.uri.help":
    "Generate it from the fields, copy it to the clipboard, or paste one and parse it back into fields.",
  "connection.modal.uri.action.generate": "Generate URI",
  "connection.modal.uri.action.parse": "Parse from URI",
  "connection.modal.uri.action.copy": "Copy URI",
  "connection.modal.uri.feedback.generated": "URI generated.",
  "connection.modal.uri.feedback.generateFailed": "Failed to generate URI.",
  "connection.modal.uri.feedback.emptyInput": "Enter a URI first.",
  "connection.modal.uri.feedback.unsupported":
    "The URI does not match this data source type, or the URI format is unsupported.",
  "connection.modal.uri.feedback.parsed":
    "Connection fields filled from the URI.",
  "connection.modal.uri.feedback.parseFailed":
    "Failed to parse URI. Check the format and retry.",
  "connection.modal.uri.feedback.emptyCopy": "No URI available to copy.",
  "connection.modal.uri.feedback.copied": "URI copied.",
  "connection.modal.uri.feedback.copyFailed": "Copy failed.",
  "connection.modal.uri.stored.clear": "Clear saved URI",
  "connection.modal.uri.stored.description":
    "A saved connection URI exists. Leave blank to keep it, or enter a new value to replace it.",
  "connection.modal.connectionParams.label": "Extra connection parameters",
  "connection.modal.connectionParams.help":
    "Use the URI/DSN query format supported by the current data source driver. Put authentication passwords in the password field above.",
  "connection.modal.filePicker.sshKeyFailure":
    "Failed to select private key file: {detail}",
  "connection.modal.filePicker.sshKnownHostsFailure":
    "Failed to select known_hosts file: {detail}",
  "connection.modal.filePicker.certificateFailure":
    "Failed to select certificate file: {detail}",
  "connection.modal.filePicker.databaseFailure":
    "Failed to select database file: {detail}",
  "connection.modal.error.unknown": "Unknown error",
  "connection.modal.secret.blocking.primary":
    "enter a new password before testing, or cancel clearing the saved password.",
  "connection.modal.secret.blocking.ssh":
    "enter a new SSH password before testing, or cancel clearing the saved SSH password.",
  "connection.modal.secret.blocking.proxy":
    "enter a new proxy password before testing, or cancel clearing the saved proxy password.",
  "connection.modal.secret.blocking.httpTunnel":
    "enter a new tunnel password before testing, or cancel clearing the saved tunnel password.",
  "connection.modal.secret.blocking.mysqlReplica":
    "enter a new replica password before testing, or cancel clearing the saved replica password.",
  "connection.modal.secret.blocking.mongoReplica":
    "enter a new replica set password before testing, or cancel clearing the saved replica set password.",
  "connection.modal.secret.blocking.mongoPrimary":
    "enter a new MongoDB password before testing, or enable saving the password again.",
  "connection.modal.save.backendUnavailable":
    "Failed to save connection: backend API is unavailable.",
  "connection.modal.save.updatedUnconnected":
    "Configuration updated (not connected).",
  "connection.modal.save.savedUnconnected":
    "Configuration saved (not connected).",
  "connection.modal.save.refreshWarning":
    "Configuration was saved, but the security update status has not refreshed yet. Check again later.",
  "connection.modal.save.failureFallback": "Save failed",
  "connection.modal.test.fallback.driverUnavailable": "Driver is not installed or enabled",
  "connection.modal.test.fallback.incompleteParams":
    "Connection settings are incomplete",
  "connection.modal.test.timeout":
    "Connection test timed out (>{seconds} seconds). Check network, proxy, and SSH settings, then retry.",
  "connection.modal.test.databaseListTimeout":
    "Connection succeeded, but fetching the database list timed out (>{seconds} seconds).",
  "connection.modal.test.noVisibleSchema":
    "Connection succeeded, but no visible schema was returned. Check the current account permissions or default schema settings.",
  "connection.modal.test.noVisibleDatabaseList":
    "Connection succeeded, but no visible database list was returned.",
  "connection.modal.test.databaseListFailure":
    "Connection succeeded, but fetching the database list failed: {detail}",
  "connection.modal.test.fallback.rejected":
    "Connection was rejected or the parameters are invalid. Check them and retry.",
  "connection.modal.test.fallback.validation":
    "Complete the required fields before testing the connection.",
  "connection.modal.test.fallback.unknownException": "Unknown exception",
  "connection.modal.driver.unavailableFallback":
    "{name} driver is not installed or enabled. Install it in Driver Manager first.",
  "connection.modal.driver.unavailableTitle": "{name} driver unavailable",
  "connection.modal.driver.currentFallback": "current",
  "connection.modal.driver.updateFallback":
    "{name} driver agent must be reinstalled to apply driver-side updates for this version",
  "connection.modal.typeWarning.unavailable": "{name} driver is not enabled",
  "connection.modal.config.basic.title": "Basic information",
  "connection.modal.config.basic.description":
    "Common settings are grouped on the left. Fill in the minimum fields needed to establish the connection first.",
  "connection.modal.config.basic.navDescription":
    "Name, address, authentication, URI, and database scope",
  "connection.modal.config.basic.jvmNavDescription":
    "JVM target, access modes, JMX, Endpoint, Agent, and diagnostics",
  "connection.modal.field.name.label": "Connection name",
  "connection.modal.field.environment_type.label": "Preset type",
  "connection.environment.production": "Production environment",
  "connection.environment.test": "Test environment",
  "connection.environment.development": "Development environment",
  "connection.environment.local": "Local environment",
  "connection.modal.field.name.placeholder.default":
    "For example: local test database",
  "connection.modal.field.name.placeholder.jvm":
    "For example: local JVM / order service JVM",
  "connection.modal.field.host.label": "Host address (Host)",
  "connection.modal.field.filePath.label": "File path (absolute path)",
  "connection.modal.field.addressPath.required": "Enter an address or path",
  "connection.modal.field.port.label": "Port (Port)",
  "connection.modal.field.port.required": "Enter the port number",
  "connection.modal.action.browse": "Browse...",
  "connection.modal.field.driver.label": "Driver Name",
  "connection.modal.field.driver.required": "Enter the driver name",
  "connection.modal.field.driver.placeholder": "For example: mysql, postgres",
  "connection.modal.field.dsn.label": "Connection string (DSN)",
  "connection.modal.field.dsn.placeholder":
    "For example: user:pass@tcp(localhost:3306)/dbname?charset=utf8",
  "connection.modal.field.dsn.clearSaved": "Clear saved DSN",
  "connection.modal.field.dsn.savedDescription":
    "A saved connection string currently exists. Leave it blank to keep using it, or enter a new value to replace it.",
  "connection.modal.field.protocol.label": "Connection protocol",
  "connection.modal.field.clickHouseProtocol.help":
    "Auto mode detects from the URI scheme and common ports. Specify HTTP/Native manually for non-standard ports.",
  "connection.modal.field.clickHouseProtocol.auto": "Auto",
  "connection.modal.field.oceanBaseProtocol.label": "OceanBase protocol",
  "connection.modal.field.oceanBaseProtocol.help.primary":
    "Choose MySQL for MySQL tenants and Oracle for Oracle tenants. GoNavi auto-selects by port: OB MySQL wire ports use OBClient capability injection (same path as Navicat), and OBProxy Oracle listener ports use standard TNS.",
  "connection.modal.field.oceanBaseProtocol.help.connectionAttributes":
    "If an Oracle tenant reports \"Error 1235\" or the OBClient handshake fails, override GoNavi's default OBClient capability injection through {attributes} in the Connection parameters field.",
  "connection.modal.field.defaultDatabase.label":
    "Default connection database",
  "connection.modal.field.defaultDatabase.help":
    "Leave blank to automatically try postgres, template1, and a database with the same name as the current user.",
  "connection.modal.field.defaultDatabase.placeholder": "For example: appdb",
  "connection.modal.field.serviceName.label": "Service Name",
  "connection.modal.field.oceanBaseServiceName.label":
    "OceanBase Oracle Service Name",
  "connection.modal.field.serviceName.required":
    "Enter the Oracle service name, for example ORCLPDB1",
  "connection.modal.field.oceanBaseServiceName.required":
    "Enter the OceanBase Oracle service name",
  "connection.modal.field.serviceName.help":
    "Enter the SERVICE_NAME registered with the listener, not the username. For example: ORCLPDB1",
  "connection.modal.field.oceanBaseServiceName.help":
    "Oracle tenants require the SERVICE_NAME registered with the listener. Keep using the OceanBase tenant format for the username.",
  "connection.modal.field.serviceName.placeholder": "For example: ORCLPDB1",
  "connection.modal.field.oracleMode.label": "Connection mode",
  "connection.modal.field.oracleMode.service": "Service name",
  "connection.modal.field.oracleMode.sid": "SID",
  "connection.modal.field.sid.label": "SID",
  "connection.modal.field.sid.required": "Please enter the SID",
  "connection.modal.field.sid.placeholder": "For example: ORCL",
  "connection.modal.jvm.unsupportedMode.saveTest":
    "This connection contains unsupported JVM modes. Change them to JMX, Endpoint, or Agent before testing or saving.",
  "connection.modal.jvm.unsupportedTransport.saveTest":
    "This connection contains an unsupported JVM diagnostic transport. Change it to agent-bridge or arthas-tunnel before testing or saving.",
  "connection.modal.jvm.unsupportedMode.banner":
    "This connection contains unsupported JVM modes. This version supports only JMX / Endpoint / Agent. Adjust the allowed modes and preferred mode before continuing.",
  "connection.modal.jvm.unsupportedMode.alert": "Unsupported JVM mode detected",
  "connection.modal.jvm.target.title": "Target JVM",
  "connection.modal.jvm.target.description":
    "Define the host entry and basic runtime environment shown in the connection tree.",
  "connection.modal.jvm.host.label": "Host address",
  "connection.modal.jvm.host.required": "Enter the JVM host address",
  "connection.modal.jvm.port.label": "Primary port",
  "connection.modal.jvm.port.required": "Enter the JVM port number",
  "connection.modal.jvm.environment.title": "Environment",
  "connection.modal.jvm.environment.dev.label": "Development / test",
  "connection.modal.jvm.environment.dev.description":
    "Local or test environment.",
  "connection.modal.jvm.environment.staging.label": "Staging / acceptance",
  "connection.modal.jvm.environment.staging.description":
    "Pre-release validation environment.",
  "connection.modal.jvm.environment.prod.label": "Production",
  "connection.modal.jvm.environment.prod.description":
    "Production JVM, with more conservative defaults.",
  "connection.modal.jvm.securityPolicy.label": "Security policy",
  "connection.modal.jvm.readonlyPreferred": "Prefer read-only",
  "connection.modal.jvm.accessMode.title": "Access modes",
  "connection.modal.jvm.accessMode.description":
    "Select allowed JVM channels with cards. Clicking an enabled card again makes it preferred.",
  "connection.modal.jvm.accessMode.required":
    "Select at least one JVM access mode",
  "connection.modal.jvm.preferredMode.required":
    "Select the preferred JVM access mode",
  "connection.modal.jvm.tag.preferred": "Preferred",
  "connection.modal.jvm.tag.enabled": "Enabled",
  "connection.modal.jvm.tag.notEnabled": "Not enabled",
  "connection.modal.choice.current": "Current",
  "connection.modal.jvm.mode.jmx.description":
    "Standard MBean and runtime metrics such as threads, memory, and class loading.",
  "connection.modal.jvm.mode.endpoint.description":
    "Read JVM resources and configuration through the server management API.",
  "connection.modal.jvm.mode.agent.description":
    "Use GoNavi Java Agent for richer enhanced capabilities.",
  "connection.modal.jvm.mode.disable": "Disable",
  "connection.modal.jvm.mode.enablePreferred": "Enable and set preferred",
  "connection.modal.jvm.preferredSummary":
    "Current preferred: {mode}. Keep at least one access mode. If the preferred mode is disabled, another remaining mode is selected automatically.",
  "connection.modal.jvm.jmx.description":
    "Standard JVM management channel with optional host, port, and authentication overrides.",
  "connection.modal.jvm.jmx.host.label": "JMX host override",
  "connection.modal.jvm.jmx.host.placeholder": "Leave blank to use the host address",
  "connection.modal.jvm.jmx.port.label": "JMX port",
  "connection.modal.jvm.jmx.port.placeholder": "Use the primary port",
  "connection.modal.jvm.jmx.username.label": "JMX username",
  "connection.modal.jvm.jmx.username.placeholder":
    "Leave blank if authentication is disabled",
  "connection.modal.jvm.jmx.password.label": "JMX password",
  "connection.modal.jvm.jmx.password.placeholder":
    "Leave blank if authentication is disabled",
  "connection.modal.jvm.endpoint.description":
    "Connect to the JVM management endpoint exposed by the application, suitable for services that already provide operations APIs.",
  "connection.modal.jvm.endpoint.address.label": "Endpoint address",
  "connection.modal.jvm.endpoint.address.required":
    "Enter the Endpoint address when Endpoint mode is enabled",
  "connection.modal.jvm.endpoint.address.help":
    "For example, a Spring Boot Actuator or custom management API address.",
  "connection.modal.jvm.endpoint.address.placeholder":
    "For example: https://orders.internal/manage/jvm",
  "connection.modal.jvm.endpoint.apiKey.label": "Endpoint API Key",
  "connection.modal.jvm.endpoint.apiKey.placeholder":
    "Enter it when the endpoint is protected by Token validation",
  "connection.modal.jvm.agent.description":
    "Connect to the GoNavi Java Agent management port for enhanced collection and diagnostics.",
  "connection.modal.jvm.agent.address.label": "Agent address",
  "connection.modal.jvm.agent.address.required":
    "Enter the Agent address when Agent mode is enabled",
  "connection.modal.jvm.agent.address.help":
    "The target Java service must start GoNavi Agent with -javaagent.",
  "connection.modal.jvm.agent.address.placeholder":
    "For example: http://127.0.0.1:19090/gonavi/agent/jvm",
  "connection.modal.jvm.agent.apiKey.label": "Agent API Key",
  "connection.modal.jvm.agent.apiKey.placeholder":
    "Enter it when Agent enables Token validation",
  "connection.modal.jvm.diagnostic.title": "Diagnostic enhancement",
  "connection.modal.jvm.diagnostic.description":
    "Enable controlled JVM diagnostic sessions and Arthas/diagnostic commands.",
  "connection.modal.jvm.switch.on": "On",
  "connection.modal.jvm.switch.off": "Off",
  "connection.modal.jvm.diagnostic.disabledHint":
    "When disabled, only the JVM connection and monitoring capabilities are saved; the diagnostic session entry is hidden.",
  "connection.modal.jvm.diagnostic.transport.label":
    "Diagnostic transport",
  "connection.modal.jvm.diagnostic.transport.agentBridge.description":
    "Bridge diagnostic commands through GoNavi Agent.",
  "connection.modal.jvm.diagnostic.transport.arthasTunnel.description":
    "Connect to the official Tunnel / Web Console.",
  "connection.modal.jvm.diagnostic.arthasTunnelAddress.label":
    "Arthas Tunnel address",
  "connection.modal.jvm.diagnostic.bridgeAddress.label":
    "Diagnostic Bridge address",
  "connection.modal.jvm.diagnostic.arthasTunnelAddress.required":
    "Enter the Arthas Tunnel Server address",
  "connection.modal.jvm.diagnostic.bridgeAddress.required":
    "Enter the Diagnostic Bridge address",
  "connection.modal.jvm.diagnostic.arthasTunnelAddress.help":
    "For example: http://127.0.0.1:7777. Reverse-proxy path prefixes are supported.",
  "connection.modal.jvm.diagnostic.bridgeAddress.help":
    "For example: http://127.0.0.1:19091/gonavi/diag",
  "connection.modal.jvm.diagnostic.targetId.agentId.label":
    "Target instance ID (AgentId)",
  "connection.modal.jvm.diagnostic.targetId.label": "Target instance ID",
  "connection.modal.jvm.diagnostic.targetId.required":
    "Target instance ID is required in Arthas Tunnel mode",
  "connection.modal.jvm.diagnostic.targetId.arthasHelp":
    "Enter the target JVM agentId in Arthas Tunnel.",
  "connection.modal.jvm.diagnostic.targetId.bridgeHelp":
    "Optional. Used by the bridge endpoint to distinguish JVM instances.",
  "connection.modal.jvm.diagnostic.timeout.label":
    "Diagnostic timeout (seconds)",
  "connection.modal.jvm.diagnostic.timeout.range":
    "Diagnostic timeout must be between 1 and 300 seconds.",
  "connection.modal.jvm.diagnostic.apiKey.label": "Diagnostic API Key",
  "connection.modal.jvm.diagnostic.apiKey.placeholder":
    "Enter it when the diagnostic bridge enables Token validation",
  "connection.modal.jvm.diagnostic.command.observe.label":
    "Observe commands",
  "connection.modal.jvm.diagnostic.command.observe.description":
    "Read-only troubleshooting commands such as thread, dashboard, and jvm.",
  "connection.modal.jvm.diagnostic.command.trace.label": "Trace commands",
  "connection.modal.jvm.diagnostic.command.trace.description":
    "Commands such as trace and watch that add extra overhead to the target.",
  "connection.modal.jvm.diagnostic.command.mutating.label":
    "High-risk commands",
  "connection.modal.jvm.diagnostic.command.mutating.description":
    "Commands that may change runtime state or cause noticeable performance impact.",
  "connection.modal.topology.single.label": "Single node",
  "connection.modal.topology.mysql.single.description":
    "Connect only to one primary database address, suitable for local and single-instance setups.",
  "connection.modal.topology.mysql.replica.label": "Primary-replica",
  "connection.modal.topology.mysql.replica.description":
    "Prefer the primary database and configure replica addresses for failover.",
  "connection.modal.topology.mongodb.single.description":
    "Connect only to one MongoDB node.",
  "connection.modal.topology.mongodb.replica.label":
    "Replica set / multi-node",
  "connection.modal.topology.mongodb.replica.description":
    "Configure a replica set name and multiple candidate nodes.",
  "connection.modal.topology.redis.single.description":
    "Connect only to one Redis node.",
  "connection.modal.topology.redis.cluster.label": "Cluster mode",
  "connection.modal.topology.redis.cluster.description":
    "Redis Cluster with multiple seed nodes.",
  "connection.modal.field.redisHosts.label": "Additional cluster node addresses",
  "connection.modal.field.redisHosts.help":
    "Use the host address above as the primary node. Enter other seed nodes here in host:port format.",
  "connection.modal.field.mysqlReplicaHosts.label":
    "Replica host addresses",
  "connection.modal.field.mysqlReplicaHosts.help":
    "Enter multiple replica addresses in host:port format. Press Enter to confirm each one.",
  "connection.modal.field.mysqlReplicaHosts.placeholder":
    "For example: 10.10.0.12:3306, 10.10.0.13:3306",
  "connection.modal.field.mysqlReplicaUser.label": "Replica username",
  "connection.modal.field.mysqlReplicaUser.placeholder":
    "Leave blank to use the primary username",
  "connection.modal.field.mysqlReplicaPassword.label": "Replica password",
  "connection.modal.field.mysqlReplicaPassword.placeholder":
    "Leave blank to use the primary password",
  "connection.modal.field.mysqlReplicaPassword.retained":
    "saved replica password",
  "connection.modal.field.mysqlReplicaPassword.clear":
    "Clear saved replica password",
  "connection.modal.field.mysqlReplicaPassword.savedDescription":
    "A saved replica password exists. Leave blank to keep it, or enter a new value to replace it.",
  "connection.modal.mongo.discovery.standard.label": "Standard address",
  "connection.modal.mongo.discovery.standard.description":
    "Use host:port for direct connections or replica set node lists.",
  "connection.modal.mongo.discovery.srv.label": "SRV address",
  "connection.modal.mongo.discovery.srv.description":
    "Use mongodb+srv and let DNS discover the target nodes.",
  "connection.modal.mongo.discovery.srvSshWarning":
    "When SRV and SSH tunnel are both enabled, local DNS resolution may be required.",
  "connection.modal.field.mongoHosts.label": "Additional node addresses",
  "connection.modal.field.mongoSrvHosts.label": "Additional SRV hosts",
  "connection.modal.field.mongoHosts.help":
    "Enter multiple node addresses in host:port format. Press Enter to confirm each one.",
  "connection.modal.field.mongoSrvHosts.help":
    "Enter multiple candidate host names in host format. Leave blank to use only the host above.",
  "connection.modal.field.mongoHosts.placeholder":
    "For example: 10.10.0.12:27017, 10.10.0.13:27017",
  "connection.modal.field.mongoSrvHosts.placeholder":
    "For example: cluster-a.example.com, cluster-b.example.com",
  "connection.modal.field.mongoReplicaSet.label": "Replica set name",
  "connection.modal.field.mongoReplicaSet.placeholder": "For example: rs0",
  "connection.modal.field.mongoReplicaUser.label": "Replica set username",
  "connection.modal.field.mongoReplicaUser.placeholder":
    "Leave blank to use the primary username",
  "connection.modal.field.mongoReplicaPassword.label":
    "Replica set password",
  "connection.modal.field.mongoReplicaPassword.placeholder":
    "Leave blank to use the primary password",
  "connection.modal.field.mongoReplicaPassword.retained":
    "saved replica set password",
  "connection.modal.field.mongoReplicaPassword.clear":
    "Clear saved replica set password",
  "connection.modal.field.mongoReplicaPassword.savedDescription":
    "A saved replica set password exists. Leave blank to keep it, or enter a new value to replace it.",
  "connection.modal.mongo.discoverMembers": "Discover members",
  "connection.modal.mongo.discover.failure": "Member discovery failed",
  "connection.modal.mongo.discover.successOne": "Discovered {count} member.",
  "connection.modal.mongo.discover.successMany": "Discovered {count} members.",
  "connection.modal.mongo.member.role": "Role",
  "connection.modal.mongo.member.health": "Health",
  "connection.modal.mongo.member.healthy": "Healthy",
  "connection.modal.mongo.member.unhealthy": "Unhealthy",
  "connection.modal.field.mongoAuthSource.label":
    "Auth database (authSource)",
  "connection.modal.field.mongoAuthSource.placeholder":
    "Defaults to database or admin",
  "connection.modal.mongo.readPreference.label":
    "Read preference (readPreference)",
  "connection.modal.mongo.readPreference.primary.description":
    "Read from the primary node only.",
  "connection.modal.mongo.readPreference.primaryPreferred.description":
    "Prefer the primary node.",
  "connection.modal.mongo.readPreference.secondary.description":
    "Read from secondary nodes only.",
  "connection.modal.mongo.readPreference.secondaryPreferred.description":
    "Prefer secondary nodes.",
  "connection.modal.mongo.readPreference.nearest.description":
    "Choose the nearest node.",
  "connection.modal.mongo.authMechanism.label": "Authentication method",
  "connection.modal.mongo.authMechanism.auto.label": "Auto-negotiate",
  "connection.modal.mongo.authMechanism.auto.description":
    "Let the driver choose based on server capabilities.",
  "connection.modal.mongo.authMechanism.none.label": "No authentication",
  "connection.modal.mongo.authMechanism.none.description":
    "Do not send authentication information.",
  "connection.modal.mongo.authMechanism.scramSha1.description":
    "Compatible with older MongoDB versions.",
  "connection.modal.mongo.authMechanism.scramSha256.description":
    "Recommended SCRAM authentication.",
  "connection.modal.mongo.authMechanism.aws.description":
    "AWS IAM authentication.",
  "connection.modal.field.redisHosts.placeholder":
    "For example: 10.10.0.12:6379, 10.10.0.13:6379",
  "connection.modal.field.redisPassword.label": "Redis password",
  "connection.modal.field.redisPassword.placeholder":
    "Redis password, if requirepass is configured",
  "connection.modal.field.redisPassword.retained": "saved Redis password",
  "connection.modal.field.displayDatabases.label": "Visible databases",
  "connection.modal.field.displayDatabases.help":
    "Exact names available after a successful connection test; combined with include masks",
  "connection.modal.field.displayDatabases.placeholder":
    "Select visible databases",
  "connection.modal.field.includeDatabasePatterns.help":
    "Matching current and newly created databases are shown automatically",
  "connection.modal.field.includeDatabasePatterns.placeholder":
    "For example: tenant_%, reporting*",
  "connection.modal.field.excludeDatabasePatterns.help":
    "Exclude masks take precedence over exact names and include masks",
  "connection.modal.field.excludeDatabasePatterns.placeholder":
    "For example: *_archive, test_%",
  "connection.modal.field.databasePatterns.help":
    "* and % match any text, _ matches one character, and \\ escapes a wildcard. Excludes win.",
  "connection.modal.field.displayRedisDatabases.placeholder":
    "Select visible databases (0-15)",
  "connection.modal.field.username.label": "Username",
  "connection.modal.field.username.required": "Enter the username",
  "connection.modal.field.password.label": "Password",
  "connection.modal.field.password.placeholder": "Password",
  "connection.modal.field.password.retained": "saved password",
  "connection.modal.field.savePassword": "Save password",
  "connection.modal.network.title": "Network & Security",
  "connection.modal.network.navDescription":
    "SSL, SSH, proxy, and advanced connection",
  "connection.modal.network.description":
    "Keep connection methods listed above and show the selected details below, so enabling options does not rearrange the page and the detail area has enough space.",
  "connection.modal.network.currentEditing": "Editing",
  "connection.modal.network.enabled": "Enabled",
  "connection.modal.network.notEnabled": "Not enabled",
  "connection.modal.network.ssl.description":
    "Encryption and certificate validation",
  "connection.modal.network.ssh.title": "SSH tunnel",
  "connection.modal.network.ssh.description":
    "Jump host or bastion forwarding",
  "connection.modal.network.proxy.title": "Proxy",
  "connection.modal.network.proxy.description":
    "Local proxy or gateway forwarding",
  "connection.modal.network.httpTunnel.title": "Navicat HTTP tunnel",
  "connection.modal.network.httpTunnel.description":
    "MySQL-compatible script tunnel",
  "connection.modal.network.ssl.panelDescription":
    "Add encryption and certificate validation controls to the connection path, suitable for production or cross-network access.",
  "connection.modal.network.ssl.disabledHint":
    "Select SSL/TLS on the left to configure mode, certificates, and validation policy here.",
  "connection.modal.network.ssl.mode": "SSL mode",
  "connection.modal.network.ssl.preferred.description":
    "Prefer SSL. If it fails, follow the driver policy.",
  "connection.modal.network.ssl.required.description":
    "Require SSL and validate certificates.",
  "connection.modal.network.ssl.skipVerify.description":
    "Require SSL but skip certificate validation.",
  "connection.modal.network.ssl.caPath": "CA certificate path",
  "connection.modal.network.ssl.serverCaPath":
    "Server certificate / CA path",
  "connection.modal.network.ssl.certPath": "Client certificate path",
  "connection.modal.network.ssl.damengCertPath":
    "Client certificate path (SSL_CERT_PATH)",
  "connection.modal.network.ssl.keyPath": "Client private key path",
  "connection.modal.network.ssl.damengKeyPath":
    "Client private key path (SSL_KEY_PATH)",
  "connection.modal.network.ssl.certRequired":
    "Dameng SSL requires a certificate path",
  "connection.modal.network.ssl.keyRequired":
    "Dameng SSL requires a private key path",
  "connection.modal.network.ssl.hint.mysqlCompatible":
    "MySQL-compatible data sources support CA certificates, client certificates, and private keys. For local self-signed certificates, try Preferred or Skip Verify first.",
  "connection.modal.network.ssl.hint.oceanBaseOracle":
    "OceanBase Oracle tenants connect through the Oracle protocol. If a Wallet is required, configure Oracle driver parameters in advanced settings.",
  "connection.modal.network.ssl.hint.dameng":
    "Dameng SSL requires client certificate and private key paths (sslCertPath / sslKeyPath).",
  "connection.modal.network.ssl.hint.sqlserver":
    "SQL Server can use a server certificate or CA file. In production, use Required and disable TrustServerCertificate.",
  "connection.modal.network.ssl.hint.mongodb":
    "MongoDB supports CA certificates, client certificates, and private keys. If certificate validation fails, use Skip Verify first to test connectivity.",
  "connection.modal.network.ssl.hint.oracle":
    "For Oracle PEM certificates, prefer Wallet and configure WALLET in advanced parameters. This section only controls SSL and validation policy.",
  "connection.modal.network.ssl.hint.tdengine":
    "TDengine currently configures WSS and validation policy only. Manage certificate files through the server trust chain.",
  "connection.modal.network.ssl.hint.default":
    "Supported drivers can configure CA certificates, client certificates, and private keys. Use Skip Verify only for tests or self-signed certificates.",
  "connection.modal.example": "For example: {value}",
  "connection.modal.example.or": "For example: {first} or {second}",
  "connection.modal.network.ssh.panelDescription":
    "Forward the database connection through a jump host or bastion, suitable for internal or restricted networks.",
  "connection.modal.network.ssh.disabledHint":
    "Select SSH tunnel on the left to enter host, port, username, password, and private key path here.",
  "connection.modal.network.ssh.host": "SSH host (domain or IP)",
  "connection.modal.network.ssh.hostRequired": "Enter the SSH host",
  "connection.modal.network.ssh.portRequired": "Enter the SSH port",
  "connection.modal.network.ssh.user": "SSH user",
  "connection.modal.network.ssh.userRequired": "Enter the SSH user",
  "connection.modal.network.ssh.password": "SSH password",
  "connection.modal.network.ssh.keyPath": "Private key path",
  "connection.modal.network.ssh.keyPathPlaceholder": "Absolute path",
  "connection.modal.network.ssh.knownHostsPath": "known_hosts path (optional)",
  "connection.modal.network.ssh.knownHostsPathPlaceholder": "Absolute path",
  "connection.modal.network.ssh.hostKeyFingerprint": "Server SHA256 fingerprint (optional)",
  "connection.modal.network.ssh.hostKeyFingerprintPlaceholder": "SHA256:<base64>",
  "connection.modal.network.ssh.hostKeyVerificationHint":
    "Configure a known_hosts path or SHA256 fingerprint. Unknown or changed server keys are rejected; keys are never written or overwritten automatically.",
  "connection.modal.network.ssh.hostKeyAutomaticHint":
    "GoNavi automatically identifies and verifies the server's identity. On first connection, verify the fingerprint through a trusted channel and confirm it; trusted servers pass automatically, while changed keys are blocked.",
  "connection.modal.network.ssh.hostKeyConfirmationRequired":
    "Confirm the SSH server identity before continuing.",
  "connection.modal.network.ssh.hostKeyTrustSaved":
    "The SSH server identity has been trusted and saved.",
  "connection.modal.network.ssh.hostKeyDialog.unknownTitle": "Confirm SSH server identity",
  "connection.modal.network.ssh.hostKeyDialog.changedTitle": "SSH server key changed",
  "connection.modal.network.ssh.hostKeyDialog.unknownMessage":
    "GoNavi identified the server public key during the SSH handshake. Verify this fingerprint through a trusted channel before continuing.",
  "connection.modal.network.ssh.hostKeyDialog.changedMessage":
    "The server presented a key that differs from the trusted record. The connection was blocked to protect against man-in-the-middle attacks.",
  "connection.modal.network.ssh.hostKeyDialog.host": "Server",
  "connection.modal.network.ssh.hostKeyDialog.keyType": "Key type",
  "connection.modal.network.ssh.hostKeyDialog.fingerprint": "SHA256 fingerprint",
  "connection.modal.network.ssh.hostKeyDialog.previousFingerprint": "Previous fingerprint",
  "connection.modal.network.ssh.hostKeyDialog.continueOnce": "Continue once",
  "connection.modal.network.ssh.hostKeyDialog.trustAndSave": "Trust and save",
  "connection.modal.network.ssh.hostKeyDialog.replaceAndTrust": "Replace and trust",
  "connection.modal.network.ssh.hostKeyDialog.saveExplanation":
    "This saves the key only in GoNavi's trusted-host store; ~/.ssh/known_hosts is not changed.",
  "connection.modal.network.ssh.hostKeyDialog.saveFailure":
    "Could not save the server identity: {detail}",
  "connection.modal.network.ssh.retained": "saved SSH password",
  "connection.modal.network.ssh.clearPassword": "Clear saved SSH password",
  "connection.modal.network.ssh.savedDescription":
    "A saved SSH password exists. Leave blank to keep it, or enter a new value to replace it.",
  "connection.modal.network.proxy.panelDescription":
    "Use a local proxy app or intermediate gateway to forward database traffic.",
  "connection.modal.network.proxy.disabledHint":
    "Select Proxy on the left to choose the proxy type and enter host, port, and authentication settings here.",
  "connection.modal.network.proxy.host": "Proxy host",
  "connection.modal.network.proxy.hostRequired": "Enter the proxy host",
  "connection.modal.network.proxy.type": "Proxy type",
  "connection.modal.network.proxy.socks5.description":
    "Common local proxy and gateway proxy.",
  "connection.modal.network.proxy.http.description":
    "Create a tunnel through HTTP CONNECT.",
  "connection.modal.network.proxy.portRequired": "Enter the proxy port",
  "connection.modal.network.proxy.user": "Proxy username",
  "connection.modal.network.proxy.password": "Proxy password",
  "connection.modal.network.proxy.noAuth":
    "Leave blank for no authentication",
  "connection.modal.network.proxy.retained": "saved proxy password",
  "connection.modal.network.proxy.clearPassword":
    "Clear saved proxy password",
  "connection.modal.network.proxy.savedDescription":
    "A saved proxy password exists. Leave blank to keep it, or enter a new value to replace it.",
  "connection.modal.network.httpTunnel.panelDescription":
    "Forward MySQL requests through a complete ntunnel_mysql.php URL.",
  "connection.modal.network.httpTunnel.disabledHint":
    "Select it to enter the complete script URL and authentication settings. This currently supports MySQL-compatible connections only; use an HTTP proxy for standard HTTP CONNECT.",
  "connection.modal.network.httpTunnel.host": "HTTP tunnel URL",
  "connection.modal.network.httpTunnel.hostRequired":
    "Enter the complete HTTP tunnel URL",
  "connection.modal.network.httpTunnel.urlPlaceholder":
    "For example: https://gateway.example.com/ntunnel_mysql.php",
  "connection.modal.network.httpTunnel.portRequired":
    "Enter the tunnel port",
  "connection.modal.network.httpTunnel.user": "HTTP Basic username",
  "connection.modal.network.httpTunnel.password": "HTTP Basic password",
  "connection.modal.network.httpTunnel.retained": "saved HTTP tunnel password",
  "connection.modal.network.httpTunnel.clearPassword":
    "Clear saved HTTP tunnel password",
  "connection.modal.network.httpTunnel.savedDescription":
    "A saved HTTP tunnel password exists. Leave blank to keep it, or enter a new value to replace it.",
  "connection.modal.network.httpTunnel.encodeBase64":
    "Base64-encode query content",
  "connection.modal.network.httpTunnel.encodeBase64Hint":
    "Matches Navicat's encodeBase64 option and is enabled by default.",
  "connection.modal.network.httpTunnel.exclusiveHint":
    "Currently supported for MySQL-compatible connections only. For a standard HTTP CONNECT proxy, choose HTTP under Proxy.",
  "connection.modal.validation.ssl.damengRequired":
    "Certificate and private key paths are required when Dameng SSL is enabled.",
  "connection.modal.validation.ssl.clientPairRequired":
    "TLS client certificate and private key paths must be provided together.",
  "connection.modal.validation.httpTunnel.hostRequired":
    "HTTP tunnel URL is required.",
  "connection.modal.validation.httpTunnel.portRange":
    "HTTP tunnel port must be between 1 and 65535.",
  "connection.modal.network.advanced.title": "Advanced connection",
  "connection.modal.network.timeout.label": "Connection timeout (seconds)",
  "connection.modal.network.timeout.help":
    "Database connection timeout. Default is 30 seconds.",
  "connection.modal.network.timeout.range":
    "Timeout must be between 1 and 300 seconds.",
  "connection.modal.network.keepAliveEnabled.checkbox":
    "Enable background keep-alive ping",
  "connection.modal.network.keepAliveEnabled.help":
    "Enable this only when a jump-host token or long-lived session needs periodic renewal.",
  "connection.modal.network.keepAliveInterval.label":
    "Keep-alive interval (minutes)",
  "connection.modal.network.keepAliveInterval.help":
    "GoNavi runs Ping or the custom keep-alive SQL on established cached connections at this interval. Default is 240 minutes.",
  "connection.modal.network.keepAliveInterval.range":
    "Keep-alive interval must be between 1 and 1440 minutes.",
  "connection.modal.network.keepAliveSQL.label": "Custom keep-alive SQL",
  "connection.modal.network.keepAliveSQL.help":
    "Leave blank to use the driver Ping. Only one SELECT/WITH statement is allowed; use a lightweight query that returns little data and a database account with read-only permissions. This value is stored in plain text with the connection; do not include credentials.",
  "connection.modal.network.keepAliveSQL.maxLength":
    "Custom keep-alive SQL cannot exceed 4096 characters.",
  "connection.modal.network.keepAliveSQL.readOnly":
    "Custom keep-alive SQL must be one SELECT or WITH statement.",
  "connection.modal.appearance.title": "Appearance",
  "connection.modal.appearance.description": "Custom icon and color",
  "connection.modal.appearance.icon": "Icon",
  "connection.modal.appearance.current": "Current: {name}",
  "connection.modal.appearance.color": "Color",
  "connection.modal.appearance.customColor": "Custom color",
  "connection.modal.appearance.preview": "Preview",
  "connection.modal.appearance.previewName": "Connection name",
  "connection.modal.appearance.reset": "Reset to default",
  "connection.modal.config.sections": "Configuration sections",
  "connection.modal.driver.unavailableAlert":
    "Current data source driver is not enabled",
  "connection.modal.driver.installAction": "Install in Driver Manager",
  "connection.modal.driver.updateAlert":
    "Driver agent reinstall is recommended for this data source",
  "connection.modal.driver.reinstallAction": "Reinstall in Driver Manager",
};
