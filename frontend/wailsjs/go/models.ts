export namespace ai {
	
	export class CLICapabilityView {
	    apiFormat: string;
	    command: string;
	    supportsEffort: boolean;
	    effortValues: string[];
	    effortValuesVerified: boolean;
	    supportsModelDiscovery: boolean;
	    hasConfigSource: boolean;
	    defaultModel: string;
	    defaultEffort: string;
	
	    static createFrom(source: any = {}) {
	        return new CLICapabilityView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.apiFormat = source["apiFormat"];
	        this.command = source["command"];
	        this.supportsEffort = source["supportsEffort"];
	        this.effortValues = source["effortValues"];
	        this.effortValuesVerified = source["effortValuesVerified"];
	        this.supportsModelDiscovery = source["supportsModelDiscovery"];
	        this.hasConfigSource = source["hasConfigSource"];
	        this.defaultModel = source["defaultModel"];
	        this.defaultEffort = source["defaultEffort"];
	    }
	}
	export class MCPClientInstallResult {
	    success: boolean;
	    client?: string;
	    message: string;
	    configPath?: string;
	    command?: string;
	    args?: string[];
	
	    static createFrom(source: any = {}) {
	        return new MCPClientInstallResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.client = source["client"];
	        this.message = source["message"];
	        this.configPath = source["configPath"];
	        this.command = source["command"];
	        this.args = source["args"];
	    }
	}
	export class MCPClientInstallStatus {
	    client: string;
	    displayName: string;
	    installMode?: string;
	    installed: boolean;
	    matchesCurrent: boolean;
	    clientDetected: boolean;
	    clientCommand?: string;
	    clientPath?: string;
	    message: string;
	    configPath?: string;
	    command?: string;
	    args?: string[];
	
	    static createFrom(source: any = {}) {
	        return new MCPClientInstallStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.client = source["client"];
	        this.displayName = source["displayName"];
	        this.installMode = source["installMode"];
	        this.installed = source["installed"];
	        this.matchesCurrent = source["matchesCurrent"];
	        this.clientDetected = source["clientDetected"];
	        this.clientCommand = source["clientCommand"];
	        this.clientPath = source["clientPath"];
	        this.message = source["message"];
	        this.configPath = source["configPath"];
	        this.command = source["command"];
	        this.args = source["args"];
	    }
	}
	export class MCPHTTPServerOptions {
	    addr?: string;
	    path?: string;
	    token?: string;
	    schemaOnly: boolean;
	
	    static createFrom(source: any = {}) {
	        return new MCPHTTPServerOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.addr = source["addr"];
	        this.path = source["path"];
	        this.token = source["token"];
	        this.schemaOnly = source["schemaOnly"];
	    }
	}
	export class MCPHTTPServerStatus {
	    enabled: boolean;
	    running: boolean;
	    addr: string;
	    path: string;
	    url: string;
	    schemaOnly: boolean;
	    token?: string;
	    authorizationHeader?: string;
	    startedAt?: number;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new MCPHTTPServerStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.running = source["running"];
	        this.addr = source["addr"];
	        this.path = source["path"];
	        this.url = source["url"];
	        this.schemaOnly = source["schemaOnly"];
	        this.token = source["token"];
	        this.authorizationHeader = source["authorizationHeader"];
	        this.startedAt = source["startedAt"];
	        this.message = source["message"];
	    }
	}
	export class MCPServerConfig {
	    id: string;
	    name: string;
	    transport: string;
	    command: string;
	    args?: string[];
	    env?: Record<string, string>;
	    enabled: boolean;
	    timeoutSeconds: number;
	
	    static createFrom(source: any = {}) {
	        return new MCPServerConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.transport = source["transport"];
	        this.command = source["command"];
	        this.args = source["args"];
	        this.env = source["env"];
	        this.enabled = source["enabled"];
	        this.timeoutSeconds = source["timeoutSeconds"];
	    }
	}
	export class MCPToolCallResult {
	    alias: string;
	    serverId: string;
	    serverName: string;
	    originalName: string;
	    title?: string;
	    content: string;
	    structuredContent?: any;
	    isError: boolean;
	
	    static createFrom(source: any = {}) {
	        return new MCPToolCallResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.alias = source["alias"];
	        this.serverId = source["serverId"];
	        this.serverName = source["serverName"];
	        this.originalName = source["originalName"];
	        this.title = source["title"];
	        this.content = source["content"];
	        this.structuredContent = source["structuredContent"];
	        this.isError = source["isError"];
	    }
	}
	export class MCPToolDescriptor {
	    alias: string;
	    serverId: string;
	    serverName: string;
	    originalName: string;
	    title?: string;
	    description?: string;
	    inputSchema?: Record<string, any>;
	
	    static createFrom(source: any = {}) {
	        return new MCPToolDescriptor(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.alias = source["alias"];
	        this.serverId = source["serverId"];
	        this.serverName = source["serverName"];
	        this.originalName = source["originalName"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.inputSchema = source["inputSchema"];
	    }
	}
	export class ProviderConfig {
	    id: string;
	    type: string;
	    name: string;
	    authMode?: string;
	    apiKey: string;
	    secretRef?: string;
	    hasSecret?: boolean;
	    baseUrl: string;
	    model: string;
	    inlineCompletionModel?: string;
	    models?: string[];
	    disabledModels?: string[];
	    customModels?: string[];
	    apiFormat?: string;
	    headers?: Record<string, string>;
	    maxTokens: number;
	    temperature: number;
	    thinkingIntensity?: string;
	    effort?: string;
	
	    static createFrom(source: any = {}) {
	        return new ProviderConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.type = source["type"];
	        this.name = source["name"];
	        this.authMode = source["authMode"];
	        this.apiKey = source["apiKey"];
	        this.secretRef = source["secretRef"];
	        this.hasSecret = source["hasSecret"];
	        this.baseUrl = source["baseUrl"];
	        this.model = source["model"];
	        this.inlineCompletionModel = source["inlineCompletionModel"];
	        this.models = source["models"];
	        this.disabledModels = source["disabledModels"];
	        this.customModels = source["customModels"];
	        this.apiFormat = source["apiFormat"];
	        this.headers = source["headers"];
	        this.maxTokens = source["maxTokens"];
	        this.temperature = source["temperature"];
	        this.thinkingIntensity = source["thinkingIntensity"];
	        this.effort = source["effort"];
	    }
	}
	export class SafetyResult {
	    allowed: boolean;
	    operationType: string;
	    requiresConfirm: boolean;
	    warningMessage?: string;
	
	    static createFrom(source: any = {}) {
	        return new SafetyResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.allowed = source["allowed"];
	        this.operationType = source["operationType"];
	        this.requiresConfirm = source["requiresConfirm"];
	        this.warningMessage = source["warningMessage"];
	    }
	}
	export class SkillConfig {
	    id: string;
	    name: string;
	    description?: string;
	    systemPrompt: string;
	    enabled: boolean;
	    scopes?: string[];
	    requiredTools?: string[];
	
	    static createFrom(source: any = {}) {
	        return new SkillConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.description = source["description"];
	        this.systemPrompt = source["systemPrompt"];
	        this.enabled = source["enabled"];
	        this.scopes = source["scopes"];
	        this.requiredTools = source["requiredTools"];
	    }
	}
	export class UserPromptSettings {
	    global: string;
	    database: string;
	    jvm: string;
	    jvmDiagnostic: string;
	
	    static createFrom(source: any = {}) {
	        return new UserPromptSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.global = source["global"];
	        this.database = source["database"];
	        this.jvm = source["jvm"];
	        this.jvmDiagnostic = source["jvmDiagnostic"];
	    }
	}

}

export namespace app {
	
	export class CloudBackupConnectionSummary {
	    id: string;
	    name: string;
	    host?: string;
	
	    static createFrom(source: any = {}) {
	        return new CloudBackupConnectionSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.host = source["host"];
	    }
	}
	export class CloudBackupCategory {
	    id: string;
	    itemCount: number;
	    files?: string[];
	    connections?: CloudBackupConnectionSummary[];
	    restartRequired: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CloudBackupCategory(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.itemCount = source["itemCount"];
	        this.files = source["files"];
	        this.connections = this.convertValues(source["connections"], CloudBackupConnectionSummary);
	        this.restartRequired = source["restartRequired"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CloudBackupConfig {
	    enabled: boolean;
	    provider: string;
	    webdavEndpoint?: string;
	    webdavFilePath?: string;
	    s3Endpoint?: string;
	    s3Bucket?: string;
	    s3Region?: string;
	    s3ObjectKey?: string;
	    schedule: string;
	    backupCategories: string[];
	    hasWebdavCredential?: boolean;
	    hasS3Credential?: boolean;
	    hasEncryptionKey?: boolean;
	    webdavLastSyncAt?: string;
	    webdavLastSyncSuccess: boolean;
	    webdavLastSyncError?: string;
	    webdavRemoteAvailable: boolean;
	    webdavRemoteUpdatedAt?: string;
	    s3LastSyncAt?: string;
	    s3LastSyncSuccess: boolean;
	    s3LastSyncError?: string;
	    s3RemoteAvailable: boolean;
	    s3RemoteUpdatedAt?: string;
	
	    static createFrom(source: any = {}) {
	        return new CloudBackupConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.provider = source["provider"];
	        this.webdavEndpoint = source["webdavEndpoint"];
	        this.webdavFilePath = source["webdavFilePath"];
	        this.s3Endpoint = source["s3Endpoint"];
	        this.s3Bucket = source["s3Bucket"];
	        this.s3Region = source["s3Region"];
	        this.s3ObjectKey = source["s3ObjectKey"];
	        this.schedule = source["schedule"];
	        this.backupCategories = source["backupCategories"];
	        this.hasWebdavCredential = source["hasWebdavCredential"];
	        this.hasS3Credential = source["hasS3Credential"];
	        this.hasEncryptionKey = source["hasEncryptionKey"];
	        this.webdavLastSyncAt = source["webdavLastSyncAt"];
	        this.webdavLastSyncSuccess = source["webdavLastSyncSuccess"];
	        this.webdavLastSyncError = source["webdavLastSyncError"];
	        this.webdavRemoteAvailable = source["webdavRemoteAvailable"];
	        this.webdavRemoteUpdatedAt = source["webdavRemoteUpdatedAt"];
	        this.s3LastSyncAt = source["s3LastSyncAt"];
	        this.s3LastSyncSuccess = source["s3LastSyncSuccess"];
	        this.s3LastSyncError = source["s3LastSyncError"];
	        this.s3RemoteAvailable = source["s3RemoteAvailable"];
	        this.s3RemoteUpdatedAt = source["s3RemoteUpdatedAt"];
	    }
	}
	export class CloudBackupConfigInput {
	    enabled: boolean;
	    provider: string;
	    webdavEndpoint?: string;
	    webdavFilePath?: string;
	    s3Endpoint?: string;
	    s3Bucket?: string;
	    s3Region?: string;
	    s3ObjectKey?: string;
	    schedule: string;
	    backupCategories: string[];
	    webdavUsername?: string;
	    webdavPassword?: string;
	    s3AccessKey?: string;
	    s3SecretKey?: string;
	    encryptionPassword?: string;
	    clearWebdavCredential: boolean;
	    clearS3Credential: boolean;
	    clearRemoteSecret: boolean;
	    clearEncryptionKey: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CloudBackupConfigInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.provider = source["provider"];
	        this.webdavEndpoint = source["webdavEndpoint"];
	        this.webdavFilePath = source["webdavFilePath"];
	        this.s3Endpoint = source["s3Endpoint"];
	        this.s3Bucket = source["s3Bucket"];
	        this.s3Region = source["s3Region"];
	        this.s3ObjectKey = source["s3ObjectKey"];
	        this.schedule = source["schedule"];
	        this.backupCategories = source["backupCategories"];
	        this.webdavUsername = source["webdavUsername"];
	        this.webdavPassword = source["webdavPassword"];
	        this.s3AccessKey = source["s3AccessKey"];
	        this.s3SecretKey = source["s3SecretKey"];
	        this.encryptionPassword = source["encryptionPassword"];
	        this.clearWebdavCredential = source["clearWebdavCredential"];
	        this.clearS3Credential = source["clearS3Credential"];
	        this.clearRemoteSecret = source["clearRemoteSecret"];
	        this.clearEncryptionKey = source["clearEncryptionKey"];
	    }
	}
	
	export class CloudBackupRestorePoint {
	    objectKey: string;
	    lastModified?: string;
	    size?: number;
	    etag?: string;
	
	    static createFrom(source: any = {}) {
	        return new CloudBackupRestorePoint(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.objectKey = source["objectKey"];
	        this.lastModified = source["lastModified"];
	        this.size = source["size"];
	        this.etag = source["etag"];
	    }
	}
	export class CloudBackupRestorePreview {
	    createdAt: string;
	    connectionCount: number;
	    fileCount: number;
	    files: string[];
	    restartRequired: boolean;
	    categories: CloudBackupCategory[];
	    confirmationToken?: string;
	
	    static createFrom(source: any = {}) {
	        return new CloudBackupRestorePreview(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.createdAt = source["createdAt"];
	        this.connectionCount = source["connectionCount"];
	        this.fileCount = source["fileCount"];
	        this.files = source["files"];
	        this.restartRequired = source["restartRequired"];
	        this.categories = this.convertValues(source["categories"], CloudBackupCategory);
	        this.confirmationToken = source["confirmationToken"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CloudBackupRestoreRequest {
	    confirmationToken: string;
	    categories: string[];
	
	    static createFrom(source: any = {}) {
	        return new CloudBackupRestoreRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.confirmationToken = source["confirmationToken"];
	        this.categories = source["categories"];
	    }
	}
	export class CloudBackupStatus {
	    configured: boolean;
	    enabled: boolean;
	    provider: string;
	    lastSyncAt?: string;
	    lastSyncSuccess: boolean;
	    lastSyncError?: string;
	    remoteAvailable: boolean;
	    remoteUpdatedAt?: string;
	    dirty: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CloudBackupStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.configured = source["configured"];
	        this.enabled = source["enabled"];
	        this.provider = source["provider"];
	        this.lastSyncAt = source["lastSyncAt"];
	        this.lastSyncSuccess = source["lastSyncSuccess"];
	        this.lastSyncError = source["lastSyncError"];
	        this.remoteAvailable = source["remoteAvailable"];
	        this.remoteUpdatedAt = source["remoteUpdatedAt"];
	        this.dirty = source["dirty"];
	    }
	}
	export class ConnectionExportOptions {
	    includeSecrets: boolean;
	    filePassword?: string;
	    connectionIds?: string[];
	    redisDbAliases?: Record<string, any>;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionExportOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.includeSecrets = source["includeSecrets"];
	        this.filePassword = source["filePassword"];
	        this.connectionIds = source["connectionIds"];
	        this.redisDbAliases = source["redisDbAliases"];
	    }
	}
	export class ConnectionPackageImportResult {
	    connections: connection.SavedConnectionView[];
	    redisDbAliases?: Record<string, any>;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionPackageImportResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connections = this.convertValues(source["connections"], connection.SavedConnectionView);
	        this.redisDbAliases = source["redisDbAliases"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DataImportModeCapability {
	    supported: boolean;
	    reason: string;
	    requiresPinnedSession: boolean;
	    supportsTransactionalBatch: boolean;
	    supportsContinue: boolean;
	    supportedFormats: string[];
	    supportedEncodings: string[];
	    supportedCompressions: string[];
	    supportedClientDirectives: string[];
	    supportedConflictPolicies: string[];
	
	    static createFrom(source: any = {}) {
	        return new DataImportModeCapability(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.supported = source["supported"];
	        this.reason = source["reason"];
	        this.requiresPinnedSession = source["requiresPinnedSession"];
	        this.supportsTransactionalBatch = source["supportsTransactionalBatch"];
	        this.supportsContinue = source["supportsContinue"];
	        this.supportedFormats = source["supportedFormats"];
	        this.supportedEncodings = source["supportedEncodings"];
	        this.supportedCompressions = source["supportedCompressions"];
	        this.supportedClientDirectives = source["supportedClientDirectives"];
	        this.supportedConflictPolicies = source["supportedConflictPolicies"];
	    }
	}
	export class DataImportCapability {
	    databaseType: string;
	    tableImport: DataImportModeCapability;
	    sqlFileImport: DataImportModeCapability;
	
	    static createFrom(source: any = {}) {
	        return new DataImportCapability(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.databaseType = source["databaseType"];
	        this.tableImport = this.convertValues(source["tableImport"], DataImportModeCapability);
	        this.sqlFileImport = this.convertValues(source["sqlFileImport"], DataImportModeCapability);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class DataSourceNavigationCapabilities {
	    primaryVisibilitySupported: boolean;
	    primaryKind: string;
	    secondarySchemaVisibilitySupported: boolean;
	    schemaIdentifierCaseSensitive: boolean;
	
	    static createFrom(source: any = {}) {
	        return new DataSourceNavigationCapabilities(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.primaryVisibilitySupported = source["primaryVisibilitySupported"];
	        this.primaryKind = source["primaryKind"];
	        this.secondarySchemaVisibilitySupported = source["secondarySchemaVisibilitySupported"];
	        this.schemaIdentifierCaseSensitive = source["schemaIdentifierCaseSensitive"];
	    }
	}
	export class DataSourceUICapabilities {
	    explainDiagnosis: boolean;
	    sqlQueryExport: boolean;
	    copyInsert: boolean;
	    copyTable: boolean;
	    createDatabase: boolean;
	    createDatabaseCharset: boolean;
	    renameDatabase: boolean;
	    dropDatabase: boolean;
	    messagePublish: boolean;
	    forceReadOnlyQueryResult: boolean;
	    forceReadOnlyStructureDesigner: boolean;
	    preferManualTotalCount: boolean;
	    supportsApproximateTableCount: boolean;
	    supportsApproximateTotalPages: boolean;
	
	    static createFrom(source: any = {}) {
	        return new DataSourceUICapabilities(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.explainDiagnosis = source["explainDiagnosis"];
	        this.sqlQueryExport = source["sqlQueryExport"];
	        this.copyInsert = source["copyInsert"];
	        this.copyTable = source["copyTable"];
	        this.createDatabase = source["createDatabase"];
	        this.createDatabaseCharset = source["createDatabaseCharset"];
	        this.renameDatabase = source["renameDatabase"];
	        this.dropDatabase = source["dropDatabase"];
	        this.messagePublish = source["messagePublish"];
	        this.forceReadOnlyQueryResult = source["forceReadOnlyQueryResult"];
	        this.forceReadOnlyStructureDesigner = source["forceReadOnlyStructureDesigner"];
	        this.preferManualTotalCount = source["preferManualTotalCount"];
	        this.supportsApproximateTableCount = source["supportsApproximateTableCount"];
	        this.supportsApproximateTotalPages = source["supportsApproximateTotalPages"];
	    }
	}
	export class DataSourceOperationCapability {
	    supported: boolean;
	    runtimeProbe?: boolean;
	    reason?: string;
	    alternative?: string;
	    messageKey?: string;
	
	    static createFrom(source: any = {}) {
	        return new DataSourceOperationCapability(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.supported = source["supported"];
	        this.runtimeProbe = source["runtimeProbe"];
	        this.reason = source["reason"];
	        this.alternative = source["alternative"];
	        this.messageKey = source["messageKey"];
	    }
	}
	export class DataSourceCapability {
	    databaseType: string;
	    query: DataSourceOperationCapability;
	    metadata: DataSourceOperationCapability;
	    transaction: DataSourceOperationCapability;
	    pagination: DataSourceOperationCapability;
	    cancel: DataSourceOperationCapability;
	    schema: DataSourceOperationCapability;
	    sampling: DataSourceOperationCapability;
	    streaming: DataSourceOperationCapability;
	    dangerousOperations: DataSourceOperationCapability;
	    ui: DataSourceUICapabilities;
	    navigation: DataSourceNavigationCapabilities;
	
	    static createFrom(source: any = {}) {
	        return new DataSourceCapability(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.databaseType = source["databaseType"];
	        this.query = this.convertValues(source["query"], DataSourceOperationCapability);
	        this.metadata = this.convertValues(source["metadata"], DataSourceOperationCapability);
	        this.transaction = this.convertValues(source["transaction"], DataSourceOperationCapability);
	        this.pagination = this.convertValues(source["pagination"], DataSourceOperationCapability);
	        this.cancel = this.convertValues(source["cancel"], DataSourceOperationCapability);
	        this.schema = this.convertValues(source["schema"], DataSourceOperationCapability);
	        this.sampling = this.convertValues(source["sampling"], DataSourceOperationCapability);
	        this.streaming = this.convertValues(source["streaming"], DataSourceOperationCapability);
	        this.dangerousOperations = this.convertValues(source["dangerousOperations"], DataSourceOperationCapability);
	        this.ui = this.convertValues(source["ui"], DataSourceUICapabilities);
	        this.navigation = this.convertValues(source["navigation"], DataSourceNavigationCapabilities);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	export class DownloadSourceConfig {
	    source: string;
	
	    static createFrom(source: any = {}) {
	        return new DownloadSourceConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source = source["source"];
	    }
	}
	export class ElasticsearchConsoleRequestResult {
	    index: number;
	    method: string;
	    path: string;
	    requestLabel: string;
	    httpStatus?: number;
	    durationMs: number;
	    rawResponse?: string;
	    contentType?: string;
	    rows?: any[];
	    columns?: string[];
	    affectedRows?: number;
	    outcome: string;
	    message?: string;
	    partialFailure?: boolean;
	    outcomeUnknown?: boolean;
	    readOnly: boolean;
	    serverMajor?: number;
	
	    static createFrom(source: any = {}) {
	        return new ElasticsearchConsoleRequestResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.method = source["method"];
	        this.path = source["path"];
	        this.requestLabel = source["requestLabel"];
	        this.httpStatus = source["httpStatus"];
	        this.durationMs = source["durationMs"];
	        this.rawResponse = source["rawResponse"];
	        this.contentType = source["contentType"];
	        this.rows = source["rows"];
	        this.columns = source["columns"];
	        this.affectedRows = source["affectedRows"];
	        this.outcome = source["outcome"];
	        this.message = source["message"];
	        this.partialFailure = source["partialFailure"];
	        this.outcomeUnknown = source["outcomeUnknown"];
	        this.readOnly = source["readOnly"];
	        this.serverMajor = source["serverMajor"];
	    }
	}
	export class ElasticsearchConsoleExecutionResult {
	    success: boolean;
	    status: string;
	    message?: string;
	    queryId: string;
	    fingerprint?: string;
	    results: ElasticsearchConsoleRequestResult[];
	    completed: number;
	    failedIndex?: number;
	    outcomeUnknown?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ElasticsearchConsoleExecutionResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.status = source["status"];
	        this.message = source["message"];
	        this.queryId = source["queryId"];
	        this.fingerprint = source["fingerprint"];
	        this.results = this.convertValues(source["results"], ElasticsearchConsoleRequestResult);
	        this.completed = source["completed"];
	        this.failedIndex = source["failedIndex"];
	        this.outcomeUnknown = source["outcomeUnknown"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ElasticsearchConsoleRequestInspection {
	    index: number;
	    method: string;
	    path: string;
	    route: string;
	    target?: string;
	    targetSummary?: string;
	    bodyKind: string;
	    bodyBytes: number;
	    bodySha256: string;
	    category: string;
	    risk: string;
	    containsScript?: boolean;
	    operationCount?: number;
	    blockReason?: string;
	
	    static createFrom(source: any = {}) {
	        return new ElasticsearchConsoleRequestInspection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.method = source["method"];
	        this.path = source["path"];
	        this.route = source["route"];
	        this.target = source["target"];
	        this.targetSummary = source["targetSummary"];
	        this.bodyKind = source["bodyKind"];
	        this.bodyBytes = source["bodyBytes"];
	        this.bodySha256 = source["bodySha256"];
	        this.category = source["category"];
	        this.risk = source["risk"];
	        this.containsScript = source["containsScript"];
	        this.operationCount = source["operationCount"];
	        this.blockReason = source["blockReason"];
	    }
	}
	export class ElasticsearchConsoleInspection {
	    success: boolean;
	    message?: string;
	    fingerprint?: string;
	    requests: ElasticsearchConsoleRequestInspection[];
	    containsWrite: boolean;
	    containsScript: boolean;
	    requiresConfirmation: boolean;
	    confirmationToken?: string;
	    blocked: boolean;
	    blockReason?: string;
	    serverMajor?: number;
	
	    static createFrom(source: any = {}) {
	        return new ElasticsearchConsoleInspection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.fingerprint = source["fingerprint"];
	        this.requests = this.convertValues(source["requests"], ElasticsearchConsoleRequestInspection);
	        this.containsWrite = source["containsWrite"];
	        this.containsScript = source["containsScript"];
	        this.requiresConfirmation = source["requiresConfirmation"];
	        this.confirmationToken = source["confirmationToken"];
	        this.blocked = source["blocked"];
	        this.blockReason = source["blockReason"];
	        this.serverMajor = source["serverMajor"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class ExportFileOptions {
	    format: string;
	    columns?: string[];
	    xlsxMaxRowsPerSheet?: number;
	    jobId?: string;
	    totalRowsHint?: number;
	    totalRowsKnown?: boolean;
	    includeDropIfExists?: boolean;
	    includeDatabaseContext?: boolean;
	    insertSQLDialect?: string;
	    insertSQLTargetTable?: string;
	    insertSQLColumnTypes?: Record<string, string>;
	    insertSQLTargetColumns?: Record<string, string>;
	    insertSQLAllowEmptyTargetTable?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ExportFileOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.format = source["format"];
	        this.columns = source["columns"];
	        this.xlsxMaxRowsPerSheet = source["xlsxMaxRowsPerSheet"];
	        this.jobId = source["jobId"];
	        this.totalRowsHint = source["totalRowsHint"];
	        this.totalRowsKnown = source["totalRowsKnown"];
	        this.includeDropIfExists = source["includeDropIfExists"];
	        this.includeDatabaseContext = source["includeDatabaseContext"];
	        this.insertSQLDialect = source["insertSQLDialect"];
	        this.insertSQLTargetTable = source["insertSQLTargetTable"];
	        this.insertSQLColumnTypes = source["insertSQLColumnTypes"];
	        this.insertSQLTargetColumns = source["insertSQLTargetColumns"];
	        this.insertSQLAllowEmptyTargetTable = source["insertSQLAllowEmptyTargetTable"];
	    }
	}
	export class ImportFileOptions {
	    columnMappings?: Record<string, string>;
	    jobId?: string;
	    continueOnError?: boolean;
	    encoding?: string;
	    delimiter?: string;
	    headerRow?: number;
	    nullToken?: string;
	    emptyStringAsNull?: boolean;
	    sheetName?: string;
	    sourceIdentityToken?: string;
	    conflictPolicy?: string;
	    conflictKeyColumns?: string[];
	    resumeJobId?: string;
	
	    static createFrom(source: any = {}) {
	        return new ImportFileOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.columnMappings = source["columnMappings"];
	        this.jobId = source["jobId"];
	        this.continueOnError = source["continueOnError"];
	        this.encoding = source["encoding"];
	        this.delimiter = source["delimiter"];
	        this.headerRow = source["headerRow"];
	        this.nullToken = source["nullToken"];
	        this.emptyStringAsNull = source["emptyStringAsNull"];
	        this.sheetName = source["sheetName"];
	        this.sourceIdentityToken = source["sourceIdentityToken"];
	        this.conflictPolicy = source["conflictPolicy"];
	        this.conflictKeyColumns = source["conflictKeyColumns"];
	        this.resumeJobId = source["resumeJobId"];
	    }
	}
	export class NacosConfigIdentity {
	    dataId: string;
	    group: string;
	    index?: number;
	
	    static createFrom(source: any = {}) {
	        return new NacosConfigIdentity(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dataId = source["dataId"];
	        this.group = source["group"];
	        this.index = source["index"];
	    }
	}
	export class NacosConfigQuery {
	    namespaceId: string;
	    dataId?: string;
	    group?: string;
	    appName?: string;
	    pageNo?: number;
	    pageSize?: number;
	    search?: string;
	
	    static createFrom(source: any = {}) {
	        return new NacosConfigQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.namespaceId = source["namespaceId"];
	        this.dataId = source["dataId"];
	        this.group = source["group"];
	        this.appName = source["appName"];
	        this.pageNo = source["pageNo"];
	        this.pageSize = source["pageSize"];
	        this.search = source["search"];
	    }
	}
	export class NacosCreateNamespacePayload {
	    id: string;
	    showName: string;
	    description?: string;
	
	    static createFrom(source: any = {}) {
	        return new NacosCreateNamespacePayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.showName = source["showName"];
	        this.description = source["description"];
	    }
	}
	export class NacosExportConfigsOptions {
	    namespaceId: string;
	    namespaceName?: string;
	    scope?: string;
	    items?: NacosConfigIdentity[];
	
	    static createFrom(source: any = {}) {
	        return new NacosExportConfigsOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.namespaceId = source["namespaceId"];
	        this.namespaceName = source["namespaceName"];
	        this.scope = source["scope"];
	        this.items = this.convertValues(source["items"], NacosConfigIdentity);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class NacosHistoryQuery {
	    namespaceId: string;
	    dataId: string;
	    group: string;
	    pageNo?: number;
	    pageSize?: number;
	
	    static createFrom(source: any = {}) {
	        return new NacosHistoryQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.namespaceId = source["namespaceId"];
	        this.dataId = source["dataId"];
	        this.group = source["group"];
	        this.pageNo = source["pageNo"];
	        this.pageSize = source["pageSize"];
	    }
	}
	export class NacosImportConfigsOptions {
	    namespaceId: string;
	    conflictMode?: string;
	    file?: string;
	    scope?: string;
	    items?: NacosConfigIdentity[];
	
	    static createFrom(source: any = {}) {
	        return new NacosImportConfigsOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.namespaceId = source["namespaceId"];
	        this.conflictMode = source["conflictMode"];
	        this.file = source["file"];
	        this.scope = source["scope"];
	        this.items = this.convertValues(source["items"], NacosConfigIdentity);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class NacosInstancePayload {
	    namespaceId: string;
	    serviceName: string;
	    groupName?: string;
	    ip: string;
	    port: number;
	    clusterName?: string;
	    weight?: number;
	    enabled?: boolean;
	    healthy?: boolean;
	    ephemeral?: boolean;
	    metadata?: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new NacosInstancePayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.namespaceId = source["namespaceId"];
	        this.serviceName = source["serviceName"];
	        this.groupName = source["groupName"];
	        this.ip = source["ip"];
	        this.port = source["port"];
	        this.clusterName = source["clusterName"];
	        this.weight = source["weight"];
	        this.enabled = source["enabled"];
	        this.healthy = source["healthy"];
	        this.ephemeral = source["ephemeral"];
	        this.metadata = source["metadata"];
	    }
	}
	export class NacosInstanceQuery {
	    namespaceId: string;
	    serviceName: string;
	    groupName?: string;
	    clusters?: string;
	    healthyOnly?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new NacosInstanceQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.namespaceId = source["namespaceId"];
	        this.serviceName = source["serviceName"];
	        this.groupName = source["groupName"];
	        this.clusters = source["clusters"];
	        this.healthyOnly = source["healthyOnly"];
	    }
	}
	export class NacosPublishConfigPayload {
	    namespaceId: string;
	    dataId: string;
	    group: string;
	    content: string;
	    type?: string;
	    appName?: string;
	    desc?: string;
	    betaIps?: string;
	
	    static createFrom(source: any = {}) {
	        return new NacosPublishConfigPayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.namespaceId = source["namespaceId"];
	        this.dataId = source["dataId"];
	        this.group = source["group"];
	        this.content = source["content"];
	        this.type = source["type"];
	        this.appName = source["appName"];
	        this.desc = source["desc"];
	        this.betaIps = source["betaIps"];
	    }
	}
	export class NacosServicePayload {
	    namespaceId: string;
	    serviceName: string;
	    groupName?: string;
	    ephemeral?: boolean;
	    protectThreshold?: number;
	    metadata?: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new NacosServicePayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.namespaceId = source["namespaceId"];
	        this.serviceName = source["serviceName"];
	        this.groupName = source["groupName"];
	        this.ephemeral = source["ephemeral"];
	        this.protectThreshold = source["protectThreshold"];
	        this.metadata = source["metadata"];
	    }
	}
	export class NacosServiceQuery {
	    namespaceId: string;
	    serviceName?: string;
	    groupName?: string;
	    pageNo?: number;
	    pageSize?: number;
	
	    static createFrom(source: any = {}) {
	        return new NacosServiceQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.namespaceId = source["namespaceId"];
	        this.serviceName = source["serviceName"];
	        this.groupName = source["groupName"];
	        this.pageNo = source["pageNo"];
	        this.pageSize = source["pageSize"];
	    }
	}
	export class NacosStartConfigListenPayload {
	    watchId?: string;
	    connectionId?: string;
	    namespaceId: string;
	    dataId: string;
	    group: string;
	    contentMd5?: string;
	
	    static createFrom(source: any = {}) {
	        return new NacosStartConfigListenPayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.watchId = source["watchId"];
	        this.connectionId = source["connectionId"];
	        this.namespaceId = source["namespaceId"];
	        this.dataId = source["dataId"];
	        this.group = source["group"];
	        this.contentMd5 = source["contentMd5"];
	    }
	}
	export class NacosUpdateNamespacePayload {
	    id: string;
	    showName: string;
	    description?: string;
	
	    static createFrom(source: any = {}) {
	        return new NacosUpdateNamespacePayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.showName = source["showName"];
	        this.description = source["description"];
	    }
	}
	export class RedisExportKeysOptions {
	    scope?: string;
	    keys?: string[];
	    pattern?: string;
	
	    static createFrom(source: any = {}) {
	        return new RedisExportKeysOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.scope = source["scope"];
	        this.keys = source["keys"];
	        this.pattern = source["pattern"];
	    }
	}
	export class RedisImportKeysOptions {
	    conflictMode?: string;
	    scope?: string;
	    keys?: string[];
	    file?: string;
	
	    static createFrom(source: any = {}) {
	        return new RedisImportKeysOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.conflictMode = source["conflictMode"];
	        this.scope = source["scope"];
	        this.keys = source["keys"];
	        this.file = source["file"];
	    }
	}
	export class RedisListPushOptions {
	    values: string[];
	    position: string;
	
	    static createFrom(source: any = {}) {
	        return new RedisListPushOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.values = source["values"];
	        this.position = source["position"];
	    }
	}
	export class SecurityUpdateOptions {
	    allowPartial?: boolean;
	    writeBackup?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SecurityUpdateOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.allowPartial = source["allowPartial"];
	        this.writeBackup = source["writeBackup"];
	    }
	}
	export class RestartSecurityUpdateRequest {
	    migrationId?: string;
	    sourceType: string;
	    rawPayload?: string;
	    options?: SecurityUpdateOptions;
	
	    static createFrom(source: any = {}) {
	        return new RestartSecurityUpdateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.migrationId = source["migrationId"];
	        this.sourceType = source["sourceType"];
	        this.rawPayload = source["rawPayload"];
	        this.options = this.convertValues(source["options"], SecurityUpdateOptions);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ResultDiffStartRequest {
	    jobId?: string;
	    config: connection.ConnectionConfig;
	    database: string;
	    left: resultdiff.DatasetSpec;
	    right: resultdiff.DatasetSpec;
	    keyColumns: string[];
	    compareColumns?: string[];
	    ignoreColumns?: string[];
	    options: resultdiff.CompareOptions;
	    maxRowsPerSide?: number;
	    includeSameRows?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ResultDiffStartRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.jobId = source["jobId"];
	        this.config = this.convertValues(source["config"], connection.ConnectionConfig);
	        this.database = source["database"];
	        this.left = this.convertValues(source["left"], resultdiff.DatasetSpec);
	        this.right = this.convertValues(source["right"], resultdiff.DatasetSpec);
	        this.keyColumns = source["keyColumns"];
	        this.compareColumns = source["compareColumns"];
	        this.ignoreColumns = source["ignoreColumns"];
	        this.options = this.convertValues(source["options"], resultdiff.CompareOptions);
	        this.maxRowsPerSide = source["maxRowsPerSide"];
	        this.includeSameRows = source["includeSameRows"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RetrySecurityUpdateRequest {
	    migrationId?: string;
	
	    static createFrom(source: any = {}) {
	        return new RetrySecurityUpdateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.migrationId = source["migrationId"];
	    }
	}
	export class SecurityUpdateIssue {
	    id: string;
	    scope: string;
	    refId?: string;
	    title: string;
	    severity: string;
	    status: string;
	    reasonCode: string;
	    action: string;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new SecurityUpdateIssue(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.scope = source["scope"];
	        this.refId = source["refId"];
	        this.title = source["title"];
	        this.severity = source["severity"];
	        this.status = source["status"];
	        this.reasonCode = source["reasonCode"];
	        this.action = source["action"];
	        this.message = source["message"];
	    }
	}
	
	export class SecurityUpdateSummary {
	    total: number;
	    updated: number;
	    pending: number;
	    skipped: number;
	    failed: number;
	
	    static createFrom(source: any = {}) {
	        return new SecurityUpdateSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total = source["total"];
	        this.updated = source["updated"];
	        this.pending = source["pending"];
	        this.skipped = source["skipped"];
	        this.failed = source["failed"];
	    }
	}
	export class SecurityUpdateStatus {
	    schemaVersion?: number;
	    migrationId?: string;
	    overallStatus: string;
	    sourceType?: string;
	    reminderVisible: boolean;
	    canStart: boolean;
	    canPostpone: boolean;
	    canRetry: boolean;
	    backupAvailable: boolean;
	    backupPath?: string;
	    startedAt?: string;
	    updatedAt?: string;
	    completedAt?: string;
	    postponedAt?: string;
	    summary: SecurityUpdateSummary;
	    issues: SecurityUpdateIssue[];
	    lastError?: string;
	
	    static createFrom(source: any = {}) {
	        return new SecurityUpdateStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schemaVersion = source["schemaVersion"];
	        this.migrationId = source["migrationId"];
	        this.overallStatus = source["overallStatus"];
	        this.sourceType = source["sourceType"];
	        this.reminderVisible = source["reminderVisible"];
	        this.canStart = source["canStart"];
	        this.canPostpone = source["canPostpone"];
	        this.canRetry = source["canRetry"];
	        this.backupAvailable = source["backupAvailable"];
	        this.backupPath = source["backupPath"];
	        this.startedAt = source["startedAt"];
	        this.updatedAt = source["updatedAt"];
	        this.completedAt = source["completedAt"];
	        this.postponedAt = source["postponedAt"];
	        this.summary = this.convertValues(source["summary"], SecurityUpdateSummary);
	        this.issues = this.convertValues(source["issues"], SecurityUpdateIssue);
	        this.lastError = source["lastError"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class StartSecurityUpdateRequest {
	    sourceType: string;
	    rawPayload?: string;
	    options?: SecurityUpdateOptions;
	
	    static createFrom(source: any = {}) {
	        return new StartSecurityUpdateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sourceType = source["sourceType"];
	        this.rawPayload = source["rawPayload"];
	        this.options = this.convertValues(source["options"], SecurityUpdateOptions);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace connection {
	
	export class UpdateRow {
	    keys: Record<string, any>;
	    values: Record<string, any>;
	
	    static createFrom(source: any = {}) {
	        return new UpdateRow(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.keys = source["keys"];
	        this.values = source["values"];
	    }
	}
	export class ChangeSet {
	    inserts: any[];
	    updates: UpdateRow[];
	    deletes: any[];
	    locatorStrategy?: string;
	
	    static createFrom(source: any = {}) {
	        return new ChangeSet(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.inserts = source["inserts"];
	        this.updates = this.convertValues(source["updates"], UpdateRow);
	        this.deletes = source["deletes"];
	        this.locatorStrategy = source["locatorStrategy"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class JVMDiagnosticConfig {
	    enabled?: boolean;
	    transport?: string;
	    baseUrl?: string;
	    targetId?: string;
	    apiKey?: string;
	    allowObserveCommands?: boolean;
	    allowTraceCommands?: boolean;
	    allowMutatingCommands?: boolean;
	    timeoutSeconds?: number;
	
	    static createFrom(source: any = {}) {
	        return new JVMDiagnosticConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.transport = source["transport"];
	        this.baseUrl = source["baseUrl"];
	        this.targetId = source["targetId"];
	        this.apiKey = source["apiKey"];
	        this.allowObserveCommands = source["allowObserveCommands"];
	        this.allowTraceCommands = source["allowTraceCommands"];
	        this.allowMutatingCommands = source["allowMutatingCommands"];
	        this.timeoutSeconds = source["timeoutSeconds"];
	    }
	}
	export class JVMAgentConfig {
	    enabled?: boolean;
	    baseUrl?: string;
	    apiKey?: string;
	    timeoutSeconds?: number;
	
	    static createFrom(source: any = {}) {
	        return new JVMAgentConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.baseUrl = source["baseUrl"];
	        this.apiKey = source["apiKey"];
	        this.timeoutSeconds = source["timeoutSeconds"];
	    }
	}
	export class JVMEndpointConfig {
	    enabled?: boolean;
	    baseUrl?: string;
	    apiKey?: string;
	    timeoutSeconds?: number;
	
	    static createFrom(source: any = {}) {
	        return new JVMEndpointConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.baseUrl = source["baseUrl"];
	        this.apiKey = source["apiKey"];
	        this.timeoutSeconds = source["timeoutSeconds"];
	    }
	}
	export class JVMJMXConfig {
	    enabled?: boolean;
	    host?: string;
	    port?: number;
	    username?: string;
	    password?: string;
	    domainAllowlist?: string[];
	
	    static createFrom(source: any = {}) {
	        return new JVMJMXConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.username = source["username"];
	        this.password = source["password"];
	        this.domainAllowlist = source["domainAllowlist"];
	    }
	}
	export class JVMConfig {
	    environment?: string;
	    readOnly?: boolean;
	    allowedModes?: string[];
	    preferredMode?: string;
	    jmx?: JVMJMXConfig;
	    endpoint?: JVMEndpointConfig;
	    agent?: JVMAgentConfig;
	    diagnostic?: JVMDiagnosticConfig;
	
	    static createFrom(source: any = {}) {
	        return new JVMConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.environment = source["environment"];
	        this.readOnly = source["readOnly"];
	        this.allowedModes = source["allowedModes"];
	        this.preferredMode = source["preferredMode"];
	        this.jmx = this.convertValues(source["jmx"], JVMJMXConfig);
	        this.endpoint = this.convertValues(source["endpoint"], JVMEndpointConfig);
	        this.agent = this.convertValues(source["agent"], JVMAgentConfig);
	        this.diagnostic = this.convertValues(source["diagnostic"], JVMDiagnosticConfig);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class HTTPTunnelConfig {
	    host: string;
	    port: number;
	    user?: string;
	    password?: string;
	
	    static createFrom(source: any = {}) {
	        return new HTTPTunnelConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.password = source["password"];
	    }
	}
	export class ProxyConfig {
	    type: string;
	    host: string;
	    port: number;
	    user?: string;
	    password?: string;
	
	    static createFrom(source: any = {}) {
	        return new ProxyConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.password = source["password"];
	    }
	}
	export class SSHConfig {
	    host: string;
	    port: number;
	    user: string;
	    password: string;
	    keyPath: string;
	    knownHostsPath?: string;
	    hostKeyFingerprint?: string;
	
	    static createFrom(source: any = {}) {
	        return new SSHConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.password = source["password"];
	        this.keyPath = source["keyPath"];
	        this.knownHostsPath = source["knownHostsPath"];
	        this.hostKeyFingerprint = source["hostKeyFingerprint"];
	    }
	}
	export class ConnectionProtectionConfig {
	    restrictDataEdit?: boolean;
	    restrictStructureEdit?: boolean;
	    restrictScriptExecution?: boolean;
	    restrictDataImport?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionProtectionConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.restrictDataEdit = source["restrictDataEdit"];
	        this.restrictStructureEdit = source["restrictStructureEdit"];
	        this.restrictScriptExecution = source["restrictScriptExecution"];
	        this.restrictDataImport = source["restrictDataImport"];
	    }
	}
	export class ConnectionConfig {
	    id?: string;
	    type: string;
	    host: string;
	    port: number;
	    user: string;
	    password: string;
	    savePassword?: boolean;
	    database: string;
	    readOnly?: boolean;
	    protection?: ConnectionProtectionConfig;
	    useSSL?: boolean;
	    sslMode?: string;
	    sslCAPath?: string;
	    sslCertPath?: string;
	    sslKeyPath?: string;
	    useSSH: boolean;
	    ssh: SSHConfig;
	    useProxy?: boolean;
	    proxy?: ProxyConfig;
	    useHttpTunnel?: boolean;
	    httpTunnel?: HTTPTunnelConfig;
	    driver?: string;
	    dsn?: string;
	    connectionParams?: string;
	    timeout?: number;
	    queryTimeout?: number;
	    keepAliveEnabled?: boolean;
	    keepAliveIntervalMinutes?: number;
	    keepAliveSQL?: string;
	    redisDB?: number;
	    redisSentinelMaster?: string;
	    redisSentinelUser?: string;
	    redisSentinelPassword?: string;
	    uri?: string;
	    clickHouseProtocol?: string;
	    oceanBaseProtocol?: string;
	    hosts?: string[];
	    topology?: string;
	    mysqlReplicaUser?: string;
	    mysqlReplicaPassword?: string;
	    replicaSet?: string;
	    authSource?: string;
	    readPreference?: string;
	    mongoSrv?: boolean;
	    mongoAuthMechanism?: string;
	    mongoReplicaUser?: string;
	    mongoReplicaPassword?: string;
	    jvm?: JVMConfig;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.type = source["type"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.password = source["password"];
	        this.savePassword = source["savePassword"];
	        this.database = source["database"];
	        this.readOnly = source["readOnly"];
	        this.protection = this.convertValues(source["protection"], ConnectionProtectionConfig);
	        this.useSSL = source["useSSL"];
	        this.sslMode = source["sslMode"];
	        this.sslCAPath = source["sslCAPath"];
	        this.sslCertPath = source["sslCertPath"];
	        this.sslKeyPath = source["sslKeyPath"];
	        this.useSSH = source["useSSH"];
	        this.ssh = this.convertValues(source["ssh"], SSHConfig);
	        this.useProxy = source["useProxy"];
	        this.proxy = this.convertValues(source["proxy"], ProxyConfig);
	        this.useHttpTunnel = source["useHttpTunnel"];
	        this.httpTunnel = this.convertValues(source["httpTunnel"], HTTPTunnelConfig);
	        this.driver = source["driver"];
	        this.dsn = source["dsn"];
	        this.connectionParams = source["connectionParams"];
	        this.timeout = source["timeout"];
	        this.queryTimeout = source["queryTimeout"];
	        this.keepAliveEnabled = source["keepAliveEnabled"];
	        this.keepAliveIntervalMinutes = source["keepAliveIntervalMinutes"];
	        this.keepAliveSQL = source["keepAliveSQL"];
	        this.redisDB = source["redisDB"];
	        this.redisSentinelMaster = source["redisSentinelMaster"];
	        this.redisSentinelUser = source["redisSentinelUser"];
	        this.redisSentinelPassword = source["redisSentinelPassword"];
	        this.uri = source["uri"];
	        this.clickHouseProtocol = source["clickHouseProtocol"];
	        this.oceanBaseProtocol = source["oceanBaseProtocol"];
	        this.hosts = source["hosts"];
	        this.topology = source["topology"];
	        this.mysqlReplicaUser = source["mysqlReplicaUser"];
	        this.mysqlReplicaPassword = source["mysqlReplicaPassword"];
	        this.replicaSet = source["replicaSet"];
	        this.authSource = source["authSource"];
	        this.readPreference = source["readPreference"];
	        this.mongoSrv = source["mongoSrv"];
	        this.mongoAuthMechanism = source["mongoAuthMechanism"];
	        this.mongoReplicaUser = source["mongoReplicaUser"];
	        this.mongoReplicaPassword = source["mongoReplicaPassword"];
	        this.jvm = this.convertValues(source["jvm"], JVMConfig);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ConnectionHealthCheck {
	    key: string;
	    status: string;
	    durationMs?: number;
	    detail?: string;
	    recommendation?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionHealthCheck(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.status = source["status"];
	        this.durationMs = source["durationMs"];
	        this.detail = source["detail"];
	        this.recommendation = source["recommendation"];
	    }
	}
	export class ConnectionHealthReport {
	    connectionId: string;
	    connectionName?: string;
	    connectionType?: string;
	    overallStatus: string;
	    durationMs: number;
	    checks: ConnectionHealthCheck[];
	
	    static createFrom(source: any = {}) {
	        return new ConnectionHealthReport(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connectionId = source["connectionId"];
	        this.connectionName = source["connectionName"];
	        this.connectionType = source["connectionType"];
	        this.overallStatus = source["overallStatus"];
	        this.durationMs = source["durationMs"];
	        this.checks = this.convertValues(source["checks"], ConnectionHealthCheck);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ConnectionHealthRun {
	    runId: string;
	    status: string;
	    total: number;
	    completed: number;
	    reports: ConnectionHealthReport[];
	    currentConnectionId?: string;
	    remainingConnectionIds: string[];
	    cancelRequested: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionHealthRun(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.runId = source["runId"];
	        this.status = source["status"];
	        this.total = source["total"];
	        this.completed = source["completed"];
	        this.reports = this.convertValues(source["reports"], ConnectionHealthReport);
	        this.currentConnectionId = source["currentConnectionId"];
	        this.remainingConnectionIds = source["remainingConnectionIds"];
	        this.cancelRequested = source["cancelRequested"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class ConnectionTag {
	    id: string;
	    name: string;
	    createdAt?: number;
	    parentTagId?: string;
	    connectionIds: string[];
	    childOrder?: string[];
	    sortMode?: string;
	    connectionSortMode?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionTag(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.createdAt = source["createdAt"];
	        this.parentTagId = source["parentTagId"];
	        this.connectionIds = source["connectionIds"];
	        this.childOrder = source["childOrder"];
	        this.sortMode = source["sortMode"];
	        this.connectionSortMode = source["connectionSortMode"];
	    }
	}
	export class ConnectionSidebarLayout {
	    initialized: boolean;
	    revision: number;
	    connectionTags: ConnectionTag[];
	    sidebarRootOrder: string[];
	    rootSortMode?: string;
	    rootConnectionSortMode?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionSidebarLayout(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.initialized = source["initialized"];
	        this.revision = source["revision"];
	        this.connectionTags = this.convertValues(source["connectionTags"], ConnectionTag);
	        this.sidebarRootOrder = source["sidebarRootOrder"];
	        this.rootSortMode = source["rootSortMode"];
	        this.rootConnectionSortMode = source["rootConnectionSortMode"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ConnectionSidebarLayoutInput {
	    connectionTags: ConnectionTag[];
	    sidebarRootOrder: string[];
	    rootSortMode?: string;
	    rootConnectionSortMode?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionSidebarLayoutInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connectionTags = this.convertValues(source["connectionTags"], ConnectionTag);
	        this.sidebarRootOrder = source["sidebarRootOrder"];
	        this.rootSortMode = source["rootSortMode"];
	        this.rootConnectionSortMode = source["rootConnectionSortMode"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class SchemaVisibilityRule {
	    mode: string;
	    schemas?: string[];
	
	    static createFrom(source: any = {}) {
	        return new SchemaVisibilityRule(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.mode = source["mode"];
	        this.schemas = source["schemas"];
	    }
	}
	export class ConnectionVisibilityInput {
	    id: string;
	    includeDatabases?: string[];
	    includeDatabasePatterns?: string[];
	    excludeDatabasePatterns?: string[];
	    includeRedisDatabases?: number[];
	    schemaVisibilityByDatabase?: Record<string, SchemaVisibilityRule>;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionVisibilityInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.includeDatabases = source["includeDatabases"];
	        this.includeDatabasePatterns = source["includeDatabasePatterns"];
	        this.excludeDatabasePatterns = source["excludeDatabasePatterns"];
	        this.includeRedisDatabases = source["includeRedisDatabases"];
	        this.schemaVisibilityByDatabase = this.convertValues(source["schemaVisibilityByDatabase"], SchemaVisibilityRule, true);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DeleteConnectionGroupInput {
	    tagId: string;
	    expectedRevision: number;
	
	    static createFrom(source: any = {}) {
	        return new DeleteConnectionGroupInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.tagId = source["tagId"];
	        this.expectedRevision = source["expectedRevision"];
	    }
	}
	export class GlobalProxyView {
	    enabled: boolean;
	    type: string;
	    host: string;
	    port: number;
	    user?: string;
	    password?: string;
	    hasPassword?: boolean;
	    secretRef?: string;
	
	    static createFrom(source: any = {}) {
	        return new GlobalProxyView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.type = source["type"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.password = source["password"];
	        this.hasPassword = source["hasPassword"];
	        this.secretRef = source["secretRef"];
	    }
	}
	
	
	
	
	
	
	
	export class QueryResult {
	    success: boolean;
	    message: string;
	    data: any;
	    fields?: string[];
	    messages?: string[];
	    partial?: boolean;
	    executedCount?: number;
	    failedIndex?: number;
	    boundaryMode?: string;
	    commitMode?: string;
	    warnings?: string[];
	    outcomeUnknown?: boolean;
	    failedObjectTypes?: string[];
	    retryable?: boolean;
	    truncated?: boolean;
	    scannedCount?: number;
	    queryId?: string;
	    cancellationState?: string;
	    transactionId?: string;
	    transactionPending?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new QueryResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.data = source["data"];
	        this.fields = source["fields"];
	        this.messages = source["messages"];
	        this.partial = source["partial"];
	        this.executedCount = source["executedCount"];
	        this.failedIndex = source["failedIndex"];
	        this.boundaryMode = source["boundaryMode"];
	        this.commitMode = source["commitMode"];
	        this.warnings = source["warnings"];
	        this.outcomeUnknown = source["outcomeUnknown"];
	        this.failedObjectTypes = source["failedObjectTypes"];
	        this.retryable = source["retryable"];
	        this.truncated = source["truncated"];
	        this.scannedCount = source["scannedCount"];
	        this.queryId = source["queryId"];
	        this.cancellationState = source["cancellationState"];
	        this.transactionId = source["transactionId"];
	        this.transactionPending = source["transactionPending"];
	    }
	}
	
	export class SaveConnectionSidebarLayoutInput {
	    expectedRevision: number;
	    layout: ConnectionSidebarLayoutInput;
	
	    static createFrom(source: any = {}) {
	        return new SaveConnectionSidebarLayoutInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.expectedRevision = source["expectedRevision"];
	        this.layout = this.convertValues(source["layout"], ConnectionSidebarLayoutInput);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SaveConnectionSidebarLayoutResult {
	    conflict: boolean;
	    layout: ConnectionSidebarLayout;
	
	    static createFrom(source: any = {}) {
	        return new SaveConnectionSidebarLayoutResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.conflict = source["conflict"];
	        this.layout = this.convertValues(source["layout"], ConnectionSidebarLayout);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SaveGlobalProxyInput {
	    enabled: boolean;
	    type: string;
	    host: string;
	    port: number;
	    user?: string;
	    password?: string;
	    clearPassword?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SaveGlobalProxyInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.type = source["type"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.password = source["password"];
	        this.clearPassword = source["clearPassword"];
	    }
	}
	export class SavedConnectionInput {
	    id?: string;
	    name: string;
	    createdAt?: number;
	    environmentType?: string;
	    config: ConnectionConfig;
	    includeDatabases?: string[];
	    includeDatabasePatterns?: string[];
	    excludeDatabasePatterns?: string[];
	    includeRedisDatabases?: number[];
	    schemaVisibilityByDatabase?: Record<string, SchemaVisibilityRule>;
	    iconType?: string;
	    iconColor?: string;
	    clearPrimaryPassword?: boolean;
	    clearSSHPassword?: boolean;
	    clearProxyPassword?: boolean;
	    clearHttpTunnelPassword?: boolean;
	    clearMySQLReplicaPassword?: boolean;
	    clearMongoReplicaPassword?: boolean;
	    clearRedisSentinelPassword?: boolean;
	    clearOpaqueURI?: boolean;
	    clearOpaqueDSN?: boolean;
	    clearJVMJMXPassword?: boolean;
	    clearJVMEndpointAPIKey?: boolean;
	    clearJVMAgentAPIKey?: boolean;
	    clearJVMDiagnosticAPIKey?: boolean;
	    clearSensitiveConnectionParams?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SavedConnectionInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.createdAt = source["createdAt"];
	        this.environmentType = source["environmentType"];
	        this.config = this.convertValues(source["config"], ConnectionConfig);
	        this.includeDatabases = source["includeDatabases"];
	        this.includeDatabasePatterns = source["includeDatabasePatterns"];
	        this.excludeDatabasePatterns = source["excludeDatabasePatterns"];
	        this.includeRedisDatabases = source["includeRedisDatabases"];
	        this.schemaVisibilityByDatabase = this.convertValues(source["schemaVisibilityByDatabase"], SchemaVisibilityRule, true);
	        this.iconType = source["iconType"];
	        this.iconColor = source["iconColor"];
	        this.clearPrimaryPassword = source["clearPrimaryPassword"];
	        this.clearSSHPassword = source["clearSSHPassword"];
	        this.clearProxyPassword = source["clearProxyPassword"];
	        this.clearHttpTunnelPassword = source["clearHttpTunnelPassword"];
	        this.clearMySQLReplicaPassword = source["clearMySQLReplicaPassword"];
	        this.clearMongoReplicaPassword = source["clearMongoReplicaPassword"];
	        this.clearRedisSentinelPassword = source["clearRedisSentinelPassword"];
	        this.clearOpaqueURI = source["clearOpaqueURI"];
	        this.clearOpaqueDSN = source["clearOpaqueDSN"];
	        this.clearJVMJMXPassword = source["clearJVMJMXPassword"];
	        this.clearJVMEndpointAPIKey = source["clearJVMEndpointAPIKey"];
	        this.clearJVMAgentAPIKey = source["clearJVMAgentAPIKey"];
	        this.clearJVMDiagnosticAPIKey = source["clearJVMDiagnosticAPIKey"];
	        this.clearSensitiveConnectionParams = source["clearSensitiveConnectionParams"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SavedConnectionView {
	    id: string;
	    name: string;
	    createdAt?: number;
	    environmentType?: string;
	    config: ConnectionConfig;
	    includeDatabases?: string[];
	    includeDatabasePatterns?: string[];
	    excludeDatabasePatterns?: string[];
	    includeRedisDatabases?: number[];
	    schemaVisibilityByDatabase?: Record<string, SchemaVisibilityRule>;
	    iconType?: string;
	    iconColor?: string;
	    secretRef?: string;
	    hasPrimaryPassword?: boolean;
	    hasSSHPassword?: boolean;
	    hasProxyPassword?: boolean;
	    hasHttpTunnelPassword?: boolean;
	    hasMySQLReplicaPassword?: boolean;
	    hasMongoReplicaPassword?: boolean;
	    hasRedisSentinelPassword?: boolean;
	    hasOpaqueURI?: boolean;
	    hasOpaqueDSN?: boolean;
	    hasJVMJMXPassword?: boolean;
	    hasJVMEndpointAPIKey?: boolean;
	    hasJVMAgentAPIKey?: boolean;
	    hasJVMDiagnosticAPIKey?: boolean;
	    hasSensitiveConnectionParams?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SavedConnectionView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.createdAt = source["createdAt"];
	        this.environmentType = source["environmentType"];
	        this.config = this.convertValues(source["config"], ConnectionConfig);
	        this.includeDatabases = source["includeDatabases"];
	        this.includeDatabasePatterns = source["includeDatabasePatterns"];
	        this.excludeDatabasePatterns = source["excludeDatabasePatterns"];
	        this.includeRedisDatabases = source["includeRedisDatabases"];
	        this.schemaVisibilityByDatabase = this.convertValues(source["schemaVisibilityByDatabase"], SchemaVisibilityRule, true);
	        this.iconType = source["iconType"];
	        this.iconColor = source["iconColor"];
	        this.secretRef = source["secretRef"];
	        this.hasPrimaryPassword = source["hasPrimaryPassword"];
	        this.hasSSHPassword = source["hasSSHPassword"];
	        this.hasProxyPassword = source["hasProxyPassword"];
	        this.hasHttpTunnelPassword = source["hasHttpTunnelPassword"];
	        this.hasMySQLReplicaPassword = source["hasMySQLReplicaPassword"];
	        this.hasMongoReplicaPassword = source["hasMongoReplicaPassword"];
	        this.hasRedisSentinelPassword = source["hasRedisSentinelPassword"];
	        this.hasOpaqueURI = source["hasOpaqueURI"];
	        this.hasOpaqueDSN = source["hasOpaqueDSN"];
	        this.hasJVMJMXPassword = source["hasJVMJMXPassword"];
	        this.hasJVMEndpointAPIKey = source["hasJVMEndpointAPIKey"];
	        this.hasJVMAgentAPIKey = source["hasJVMAgentAPIKey"];
	        this.hasJVMDiagnosticAPIKey = source["hasJVMDiagnosticAPIKey"];
	        this.hasSensitiveConnectionParams = source["hasSensitiveConnectionParams"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SavedQuery {
	    id: string;
	    name: string;
	    sql: string;
	    connectionId: string;
	    dbName: string;
	    createdAt: number;
	    connectionFingerprint?: string;
	    fingerprintVersion?: string;
	    bindingStatus?: string;
	    originalConnectionId?: string;
	
	    static createFrom(source: any = {}) {
	        return new SavedQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.sql = source["sql"];
	        this.connectionId = source["connectionId"];
	        this.dbName = source["dbName"];
	        this.createdAt = source["createdAt"];
	        this.connectionFingerprint = source["connectionFingerprint"];
	        this.fingerprintVersion = source["fingerprintVersion"];
	        this.bindingStatus = source["bindingStatus"];
	        this.originalConnectionId = source["originalConnectionId"];
	    }
	}
	export class SavedQueryGroup {
	    id: string;
	    name: string;
	    parentGroupId: string;
	    queryIds: string[];
	    childOrder: string[];
	
	    static createFrom(source: any = {}) {
	        return new SavedQueryGroup(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.parentGroupId = source["parentGroupId"];
	        this.queryIds = source["queryIds"];
	        this.childOrder = source["childOrder"];
	    }
	}
	export class SavedQueryImportPayload {
	    queries: SavedQuery[];
	    groups?: SavedQueryGroup[];
	    legacyConnections?: SavedConnectionInput[];
	
	    static createFrom(source: any = {}) {
	        return new SavedQueryImportPayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.queries = this.convertValues(source["queries"], SavedQuery);
	        this.groups = this.convertValues(source["groups"], SavedQueryGroup);
	        this.legacyConnections = this.convertValues(source["legacyConnections"], SavedConnectionInput);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class TestGlobalProxyInput {
	    proxy: SaveGlobalProxyInput;
	    url: string;
	    timeoutSeconds?: number;
	
	    static createFrom(source: any = {}) {
	        return new TestGlobalProxyInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.proxy = this.convertValues(source["proxy"], SaveGlobalProxyInput);
	        this.url = source["url"];
	        this.timeoutSeconds = source["timeoutSeconds"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace jvm {
	
	export class ChangeRequest {
	    providerMode: string;
	    resourceId: string;
	    action: string;
	    reason: string;
	    source?: string;
	    expectedVersion?: string;
	    confirmationToken?: string;
	    payload?: Record<string, any>;
	
	    static createFrom(source: any = {}) {
	        return new ChangeRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.providerMode = source["providerMode"];
	        this.resourceId = source["resourceId"];
	        this.action = source["action"];
	        this.reason = source["reason"];
	        this.source = source["source"];
	        this.expectedVersion = source["expectedVersion"];
	        this.confirmationToken = source["confirmationToken"];
	        this.payload = source["payload"];
	    }
	}
	export class DiagnosticCommandRequest {
	    sessionId: string;
	    commandId: string;
	    command: string;
	    source?: string;
	    reason?: string;
	
	    static createFrom(source: any = {}) {
	        return new DiagnosticCommandRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessionId = source["sessionId"];
	        this.commandId = source["commandId"];
	        this.command = source["command"];
	        this.source = source["source"];
	        this.reason = source["reason"];
	    }
	}
	export class DiagnosticSessionRequest {
	    title?: string;
	    reason?: string;
	
	    static createFrom(source: any = {}) {
	        return new DiagnosticSessionRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.title = source["title"];
	        this.reason = source["reason"];
	    }
	}

}

export namespace nativewindow {
	
	export class HostStateRequest {
	    id: string;
	    revision: number;
	    storeState: Record<string, any>;
	
	    static createFrom(source: any = {}) {
	        return new HostStateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.revision = source["revision"];
	        this.storeState = source["storeState"];
	    }
	}
	export class OpenRequest {
	    id?: string;
	    kind: string;
	    title: string;
	    payload?: any;
	    x: number;
	    y: number;
	    width: number;
	    height: number;
	
	    static createFrom(source: any = {}) {
	        return new OpenRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.kind = source["kind"];
	        this.title = source["title"];
	        this.payload = source["payload"];
	        this.x = source["x"];
	        this.y = source["y"];
	        this.width = source["width"];
	        this.height = source["height"];
	    }
	}
	export class WindowBounds {
	    x: number;
	    y: number;
	    width: number;
	    height: number;
	
	    static createFrom(source: any = {}) {
	        return new WindowBounds(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.x = source["x"];
	        this.y = source["y"];
	        this.width = source["width"];
	        this.height = source["height"];
	    }
	}
	export class OperationResult {
	    success: boolean;
	    message?: string;
	    id?: string;
	    bounds?: WindowBounds;
	    visibilityRevision?: number;
	    applied?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new OperationResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.id = source["id"];
	        this.bounds = this.convertValues(source["bounds"], WindowBounds);
	        this.visibilityRevision = source["visibilityRevision"];
	        this.applied = source["applied"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class WindowInfo {
	    id: string;
	    kind: string;
	    title: string;
	    x: number;
	    y: number;
	    width: number;
	    height: number;
	    pid?: number;
	    openedAt: number;
	    ready: boolean;
	    closeSent: boolean;
	    hidden?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new WindowInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.kind = source["kind"];
	        this.title = source["title"];
	        this.x = source["x"];
	        this.y = source["y"];
	        this.width = source["width"];
	        this.height = source["height"];
	        this.pid = source["pid"];
	        this.openedAt = source["openedAt"];
	        this.ready = source["ready"];
	        this.closeSent = source["closeSent"];
	        this.hidden = source["hidden"];
	    }
	}

}

export namespace redis {
	
	export class ZSetMember {
	    member: string;
	    score: number;
	
	    static createFrom(source: any = {}) {
	        return new ZSetMember(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.member = source["member"];
	        this.score = source["score"];
	    }
	}

}

export namespace requesttrace {
	
	export class Filter {
	    requestId?: string;
	    entry?: string;
	    limit?: number;
	
	    static createFrom(source: any = {}) {
	        return new Filter(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.requestId = source["requestId"];
	        this.entry = source["entry"];
	        this.limit = source["limit"];
	    }
	}

}

export namespace resultdiff {
	
	export class CompareOptions {
	    trimStrings: boolean;
	    ignoreCase: boolean;
	    nullEqualsEmpty: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CompareOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.trimStrings = source["trimStrings"];
	        this.ignoreCase = source["ignoreCase"];
	        this.nullEqualsEmpty = source["nullEqualsEmpty"];
	    }
	}
	export class DatasetSpec {
	    mode: string;
	    sql?: string;
	    columns?: string[];
	    rows?: any[];
	
	    static createFrom(source: any = {}) {
	        return new DatasetSpec(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.mode = source["mode"];
	        this.sql = source["sql"];
	        this.columns = source["columns"];
	        this.rows = source["rows"];
	    }
	}
	export class PageRequest {
	    jobId: string;
	    kinds?: string[];
	    changedColumn?: string;
	    offset: number;
	    limit: number;
	    includeSameRows?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PageRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.jobId = source["jobId"];
	        this.kinds = source["kinds"];
	        this.changedColumn = source["changedColumn"];
	        this.offset = source["offset"];
	        this.limit = source["limit"];
	        this.includeSameRows = source["includeSameRows"];
	    }
	}
	export class UploadChunkRequest {
	    jobId: string;
	    side: string;
	    columns?: string[];
	    rows: any[];
	    done: boolean;
	
	    static createFrom(source: any = {}) {
	        return new UploadChunkRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.jobId = source["jobId"];
	        this.side = source["side"];
	        this.columns = source["columns"];
	        this.rows = source["rows"];
	        this.done = source["done"];
	    }
	}

}

export namespace runharness {
	
	export class AgentInputReceipt {
	    requestId: string;
	    sessionId: string;
	    runId: string;
	    disposition: string;
	    revision: number;
	    state: string;
	
	    static createFrom(source: any = {}) {
	        return new AgentInputReceipt(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.requestId = source["requestId"];
	        this.sessionId = source["sessionId"];
	        this.runId = source["runId"];
	        this.disposition = source["disposition"];
	        this.revision = source["revision"];
	        this.state = source["state"];
	    }
	}
	export class Attachment {
	    name?: string;
	    mediaType?: string;
	    data?: string;
	
	    static createFrom(source: any = {}) {
	        return new Attachment(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.mediaType = source["mediaType"];
	        this.data = source["data"];
	    }
	}
	export class AgentInputRequest {
	    requestId: string;
	    sessionId?: string;
	    branchFromMessageId?: string;
	    content: string;
	    attachments?: Attachment[];
	    dispatchMode?: string;
	    contextSourceId?: string;
	    contextSourceInstanceId?: string;
	    provider?: string;
	    model?: string;
	    thinking?: string;
	    temperature?: number;
	    maxTokens?: number;
	    taskKind?: string;
	    allowTools?: boolean;
	    expectedRevision?: number;
	
	    static createFrom(source: any = {}) {
	        return new AgentInputRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.requestId = source["requestId"];
	        this.sessionId = source["sessionId"];
	        this.branchFromMessageId = source["branchFromMessageId"];
	        this.content = source["content"];
	        this.attachments = this.convertValues(source["attachments"], Attachment);
	        this.dispatchMode = source["dispatchMode"];
	        this.contextSourceId = source["contextSourceId"];
	        this.contextSourceInstanceId = source["contextSourceInstanceId"];
	        this.provider = source["provider"];
	        this.model = source["model"];
	        this.thinking = source["thinking"];
	        this.temperature = source["temperature"];
	        this.maxTokens = source["maxTokens"];
	        this.taskKind = source["taskKind"];
	        this.allowTools = source["allowTools"];
	        this.expectedRevision = source["expectedRevision"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class CLIWorkspaceContext {
	    cwd?: string;
	    contextFiles?: string[];
	    connectionId?: string;
	    database?: string;
	    command?: string;
	
	    static createFrom(source: any = {}) {
	        return new CLIWorkspaceContext(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cwd = source["cwd"];
	        this.contextFiles = source["contextFiles"];
	        this.connectionId = source["connectionId"];
	        this.database = source["database"];
	        this.command = source["command"];
	    }
	}
	export class LedgerStatus {
	    state: string;
	    message?: string;
	
	    static createFrom(source: any = {}) {
	        return new LedgerStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.state = source["state"];
	        this.message = source["message"];
	    }
	}
	export class Message {
	    id: string;
	    sessionId: string;
	    runId?: string;
	    sequence: number;
	    role: string;
	    content: string;
	    images?: string[];
	    attachments?: Attachment[];
	    reasoning?: string;
	    toolCallId?: string;
	    toolCalls?: number[];
	    metadata?: number[];
	    // Go type: time
	    createdAt: any;
	
	    static createFrom(source: any = {}) {
	        return new Message(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.sessionId = source["sessionId"];
	        this.runId = source["runId"];
	        this.sequence = source["sequence"];
	        this.role = source["role"];
	        this.content = source["content"];
	        this.images = source["images"];
	        this.attachments = this.convertValues(source["attachments"], Attachment);
	        this.reasoning = source["reasoning"];
	        this.toolCallId = source["toolCallId"];
	        this.toolCalls = source["toolCalls"];
	        this.metadata = source["metadata"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RunControlRequest {
	    requestId: string;
	    runId: string;
	    sessionId?: string;
	    action: string;
	    callId?: string;
	    approvalId?: string;
	    argsHash?: string;
	    content?: string;
	    expectedRevision?: number;
	
	    static createFrom(source: any = {}) {
	        return new RunControlRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.requestId = source["requestId"];
	        this.runId = source["runId"];
	        this.sessionId = source["sessionId"];
	        this.action = source["action"];
	        this.callId = source["callId"];
	        this.approvalId = source["approvalId"];
	        this.argsHash = source["argsHash"];
	        this.content = source["content"];
	        this.expectedRevision = source["expectedRevision"];
	    }
	}
	export class RunEvent {
	    schemaVersion: number;
	    runId: string;
	    sessionId: string;
	    sessionGeneration: number;
	    sequence: number;
	    runRevision: number;
	    attempt: number;
	    // Go type: time
	    timestamp: any;
	    kind: string;
	    resultingState: string;
	    payload?: number[];
	
	    static createFrom(source: any = {}) {
	        return new RunEvent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schemaVersion = source["schemaVersion"];
	        this.runId = source["runId"];
	        this.sessionId = source["sessionId"];
	        this.sessionGeneration = source["sessionGeneration"];
	        this.sequence = source["sequence"];
	        this.runRevision = source["runRevision"];
	        this.attempt = source["attempt"];
	        this.timestamp = this.convertValues(source["timestamp"], null);
	        this.kind = source["kind"];
	        this.resultingState = source["resultingState"];
	        this.payload = source["payload"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RunPolicy {
	    defaultDispatchMode: string;
	    softToolRoundLimit: number;
	    maxToolRounds: number;
	    maxConsecutiveFailedToolRounds: number;
	    maxToolNudges: number;
	    maxModelRetriesPerTurn: number;
	    maxActiveDuration: number;
	    modelTurnTimeout: number;
	    modelIdleTimeout: number;
	    defaultToolTimeout: number;
	    maxTotalTokens: number;
	    maxToolResultBytes: number;
	
	    static createFrom(source: any = {}) {
	        return new RunPolicy(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.defaultDispatchMode = source["defaultDispatchMode"];
	        this.softToolRoundLimit = source["softToolRoundLimit"];
	        this.maxToolRounds = source["maxToolRounds"];
	        this.maxConsecutiveFailedToolRounds = source["maxConsecutiveFailedToolRounds"];
	        this.maxToolNudges = source["maxToolNudges"];
	        this.maxModelRetriesPerTurn = source["maxModelRetriesPerTurn"];
	        this.maxActiveDuration = source["maxActiveDuration"];
	        this.modelTurnTimeout = source["modelTurnTimeout"];
	        this.modelIdleTimeout = source["modelIdleTimeout"];
	        this.defaultToolTimeout = source["defaultToolTimeout"];
	        this.maxTotalTokens = source["maxTotalTokens"];
	        this.maxToolResultBytes = source["maxToolResultBytes"];
	    }
	}
	export class RunRuntimeConfig {
	    controlPollInterval: number;
	    workspaceSnapshotRenewInterval: number;
	    workspaceSnapshotLeaseDuration: number;
	    policyWatchInterval: number;
	
	    static createFrom(source: any = {}) {
	        return new RunRuntimeConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.controlPollInterval = source["controlPollInterval"];
	        this.workspaceSnapshotRenewInterval = source["workspaceSnapshotRenewInterval"];
	        this.workspaceSnapshotLeaseDuration = source["workspaceSnapshotLeaseDuration"];
	        this.policyWatchInterval = source["policyWatchInterval"];
	    }
	}
	export class RunPolicyMutationRequest {
	    expectedRevision: number;
	    policy: RunPolicy;
	    runtime: RunRuntimeConfig;
	
	    static createFrom(source: any = {}) {
	        return new RunPolicyMutationRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.expectedRevision = source["expectedRevision"];
	        this.policy = this.convertValues(source["policy"], RunPolicy);
	        this.runtime = this.convertValues(source["runtime"], RunRuntimeConfig);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RunPolicySnapshot {
	    schemaVersion: number;
	    revision: number;
	    policy: RunPolicy;
	    runtime: RunRuntimeConfig;
	
	    static createFrom(source: any = {}) {
	        return new RunPolicySnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schemaVersion = source["schemaVersion"];
	        this.revision = source["revision"];
	        this.policy = this.convertValues(source["policy"], RunPolicy);
	        this.runtime = this.convertValues(source["runtime"], RunRuntimeConfig);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RunReadRequest {
	    runId: string;
	    afterSequence?: number;
	    limit?: number;
	
	    static createFrom(source: any = {}) {
	        return new RunReadRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.runId = source["runId"];
	        this.afterSequence = source["afterSequence"];
	        this.limit = source["limit"];
	    }
	}
	export class RunSnapshot {
	    runId: string;
	    sessionId: string;
	    requestId?: string;
	    sessionGeneration: number;
	    state: string;
	    revision: number;
	    attempt: number;
	    nextSequence: number;
	    // Go type: time
	    ownerExpiresAt?: any;
	    checkpointId?: string;
	    terminalReason?: string;
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    updatedAt: any;
	    activeDurationMs: number;
	    policy: RunPolicy;
	    provider?: string;
	    model?: string;
	    thinking?: string;
	    temperature?: number;
	    maxTokens?: number;
	    taskKind: string;
	    allowTools: boolean;
	    contextSourceId?: string;
	    contextSourceInstanceId?: string;
	    toolCatalogHash?: string;
	    toolCatalogRevision?: number;
	    promptTokens: number;
	    completionTokens: number;
	    totalTokens: number;
	    reservedTokens: number;
	
	    static createFrom(source: any = {}) {
	        return new RunSnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.runId = source["runId"];
	        this.sessionId = source["sessionId"];
	        this.requestId = source["requestId"];
	        this.sessionGeneration = source["sessionGeneration"];
	        this.state = source["state"];
	        this.revision = source["revision"];
	        this.attempt = source["attempt"];
	        this.nextSequence = source["nextSequence"];
	        this.ownerExpiresAt = this.convertValues(source["ownerExpiresAt"], null);
	        this.checkpointId = source["checkpointId"];
	        this.terminalReason = source["terminalReason"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.updatedAt = this.convertValues(source["updatedAt"], null);
	        this.activeDurationMs = source["activeDurationMs"];
	        this.policy = this.convertValues(source["policy"], RunPolicy);
	        this.provider = source["provider"];
	        this.model = source["model"];
	        this.thinking = source["thinking"];
	        this.temperature = source["temperature"];
	        this.maxTokens = source["maxTokens"];
	        this.taskKind = source["taskKind"];
	        this.allowTools = source["allowTools"];
	        this.contextSourceId = source["contextSourceId"];
	        this.contextSourceInstanceId = source["contextSourceInstanceId"];
	        this.toolCatalogHash = source["toolCatalogHash"];
	        this.toolCatalogRevision = source["toolCatalogRevision"];
	        this.promptTokens = source["promptTokens"];
	        this.completionTokens = source["completionTokens"];
	        this.totalTokens = source["totalTokens"];
	        this.reservedTokens = source["reservedTokens"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RunReadResult {
	    run: RunSnapshot;
	    events: RunEvent[];
	    nextSequence: number;
	    hasMore: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RunReadResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.run = this.convertValues(source["run"], RunSnapshot);
	        this.events = this.convertValues(source["events"], RunEvent);
	        this.nextSequence = source["nextSequence"];
	        this.hasMore = source["hasMore"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class SessionListRequest {
	    limit?: number;
	    offset?: number;
	    activeOnly?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SessionListRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.limit = source["limit"];
	        this.offset = source["offset"];
	        this.activeOnly = source["activeOnly"];
	    }
	}
	export class SessionProjection {
	    sessionId: string;
	    title?: string;
	    revision: number;
	    generation: number;
	    parentSessionId?: string;
	    branchFromMessageId?: string;
	    branchFromSequence?: number;
	    archived: boolean;
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    updatedAt: any;
	    runs?: RunSnapshot[];
	    messages?: Message[];
	
	    static createFrom(source: any = {}) {
	        return new SessionProjection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessionId = source["sessionId"];
	        this.title = source["title"];
	        this.revision = source["revision"];
	        this.generation = source["generation"];
	        this.parentSessionId = source["parentSessionId"];
	        this.branchFromMessageId = source["branchFromMessageId"];
	        this.branchFromSequence = source["branchFromSequence"];
	        this.archived = source["archived"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.updatedAt = this.convertValues(source["updatedAt"], null);
	        this.runs = this.convertValues(source["runs"], RunSnapshot);
	        this.messages = this.convertValues(source["messages"], Message);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SessionListResult {
	    sessions: SessionProjection[];
	    total: number;
	
	    static createFrom(source: any = {}) {
	        return new SessionListResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessions = this.convertValues(source["sessions"], SessionProjection);
	        this.total = source["total"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SessionMutationRequest {
	    sessionId: string;
	    expectedRevision?: number;
	    title?: string;
	    archived?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SessionMutationRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessionId = source["sessionId"];
	        this.expectedRevision = source["expectedRevision"];
	        this.title = source["title"];
	        this.archived = source["archived"];
	    }
	}
	
	export class SessionReadRequest {
	    sessionId: string;
	    afterSequence?: number;
	    limit?: number;
	
	    static createFrom(source: any = {}) {
	        return new SessionReadRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessionId = source["sessionId"];
	        this.afterSequence = source["afterSequence"];
	        this.limit = source["limit"];
	    }
	}
	export class SnapshotAck {
	    sourceId: string;
	    sourceInstanceId: string;
	    revision: number;
	    contentHash: string;
	    accepted: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SnapshotAck(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sourceId = source["sourceId"];
	        this.sourceInstanceId = source["sourceInstanceId"];
	        this.revision = source["revision"];
	        this.contentHash = source["contentHash"];
	        this.accepted = source["accepted"];
	    }
	}
	export class WorkspaceQuery {
	    id?: string;
	    name?: string;
	    content?: string;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.content = source["content"];
	    }
	}
	export class WorkspaceSQLActivity {
	    id?: string;
	    statement?: string;
	    status?: string;
	    // Go type: time
	    createdAt?: any;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceSQLActivity(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.statement = source["statement"];
	        this.status = source["status"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class WorkspaceTab {
	    id: string;
	    title?: string;
	    kind?: string;
	    connectionId?: string;
	    database?: string;
	    object?: string;
	    draft?: string;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceTab(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.kind = source["kind"];
	        this.connectionId = source["connectionId"];
	        this.database = source["database"];
	        this.object = source["object"];
	        this.draft = source["draft"];
	    }
	}
	export class WorkspaceSnapshot {
	    schemaVersion: number;
	    sourceKind: string;
	    sourceId: string;
	    sourceInstanceId: string;
	    revision: number;
	    // Go type: time
	    capturedAt: any;
	    contentHash: string;
	    activeContext?: Record<string, any>;
	    tabs?: WorkspaceTab[];
	    activeTabId?: string;
	    sqlActivity?: WorkspaceSQLActivity[];
	    savedQueries?: WorkspaceQuery[];
	    snippets?: WorkspaceQuery[];
	    externalSqlDirectories?: string[];
	    shortcuts?: Record<string, string>;
	    transactionState?: Record<string, any>;
	    diagnostics?: Record<string, any>;
	    cliContext?: CLIWorkspaceContext;
	    capabilities?: Record<string, boolean>;
	    availability?: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceSnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schemaVersion = source["schemaVersion"];
	        this.sourceKind = source["sourceKind"];
	        this.sourceId = source["sourceId"];
	        this.sourceInstanceId = source["sourceInstanceId"];
	        this.revision = source["revision"];
	        this.capturedAt = this.convertValues(source["capturedAt"], null);
	        this.contentHash = source["contentHash"];
	        this.activeContext = source["activeContext"];
	        this.tabs = this.convertValues(source["tabs"], WorkspaceTab);
	        this.activeTabId = source["activeTabId"];
	        this.sqlActivity = this.convertValues(source["sqlActivity"], WorkspaceSQLActivity);
	        this.savedQueries = this.convertValues(source["savedQueries"], WorkspaceQuery);
	        this.snippets = this.convertValues(source["snippets"], WorkspaceQuery);
	        this.externalSqlDirectories = source["externalSqlDirectories"];
	        this.shortcuts = source["shortcuts"];
	        this.transactionState = source["transactionState"];
	        this.diagnostics = source["diagnostics"];
	        this.cliContext = this.convertValues(source["cliContext"], CLIWorkspaceContext);
	        this.capabilities = source["capabilities"];
	        this.availability = source["availability"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace sqlaudit {
	
	export class Filter {
	    search: string;
	    connectionId: string;
	    database: string;
	    dbType: string;
	    eventType: string;
	    status: string;
	    transactionId: string;
	    source: string;
	    fromTimestamp: number;
	    toTimestamp: number;
	    executionHistory: boolean;
	    page: number;
	    pageSize: number;
	
	    static createFrom(source: any = {}) {
	        return new Filter(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.search = source["search"];
	        this.connectionId = source["connectionId"];
	        this.database = source["database"];
	        this.dbType = source["dbType"];
	        this.eventType = source["eventType"];
	        this.status = source["status"];
	        this.transactionId = source["transactionId"];
	        this.source = source["source"];
	        this.fromTimestamp = source["fromTimestamp"];
	        this.toTimestamp = source["toTimestamp"];
	        this.executionHistory = source["executionHistory"];
	        this.page = source["page"];
	        this.pageSize = source["pageSize"];
	    }
	}
	export class Settings {
	    enabled: boolean;
	    captureMode: string;
	    retentionDays: number;
	    maxRecords: number;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.captureMode = source["captureMode"];
	        this.retentionDays = source["retentionDays"];
	        this.maxRecords = source["maxRecords"];
	    }
	}

}

export namespace sync {
	
	export class MigrationCapability {
	    sourceType: string;
	    targetType: string;
	    sourceModel: string;
	    targetModel: string;
	    planner: string;
	    supportLevel: string;
	    canExecute: boolean;
	    supportsAutoCreate: boolean;
	    supportsAutoAddColumns: boolean;
	    requiresExistingTarget: boolean;
	    supportsMutations: boolean;
	
	    static createFrom(source: any = {}) {
	        return new MigrationCapability(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sourceType = source["sourceType"];
	        this.targetType = source["targetType"];
	        this.sourceModel = source["sourceModel"];
	        this.targetModel = source["targetModel"];
	        this.planner = source["planner"];
	        this.supportLevel = source["supportLevel"];
	        this.canExecute = source["canExecute"];
	        this.supportsAutoCreate = source["supportsAutoCreate"];
	        this.supportsAutoAddColumns = source["supportsAutoAddColumns"];
	        this.requiresExistingTarget = source["requiresExistingTarget"];
	        this.supportsMutations = source["supportsMutations"];
	    }
	}
	export class SyncValueTransform {
	    type: string;
	    args?: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new SyncValueTransform(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.args = source["args"];
	    }
	}
	export class SyncDefaultValue {
	    when?: string[];
	    valueType?: string;
	    value?: string;
	
	    static createFrom(source: any = {}) {
	        return new SyncDefaultValue(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.when = source["when"];
	        this.valueType = source["valueType"];
	        this.value = source["value"];
	    }
	}
	export class SyncColumnMapping {
	    source?: string;
	    target?: string;
	    drop?: boolean;
	    default?: SyncDefaultValue;
	    transforms?: SyncValueTransform[];
	
	    static createFrom(source: any = {}) {
	        return new SyncColumnMapping(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source = source["source"];
	        this.target = source["target"];
	        this.drop = source["drop"];
	        this.default = this.convertValues(source["default"], SyncDefaultValue);
	        this.transforms = this.convertValues(source["transforms"], SyncValueTransform);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SyncObjectRef {
	    catalog?: string;
	    database?: string;
	    schema?: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new SyncObjectRef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.catalog = source["catalog"];
	        this.database = source["database"];
	        this.schema = source["schema"];
	        this.name = source["name"];
	    }
	}
	export class SyncObjectMapping {
	    id?: string;
	    source: SyncObjectRef;
	    target: SyncObjectRef;
	    keyColumns?: string[];
	    filter?: string;
	    columns?: SyncColumnMapping[];
	
	    static createFrom(source: any = {}) {
	        return new SyncObjectMapping(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.source = this.convertValues(source["source"], SyncObjectRef);
	        this.target = this.convertValues(source["target"], SyncObjectRef);
	        this.keyColumns = source["keyColumns"];
	        this.filter = source["filter"];
	        this.columns = this.convertValues(source["columns"], SyncColumnMapping);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TableOptions {
	    insert?: boolean;
	    update?: boolean;
	    delete?: boolean;
	    selectedInsertPks?: string[];
	    selectedUpdatePks?: string[];
	    selectedDeletePks?: string[];
	
	    static createFrom(source: any = {}) {
	        return new TableOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.insert = source["insert"];
	        this.update = source["update"];
	        this.delete = source["delete"];
	        this.selectedInsertPks = source["selectedInsertPks"];
	        this.selectedUpdatePks = source["selectedUpdatePks"];
	        this.selectedDeletePks = source["selectedDeletePks"];
	    }
	}
	export class SyncConfig {
	    sourceConfig: connection.ConnectionConfig;
	    targetConfig: connection.ConnectionConfig;
	    sourceDatabase?: string;
	    targetDatabase?: string;
	    targetSchema?: string;
	    tables: string[];
	    sourceQuery?: string;
	    content?: string;
	    mode: string;
	    jobId?: string;
	    autoAddColumns?: boolean;
	    targetTableStrategy?: string;
	    createIndexes?: boolean;
	    mongoCollectionName?: string;
	    tableOptions?: Record<string, TableOptions>;
	    mappings?: SyncObjectMapping[];
	    batchSize?: number;
	    rowErrorPolicy?: string;
	
	    static createFrom(source: any = {}) {
	        return new SyncConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sourceConfig = this.convertValues(source["sourceConfig"], connection.ConnectionConfig);
	        this.targetConfig = this.convertValues(source["targetConfig"], connection.ConnectionConfig);
	        this.sourceDatabase = source["sourceDatabase"];
	        this.targetDatabase = source["targetDatabase"];
	        this.targetSchema = source["targetSchema"];
	        this.tables = source["tables"];
	        this.sourceQuery = source["sourceQuery"];
	        this.content = source["content"];
	        this.mode = source["mode"];
	        this.jobId = source["jobId"];
	        this.autoAddColumns = source["autoAddColumns"];
	        this.targetTableStrategy = source["targetTableStrategy"];
	        this.createIndexes = source["createIndexes"];
	        this.mongoCollectionName = source["mongoCollectionName"];
	        this.tableOptions = this.convertValues(source["tableOptions"], TableOptions, true);
	        this.mappings = this.convertValues(source["mappings"], SyncObjectMapping);
	        this.batchSize = source["batchSize"];
	        this.rowErrorPolicy = source["rowErrorPolicy"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	export class SyncResult {
	    success: boolean;
	    message: string;
	    logs: string[];
	    tablesSynced: number;
	    rowsInserted: number;
	    rowsUpdated: number;
	    rowsDeleted: number;
	    rowsSkipped?: number;
	    cancelled?: boolean;
	    outcomeUnknown?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SyncResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.logs = source["logs"];
	        this.tablesSynced = source["tablesSynced"];
	        this.rowsInserted = source["rowsInserted"];
	        this.rowsUpdated = source["rowsUpdated"];
	        this.rowsDeleted = source["rowsDeleted"];
	        this.rowsSkipped = source["rowsSkipped"];
	        this.cancelled = source["cancelled"];
	        this.outcomeUnknown = source["outcomeUnknown"];
	    }
	}
	

}

export namespace syncjob {
	
	export class CDCSpec {
	    adapter?: string;
	    startPosition?: string;
	    initialSnapshot?: boolean;
	    slotName?: string;
	    publicationName?: string;
	
	    static createFrom(source: any = {}) {
	        return new CDCSpec(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.adapter = source["adapter"];
	        this.startPosition = source["startPosition"];
	        this.initialSnapshot = source["initialSnapshot"];
	        this.slotName = source["slotName"];
	        this.publicationName = source["publicationName"];
	    }
	}
	export class TransformSpec {
	    kind?: string;
	    argument?: number[];
	
	    static createFrom(source: any = {}) {
	        return new TransformSpec(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.argument = source["argument"];
	    }
	}
	export class ColumnMapping {
	    source?: string;
	    target: string;
	    transform?: TransformSpec;
	    defaultValue?: number[];
	    required?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ColumnMapping(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source = source["source"];
	        this.target = source["target"];
	        this.transform = this.convertValues(source["transform"], TransformSpec);
	        this.defaultValue = source["defaultValue"];
	        this.required = source["required"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class EndpointRef {
	    connectionId: string;
	    connectionType?: string;
	    connectionName?: string;
	    database?: string;
	    schema?: string;
	    fingerprint?: string;
	
	    static createFrom(source: any = {}) {
	        return new EndpointRef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connectionId = source["connectionId"];
	        this.connectionType = source["connectionType"];
	        this.connectionName = source["connectionName"];
	        this.database = source["database"];
	        this.schema = source["schema"];
	        this.fingerprint = source["fingerprint"];
	    }
	}
	export class ExecutionApproval {
	    definitionHash: string;
	    targetFingerprint: string;
	    approvedAt: number;
	    approvedByRuntime: string;
	
	    static createFrom(source: any = {}) {
	        return new ExecutionApproval(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.definitionHash = source["definitionHash"];
	        this.targetFingerprint = source["targetFingerprint"];
	        this.approvedAt = source["approvedAt"];
	        this.approvedByRuntime = source["approvedByRuntime"];
	    }
	}
	export class ExecutionOptions {
	    content?: string;
	    syncMode?: string;
	    targetTableStrategy?: string;
	    autoAddColumns?: boolean;
	    createIndexes?: boolean;
	    propagateDeletes?: boolean;
	    batchSize?: number;
	    errorPolicy?: string;
	    maxRetries?: number;
	    retryBackoffMillis?: number;
	    captureErrorPayload?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ExecutionOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.content = source["content"];
	        this.syncMode = source["syncMode"];
	        this.targetTableStrategy = source["targetTableStrategy"];
	        this.autoAddColumns = source["autoAddColumns"];
	        this.createIndexes = source["createIndexes"];
	        this.propagateDeletes = source["propagateDeletes"];
	        this.batchSize = source["batchSize"];
	        this.errorPolicy = source["errorPolicy"];
	        this.maxRetries = source["maxRetries"];
	        this.retryBackoffMillis = source["retryBackoffMillis"];
	        this.captureErrorPayload = source["captureErrorPayload"];
	    }
	}
	export class ScheduleSpec {
	    kind: string;
	    runAt?: number;
	    intervalSeconds?: number;
	    cronExpression?: string;
	    timezone?: string;
	    anchorAt?: number;
	    misfirePolicy?: string;
	
	    static createFrom(source: any = {}) {
	        return new ScheduleSpec(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.runAt = source["runAt"];
	        this.intervalSeconds = source["intervalSeconds"];
	        this.cronExpression = source["cronExpression"];
	        this.timezone = source["timezone"];
	        this.anchorAt = source["anchorAt"];
	        this.misfirePolicy = source["misfirePolicy"];
	    }
	}
	export class WatermarkSpec {
	    column: string;
	    initialValue?: number[];
	    tieBreakerColumns?: string[];
	
	    static createFrom(source: any = {}) {
	        return new WatermarkSpec(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.column = source["column"];
	        this.initialValue = source["initialValue"];
	        this.tieBreakerColumns = source["tieBreakerColumns"];
	    }
	}
	export class TableMapping {
	    sourceSchema?: string;
	    sourceTable: string;
	    targetSchema?: string;
	    targetTable: string;
	    targetTableStrategy?: string;
	    filter?: string;
	    keyColumns?: string[];
	    columns?: ColumnMapping[];
	    watermark?: WatermarkSpec;
	    enabled: boolean;
	
	    static createFrom(source: any = {}) {
	        return new TableMapping(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sourceSchema = source["sourceSchema"];
	        this.sourceTable = source["sourceTable"];
	        this.targetSchema = source["targetSchema"];
	        this.targetTable = source["targetTable"];
	        this.targetTableStrategy = source["targetTableStrategy"];
	        this.filter = source["filter"];
	        this.keyColumns = source["keyColumns"];
	        this.columns = this.convertValues(source["columns"], ColumnMapping);
	        this.watermark = this.convertValues(source["watermark"], WatermarkSpec);
	        this.enabled = source["enabled"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class JobDefinition {
	    version: number;
	    id: string;
	    name: string;
	    description?: string;
	    lifecycle: string;
	    enabled: boolean;
	    kind: string;
	    incrementalMode: string;
	    source: EndpointRef;
	    target: EndpointRef;
	    sourceQuery?: string;
	    mappings: TableMapping[];
	    options: ExecutionOptions;
	    schedule: ScheduleSpec;
	    cdc?: CDCSpec;
	    approval?: ExecutionApproval;
	    concurrencyPolicy?: string;
	    resumePolicy?: string;
	    revision: number;
	    createdAt: number;
	    updatedAt: number;
	    nextRunAt?: number;
	    lastScheduledAt?: number;
	    archivedAt?: number;
	
	    static createFrom(source: any = {}) {
	        return new JobDefinition(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.id = source["id"];
	        this.name = source["name"];
	        this.description = source["description"];
	        this.lifecycle = source["lifecycle"];
	        this.enabled = source["enabled"];
	        this.kind = source["kind"];
	        this.incrementalMode = source["incrementalMode"];
	        this.source = this.convertValues(source["source"], EndpointRef);
	        this.target = this.convertValues(source["target"], EndpointRef);
	        this.sourceQuery = source["sourceQuery"];
	        this.mappings = this.convertValues(source["mappings"], TableMapping);
	        this.options = this.convertValues(source["options"], ExecutionOptions);
	        this.schedule = this.convertValues(source["schedule"], ScheduleSpec);
	        this.cdc = this.convertValues(source["cdc"], CDCSpec);
	        this.approval = this.convertValues(source["approval"], ExecutionApproval);
	        this.concurrencyPolicy = source["concurrencyPolicy"];
	        this.resumePolicy = source["resumePolicy"];
	        this.revision = source["revision"];
	        this.createdAt = source["createdAt"];
	        this.updatedAt = source["updatedAt"];
	        this.nextRunAt = source["nextRunAt"];
	        this.lastScheduledAt = source["lastScheduledAt"];
	        this.archivedAt = source["archivedAt"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	

}

