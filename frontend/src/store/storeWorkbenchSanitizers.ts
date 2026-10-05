import {
  AIChatMessage,
  SqlSnippet,
  ExternalSQLDirectory,
  TabData,
  TableExportHistoryEntry,
} from "../types";
import { normalizeExternalSQLPath, buildExternalSQLDirectoryId } from "../utils/externalSqlTree";
import { DEFAULT_SQL_SNIPPETS } from "../utils/sqlSnippetDefaults";
import { t as translate } from "../i18n";
import {
  getPersistedQueryTabDraftEntry,
  listPersistedQueryTabDraftEntries,
} from "../utils/sqlFileTabDrafts";
import { toTrimmedString, indexedStoreFallback } from "./storeConnectionSanitizers";
import type {
  RecentConnectionTarget,
  RecentSQLFile,
  AppState,
  ActiveContext,
} from "./storeStateTypes";
import {
  MAX_RECENT_TARGET_DATABASE_LENGTH,
  MAX_RECENT_WORKBENCH_TARGETS,
  MAX_RECENT_SQL_FILE_NAME_LENGTH,
  MAX_URI_LENGTH,
  MAX_RECENT_SQL_FILES,
  MAX_PERSISTED_SQL_LOG_MESSAGE_LENGTH,
  MAX_TABLE_EXPORT_HISTORY_TARGETS,
  MAX_TABLE_EXPORT_HISTORY_PER_TARGET,
  MAX_PERSISTED_QUERY_LENGTH,
  MAX_PERSISTED_QUERY_TABS,
} from "./storeConstants";

const AI_STREAMING_MESSAGE_UPDATE_KEYS = new Set<keyof AIChatMessage>([
  "content",
  "thinking",
  "reasoning_content",
  "phase",
]);

export const isAIStreamingOnlyMessageUpdate = (
  updates: Partial<AIChatMessage>,
): boolean => {
  const updateKeys = Object.keys(updates) as Array<keyof AIChatMessage>;
  return (
    updateKeys.length > 0 &&
    updateKeys.every((key) => AI_STREAMING_MESSAGE_UPDATE_KEYS.has(key))
  );
};

export const sanitizeSqlSnippets = (value: unknown): SqlSnippet[] => {
  if (!Array.isArray(value)) return DEFAULT_SQL_SNIPPETS;
  const result: SqlSnippet[] = [];
  const seenIds = new Set<string>();
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const raw = entry as Record<string, unknown>;
    const prefix = toTrimmedString(raw.prefix)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 20);
    const body = typeof raw.body === "string" ? raw.body : "";
    if (!prefix || !body.trim()) return;
    const id = toTrimmedString(raw.id, `snippet-${index + 1}`) || `snippet-${index + 1}`;
    const fallbackName = indexedStoreFallback(
      "store.fallback.sql_snippet_name",
      index,
    );
    if (seenIds.has(id)) return;
    seenIds.add(id);
    result.push({
      id,
      prefix,
      name: toTrimmedString(raw.name, fallbackName) || fallbackName,
      description: toTrimmedString(raw.description) || undefined,
      syntaxHelp: toTrimmedString(raw.syntaxHelp) || undefined,
      body,
      isBuiltin: raw.isBuiltin === true,
      createdAt: Number.isFinite(Number(raw.createdAt))
        ? Number(raw.createdAt)
        : Date.now(),
    });
  });
  return result;
};

export const resolveExternalSQLDirectoryName = (name: unknown, path: string): string => {
  const explicitName = toTrimmedString(name);
  if (explicitName) return explicitName;
  const pathSegment = path.split(/[\\/]/).filter(Boolean).pop();
  return pathSegment || translate("sidebar.sql_directory.default_name");
};

export const sanitizeExternalSQLFileBindings = (
  value: unknown,
): NonNullable<ExternalSQLDirectory["fileBindings"]> => {
  if (!Array.isArray(value)) return [];
  const bindings = new Map<string, NonNullable<ExternalSQLDirectory["fileBindings"]>[number]>();
  value.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const raw = entry as Record<string, unknown>;
    const filePath = normalizeExternalSQLPath(toTrimmedString(raw.filePath));
    const connectionId = toTrimmedString(raw.connectionId);
    const dbName = toTrimmedString(raw.dbName);
    // dbName intentionally stays optional for a file binding: an empty value
    // means "connect to this host without selecting a default database".
    if (!filePath || !connectionId) return;
    bindings.set(filePath, { filePath, connectionId, dbName });
  });
  return [...bindings.values()];
};

export const sanitizeExternalSQLDirectories = (
  value: unknown,
): ExternalSQLDirectory[] => {
  if (!Array.isArray(value)) return [];
  const result: ExternalSQLDirectory[] = [];
  const seenDirectoryIds = new Set<string>();
  value.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const raw = entry as Record<string, unknown>;
    const path = toTrimmedString(raw.path);
    if (!path) return;
    const connectionId = toTrimmedString(raw.connectionId);
    const dbName = toTrimmedString(raw.dbName);
    const fileBindings = sanitizeExternalSQLFileBindings(raw.fileBindings);
    const id =
      toTrimmedString(
        raw.id,
        buildExternalSQLDirectoryId(connectionId, dbName, path),
      ) || buildExternalSQLDirectoryId(connectionId, dbName, path);
    if (seenDirectoryIds.has(id)) return;
    seenDirectoryIds.add(id);
    result.push({
      id,
      name: resolveExternalSQLDirectoryName(raw.name, path),
      path,
      ...(connectionId ? { connectionId } : {}),
      ...(dbName ? { dbName } : {}),
      ...(fileBindings.length > 0 ? { fileBindings } : {}),
      createdAt: Number.isFinite(Number(raw.createdAt))
        ? Number(raw.createdAt)
        : Date.now(),
    });
  });
  return result;
};

const normalizeRecentTargetTimestamp = (value: unknown): number => {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? Math.trunc(timestamp)
    : 0;
};

const buildRecentConnectionTargetKey = (
  connectionId: string,
  dbName?: string,
): string => `${connectionId}::${String(dbName || '')}`;

const buildRecentSQLFileKey = (
  connectionId: string,
  dbName: string | undefined,
  filePath: string,
): string => [
  connectionId,
  String(dbName || ''),
  filePath.replace(/\\/g, '/'),
].join('::');

export const sanitizeRecentConnectionTargets = (
  value: unknown,
): RecentConnectionTarget[] => {
  if (!Array.isArray(value)) return [];

  const candidates = value.flatMap((entry): RecentConnectionTarget[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const raw = entry as Record<string, unknown>;
    const connectionId = toTrimmedString(raw.connectionId);
    if (!connectionId || connectionId.length > 256) return [];
    const dbName = toTrimmedString(raw.dbName).slice(0, MAX_RECENT_TARGET_DATABASE_LENGTH);
    return [{
      connectionId,
      ...(dbName ? { dbName } : {}),
      openedAt: normalizeRecentTargetTimestamp(raw.openedAt),
    }];
  }).sort((left, right) => right.openedAt - left.openedAt);

  const seen = new Set<string>();
  return candidates.filter((target) => {
    const key = buildRecentConnectionTargetKey(target.connectionId, target.dbName);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_RECENT_WORKBENCH_TARGETS);
};

export const resolveRecentSQLFileName = (filePath: string, title: unknown): string => {
  const fallbackName = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
  return (toTrimmedString(title) || fallbackName).slice(0, MAX_RECENT_SQL_FILE_NAME_LENGTH);
};

export const normalizeRecentSQLPath = (value: unknown): string => {
  const normalized = toTrimmedString(value).replace(/\\/g, '/');
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
};

export const isRecentSQLPathInDirectory = (filePath: string, directoryPath: string): boolean => {
  const normalizedFilePath = normalizeRecentSQLPath(filePath);
  const normalizedDirectoryPath = normalizeRecentSQLPath(directoryPath);
  if (!normalizedDirectoryPath) return false;
  if (normalizedDirectoryPath === '/') return normalizedFilePath.startsWith('/');
  return normalizedFilePath === normalizedDirectoryPath
    || normalizedFilePath.startsWith(`${normalizedDirectoryPath}/`);
};

export const relocateRecentSQLFilePath = (
  filePath: string,
  previousDirectoryPath: string,
  nextDirectoryPath: string,
): string => {
  const normalizedPreviousDirectoryPath = normalizeRecentSQLPath(previousDirectoryPath);
  const normalizedFilePath = normalizeRecentSQLPath(filePath);
  const normalizedNextDirectoryPath = normalizeRecentSQLPath(nextDirectoryPath);
  if (!normalizedPreviousDirectoryPath || !normalizedNextDirectoryPath) return filePath;
  const suffix = normalizedFilePath.slice(normalizedPreviousDirectoryPath.length);
  const rawNextDirectoryPath = toTrimmedString(nextDirectoryPath).replace(/[\\/]+$/, '');
  const separator = rawNextDirectoryPath.includes('\\') ? '\\' : '/';
  return `${rawNextDirectoryPath}${suffix.replace(/\//g, separator)}`;
};

export const sanitizeRecentSQLFiles = (value: unknown): RecentSQLFile[] => {
  if (!Array.isArray(value)) return [];

  const candidates = value.flatMap((entry): RecentSQLFile[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const raw = entry as Record<string, unknown>;
    const connectionId = toTrimmedString(raw.connectionId);
    const filePath = toTrimmedString(raw.filePath).slice(0, MAX_URI_LENGTH);
    if (!connectionId || connectionId.length > 256 || !filePath) return [];
    const dbName = toTrimmedString(raw.dbName).slice(0, MAX_RECENT_TARGET_DATABASE_LENGTH);
    const fileName = resolveRecentSQLFileName(filePath, raw.fileName);
    if (!fileName) return [];
    return [{
      filePath,
      fileName,
      connectionId,
      ...(dbName ? { dbName } : {}),
      openedAt: normalizeRecentTargetTimestamp(raw.openedAt),
    }];
  }).sort((left, right) => right.openedAt - left.openedAt);

  const seen = new Set<string>();
  return candidates.filter((file) => {
    const key = buildRecentSQLFileKey(file.connectionId, file.dbName, file.filePath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_RECENT_SQL_FILES);
};

const prependRecentConnectionTarget = (
  existing: RecentConnectionTarget[],
  tab: Pick<TabData, 'connectionId' | 'dbName'>,
): RecentConnectionTarget[] => {
  const connectionId = toTrimmedString(tab.connectionId);
  if (!connectionId) return existing;
  const dbName = toTrimmedString(tab.dbName).slice(0, MAX_RECENT_TARGET_DATABASE_LENGTH);
  const target: RecentConnectionTarget = {
    connectionId,
    ...(dbName ? { dbName } : {}),
    openedAt: Date.now(),
  };
  const key = buildRecentConnectionTargetKey(target.connectionId, target.dbName);
  return [
    target,
    ...existing.filter((item) => buildRecentConnectionTargetKey(item.connectionId, item.dbName) !== key),
  ].slice(0, MAX_RECENT_WORKBENCH_TARGETS);
};

const prependRecentSQLFile = (
  existing: RecentSQLFile[],
  tab: Pick<TabData, 'connectionId' | 'dbName' | 'filePath' | 'title'>,
): RecentSQLFile[] => {
  const connectionId = toTrimmedString(tab.connectionId);
  const filePath = toTrimmedString(tab.filePath).slice(0, MAX_URI_LENGTH);
  if (!connectionId || !filePath) return existing;
  const dbName = toTrimmedString(tab.dbName).slice(0, MAX_RECENT_TARGET_DATABASE_LENGTH);
  const file: RecentSQLFile = {
    filePath,
    fileName: resolveRecentSQLFileName(filePath, tab.title),
    connectionId,
    ...(dbName ? { dbName } : {}),
    openedAt: Date.now(),
  };
  const key = buildRecentSQLFileKey(file.connectionId, file.dbName, file.filePath);
  return [
    file,
    ...existing.filter((item) => buildRecentSQLFileKey(item.connectionId, item.dbName, item.filePath) !== key),
  ].slice(0, MAX_RECENT_SQL_FILES);
};

export const resolveRecentWorkbenchEntries = (
  state: Pick<AppState, 'recentConnectionTargets' | 'recentSQLFiles'>,
  tab: TabData,
): Pick<AppState, 'recentConnectionTargets' | 'recentSQLFiles'> => ({
  recentConnectionTargets: prependRecentConnectionTarget(
    state.recentConnectionTargets,
    tab,
  ),
  recentSQLFiles: prependRecentSQLFile(state.recentSQLFiles, tab),
});

export const sanitizeTableExportHistoryEntry = (
  value: unknown,
): TableExportHistoryEntry | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const jobId = toTrimmedString(raw.jobId);
  if (!jobId) {
    return null;
  }
  const normalizeCount = (input: unknown): number => {
    const next = Number(input);
    if (!Number.isFinite(next) || next < 0) {
      return 0;
    }
    return Math.trunc(next);
  };
  const normalizeTimestamp = (input: unknown): number => {
    const next = Number(input);
    if (!Number.isFinite(next) || next <= 0) {
      return 0;
    }
    return Math.trunc(next);
  };
  const statusRaw = toTrimmedString(raw.status).toLowerCase();
  const status: TableExportHistoryEntry["status"] =
    statusRaw === "start" ||
    statusRaw === "running" ||
    statusRaw === "finalizing" ||
    statusRaw === "done" ||
    statusRaw === "error"
      ? statusRaw
      : "idle";
  return {
    jobId,
    targetName:
      toTrimmedString(raw.targetName, translate("data_export.progress.value.target_fallback")) ||
      translate("data_export.progress.value.target_fallback"),
    startedAt: normalizeTimestamp(raw.startedAt),
    finishedAt: normalizeTimestamp(raw.finishedAt),
    format: toTrimmedString(raw.format).slice(0, 32),
    scope: toTrimmedString(raw.scope).slice(0, 64),
    scopeLabel: toTrimmedString(raw.scopeLabel).slice(0, 128),
    strategyLabel: toTrimmedString(raw.strategyLabel).slice(0, 128),
    status,
    stage: toTrimmedString(raw.stage).slice(0, 256),
    current: normalizeCount(raw.current),
    total: normalizeCount(raw.total),
    totalRowsKnown: raw.totalRowsKnown === true,
    filePath: toTrimmedString(raw.filePath).slice(0, MAX_URI_LENGTH),
    message: toTrimmedString(raw.message).slice(0, MAX_PERSISTED_SQL_LOG_MESSAGE_LENGTH),
  };
};

export const sanitizeTableExportHistories = (
  value: unknown,
): Record<string, TableExportHistoryEntry[]> => {
  if (!value || typeof value !== "object") {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const entries = Object.entries(raw)
    .filter(([key, history]) => toTrimmedString(key) && Array.isArray(history))
    .slice(0, MAX_TABLE_EXPORT_HISTORY_TARGETS);
  const result: Record<string, TableExportHistoryEntry[]> = {};
  entries.forEach(([key, history]) => {
    const seenJobIds = new Set<string>();
    const sanitizedHistory = (history as unknown[])
      .map((entry) => sanitizeTableExportHistoryEntry(entry))
      .filter((entry): entry is TableExportHistoryEntry => !!entry)
      .filter((entry) => entry.status === "done" || entry.status === "error")
      .filter((entry) => {
        if (seenJobIds.has(entry.jobId)) {
          return false;
        }
        seenJobIds.add(entry.jobId);
        return true;
      })
      .sort((a, b) => {
        const timeA = a.finishedAt || a.startedAt || 0;
        const timeB = b.finishedAt || b.startedAt || 0;
        return timeB - timeA;
      })
      .slice(0, MAX_TABLE_EXPORT_HISTORY_PER_TARGET);
    if (sanitizedHistory.length > 0) {
      result[toTrimmedString(key)] = sanitizedHistory;
    }
  });
  return result;
};

export const sanitizeQueryTabs = (value: unknown): TabData[] => {
  const entries = Array.isArray(value) ? value : [];
  const result: TabData[] = [];
  const seenIds = new Set<string>();

  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const raw = entry as Record<string, unknown>;
    if (raw.type !== "query") return;

    let id = toTrimmedString(raw.id, `query-${index + 1}`) || `query-${index + 1}`;
    const persistedDraft = getPersistedQueryTabDraftEntry(id);
    const query =
      typeof raw.query === "string" && raw.query.trim()
        ? raw.query.slice(0, MAX_PERSISTED_QUERY_LENGTH)
        : String(persistedDraft?.query || "").slice(
            0,
            MAX_PERSISTED_QUERY_LENGTH,
          );
    const filePath = toTrimmedString(raw.filePath, persistedDraft?.filePath);
    const savedQueryId = toTrimmedString(
      raw.savedQueryId,
      persistedDraft?.savedQueryId,
    );
    const rawFormatRestoreSnapshot =
      raw.formatRestoreSnapshot && typeof raw.formatRestoreSnapshot === "object"
        ? (raw.formatRestoreSnapshot as Record<string, unknown>)
        : null;
    const formatRestoreQuery =
      typeof rawFormatRestoreSnapshot?.query === "string"
        ? rawFormatRestoreSnapshot.query.slice(0, MAX_PERSISTED_QUERY_LENGTH)
        : "";
    const formatRestoreCreatedAt = Number(rawFormatRestoreSnapshot?.createdAt);
    if (!query.trim() && !filePath && !savedQueryId) return;

    if (seenIds.has(id)) {
      id = `${id}-${index + 1}`;
    }
    seenIds.add(id);

    // object-edit 身份字段必须随 tab 持久化，否则重启/刷新后
    // 侧栏定位按钮会因解析不到对象身份而禁用。
    const isObjectEditTab = raw.queryMode === "object-edit";
    const asViewKind = (value: unknown): TabData["viewKind"] =>
      value === "view" || value === "materialized" ? value : undefined;
    const asObjectType = (value: unknown): TabData["objectType"] =>
      value === "view" || value === "materialized-view" || value === "table"
        ? value
        : undefined;
    const objectEditIdentity = isObjectEditTab
      ? {
          routineName: toTrimmedString(raw.routineName).slice(0, 256) || undefined,
          routineType: toTrimmedString(raw.routineType).slice(0, 64) || undefined,
          viewName: toTrimmedString(raw.viewName).slice(0, 256) || undefined,
          viewKind: asViewKind(raw.viewKind),
          objectType: asObjectType(raw.objectType),
          sequenceName: toTrimmedString(raw.sequenceName).slice(0, 256) || undefined,
          packageName: toTrimmedString(raw.packageName).slice(0, 256) || undefined,
          triggerName: toTrimmedString(raw.triggerName).slice(0, 256) || undefined,
          triggerTableName:
            toTrimmedString(raw.triggerTableName).slice(0, 256) || undefined,
          eventName: toTrimmedString(raw.eventName).slice(0, 256) || undefined,
          sidebarLocateKey:
            toTrimmedString(raw.sidebarLocateKey).slice(0, 512) || undefined,
          returnToTabId:
            toTrimmedString(raw.returnToTabId).slice(0, 256) || undefined,
        }
      : undefined;

    result.push({
      id,
      title:
        toTrimmedString(
          raw.title,
          toTrimmedString(
            persistedDraft?.title,
            translate("sidebar.tab.new_query"),
          ),
        ) ||
        translate("sidebar.tab.new_query"),
      type: "query",
      connectionId: toTrimmedString(
        raw.connectionId,
        persistedDraft?.connectionId,
      ),
      dbName: toTrimmedString(raw.dbName, persistedDraft?.dbName),
      schemaName: toTrimmedString(raw.schemaName).slice(0, 256) || undefined,
      query,
      resultPanelVisible:
        typeof raw.resultPanelVisible === "boolean"
          ? raw.resultPanelVisible
          : undefined,
      queryMode: isObjectEditTab ? "object-edit" : undefined,
      ...(objectEditIdentity || {}),
      filePath: filePath || undefined,
      savedQueryId: savedQueryId || undefined,
      readOnly: raw.readOnly === true || persistedDraft?.readOnly === true,
      formatRestoreSnapshot: formatRestoreQuery
        ? {
            query: formatRestoreQuery,
            createdAt: Number.isFinite(formatRestoreCreatedAt)
              ? formatRestoreCreatedAt
              : Date.now(),
          }
        : undefined,
    });
  });

  listPersistedQueryTabDraftEntries().forEach((entry) => {
    if (seenIds.has(entry.tabId)) {
      return;
    }
    const filePath = toTrimmedString(entry.filePath);
    const savedQueryId = toTrimmedString(entry.savedQueryId);
    if (!entry.query.trim() && !filePath && !savedQueryId) {
      return;
    }
    seenIds.add(entry.tabId);
    result.push({
      id: entry.tabId,
      title:
        toTrimmedString(entry.title, translate("sidebar.tab.new_query")) ||
        translate("sidebar.tab.new_query"),
      type: "query",
      connectionId: toTrimmedString(entry.connectionId),
      dbName: toTrimmedString(entry.dbName) || undefined,
      query: entry.query.slice(0, MAX_PERSISTED_QUERY_LENGTH),
      filePath: filePath || undefined,
      savedQueryId: savedQueryId || undefined,
      readOnly: entry.readOnly === true,
    });
  });

  return result.slice(0, MAX_PERSISTED_QUERY_TABS);
};

export const sanitizeActiveTabId = (activeTabId: unknown, tabs: TabData[]): string | null => {
  const id = toTrimmedString(activeTabId);
  if (id && tabs.some((tab) => tab.id === id)) {
    return id;
  }
  return tabs[0]?.id || null;
};

export const resolveCloseTabActiveTabId = (
  closedTab: TabData | undefined,
  newTabs: TabData[],
): string | null => {
  const returnToTabId = toTrimmedString(closedTab?.returnToTabId);
  if (returnToTabId && newTabs.some((tab) => tab.id === returnToTabId)) {
    return returnToTabId;
  }
  return newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
};

export const resolveActiveContextFromTab = (
  tab: TabData | null | undefined,
): ActiveContext | null => {
  if (!tab) return null;
  const connectionId = toTrimmedString(tab.connectionId);
  if (!connectionId) return null;
  const schemaName = toTrimmedString(tab.schemaName);
  const tableName = toTrimmedString(
    tab.tableName
    || tab.viewName
    || tab.triggerName
    || tab.eventName
    || tab.routineName
    || tab.sequenceName
    || tab.packageName,
  );
  return {
    connectionId,
    dbName: toTrimmedString(tab.dbName),
    ...(schemaName ? { schemaName } : {}),
    ...(tableName ? { tableName } : {}),
  };
};

export const activeContextMatchesTab = (
  context: ActiveContext | null | undefined,
  tab: TabData | null | undefined,
): boolean => {
  const tabContext = resolveActiveContextFromTab(tab);
  if (!context || !tabContext) return false;
  return (
    context.connectionId === tabContext.connectionId
    && context.dbName === tabContext.dbName
    && toTrimmedString(context.schemaName) === toTrimmedString(tabContext.schemaName)
    && toTrimmedString(context.tableName) === toTrimmedString(tabContext.tableName)
  );
};

export const resolveActiveContextForTabId = (
  tabs: TabData[],
  activeTabId: string | null | undefined,
  fallbackContext: ActiveContext | null,
): ActiveContext | null => {
  const normalizedActiveTabId = toTrimmedString(activeTabId);
  if (normalizedActiveTabId) {
    const activeTab = tabs.find((tab) => tab.id === normalizedActiveTabId);
    const contextFromTab = resolveActiveContextFromTab(activeTab);
    if (contextFromTab) {
      return contextFromTab;
    }
  }
  return fallbackContext;
};

export const isRunningDataImportTab = (tab: TabData | undefined): boolean => (
  tab?.type === "data-import" && tab.dataImportRunning === true
);
