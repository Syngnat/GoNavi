import type { SavedConnection, SavedQuery, SavedQueryGroup,
  SavedQueryParam,
} from '../types';
import { t as translate } from '../i18n';
import { LEGACY_PERSIST_KEY } from './legacyConnectionStorage';
import { normalizeSavedQueryGroups } from './savedQueryGroups';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export interface SavedQueryImportPayload {
  queries: SavedQuery[];
  groups?: SavedQueryGroup[];
  legacyConnections?: SavedConnection[];
}

export interface SavedQueryBackend {
  GetSavedQueries?: () => Promise<SavedQuery[]>;
  SaveQuery?: (query: SavedQuery) => Promise<SavedQuery | null | undefined>;
  ImportSavedQueries?: (payload: SavedQueryImportPayload) => Promise<SavedQuery[]>;
  DeleteQuery?: (id: string) => Promise<void>;
  RebindSavedQuery?: (id: string, connectionId: string) => Promise<SavedQuery>;
  GetSavedQueryGroups?: () => Promise<SavedQueryGroup[]>;
  SaveSavedQueryGroup?: (group: SavedQueryGroup) => Promise<SavedQueryGroup | null | undefined>;
  DeleteSavedQueryGroup?: (id: string) => Promise<void>;
  MoveSavedQueryToGroup?: (queryId: string, groupId: string) => Promise<void>;
  MoveSavedQueryGroup?: (groupId: string, parentGroupId: string) => Promise<void>;
}

export interface SavedQueryBootstrapArgs {
  backend?: SavedQueryBackend;
  replaceSavedQueries: (queries: SavedQuery[]) => void;
  storage?: StorageLike;
}

export interface SavedQueryBootstrapResult {
  importedLegacyCount: number;
  loadedCount: number;
}

let capturedLegacySavedQuerySource: SavedQueryImportPayload = { queries: [] };

const toTrimmedString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return fallback;
};

const unwrapPersistedAppState = (payload: unknown): Record<string, unknown> => {
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  const raw = payload as Record<string, unknown>;
  if (raw.state && typeof raw.state === 'object') {
    return raw.state as Record<string, unknown>;
  }
  return raw;
};

const resolveGeneratedSavedQueryName = (index: number): string => (
  translate('saved_query.default_name', { index: index + 1 })
);

const sanitizeSavedQuery = (value: unknown, index: number): SavedQuery | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = toTrimmedString(raw.id, `query-${index + 1}`) || `query-${index + 1}`;
  const sql = typeof raw.sql === 'string' ? raw.sql : toTrimmedString(raw.sql);
  const connectionId = toTrimmedString(raw.connectionId);
  const dbName = toTrimmedString(raw.dbName);
  // SQL 允许为空：清空编辑器是合法编辑状态，空内容按 0 字节 .sql 落盘。
  // 绑定上下文仍必填，否则条目无法在侧边栏恢复定位。
  if (!connectionId || !dbName) {
    return null;
  }
  const query: SavedQuery = {
    id,
    name: toTrimmedString(raw.name, resolveGeneratedSavedQueryName(index)) || resolveGeneratedSavedQueryName(index),
    sql,
    connectionId,
    dbName,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
  };
  const connectionFingerprint = toTrimmedString(raw.connectionFingerprint);
  const fingerprintVersion = toTrimmedString(raw.fingerprintVersion);
  const bindingStatus = toTrimmedString(raw.bindingStatus);
  const originalConnectionId = toTrimmedString(raw.originalConnectionId);
  if (connectionFingerprint) query.connectionFingerprint = connectionFingerprint;
  if (fingerprintVersion) query.fingerprintVersion = fingerprintVersion;
  if (bindingStatus) query.bindingStatus = bindingStatus;
  if (originalConnectionId) query.originalConnectionId = originalConnectionId;
  const parameters = sanitizeSavedQueryParameters(raw.parameters);
  if (parameters.length > 0) query.parameters = parameters;
  return query;
};

const SAVED_QUERY_PARAM_TYPES = new Set(['string', 'number', 'boolean', 'datetime', 'null', 'list']);

// 参数声明白名单过滤：与后端 normalizeSavedQueryParameters 语义一致，
// 丢弃空名/未知类型/重复名，防止导入或共享文件注入任意类型。
const sanitizeSavedQueryParameters = (value: unknown): SavedQueryParam[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: SavedQueryParam[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const name = toTrimmedString(raw.name);
    if (!name || seen.has(name)) continue;
    const type = toTrimmedString(raw.type) || 'string';
    if (!SAVED_QUERY_PARAM_TYPES.has(type)) continue;
    seen.add(name);
    result.push({ name, type, label: toTrimmedString(raw.label), default: raw.default });
  }
  return result;
};

export const sanitizeSavedQueries = (value: unknown): SavedQuery[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: SavedQuery[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const query = sanitizeSavedQuery(item, index);
    if (!query || seen.has(query.id)) {
      return;
    }
    seen.add(query.id);
    result.push(query);
  });
  return result;
};

const mergeSavedQueriesById = (...groups: SavedQuery[][]): SavedQuery[] => {
  const result: SavedQuery[] = [];
  const indexById = new Map<string, number>();
  groups.flat().forEach((query) => {
    if (!query.id) {
      return;
    }
    const existingIndex = indexById.get(query.id);
    if (existingIndex === undefined) {
      indexById.set(query.id, result.length);
      result.push(query);
      return;
    }
    result[existingIndex] = query;
  });
  return result;
};

const sanitizeLegacyConnections = (value: unknown): SavedConnection[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is SavedConnection => !!item && typeof item === 'object');
};

const mergeLegacyConnectionsById = (...groups: SavedConnection[][]): SavedConnection[] => {
  const result: SavedConnection[] = [];
  const indexById = new Map<string, number>();
  groups.flat().forEach((connection) => {
    const id = toTrimmedString((connection as { id?: unknown }).id);
    if (!id) {
      return;
    }
    const existingIndex = indexById.get(id);
    if (existingIndex === undefined) {
      indexById.set(id, result.length);
      result.push(connection);
      return;
    }
    result[existingIndex] = connection;
  });
  return result;
};

const mergeSavedQueryImportSources = (...sources: SavedQueryImportPayload[]): SavedQueryImportPayload => {
  return {
    queries: mergeSavedQueriesById(...sources.map((source) => source.queries || [])),
    legacyConnections: mergeLegacyConnectionsById(...sources.map((source) => source.legacyConnections || [])),
  };
};

export const captureLegacySavedQueriesSnapshot = (value: unknown, legacyConnections?: unknown): void => {
  const nextQueries = sanitizeSavedQueries(value);
  if (nextQueries.length === 0) {
    return;
  }
  capturedLegacySavedQuerySource = mergeSavedQueryImportSources(capturedLegacySavedQuerySource, {
    queries: nextQueries,
    legacyConnections: sanitizeLegacyConnections(legacyConnections),
  });
};

export const readLegacySavedQuerySourceFromPayload = (payload: string | null | undefined): SavedQueryImportPayload => {
  if (!payload || typeof payload !== 'string') {
    return { queries: [] };
  }
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const state = unwrapPersistedAppState(parsed);
    return {
      queries: sanitizeSavedQueries(state.savedQueries),
      legacyConnections: sanitizeLegacyConnections(state.connections),
    };
  } catch {
    return { queries: [] };
  }
};

export const readLegacySavedQueriesFromPayload = (payload: string | null | undefined): SavedQuery[] => (
  readLegacySavedQuerySourceFromPayload(payload).queries
);

export const stripLegacySavedQueries = (payload: string | null | undefined): string => {
  if (!payload || typeof payload !== 'string') {
    return '';
  }
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const state = unwrapPersistedAppState(parsed);
    if (state.savedQueries === undefined) {
      return payload;
    }
    delete state.savedQueries;
    return JSON.stringify(parsed);
  } catch {
    return payload;
  }
};

const resolveStorage = (storage?: StorageLike): StorageLike | undefined => {
  if (storage) {
    return storage;
  }
  if (typeof window === 'undefined') {
    return undefined;
  }
  return window.localStorage;
};

const readLegacySavedQuerySourceFromStorage = (storage?: StorageLike): SavedQueryImportPayload => {
  const rawPayload = storage?.getItem(LEGACY_PERSIST_KEY) ?? null;
  return readLegacySavedQuerySourceFromPayload(rawPayload);
};

const cleanupLegacySavedQueriesFromStorage = (storage?: StorageLike): void => {
  const rawPayload = storage?.getItem(LEGACY_PERSIST_KEY) ?? null;
  const sanitizedPayload = stripLegacySavedQueries(rawPayload);
  if (sanitizedPayload && sanitizedPayload !== rawPayload) {
    storage?.setItem(LEGACY_PERSIST_KEY, sanitizedPayload);
  }
};

export const saveSavedQueryToBackend = async (
  backend: SavedQueryBackend | undefined,
  query: SavedQuery,
): Promise<SavedQuery> => {
  const sanitized = sanitizeSavedQuery(query, 0);
  if (!sanitized) {
    throw new Error(translate('saved_query.error.missing_context'));
  }
  if (typeof backend?.SaveQuery !== 'function') {
    return sanitized;
  }
  const saved = await backend.SaveQuery(sanitized);
  return sanitizeSavedQuery(saved || sanitized, 0) || sanitized;
};

export const deleteSavedQueryFromBackend = async (
  backend: SavedQueryBackend | undefined,
  id: string,
): Promise<void> => {
  if (typeof backend?.DeleteQuery === 'function') {
    await backend.DeleteQuery(id);
  }
};

const savedQueryGroupBackendUnavailable = (): Error => (
  new Error(translate('sidebar.saved_query_group.error.backend_unavailable'))
);

const savedQueryGroupInvalidInput = (): Error => (
  new Error(translate('sidebar.saved_query_group.error.invalid_input'))
);

const sanitizeSavedQueryGroupInput = (group: SavedQueryGroup): SavedQueryGroup | null => {
  const name = toTrimmedString(group?.name);
  if (!name) return null;
  const seenQueryIds = new Set<string>();
  const queryIds = Array.isArray(group?.queryIds)
    ? group.queryIds.reduce<string[]>((result, queryId) => {
      const id = toTrimmedString(queryId);
      if (!id || seenQueryIds.has(id)) return result;
      seenQueryIds.add(id);
      result.push(id);
      return result;
    }, [])
    : [];
  const seenTokens = new Set<string>();
  const childOrder = Array.isArray(group?.childOrder)
    ? group.childOrder.reduce<string[]>((result, token) => {
      const value = toTrimmedString(token);
      if (!value || seenTokens.has(value)) return result;
      seenTokens.add(value);
      result.push(value);
      return result;
    }, [])
    : [];
  const sanitized: SavedQueryGroup = {
    id: toTrimmedString(group?.id),
    name,
    parentGroupId: toTrimmedString(group?.parentGroupId),
    queryIds,
    childOrder,
  };
  return sanitized;
};

export const getSavedQueryGroupsFromBackend = async (
  backend: SavedQueryBackend | undefined,
): Promise<SavedQueryGroup[]> => {
  if (typeof backend?.GetSavedQueryGroups !== 'function') {
    return [];
  }
  return normalizeSavedQueryGroups(await backend.GetSavedQueryGroups());
};

export const saveSavedQueryGroupToBackend = async (
  backend: SavedQueryBackend | undefined,
  group: SavedQueryGroup,
): Promise<SavedQueryGroup> => {
  const sanitized = sanitizeSavedQueryGroupInput(group);
  if (!sanitized) {
    throw savedQueryGroupInvalidInput();
  }
  if (typeof backend?.SaveSavedQueryGroup !== 'function') {
    throw savedQueryGroupBackendUnavailable();
  }
  const saved = await backend.SaveSavedQueryGroup(sanitized);
  const persisted = saved ? sanitizeSavedQueryGroupInput(saved) : null;
  if (!persisted || !persisted.id) {
    throw savedQueryGroupInvalidInput();
  }
  return persisted;
};

export const deleteSavedQueryGroupFromBackend = async (
  backend: SavedQueryBackend | undefined,
  id: string,
): Promise<void> => {
  const targetId = toTrimmedString(id);
  if (!targetId) throw savedQueryGroupInvalidInput();
  if (typeof backend?.DeleteSavedQueryGroup !== 'function') {
    throw savedQueryGroupBackendUnavailable();
  }
  await backend.DeleteSavedQueryGroup(targetId);
};

export const moveSavedQueryToGroupInBackend = async (
  backend: SavedQueryBackend | undefined,
  queryId: string,
  groupId?: string | null,
): Promise<void> => {
  const targetQueryId = toTrimmedString(queryId);
  if (!targetQueryId) throw savedQueryGroupInvalidInput();
  if (typeof backend?.MoveSavedQueryToGroup !== 'function') {
    throw savedQueryGroupBackendUnavailable();
  }
  await backend.MoveSavedQueryToGroup(targetQueryId, toTrimmedString(groupId));
};

export const moveSavedQueryGroupInBackend = async (
  backend: SavedQueryBackend | undefined,
  groupId: string,
  parentGroupId?: string | null,
): Promise<void> => {
  const targetGroupId = toTrimmedString(groupId);
  if (!targetGroupId) throw savedQueryGroupInvalidInput();
  if (typeof backend?.MoveSavedQueryGroup !== 'function') {
    throw savedQueryGroupBackendUnavailable();
  }
  await backend.MoveSavedQueryGroup(targetGroupId, toTrimmedString(parentGroupId));
};

export async function bootstrapSavedQueries(args: SavedQueryBootstrapArgs): Promise<SavedQueryBootstrapResult> {
  const storage = resolveStorage(args.storage);
  const storageLegacySource = readLegacySavedQuerySourceFromStorage(storage);
  const legacySource = mergeSavedQueryImportSources(capturedLegacySavedQuerySource, storageLegacySource);
  const legacyQueries = legacySource.queries;
  let importedLegacyCount = 0;

  if (legacyQueries.length > 0) {
    if (typeof args.backend?.ImportSavedQueries === 'function') {
      await args.backend.ImportSavedQueries(legacySource);
      importedLegacyCount = legacyQueries.length;
      capturedLegacySavedQuerySource = { queries: [] };
      cleanupLegacySavedQueriesFromStorage(storage);
    } else if (typeof args.backend?.SaveQuery === 'function') {
      for (const query of legacyQueries) {
        await args.backend.SaveQuery(query);
      }
      importedLegacyCount = legacyQueries.length;
      capturedLegacySavedQuerySource = { queries: [] };
      cleanupLegacySavedQueriesFromStorage(storage);
    }
  }

  let loadedQueries: SavedQuery[] = [];
  if (typeof args.backend?.GetSavedQueries === 'function') {
    loadedQueries = sanitizeSavedQueries(await args.backend.GetSavedQueries());
  }
  if (loadedQueries.length === 0 && importedLegacyCount === 0 && legacyQueries.length > 0) {
    loadedQueries = legacyQueries;
  }
  args.replaceSavedQueries(loadedQueries);

  return {
    importedLegacyCount,
    loadedCount: loadedQueries.length,
  };
}
