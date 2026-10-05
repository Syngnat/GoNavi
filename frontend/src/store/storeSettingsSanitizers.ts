import { SavedConnection, GlobalProxyConfig } from "../types";
import {
  ShortcutOptions,
  migrateLegacySidebarSearchShortcutOptions,
  sanitizeShortcutOptions,
} from "../utils/shortcuts";
import { sanitizeDataGridDisplaySettings } from "../utils/dataGridDisplay";
import {
  migrateLegacySqlEditorTypographySettings,
  sanitizeSqlEditorTypographySettings,
} from "../utils/sqlEditorTypography";
import { sanitizeTitlebarActionsPlacementSettings } from "../utils/titlebarActionsPlacement";
import { sanitizeFontFamilyInput } from "../utils/fontFamilies";
import type { AIChatDetachedBoundsMemory, DetachedWindowBounds } from "../utils/detachedWindow";
import {
  type LanguagePreference,
  LANGUAGE_PREFERENCES,
  resolveLanguage,
  DEFAULT_LANGUAGE,
} from "../i18n";
import {
  type TabDisplaySettings,
  sanitizeTabDisplaySettings,
  DEFAULT_TAB_DISPLAY_SETTINGS,
} from "../utils/tabDisplay";
import { sanitizeRedisDbAliases } from "../utils/redisDbAlias";
import { sanitizeQueryEditorEditorHeightRatio } from "../utils/queryEditorSplitLayout";
import {
  sanitizeSidebarTableMetadataFields,
  resolveSidebarTableMetadataFields,
  resolveSidebarTableMetadataFieldOrder,
  applySidebarTableMetadataFieldOrder,
} from "../utils/sidebarTableMetadata";
import { sanitizeSidebarHiddenObjectGroups } from "../utils/sidebarObjectVisibility";
import { sanitizeToolbarButtonColorOverrides } from "../utils/toolbarAppearance";
import { normalizeTableAliasPrefix } from "../utils/tableAliasPrefix";
import type { SidebarTableSortPreference } from "../utils/sidebarTreeOrder";
import {
  MAX_RUNTIME_SQL_LOGS,
  MAX_RUNTIME_SQL_LOG_LENGTH,
  MAX_RUNTIME_SQL_LOG_MESSAGE_LENGTH,
  MAX_PERSISTED_SQL_LOGS,
  MAX_PERSISTED_SQL_LOG_LENGTH,
  MAX_PERSISTED_SQL_LOG_MESSAGE_LENGTH,
  DEFAULT_LANGUAGE_PREFERENCE,
  DEFAULT_APPEARANCE,
  SQL_EDITOR_FONT_SIZE_SPLIT_VERSION,
  sanitizeTableDoubleClickAction,
  sanitizeQueryTableCtrlClickAction,
  sanitizeV2SidebarSearchMode,
  sanitizeV2SidebarPersistedFilter,
  sanitizeV2SidebarRailScale,
  sanitizeTabEnvironmentAccentThickness,
  sanitizeNewQuerySqlTemplate,
  TAB_DISPLAY_DEFAULT_MIGRATION_VERSION,
  DEFAULT_AUTO_CHECK_FOR_UPDATES,
  AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS_SET,
  DEFAULT_AUTO_CHECK_FOR_UPDATES_INTERVAL_MINUTES,
  normalizeFloatInRange,
  DEFAULT_UI_SCALE,
  MIN_UI_SCALE,
  MAX_UI_SCALE,
  normalizeIntegerInRange,
  DEFAULT_FONT_SIZE,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  DEFAULT_GLOBAL_PROXY,
  SIDEBAR_SEARCH_SHORTCUT_MIGRATION_VERSION,
  PERSIST_STORAGE_KEY,
} from "./storeConstants";
import type {
  SqlLog,
  ThemeMode,
  ThemePreference,
  QueryOptions,
  DataEditTransactionOptions,
  SqlEditorTransactionOptions,
  AppearanceSettings,
  AIChatOpenMode,
} from "./storeStateTypes";
import {
  toTrimmedString,
  normalizePort,
  unwrapPersistedAppState,
} from "./storeConnectionSanitizers";
import { isLegacyDefaultAppearance } from "./storeConnectionTagTree";

type SqlLogSanitizeOptions = {
  limit: number;
  sqlLength: number;
  messageLength: number;
};

const RUNTIME_SQL_LOG_SANITIZE_OPTIONS: SqlLogSanitizeOptions = {
  limit: MAX_RUNTIME_SQL_LOGS,
  sqlLength: MAX_RUNTIME_SQL_LOG_LENGTH,
  messageLength: MAX_RUNTIME_SQL_LOG_MESSAGE_LENGTH,
};

const PERSISTED_SQL_LOG_SANITIZE_OPTIONS: SqlLogSanitizeOptions = {
  limit: MAX_PERSISTED_SQL_LOGS,
  sqlLength: MAX_PERSISTED_SQL_LOG_LENGTH,
  messageLength: MAX_PERSISTED_SQL_LOG_MESSAGE_LENGTH,
};

const sanitizeSqlLogEntry = (
  entry: unknown,
  index: number,
  options: SqlLogSanitizeOptions,
): SqlLog | null => {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, unknown>;
  const sql = typeof raw.sql === "string" ? raw.sql.slice(0, options.sqlLength) : "";
  if (!sql.trim()) return null;

  const status = raw.status === "error" ? "error" : "success";
  const timestamp = Number(raw.timestamp);
  const duration = Number(raw.duration);
  const affectedRows = Number(raw.affectedRows);
  const message = typeof raw.message === "string"
    ? raw.message.slice(0, options.messageLength)
    : "";

  const log: SqlLog = {
    id: toTrimmedString(raw.id, `log-${index + 1}`) || `log-${index + 1}`,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    sql,
    status,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    dbName: toTrimmedString(raw.dbName) || undefined,
  };

  if (raw.category === "query" || raw.category === "transaction") {
    log.category = raw.category;
  }
  const transactionId = toTrimmedString(raw.transactionId);
  if (transactionId) {
    log.transactionId = transactionId;
  }
  if (raw.transactionAction === "commit" || raw.transactionAction === "rollback") {
    log.transactionAction = raw.transactionAction;
  }

  if (message) {
    log.message = message;
  }
  if (raw.hiddenFromRecent === true) {
    log.hiddenFromRecent = true;
  }
  if (Number.isFinite(affectedRows)) {
    log.affectedRows = affectedRows;
  }

  return log;
};

const sanitizeSqlLogs = (
  value: unknown,
  options: SqlLogSanitizeOptions = PERSISTED_SQL_LOG_SANITIZE_OPTIONS,
): SqlLog[] => {
  if (!Array.isArray(value)) return [];
  const result: SqlLog[] = [];
  const seenIds = new Set<string>();

  value.forEach((entry, index) => {
    const log = sanitizeSqlLogEntry(entry, index, options);
    if (!log) return;

    let id = log.id;
    if (seenIds.has(id)) {
      id = `${id}-${index + 1}`;
    }
    seenIds.add(id);

    result.push(id === log.id ? log : { ...log, id });
  });

  return result.slice(0, options.limit);
};

export const sanitizeRuntimeSqlLogs = (value: unknown) =>
  sanitizeSqlLogs(value, RUNTIME_SQL_LOG_SANITIZE_OPTIONS);

export const sanitizePersistedSqlLogs = (value: unknown) =>
  sanitizeSqlLogs(value, PERSISTED_SQL_LOG_SANITIZE_OPTIONS);

export const appendRuntimeSqlLog = (existing: SqlLog[], entry: SqlLog): SqlLog[] => {
  const nextEntry = sanitizeSqlLogEntry(entry, 0, RUNTIME_SQL_LOG_SANITIZE_OPTIONS);
  if (!nextEntry) {
    return existing;
  }

  const nextLogs = [nextEntry, ...existing.slice(0, MAX_RUNTIME_SQL_LOGS - 1)];
  return existing.some((item) => item.id === nextEntry.id)
    ? sanitizeRuntimeSqlLogs(nextLogs)
    : nextLogs;
};

export const hasLegacyConnectionSecrets = (
  connections: SavedConnection[],
): boolean => {
  return connections.some((connection) => {
    const config =
      connection?.config && typeof connection.config === "object"
        ? (connection.config as unknown as Record<string, unknown>)
        : {};
    const ssh =
      config.ssh && typeof config.ssh === "object"
        ? (config.ssh as Record<string, unknown>)
        : {};
    const proxy =
      config.proxy && typeof config.proxy === "object"
        ? (config.proxy as Record<string, unknown>)
        : {};
    const httpTunnel =
      config.httpTunnel && typeof config.httpTunnel === "object"
        ? (config.httpTunnel as Record<string, unknown>)
        : {};

    return (
      toTrimmedString(config.password) !== "" ||
      toTrimmedString(ssh.password) !== "" ||
      toTrimmedString(proxy.password) !== "" ||
      toTrimmedString(httpTunnel.password) !== "" ||
      toTrimmedString(config.mysqlReplicaPassword) !== "" ||
      toTrimmedString(config.mongoReplicaPassword) !== "" ||
      toTrimmedString(config.redisSentinelPassword) !== "" ||
      toTrimmedString(config.uri) !== "" ||
      toTrimmedString(config.dsn) !== ""
    );
  });
};

export const sanitizeTheme = (value: unknown): ThemeMode =>
  value === "dark" ? "dark" : "light";

export const sanitizeThemePreference = (
  value: unknown,
  fallbackTheme: ThemeMode = "light",
): ThemePreference => (value === "system" ? "system" : sanitizeTheme(value ?? fallbackTheme));

export const sanitizeLanguagePreference = (value: unknown): LanguagePreference => {
  if (
    typeof value === "string" &&
    (LANGUAGE_PREFERENCES as readonly string[]).includes(value)
  ) {
    return value as LanguagePreference;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const resolved = resolveLanguage(value, []);
    if (resolved !== DEFAULT_LANGUAGE) {
      return resolved;
    }
  }
  return DEFAULT_LANGUAGE_PREFERENCE;
};

export const sanitizeSqlFormatOptions = (
  value: unknown,
): { keywordCase: "upper" | "lower" } => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return { keywordCase: raw.keywordCase === "lower" ? "lower" : "upper" };
};

export const sanitizeQueryOptions = (value: unknown): QueryOptions => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const maxRows = Number(raw.maxRows);
  const wordWrap = raw.wordWrap === true;
  const tableOverviewViewMode =
    raw.tableOverviewViewMode === "card" ||
    raw.tableOverviewViewMode === "list" ||
    raw.tableOverviewViewMode === "table"
      ? raw.tableOverviewViewMode
      : undefined;
  const showColumnComment =
    typeof raw.showColumnComment === "boolean" ? raw.showColumnComment : true;
  const showSidebarTableComment =
    typeof raw.showSidebarTableComment === "boolean"
      ? raw.showSidebarTableComment
      : false;
  const sidebarTableMetadataFields = Array.isArray(raw.sidebarTableMetadataFields)
    ? sanitizeSidebarTableMetadataFields(raw.sidebarTableMetadataFields, [])
    : resolveSidebarTableMetadataFields(undefined, showSidebarTableComment);
  const sidebarTableMetadataFieldOrder = resolveSidebarTableMetadataFieldOrder(
    raw.sidebarTableMetadataFieldOrder,
  );
  const orderedSidebarTableMetadataFields = applySidebarTableMetadataFieldOrder(
    sidebarTableMetadataFields,
    sidebarTableMetadataFieldOrder,
  );
  const derivedShowSidebarTableComment = orderedSidebarTableMetadataFields.includes("comment");
  const showColumnType =
    typeof raw.showColumnType === "boolean" ? raw.showColumnType : true;
  const alignNumericTemporalCellsRight =
    typeof raw.alignNumericTemporalCellsRight === "boolean"
      ? raw.alignNumericTemporalCellsRight
      : false;
  const showQueryResultsPanel =
    typeof raw.showQueryResultsPanel === "boolean" ? raw.showQueryResultsPanel : false;
  const queryEditorEditorHeightRatio = sanitizeQueryEditorEditorHeightRatio(
    raw.queryEditorEditorHeightRatio,
  );
  if (!Number.isFinite(maxRows) || maxRows < 0) {
    return {
      maxRows: 5000,
      wordWrap,
      tableOverviewViewMode,
      showColumnComment,
      showSidebarTableComment: derivedShowSidebarTableComment,
      sidebarTableMetadataFields: orderedSidebarTableMetadataFields,
      sidebarTableMetadataFieldOrder,
      showColumnType,
      alignNumericTemporalCellsRight,
      showQueryResultsPanel,
      queryEditorEditorHeightRatio,
    };
  }
  return {
    maxRows: Math.min(50000, Math.trunc(maxRows)),
    wordWrap,
    tableOverviewViewMode,
    showColumnComment,
    showSidebarTableComment: derivedShowSidebarTableComment,
    sidebarTableMetadataFields: orderedSidebarTableMetadataFields,
    sidebarTableMetadataFieldOrder,
    showColumnType,
    alignNumericTemporalCellsRight,
    showQueryResultsPanel,
    queryEditorEditorHeightRatio,
  };
};

const DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS = new Set([3000, 5000, 10000, 30000]);
const SQL_EDITOR_AUTO_COMMIT_DELAY_OPTIONS = new Set([0, 3000, 5000, 10000, 30000]);

export const sanitizeDataEditTransactionOptions = (
  value: unknown,
): DataEditTransactionOptions => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const autoCommitDelayMs = Number(raw.autoCommitDelayMs);
  return {
    commitMode: raw.commitMode === "auto" ? "auto" : "manual",
    autoCommitDelayMs: DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS.has(autoCommitDelayMs)
      ? autoCommitDelayMs
      : 5000,
  };
};

export const sanitizeSqlEditorTransactionOptions = (
  value: unknown,
): SqlEditorTransactionOptions => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const autoCommitDelayMs = Number(raw.autoCommitDelayMs);
  return {
    commitMode: raw.commitMode === "auto" ? "auto" : "manual",
    autoCommitDelayMs: SQL_EDITOR_AUTO_COMMIT_DELAY_OPTIONS.has(autoCommitDelayMs)
      ? autoCommitDelayMs
      : 0,
  };
};

export const sanitizeTableSortPreference = (
  value: unknown,
): Record<string, SidebarTableSortPreference> => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const result: Record<string, SidebarTableSortPreference> = {};
  Object.entries(raw).forEach(([key, preference]) => {
    result[key] = preference === "frequency" || preference === "manual" ? preference : "name";
  });
  return result;
};

export const sanitizeTableDesignerSchemaByConnection = (
  value: unknown,
): Record<string, string> => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const result: Record<string, string> = {};
  Object.entries(raw).forEach(([connectionId, schemaName]) => {
    const safeConnectionId = toTrimmedString(connectionId);
    const safeSchemaName = toTrimmedString(schemaName).slice(0, 256);
    if (safeConnectionId && safeSchemaName) {
      result[safeConnectionId] = safeSchemaName;
    }
  });
  return result;
};

export const sanitizeTableColumnOrders = (
  value: unknown,
): Record<string, string[]> => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const result: Record<string, string[]> = {};
  Object.entries(raw).forEach(([key, orderArray]) => {
    if (Array.isArray(orderArray)) {
      result[key] = orderArray.map((col) => String(col));
    }
  });
  return result;
};

export const sanitizeTableHiddenColumns = (
  value: unknown,
): Record<string, string[]> => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const result: Record<string, string[]> = {};
  Object.entries(raw).forEach(([key, hiddenArray]) => {
    if (Array.isArray(hiddenArray)) {
      result[key] = hiddenArray.map((col) => String(col));
    }
  });
  return result;
};

export const sanitizePinnedSidebarTables = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => toTrimmedString(entry))
        .filter(Boolean),
    ),
  );
};

export const sanitizePinnedConnectionTypes = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => toTrimmedString(entry).toLowerCase())
        .filter((entry) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry)),
    ),
  ).slice(0, 64);
};

export const updatePinnedConnectionTypeKeys = (
  pinnedTypes: unknown,
  dbType: string,
  pinned: boolean,
): string[] => {
  const current = sanitizePinnedConnectionTypes(pinnedTypes);
  const normalizedType = toTrimmedString(dbType).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalizedType)) {
    return current;
  }
  const withoutCurrent = current.filter((entry) => entry !== normalizedType);
  return pinned ? [normalizedType, ...withoutCurrent] : withoutCurrent;
};

const isLegacyDefaultTabDisplaySettings = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const raw = value as Partial<TabDisplaySettings>;
  return raw.layout === "single"
    && Array.isArray(raw.primaryElements)
    && raw.primaryElements.length === 3
    && raw.primaryElements[0] === "connection"
    && raw.primaryElements[1] === "kind"
    && raw.primaryElements[2] === "object"
    && Array.isArray(raw.secondaryElements)
    && raw.secondaryElements.length === 0
    && raw.single === undefined
    && raw.double === undefined;
};

export const sanitizeAppearance = (
  appearance: Partial<AppearanceSettings> | undefined,
  version: number,
): AppearanceSettings => {
  if (!appearance || typeof appearance !== "object") {
    return { ...DEFAULT_APPEARANCE };
  }
  const dataGridDisplaySettings = sanitizeDataGridDisplaySettings(appearance);
  const sqlEditorTypographySettings = version < SQL_EDITOR_FONT_SIZE_SPLIT_VERSION
    ? migrateLegacySqlEditorTypographySettings(dataGridDisplaySettings)
    : sanitizeSqlEditorTypographySettings(appearance);
  const nextAppearance = {
    enabled:
      typeof appearance.enabled === "boolean"
        ? appearance.enabled
        : DEFAULT_APPEARANCE.enabled,
    opacity:
      typeof appearance.opacity === "number"
        ? appearance.opacity
        : DEFAULT_APPEARANCE.opacity,
    blur:
      typeof appearance.blur === "number"
        ? appearance.blur
        : DEFAULT_APPEARANCE.blur,
    tableDoubleClickAction: sanitizeTableDoubleClickAction(
      appearance.tableDoubleClickAction,
    ),
    queryTableCtrlClickAction: sanitizeQueryTableCtrlClickAction(
      appearance.queryTableCtrlClickAction,
    ),
    v2SidebarSearchMode: sanitizeV2SidebarSearchMode(
      appearance.v2SidebarSearchMode,
    ),
    v2SidebarPersistedFilter: sanitizeV2SidebarPersistedFilter(
      appearance.v2SidebarPersistedFilter,
    ),
    v2SidebarRailScale: sanitizeV2SidebarRailScale(
      appearance.v2SidebarRailScale,
    ),
    tabEnvironmentAccentThickness: sanitizeTabEnvironmentAccentThickness(
      appearance.tabEnvironmentAccentThickness,
    ),
    toolbarButtonColorOverrides: sanitizeToolbarButtonColorOverrides(
      appearance.toolbarButtonColorOverrides,
    ),
    sidebarSingleDatabaseExpansion:
      appearance.sidebarSingleDatabaseExpansion === true,
    sidebarHiddenObjectGroups: sanitizeSidebarHiddenObjectGroups(
      appearance.sidebarHiddenObjectGroups,
    ),
    customUIFontFamily: sanitizeFontFamilyInput(appearance.customUIFontFamily),
    customMonoFontFamily: sanitizeFontFamilyInput(appearance.customMonoFontFamily),
    newQuerySqlTemplate: sanitizeNewQuerySqlTemplate(appearance.newQuerySqlTemplate),
    autoAddTableAlias:
      typeof appearance.autoAddTableAlias === "boolean"
        ? appearance.autoAddTableAlias
        : DEFAULT_APPEARANCE.autoAddTableAlias,
    customTableAliasPrefixEnabled:
      appearance.customTableAliasPrefixEnabled === true,
    customTableAliasPrefix: normalizeTableAliasPrefix(
      appearance.customTableAliasPrefix,
    ),
    tabDisplay: version < TAB_DISPLAY_DEFAULT_MIGRATION_VERSION
      && isLegacyDefaultTabDisplaySettings(appearance.tabDisplay)
      ? sanitizeTabDisplaySettings(DEFAULT_TAB_DISPLAY_SETTINGS)
      : sanitizeTabDisplaySettings(appearance.tabDisplay),
    redisDbAliases: sanitizeRedisDbAliases(appearance.redisDbAliases),
    // 各设置分片的归一化函数只返回自身字段，直接展开。
    ...dataGridDisplaySettings,
    ...sqlEditorTypographySettings,
    ...sanitizeTitlebarActionsPlacementSettings(appearance),
  };
  if (version < 2 && isLegacyDefaultAppearance(appearance)) {
    return { ...DEFAULT_APPEARANCE };
  }
  return nextAppearance;
};

export const sanitizeStartupFullscreen = (value: unknown): boolean => {
  return value === true;
};

export const sanitizeAutoCheckForUpdates = (value: unknown): boolean => {
  return typeof value === "boolean" ? value : DEFAULT_AUTO_CHECK_FOR_UPDATES;
};

export const sanitizeAutoCheckForUpdatesIntervalMinutes = (
  value: unknown,
): number => {
  const minutes = Math.round(Number(value));
  if (
    Number.isFinite(minutes) &&
    AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS_SET.has(minutes)
  ) {
    return minutes;
  }
  return DEFAULT_AUTO_CHECK_FOR_UPDATES_INTERVAL_MINUTES;
};

export const sanitizeUiScale = (value: unknown): number => {
  return normalizeFloatInRange(
    value,
    DEFAULT_UI_SCALE,
    MIN_UI_SCALE,
    MAX_UI_SCALE,
  );
};

export const sanitizeFontSize = (value: unknown): number => {
  return normalizeIntegerInRange(
    value,
    DEFAULT_FONT_SIZE,
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
  );
};

export const sanitizeGlobalProxy = (
  value: unknown,
  options: { allowPassword?: boolean } = {},
): GlobalProxyConfig => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const typeRaw = toTrimmedString(
    raw.type,
    DEFAULT_GLOBAL_PROXY.type,
  ).toLowerCase();
  const type: "socks5" | "http" = typeRaw === "http" ? "http" : "socks5";
  const fallbackPort = type === "http" ? 8080 : 1080;
  const password = toTrimmedString(raw.password);
  return {
    enabled: raw.enabled === true,
    type,
    host: toTrimmedString(raw.host),
    port: normalizePort(raw.port, fallbackPort),
    user: toTrimmedString(raw.user),
    password: options.allowPassword === false ? "" : password,
    hasPassword: raw.hasPassword === true || password !== "",
    secretRef: toTrimmedString(raw.secretRef) || undefined,
  };
};

export const sanitizeWindowState = (
  value: unknown,
): "normal" | "fullscreen" | "maximized" => {
  if (value === "fullscreen" || value === "maximized") return value;
  return "normal";
};

export const sanitizeAIChatOpenMode = (value: unknown): AIChatOpenMode => {
  return value === "detached" ? "detached" : "dock";
};

export const sanitizeAIChatDetachedBoundsMemory = (
  value: unknown,
): AIChatDetachedBoundsMemory | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const x = Number(raw.x);
  const y = Number(raw.y);
  return {
    width,
    height,
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    ...(raw.coordinateSpace === "screen" || raw.coordinateSpace === "viewport"
      ? { coordinateSpace: raw.coordinateSpace }
      : {}),
  };
};

/** 打开/弹出 AI 独立窗时，在记忆尺寸上叠加本次 preferred */
export const resolveAIChatDetachPreferred = (
  memory: AIChatDetachedBoundsMemory | null,
  preferred?: Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">>,
): Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">> | undefined => {
  if (!memory && !preferred) return preferred;
  const memoryBounds = memory?.coordinateSpace === "screen"
    ? { width: memory.width, height: memory.height }
    : memory;
  return {
    ...(memoryBounds ?? {}),
    ...(preferred ?? {}),
  };
};

export const sanitizeWindowBounds = (
  value: unknown,
): { width: number; height: number; x: number; y: number; dpi?: number } | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const width = Number(raw.width);
  const height = Number(raw.height);
  const x = Number(raw.x);
  const y = Number(raw.y);
  const dpi = Number(raw.dpi);
  if (![width, height, x, y].every(Number.isFinite) || width < 400 || height < 300) return null;
  return {
    width: Math.trunc(width),
    height: Math.trunc(height),
    x: Math.trunc(x),
    y: Math.trunc(y),
    ...(Number.isFinite(dpi) && dpi > 0 ? { dpi: Math.trunc(dpi) } : {}),
  };
};

let shortcutOptionsExplicitlySet = false;

export const sanitizePersistedShortcutOptions = (
  value: unknown,
  version: number,
): ShortcutOptions => (
  version < SIDEBAR_SEARCH_SHORTCUT_MIGRATION_VERSION
    ? migrateLegacySidebarSearchShortcutOptions(value)
    : sanitizeShortcutOptions(value)
);

export const readPersistedShortcutOptions = (): ShortcutOptions | null => {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    const payload = localStorage.getItem(PERSIST_STORAGE_KEY);
    if (!payload) {
      return null;
    }
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const state = unwrapPersistedAppState(raw);
    if (state.shortcutOptions === undefined) {
      return null;
    }
    const version = typeof raw.version === "number" ? raw.version : 0;
    return sanitizePersistedShortcutOptions(state.shortcutOptions, version);
  } catch {
    return null;
  }
};

export const resolveShortcutOptionsForPersistence = (
  shortcutOptions: ShortcutOptions,
): ShortcutOptions => {
  const safeOptions = sanitizeShortcutOptions(shortcutOptions);
  if (shortcutOptionsExplicitlySet) {
    return safeOptions;
  }
  return readPersistedShortcutOptions() ?? safeOptions;
};

export const runWithExplicitShortcutPersistence = (callback: () => void): void => {
  shortcutOptionsExplicitlySet = true;
  try {
    callback();
  } finally {
    shortcutOptionsExplicitlySet = false;
  }
};
