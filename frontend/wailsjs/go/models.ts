export namespace ai {
	
	export class ChatSendOptions {
	    model?: string;
	    temperature?: number;
	    maxTokens?: number;
	    thinkingIntensity?: string;
	
	    static createFrom(source: any = {}) {
	        return new ChatSendOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.model = source["model"];
	        this.temperature = source["temperature"];
	        this.maxTokens = source["maxTokens"];
	        this.thinkingIntensity = source["thinkingIntensity"];
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
	export class ToolCallFunction {
	    name: string;
	    arguments: string;
	
	    static createFrom(source: any = {}) {
	        return new ToolCallFunction(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.arguments = source["arguments"];
	    }
	}
	export class ToolCall {
	    id: string;
	    type: string;
	    function: ToolCallFunction;
	
	    static createFrom(source: any = {}) {
	        return new ToolCall(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.type = source["type"];
	        this.function = this.convertValues(source["function"], ToolCallFunction);
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
	export class Message {
	    role: string;
	    content: string;
	    images?: string[];
	    tool_call_id?: string;
	    tool_calls?: ToolCall[];
	    reasoning_content?: string;
	
	    static createFrom(source: any = {}) {
	        return new Message(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.role = source["role"];
	        this.content = source["content"];
	        this.images = source["images"];
	        this.tool_call_id = source["tool_call_id"];
	        this.tool_calls = this.convertValues(source["tool_calls"], ToolCall);
	        this.reasoning_content = source["reasoning_content"];
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
	    apiFormat?: string;
	    headers?: Record<string, string>;
	    maxTokens: number;
	    temperature: number;
	    thinkingIntensity?: string;
	
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
	        this.apiFormat = source["apiFormat"];
	        this.headers = source["headers"];
	        this.maxTokens = source["maxTokens"];
	        this.temperature = source["temperature"];
	        this.thinkingIntensity = source["thinkingIntensity"];
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
	export class ToolFunction {
	    name: string;
	    description: string;
	    parameters: any;
	
	    static createFrom(source: any = {}) {
	        return new ToolFunction(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	        this.parameters = source["parameters"];
	    }
	}
	export class Tool {
	    type: string;
	    function: ToolFunction;
	
	    static createFrom(source: any = {}) {
	        return new Tool(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.function = this.convertValues(source["function"], ToolFunction);
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
	
	    static createFrom(source: any = {}) {
	        return new ImportFileOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.columnMappings = source["columnMappings"];
	        this.jobId = source["jobId"];
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
	    groupName?: string;
	    pageNo?: number;
	    pageSize?: number;
	
	    static createFrom(source: any = {}) {
	        return new NacosServiceQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.namespaceId = source["namespaceId"];
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
	    queryId?: string;
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
	        this.queryId = source["queryId"];
	        this.transactionId = source["transactionId"];
	        this.transactionPending = source["transactionPending"];
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
	export class SavedConnectionInput {
	    id?: string;
	    name: string;
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
	
	    static createFrom(source: any = {}) {
	        return new SavedConnectionInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
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
	
	    static createFrom(source: any = {}) {
	        return new SavedConnectionView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
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
	    }
	}

}
