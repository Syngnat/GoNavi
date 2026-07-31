import React, { useSyncExternalStore } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// import './index.css' // Optional global styles

import { setCurrentLanguage, t } from './i18n'
import { I18nProvider } from './i18n/provider'
import { applyDayjsLocale } from './i18n/runtime'
import { useStore } from './store'
import { cloneBrowserMockValue, duplicateBrowserMockConnection, resolveBrowserMockSecretFlag } from './utils/browserMockConnections'
import { configureAntdStaticOverlayLayer } from './utils/overlayZIndex'
import { normalizeConnectionEnvironmentType } from './utils/connectionEnvironment'

configureAntdStaticOverlayLayer();

const resolveDevHarnessMode = (): string => {
    if (typeof window === 'undefined') {
        return '';
    }
    try {
        return new URLSearchParams(window.location.search).get('devHarness') || '';
    } catch {
        return '';
    }
};

if (
    typeof window !== 'undefined'
    && (
        typeof (window as any).go?.app?.App?.GetSavedConnections !== 'function'
        || typeof (window as any).go?.aiservice?.Service?.AIGetProviders !== 'function'
    )
) {
    const existingRuntime = (window as any).runtime || {};
    const existingEventsOnMultiple = existingRuntime.EventsOnMultiple;
    (window as any).runtime = {
        ...existingRuntime,
        EventsOnMultiple: (...args: any[]) => {
            const off = typeof existingEventsOnMultiple === 'function'
                ? existingEventsOnMultiple(...args)
                : undefined;
            return typeof off === 'function' ? off : () => {};
        },
        EventsOff: typeof existingRuntime.EventsOff === 'function' ? existingRuntime.EventsOff : () => {},
        EventsOffAll: typeof existingRuntime.EventsOffAll === 'function' ? existingRuntime.EventsOffAll : () => {},
        EventsEmit: typeof existingRuntime.EventsEmit === 'function' ? existingRuntime.EventsEmit : () => {},
    };

    const mockConnections: any[] = [];
    const mockSavedQueries: any[] = [];
    const mockSavedQueryGroups: any[] = [];
    const mockQueryTables = [
        { table_name: 'videos', table_comment: 'sample video records' },
        { table_name: 'users', table_comment: 'sample users' },
    ];
    const mockQueryColumns = [
        { tableName: 'videos', name: 'id', type: 'bigint', comment: 'primary key' },
        { tableName: 'videos', name: 'code', type: 'varchar', comment: 'video code' },
        { tableName: 'videos', name: 'title', type: 'varchar', comment: 'video title' },
        { tableName: 'users', name: 'id', type: 'bigint', comment: 'primary key' },
        { tableName: 'users', name: 'name', type: 'varchar', comment: 'display name' },
    ];
    const mockConnectionSecrets = new Map<string, any>();
    const mockProviders: any[] = [];
    const mockProviderSecrets = new Map<string, string>();
    let mockActiveProviderId = '';
    let mockAISafetyLevel = 'readonly';
    let mockAIContextLevel = 'schema_only';
    let mockAIUserPromptSettings: any = {
        global: '',
        database: '',
        jvm: '',
        jvmDiagnostic: '',
    };
    let mockMCPServers: any[] = [];
    let mockMCPHTTPServerStatus: any = {
        enabled: false,
        running: false,
        addr: '127.0.0.1:8765',
        path: '/mcp',
        url: 'http://127.0.0.1:8765/mcp',
        schemaOnly: false,
        message: t('app.browser_mock.mcp_http.not_running'),
    };
    let mockMCPClientStatuses: any[] = [
        {
            client: 'claude-code',
            displayName: 'Claude Code',
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'claude',
            message: t('app.browser_mock.mcp_client.claude_code.not_detected'),
            configPath: 'C:/Users/mock/.claude.json',
            command: 'C:/Program Files/GoNavi/GoNavi.exe',
            args: ['mcp-server'],
        },
        {
            client: 'codex',
            displayName: 'Codex',
            installed: true,
            matchesCurrent: false,
            clientDetected: true,
            clientCommand: 'codex',
            clientPath: 'C:/Users/mock/AppData/Roaming/npm/codex.cmd',
            message: t('app.browser_mock.mcp_client.codex.path_mismatch'),
            configPath: 'C:/Users/mock/.codex/config.toml',
            command: 'C:/Old/GoNavi.exe',
            args: ['mcp-server'],
        },
        {
            client: 'opencode',
            displayName: 'OpenCode',
            installMode: 'auto',
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'opencode',
            message: t('app.browser_mock.mcp_client.opencode.not_detected'),
            configPath: 'C:/Users/mock/.config/opencode/opencode.json',
            command: 'C:/Program Files/GoNavi/GoNavi.exe',
            args: ['mcp-server'],
        },
    ];
    let mockSkills: any[] = [];
    let mockGlobalProxy: any = { enabled: false, type: 'socks5', host: '', port: 1080, user: '', password: '', hasPassword: false };
    let mockUpdateChannel: 'latest' | 'dev' = 'latest';
    const mockReleasePublishedAt = '2026-07-08T11:15:00Z';
    const buildMockUpdateInfo = () => ({
        hasUpdate: false,
        channel: mockUpdateChannel,
        currentVersion: '0.0.0',
        latestVersion: mockUpdateChannel === 'dev' ? 'dev-browser-mock' : '0.0.0',
        releaseName: mockUpdateChannel === 'dev' ? 'Dev Build (dev-browser-mock)' : 'Browser Mock Release',
        releasePublishedAt: mockReleasePublishedAt,
        releaseNotesUrl: mockUpdateChannel === 'dev'
            ? 'https://github.com/Syngnat/GoNavi/releases/tag/dev-latest'
            : 'https://github.com/Syngnat/GoNavi/releases/latest',
    });
    let mockDataRootInfo: any = {
        path: 'C:/mock/.gonavi',
        defaultPath: 'C:/mock/.gonavi',
        driverPath: 'C:/mock/.gonavi/drivers',
        isDefaultPath: true,
        bootstrapPath: 'C:/mock/.gonavi/storage_root.json',
        logDirectory: 'C:/Users/mock/.GoNavi/Logs',
        activeLogDirectory: 'C:/Users/mock/.GoNavi/Logs',
        logFilePath: 'C:/Users/mock/.GoNavi/Logs/gonavi.log',
        defaultLogDirectory: 'C:/Users/mock/.GoNavi/Logs',
        logDirectorySource: 'default',
        logDirectoryEditable: true,
        logDirectoryRestartRequired: false,
        savedQueryDirectory: 'C:/mock/.gonavi/saved_queries',
        defaultSavedQueryDirectory: 'C:/mock/.gonavi/saved_queries',
        savedQueryDirectorySource: 'default',
    };

    const upsertMockConnection = (view: any) => {
        const index = mockConnections.findIndex((item) => item.id === view.id);
        if (index >= 0) {
            mockConnections[index] = view;
            return;
        }
        mockConnections.push(view);
    };

    const saveMockConnection = (input: any) => {
        const existing = mockConnections.find((item) => item.id === input?.id);
        const hasSchemaVisibilityByDatabase = Object.prototype.hasOwnProperty.call(input || {}, 'schemaVisibilityByDatabase');
        const existingSecrets = mockConnectionSecrets.get(existing?.id || input?.id || '') || {};
        const config = (input?.config && typeof input.config === 'object') ? input.config : {};
        const ssh = (config.ssh && typeof config.ssh === 'object') ? config.ssh : {};
        const proxy = (config.proxy && typeof config.proxy === 'object') ? config.proxy : {};
        const httpTunnel = (config.httpTunnel && typeof config.httpTunnel === 'object') ? config.httpTunnel : {};
        const nextId = String(input?.id || existing?.id || `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const nextSecrets = {
            password: String(config.password ?? existingSecrets.password ?? ''),
            sshPassword: String(ssh.password ?? existingSecrets.sshPassword ?? ''),
            proxyPassword: String(proxy.password ?? existingSecrets.proxyPassword ?? ''),
            httpTunnelPassword: String(httpTunnel.password ?? existingSecrets.httpTunnelPassword ?? ''),
            mysqlReplicaPassword: String(config.mysqlReplicaPassword ?? existingSecrets.mysqlReplicaPassword ?? ''),
            mongoReplicaPassword: String(config.mongoReplicaPassword ?? existingSecrets.mongoReplicaPassword ?? ''),
            redisSentinelPassword: String(config.redisSentinelPassword ?? existingSecrets.redisSentinelPassword ?? ''),
            uri: String(config.uri ?? existingSecrets.uri ?? ''),
            dsn: String(config.dsn ?? existingSecrets.dsn ?? ''),
        };
        if (input?.clearPrimaryPassword) nextSecrets.password = '';
        if (input?.clearSSHPassword) nextSecrets.sshPassword = '';
        if (input?.clearProxyPassword) nextSecrets.proxyPassword = '';
        if (input?.clearHttpTunnelPassword) nextSecrets.httpTunnelPassword = '';
        if (input?.clearMySQLReplicaPassword) nextSecrets.mysqlReplicaPassword = '';
        if (input?.clearMongoReplicaPassword) nextSecrets.mongoReplicaPassword = '';
        if (input?.clearRedisSentinelPassword) nextSecrets.redisSentinelPassword = '';
        if (input?.clearOpaqueURI) nextSecrets.uri = '';
        if (input?.clearOpaqueDSN) nextSecrets.dsn = '';
        mockConnectionSecrets.set(nextId, nextSecrets);
        const view = {
            id: nextId,
            name: String(input?.name || existing?.name || t('connection.unnamed')),
            environmentType: normalizeConnectionEnvironmentType(
                input?.environmentType ?? existing?.environmentType,
            ),
            config: {
                ...config,
                id: nextId,
                password: '',
                ssh: { ...ssh, password: '' },
                proxy: { ...proxy, password: '' },
                httpTunnel: { ...httpTunnel, password: '' },
                uri: '',
                dsn: '',
                mysqlReplicaPassword: '',
                mongoReplicaPassword: '',
                redisSentinelPassword: '',
            },
            includeDatabases: Array.isArray(input?.includeDatabases) ? [...input.includeDatabases] : existing?.includeDatabases,
            includeRedisDatabases: Array.isArray(input?.includeRedisDatabases) ? [...input.includeRedisDatabases] : existing?.includeRedisDatabases,
            schemaVisibilityByDatabase: hasSchemaVisibilityByDatabase
                ? (input?.schemaVisibilityByDatabase && typeof input.schemaVisibilityByDatabase === 'object'
                    ? cloneBrowserMockValue(input.schemaVisibilityByDatabase)
                    : undefined)
                : existing?.schemaVisibilityByDatabase,
            iconType: typeof input?.iconType === 'string' ? input.iconType : (existing?.iconType || ''),
            iconColor: typeof input?.iconColor === 'string' ? input.iconColor : (existing?.iconColor || ''),
            hasPrimaryPassword: resolveBrowserMockSecretFlag(config.password, !!input?.clearPrimaryPassword, existing?.hasPrimaryPassword),
            hasSSHPassword: resolveBrowserMockSecretFlag(ssh.password, !!input?.clearSSHPassword, existing?.hasSSHPassword),
            hasProxyPassword: resolveBrowserMockSecretFlag(proxy.password, !!input?.clearProxyPassword, existing?.hasProxyPassword),
            hasHttpTunnelPassword: resolveBrowserMockSecretFlag(httpTunnel.password, !!input?.clearHttpTunnelPassword, existing?.hasHttpTunnelPassword),
            hasMySQLReplicaPassword: resolveBrowserMockSecretFlag(config.mysqlReplicaPassword, !!input?.clearMySQLReplicaPassword, existing?.hasMySQLReplicaPassword),
            hasMongoReplicaPassword: resolveBrowserMockSecretFlag(config.mongoReplicaPassword, !!input?.clearMongoReplicaPassword, existing?.hasMongoReplicaPassword),
            hasRedisSentinelPassword: resolveBrowserMockSecretFlag(config.redisSentinelPassword, !!input?.clearRedisSentinelPassword, existing?.hasRedisSentinelPassword),
            hasOpaqueURI: resolveBrowserMockSecretFlag(config.uri, !!input?.clearOpaqueURI, existing?.hasOpaqueURI),
            hasOpaqueDSN: resolveBrowserMockSecretFlag(config.dsn, !!input?.clearOpaqueDSN, existing?.hasOpaqueDSN),
        };
        upsertMockConnection(view);
        return cloneBrowserMockValue(view);
    };

    const saveMockQuery = (input: any) => {
        const nextId = String(input?.id || `saved-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const index = mockSavedQueries.findIndex((item) => item.id === nextId);
        const generatedNameIndex = index >= 0 ? index : mockSavedQueries.length;
        const view = {
            id: nextId,
            name: String(input?.name || t('saved_query.default_name', { index: generatedNameIndex + 1 })),
            sql: String(input?.sql || ''),
            connectionId: String(input?.connectionId || ''),
            dbName: String(input?.dbName || ''),
            createdAt: Number.isFinite(Number(input?.createdAt)) ? Number(input.createdAt) : Date.now(),
            connectionFingerprint: typeof input?.connectionFingerprint === 'string' ? input.connectionFingerprint : undefined,
            fingerprintVersion: typeof input?.fingerprintVersion === 'string' ? input.fingerprintVersion : undefined,
            bindingStatus: typeof input?.bindingStatus === 'string' ? input.bindingStatus : undefined,
            originalConnectionId: typeof input?.originalConnectionId === 'string' ? input.originalConnectionId : undefined,
        };
        if (index >= 0) {
            mockSavedQueries[index] = view;
        } else {
            mockSavedQueries.push(view);
        }
        return cloneBrowserMockValue(view);
    };

    const uniqueMockStringArray = (value: unknown): string[] => {
        if (!Array.isArray(value)) return [];
        const seen = new Set<string>();
        return value.reduce<string[]>((result, item) => {
            const next = String(item || '').trim();
            if (!next || seen.has(next)) return result;
            seen.add(next);
            result.push(next);
            return result;
        }, []);
    };

    const saveMockSavedQueryGroup = (input: any) => {
        const nextId = String(input?.id || `saved-query-group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const index = mockSavedQueryGroups.findIndex((item) => item.id === nextId);
        const existing = index >= 0 ? mockSavedQueryGroups[index] : undefined;
        const queryIds = uniqueMockStringArray(input?.queryIds);
        const childOrder = uniqueMockStringArray(input?.childOrder);
        const view = {
            id: nextId,
            name: String(input?.name || existing?.name || t('sidebar.saved_query_group.untitled')).trim(),
            parentGroupId: String(input?.parentGroupId || '').trim() || undefined,
            queryIds,
            childOrder,
        };
        if (index >= 0) {
            mockSavedQueryGroups[index] = view;
        } else {
            mockSavedQueryGroups.push(view);
        }
        mockSavedQueryGroups.forEach((group) => {
            if (group.id === nextId) return;
            group.queryIds = uniqueMockStringArray(group.queryIds).filter((queryId) => !queryIds.includes(queryId));
            group.childOrder = uniqueMockStringArray(group.childOrder)
                .filter((token) => !queryIds.includes(String(token).replace(/^query:/, '')));
        });
        return cloneBrowserMockValue(view);
    };

    const deleteMockSavedQueryGroup = (id: string) => {
        const index = mockSavedQueryGroups.findIndex((item) => item.id === id);
        if (index < 0) return;
        const removed = mockSavedQueryGroups[index];
        mockSavedQueryGroups.splice(index, 1);
        mockSavedQueryGroups.forEach((group) => {
            if (group.parentGroupId === removed.id) {
                group.parentGroupId = removed.parentGroupId || undefined;
            }
            if (group.id === removed.parentGroupId) {
                group.queryIds = uniqueMockStringArray([...(group.queryIds || []), ...(removed.queryIds || [])]);
                group.childOrder = uniqueMockStringArray([
                    ...(group.childOrder || []).filter((token: string) => token !== `group:${removed.id}`),
                    ...(removed.childOrder || []),
                ]);
            }
        });
    };

    const saveMockGlobalProxy = (input: any) => {
        const nextPassword = String(input?.password ?? '');
        const clearPassword = input?.clearPassword === true;
        mockGlobalProxy = {
            ...mockGlobalProxy,
            ...input,
            password: '',
            hasPassword: clearPassword ? false : (nextPassword !== '' ? true : !!mockGlobalProxy.hasPassword),
            clearPassword: undefined,
        };
        return cloneBrowserMockValue(mockGlobalProxy);
    };

    const saveMockProvider = (input: any) => {
        const existing = mockProviders.find((item) => item.id === input?.id);
        const nextId = String(input?.id || existing?.id || `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const apiKey = String(input?.apiKey ?? '');
        if (apiKey !== '') {
            mockProviderSecrets.set(nextId, apiKey);
        } else if (input?.hasSecret === false) {
            mockProviderSecrets.delete(nextId);
        }
        const hasSecret = mockProviderSecrets.has(nextId);
        const view = {
            ...existing,
            ...input,
            id: nextId,
            apiKey: '',
            hasSecret,
            secretRef: '',
        };
        const index = mockProviders.findIndex((item) => item.id === nextId);
        if (index >= 0) {
            mockProviders[index] = view;
        } else {
            mockProviders.push(view);
        }
        if (!mockActiveProviderId) {
            mockActiveProviderId = nextId;
        }
        return cloneBrowserMockValue(view);
    };

    const mockGo = {
        app: {
            App: {
                CheckUpdate: async () => ({ success: false }),
                DownloadUpdate: async () => ({ success: false }),
                SetLanguage: async () => null,
                GetSavedConnections: async () => cloneBrowserMockValue(mockConnections),
                GetEditableSavedConnection: async (id: string) => {
                    const existing = mockConnections.find((item) => item.id === id);
                    if (!existing) {
                        throw new Error(`saved connection not found: ${id}`);
                    }
                    const secrets = mockConnectionSecrets.get(id) || {};
                    return cloneBrowserMockValue({
                        ...existing,
                        config: {
                            ...existing.config,
                            password: secrets.password || '',
                            ssh: { ...(existing.config?.ssh || {}), password: secrets.sshPassword || '' },
                            proxy: { ...(existing.config?.proxy || {}), password: secrets.proxyPassword || '' },
                            httpTunnel: { ...(existing.config?.httpTunnel || {}), password: secrets.httpTunnelPassword || '' },
                            mysqlReplicaPassword: secrets.mysqlReplicaPassword || '',
                            mongoReplicaPassword: secrets.mongoReplicaPassword || '',
                            redisSentinelPassword: secrets.redisSentinelPassword || '',
                            uri: secrets.uri || '',
                            dsn: secrets.dsn || '',
                        },
                    });
                },
                ListInstalledFontFamilies: async () => ({ success: true, data: [] }),
                SaveConnection: async (input: any) => saveMockConnection(input),
                DeleteConnection: async (id: string) => {
                    const index = mockConnections.findIndex((item) => item.id === id);
                    if (index >= 0) {
                        mockConnections.splice(index, 1);
                    }
                    return null;
                },
                DuplicateConnection: async (id: string) => {
                    const existing = mockConnections.find((item) => item.id === id);
                    if (!existing) return null;
                    const duplicated = duplicateBrowserMockConnection({
                        existing,
                        items: mockConnections,
                        nextId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    });
                    mockConnections.push(duplicated);
                    return cloneBrowserMockValue(duplicated);
                },
                ImportLegacyConnections: async (items: any[]) => items.map((item) => saveMockConnection(item)),
                OpenConnection: async () => null,
                CloseConnection: async () => null,
                GetDatabases: async () => [],
                GetTables: async () => [],
                GetTableData: async () => ({ columns: [], rows: [], total: 0 }),
                GetTableColumns: async () => [],
                DBGetDatabases: async () => ({ success: true, data: ['missav_bot'] }),
                DBGetTables: async () => ({ success: true, data: cloneBrowserMockValue(mockQueryTables) }),
                DBGetAllColumns: async () => ({ success: true, data: cloneBrowserMockValue(mockQueryColumns) }),
                DBGetDatabaseForeignKeys: async () => ({ success: true, data: {} }),
                DBGetColumns: async (_config: any, _dbName: string, tableName: string) => ({
                    success: true,
                    data: cloneBrowserMockValue(
                        mockQueryColumns
                            .filter((column) => String(column.tableName || '').toLowerCase() === String(tableName || '').toLowerCase())
                            .map(({ tableName: _tableName, ...column }) => column),
                    ),
                }),
                DBQuery: async () => ({ success: true, data: [], columns: [] }),
                DBQueryAudited: async () => ({ success: true, data: { affectedRows: 1 }, queryId: `query-${Date.now()}` }),
                ExecuteQuery: async () => ({ columns: [], rows: [], time: 0 }),
                GetSQLAuditEvents: async (filter: any) => ({
                    success: true,
                    data: {
                        items: [],
                        total: 0,
                        page: Number(filter?.page) || 1,
                        pageSize: Number(filter?.pageSize) || 50,
                        summary: { totalEvents: 0, successCount: 0, errorCount: 0, transactionCount: 0 },
                    },
                }),
                GetSQLAuditHealth: async () => ({
                    success: true,
                    data: {
                        status: 'healthy',
                        captureEnabled: true,
                        captureMode: 'redacted',
                        droppedEvents: 0,
                        firstFailureAt: 0,
                        lastFailureAt: 0,
                        lastSuccessAt: 0,
                        lastError: '',
                    },
                }),
                GetSQLAuditSettings: async () => ({ success: true, data: { enabled: true, captureMode: 'redacted', retentionDays: 30, maxRecords: 100000 } }),
                UpdateSQLAuditSettings: async () => ({ success: true }),
                VerifySQLAuditIntegrity: async () => ({
                    success: true,
                    data: { valid: true, weakValidation: true, partialChain: false, truncatedPrefix: false, checkedRecords: 0 },
                }),
                BuildSQLAuditExport: async (_filter: any, format: string) => ({
                    success: true,
                    data: {
                        fileName: `gonavi-sql-audit.${format === 'csv' ? 'csv' : 'json'}`,
                        mimeType: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
                        content: format === 'csv' ? '' : '[]',
                    },
                }),
                ExportSQLAuditFile: async (_filter: any, format: string) => ({ success: true, data: { filePath: `gonavi-sql-audit.${format}` } }),
                ClearSQLAuditEvents: async () => ({ success: true }),
                GetSavedQueries: async () => cloneBrowserMockValue(mockSavedQueries),
                GetSavedQueryGroups: async () => cloneBrowserMockValue(mockSavedQueryGroups),
                SaveQuery: async (input: any) => saveMockQuery(input),
                RenameSavedQuery: async (id: string, name: string) => {
                    const existing = mockSavedQueries.find((item) => item.id === id);
                    if (!existing) throw new Error('saved query not found');
                    return saveMockQuery({
                        ...existing,
                        name: String(name || '').trim(),
                    });
                },
                RevealSavedQueryInFolder: async (id: string) => {
                    const existing = mockSavedQueries.find((item) => item.id === id);
                    if (!existing) {
                        return {
                            success: false,
                            message: t('app.data_root.saved_query_directory.backend.error.query_not_found', { id }),
                        };
                    }
                    const path = `${mockDataRootInfo.savedQueryDirectory}/${id}.sql`;
                    return {
                        success: true,
                        message: t('app.data_root.saved_query_directory.backend.message.revealed', { path }),
                        data: { path },
                    };
                },
                SaveSavedQueryGroup: async (input: any) => saveMockSavedQueryGroup(input),
                ImportSavedQueries: async (payload: any) => {
                    const items = Array.isArray(payload) ? payload : payload?.queries;
                    (Array.isArray(items) ? items : []).forEach((item) => saveMockQuery(item));
                    const groups: unknown[] = Array.isArray(payload?.groups) ? payload.groups : [];
                    groups.forEach((group) => saveMockSavedQueryGroup(group));
                    return cloneBrowserMockValue(mockSavedQueries);
                },
                DeleteQuery: async (id: string) => {
                    const index = mockSavedQueries.findIndex((item) => item.id === id);
                    if (index >= 0) {
                        mockSavedQueries.splice(index, 1);
                    }
                    mockSavedQueryGroups.forEach((group) => {
                        group.queryIds = uniqueMockStringArray(group.queryIds).filter((queryId) => queryId !== id);
                        group.childOrder = uniqueMockStringArray(group.childOrder)
                            .filter((token) => token !== `query:${id}`);
                    });
                    return null;
                },
                DeleteSavedQueryGroup: async (id: string) => {
                    deleteMockSavedQueryGroup(id);
                    return null;
                },
                MoveSavedQueryToGroup: async (queryId: string, groupId: string) => {
                    if (!mockSavedQueries.some((query) => query.id === queryId)) {
                        throw new Error('saved query not found');
                    }
                    const target = groupId ? mockSavedQueryGroups.find((group) => group.id === groupId) : null;
                    if (groupId && !target) {
                        throw new Error('saved query group not found');
                    }
                    mockSavedQueryGroups.forEach((group) => {
                        group.queryIds = uniqueMockStringArray(group.queryIds).filter((id) => id !== queryId);
                        group.childOrder = uniqueMockStringArray(group.childOrder)
                            .filter((token) => token !== `query:${queryId}`);
                    });
                    if (target) {
                        target.queryIds = uniqueMockStringArray([...(target.queryIds || []), queryId]);
                        target.childOrder = uniqueMockStringArray([...(target.childOrder || []), `query:${queryId}`]);
                    }
                    return null;
                },
                MoveSavedQueryGroup: async (groupId: string, parentGroupId: string) => {
                    const target = mockSavedQueryGroups.find((group) => group.id === groupId);
                    if (!target) throw new Error('saved query group not found');
                    if (parentGroupId && !mockSavedQueryGroups.some((group) => group.id === parentGroupId)) {
                        throw new Error('saved query parent group not found');
                    }
                    mockSavedQueryGroups.forEach((group) => {
                        group.childOrder = uniqueMockStringArray(group.childOrder)
                            .filter((token) => token !== `group:${groupId}`);
                    });
                    target.parentGroupId = parentGroupId || undefined;
                    if (parentGroupId) {
                        const parent = mockSavedQueryGroups.find((group) => group.id === parentGroupId);
                        parent.childOrder = uniqueMockStringArray([...(parent.childOrder || []), `group:${groupId}`]);
                    }
                    return null;
                },
                RebindSavedQuery: async (id: string, connectionId: string) => {
                    const existing = mockSavedQueries.find((item) => item.id === id);
                    if (!existing) throw new Error('saved query not found');
                    return saveMockQuery({
                        ...existing,
                        connectionId,
                        originalConnectionId: existing.originalConnectionId || existing.connectionId,
                        bindingStatus: 'active',
                    });
                },
                GetAppInfo: async () => ({ success: true, data: { version: '0.0.0', author: 'GoNavi' } }),
                GetDataRootDirectoryInfo: async () => ({ success: true, data: cloneBrowserMockValue(mockDataRootInfo) }),
                CheckForUpdates: async () => ({
                    success: true,
                    data: buildMockUpdateInfo(),
                }),
                CheckForUpdatesSilently: async () => ({
                    success: true,
                    data: buildMockUpdateInfo(),
                }),
                GetUpdateChannel: async () => ({ success: true, data: { channel: mockUpdateChannel } }),
                OpenDownloadedUpdateDirectory: async () => ({ success: false }),
                OpenDriverDownloadDirectory: async (path: string) => ({ success: true, data: { path } }),
                OpenDataRootDirectory: async () => ({ success: true }),
                OpenLogDirectory: async () => ({ success: true }),
                OpenSavedQueryDirectory: async () => ({ success: true }),
                SelectSQLDirectory: async (currentPath: string) => ({ success: false, message: currentPath ? '已取消' : '已取消' }),
                ListSQLDirectory: async () => ({ success: true, data: [] }),
                ReadSQLFile: async () => ({ success: false, message: '已取消' }),
                ReadAppLogTail: async (lineLimit: number, keyword: string) => {
                    const allLines = [
                        '2026/06/09 10:10:00.000000 [INFO] 应用启动完成',
                        '2026/06/09 10:10:05.000000 [WARN] MCP mock service slow start',
                        '2026/06/09 10:10:09.000000 [ERROR] MySQL mock dial failed: connect timeout',
                    ];
                    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
                    const filtered = normalizedKeyword
                        ? allLines.filter((line) => line.toLowerCase().includes(normalizedKeyword))
                        : allLines;
                    const safeLimit = Math.max(1, Math.min(Number(lineLimit) || 80, 200));
                    const visibleLines = filtered.slice(-safeLimit);
                    return {
                        success: true,
                        data: {
                            logPath: 'C:/Users/mock/.GoNavi/Logs/gonavi.log',
                            keyword: String(keyword || ''),
                            requestedLineLimit: safeLimit,
                            returnedLineCount: visibleLines.length,
                            fileWindowTruncated: false,
                            matchedLinesTruncated: filtered.length > visibleLines.length,
                            levelBreakdown: {
                                INFO: visibleLines.filter((line) => line.includes('[INFO]')).length,
                                WARN: visibleLines.filter((line) => line.includes('[WARN]')).length,
                                ERROR: visibleLines.filter((line) => line.includes('[ERROR]')).length,
                                OTHER: visibleLines.filter((line) => !/\[(INFO|WARN|ERROR)\]/.test(line)).length,
                            },
                            lines: visibleLines,
                        },
                    };
                },
                CreateSQLFile: async (_directoryPath: string, _name: string) => ({ success: true, data: { filePath: '', name: _name } }),
                CreateSQLDirectory: async (directoryPath: string, name: string) => ({ success: true, data: { directoryPath: `${directoryPath}/${name}`, name } }),
                DeleteSQLFile: async (_filePath: string) => ({ success: true }),
                DeleteSQLDirectory: async (_directoryPath: string) => ({ success: true }),
                RenameSQLFile: async (_filePath: string, name: string) => ({ success: true, data: { filePath: _filePath, name } }),
                RenameSQLDirectory: async (directoryPath: string, name: string) => ({ success: true, data: { directoryPath: `${directoryPath.replace(/[\\/][^\\/]*$/, '')}/${name}`, name } }),
                WriteSQLFile: async (_filePath: string, _content: string) => ({ success: true }),
                ExportSQLFile: async (_defaultName: string, _content: string) => ({ success: false, message: t('app.browser_mock.export_sql_unsupported') }),
                InstallUpdateAndRestart: async (_closeAllWindowsInstancesConfirmed: boolean) => ({ success: false }),
                ImportConfigFile: async () => ({ success: false, message: '已取消' }),
                ImportConnectionsPayload: async (raw: string, _password?: string) => {
                    try {
                        const parsed = JSON.parse(raw);
                        if (Array.isArray(parsed)) {
                            return {
                                connections: parsed.map((item) => saveMockConnection(item)),
                                redisDbAliases: {},
                            };
                        }
                        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.connections)) {
                            return {
                                connections: parsed.connections.map((item: unknown) => saveMockConnection(item)),
                                redisDbAliases: parsed.redisDbAliases && typeof parsed.redisDbAliases === 'object'
                                    ? parsed.redisDbAliases
                                    : {},
                            };
                        }
                    } catch {
                        throw new Error(t('app.browser_mock.import_connection_package_unsupported'));
                    }
                    throw new Error(t('app.browser_mock.import_connection_package_unsupported'));
                },
                ExportConnectionsPackage: async (_options?: {
                    includeSecrets?: boolean;
                    filePassword?: string;
                    redisDbAliases?: Record<string, Record<string, string>>;
                }) => ({ success: false, message: t('app.browser_mock.export_connection_package_unsupported') }),
                ExportData: async () => ({ success: false }),
                GetGlobalProxyConfig: async () => ({ success: true, data: cloneBrowserMockValue(mockGlobalProxy) }),
                SetUpdateChannel: async (channel: string) => {
                    mockUpdateChannel = String(channel || '').trim().toLowerCase() === 'dev' ? 'dev' : 'latest';
                    return { success: true, data: { channel: mockUpdateChannel } };
                },
                SaveGlobalProxy: async (input: any) => saveMockGlobalProxy(input),
                ImportLegacyGlobalProxy: async (input: any) => saveMockGlobalProxy(input),
                TestGlobalProxyConnection: async (input: any) => {
                    const url = String(input?.url || 'https://api.github.com/').trim();
                    return {
                        success: true,
                        message: t('app.proxy.backend.message.test_success', { status: 200, duration: 18, url }),
                        data: {
                            url,
                            finalUrl: url,
                            statusCode: 200,
                            status: '200 OK',
                            durationMs: 18,
                            viaProxy: input?.proxy?.enabled === true,
                        },
                    };
                },
                SelectDataRootDirectory: async (currentPath: string) => ({ success: true, data: { ...mockDataRootInfo, path: currentPath || mockDataRootInfo.path } }),
                ApplyDataRootDirectory: async (path: string) => {
                    const nextPath = String(path || mockDataRootInfo.defaultPath);
                    mockDataRootInfo = {
                        ...mockDataRootInfo,
                        path: nextPath,
                        driverPath: `${nextPath}/drivers`,
                        isDefaultPath: nextPath === mockDataRootInfo.defaultPath,
                    };
                    return { success: true, message: t('app.data_root.message.updated'), data: cloneBrowserMockValue(mockDataRootInfo) };
                },
                SelectLogDirectory: async (currentPath: string) => ({
                    success: true,
                    data: { directory: currentPath || mockDataRootInfo.defaultLogDirectory },
                }),
                ApplyLogDirectory: async (path: string) => {
                    const nextPath = String(path || mockDataRootInfo.defaultLogDirectory);
                    mockDataRootInfo = {
                        ...mockDataRootInfo,
                        logDirectory: nextPath,
                        logDirectorySource: nextPath === mockDataRootInfo.defaultLogDirectory ? 'default' : 'custom',
                        logDirectoryRestartRequired: nextPath !== mockDataRootInfo.activeLogDirectory,
                    };
                    return {
                        success: true,
                        message: t('app.data_root.log_directory.message.updated'),
                        data: cloneBrowserMockValue(mockDataRootInfo),
                    };
                },
                SelectSavedQueryDirectory: async (currentPath: string) => ({
                    success: true,
                    data: { directory: currentPath || mockDataRootInfo.defaultSavedQueryDirectory },
                }),
                ApplySavedQueryDirectory: async (path: string) => {
                    const nextPath = String(path || mockDataRootInfo.defaultSavedQueryDirectory);
                    mockDataRootInfo = {
                        ...mockDataRootInfo,
                        savedQueryDirectory: nextPath,
                        savedQueryDirectorySource: nextPath === mockDataRootInfo.defaultSavedQueryDirectory
                            ? 'default'
                            : 'custom',
                    };
                    return {
                        success: true,
                        message: t('app.data_root.saved_query_directory.message.updated'),
                        data: cloneBrowserMockValue(mockDataRootInfo),
                    };
                },
            }
        },
        aiservice: {
            Service: {
                AIGetProviders: async () => cloneBrowserMockValue(mockProviders),
                AIGetEditableProvider: async (id: string) => {
                    const existing = mockProviders.find((item) => item.id === id);
                    if (!existing) {
                        throw new Error(`provider not found: ${id}`);
                    }
                    return cloneBrowserMockValue({
                        ...existing,
                        apiKey: mockProviderSecrets.get(id) || '',
                    });
                },
                AISaveProvider: async (input: any) => saveMockProvider(input),
                AIDeleteProvider: async (id: string) => {
                    const index = mockProviders.findIndex((item) => item.id === id);
                    if (index >= 0) {
                        mockProviders.splice(index, 1);
                    }
                    mockProviderSecrets.delete(id);
                    if (mockActiveProviderId === id) {
                        mockActiveProviderId = mockProviders[0]?.id || '';
                    }
                    return null;
                },
                AIGetActiveProvider: async () => mockActiveProviderId,
                AISetActiveProvider: async (id: string) => {
                    mockActiveProviderId = id;
                    return null;
                },
                AIGetSafetyLevel: async () => mockAISafetyLevel,
                AIGetContextLevel: async () => mockAIContextLevel,
                AIGetBuiltinPrompts: async () => ({}),
                AIGetUserPromptSettings: async () => cloneBrowserMockValue(mockAIUserPromptSettings),
                AIChatSend: async () => ({
                    success: true,
                    content: 'SELECT * FROM `videos` LIMIT 100;',
                }),
                AIChatSendWithOptions: async (messages: any[], tools: any[], options: any) => {
                    (window as any).__gonaviLastAIChatSendWithOptions = {
                        messages: cloneBrowserMockValue(messages),
                        tools: cloneBrowserMockValue(tools),
                        options: cloneBrowserMockValue(options),
                    };
                    return {
                        success: true,
                        content: 'SELECT * FROM `videos` LIMIT 100;',
                    };
                },
                AISaveUserPromptSettings: async (input: any) => {
                    mockAIUserPromptSettings = {
                        global: String(input?.global || ''),
                        database: String(input?.database || ''),
                        jvm: String(input?.jvm || ''),
                        jvmDiagnostic: String(input?.jvmDiagnostic || ''),
                    };
                    return null;
                },
                AIGetMCPClientInstallStatuses: async () => cloneBrowserMockValue(mockMCPClientStatuses),
                AIGetMCPHTTPServerStatus: async () => cloneBrowserMockValue(mockMCPHTTPServerStatus),
                AIStartMCPHTTPServer: async (input: any) => {
                    const addr = String(input?.addr || '127.0.0.1:8765');
                    const path = String(input?.path || '/mcp').startsWith('/') ? String(input?.path || '/mcp') : `/${String(input?.path || '/mcp')}`;
                    const token = String(input?.token || 'gnv_browser_mock_token').trim() || 'gnv_browser_mock_token';
                    mockMCPHTTPServerStatus = {
                        running: true,
                        enabled: true,
                        addr,
                        path,
                        url: `http://${addr}${path}`,
                        schemaOnly: Boolean(input?.schemaOnly),
                        token,
                        authorizationHeader: `Bearer ${token}`,
                        startedAt: Date.now(),
                        message: t('app.browser_mock.mcp_http.started'),
                    };
                    return cloneBrowserMockValue(mockMCPHTTPServerStatus);
                },
                AIStopMCPHTTPServer: async () => {
                    mockMCPHTTPServerStatus = {
                        ...mockMCPHTTPServerStatus,
                        enabled: false,
                        running: false,
                        message: t('app.browser_mock.mcp_http.stopped'),
                    };
                    return cloneBrowserMockValue(mockMCPHTTPServerStatus);
                },
                AIGetMCPServers: async () => cloneBrowserMockValue(mockMCPServers),
                AIInstallClaudeCodeMCP: async () => {
                    mockMCPClientStatuses = mockMCPClientStatuses.map((item) => item.client === 'claude-code'
                        ? {
                            ...item,
                            installed: true,
                            matchesCurrent: true,
                            message: t('app.browser_mock.mcp_client.claude_code.installed'),
                            command: 'C:/Program Files/GoNavi/GoNavi.exe',
                            args: ['mcp-server'],
                        }
                        : item);
                    return {
                        success: true,
                        client: 'claude-code',
                        message: t('app.browser_mock.mcp_client.claude_code.installed'),
                        configPath: 'C:/Users/mock/.claude.json',
                        command: 'C:/Program Files/GoNavi/GoNavi.exe',
                        args: ['mcp-server'],
                    };
                },
                AIInstallCodexMCP: async () => {
                    mockMCPClientStatuses = mockMCPClientStatuses.map((item) => item.client === 'codex'
                        ? {
                            ...item,
                            installed: true,
                            matchesCurrent: true,
                            message: t('app.browser_mock.mcp_client.codex.installed'),
                            command: 'C:/Program Files/GoNavi/GoNavi.exe',
                            args: ['mcp-server'],
                        }
                        : item);
                    return {
                        success: true,
                        client: 'codex',
                        message: t('app.browser_mock.mcp_client.codex.installed'),
                        configPath: 'C:/Users/mock/.codex/config.toml',
                        command: 'C:/Program Files/GoNavi/GoNavi.exe',
                        args: ['mcp-server'],
                    };
                },
                AIInstallOpenCodeMCP: async () => {
                    mockMCPClientStatuses = mockMCPClientStatuses.map((item) => item.client === 'opencode'
                        ? {
                            ...item,
                            installed: true,
                            matchesCurrent: true,
                            message: t('app.browser_mock.mcp_client.opencode.installed'),
                            command: 'C:/Program Files/GoNavi/GoNavi.exe',
                            args: ['mcp-server'],
                        }
                        : item);
                    return {
                        success: true,
                        client: 'opencode',
                        message: t('app.browser_mock.mcp_client.opencode.installed'),
                        configPath: 'C:/Users/mock/.config/opencode/opencode.json',
                        command: 'C:/Program Files/GoNavi/GoNavi.exe',
                        args: ['mcp-server'],
                    };
                },
                AISaveMCPServer: async (input: any) => {
                    const next = {
                        id: String(input?.id || `mcp-${Date.now()}`),
                        name: String(input?.name || ''),
                        transport: 'stdio',
                        command: String(input?.command || ''),
                        args: Array.isArray(input?.args) ? [...input.args] : [],
                        env: { ...(input?.env || {}) },
                        enabled: input?.enabled !== false,
                        timeoutSeconds: Number(input?.timeoutSeconds) || 20,
                    };
                    const index = mockMCPServers.findIndex((item) => item.id === next.id);
                    if (index >= 0) mockMCPServers[index] = next;
                    else mockMCPServers.push(next);
                    return null;
                },
                AIDeleteMCPServer: async (id: string) => {
                    mockMCPServers = mockMCPServers.filter((item) => item.id !== id);
                    return null;
                },
                AITestMCPServer: async (input: any) => ({
                    success: String(input?.command || '').trim() !== '',
                    message: String(input?.command || '').trim() !== ''
                        ? t('app.browser_mock.mcp_server.test_success')
                        : t('app.browser_mock.mcp_server.command_required'),
                    tools: [],
                }),
                AIListMCPTools: async () => [],
                AICallMCPTool: async (_alias: string, _argumentsJSON: string) => ({
                    alias: _alias,
                    serverId: '',
                    serverName: '',
                    originalName: _alias,
                    content: t('app.browser_mock.mcp_tool.unavailable'),
                    isError: true,
                }),
                AIGetSkills: async () => cloneBrowserMockValue(mockSkills),
                AISaveSkill: async (input: any) => {
                    const next = {
                        id: String(input?.id || `skill-${Date.now()}`),
                        name: String(input?.name || ''),
                        description: String(input?.description || ''),
                        systemPrompt: String(input?.systemPrompt || ''),
                        enabled: input?.enabled !== false,
                        scopes: Array.isArray(input?.scopes) ? [...input.scopes] : ['global'],
                        requiredTools: Array.isArray(input?.requiredTools) ? [...input.requiredTools] : [],
                    };
                    const index = mockSkills.findIndex((item) => item.id === next.id);
                    if (index >= 0) mockSkills[index] = next;
                    else mockSkills.push(next);
                    return null;
                },
                AIDeleteSkill: async (id: string) => {
                    mockSkills = mockSkills.filter((item) => item.id !== id);
                    return null;
                },
                AITestProvider: async (input: any) => ({
                    success: String(input?.apiKey || '').trim() !== '',
                    message: String(input?.apiKey || '').trim() !== ''
                        ? t('app.browser_mock.provider.test_success')
                        : t('app.browser_mock.provider.test_failed_detail', { detail: 'missing api key' }),
                }),
                AISetSafetyLevel: async (level: string) => {
                    mockAISafetyLevel = String(level || 'readonly');
                    return null;
                },
                AISetContextLevel: async (level: string) => {
                    mockAIContextLevel = String(level || 'schema_only');
                    return null;
                },
                AISetLanguage: async () => null,
            },
        }
    };
    const existingGo = (window as any).go || {};
    (window as any).go = {
        ...mockGo,
        ...existingGo,
        app: {
            ...mockGo.app,
            ...(existingGo.app || {}),
            App: {
                ...mockGo.app.App,
                ...(existingGo.app?.App || {}),
            },
        },
        aiservice: {
            ...mockGo.aiservice,
            ...(existingGo.aiservice || {}),
            Service: {
                ...mockGo.aiservice.Service,
                ...(existingGo.aiservice?.Service || {}),
            },
        },
    };
}
const rootNode = document.getElementById('root')!;

const devHarnessMode = import.meta.env.DEV ? resolveDevHarnessMode() : '';

const readBrowserLanguages = (): string[] => {
    if (typeof navigator === 'undefined') return [];
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
        return [...navigator.languages];
    }
    return navigator.language ? [navigator.language] : [];
};

const serializeBrowserLanguages = (languages: readonly string[]) => languages.join('\n');

const deserializeBrowserLanguages = (snapshot: string) =>
    snapshot ? snapshot.split('\n').filter(Boolean) : [];

const getBrowserLanguageSnapshot = () => serializeBrowserLanguages(readBrowserLanguages());

const subscribeBrowserLanguageChange = (listener: () => void) => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return () => {};
    }
    window.addEventListener('languagechange', listener);
    return () => {
        if (typeof window.removeEventListener === 'function') {
            window.removeEventListener('languagechange', listener);
        }
    };
};

const subscribeStoreHydration = (listener: () => void) => {
    if (useStore.persist.hasHydrated()) {
        listener();
        return () => {};
    }
    return useStore.persist.onFinishHydration(() => {
        listener();
    });
};

const getStoreHydrationSnapshot = () => useStore.persist.hasHydrated();

const Root = ({ rootComponent }: { rootComponent: React.ReactNode }) => {
    const isStoreHydrated = useSyncExternalStore(
        subscribeStoreHydration,
        getStoreHydrationSnapshot,
        getStoreHydrationSnapshot,
    );
    const languagePreference = useStore((state) => state.languagePreference);
    const setLanguagePreference = useStore((state) => state.setLanguagePreference);
    const browserLanguageSnapshot = useSyncExternalStore(
        subscribeBrowserLanguageChange,
        getBrowserLanguageSnapshot,
        getBrowserLanguageSnapshot,
    );

    if (!isStoreHydrated) {
        return null;
    }

    const systemLanguages = deserializeBrowserLanguages(browserLanguageSnapshot);
    const resolvedLanguage = setCurrentLanguage(languagePreference, systemLanguages);
    applyDayjsLocale(resolvedLanguage);

    return (
        <I18nProvider
            preference={languagePreference}
            onPreferenceChange={setLanguagePreference}
            systemLanguages={systemLanguages}
        >
            {rootComponent}
        </I18nProvider>
    );
};

const renderRoot = async () => {
    let rootComponent: React.ReactNode = <App />;
    if (devHarnessMode === 'datagrid-perf') {
        const { default: PerfDataGridHarness } = await import('./dev/PerfDataGridHarness');
        rootComponent = <PerfDataGridHarness />;
    }

    ReactDOM.createRoot(rootNode).render(
      <React.StrictMode>
        <Root rootComponent={rootComponent} />
      </React.StrictMode>,
    );
};

void renderRoot();
