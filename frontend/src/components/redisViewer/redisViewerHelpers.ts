import { RedisKeyInfo } from '../../types';

export const REDIS_TREE_KEY_TYPE_WIDTH = 92;
export const REDIS_TREE_KEY_TYPE_WIDTH_NARROW = 84;
export const REDIS_TREE_KEY_TTL_WIDTH = 92;
export const REDIS_TREE_HIDE_TTL_THRESHOLD = 460;
const REDIS_KEY_INITIAL_LOAD_COUNT = 100;
const REDIS_KEY_LOAD_MORE_COUNT = 100;
const REDIS_CLUSTER_KEY_INITIAL_LOAD_COUNT = 2000;
const REDIS_CLUSTER_KEY_LOAD_MORE_COUNT = 2000;
const REDIS_KEY_SEARCH_INITIAL_LOAD_COUNT = 100;
const REDIS_KEY_SEARCH_LOAD_MORE_COUNT = 100;
export const REDIS_KEY_SEARCH_MAX_RESULT_COUNT = 10000;
export const REDIS_KEY_VIRTUAL_SCROLL_THRESHOLD = 500;
export const REDIS_LARGE_KEYSPACE_THRESHOLD = 10000;
export const REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS = 200;
const REDIS_KEY_GONE_MESSAGE = 'Redis Key 不存在或已过期';
export const REDIS_VALUE_TABLE_PAGE_SIZE = 50;
export const REDIS_VALUE_TABLE_DEFAULT_SCROLL_HEIGHT = 240;
export const REDIS_VALUE_TABLE_MIN_SCROLL_HEIGHT = 96;

export type RedisExportScope = 'all' | 'selected';
export type RedisImportConflictMode = 'overwrite' | 'skip';
export type RedisListSortOrder = 'ascend' | 'descend' | null;
export type RedisKeyViewMode = 'tree' | 'list' | 'type';
export type RedisImportPreview = {
    file: string;
    exportedAt?: string;
    database: number;
    scope?: string;
    pattern?: string;
    sourceAppName?: string;
    total: number;
    keys: RedisKeyInfo[];
};

export const getRedisScanLoadCount = (pattern: string, append: boolean, isCluster: boolean): number => {
    const normalizedPattern = pattern.trim() || '*';
    if (normalizedPattern === '*') {
        if (isCluster) {
            return append ? REDIS_CLUSTER_KEY_LOAD_MORE_COUNT : REDIS_CLUSTER_KEY_INITIAL_LOAD_COUNT;
        }
        return append ? REDIS_KEY_LOAD_MORE_COUNT : REDIS_KEY_INITIAL_LOAD_COUNT;
    }
    return append ? REDIS_KEY_SEARCH_LOAD_MORE_COUNT : REDIS_KEY_SEARCH_INITIAL_LOAD_COUNT;
};

export const normalizeRedisCursor = (value: unknown): string => {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? '0' : trimmed;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return '0';
        }
        return Math.trunc(value).toString();
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return '0';
};

export const isRedisKeyGoneErrorMessage = (messageText: string): boolean => {
    return messageText.includes(REDIS_KEY_GONE_MESSAGE);
};

export const normalizeToolbarText = (value: unknown): string => String(value || '').trim();
export const extractFilenameFromPath = (value: unknown): string => {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    if (!normalized) {
        return '';
    }
    const segments = normalized.split('/');
    return segments[segments.length - 1] || normalized;
};

export const mergeRedisKeyInfoLists = (existing: RedisKeyInfo[], incoming: RedisKeyInfo[]): RedisKeyInfo[] => {
    const keyMap = new Map<string, RedisKeyInfo>();
    existing.forEach((item) => keyMap.set(item.key, item));
    incoming.forEach((item) => keyMap.set(item.key, item));
    return Array.from(keyMap.values());
};

export const resolveRedisTopology = (connection?: { config?: { topology?: string; hosts?: string[] } }): 'single' | 'replica' | 'cluster' | 'sentinel' => {
    const topology = normalizeToolbarText(connection?.config?.topology).toLowerCase();
    if (topology === 'replica') return 'replica';
    if (topology === 'sentinel') return 'sentinel';
    if (topology === 'cluster') return 'cluster';
    const extraHosts = Array.isArray(connection?.config?.hosts) ? connection.config.hosts.filter(Boolean) : [];
    return extraHosts.length > 0 ? 'cluster' : 'single';
};

export const buildRedisSeedAddresses = (connection?: { config?: { host?: string; port?: number | string; hosts?: string[] } }): string[] => {
    if (!connection) return [];
    const port = Number.isFinite(Number(connection.config?.port)) ? Number(connection.config?.port) : 6379;
    const primaryHost = normalizeToolbarText(connection.config?.host);
    const primary = primaryHost ? `${primaryHost}:${port}` : '';
    const extraHosts = Array.isArray(connection.config?.hosts)
        ? connection.config.hosts.map((host) => normalizeToolbarText(host)).filter(Boolean)
        : [];
    return [primary, ...extraHosts].filter(Boolean);
};

export const getRedisTopologyTagLabel = (topology: 'single' | 'replica' | 'cluster' | 'sentinel'): string => {
    if (topology === 'replica') return 'Replica';
    if (topology === 'cluster') return 'Cluster';
    if (topology === 'sentinel') return 'Sentinel';
    return 'Single';
};
