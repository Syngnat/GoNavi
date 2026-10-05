import { resolveBrandIconRemoteSrc } from '../../brand/brandIcons';
import {
    cloneBrowserMockValue, duplicateBrowserMockConnection,
} from '../../utils/browserMockConnections';
import { t } from '../../i18n';
import type { ConnectionEnvironmentType } from '../../typeDefs/connectionTypes';

export interface CreateBrowserMockAppMethodsInput {
    mockConnections: any[];
    mockConnectionSidebarLayoutRef: { current: any; };
    mockConnectionSecrets: Map<string, any>;
    saveMockConnection: (input: any) => { id: string; name: string; environmentType: ConnectionEnvironmentType; config: any; includeDatabases: any; includeDatabasePatterns: any; excludeDatabasePatterns: any; includeRedisDatabases: any; schemaVisibilityByDatabase: any; iconType: any; iconColor: any; hasPrimaryPassword: boolean; hasSSHPassword: boolean; hasProxyPassword: boolean; hasHttpTunnelPassword: boolean; hasMySQLReplicaPassword: boolean; hasMongoReplicaPassword: boolean; hasRedisSentinelPassword: boolean; hasOpaqueURI: boolean; hasOpaqueDSN: boolean; };
    updateMockConnectionVisibility: (input: any) => any;
    mockQueryTables: { table_name: string; table_comment: string; }[];
    mockQueryColumns: { tableName: string; name: string; type: string; comment: string; }[];
    mockSavedQueries: any[];
    mockSavedQueryGroups: any[];
    saveMockQuery: (input: any) => { id: string; name: string; sql: string; connectionId: string; dbName: string; createdAt: number; connectionFingerprint: any; fingerprintVersion: any; bindingStatus: any; originalConnectionId: any; };
    mockDataRootInfoRef: { current: any; };
    saveMockSavedQueryGroup: (input: any) => { id: string; name: string; parentGroupId: string | undefined; queryIds: string[]; childOrder: string[]; };
    uniqueMockStringArray: (value: unknown) => string[];
    deleteMockSavedQueryGroup: (id: string) => void;
    buildMockUpdateInfo: () => { hasUpdate: boolean; channel: "latest" | "dev"; currentVersion: string; latestVersion: string; releaseName: string; releasePublishedAt: string; releaseNotesUrl: string; releaseNotes: string; };
    mockUpdateChannelRef: { current: "latest" | "dev"; };
    mockGlobalProxyRef: { current: any; };
    mockDownloadSourceRef: { current: "cst" | "bero" | "github"; };
    saveMockGlobalProxy: (input: any) => any;
}

export const createBrowserMockAppMethods = ({
    mockConnections, mockConnectionSidebarLayoutRef, mockConnectionSecrets, saveMockConnection,
    updateMockConnectionVisibility, mockQueryTables, mockQueryColumns, mockSavedQueries,
    mockSavedQueryGroups, saveMockQuery, mockDataRootInfoRef, saveMockSavedQueryGroup,
    uniqueMockStringArray, deleteMockSavedQueryGroup, buildMockUpdateInfo, mockUpdateChannelRef,
    mockGlobalProxyRef, mockDownloadSourceRef, saveMockGlobalProxy,
}: CreateBrowserMockAppMethodsInput) => {
    const mockAppMethods = {
        CheckUpdate: async () => ({ success: false }),
        DownloadUpdate: async () => ({ success: false }),
        StartUpdateDownload: async () => ({ success: false, message: 'Browser mock does not provide an update package' }),
        GetUpdateDownloadTask: async () => ({ success: true, data: { task: null } }),
        SetLanguage: async () => null,
        // The native backend downloads, verifies, and caches these immutable
        // assets. Browser/Playwright harnesses have no Go backend, so point
        // image elements at the same origin instead of showing one fallback
        // glyph for the remotely hosted choices.
        GetBrandIconDataURL: async (id: string) => resolveBrandIconRemoteSrc(id),
        GetSavedConnections: async () => cloneBrowserMockValue(mockConnections),
        BootstrapConnectionSidebarLayout: async (input: any) => {
            if (
                !mockConnectionSidebarLayoutRef.current.initialized
                && Array.isArray(input?.connectionTags)
                && input.connectionTags.length > 0
            ) {
                mockConnectionSidebarLayoutRef.current = {
                    initialized: true,
                    revision: 1,
                    connectionTags: cloneBrowserMockValue(input.connectionTags),
                    sidebarRootOrder: cloneBrowserMockValue(input.sidebarRootOrder || []),
                    rootSortMode: 'manual',
                    rootConnectionSortMode: input?.rootConnectionSortMode === 'manual' || input?.rootConnectionSortMode === 'name' ? input.rootConnectionSortMode : 'createdAt',
                };
            }
            return cloneBrowserMockValue(mockConnectionSidebarLayoutRef.current);
        },
        SaveConnectionSidebarLayout: async (input: any) => {
            if (Number(input?.expectedRevision) !== Number(mockConnectionSidebarLayoutRef.current.revision)) {
                return {
                    conflict: true,
                    layout: cloneBrowserMockValue(mockConnectionSidebarLayoutRef.current),
                };
            }
            const layout = input?.layout || {};
            mockConnectionSidebarLayoutRef.current = {
                initialized: true,
                revision: Number(mockConnectionSidebarLayoutRef.current.revision) + 1,
                connectionTags: cloneBrowserMockValue(layout.connectionTags || []),
                sidebarRootOrder: cloneBrowserMockValue(layout.sidebarRootOrder || []),
                rootSortMode: 'manual',
                rootConnectionSortMode: layout.rootConnectionSortMode === 'manual' || layout.rootConnectionSortMode === 'name' ? layout.rootConnectionSortMode : 'createdAt',
            };
            return {
                conflict: false,
                layout: cloneBrowserMockValue(mockConnectionSidebarLayoutRef.current),
            };
        },
        LoadConnectionSidebarLayout: async () => cloneBrowserMockValue(mockConnectionSidebarLayoutRef.current),
        GetEditableSavedConnection: async (id: string) => {
            const existing = mockConnections.find((item) => item.id === id);
            if (!existing) {
                throw new Error(`saved connection not found: ${id}`);
            }
            return cloneBrowserMockValue(existing);
        },
        RevealSavedConnectionPrimaryPassword: async (id: string) => {
            const existing = mockConnections.find((item) => item.id === id);
            if (!existing) {
                throw new Error(`saved connection not found: ${id}`);
            }
            const password = String(mockConnectionSecrets.get(id)?.password || '');
            if (!existing.hasPrimaryPassword || password === '') {
                throw new Error(`saved connection has no stored primary password: ${id}`);
            }
            return password;
        },
        ListInstalledFontFamilies: async () => ({ success: true, data: [] }),
        SaveConnection: async (input: any) => saveMockConnection(input),
        UpdateConnectionVisibility: async (input: any) => updateMockConnectionVisibility(input),
        DeleteConnection: async (id: string) => {
            const index = mockConnections.findIndex((item) => item.id === id);
            if (index >= 0) {
                mockConnections.splice(index, 1);
            }
            mockConnectionSecrets.delete(id);
            return null;
        },
        DeleteConnections: async (ids: string[]) => {
            const requested = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).trim()).filter(Boolean));
            for (let index = mockConnections.length - 1; index >= 0; index -= 1) {
                if (requested.has(String(mockConnections[index]?.id || ''))) {
                    mockConnectionSecrets.delete(mockConnections[index].id);
                    mockConnections.splice(index, 1);
                }
            }
            requested.forEach((id) => mockConnectionSecrets.delete(id));
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
            const existingSecrets = mockConnectionSecrets.get(id);
            if (existingSecrets) {
                mockConnectionSecrets.set(
                    duplicated.id,
                    cloneBrowserMockValue(existingSecrets),
                );
            }
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
        DataSyncCapability: async (sourceConfig: any, targetConfig: any) => {
            const sourceType = String(sourceConfig?.type || sourceConfig?.driver || '').trim().toLowerCase();
            const targetType = String(targetConfig?.type || targetConfig?.driver || '').trim().toLowerCase();
            const canExecute = sourceType !== '' && targetType !== '';
            return {
                sourceType,
                targetType,
                sourceModel: 'custom',
                targetModel: 'custom',
                planner: canExecute ? 'browser-mock-existing-target' : '',
                supportLevel: canExecute ? 'partial' : 'unsupported',
                canExecute,
                supportsAutoCreate: false,
                supportsAutoAddColumns: false,
                requiresExistingTarget: true,
            };
        },
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
            const path = `${mockDataRootInfoRef.current.savedQueryDirectory}/${id}.sql`;
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
        GetDataRootDirectoryInfo: async () => ({ success: true, data: cloneBrowserMockValue(mockDataRootInfoRef.current) }),
        CheckForUpdates: async () => ({
            success: true,
            data: buildMockUpdateInfo(),
        }),
        CheckForUpdatesSilently: async () => ({
            success: true,
            data: buildMockUpdateInfo(),
        }),
        GetUpdateChannel: async () => ({ success: true, data: { channel: mockUpdateChannelRef.current } }),
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
        GetGlobalProxyConfig: async () => ({ success: true, data: cloneBrowserMockValue(mockGlobalProxyRef.current) }),
        GetDownloadSourceConfig: async () => ({ source: mockDownloadSourceRef.current }),
        SaveDownloadSourceConfig: async (source: string) => {
            const normalized = String(source || '').trim().toLowerCase();
            mockDownloadSourceRef.current = normalized === 'bero' || normalized === 'github' ? normalized : 'cst';
            return { source: mockDownloadSourceRef.current };
        },
        SetUpdateChannel: async (channel: string) => {
            mockUpdateChannelRef.current = String(channel || '').trim().toLowerCase() === 'dev' ? 'dev' : 'latest';
            return { success: true, data: { channel: mockUpdateChannelRef.current } };
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
        SelectDataRootDirectory: async (currentPath: string) => ({ success: true, data: { ...mockDataRootInfoRef.current, path: currentPath || mockDataRootInfoRef.current.path } }),
        ApplyDataRootDirectory: async (path: string) => {
            const nextPath = String(path || mockDataRootInfoRef.current.defaultPath);
            mockDataRootInfoRef.current = {
                ...mockDataRootInfoRef.current,
                path: nextPath,
                driverPath: `${nextPath}/drivers`,
                isDefaultPath: nextPath === mockDataRootInfoRef.current.defaultPath,
            };
            return { success: true, message: t('app.data_root.message.updated'), data: cloneBrowserMockValue(mockDataRootInfoRef.current) };
        },
        SelectLogDirectory: async (currentPath: string) => ({
            success: true,
            data: { directory: currentPath || mockDataRootInfoRef.current.defaultLogDirectory },
        }),
        ApplyLogDirectory: async (path: string) => {
            const nextPath = String(path || mockDataRootInfoRef.current.defaultLogDirectory);
            mockDataRootInfoRef.current = {
                ...mockDataRootInfoRef.current,
                logDirectory: nextPath,
                logDirectorySource: nextPath === mockDataRootInfoRef.current.defaultLogDirectory ? 'default' : 'custom',
                logDirectoryRestartRequired: nextPath !== mockDataRootInfoRef.current.activeLogDirectory,
            };
            return {
                success: true,
                message: t('app.data_root.log_directory.message.updated'),
                data: cloneBrowserMockValue(mockDataRootInfoRef.current),
            };
        },
        SelectSavedQueryDirectory: async (currentPath: string) => ({
            success: true,
            data: { directory: currentPath || mockDataRootInfoRef.current.defaultSavedQueryDirectory },
        }),
        ApplySavedQueryDirectory: async (path: string) => {
            const nextPath = String(path || mockDataRootInfoRef.current.defaultSavedQueryDirectory);
            mockDataRootInfoRef.current = {
                ...mockDataRootInfoRef.current,
                savedQueryDirectory: nextPath,
                savedQueryDirectorySource: nextPath === mockDataRootInfoRef.current.defaultSavedQueryDirectory
                    ? 'default'
                    : 'custom',
            };
            return {
                success: true,
                message: t('app.data_root.saved_query_directory.message.updated'),
                data: cloneBrowserMockValue(mockDataRootInfoRef.current),
            };
        },
    };
    return { mockAppMethods };
};
