import { t } from '../../i18n';
import { normalizeConnectionEnvironmentType } from '../../utils/connectionEnvironment';
import {
    cloneBrowserMockValue, resolveBrowserMockSecretFlag,
} from '../../utils/browserMockConnections';

export interface CreateBrowserMockConnectionStoreInput {
    mockConnections: any[];
    mockConnectionSecrets: Map<string, any>;
    mockSavedQueries: any[];
    mockSavedQueryGroups: any[];
    mockGlobalProxyRef: { current: any; };
    mockProviders: any[];
    mockProviderSecrets: Map<string, string>;
    mockActiveProviderIdRef: { current: string; };
}

export const createBrowserMockConnectionStore = ({
    mockConnections, mockConnectionSecrets, mockSavedQueries, mockSavedQueryGroups,
    mockGlobalProxyRef, mockProviders, mockProviderSecrets, mockActiveProviderIdRef,
}: CreateBrowserMockConnectionStoreInput) => {
    const upsertMockConnection = (view: any) => {
        const index = mockConnections.findIndex((item) => item.id === view.id);
        if (index >= 0) {
            mockConnections[index] = view;
            return;
        }
        mockConnections.push(view);
    };

    const retainMockConnectionSecret = (value: unknown, existingValue: unknown): string => {
        const nextValue = String(value ?? '');
        return nextValue !== '' ? nextValue : String(existingValue ?? '');
    };

    const saveMockConnection = (input: any) => {
        const existing = mockConnections.find((item) => item.id === input?.id);
        const hasIncludeDatabases = Object.prototype.hasOwnProperty.call(input || {}, 'includeDatabases');
        const hasIncludeDatabasePatterns = Object.prototype.hasOwnProperty.call(input || {}, 'includeDatabasePatterns');
        const hasExcludeDatabasePatterns = Object.prototype.hasOwnProperty.call(input || {}, 'excludeDatabasePatterns');
        const hasIncludeRedisDatabases = Object.prototype.hasOwnProperty.call(input || {}, 'includeRedisDatabases');
        const hasSchemaVisibilityByDatabase = Object.prototype.hasOwnProperty.call(input || {}, 'schemaVisibilityByDatabase');
        const existingSecrets = existing ? (mockConnectionSecrets.get(existing.id) || {}) : {};
        const config = (input?.config && typeof input.config === 'object') ? input.config : {};
        const ssh = (config.ssh && typeof config.ssh === 'object') ? config.ssh : {};
        const proxy = (config.proxy && typeof config.proxy === 'object') ? config.proxy : {};
        const httpTunnel = (config.httpTunnel && typeof config.httpTunnel === 'object') ? config.httpTunnel : {};
        const nextId = String(input?.id || existing?.id || `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const nextSecrets: Record<string, string> = {
            password: retainMockConnectionSecret(config.password, existingSecrets.password),
            sshPassword: retainMockConnectionSecret(ssh.password, existingSecrets.sshPassword),
            proxyPassword: retainMockConnectionSecret(proxy.password, existingSecrets.proxyPassword),
            httpTunnelPassword: retainMockConnectionSecret(httpTunnel.password, existingSecrets.httpTunnelPassword),
            mysqlReplicaPassword: retainMockConnectionSecret(config.mysqlReplicaPassword, existingSecrets.mysqlReplicaPassword),
            mongoReplicaPassword: retainMockConnectionSecret(config.mongoReplicaPassword, existingSecrets.mongoReplicaPassword),
            redisSentinelPassword: retainMockConnectionSecret(config.redisSentinelPassword, existingSecrets.redisSentinelPassword),
            uri: retainMockConnectionSecret(config.uri, existingSecrets.uri),
            dsn: retainMockConnectionSecret(config.dsn, existingSecrets.dsn),
        };
        if (input?.clearPrimaryPassword) delete nextSecrets.password;
        if (input?.clearSSHPassword) delete nextSecrets.sshPassword;
        if (input?.clearProxyPassword) delete nextSecrets.proxyPassword;
        if (input?.clearHttpTunnelPassword) delete nextSecrets.httpTunnelPassword;
        if (input?.clearMySQLReplicaPassword) delete nextSecrets.mysqlReplicaPassword;
        if (input?.clearMongoReplicaPassword) delete nextSecrets.mongoReplicaPassword;
        if (input?.clearRedisSentinelPassword) delete nextSecrets.redisSentinelPassword;
        if (input?.clearOpaqueURI) delete nextSecrets.uri;
        if (input?.clearOpaqueDSN) delete nextSecrets.dsn;
        Object.entries(nextSecrets).forEach(([key, value]) => {
            if (value === '') delete nextSecrets[key];
        });
        if (Object.keys(nextSecrets).length > 0) {
            mockConnectionSecrets.set(nextId, nextSecrets);
        } else {
            mockConnectionSecrets.delete(nextId);
        }
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
            includeDatabases: hasIncludeDatabases
                ? (Array.isArray(input?.includeDatabases) ? [...input.includeDatabases] : undefined)
                : existing?.includeDatabases,
            includeDatabasePatterns: hasIncludeDatabasePatterns
                ? (Array.isArray(input?.includeDatabasePatterns) ? [...input.includeDatabasePatterns] : undefined)
                : existing?.includeDatabasePatterns,
            excludeDatabasePatterns: hasExcludeDatabasePatterns
                ? (Array.isArray(input?.excludeDatabasePatterns) ? [...input.excludeDatabasePatterns] : undefined)
                : existing?.excludeDatabasePatterns,
            includeRedisDatabases: hasIncludeRedisDatabases
                ? (Array.isArray(input?.includeRedisDatabases) ? [...input.includeRedisDatabases] : undefined)
                : existing?.includeRedisDatabases,
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

    const updateMockConnectionVisibility = (input: any) => {
        const existing = mockConnections.find((item) => item.id === input?.id);
        if (!existing) {
            throw new Error(`saved connection not found: ${String(input?.id || '')}`);
        }
        const updated = {
            ...existing,
            includeDatabases: Array.isArray(input?.includeDatabases) ? [...input.includeDatabases] : undefined,
            includeDatabasePatterns: Array.isArray(input?.includeDatabasePatterns) ? [...input.includeDatabasePatterns] : undefined,
            excludeDatabasePatterns: Array.isArray(input?.excludeDatabasePatterns) ? [...input.excludeDatabasePatterns] : undefined,
            includeRedisDatabases: Array.isArray(input?.includeRedisDatabases) ? [...input.includeRedisDatabases] : undefined,
            schemaVisibilityByDatabase: input?.schemaVisibilityByDatabase && typeof input.schemaVisibilityByDatabase === 'object'
                ? cloneBrowserMockValue(input.schemaVisibilityByDatabase)
                : undefined,
        };
        upsertMockConnection(updated);
        return cloneBrowserMockValue(updated);
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
        mockGlobalProxyRef.current = {
            ...mockGlobalProxyRef.current,
            ...input,
            password: '',
            hasPassword: clearPassword ? false : (nextPassword !== '' ? true : !!mockGlobalProxyRef.current.hasPassword),
            clearPassword: undefined,
        };
        return cloneBrowserMockValue(mockGlobalProxyRef.current);
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
        if (!mockActiveProviderIdRef.current) {
            mockActiveProviderIdRef.current = nextId;
        }
        return cloneBrowserMockValue(view);
    };
    return {
        saveMockConnection, updateMockConnectionVisibility, saveMockQuery, uniqueMockStringArray,
        saveMockSavedQueryGroup, deleteMockSavedQueryGroup, saveMockGlobalProxy, saveMockProvider,
    };
};
