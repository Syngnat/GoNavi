import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ConnectionConfig, ProxyConfig, SavedConnection, TabData, SavedQuery, ConnectionTag } from './types';

const DEFAULT_APPEARANCE = { opacity: 1.0, blur: 0 };
const DEFAULT_UI_SCALE = 1.0;
const MIN_UI_SCALE = 0.8;
const MAX_UI_SCALE = 1.25;
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
const DEFAULT_STARTUP_FULLSCREEN = false;
const LEGACY_DEFAULT_OPACITY = 0.95;
const OPACITY_EPSILON = 1e-6;
const MAX_URI_LENGTH = 4096;
const MAX_HOST_ENTRY_LENGTH = 512;
const MAX_HOST_ENTRIES = 64;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 3600;
const PERSIST_VERSION = 5;
const DEFAULT_CONNECTION_TYPE = 'mysql';
const DEFAULT_GLOBAL_PROXY: GlobalProxyConfig = {
  enabled: false,
  type: 'socks5',
  host: '',
  port: 1080,
  user: '',
  password: '',
};
const SUPPORTED_CONNECTION_TYPES = new Set([
  'mysql',
  'mariadb',
  'doris',
  'diros',
  'sphinx',
  'clickhouse',
  'postgres',
  'redis',
  'tdengine',
  'oracle',
  'dameng',
  'kingbase',
  'sqlserver',
  'mongodb',
  'highgo',
  'vastbase',
  'sqlite',
  'duckdb',
  'custom',
]);

const getDefaultPortByType = (type: string): number => {
  switch (type) {
    case 'mysql':
    case 'mariadb':
      return 3306;
    case 'doris':
    case 'diros':
      return 9030;
    case 'duckdb':
      return 0;
    case 'sphinx':
      return 9306;
    case 'clickhouse':
      return 9000;
    case 'postgres':
    case 'vastbase':
      return 5432;
    case 'redis':
      return 6379;
    case 'tdengine':
      return 6041;
    case 'oracle':
      return 1521;
    case 'dameng':
      return 5236;
    case 'kingbase':
      return 54321;
    case 'sqlserver':
      return 1433;
    case 'mongodb':
      return 27017;
    case 'highgo':
      return 5866;
    default:
      return 3306;
  }
};

const toTrimmedString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return fallback;
};

const normalizePort = (value: unknown, fallbackPort: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackPort;
  const port = Math.trunc(parsed);
  if (port <= 0 || port > 65535) return fallbackPort;
  return port;
};

const normalizeIntegerInRange = (value: unknown, fallbackValue: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackValue;
  const normalized = Math.trunc(parsed);
  if (normalized < min || normalized > max) return fallbackValue;
  return normalized;
};

const normalizeFloatInRange = (value: unknown, fallbackValue: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackValue;
  if (parsed < min || parsed > max) return fallbackValue;
  return parsed;
};

const isValidHostEntry = (entry: string): boolean => {
  if (!entry) return false;
  if (entry.length > MAX_HOST_ENTRY_LENGTH) return false;
  if (/[()\\/\s]/.test(entry)) return false;
  return true;
};

const sanitizeStringArray = (value: unknown, maxLength = 256): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((entry) => {
    const normalized = toTrimmedString(entry);
    if (!normalized || normalized.length > maxLength) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
};

const sanitizeNumberArray = (value: unknown, min: number, max: number): number[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const result: number[] = [];
  value.forEach((entry) => {
    const parsed = Number(entry);
    if (!Number.isFinite(parsed)) return;
    const num = Math.trunc(parsed);
    if (num < min || num > max) return;
    if (seen.has(num)) return;
    seen.add(num);
    result.push(num);
  });
  return result;
};

const sanitizeAddressList = (value: unknown): string[] => {
  const all = sanitizeStringArray(value, MAX_HOST_ENTRY_LENGTH)
    .filter((entry) => isValidHostEntry(entry));
  return all.slice(0, MAX_HOST_ENTRIES);
};

const normalizeConnectionType = (value: unknown): string => {
  const type = toTrimmedString(value).toLowerCase();
  if (type === 'doris') {
    return 'diros';
  }
  return SUPPORTED_CONNECTION_TYPES.has(type) ? type : DEFAULT_CONNECTION_TYPE;
};

const sanitizeConnectionConfig = (value: unknown): ConnectionConfig => {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const type = normalizeConnectionType(raw.type);
  const defaultPort = getDefaultPortByType(type);
  const savePassword = typeof raw.savePassword === 'boolean' ? raw.savePassword : true;
  const mongoSrv = !!raw.mongoSrv;

  const sshRaw = (raw.ssh && typeof raw.ssh === 'object') ? raw.ssh as Record<string, unknown> : {};
  const ssh = {
    host: toTrimmedString(sshRaw.host),
    port: normalizePort(sshRaw.port, 22),
    user: toTrimmedString(sshRaw.user),
    password: toTrimmedString(sshRaw.password),
    keyPath: toTrimmedString(sshRaw.keyPath),
  };
  const proxyRaw = (raw.proxy && typeof raw.proxy === 'object') ? raw.proxy as Record<string, unknown> : {};
  const proxyTypeRaw = toTrimmedString(proxyRaw.type, 'socks5').toLowerCase();
  const proxyType: 'socks5' | 'http' = proxyTypeRaw === 'http' ? 'http' : 'socks5';
  const proxy = {
    type: proxyType,
    host: toTrimmedString(proxyRaw.host),
    port: normalizePort(proxyRaw.port, proxyTypeRaw === 'http' ? 8080 : 1080),
    user: toTrimmedString(proxyRaw.user),
    password: toTrimmedString(proxyRaw.password),
  };

  const safeConfig: ConnectionConfig & Record<string, unknown> = {
    ...raw,
    type,
    host: toTrimmedString(raw.host, 'localhost') || 'localhost',
    port: normalizePort(raw.port, defaultPort),
    user: toTrimmedString(raw.user),
    password: savePassword ? toTrimmedString(raw.password) : '',
    savePassword,
    database: toTrimmedString(raw.database),
    useSSH: !!raw.useSSH,
    ssh,
    useProxy: !!raw.useProxy,
    proxy,
    uri: toTrimmedString(raw.uri).slice(0, MAX_URI_LENGTH),
    hosts: sanitizeAddressList(raw.hosts),
    topology: raw.topology === 'replica' ? 'replica' : (raw.topology === 'cluster' ? 'cluster' : 'single'),
    mysqlReplicaUser: toTrimmedString(raw.mysqlReplicaUser),
    mysqlReplicaPassword: savePassword ? toTrimmedString(raw.mysqlReplicaPassword) : '',
    replicaSet: toTrimmedString(raw.replicaSet),
    authSource: toTrimmedString(raw.authSource),
    readPreference: toTrimmedString(raw.readPreference),
    mongoSrv,
    mongoAuthMechanism: toTrimmedString(raw.mongoAuthMechanism),
    mongoReplicaUser: toTrimmedString(raw.mongoReplicaUser),
    mongoReplicaPassword: savePassword ? toTrimmedString(raw.mongoReplicaPassword) : '',
    timeout: normalizeIntegerInRange(raw.timeout, DEFAULT_TIMEOUT_SECONDS, 1, MAX_TIMEOUT_SECONDS),
  };

  if (type === 'redis') {
    safeConfig.redisDB = normalizeIntegerInRange(raw.redisDB, 0, 0, 15);
  }

  if (type === 'custom') {
    safeConfig.driver = toTrimmedString(raw.driver);
    safeConfig.dsn = toTrimmedString(raw.dsn).slice(0, MAX_URI_LENGTH);
  }

  return safeConfig;
};

const resolveConnectionConfigPayload = (raw: Record<string, unknown>): unknown => {
  if (raw.config && typeof raw.config === 'object') {
    return raw.config;
  }
  // 兼容历史/导入场景：连接对象可能是扁平结构（无 config 包装）。
  const hasLegacyFlatConfig =
    raw.type !== undefined ||
    raw.host !== undefined ||
    raw.port !== undefined ||
    raw.user !== undefined ||
    raw.database !== undefined;
  if (hasLegacyFlatConfig) {
    return raw;
  }
  return undefined;
};

const sanitizeSavedConnection = (value: unknown, index: number): SavedConnection | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const config = sanitizeConnectionConfig(resolveConnectionConfigPayload(raw));
  const id = toTrimmedString(raw.id, `conn-${index + 1}`) || `conn-${index + 1}`;
  const displayType = config.type === 'diros' ? 'doris' : config.type;
  const fallbackName = config.host ? `${displayType}-${config.host}` : `连接-${index + 1}`;
  const name = toTrimmedString(raw.name, fallbackName) || fallbackName;
  const includeDatabases = sanitizeStringArray(raw.includeDatabases, 256);
  const includeRedisDatabases = sanitizeNumberArray(raw.includeRedisDatabases, 0, 15);

  return {
    id,
    name,
    config,
    includeDatabases: includeDatabases.length > 0 ? includeDatabases : undefined,
    includeRedisDatabases: includeRedisDatabases.length > 0 ? includeRedisDatabases : undefined,
  };
};

const sanitizeConnections = (value: unknown): SavedConnection[] => {
  if (!Array.isArray(value)) return [];
  const result: SavedConnection[] = [];
  const idSet = new Set<string>();

  value.forEach((entry, index) => {
    const conn = sanitizeSavedConnection(entry, index);
    if (!conn) return;
    let nextId = conn.id;
    if (idSet.has(nextId)) {
      nextId = `${nextId}-${index + 1}`;
    }
    idSet.add(nextId);
    result.push({ ...conn, id: nextId });
  });

  return result;
};

const sanitizeConnectionTags = (value: unknown): ConnectionTag[] => {
  if (!Array.isArray(value)) return [];
  const result: ConnectionTag[] = [];
  const idSet = new Set<string>();

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const raw = entry as Record<string, unknown>;
    const id = toTrimmedString(raw.id, `tag-${index + 1}`) || `tag-${index + 1}`;
    if (idSet.has(id)) return;
    idSet.add(id);
    
    const name = toTrimmedString(raw.name, `标签-${index + 1}`) || `标签-${index + 1}`;
    const connectionIds = sanitizeStringArray(raw.connectionIds, 256);
    
    result.push({ id, name, connectionIds });
  });

  return result;
};

const isLegacyDefaultAppearance = (appearance: Partial<{ opacity: number; blur: number }> | undefined): boolean => {
  if (!appearance) {
    return true;
  }
  const opacity = typeof appearance.opacity === 'number' ? appearance.opacity : LEGACY_DEFAULT_OPACITY;
  const blur = typeof appearance.blur === 'number' ? appearance.blur : 0;
  return Math.abs(opacity - LEGACY_DEFAULT_OPACITY) < OPACITY_EPSILON && blur === 0;
};

export interface SqlLog {
  id: string;
  timestamp: number;
  sql: string;
  status: 'success' | 'error';
  duration: number;
  message?: string;
  dbName?: string;
  affectedRows?: number;
}

export interface QueryOptions {
  maxRows: number;
  showColumnComment: boolean;
  showColumnType: boolean;
}

export interface GlobalProxyConfig extends ProxyConfig {
  enabled: boolean;
}

interface AppState {
  connections: SavedConnection[];
  connectionTags: ConnectionTag[];
  tabs: TabData[];
  activeTabId: string | null;
  activeContext: { connectionId: string; dbName: string } | null;
  savedQueries: SavedQuery[];
  theme: 'light' | 'dark';
  appearance: { opacity: number; blur: number };
  uiScale: number;
  fontSize: number;
  startupFullscreen: boolean;
  globalProxy: GlobalProxyConfig;
  sqlFormatOptions: { keywordCase: 'upper' | 'lower' };
  queryOptions: QueryOptions;
  sqlLogs: SqlLog[];
  tableAccessCount: Record<string, number>;
  tableSortPreference: Record<string, 'name' | 'frequency'>;

  addConnection: (conn: SavedConnection) => void;
  updateConnection: (conn: SavedConnection) => void;
  removeConnection: (id: string) => void;

  addConnectionTag: (tag: ConnectionTag) => void;
  updateConnectionTag: (tag: ConnectionTag) => void;
  removeConnectionTag: (id: string) => void;
  moveConnectionToTag: (connectionId: string, targetTagId: string | null) => void;
  reorderTags: (tagIds: string[]) => void;

  addTab: (tab: TabData) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToLeft: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  closeTabsByConnection: (connectionId: string) => void;
  closeTabsByDatabase: (connectionId: string, dbName: string) => void;
  moveTab: (sourceId: string, targetId: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (id: string) => void;
  setActiveContext: (context: { connectionId: string; dbName: string } | null) => void;

  saveQuery: (query: SavedQuery) => void;
  deleteQuery: (id: string) => void;

  setTheme: (theme: 'light' | 'dark') => void;
  setAppearance: (appearance: Partial<{ opacity: number; blur: number }>) => void;
  setUiScale: (scale: number) => void;
  setFontSize: (size: number) => void;
  setStartupFullscreen: (enabled: boolean) => void;
  setGlobalProxy: (proxy: Partial<GlobalProxyConfig>) => void;
  setSqlFormatOptions: (options: { keywordCase: 'upper' | 'lower' }) => void;
  setQueryOptions: (options: Partial<QueryOptions>) => void;

  addSqlLog: (log: SqlLog) => void;
  clearSqlLogs: () => void;

  recordTableAccess: (connectionId: string, dbName: string, tableName: string) => void;
  setTableSortPreference: (connectionId: string, dbName: string, sortBy: 'name' | 'frequency') => void;
}

const sanitizeSavedQueries = (value: unknown): SavedQuery[] => {
  if (!Array.isArray(value)) return [];
  const result: SavedQuery[] = [];
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const raw = entry as Record<string, unknown>;
    const id = toTrimmedString(raw.id, `query-${index + 1}`) || `query-${index + 1}`;
    const sql = toTrimmedString(raw.sql);
    const connectionId = toTrimmedString(raw.connectionId);
    const dbName = toTrimmedString(raw.dbName);
    if (!sql || !connectionId || !dbName) return;
    result.push({
      id,
      name: toTrimmedString(raw.name, `查询-${index + 1}`) || `查询-${index + 1}`,
      sql,
      connectionId,
      dbName,
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    });
  });
  return result;
};

const sanitizeTheme = (value: unknown): 'light' | 'dark' => (value === 'dark' ? 'dark' : 'light');

const sanitizeSqlFormatOptions = (value: unknown): { keywordCase: 'upper' | 'lower' } => {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  return { keywordCase: raw.keywordCase === 'lower' ? 'lower' : 'upper' };
};

const sanitizeQueryOptions = (value: unknown): QueryOptions => {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const maxRows = Number(raw.maxRows);
  const showColumnComment = typeof raw.showColumnComment === 'boolean' ? raw.showColumnComment : true;
  const showColumnType = typeof raw.showColumnType === 'boolean' ? raw.showColumnType : true;
  if (!Number.isFinite(maxRows) || maxRows <= 0) {
    return { maxRows: 5000, showColumnComment, showColumnType };
  }
  return { maxRows: Math.min(50000, Math.trunc(maxRows)), showColumnComment, showColumnType };
};

const sanitizeTableAccessCount = (value: unknown): Record<string, number> => {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const result: Record<string, number> = {};
  Object.entries(raw).forEach(([key, count]) => {
    const parsed = Number(count);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    result[key] = Math.trunc(parsed);
  });
  return result;
};

const sanitizeTableSortPreference = (value: unknown): Record<string, 'name' | 'frequency'> => {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const result: Record<string, 'name' | 'frequency'> = {};
  Object.entries(raw).forEach(([key, preference]) => {
    result[key] = preference === 'frequency' ? 'frequency' : 'name';
  });
  return result;
};

const sanitizeAppearance = (
  appearance: Partial<{ opacity: number; blur: number }> | undefined,
  version: number
): { opacity: number; blur: number } => {
  if (!appearance || typeof appearance !== 'object') {
    return { ...DEFAULT_APPEARANCE };
  }
  const nextAppearance = {
    opacity: typeof appearance.opacity === 'number' ? appearance.opacity : DEFAULT_APPEARANCE.opacity,
    blur: typeof appearance.blur === 'number' ? appearance.blur : DEFAULT_APPEARANCE.blur,
  };
  if (version < 2 && isLegacyDefaultAppearance(appearance)) {
    return { ...DEFAULT_APPEARANCE };
  }
  return nextAppearance;
};

const sanitizeStartupFullscreen = (value: unknown): boolean => {
  return value === true;
};

const sanitizeUiScale = (value: unknown): number => {
  return normalizeFloatInRange(value, DEFAULT_UI_SCALE, MIN_UI_SCALE, MAX_UI_SCALE);
};

const sanitizeFontSize = (value: unknown): number => {
  return normalizeIntegerInRange(value, DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE);
};

const sanitizeGlobalProxy = (value: unknown): GlobalProxyConfig => {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const typeRaw = toTrimmedString(raw.type, DEFAULT_GLOBAL_PROXY.type).toLowerCase();
  const type: 'socks5' | 'http' = typeRaw === 'http' ? 'http' : 'socks5';
  const fallbackPort = type === 'http' ? 8080 : 1080;
  return {
    enabled: raw.enabled === true,
    type,
    host: toTrimmedString(raw.host),
    port: normalizePort(raw.port, fallbackPort),
    user: toTrimmedString(raw.user),
    password: toTrimmedString(raw.password),
  };
};

const unwrapPersistedAppState = (persistedState: unknown): Record<string, unknown> => {
  if (!persistedState || typeof persistedState !== 'object') {
    return {};
  }
  const raw = persistedState as Record<string, unknown>;
  if (raw.state && typeof raw.state === 'object') {
    return raw.state as Record<string, unknown>;
  }
  return raw;
};

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      connections: [],
      connectionTags: [],
      tabs: [],
      activeTabId: null,
      activeContext: null,
      savedQueries: [],
      theme: 'light',
      appearance: { ...DEFAULT_APPEARANCE },
      uiScale: DEFAULT_UI_SCALE,
      fontSize: DEFAULT_FONT_SIZE,
      startupFullscreen: DEFAULT_STARTUP_FULLSCREEN,
      globalProxy: { ...DEFAULT_GLOBAL_PROXY },
      sqlFormatOptions: { keywordCase: 'upper' },
      queryOptions: { maxRows: 5000, showColumnComment: true, showColumnType: true },
      sqlLogs: [],
      tableAccessCount: {},
      tableSortPreference: {},

      addConnection: (conn) => set((state) => ({ connections: [...state.connections, conn] })),
      updateConnection: (conn) => set((state) => ({
          connections: state.connections.map(c => c.id === conn.id ? conn : c)
      })),
      removeConnection: (id) => set((state) => ({ 
          connections: state.connections.filter(c => c.id !== id),
          connectionTags: state.connectionTags.map(tag => ({
            ...tag,
            connectionIds: tag.connectionIds.filter(cid => cid !== id)
          }))
      })),

      addConnectionTag: (tag) => set((state) => ({ connectionTags: [...state.connectionTags, tag] })),
      updateConnectionTag: (tag) => set((state) => ({
          connectionTags: state.connectionTags.map(t => t.id === tag.id ? tag : t)
      })),
      removeConnectionTag: (id) => set((state) => ({ 
          connectionTags: state.connectionTags.filter(t => t.id !== id) 
      })),
      moveConnectionToTag: (connectionId, targetTagId) => set((state) => {
          const newTags = state.connectionTags.map(tag => {
              //先从所有tag中移除该connection
              const filteredIds = tag.connectionIds.filter(id => id !== connectionId);
              if (tag.id === targetTagId) {
                  return { ...tag, connectionIds: [...filteredIds, connectionId] };
              }
              return { ...tag, connectionIds: filteredIds };
          });
          return { connectionTags: newTags };
      }),
      reorderTags: (tagIds) => set((state) => {
          const tagMap = new Map(state.connectionTags.map(t => [t.id, t]));
          const newTags: ConnectionTag[] = [];
          tagIds.forEach(id => {
              const tag = tagMap.get(id);
              if (tag) {
                  newTags.push(tag);
                  tagMap.delete(id);
              }
          });
          // 追加未指定的tag（如果有的话）
          newTags.push(...Array.from(tagMap.values()));
          return { connectionTags: newTags };
      }),

      addTab: (tab) => set((state) => {
        const index = state.tabs.findIndex(t => t.id === tab.id);
        if (index !== -1) {
            // Update existing tab with new data (e.g. switch initialTab)
            const newTabs = [...state.tabs];
            newTabs[index] = { ...newTabs[index], ...tab };
            return { tabs: newTabs, activeTabId: tab.id };
        }
        return { tabs: [...state.tabs, tab], activeTabId: tab.id };
      }),
      
      closeTab: (id) => set((state) => {
        const newTabs = state.tabs.filter(t => t.id !== id);
        let newActiveId = state.activeTabId;
        if (state.activeTabId === id) {
          newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
        }
        return { tabs: newTabs, activeTabId: newActiveId };
      }),

      closeOtherTabs: (id) => set((state) => {
        const keep = state.tabs.find(t => t.id === id);
        if (!keep) return state;
        return { tabs: [keep], activeTabId: id };
      }),

      closeTabsToLeft: (id) => set((state) => {
        const index = state.tabs.findIndex(t => t.id === id);
        if (index === -1) return state;
        const newTabs = state.tabs.slice(index);
        const activeStillExists = state.activeTabId ? newTabs.some(t => t.id === state.activeTabId) : false;
        return { tabs: newTabs, activeTabId: activeStillExists ? state.activeTabId : id };
      }),

      closeTabsToRight: (id) => set((state) => {
        const index = state.tabs.findIndex(t => t.id === id);
        if (index === -1) return state;
        const newTabs = state.tabs.slice(0, index + 1);
        const activeStillExists = state.activeTabId ? newTabs.some(t => t.id === state.activeTabId) : false;
        return { tabs: newTabs, activeTabId: activeStillExists ? state.activeTabId : id };
      }),

      closeTabsByConnection: (connectionId) => set((state) => {
        const targetConnectionId = String(connectionId || '').trim();
        if (!targetConnectionId) return state;
        const newTabs = state.tabs.filter(t => String(t.connectionId || '').trim() !== targetConnectionId);
        const activeStillExists = state.activeTabId ? newTabs.some(t => t.id === state.activeTabId) : false;
        const nextActiveTabId = activeStillExists
          ? state.activeTabId
          : (newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
        const nextActiveContext = state.activeContext?.connectionId === targetConnectionId ? null : state.activeContext;
        return {
          tabs: newTabs,
          activeTabId: nextActiveTabId,
          activeContext: nextActiveContext,
        };
      }),

      closeTabsByDatabase: (connectionId, dbName) => set((state) => {
        const targetConnectionId = String(connectionId || '').trim();
        const targetDbName = String(dbName || '').trim();
        if (!targetConnectionId || !targetDbName) return state;
        const newTabs = state.tabs.filter((tab) => {
          const sameConnection = String(tab.connectionId || '').trim() === targetConnectionId;
          const sameDb = String(tab.dbName || '').trim() === targetDbName;
          return !(sameConnection && sameDb);
        });
        const activeStillExists = state.activeTabId ? newTabs.some(t => t.id === state.activeTabId) : false;
        const nextActiveTabId = activeStillExists
          ? state.activeTabId
          : (newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
        const sameActiveContext = state.activeContext
          && state.activeContext.connectionId === targetConnectionId
          && state.activeContext.dbName === targetDbName;
        return {
          tabs: newTabs,
          activeTabId: nextActiveTabId,
          activeContext: sameActiveContext ? null : state.activeContext,
        };
      }),

      moveTab: (sourceId, targetId) => set((state) => {
        const fromId = String(sourceId || '').trim();
        const toId = String(targetId || '').trim();
        if (!fromId || !toId || fromId === toId) {
          return state;
        }
        const fromIndex = state.tabs.findIndex((tab) => tab.id === fromId);
        const toIndex = state.tabs.findIndex((tab) => tab.id === toId);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
          return state;
        }
        const nextTabs = [...state.tabs];
        const [movingTab] = nextTabs.splice(fromIndex, 1);
        nextTabs.splice(toIndex, 0, movingTab);
        return { tabs: nextTabs };
      }),

      closeAllTabs: () => set(() => ({ tabs: [], activeTabId: null })),
      
      setActiveTab: (id) => set({ activeTabId: id }),
      setActiveContext: (context) => set({ activeContext: context }),

      saveQuery: (query) => set((state) => {
        // If query with same ID exists, update it
        const existing = state.savedQueries.find(q => q.id === query.id);
        if (existing) {
             return { savedQueries: state.savedQueries.map(q => q.id === query.id ? query : q) };
        }
        return { savedQueries: [...state.savedQueries, query] };
      }),

      deleteQuery: (id) => set((state) => ({ savedQueries: state.savedQueries.filter(q => q.id !== id) })),

      setTheme: (theme) => set({ theme }),
      setAppearance: (appearance) => set((state) => ({ appearance: { ...state.appearance, ...appearance } })),
      setUiScale: (scale) => set({ uiScale: sanitizeUiScale(scale) }),
      setFontSize: (size) => set({ fontSize: sanitizeFontSize(size) }),
      setStartupFullscreen: (enabled) => set({ startupFullscreen: !!enabled }),
      setGlobalProxy: (proxy) => set((state) => ({ globalProxy: sanitizeGlobalProxy({ ...state.globalProxy, ...proxy }) })),
      setSqlFormatOptions: (options) => set({ sqlFormatOptions: options }),
      setQueryOptions: (options) => set((state) => ({ queryOptions: { ...state.queryOptions, ...options } })),

      addSqlLog: (log) => set((state) => ({ sqlLogs: [log, ...state.sqlLogs].slice(0, 1000) })), // Keep last 1000 logs
      clearSqlLogs: () => set({ sqlLogs: [] }),

      recordTableAccess: (connectionId, dbName, tableName) => set((state) => {
        const key = `${connectionId}-${dbName}-${tableName}`;
        const currentCount = state.tableAccessCount[key] || 0;
        return {
          tableAccessCount: {
            ...state.tableAccessCount,
            [key]: currentCount + 1
          }
        };
      }),

      setTableSortPreference: (connectionId, dbName, sortBy) => set((state) => {
        const key = `${connectionId}-${dbName}`;
        return {
          tableSortPreference: {
            ...state.tableSortPreference,
            [key]: sortBy
          }
        };
      }),
    }),
    {
      name: 'lite-db-storage', // name of the item in the storage (must be unique)
      version: PERSIST_VERSION,
      migrate: (persistedState: unknown, version: number) => {
        const state = unwrapPersistedAppState(persistedState) as Partial<AppState>;
        const nextState: Partial<AppState> = { ...state };
        nextState.connections = sanitizeConnections(state.connections);
        if (version < 5) {
          nextState.connectionTags = sanitizeConnectionTags(state.connectionTags);
        } else {
          nextState.connectionTags = sanitizeConnectionTags(state.connectionTags);
        }
        nextState.savedQueries = sanitizeSavedQueries(state.savedQueries);
        nextState.theme = sanitizeTheme(state.theme);
        nextState.appearance = sanitizeAppearance(state.appearance, version);
        nextState.uiScale = sanitizeUiScale(state.uiScale);
        nextState.fontSize = sanitizeFontSize(state.fontSize);
        nextState.startupFullscreen = sanitizeStartupFullscreen(state.startupFullscreen);
        nextState.globalProxy = sanitizeGlobalProxy(state.globalProxy);
        nextState.sqlFormatOptions = sanitizeSqlFormatOptions(state.sqlFormatOptions);
        nextState.queryOptions = sanitizeQueryOptions(state.queryOptions);
        nextState.tableAccessCount = sanitizeTableAccessCount(state.tableAccessCount);
        nextState.tableSortPreference = sanitizeTableSortPreference(state.tableSortPreference);
        return nextState as AppState;
      },
      merge: (persistedState, currentState) => {
        const state = unwrapPersistedAppState(persistedState) as Partial<AppState>;
        return {
          ...currentState,
          ...state,
          connections: sanitizeConnections(state.connections),
          connectionTags: sanitizeConnectionTags(state.connectionTags),
          savedQueries: sanitizeSavedQueries(state.savedQueries),
          theme: sanitizeTheme(state.theme),
          appearance: sanitizeAppearance(state.appearance, PERSIST_VERSION),
          uiScale: sanitizeUiScale(state.uiScale),
          fontSize: sanitizeFontSize(state.fontSize),
          startupFullscreen: sanitizeStartupFullscreen(state.startupFullscreen),
          globalProxy: sanitizeGlobalProxy(state.globalProxy),
          sqlFormatOptions: sanitizeSqlFormatOptions(state.sqlFormatOptions),
          queryOptions: sanitizeQueryOptions(state.queryOptions),
          tableAccessCount: sanitizeTableAccessCount(state.tableAccessCount),
          tableSortPreference: sanitizeTableSortPreference(state.tableSortPreference),
        };
      },
      partialize: (state) => ({
        connections: state.connections,
        connectionTags: state.connectionTags,
        savedQueries: state.savedQueries,
        theme: state.theme,
        appearance: state.appearance,
        uiScale: state.uiScale,
        fontSize: state.fontSize,
        startupFullscreen: state.startupFullscreen,
        globalProxy: state.globalProxy,
        sqlFormatOptions: state.sqlFormatOptions,
        queryOptions: state.queryOptions,
        tableAccessCount: state.tableAccessCount,
        tableSortPreference: state.tableSortPreference
      }), // Don't persist logs
    }
  )
);
