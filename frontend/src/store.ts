import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ConnectionConfig, SavedConnection, TabData, SavedQuery } from './types';

const DEFAULT_APPEARANCE = { opacity: 1.0, blur: 0 };
const LEGACY_DEFAULT_OPACITY = 0.95;
const OPACITY_EPSILON = 1e-6;
const MAX_URI_LENGTH = 4096;
const MAX_HOST_ENTRY_LENGTH = 512;
const MAX_HOST_ENTRIES = 64;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_CONNECTION_TYPE = 'mysql';
const SUPPORTED_CONNECTION_TYPES = new Set([
  'mysql',
  'mariadb',
  'sphinx',
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
  'custom',
]);

const getDefaultPortByType = (type: string): number => {
  switch (type) {
    case 'mysql':
    case 'mariadb':
      return 3306;
    case 'sphinx':
      return 9306;
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
    uri: toTrimmedString(raw.uri).slice(0, MAX_URI_LENGTH),
    hosts: sanitizeAddressList(raw.hosts),
    topology: raw.topology === 'replica' ? 'replica' : 'single',
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

const sanitizeSavedConnection = (value: unknown, index: number): SavedConnection | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const config = sanitizeConnectionConfig(raw.config);
  const id = toTrimmedString(raw.id, `conn-${index + 1}`) || `conn-${index + 1}`;
  const fallbackName = config.host ? `${config.type}-${config.host}` : `连接-${index + 1}`;
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

interface AppState {
  connections: SavedConnection[];
  tabs: TabData[];
  activeTabId: string | null;
  activeContext: { connectionId: string; dbName: string } | null;
  savedQueries: SavedQuery[];
  theme: 'light' | 'dark';
  appearance: { opacity: number; blur: number };
  sqlFormatOptions: { keywordCase: 'upper' | 'lower' };
  queryOptions: { maxRows: number };
  sqlLogs: SqlLog[];
  tableAccessCount: Record<string, number>;
  tableSortPreference: Record<string, 'name' | 'frequency'>;

  addConnection: (conn: SavedConnection) => void;
  updateConnection: (conn: SavedConnection) => void;
  removeConnection: (id: string) => void;

  addTab: (tab: TabData) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToLeft: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  closeTabsByConnection: (connectionId: string) => void;
  closeTabsByDatabase: (connectionId: string, dbName: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (id: string) => void;
  setActiveContext: (context: { connectionId: string; dbName: string } | null) => void;

  saveQuery: (query: SavedQuery) => void;
  deleteQuery: (id: string) => void;

  setTheme: (theme: 'light' | 'dark') => void;
  setAppearance: (appearance: Partial<{ opacity: number; blur: number }>) => void;
  setSqlFormatOptions: (options: { keywordCase: 'upper' | 'lower' }) => void;
  setQueryOptions: (options: Partial<{ maxRows: number }>) => void;

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

const sanitizeQueryOptions = (value: unknown): { maxRows: number } => {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const maxRows = Number(raw.maxRows);
  if (!Number.isFinite(maxRows) || maxRows <= 0) {
    return { maxRows: 5000 };
  }
  return { maxRows: Math.min(50000, Math.trunc(maxRows)) };
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

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      connections: [],
      tabs: [],
      activeTabId: null,
      activeContext: null,
      savedQueries: [],
      theme: 'light',
      appearance: { ...DEFAULT_APPEARANCE },
      sqlFormatOptions: { keywordCase: 'upper' },
      queryOptions: { maxRows: 5000 },
      sqlLogs: [],
      tableAccessCount: {},
      tableSortPreference: {},

      addConnection: (conn) => set((state) => ({ connections: [...state.connections, conn] })),
      updateConnection: (conn) => set((state) => ({
          connections: state.connections.map(c => c.id === conn.id ? conn : c)
      })),
      removeConnection: (id) => set((state) => ({ connections: state.connections.filter(c => c.id !== id) })),

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
      version: 3,
      migrate: (persistedState: unknown, version: number) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return persistedState as AppState;
        }
        const state = persistedState as Partial<AppState>;
        const nextState: Partial<AppState> = { ...state };
        nextState.connections = sanitizeConnections(state.connections);
        nextState.savedQueries = sanitizeSavedQueries(state.savedQueries);
        nextState.theme = sanitizeTheme(state.theme);
        nextState.appearance = sanitizeAppearance(state.appearance, version);
        nextState.sqlFormatOptions = sanitizeSqlFormatOptions(state.sqlFormatOptions);
        nextState.queryOptions = sanitizeQueryOptions(state.queryOptions);
        nextState.tableAccessCount = sanitizeTableAccessCount(state.tableAccessCount);
        nextState.tableSortPreference = sanitizeTableSortPreference(state.tableSortPreference);
        return nextState as AppState;
      },
      merge: (persistedState, currentState) => {
        const state = (persistedState && typeof persistedState === 'object')
          ? persistedState as Partial<AppState>
          : {};
        return {
          ...currentState,
          ...state,
          connections: sanitizeConnections(state.connections),
          savedQueries: sanitizeSavedQueries(state.savedQueries),
          theme: sanitizeTheme(state.theme),
          appearance: sanitizeAppearance(state.appearance, 3),
          sqlFormatOptions: sanitizeSqlFormatOptions(state.sqlFormatOptions),
          queryOptions: sanitizeQueryOptions(state.queryOptions),
          tableAccessCount: sanitizeTableAccessCount(state.tableAccessCount),
          tableSortPreference: sanitizeTableSortPreference(state.tableSortPreference),
        };
      },
      partialize: (state) => ({
        connections: state.connections,
        savedQueries: state.savedQueries,
        theme: state.theme,
        appearance: state.appearance,
        sqlFormatOptions: state.sqlFormatOptions,
        queryOptions: state.queryOptions,
        tableAccessCount: state.tableAccessCount,
        tableSortPreference: state.tableSortPreference
      }), // Don't persist logs
    }
  )
);
