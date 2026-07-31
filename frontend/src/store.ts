import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isNativeDetachedWindowRoute } from "./utils/nativeDetachedWindowRoute";
import {
  ConnectionConfig,
  ProxyConfig,
  SavedConnection,
  SchemaVisibilityRule,
  TabData,
  SavedQuery,
  SavedQueryGroup,
  ConnectionTag,
  AIChatMessage,
  AIContextItem,
  GlobalProxyConfig,
  ExternalSQLDirectory,
  JVMDiagnosticCommandDraft,
  JVMDiagnosticEventChunk,
  SqlSnippet,
  TableExportHistoryEntry,
} from "./types";
import {
  ShortcutAction,
  ShortcutOptions,
  DEFAULT_SHORTCUT_OPTIONS,
  cloneShortcutOptions,
  getShortcutPlatform,
  migrateLegacySidebarSearchShortcutOptions,
  sanitizeShortcutOptions,
  type ShortcutPlatformBinding,
  type ShortcutPlatform,
} from "./utils/shortcuts";
import { buildExternalSQLDirectoryId } from "./utils/externalSqlTree";
import {
  DEFAULT_SQL_SNIPPETS,
  BUILTIN_SNIPPET_MAP,
} from "./utils/sqlSnippetDefaults";
import {
  DEFAULT_BRAND_ICON_ID,
  sanitizeBrandIconId,
} from "./brand/brandIcons";

const sanitizeBrandIconIdLocal = (value: unknown): string =>
  sanitizeBrandIconId(value) || DEFAULT_BRAND_ICON_ID;
import { toPersistedGlobalProxy } from "./utils/globalProxyDraft";
import {
  DEFAULT_DATA_GRID_DISPLAY_SETTINGS,
  sanitizeDataGridDisplaySettings,
  type DataGridDisplaySettings,
} from "./utils/dataGridDisplay";
import {
  DEFAULT_SQL_EDITOR_TYPOGRAPHY_SETTINGS,
  migrateLegacySqlEditorTypographySettings,
  sanitizeSqlEditorTypographySettings,
  type SqlEditorTypographySettings,
} from "./utils/sqlEditorTypography";
import {
  normalizeOceanBaseProtocol,
  resolveOceanBaseProtocolFromConfig,
  resolveOceanBaseProtocolFromQueryText,
} from "./utils/oceanBaseProtocol";
import { sanitizeFontFamilyInput } from "./utils/fontFamilies";
import {
  createDefaultDetachedBounds,
  nextDetachedZIndex,
  toAIChatDetachedBoundsMemory,
  type AIChatDetachedBoundsMemory,
  type DetachedAIChatWindow,
  type DetachedQueryResultWindow,
  type DetachedWorkbenchWindow,
  type DetachedWindowBounds,
} from "./utils/detachedWindow";
import { clearQueryEditorResultSession } from "./utils/queryEditorResultSessionCache";
import { normalizeConnectionEnvironmentType } from "./utils/connectionEnvironment";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_PREFERENCES,
  resolveLanguage,
  t as translate,
  type LanguagePreference,
} from "./i18n";
import {
  DEFAULT_TAB_DISPLAY_SETTINGS,
  sanitizeTabDisplaySettings,
  type TabDisplaySettings,
} from "./utils/tabDisplay";
import {
  DEFAULT_REDIS_DB_ALIASES,
  sanitizeRedisDbAliases,
  setRedisDbAlias as applyRedisDbAlias,
  type RedisDbAliasMap,
} from "./utils/redisDbAlias";
import {
  captureLegacySavedQueriesSnapshot,
  deleteSavedQueryGroupFromBackend,
  deleteSavedQueryFromBackend,
  getSavedQueryGroupsFromBackend,
  moveSavedQueryGroupInBackend,
  moveSavedQueryToGroupInBackend,
  sanitizeSavedQueries,
  saveSavedQueryGroupToBackend,
  saveSavedQueryToBackend,
  type SavedQueryBackend,
} from "./utils/savedQueryPersistence";
import { normalizeSavedQueryGroups } from "./utils/savedQueryGroups";
import {
  clearQueryTabDraft,
  getPersistedQueryTabDraftEntry,
  listPersistedQueryTabDraftEntries,
} from "./utils/sqlFileTabDrafts";
import {
  deriveLegacyConnectionReadOnlyFlag,
  MAX_CONNECTION_KEEPALIVE_SQL_LENGTH,
  normalizeConnectionProtectionConfig,
  resolveConnectionProtectionConfig,
  supportsConnectionKeepAliveSQL,
} from "./utils/connectionReadOnly";
import {
  DEFAULT_QUERY_EDITOR_EDITOR_HEIGHT_RATIO,
  sanitizeQueryEditorEditorHeightRatio,
} from "./utils/queryEditorSplitLayout";
import { sanitizeSidebarWidth } from "./utils/sidebarLayout";
import {
  DEFAULT_SIDEBAR_TABLE_METADATA_FIELDS,
  applySidebarTableMetadataFieldOrder,
  resolveSidebarTableMetadataFieldOrder,
  resolveSidebarTableMetadataFields,
  sanitizeSidebarTableMetadataFields,
  type SidebarTableMetadataField,
} from "./utils/sidebarTableMetadata";
import {
  sanitizeSidebarHiddenObjectGroups,
  type SidebarObjectGroupKey,
} from "./utils/sidebarObjectVisibility";
import {
  CONNECTION_TYPE_GROUPS,
  getConnectionTypeDefaultPort,
} from "./utils/connectionTypeCatalog";
import { supportsSSLForType } from "./utils/connectionTypeCapabilities";
import { normalizeDriverType } from "./utils/connectionDriverType";
import { createDebouncedPersistStorage } from "./utils/debouncedPersistStorage";
import {
  incrementTableAccessCount,
  removeConnectionTableAccessCounts,
  sanitizeTableAccessCount,
} from "./utils/tableAccessCount";

export type TableDoubleClickAction = "open-data" | "open-design";
export type ThemeMode = "light" | "dark";
export type ThemePreference = ThemeMode | "system";
/** AI 聊天默认打开形态：侧栏 / 独立浮动窗 */
export type AIChatOpenMode = "dock" | "detached";

export interface AppearanceSettings
  extends DataGridDisplaySettings, SqlEditorTypographySettings {
  uiVersion: "legacy" | "v2";
  enabled: boolean;
  opacity: number;
  blur: number;
  tableDoubleClickAction: TableDoubleClickAction;
  v2SidebarSearchMode: "command" | "filter";
  v2CommandSearchPersistentFilterEnabled: boolean;
  v2SidebarPersistedFilter: string;
  v2SidebarRailScale: number;
  sidebarSingleDatabaseExpansion: boolean;
  sidebarHiddenObjectGroups: SidebarObjectGroupKey[];
  customUIFontFamily: string | null;
  customMonoFontFamily: string | null;
  newQuerySqlTemplate: string | null;
  tabDisplay: TabDisplaySettings;
  redisDbAliases: RedisDbAliasMap;
}

export const DEFAULT_V2_SIDEBAR_RAIL_SCALE = 1.0;
export const MIN_V2_SIDEBAR_RAIL_SCALE = 1.0;
export const MAX_V2_SIDEBAR_RAIL_SCALE = 1.8;

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  uiVersion: "v2",
  enabled: true,
  opacity: 1.0,
  blur: 0,
  tableDoubleClickAction: "open-data",
  v2SidebarSearchMode: "command",
  v2CommandSearchPersistentFilterEnabled: false,
  v2SidebarPersistedFilter: "",
  v2SidebarRailScale: DEFAULT_V2_SIDEBAR_RAIL_SCALE,
  sidebarSingleDatabaseExpansion: false,
  sidebarHiddenObjectGroups: [],
  customUIFontFamily: null,
  customMonoFontFamily: null,
  newQuerySqlTemplate: null,
  tabDisplay: DEFAULT_TAB_DISPLAY_SETTINGS,
  redisDbAliases: DEFAULT_REDIS_DB_ALIASES,
  ...DEFAULT_DATA_GRID_DISPLAY_SETTINGS,
  ...DEFAULT_SQL_EDITOR_TYPOGRAPHY_SETTINGS,
};
const DEFAULT_UI_SCALE = 1.0;
const MIN_UI_SCALE = 0.8;
const MAX_UI_SCALE = 1.25;
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
const DEFAULT_STARTUP_FULLSCREEN = false;
const DEFAULT_AUTO_CHECK_FOR_UPDATES = true;
/** 自动检查更新间隔（分钟）；与关于页 Select 选项保持一致 */
export const AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS = [
  15, 30, 60, 120, 360, 720, 1440,
] as const;
const DEFAULT_AUTO_CHECK_FOR_UPDATES_INTERVAL_MINUTES = 30;
const AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS_SET = new Set<number>(
  AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS,
);
const LEGACY_DEFAULT_OPACITY = 0.95;
const OPACITY_EPSILON = 1e-6;
const MAX_SIDEBAR_PERSISTED_FILTER_LENGTH = 120;
const MAX_NEW_QUERY_SQL_TEMPLATE_LENGTH = 32 * 1024;

const sanitizeV2SidebarSearchMode = (
  value: unknown,
): AppearanceSettings["v2SidebarSearchMode"] => {
  return value === "filter" ? "filter" : DEFAULT_APPEARANCE.v2SidebarSearchMode;
};

const sanitizeTableDoubleClickAction = (
  value: unknown,
): TableDoubleClickAction => {
  return value === "open-design" ? "open-design" : DEFAULT_APPEARANCE.tableDoubleClickAction;
};

const sanitizeV2SidebarPersistedFilter = (value: unknown): string => {
  if (typeof value !== "string") {
    return DEFAULT_APPEARANCE.v2SidebarPersistedFilter;
  }
  return value.trim().slice(0, MAX_SIDEBAR_PERSISTED_FILTER_LENGTH);
};

const sanitizeNewQuerySqlTemplate = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return DEFAULT_APPEARANCE.newQuerySqlTemplate;
  }
  if (typeof value !== "string") {
    return DEFAULT_APPEARANCE.newQuerySqlTemplate;
  }
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .slice(0, MAX_NEW_QUERY_SQL_TEMPLATE_LENGTH);
};

export const sanitizeV2SidebarRailScale = (value: unknown): number => {
  return normalizeFloatInRange(
    value,
    DEFAULT_V2_SIDEBAR_RAIL_SCALE,
    MIN_V2_SIDEBAR_RAIL_SCALE,
    MAX_V2_SIDEBAR_RAIL_SCALE,
  );
};

const MAX_URI_LENGTH = 4096;
const MAX_HOST_ENTRY_LENGTH = 512;
const MAX_HOST_ENTRIES = 64;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_KEEPALIVE_INTERVAL_MINUTES = 240;
const MIN_KEEPALIVE_INTERVAL_MINUTES = 1;
const MAX_KEEPALIVE_INTERVAL_MINUTES = 1440;
const DEFAULT_DIAGNOSTIC_TIMEOUT_SECONDS = 15;
const MAX_DIAGNOSTIC_TIMEOUT_SECONDS = 300;
const PERSIST_VERSION = 20;
const SQL_EDITOR_FONT_SIZE_SPLIT_VERSION = 19;
const TAB_DISPLAY_DEFAULT_MIGRATION_VERSION = 20;
const UI_VERSION_V2_MIGRATION_VERSION = 14;
const SIDEBAR_SEARCH_SHORTCUT_MIGRATION_VERSION = 18;
const PERSIST_STORAGE_KEY = "lite-db-storage";
const PERSIST_WRITE_DEBOUNCE_MS = 160;
const MAX_PERSISTED_QUERY_TABS = 20;
const MAX_PERSISTED_QUERY_LENGTH = 1024 * 1024;
const MAX_RUNTIME_SQL_LOGS = 120;
const MAX_RUNTIME_SQL_LOG_LENGTH = 12 * 1024;
const MAX_RUNTIME_SQL_LOG_MESSAGE_LENGTH = 1024;
const MAX_PERSISTED_SQL_LOGS = 200;
const MAX_PERSISTED_SQL_LOG_LENGTH = 24 * 1024;
const MAX_PERSISTED_SQL_LOG_MESSAGE_LENGTH = 2 * 1024;
const MAX_TABLE_EXPORT_HISTORY_PER_TARGET = 20;
const MAX_TABLE_EXPORT_HISTORY_TARGETS = 200;
const MAX_RECENT_WORKBENCH_TARGETS = 8;
const MAX_RECENT_SQL_FILES = 8;
const MAX_RECENT_TARGET_DATABASE_LENGTH = 256;
const MAX_RECENT_SQL_FILE_NAME_LENGTH = 256;
const DEFAULT_CONNECTION_TYPE = "mysql";
const DEFAULT_JVM_PORT = 9010;
const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = "system";
const MAX_REDIS_DATABASE_INDEX = Number.MAX_SAFE_INTEGER;
const DEFAULT_GLOBAL_PROXY: GlobalProxyConfig = {
  enabled: false,
  type: "socks5",
  host: "",
  port: 1080,
  user: "",
  password: "",
  hasPassword: false,
};

const isFrontendTestRuntime = (): boolean => {
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env || {};
  return env.MODE === "test" || env.VITEST === true || env.VITEST === "true";
};

const resolveSavedQueryBackend = (): SavedQueryBackend | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (window as unknown as { go?: { app?: { App?: SavedQueryBackend } } }).go?.app?.App;
};

const writePersistedStatePatch = (
  patch: Record<string, unknown>,
): void => {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const payload = localStorage.getItem(PERSIST_STORAGE_KEY);
    const raw =
      payload && payload.trim() !== ""
        ? (JSON.parse(payload) as Record<string, unknown>)
        : {};
    const state = unwrapPersistedAppState(raw);
    localStorage.setItem(
      PERSIST_STORAGE_KEY,
      JSON.stringify({
        ...raw,
        state: {
          ...state,
          ...patch,
        },
        version:
          typeof raw.version === "number" ? raw.version : PERSIST_VERSION,
      }),
    );
  } catch {
    // ignore
  }
};

const resolveOceanBaseProtocol = (
  raw: Record<string, unknown>,
  normalizedConnectionParams: string,
  normalizedUri: string,
): "mysql" | "oracle" => {
  const normalizedConfig = {
    ...raw,
    connectionParams: normalizedConnectionParams,
    uri: normalizedUri,
  };
  try {
    return resolveOceanBaseProtocolFromConfig(normalizedConfig);
  } catch {
    return (
      normalizeOceanBaseProtocol(raw.oceanBaseProtocol) ||
      resolveOceanBaseProtocolFromQueryText(normalizedConnectionParams).protocol ||
      resolveOceanBaseProtocolFromQueryText(normalizedUri).protocol ||
      "mysql"
    );
  }
};
const SUPPORTED_CONNECTION_TYPES = new Set([
  ...CONNECTION_TYPE_GROUPS.flatMap((group) =>
    group.items.map((item) => item.key),
  ),
  // Legacy persisted alias, normalized to diros before support is checked.
  "doris",
]);

const toTrimmedString = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return fallback;
};

const indexedStoreFallback = (
  key:
    | "store.fallback.connection_name"
    | "store.fallback.connection_tag_name"
    | "store.fallback.sql_snippet_name",
  index: number,
): string => translate(key, { index: index + 1 });

const normalizeClickHouseProtocol = (
  value: unknown,
): "auto" | "http" | "native" => {
  const text = toTrimmedString(value).toLowerCase();
  if (text === "http" || text === "https") return "http";
  if (text === "native" || text === "tcp") return "native";
  return "auto";
};

const normalizePort = (value: unknown, fallbackPort: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackPort;
  const port = Math.trunc(parsed);
  if (port <= 0 || port > 65535) return fallbackPort;
  return port;
};

const normalizeIntegerInRange = (
  value: unknown,
  fallbackValue: number,
  min: number,
  max: number,
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackValue;
  const normalized = Math.trunc(parsed);
  if (normalized < min || normalized > max) return fallbackValue;
  return normalized;
};

const normalizeFloatInRange = (
  value: unknown,
  fallbackValue: number,
  min: number,
  max: number,
): number => {
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

const sanitizeSchemaVisibilityByDatabase = (
  value: unknown,
): Record<string, SchemaVisibilityRule> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, SchemaVisibilityRule> = {};
  const seenDatabases = new Set<string>();
  Object.entries(value as Record<string, unknown>).some(([rawDatabase, rawRule]) => {
    if (Object.keys(result).length >= 128) return true;
    const database = toTrimmedString(rawDatabase);
    const databaseKey = database.toLocaleLowerCase();
    if (!database || database.length > 256 || seenDatabases.has(databaseKey)) {
      return false;
    }
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      return false;
    }
    const rule = rawRule as Record<string, unknown>;
    const mode = rule.mode === "include" || rule.mode === "exclude"
      ? rule.mode
      : undefined;
    if (!mode) return false;

    const seenSchemas = new Set<string>();
    const schemas = sanitizeStringArray(rule.schemas, 256)
      .filter((schema) => {
        const schemaKey = schema.toLocaleLowerCase();
        if (seenSchemas.has(schemaKey)) return false;
        seenSchemas.add(schemaKey);
        return true;
      })
      .slice(0, 256);
    if (schemas.length === 0) return false;

    seenDatabases.add(databaseKey);
    result[database] = { mode, schemas };
    return false;
  });

  return Object.keys(result).length > 0 ? result : undefined;
};

const sanitizeNumberArray = (
  value: unknown,
  min: number,
  max: number,
): number[] => {
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
  const all = sanitizeStringArray(value, MAX_HOST_ENTRY_LENGTH).filter(
    (entry) => isValidHostEntry(entry),
  );
  return all.slice(0, MAX_HOST_ENTRIES);
};

const sanitizeConnectionIconType = (value: unknown): string | undefined => {
  const iconType = toTrimmedString(value).toLowerCase();
  return iconType || undefined;
};

const sanitizeConnectionIconColor = (value: unknown): string | undefined => {
  const color = toTrimmedString(value);
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)
    ? color
    : undefined;
};

const normalizeConnectionType = (value: unknown): string => {
  const type = normalizeDriverType(toTrimmedString(value));
  if (type === "doris") {
    return "diros";
  }
  if (type === "postgresql") {
    return "postgres";
  }
  if (type === "mssql" || type === "sql_server" || type === "sql-server") {
    return "sqlserver";
  }
  if (type === "kingbase8" || type === "kingbasees" || type === "kingbasev8") {
    return "kingbase";
  }
  if (type === "dm" || type === "dm8") {
    return "dameng";
  }
  if (type === "sqlite3") {
    return "sqlite";
  }
  if (type === "sphinxql") {
    return "sphinx";
  }
  if (
    type === "open_gauss" ||
    type === "open-gauss" ||
    type === "opengauss"
  ) {
    return "opengauss";
  }
  if (type === "gaussdb" || type === "gauss_db" || type === "gauss-db") {
    return "gaussdb";
  }
  if (type === "goldendb" || type === "greatdb" || type === "gdb") {
    return "goldendb";
  }
  if (type === "kafka" || type === "apache-kafka" || type === "apache_kafka") {
    return "kafka";
  }
  if (
    type === "inter-systems" ||
    type === "inter-systems-iris" ||
    type === "intersystems" ||
    type === "intersystems iris" ||
    type === "intersystemsiris" ||
    type.includes("iris")
  ) {
    return "iris";
  }
  return SUPPORTED_CONNECTION_TYPES.has(type) ? type : DEFAULT_CONNECTION_TYPE;
};

const sanitizeJVMModes = (
  value: unknown,
): Array<"jmx" | "endpoint" | "agent"> => {
  if (!Array.isArray(value)) return ["jmx"];
  const result: Array<"jmx" | "endpoint" | "agent"> = [];
  const seen = new Set<"jmx" | "endpoint" | "agent">();
  value.forEach((entry) => {
    const normalized = toTrimmedString(entry).toLowerCase();
    if (
      normalized !== "jmx" &&
      normalized !== "endpoint" &&
      normalized !== "agent"
    )
      return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result.length > 0 ? result : ["jmx"];
};

const sanitizeJVMConfig = (
  value: unknown,
  options: {
    host: string;
    port: number;
    timeout: number;
    persistSecrets: boolean;
  },
): ConnectionConfig["jvm"] => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const allowedModes = sanitizeJVMModes(raw.allowedModes);
  const preferredModeRaw = toTrimmedString(raw.preferredMode).toLowerCase();
  const preferredMode = allowedModes.includes(
    preferredModeRaw as "jmx" | "endpoint" | "agent",
  )
    ? (preferredModeRaw as "jmx" | "endpoint" | "agent")
    : allowedModes[0];
  const environmentRaw = toTrimmedString(raw.environment, "dev").toLowerCase();
  const environment: "dev" | "uat" | "prod" =
    environmentRaw === "uat"
      ? "uat"
      : environmentRaw === "prod"
        ? "prod"
        : "dev";
  const jmxRaw =
    raw.jmx && typeof raw.jmx === "object"
      ? (raw.jmx as Record<string, unknown>)
      : {};
  const endpointRaw =
    raw.endpoint && typeof raw.endpoint === "object"
      ? (raw.endpoint as Record<string, unknown>)
      : {};
  const agentRaw =
    raw.agent && typeof raw.agent === "object"
      ? (raw.agent as Record<string, unknown>)
      : {};
  const diagnosticRaw =
    raw.diagnostic && typeof raw.diagnostic === "object"
      ? (raw.diagnostic as Record<string, unknown>)
      : {};
  const diagnosticTransportRaw = toTrimmedString(
    diagnosticRaw.transport,
    "agent-bridge",
  ).toLowerCase();
  const diagnosticTransport =
    diagnosticTransportRaw === "arthas-tunnel"
      ? "arthas-tunnel"
      : "agent-bridge";
  const fallbackPort = options.port > 0 ? options.port : DEFAULT_JVM_PORT;
  const fallbackTimeout =
    options.timeout > 0 ? options.timeout : DEFAULT_TIMEOUT_SECONDS;

  return {
    environment,
    readOnly: typeof raw.readOnly === "boolean" ? raw.readOnly : true,
    allowedModes,
    preferredMode,
    jmx: {
      enabled: jmxRaw.enabled === true || allowedModes.includes("jmx"),
      host: toTrimmedString(jmxRaw.host, options.host) || options.host,
      port: normalizePort(jmxRaw.port, fallbackPort),
      username: toTrimmedString(jmxRaw.username),
      password: options.persistSecrets ? toTrimmedString(jmxRaw.password) : "",
      domainAllowlist: sanitizeStringArray(jmxRaw.domainAllowlist, 256),
    },
    endpoint: {
      enabled: endpointRaw.enabled === true,
      baseUrl: toTrimmedString(endpointRaw.baseUrl),
      apiKey: options.persistSecrets ? toTrimmedString(endpointRaw.apiKey) : "",
      timeoutSeconds: normalizeIntegerInRange(
        endpointRaw.timeoutSeconds,
        fallbackTimeout,
        1,
        MAX_TIMEOUT_SECONDS,
      ),
    },
    agent: {
      enabled: agentRaw.enabled === true,
      baseUrl: toTrimmedString(agentRaw.baseUrl),
      apiKey: options.persistSecrets ? toTrimmedString(agentRaw.apiKey) : "",
      timeoutSeconds: normalizeIntegerInRange(
        agentRaw.timeoutSeconds,
        fallbackTimeout,
        1,
        MAX_TIMEOUT_SECONDS,
      ),
    },
    diagnostic: {
      enabled: diagnosticRaw.enabled === true,
      transport: diagnosticTransport,
      baseUrl: toTrimmedString(diagnosticRaw.baseUrl),
      targetId: toTrimmedString(diagnosticRaw.targetId),
      apiKey: options.persistSecrets
        ? toTrimmedString(diagnosticRaw.apiKey)
        : "",
      allowObserveCommands: diagnosticRaw.allowObserveCommands !== false,
      allowTraceCommands: diagnosticRaw.allowTraceCommands === true,
      allowMutatingCommands: diagnosticRaw.allowMutatingCommands === true,
      timeoutSeconds: normalizeIntegerInRange(
        diagnosticRaw.timeoutSeconds,
        DEFAULT_DIAGNOSTIC_TIMEOUT_SECONDS,
        1,
        MAX_DIAGNOSTIC_TIMEOUT_SECONDS,
      ),
    },
  };
};

const sanitizeConnectionConfig = (value: unknown): ConnectionConfig => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const type = normalizeConnectionType(raw.type);
  const defaultPort = getConnectionTypeDefaultPort(type);
  const savePassword =
    typeof raw.savePassword === "boolean" ? raw.savePassword : true;
  const mongoSrv = !!raw.mongoSrv;
  const sslCapable = supportsSSLForType(type);
  const sslModeRaw = toTrimmedString(raw.sslMode, "preferred").toLowerCase();
  const sslMode: "preferred" | "required" | "skip-verify" | "disable" =
    sslModeRaw === "required"
      ? "required"
      : sslModeRaw === "skip-verify"
        ? "skip-verify"
        : sslModeRaw === "disable"
          ? "disable"
          : "preferred";

  const sshRaw =
    raw.ssh && typeof raw.ssh === "object"
      ? (raw.ssh as Record<string, unknown>)
      : {};
  const ssh = {
    host: toTrimmedString(sshRaw.host),
    port: normalizePort(sshRaw.port, 22),
    user: toTrimmedString(sshRaw.user),
    password: toTrimmedString(sshRaw.password),
    keyPath: toTrimmedString(sshRaw.keyPath),
  };
  const proxyRaw =
    raw.proxy && typeof raw.proxy === "object"
      ? (raw.proxy as Record<string, unknown>)
      : {};
  const proxyTypeRaw = toTrimmedString(proxyRaw.type, "socks5").toLowerCase();
  const proxyType: "socks5" | "http" =
    proxyTypeRaw === "http" ? "http" : "socks5";
  const proxy = {
    type: proxyType,
    host: toTrimmedString(proxyRaw.host),
    port: normalizePort(proxyRaw.port, proxyTypeRaw === "http" ? 8080 : 1080),
    user: toTrimmedString(proxyRaw.user),
    password: toTrimmedString(proxyRaw.password),
  };
  const httpTunnelRaw =
    raw.httpTunnel && typeof raw.httpTunnel === "object"
      ? (raw.httpTunnel as Record<string, unknown>)
      : raw.HTTPTunnel && typeof raw.HTTPTunnel === "object"
        ? (raw.HTTPTunnel as Record<string, unknown>)
        : {};
  const httpTunnel = {
    host: toTrimmedString(httpTunnelRaw.host ?? raw.httpTunnelHost),
    port: normalizePort(httpTunnelRaw.port ?? raw.httpTunnelPort, 8080),
    user: toTrimmedString(httpTunnelRaw.user ?? raw.httpTunnelUser),
    password: toTrimmedString(httpTunnelRaw.password ?? raw.httpTunnelPassword),
  };
  const supportsNetworkTunnel = type !== "sqlite" && type !== "duckdb";
  const useHttpTunnel =
    supportsNetworkTunnel &&
    (raw.useHttpTunnel === true || raw.UseHTTPTunnel === true);
  const useProxy = supportsNetworkTunnel && !!raw.useProxy && !useHttpTunnel;
  const normalizedProtection = normalizeConnectionProtectionConfig(
    raw.protection,
  );

  const safeConfig: ConnectionConfig & Record<string, unknown> = {
    ...raw,
    id: toTrimmedString(raw.id ?? raw.ID),
    type,
    host: toTrimmedString(raw.host, "localhost") || "localhost",
    port: normalizePort(raw.port, defaultPort),
    user: toTrimmedString(raw.user),
    password: savePassword ? toTrimmedString(raw.password) : "",
    savePassword,
    database: toTrimmedString(raw.database),
    readOnly: raw.readOnly === true,
    protection: normalizedProtection,
    useSSL: sslCapable ? !!raw.useSSL : false,
    sslMode: sslCapable ? sslMode : "disable",
    sslCAPath: sslCapable ? toTrimmedString(raw.sslCAPath) : "",
    sslCertPath: sslCapable ? toTrimmedString(raw.sslCertPath) : "",
    sslKeyPath: sslCapable ? toTrimmedString(raw.sslKeyPath) : "",
    useSSH: !!raw.useSSH,
    ssh,
    useProxy,
    proxy,
    useHttpTunnel,
    httpTunnel,
    uri: toTrimmedString(raw.uri).slice(0, MAX_URI_LENGTH),
    connectionParams: toTrimmedString(raw.connectionParams).slice(
      0,
      MAX_URI_LENGTH,
    ),
    hosts: sanitizeAddressList(raw.hosts),
    topology:
      raw.topology === "replica"
        ? "replica"
        : raw.topology === "cluster"
          ? "cluster"
          : raw.topology === "sentinel"
            ? "sentinel"
          : "single",
    mysqlReplicaUser: toTrimmedString(raw.mysqlReplicaUser),
    mysqlReplicaPassword: savePassword
      ? toTrimmedString(raw.mysqlReplicaPassword)
      : "",
    replicaSet: toTrimmedString(raw.replicaSet),
    authSource: toTrimmedString(raw.authSource),
    readPreference: toTrimmedString(raw.readPreference),
    mongoSrv,
    mongoAuthMechanism: toTrimmedString(raw.mongoAuthMechanism),
    mongoReplicaUser: toTrimmedString(raw.mongoReplicaUser),
    mongoReplicaPassword: savePassword
      ? toTrimmedString(raw.mongoReplicaPassword)
      : "",
    timeout: normalizeIntegerInRange(
      raw.timeout,
      DEFAULT_TIMEOUT_SECONDS,
      1,
      MAX_TIMEOUT_SECONDS,
    ),
    keepAliveEnabled: Boolean(raw.keepAliveEnabled),
    keepAliveIntervalMinutes: normalizeIntegerInRange(
      raw.keepAliveIntervalMinutes,
      DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
      MIN_KEEPALIVE_INTERVAL_MINUTES,
      MAX_KEEPALIVE_INTERVAL_MINUTES,
    ),
    keepAliveSQL: supportsConnectionKeepAliveSQL({
      type,
      driver: toTrimmedString(raw.driver),
      oceanBaseProtocol:
        raw.oceanBaseProtocol as ConnectionConfig["oceanBaseProtocol"],
    })
      ? toTrimmedString(raw.keepAliveSQL).slice(
          0,
          MAX_CONNECTION_KEEPALIVE_SQL_LENGTH,
        )
      : "",
  };

  const resolvedProtection = resolveConnectionProtectionConfig(safeConfig);
  safeConfig.protection = resolvedProtection;
  safeConfig.readOnly = deriveLegacyConnectionReadOnlyFlag(resolvedProtection);

  if (type === "redis") {
    safeConfig.redisDB = normalizeIntegerInRange(
      raw.redisDB,
      0,
      0,
      MAX_REDIS_DATABASE_INDEX,
    );
    safeConfig.redisSentinelMaster = toTrimmedString(raw.redisSentinelMaster);
    safeConfig.redisSentinelUser = toTrimmedString(raw.redisSentinelUser);
    safeConfig.redisSentinelPassword = savePassword
      ? toTrimmedString(raw.redisSentinelPassword)
      : "";
  }

  if (type === "clickhouse") {
    safeConfig.clickHouseProtocol = normalizeClickHouseProtocol(
      raw.clickHouseProtocol,
    );
  }

  if (type === "oceanbase") {
    safeConfig.oceanBaseProtocol = resolveOceanBaseProtocol(
      raw,
      safeConfig.connectionParams || "",
      safeConfig.uri || "",
    );
  }

  if (type === "custom") {
    safeConfig.driver = toTrimmedString(raw.driver);
    safeConfig.dsn = toTrimmedString(raw.dsn).slice(0, MAX_URI_LENGTH);
  }

  if (type === "jvm") {
    safeConfig.jvm = sanitizeJVMConfig(raw.jvm, {
      host: safeConfig.host,
      port: safeConfig.port,
      timeout: safeConfig.timeout || DEFAULT_TIMEOUT_SECONDS,
      persistSecrets: savePassword,
    });
  }

  return safeConfig;
};

const resolveConnectionConfigPayload = (
  raw: Record<string, unknown>,
): unknown => {
  if (raw.config && typeof raw.config === "object") {
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

const sanitizeSavedConnection = (
  value: unknown,
  index: number,
): SavedConnection | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const config = sanitizeConnectionConfig(resolveConnectionConfigPayload(raw));
  const id =
    toTrimmedString(raw.id, `conn-${index + 1}`) || `conn-${index + 1}`;
  const displayType = config.type === "diros" ? "doris" : config.type;
  const fallbackName = config.host
    ? `${displayType}-${config.host}`
    : indexedStoreFallback("store.fallback.connection_name", index);
  const name = toTrimmedString(raw.name, fallbackName) || fallbackName;
  const includeDatabases = sanitizeStringArray(raw.includeDatabases, 256);
  const includeRedisDatabases = sanitizeNumberArray(
    raw.includeRedisDatabases,
    0,
    MAX_REDIS_DATABASE_INDEX,
  );
  const schemaVisibilityByDatabase = sanitizeSchemaVisibilityByDatabase(
    raw.schemaVisibilityByDatabase,
  );

  return {
    id,
    name,
    environmentType: normalizeConnectionEnvironmentType(raw.environmentType),
    config: { ...config, id: config.id || id },
    secretRef: toTrimmedString(raw.secretRef) || undefined,
    hasPrimaryPassword: raw.hasPrimaryPassword === true,
    hasSSHPassword: raw.hasSSHPassword === true,
    hasProxyPassword: raw.hasProxyPassword === true,
    hasHttpTunnelPassword: raw.hasHttpTunnelPassword === true,
    hasMySQLReplicaPassword: raw.hasMySQLReplicaPassword === true,
    hasMongoReplicaPassword: raw.hasMongoReplicaPassword === true,
    hasRedisSentinelPassword: raw.hasRedisSentinelPassword === true,
    hasOpaqueURI: raw.hasOpaqueURI === true,
    hasOpaqueDSN: raw.hasOpaqueDSN === true,
    includeDatabases:
      includeDatabases.length > 0 ? includeDatabases : undefined,
    includeRedisDatabases:
      includeRedisDatabases.length > 0 ? includeRedisDatabases : undefined,
    schemaVisibilityByDatabase,
    iconType: sanitizeConnectionIconType(raw.iconType),
    iconColor: sanitizeConnectionIconColor(raw.iconColor),
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

const SIDEBAR_ROOT_TAG_TOKEN_PREFIX = "tag:";
const SIDEBAR_ROOT_CONNECTION_TOKEN_PREFIX = "connection:";

export const buildSidebarRootTagToken = (tagId: string): string =>
  `${SIDEBAR_ROOT_TAG_TOKEN_PREFIX}${toTrimmedString(tagId)}`;

export const buildSidebarRootConnectionToken = (
  connectionId: string,
): string => `${SIDEBAR_ROOT_CONNECTION_TOKEN_PREFIX}${toTrimmedString(connectionId)}`;

const isSidebarRootTagToken = (token: string): boolean =>
  token.startsWith(SIDEBAR_ROOT_TAG_TOKEN_PREFIX) &&
  token.length > SIDEBAR_ROOT_TAG_TOKEN_PREFIX.length;

const isSidebarRootConnectionToken = (token: string): boolean =>
  token.startsWith(SIDEBAR_ROOT_CONNECTION_TOKEN_PREFIX) &&
  token.length > SIDEBAR_ROOT_CONNECTION_TOKEN_PREFIX.length;

const getSidebarTagIdFromToken = (token: string): string =>
  isSidebarRootTagToken(token)
    ? token.slice(SIDEBAR_ROOT_TAG_TOKEN_PREFIX.length)
    : "";

const getSidebarConnectionIdFromToken = (token: string): string =>
  isSidebarRootConnectionToken(token)
    ? token.slice(SIDEBAR_ROOT_CONNECTION_TOKEN_PREFIX.length)
    : "";

const sanitizeSidebarItemOrder = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((entry) => {
    const token = toTrimmedString(entry);
    if (!token) return;
    if (!isSidebarRootTagToken(token) && !isSidebarRootConnectionToken(token)) {
      return;
    }
    if (seen.has(token)) return;
    seen.add(token);
    result.push(token);
  });
  return result;
};

const sanitizeSidebarRootOrder = sanitizeSidebarItemOrder;

const normalizeConnectionTagTree = (
  value: ConnectionTag[],
): ConnectionTag[] => {
  const tags: ConnectionTag[] = [];
  const idSet = new Set<string>();

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const id =
      toTrimmedString(entry.id, `tag-${index + 1}`) || `tag-${index + 1}`;
    if (idSet.has(id)) return;
    idSet.add(id);

    const fallbackName = indexedStoreFallback(
      "store.fallback.connection_tag_name",
      index,
    );
    const name = toTrimmedString(entry.name, fallbackName) || fallbackName;
    const parentTagId = toTrimmedString(entry.parentTagId) || undefined;
    tags.push({
      id,
      name,
      environmentType: normalizeConnectionEnvironmentType(entry.environmentType),
      parentTagId,
      connectionIds: sanitizeStringArray(entry.connectionIds, 256),
      childOrder: sanitizeSidebarItemOrder(entry.childOrder),
    });
  });

  const tagById = new Map(tags.map((tag) => [tag.id, tag]));
  tags.forEach((tag) => {
    if (
      !tag.parentTagId ||
      tag.parentTagId === tag.id ||
      !tagById.has(tag.parentTagId)
    ) {
      tag.parentTagId = undefined;
    }
  });

  // Corrupted persisted data must never make the sidebar recurse forever.
  // Promote every member of a detected parent cycle to the root.
  tags.forEach((tag) => {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let currentId = tag.id;
    while (currentId) {
      const current = tagById.get(currentId);
      if (!current?.parentTagId) break;
      const cycleStart = pathIndex.get(currentId);
      if (cycleStart !== undefined) {
        path.slice(cycleStart).forEach((cycleTagId) => {
          const cycleTag = tagById.get(cycleTagId);
          if (cycleTag) cycleTag.parentTagId = undefined;
        });
        break;
      }
      pathIndex.set(currentId, path.length);
      path.push(currentId);
      currentId = current.parentTagId;
    }
  });

  // A host can have one direct owner only. Keep the first persisted owner to
  // make recovery deterministic and match the flat model's intended invariant.
  const assignedConnectionIds = new Set<string>();
  tags.forEach((tag) => {
    tag.connectionIds = tag.connectionIds.filter((connectionId) => {
      if (assignedConnectionIds.has(connectionId)) return false;
      assignedConnectionIds.add(connectionId);
      return true;
    });
  });

  return tags.map((tag) => {
    const childOrder = resolveConnectionTagChildOrder(tag.id, tags);
    return {
      ...tag,
      // Keep the direct-host array aligned with its display-order subsequence.
      connectionIds: childOrder
        .filter(isSidebarRootConnectionToken)
        .map(getSidebarConnectionIdFromToken),
      childOrder,
    };
  });
};

const sanitizeConnectionTags = (value: unknown): ConnectionTag[] => {
  if (!Array.isArray(value)) return [];
  const result: ConnectionTag[] = [];
  const idSet = new Set<string>();

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const raw = entry as Record<string, unknown>;
    const id =
      toTrimmedString(raw.id, `tag-${index + 1}`) || `tag-${index + 1}`;
    if (idSet.has(id)) return;
    idSet.add(id);

    const fallbackName = indexedStoreFallback(
      "store.fallback.connection_tag_name",
      index,
    );
    const name = toTrimmedString(raw.name, fallbackName) || fallbackName;
    result.push({
      id,
      name,
      environmentType: normalizeConnectionEnvironmentType(raw.environmentType),
      parentTagId: toTrimmedString(raw.parentTagId) || undefined,
      connectionIds: sanitizeStringArray(raw.connectionIds, 256),
      childOrder: sanitizeSidebarItemOrder(raw.childOrder),
    });
  });

  return normalizeConnectionTagTree(result);
};

export const resolveConnectionTagChildOrder = (
  tagId: string,
  connectionTags: ConnectionTag[],
): string[] => {
  const tag = connectionTags.find((candidate) => candidate.id === tagId);
  if (!tag) return [];

  const defaultOrder = [
    ...sanitizeStringArray(tag.connectionIds, 256).map(
      buildSidebarRootConnectionToken,
    ),
    ...connectionTags
      .filter((candidate) => candidate.parentTagId === tagId)
      .map((candidate) => buildSidebarRootTagToken(candidate.id)),
  ];
  const validTokens = new Set(defaultOrder);
  const seen = new Set<string>();
  const result: string[] = [];

  sanitizeSidebarItemOrder(tag.childOrder).forEach((token) => {
    if (!validTokens.has(token) || seen.has(token)) return;
    seen.add(token);
    result.push(token);
  });
  defaultOrder.forEach((token) => {
    if (seen.has(token)) return;
    seen.add(token);
    result.push(token);
  });

  return result;
};

const buildDefaultSidebarRootOrderTokens = (
  connectionTags: ConnectionTag[],
  connections: SavedConnection[],
): string[] => {
  const groupedConnectionIds = new Set<string>();
  connectionTags.forEach((tag) => {
    tag.connectionIds.forEach((connectionId) => {
      if (connectionId) groupedConnectionIds.add(connectionId);
    });
  });

  return [
    ...connectionTags
      .filter((tag) => !tag.parentTagId)
      .map((tag) => buildSidebarRootTagToken(tag.id)),
    ...connections
      .filter((connection) => !groupedConnectionIds.has(connection.id))
      .map((connection) => buildSidebarRootConnectionToken(connection.id)),
  ];
};

export const resolveSidebarRootOrderTokens = (
  sidebarRootOrder: unknown,
  connectionTags: ConnectionTag[],
  connections: SavedConnection[],
): string[] => {
  const defaultOrder = buildDefaultSidebarRootOrderTokens(
    connectionTags,
    connections,
  );
  if (defaultOrder.length === 0) {
    return [];
  }

  const validTokens = new Set(defaultOrder);
  const seen = new Set<string>();
  const result: string[] = [];

  sanitizeSidebarRootOrder(sidebarRootOrder).forEach((token) => {
    if (!validTokens.has(token) || seen.has(token)) return;
    seen.add(token);
    result.push(token);
  });

  defaultOrder.forEach((token) => {
    if (seen.has(token)) return;
    seen.add(token);
    result.push(token);
  });

  return result;
};

const resolveHydratedSidebarRootOrderTokens = (
  sidebarRootOrder: unknown,
  connectionTags?: ConnectionTag[],
  connections?: SavedConnection[],
): string[] => {
  const sanitized = sanitizeSidebarRootOrder(sidebarRootOrder);
  if (!connectionTags) {
    return sanitized;
  }
  const rootTagIds = new Set(
    connectionTags
      .filter((tag) => !tag.parentTagId)
      .map((tag) => tag.id),
  );
  const rootOnly = sanitized.filter(
    (token) =>
      !isSidebarRootTagToken(token) ||
      rootTagIds.has(getSidebarTagIdFromToken(token)),
  );
  if (!connections) {
    return rootOnly;
  }
  return resolveSidebarRootOrderTokens(rootOnly, connectionTags, connections);
};

const insertSidebarRootTokenBeforeUngrouped = (
  sidebarRootOrder: string[],
  token: string,
): string[] => {
  if (!token || sidebarRootOrder.includes(token)) {
    return [...sidebarRootOrder];
  }
  const firstConnectionIndex = sidebarRootOrder.findIndex(
    isSidebarRootConnectionToken,
  );
  if (firstConnectionIndex === -1) {
    return [...sidebarRootOrder, token];
  }
  const nextOrder = [...sidebarRootOrder];
  nextOrder.splice(firstConnectionIndex, 0, token);
  return nextOrder;
};

const insertSidebarRootTokenAfter = (
  sidebarRootOrder: string[],
  token: string,
  anchorToken: string,
): string[] => {
  if (!token) return [...sidebarRootOrder];
  const nextOrder = sidebarRootOrder.filter((item) => item !== token);
  const anchorIndex = nextOrder.indexOf(anchorToken);
  if (anchorIndex === -1) {
    nextOrder.push(token);
    return nextOrder;
  }
  nextOrder.splice(anchorIndex + 1, 0, token);
  return nextOrder;
};

const moveSidebarRootToken = (
  sidebarRootOrder: string[],
  sourceToken: string,
  targetToken: string,
  insertBefore: boolean,
): string[] => {
  if (!sourceToken || !targetToken || sourceToken === targetToken) {
    return [...sidebarRootOrder];
  }
  const filtered = sidebarRootOrder.filter((token) => token !== sourceToken);
  const targetIndex = filtered.indexOf(targetToken);
  const insertIndex =
    targetIndex === -1
      ? filtered.length
      : Math.max(
          0,
          Math.min(
            filtered.length,
            insertBefore ? targetIndex : targetIndex + 1,
          ),
        );
  filtered.splice(insertIndex, 0, sourceToken);
  return filtered;
};

type ConnectionTagTreeState = {
  connectionTags: ConnectionTag[];
  sidebarRootOrder: string[];
};

const setConnectionTagChildOrder = (
  connectionTags: ConnectionTag[],
  tagId: string,
  childOrder: string[],
): ConnectionTag[] =>
  connectionTags.map((tag) =>
    tag.id === tagId ? { ...tag, childOrder } : tag,
  );

const removeSidebarItemTokenFromTagOrders = (
  connectionTags: ConnectionTag[],
  token: string,
): ConnectionTag[] =>
  connectionTags.map((tag) => ({
    ...tag,
    childOrder: sanitizeSidebarItemOrder(tag.childOrder).filter(
      (item) => item !== token,
    ),
  }));

const placeSidebarItemToken = (
  order: string[],
  token: string,
  targetToken?: string | null,
  insertBefore = false,
): string[] => {
  if (!token) return [...order];
  if (targetToken === token) return [...order];
  const nextOrder = order.filter((item) => item !== token);
  if (!targetToken) {
    return [...nextOrder, token];
  }
  const targetIndex = nextOrder.indexOf(targetToken);
  if (targetIndex === -1) {
    return [...nextOrder, token];
  }
  const insertIndex = insertBefore ? targetIndex : targetIndex + 1;
  nextOrder.splice(insertIndex, 0, token);
  return nextOrder;
};

const replaceSidebarItemToken = (
  order: string[],
  token: string,
  replacements: string[],
): string[] => {
  const replacementTokens = Array.from(
    new Set(replacements.filter(Boolean)),
  );
  const replacementSet = new Set(replacementTokens);
  const result: string[] = [];
  let inserted = false;

  order.forEach((item) => {
    if (item === token) {
      if (!inserted) {
        result.push(...replacementTokens);
        inserted = true;
      }
      return;
    }
    if (replacementSet.has(item)) return;
    result.push(item);
  });
  if (!inserted) {
    result.push(...replacementTokens);
  }
  return result;
};

const getConnectionOwnerTagId = (
  connectionId: string,
  connectionTags: ConnectionTag[],
): string | undefined =>
  connectionTags.find((tag) => tag.connectionIds.includes(connectionId))?.id;

const getRootConnectionTagId = (
  tagId: string | undefined,
  connectionTags: ConnectionTag[],
): string | undefined => {
  if (!tagId) return undefined;
  const tagById = new Map(connectionTags.map((tag) => [tag.id, tag]));
  const visited = new Set<string>();
  let current = tagById.get(tagId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (!current.parentTagId) return current.id;
    current = tagById.get(current.parentTagId);
  }
  return undefined;
};

const isConnectionTagSelfOrDescendant = (
  tagId: string,
  candidateParentTagId: string,
  connectionTags: ConnectionTag[],
): boolean => {
  const tagById = new Map(connectionTags.map((tag) => [tag.id, tag]));
  const visited = new Set<string>();
  let currentId: string | undefined = candidateParentTagId;
  while (currentId && !visited.has(currentId)) {
    if (currentId === tagId) return true;
    visited.add(currentId);
    currentId = tagById.get(currentId)?.parentTagId;
  }
  return false;
};

const normalizeConnectionTagTreeState = (
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[],
  connections: SavedConnection[],
): ConnectionTagTreeState => {
  const nextTags = normalizeConnectionTagTree(connectionTags);
  return {
    connectionTags: nextTags,
    sidebarRootOrder: resolveSidebarRootOrderTokens(
      sidebarRootOrder,
      nextTags,
      connections,
    ),
  };
};

const moveConnectionTagInTree = (
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[],
  connections: SavedConnection[],
  tagId: string,
  targetParentTagId: string | null,
  targetToken?: string | null,
  insertBefore = false,
): ConnectionTagTreeState | null => {
  const normalized = normalizeConnectionTagTreeState(
    connectionTags,
    sidebarRootOrder,
    connections,
  );
  const tagById = new Map(
    normalized.connectionTags.map((tag) => [tag.id, tag]),
  );
  const source = tagById.get(tagId);
  if (!source) return null;

  const nextParentTagId = toTrimmedString(targetParentTagId) || undefined;
  if (
    nextParentTagId &&
    (!tagById.has(nextParentTagId) ||
      isConnectionTagSelfOrDescendant(
        tagId,
        nextParentTagId,
        normalized.connectionTags,
      ))
  ) {
    return null;
  }

  const token = buildSidebarRootTagToken(tagId);
  let nextTags = removeSidebarItemTokenFromTagOrders(
    normalized.connectionTags,
    token,
  ).map((tag) =>
    tag.id === tagId ? { ...tag, parentTagId: nextParentTagId } : tag,
  );
  let nextRootOrder = normalized.sidebarRootOrder.filter(
    (item) => item !== token,
  );

  nextTags = normalizeConnectionTagTree(nextTags);
  if (nextParentTagId) {
    const targetOrder = resolveConnectionTagChildOrder(
      nextParentTagId,
      nextTags,
    );
    nextTags = setConnectionTagChildOrder(
      nextTags,
      nextParentTagId,
      placeSidebarItemToken(targetOrder, token, targetToken, insertBefore),
    );
  } else {
    const targetOrder = resolveSidebarRootOrderTokens(
      nextRootOrder,
      nextTags,
      connections,
    );
    nextRootOrder = placeSidebarItemToken(
      targetOrder,
      token,
      targetToken,
      insertBefore,
    );
  }

  return normalizeConnectionTagTreeState(
    nextTags,
    nextRootOrder,
    connections,
  );
};

const moveConnectionInTree = (
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[],
  connections: SavedConnection[],
  connectionId: string,
  targetTagId: string | null,
  targetToken?: string | null,
  insertBefore = false,
): ConnectionTagTreeState | null => {
  if (!connections.some((connection) => connection.id === connectionId)) {
    return null;
  }
  const normalized = normalizeConnectionTagTreeState(
    connectionTags,
    sidebarRootOrder,
    connections,
  );
  const nextTargetTagId = toTrimmedString(targetTagId) || undefined;
  if (
    nextTargetTagId &&
    !normalized.connectionTags.some((tag) => tag.id === nextTargetTagId)
  ) {
    return null;
  }

  const sourceTagId = getConnectionOwnerTagId(
    connectionId,
    normalized.connectionTags,
  );
  const sourceRootTagId = getRootConnectionTagId(
    sourceTagId,
    normalized.connectionTags,
  );
  const token = buildSidebarRootConnectionToken(connectionId);
  let nextTags = removeSidebarItemTokenFromTagOrders(
    normalized.connectionTags,
    token,
  ).map((tag) => ({
    ...tag,
    connectionIds: tag.connectionIds.filter((id) => id !== connectionId),
  }));
  let nextRootOrder = normalized.sidebarRootOrder.filter(
    (item) => item !== token,
  );

  if (nextTargetTagId) {
    nextTags = nextTags.map((tag) =>
      tag.id === nextTargetTagId
        ? {
            ...tag,
            connectionIds: [...tag.connectionIds, connectionId],
          }
        : tag,
    );
    nextTags = normalizeConnectionTagTree(nextTags);
    const targetOrder = resolveConnectionTagChildOrder(
      nextTargetTagId,
      nextTags,
    );
    nextTags = setConnectionTagChildOrder(
      nextTags,
      nextTargetTagId,
      placeSidebarItemToken(targetOrder, token, targetToken, insertBefore),
    );
  } else {
    nextTags = normalizeConnectionTagTree(nextTags);
    const rootOrder = resolveSidebarRootOrderTokens(
      nextRootOrder,
      nextTags,
      connections,
    );
    nextRootOrder = targetToken
      ? placeSidebarItemToken(rootOrder, token, targetToken, insertBefore)
      : sourceRootTagId
        ? insertSidebarRootTokenAfter(
            rootOrder,
            token,
            buildSidebarRootTagToken(sourceRootTagId),
          )
        : insertSidebarRootTokenBeforeUngrouped(rootOrder, token);
  }

  return normalizeConnectionTagTreeState(
    nextTags,
    nextRootOrder,
    connections,
  );
};

const orderUngroupedConnectionsBySidebarRootOrder = (
  connections: SavedConnection[],
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[],
): SavedConnection[] => {
  const rootOrder = resolveSidebarRootOrderTokens(
    sidebarRootOrder,
    connectionTags,
    connections,
  );
  const orderMap = new Map<string, number>();
  rootOrder.forEach((token, index) => {
    if (isSidebarRootConnectionToken(token)) {
      orderMap.set(getSidebarConnectionIdFromToken(token), index);
    }
  });
  return [...connections].sort((left, right) => {
    const leftIndex = orderMap.get(left.id);
    const rightIndex = orderMap.get(right.id);
    if (leftIndex !== undefined && rightIndex !== undefined) {
      return leftIndex - rightIndex;
    }
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return 0;
  });
};

const isLegacyDefaultAppearance = (
  appearance: Partial<{ opacity: number; blur: number }> | undefined,
): boolean => {
  if (!appearance) {
    return true;
  }
  const opacity =
    typeof appearance.opacity === "number"
      ? appearance.opacity
      : LEGACY_DEFAULT_OPACITY;
  const blur = typeof appearance.blur === "number" ? appearance.blur : 0;
  return (
    Math.abs(opacity - LEGACY_DEFAULT_OPACITY) < OPACITY_EPSILON && blur === 0
  );
};

export interface SqlLog {
  id: string;
  timestamp: number;
  sql: string;
  status: "success" | "error";
  duration: number;
  hiddenFromRecent?: boolean;
  message?: string;
  dbName?: string;
  affectedRows?: number;
  category?: "query" | "transaction";
  transactionId?: string;
  transactionAction?: "commit" | "rollback";
}

/** 首页一键重新打开的最近连接 / 数据库目标。 */
export interface RecentConnectionTarget {
  connectionId: string;
  dbName?: string;
  openedAt: number;
}

/** 首页一键重新打开的 SQL 文件，始终保留其运行时连接上下文。 */
export interface RecentSQLFile {
  filePath: string;
  fileName: string;
  connectionId: string;
  dbName?: string;
  openedAt: number;
}

export type TableOverviewViewMode = "card" | "list" | "table";

export interface QueryOptions {
  maxRows: number;
  wordWrap: boolean;
  tableOverviewViewMode?: TableOverviewViewMode;
  showColumnComment: boolean;
  showSidebarTableComment?: boolean;
  sidebarTableMetadataFields?: SidebarTableMetadataField[];
  sidebarTableMetadataFieldOrder?: SidebarTableMetadataField[];
  showColumnType: boolean;
  showQueryResultsPanel: boolean;
  queryEditorEditorHeightRatio: number;
}

export interface DataEditTransactionOptions {
  commitMode: "manual" | "auto";
  autoCommitDelayMs: number;
}

export interface SqlEditorTransactionOptions {
  commitMode: "manual" | "auto";
  autoCommitDelayMs: number;
}

export interface SqlEditorPendingTransactionState {
  id: string;
  tabId: string;
  commitMode: "manual" | "auto";
  autoCommitDelayMs: number;
  createdAt: number;
  autoCommitDueAt?: number | null;
  statementCount?: number;
  dbType?: string;
  dbName?: string;
  statements?: string[];
  executionDurationMs?: number;
}

interface AppState {
  connections: SavedConnection[];
  connectionTags: ConnectionTag[];
  sidebarRootOrder: string[];
  tabs: TabData[];
  /** 主工作区已拆出的浮动窗口（会话态，不持久化） */
  detachedWorkbenchWindows: DetachedWorkbenchWindow[];
  /** SQL 结果区已拆出的浮动窗口（会话态，不持久化） */
  detachedQueryResultWindows: DetachedQueryResultWindow[];
  /** AI 聊天独立浮动窗口（单例，会话态不持久化） */
  detachedAIChatWindow: DetachedAIChatWindow | null;
  /** AI 独立窗上次尺寸/位置（持久化，再次打开时复用） */
  aiChatDetachedBoundsMemory: AIChatDetachedBoundsMemory | null;
  activeTabId: string | null;
  activeContext: { connectionId: string; dbName: string } | null;
  savedQueries: SavedQuery[];
  savedQueryGroups: SavedQueryGroup[];
  externalSQLDirectories: ExternalSQLDirectory[];
  recentConnectionTargets: RecentConnectionTarget[];
  recentSQLFiles: RecentSQLFile[];
  theme: ThemeMode;
  themePreference: ThemePreference;
  /** Built-in brand mascot icon id (01-10), used in title bar / about / favicon. */
  brandIconId: string;
  languagePreference: LanguagePreference;
  appearance: AppearanceSettings;
  uiScale: number;
  fontSize: number;
  /** Legacy persisted name; true means maximise the startup window on every desktop platform. */
  startupFullscreen: boolean;
  /** 启动后与定时静默检查更新；默认开启 */
  autoCheckForUpdates: boolean;
  /** 自动检查更新间隔（分钟），默认 30 */
  autoCheckForUpdatesIntervalMinutes: number;
  globalProxy: GlobalProxyConfig;
  sqlFormatOptions: { keywordCase: "upper" | "lower" };
  queryOptions: QueryOptions;
  dataEditTransactionOptions: DataEditTransactionOptions;
  sqlEditorTransactionOptions: SqlEditorTransactionOptions;
  sqlEditorPendingTransactions: Record<string, SqlEditorPendingTransactionState>;
  shortcutOptions: ShortcutOptions;
  sqlSnippets: SqlSnippet[];
  sqlLogs: SqlLog[];
  tableExportHistories: Record<string, TableExportHistoryEntry[]>;
  tableAccessCount: Record<string, number>;
  tableSortPreference: Record<string, "name" | "frequency">;
  tableColumnOrders: Record<string, string[]>;
  enableColumnOrderMemory: boolean;
  /** 数据表横向滚动时左侧固定的数据列（按表维度记忆；勾选列/行号列始终固定） */
  tablePinnedLeftColumns: Record<string, string[]>;
  tableHiddenColumns: Record<string, string[]>;
  enableHiddenColumnMemory: boolean;
  pinnedSidebarTables: string[];
  windowBounds: { width: number; height: number; x: number; y: number } | null;
  windowState: "normal" | "fullscreen" | "maximized";
  sidebarWidth: number;

  // AI 运行时与持久化状态
  aiPanelVisible: boolean;
  /** 打开 AI 时的默认形态：侧栏 dock 或独立窗口 detached（持久化） */
  aiChatOpenMode: AIChatOpenMode;
  aiChatHistory: Record<string, AIChatMessage[]>; // sessionId -> messages
  replaceAIChatHistory: (sessionId: string, messages: AIChatMessage[]) => void;
  aiChatSessions: { id: string; title: string; updatedAt: number }[]; // 历史会话列表
  aiActiveSessionId: string | null;
  updateAISessionTitle: (sessionId: string, title: string) => void;

  aiContexts: Record<string, AIContextItem[]>;
  addAIContext: (connectionKey: string, context: AIContextItem) => void;
  removeAIContext: (
    connectionKey: string,
    dbName: string,
    tableName: string,
  ) => void;
  clearAIContexts: (connectionKey: string) => void;

  jvmDiagnosticDrafts: Record<string, JVMDiagnosticCommandDraft>;
  jvmDiagnosticOutputs: Record<string, JVMDiagnosticEventChunk[]>;
  setJVMDiagnosticDraft: (
    tabId: string,
    draft: Partial<JVMDiagnosticCommandDraft>,
  ) => void;
  appendJVMDiagnosticOutput: (
    tabId: string,
    chunks: JVMDiagnosticEventChunk[],
  ) => void;
  clearJVMDiagnosticOutput: (tabId: string) => void;

  addConnection: (conn: SavedConnection) => void;
  updateConnection: (conn: SavedConnection) => void;
  removeConnection: (id: string) => void;
  replaceConnections: (connections: SavedConnection[]) => void;

  addConnectionTag: (tag: ConnectionTag) => void;
  updateConnectionTag: (tag: ConnectionTag) => void;
  removeConnectionTag: (id: string) => void;
  moveConnectionToTag: (
    connectionId: string,
    targetTagId: string | null,
    targetToken?: string | null,
    insertBefore?: boolean,
  ) => void;
  moveConnectionTag: (
    tagId: string,
    targetParentTagId: string | null,
    targetToken?: string | null,
    insertBefore?: boolean,
  ) => void;
  reorderConnections: (
    connectionId: string,
    targetConnectionId: string,
    targetTagId: string | null,
    insertBefore?: boolean,
  ) => void;
  reorderTags: (tagIds: string[]) => void;
  reorderSidebarRoot: (
    sourceToken: string,
    targetToken: string,
    insertBefore: boolean,
  ) => void;

  addTab: (tab: TabData) => void;
  updateQueryTabDraft: (
    id: string,
    draft: Partial<
      Pick<
        TabData,
        | "query"
        | "connectionId"
        | "dbName"
        | "title"
        | "resultPanelVisible"
        | "formatRestoreSnapshot"
      >
    >,
  ) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToLeft: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  closeTabsByConnection: (connectionId: string) => void;
  closeTabsByDatabase: (connectionId: string, dbName: string) => void;
  moveTab: (sourceId: string, targetId: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (id: string) => void;
  setActiveContext: (
    context: { connectionId: string; dbName: string } | null,
  ) => void;
  detachWorkbenchTab: (
    tabId: string,
    preferred?: Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">>,
  ) => void;
  attachWorkbenchTab: (tabId: string) => void;
  updateDetachedWorkbenchBounds: (
    tabId: string,
    bounds: Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">>,
  ) => void;
  focusDetachedWorkbenchTab: (tabId: string) => void;
  isWorkbenchTabDetached: (tabId: string) => boolean;
  detachQueryResultWindow: (
    windowState: Omit<DetachedQueryResultWindow, keyof DetachedWindowBounds> &
      Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">>,
  ) => void;
  attachQueryResultWindow: (id: string) => DetachedQueryResultWindow | null;
  closeDetachedQueryResultWindow: (id: string) => void;
  updateDetachedQueryResultBounds: (
    id: string,
    bounds: Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">>,
  ) => void;
  focusDetachedQueryResultWindow: (id: string) => void;
  closeDetachedQueryResultWindowsBySourceTab: (sourceQueryTabId: string) => void;

  replaceSavedQueries: (queries: SavedQuery[]) => void;
  replaceSavedQueryGroups: (groups: SavedQueryGroup[]) => void;
  reloadSavedQueryGroups: () => Promise<SavedQueryGroup[]>;
  saveSavedQueryGroup: (group: SavedQueryGroup) => Promise<SavedQueryGroup>;
  deleteSavedQueryGroup: (id: string) => Promise<void>;
  moveSavedQueryToGroup: (queryId: string, groupId?: string | null) => Promise<void>;
  moveSavedQueryGroup: (groupId: string, parentGroupId?: string | null) => Promise<void>;
  saveQuery: (query: SavedQuery) => Promise<SavedQuery>;
  deleteQuery: (id: string) => Promise<void>;
  saveExternalSQLDirectory: (directory: ExternalSQLDirectory) => void;
  deleteExternalSQLDirectory: (id: string) => void;
  updateRecentSQLFilePath: (previousPath: string, nextPath: string) => void;
  removeRecentSQLFilesByPath: (filePath: string) => void;
  moveRecentSQLFilesByDirectory: (previousDirectoryPath: string, nextDirectoryPath: string) => void;
  removeRecentSQLFilesByDirectory: (directoryPath: string) => void;

  setTheme: (theme: ThemeMode) => void;
  setThemePreference: (themePreference: ThemePreference) => void;
  setBrandIconId: (brandIconId: string) => void;
  setLanguagePreference: (languagePreference: LanguagePreference) => void;
  setAppearance: (appearance: Partial<AppearanceSettings>) => void;
  setRedisDbAlias: (
    connectionId: string,
    dbIndex: number,
    alias: string,
  ) => void;
  setUiScale: (scale: number) => void;
  setFontSize: (size: number) => void;
  setStartupFullscreen: (enabled: boolean) => void;
  setAutoCheckForUpdates: (enabled: boolean) => void;
  setAutoCheckForUpdatesIntervalMinutes: (minutes: number) => void;
  setGlobalProxy: (proxy: Partial<GlobalProxyConfig>) => void;
  replaceGlobalProxy: (proxy: Partial<GlobalProxyConfig>) => void;
  setSqlFormatOptions: (options: { keywordCase: "upper" | "lower" }) => void;
  setQueryOptions: (options: Partial<QueryOptions>) => void;
  setDataEditTransactionOptions: (
    options: Partial<DataEditTransactionOptions>,
  ) => void;
  setSqlEditorTransactionOptions: (
    options: Partial<SqlEditorTransactionOptions>,
  ) => void;
  setSqlEditorPendingTransaction: (
    tabId: string,
    transaction: Omit<SqlEditorPendingTransactionState, "tabId"> | null,
  ) => void;
  updateShortcut: (
    action: ShortcutAction,
    binding: Partial<ShortcutPlatformBinding>,
    platform?: ShortcutPlatform,
  ) => void;
  resetShortcutOptions: () => void;
  saveSqlSnippet: (snippet: SqlSnippet) => void;
  deleteSqlSnippet: (id: string) => void;
  resetBuiltinSqlSnippet: (id: string) => void;

  addSqlLog: (log: SqlLog) => void;
  hideSqlLogFromRecent: (id: string) => void;
  clearRecentSqlLogs: () => void;
  clearSqlLogs: () => void;
  upsertTableExportHistory: (
    historyKey: string,
    entry: TableExportHistoryEntry,
  ) => void;

  recordTableAccess: (
    connectionId: string,
    dbName: string,
    tableName: string,
  ) => void;
  setTableSortPreference: (
    connectionId: string,
    dbName: string,
    sortBy: "name" | "frequency",
  ) => void;
  setSidebarTablePinned: (
    connectionId: string,
    dbName: string,
    tableName: string,
    schemaName: string | undefined,
    pinned: boolean,
  ) => void;
  setTableColumnOrder: (
    connectionId: string,
    dbName: string,
    tableName: string,
    order: string[],
  ) => void;
  setEnableColumnOrderMemory: (enabled: boolean) => void;
  clearTableColumnOrder: (
    connectionId: string,
    dbName: string,
    tableName: string,
  ) => void;
  setTablePinnedLeftColumns: (
    connectionId: string,
    dbName: string,
    tableName: string,
    columns: string[],
  ) => void;
  clearTablePinnedLeftColumns: (
    connectionId: string,
    dbName: string,
    tableName: string,
  ) => void;

  setTableHiddenColumns: (
    connectionId: string,
    dbName: string,
    tableName: string,
    hiddenColumns: string[],
  ) => void;
  setEnableHiddenColumnMemory: (enabled: boolean) => void;
  clearTableHiddenColumns: (
    connectionId: string,
    dbName: string,
    tableName: string,
  ) => void;
  setWindowBounds: (bounds: {
    width: number;
    height: number;
    x: number;
    y: number;
  }) => void;
  setWindowState: (state: "normal" | "fullscreen" | "maximized") => void;
  setSidebarWidth: (width: number) => void;

  // AI actions
  toggleAIPanel: () => void;
  setAIPanelVisible: (visible: boolean) => void;
  setAIChatOpenMode: (mode: AIChatOpenMode) => void;
  detachAIChatPanel: (
    preferred?: Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">>,
  ) => void;
  attachAIChatPanel: () => void;
  updateDetachedAIChatBounds: (
    bounds: Partial<Pick<
      DetachedAIChatWindow,
      "x" | "y" | "width" | "height" | "coordinateSpace"
    >>,
  ) => void;
  focusDetachedAIChatPanel: () => void;
  isAIChatDetached: () => boolean;
  addAIChatMessage: (sessionId: string, message: AIChatMessage) => void;
  updateAIChatMessage: (
    sessionId: string,
    messageId: string,
    updates: Partial<AIChatMessage>,
  ) => void;
  deleteAIChatMessage: (sessionId: string, messageId: string) => void;
  truncateAIChatMessages: (sessionId: string, upToMessageId: string) => void;
  clearAIChatHistory: (sessionId: string) => void;
  deleteAISession: (sessionId: string) => void;
  createNewAISession: () => void;
  setAIActiveSessionId: (sessionId: string | null) => void;
}

const AI_STREAMING_MESSAGE_UPDATE_KEYS = new Set<keyof AIChatMessage>([
  "content",
  "thinking",
  "reasoning_content",
  "phase",
]);

const isAIStreamingOnlyMessageUpdate = (
  updates: Partial<AIChatMessage>,
): boolean => {
  const updateKeys = Object.keys(updates) as Array<keyof AIChatMessage>;
  return (
    updateKeys.length > 0 &&
    updateKeys.every((key) => AI_STREAMING_MESSAGE_UPDATE_KEYS.has(key))
  );
};

const sanitizeSqlSnippets = (value: unknown): SqlSnippet[] => {
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

const resolveExternalSQLDirectoryName = (name: unknown, path: string): string => {
  const explicitName = toTrimmedString(name);
  if (explicitName) return explicitName;
  const pathSegment = path.split(/[\\/]/).filter(Boolean).pop();
  return pathSegment || translate("sidebar.sql_directory.default_name");
};

const sanitizeExternalSQLDirectories = (
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

const sanitizeRecentConnectionTargets = (
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

const resolveRecentSQLFileName = (filePath: string, title: unknown): string => {
  const fallbackName = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
  return (toTrimmedString(title) || fallbackName).slice(0, MAX_RECENT_SQL_FILE_NAME_LENGTH);
};

const normalizeRecentSQLPath = (value: unknown): string => {
  const normalized = toTrimmedString(value).replace(/\\/g, '/');
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
};

const isRecentSQLPathInDirectory = (filePath: string, directoryPath: string): boolean => {
  const normalizedFilePath = normalizeRecentSQLPath(filePath);
  const normalizedDirectoryPath = normalizeRecentSQLPath(directoryPath);
  if (!normalizedDirectoryPath) return false;
  if (normalizedDirectoryPath === '/') return normalizedFilePath.startsWith('/');
  return normalizedFilePath === normalizedDirectoryPath
    || normalizedFilePath.startsWith(`${normalizedDirectoryPath}/`);
};

const relocateRecentSQLFilePath = (
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

const sanitizeRecentSQLFiles = (value: unknown): RecentSQLFile[] => {
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

const resolveRecentWorkbenchEntries = (
  state: Pick<AppState, 'recentConnectionTargets' | 'recentSQLFiles'>,
  tab: TabData,
): Pick<AppState, 'recentConnectionTargets' | 'recentSQLFiles'> => ({
  recentConnectionTargets: prependRecentConnectionTarget(
    state.recentConnectionTargets,
    tab,
  ),
  recentSQLFiles: prependRecentSQLFile(state.recentSQLFiles, tab),
});

const sanitizeTableExportHistoryEntry = (
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

const sanitizeTableExportHistories = (
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

const sanitizeQueryTabs = (value: unknown): TabData[] => {
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
      query,
      resultPanelVisible:
        typeof raw.resultPanelVisible === "boolean"
          ? raw.resultPanelVisible
          : undefined,
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

const sanitizeActiveTabId = (activeTabId: unknown, tabs: TabData[]): string | null => {
  const id = toTrimmedString(activeTabId);
  if (id && tabs.some((tab) => tab.id === id)) {
    return id;
  }
  return tabs[0]?.id || null;
};

const resolveCloseTabActiveTabId = (
  closedTab: TabData | undefined,
  newTabs: TabData[],
): string | null => {
  const returnToTabId = toTrimmedString(closedTab?.returnToTabId);
  if (returnToTabId && newTabs.some((tab) => tab.id === returnToTabId)) {
    return returnToTabId;
  }
  return newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
};

const resolveActiveContextFromTab = (
  tab: TabData | null | undefined,
): { connectionId: string; dbName: string } | null => {
  if (!tab) return null;
  const connectionId = toTrimmedString(tab.connectionId);
  if (!connectionId) return null;
  return {
    connectionId,
    dbName: toTrimmedString(tab.dbName),
  };
};

const resolveActiveContextForTabId = (
  tabs: TabData[],
  activeTabId: string | null | undefined,
  fallbackContext: { connectionId: string; dbName: string } | null,
): { connectionId: string; dbName: string } | null => {
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

const isRunningDataImportTab = (tab: TabData | undefined): boolean => (
  tab?.type === "data-import" && tab.dataImportRunning === true
);

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

const sanitizeRuntimeSqlLogs = (value: unknown) =>
  sanitizeSqlLogs(value, RUNTIME_SQL_LOG_SANITIZE_OPTIONS);

const sanitizePersistedSqlLogs = (value: unknown) =>
  sanitizeSqlLogs(value, PERSISTED_SQL_LOG_SANITIZE_OPTIONS);

const appendRuntimeSqlLog = (existing: SqlLog[], entry: SqlLog): SqlLog[] => {
  const nextEntry = sanitizeSqlLogEntry(entry, 0, RUNTIME_SQL_LOG_SANITIZE_OPTIONS);
  if (!nextEntry) {
    return existing;
  }

  const nextLogs = [nextEntry, ...existing.slice(0, MAX_RUNTIME_SQL_LOGS - 1)];
  return existing.some((item) => item.id === nextEntry.id)
    ? sanitizeRuntimeSqlLogs(nextLogs)
    : nextLogs;
};

const hasLegacyConnectionSecrets = (
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

const sanitizeTheme = (value: unknown): ThemeMode =>
  value === "dark" ? "dark" : "light";

const sanitizeThemePreference = (
  value: unknown,
  fallbackTheme: ThemeMode = "light",
): ThemePreference => (value === "system" ? "system" : sanitizeTheme(value ?? fallbackTheme));

const sanitizeLanguagePreference = (value: unknown): LanguagePreference => {
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

const sanitizeSqlFormatOptions = (
  value: unknown,
): { keywordCase: "upper" | "lower" } => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return { keywordCase: raw.keywordCase === "lower" ? "lower" : "upper" };
};

const sanitizeQueryOptions = (value: unknown): QueryOptions => {
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
    showQueryResultsPanel,
    queryEditorEditorHeightRatio,
  };
};

const DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS = new Set([3000, 5000, 10000, 30000]);
const SQL_EDITOR_AUTO_COMMIT_DELAY_OPTIONS = new Set([0, 3000, 5000, 10000, 30000]);

const sanitizeDataEditTransactionOptions = (
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

const sanitizeSqlEditorTransactionOptions = (
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

const sanitizeTableSortPreference = (
  value: unknown,
): Record<string, "name" | "frequency"> => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const result: Record<string, "name" | "frequency"> = {};
  Object.entries(raw).forEach(([key, preference]) => {
    result[key] = preference === "frequency" ? "frequency" : "name";
  });
  return result;
};

const sanitizeTableColumnOrders = (
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

const sanitizeTableHiddenColumns = (
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

const sanitizePinnedSidebarTables = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => toTrimmedString(entry))
        .filter(Boolean),
    ),
  );
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

const sanitizeAppearance = (
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
    uiVersion:
      appearance.uiVersion === "v2" || appearance.uiVersion === "legacy"
        ? appearance.uiVersion
        : DEFAULT_APPEARANCE.uiVersion,
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
    v2SidebarSearchMode: sanitizeV2SidebarSearchMode(
      appearance.v2SidebarSearchMode,
    ),
    v2CommandSearchPersistentFilterEnabled:
      typeof appearance.v2CommandSearchPersistentFilterEnabled === "boolean"
        ? appearance.v2CommandSearchPersistentFilterEnabled
        : DEFAULT_APPEARANCE.v2CommandSearchPersistentFilterEnabled,
    v2SidebarPersistedFilter: sanitizeV2SidebarPersistedFilter(
      appearance.v2SidebarPersistedFilter,
    ),
    v2SidebarRailScale: sanitizeV2SidebarRailScale(
      appearance.v2SidebarRailScale,
    ),
    sidebarSingleDatabaseExpansion:
      appearance.sidebarSingleDatabaseExpansion === true,
    sidebarHiddenObjectGroups: sanitizeSidebarHiddenObjectGroups(
      appearance.sidebarHiddenObjectGroups,
    ),
    customUIFontFamily: sanitizeFontFamilyInput(appearance.customUIFontFamily),
    customMonoFontFamily: sanitizeFontFamilyInput(appearance.customMonoFontFamily),
    newQuerySqlTemplate: sanitizeNewQuerySqlTemplate(appearance.newQuerySqlTemplate),
    tabDisplay: version < TAB_DISPLAY_DEFAULT_MIGRATION_VERSION
      && isLegacyDefaultTabDisplaySettings(appearance.tabDisplay)
      ? sanitizeTabDisplaySettings(DEFAULT_TAB_DISPLAY_SETTINGS)
      : sanitizeTabDisplaySettings(appearance.tabDisplay),
    redisDbAliases: sanitizeRedisDbAliases(appearance.redisDbAliases),
    showDataTableVerticalBorders:
      dataGridDisplaySettings.showDataTableVerticalBorders,
    showDataTableRowNumber: dataGridDisplaySettings.showDataTableRowNumber,
    dataTableDensity: dataGridDisplaySettings.dataTableDensity,
    dataTableFontSize: dataGridDisplaySettings.dataTableFontSize,
    dataTableFontSizeFollowGlobal:
      dataGridDisplaySettings.dataTableFontSizeFollowGlobal,
    sqlEditorFontSize: sqlEditorTypographySettings.sqlEditorFontSize,
    sqlEditorFontSizeFollowGlobal:
      sqlEditorTypographySettings.sqlEditorFontSizeFollowGlobal,
    sidebarTreeFontSize: dataGridDisplaySettings.sidebarTreeFontSize,
    sidebarTreeFontSizeFollowGlobal:
      dataGridDisplaySettings.sidebarTreeFontSizeFollowGlobal,
  };
  if (version < 2 && isLegacyDefaultAppearance(appearance)) {
    return { ...DEFAULT_APPEARANCE };
  }
  return nextAppearance;
};

const sanitizeStartupFullscreen = (value: unknown): boolean => {
  return value === true;
};

const sanitizeAutoCheckForUpdates = (value: unknown): boolean => {
  return typeof value === "boolean" ? value : DEFAULT_AUTO_CHECK_FOR_UPDATES;
};

const sanitizeAutoCheckForUpdatesIntervalMinutes = (
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

const sanitizeUiScale = (value: unknown): number => {
  return normalizeFloatInRange(
    value,
    DEFAULT_UI_SCALE,
    MIN_UI_SCALE,
    MAX_UI_SCALE,
  );
};

const sanitizeFontSize = (value: unknown): number => {
  return normalizeIntegerInRange(
    value,
    DEFAULT_FONT_SIZE,
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
  );
};

const sanitizeGlobalProxy = (
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

const sanitizeWindowState = (
  value: unknown,
): "normal" | "fullscreen" | "maximized" => {
  if (value === "fullscreen" || value === "maximized") return value;
  return "normal";
};

const sanitizeAIChatOpenMode = (value: unknown): AIChatOpenMode => {
  return value === "detached" ? "detached" : "dock";
};

const sanitizeAIChatDetachedBoundsMemory = (
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
const resolveAIChatDetachPreferred = (
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

const sanitizeWindowBounds = (
  value: unknown,
): { width: number; height: number; x: number; y: number } | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const width = Number(raw.width);
  const height = Number(raw.height);
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  )
    return null;
  if (width < 400 || height < 300) return null;
  return {
    width: Math.trunc(width),
    height: Math.trunc(height),
    x: Math.trunc(x),
    y: Math.trunc(y),
  };
};

const unwrapPersistedAppState = (
  persistedState: unknown,
): Record<string, unknown> => {
  if (!persistedState || typeof persistedState !== "object") {
    return {};
  }
  const raw = persistedState as Record<string, unknown>;
  if (raw.state && typeof raw.state === "object") {
    return raw.state as Record<string, unknown>;
  }
  return raw;
};

let shortcutOptionsExplicitlySet = false;

const sanitizePersistedShortcutOptions = (
  value: unknown,
  version: number,
): ShortcutOptions => (
  version < SIDEBAR_SEARCH_SHORTCUT_MIGRATION_VERSION
    ? migrateLegacySidebarSearchShortcutOptions(value)
    : sanitizeShortcutOptions(value)
);

const readPersistedShortcutOptions = (): ShortcutOptions | null => {
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

const resolveShortcutOptionsForPersistence = (
  shortcutOptions: ShortcutOptions,
): ShortcutOptions => {
  const safeOptions = sanitizeShortcutOptions(shortcutOptions);
  if (shortcutOptionsExplicitlySet) {
    return safeOptions;
  }
  return readPersistedShortcutOptions() ?? safeOptions;
};

const runWithExplicitShortcutPersistence = (callback: () => void): void => {
  shortcutOptionsExplicitlySet = true;
  try {
    callback();
  } finally {
    shortcutOptionsExplicitlySet = false;
  }
};

export const buildSidebarTablePinKey = (
  connectionId: string,
  dbName: string,
  tableName: string,
  schemaName = "",
): string => {
  const parts = [
    toTrimmedString(connectionId),
    toTrimmedString(dbName),
    toTrimmedString(schemaName),
    toTrimmedString(tableName),
  ];
  return parts[0] && parts[1] && parts[3] ? JSON.stringify(parts) : "";
};

// --- AI 会话文件持久化辅助函数 ---

/** 每个 session 独立防抖定时器（2秒） */
const _persistTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const _persistGenerations: Record<string, number> = {};
const _persistDirtySessions = new Set<string>();
const _persistInFlight: Partial<Record<string, Promise<void>>> = {};

const _persistSessionNow = async (sessionId: string): Promise<void> => {
  const state = useStore.getState();
  const messages = state.aiChatHistory[sessionId];
  const sessionMeta = state.aiChatSessions.find((s) => s.id === sessionId);
  if (!messages && !sessionMeta) return;
  const title = sessionMeta?.title || translate("ai_chat.panel.session.default_title");
  const updatedAt = sessionMeta?.updatedAt || Date.now();
  const Service = typeof window === "undefined"
    ? undefined
    : (window as any).go?.aiservice?.Service;
  if (typeof Service?.AISaveSession !== "function") return;
  await Service.AISaveSession(sessionId, title, updatedAt, JSON.stringify(messages || []));
};

function _debouncedPersistSession(sessionId: string) {
  if (_persistTimers[sessionId]) clearTimeout(_persistTimers[sessionId]);
  const generation = (_persistGenerations[sessionId] || 0) + 1;
  _persistGenerations[sessionId] = generation;
  _persistDirtySessions.add(sessionId);
  _persistTimers[sessionId] = setTimeout(() => {
    delete _persistTimers[sessionId];
    const inFlight = _persistSessionNow(sessionId);
    _persistInFlight[sessionId] = inFlight;
    void inFlight.then(() => {
      if (_persistGenerations[sessionId] === generation) {
        _persistDirtySessions.delete(sessionId);
      }
    }).catch((e: unknown) => {
      console.error("[AI Session Persist] 持久化失败:", sessionId, e);
    }).finally(() => {
      if (_persistInFlight[sessionId] === inFlight) {
        delete _persistInFlight[sessionId];
      }
    });
  }, 2000);
}

/** Flush pending AI session writes before a native child process exits. */
export async function flushAIChatSessionPersistence(
  sessionIds?: string[],
): Promise<void> {
  const ids = Array.from(new Set(
    (sessionIds ?? Array.from(_persistDirtySessions))
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  ));
  for (let index = 0; index < ids.length; index += 1) {
    try {
      const id = ids[index];
      for (;;) {
        if (_persistTimers[id]) {
          clearTimeout(_persistTimers[id]);
          delete _persistTimers[id];
        }
        const inFlight = _persistInFlight[id];
        if (inFlight) {
          await inFlight.catch(() => undefined);
        }
        const generation = _persistGenerations[id] || 0;
        await _persistSessionNow(id);
        if (_persistGenerations[id] === generation) {
          _persistDirtySessions.delete(id);
          break;
        }
      }
    } catch (error) {
      for (const id of ids.slice(index)) {
        _debouncedPersistSession(id);
      }
      throw error;
    }
  }
}

/** 从后端加载会话列表（仅元数据，不含消息体） */
export async function loadAISessionsFromBackend(): Promise<
  { id: string; title: string; updatedAt: number }[]
> {
  const Service = (window as any).go?.aiservice?.Service;
  if (!Service?.AIGetSessions) return [];
  try {
    const sessions = await Service.AIGetSessions();
    if (Array.isArray(sessions)) {
      useStore.setState({ aiChatSessions: sessions });
      return sessions;
    }
  } catch (e) {
    console.error("[AI Session] 加载会话列表失败:", e);
  }
  return [];
}

/** 从后端加载指定会话的消息数据到内存 */
export async function loadAISessionFromBackend(
  sessionId: string,
): Promise<boolean> {
  const state = useStore.getState();
  // 如果内存中已有消息，跳过重复加载
  if (state.aiChatHistory[sessionId]?.length > 0) return true;

  const Service = (window as any).go?.aiservice?.Service;
  if (!Service?.AILoadSession) return false;
  try {
    const result = await Service.AILoadSession(sessionId);
    if (result?.success) {
      let messages = result.messages;
      // messages 可能是 JSON string 或已解析的数组
      if (typeof messages === "string") {
        try {
          messages = JSON.parse(messages);
        } catch {
          messages = [];
        }
      }
      if (Array.isArray(messages)) {
        useStore.setState((prev) => ({
          aiChatHistory: { ...prev.aiChatHistory, [sessionId]: messages },
        }));
        return true;
      }
    }
  } catch (e) {
    console.error("[AI Session] 加载会话消息失败:", sessionId, e);
  }
  return false;
}

const PERSISTED_STATE_DEPENDENCY_KEYS = [
  "tabs",
  "activeTabId",
  "connectionTags",
  "sidebarRootOrder",
  "externalSQLDirectories",
  "recentConnectionTargets",
  "recentSQLFiles",
  "theme",
  "themePreference",
  "brandIconId",
  "languagePreference",
  "appearance",
  "uiScale",
  "fontSize",
  "startupFullscreen",
  "autoCheckForUpdates",
  "autoCheckForUpdatesIntervalMinutes",
  "aiChatOpenMode",
  "aiChatDetachedBoundsMemory",
  "globalProxy",
  "sqlFormatOptions",
  "queryOptions",
  "dataEditTransactionOptions",
  "sqlEditorTransactionOptions",
  "shortcutOptions",
  "sqlLogs",
  "tableExportHistories",
  "sqlSnippets",
  "tableAccessCount",
  "tableSortPreference",
  "tableColumnOrders",
  "enableColumnOrderMemory",
  "tablePinnedLeftColumns",
  "tableHiddenColumns",
  "enableHiddenColumnMemory",
  "pinnedSidebarTables",
  "windowBounds",
  "windowState",
  "sidebarWidth",
  "connections",
] as const satisfies readonly (keyof AppState)[];

type PersistedStateProjectionSource = Pick<
  AppState,
  (typeof PERSISTED_STATE_DEPENDENCY_KEYS)[number]
>;

const buildPersistedStateProjection = (
  state: PersistedStateProjectionSource,
): AppState => {
  const tabs = sanitizeQueryTabs(state.tabs);
  const partialState: Partial<AppState> = {
    tabs,
    activeTabId: sanitizeActiveTabId(state.activeTabId, tabs),
    connectionTags: state.connectionTags,
    sidebarRootOrder: state.sidebarRootOrder,
    externalSQLDirectories: state.externalSQLDirectories,
    recentConnectionTargets: sanitizeRecentConnectionTargets(
      state.recentConnectionTargets,
    ),
    recentSQLFiles: sanitizeRecentSQLFiles(state.recentSQLFiles),
    theme: state.theme,
    themePreference: state.themePreference,
    brandIconId: sanitizeBrandIconIdLocal(state.brandIconId),
    languagePreference: state.languagePreference,
    appearance: state.appearance,
    uiScale: state.uiScale,
    fontSize: state.fontSize,
    startupFullscreen: state.startupFullscreen,
    autoCheckForUpdates: state.autoCheckForUpdates,
    autoCheckForUpdatesIntervalMinutes:
      state.autoCheckForUpdatesIntervalMinutes,
    aiChatOpenMode: sanitizeAIChatOpenMode(state.aiChatOpenMode),
    aiChatDetachedBoundsMemory: sanitizeAIChatDetachedBoundsMemory(
      state.aiChatDetachedBoundsMemory,
    ),
    globalProxy:
      toTrimmedString(state.globalProxy.password) !== ""
        ? { ...state.globalProxy }
        : toPersistedGlobalProxy(state.globalProxy),
    sqlFormatOptions: state.sqlFormatOptions,
    queryOptions: state.queryOptions,
    dataEditTransactionOptions: state.dataEditTransactionOptions,
    sqlEditorTransactionOptions: state.sqlEditorTransactionOptions,
    shortcutOptions: resolveShortcutOptionsForPersistence(state.shortcutOptions),
    sqlLogs: sanitizePersistedSqlLogs(state.sqlLogs),
    tableExportHistories: sanitizeTableExportHistories(
      state.tableExportHistories,
    ),
    sqlSnippets: state.sqlSnippets,
    tableAccessCount: sanitizeTableAccessCount(state.tableAccessCount),
    tableSortPreference: state.tableSortPreference,
    tableColumnOrders: state.tableColumnOrders,
    enableColumnOrderMemory: state.enableColumnOrderMemory,
    tablePinnedLeftColumns: state.tablePinnedLeftColumns,
    tableHiddenColumns: state.tableHiddenColumns,
    enableHiddenColumnMemory: state.enableHiddenColumnMemory,
    pinnedSidebarTables: state.pinnedSidebarTables,
    windowBounds: state.windowBounds,
    windowState: state.windowState,
    sidebarWidth: state.sidebarWidth,
  };

  if (hasLegacyConnectionSecrets(state.connections)) {
    partialState.connections = state.connections;
  }

  // AI 会话数据已迁移到后端文件持久化（~/.gonavi/sessions/），不再写入 localStorage
  return partialState as AppState;
};

const createMemoizedPersistedStateProjection = () => {
  let previousDependencies: unknown[] | null = null;
  let previousProjection: AppState | null = null;

  return (state: AppState): AppState => {
    if (previousDependencies && previousProjection) {
      let unchanged = true;
      for (
        let index = 0;
        index < PERSISTED_STATE_DEPENDENCY_KEYS.length;
        index += 1
      ) {
        const key = PERSISTED_STATE_DEPENDENCY_KEYS[index];
        if (!Object.is(previousDependencies[index], state[key])) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) {
        return previousProjection;
      }
    }

    previousDependencies = PERSISTED_STATE_DEPENDENCY_KEYS.map(
      (key) => state[key],
    );
    previousProjection = buildPersistedStateProjection(state);
    return previousProjection;
  };
};

const partializePersistedState = createMemoizedPersistedStateProjection();

const appPersistStorage = createDebouncedPersistStorage<AppState>(
  () => localStorage,
  {
    debounceMs: PERSIST_WRITE_DEBOUNCE_MS,
    enabled: !isFrontendTestRuntime(),
  },
);

export const flushAppStatePersistence = async (): Promise<void> => {
  const flush = (appPersistStorage as { flush?: () => Promise<void> } | undefined)?.flush;
  if (typeof flush === "function") {
    await flush();
  }
};

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      connections: [],
      connectionTags: [],
      sidebarRootOrder: [],
      tabs: [],
      detachedWorkbenchWindows: [],
      detachedQueryResultWindows: [],
      detachedAIChatWindow: null,
      aiChatDetachedBoundsMemory: null,
      activeTabId: null,
      activeContext: null,
      savedQueries: [],
      savedQueryGroups: [],
      externalSQLDirectories: [],
      recentConnectionTargets: [],
      recentSQLFiles: [],
      theme: "light",
      themePreference: "light",
      brandIconId: "02",
      languagePreference: DEFAULT_LANGUAGE_PREFERENCE,
      appearance: { ...DEFAULT_APPEARANCE },
      uiScale: DEFAULT_UI_SCALE,
      fontSize: DEFAULT_FONT_SIZE,
      startupFullscreen: DEFAULT_STARTUP_FULLSCREEN,
      autoCheckForUpdates: DEFAULT_AUTO_CHECK_FOR_UPDATES,
      autoCheckForUpdatesIntervalMinutes:
        DEFAULT_AUTO_CHECK_FOR_UPDATES_INTERVAL_MINUTES,
      globalProxy: { ...DEFAULT_GLOBAL_PROXY },
      sqlFormatOptions: { keywordCase: "upper" },
      queryOptions: {
        maxRows: 5000,
        wordWrap: false,
        showColumnComment: true,
        showSidebarTableComment: false,
        sidebarTableMetadataFields: ["rows"],
        sidebarTableMetadataFieldOrder: [...DEFAULT_SIDEBAR_TABLE_METADATA_FIELDS],
        showColumnType: true,
        showQueryResultsPanel: false,
        queryEditorEditorHeightRatio: DEFAULT_QUERY_EDITOR_EDITOR_HEIGHT_RATIO,
      },
      dataEditTransactionOptions: {
        commitMode: "manual",
        autoCommitDelayMs: 5000,
      },
      sqlEditorTransactionOptions: {
        commitMode: "manual",
        autoCommitDelayMs: 0,
      },
      sqlEditorPendingTransactions: {},
      shortcutOptions: cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS),
      sqlSnippets: DEFAULT_SQL_SNIPPETS,
      sqlLogs: [],
      tableExportHistories: {},
      tableAccessCount: {},
      tableSortPreference: {},
      tableColumnOrders: {},
      enableColumnOrderMemory: true,
      tablePinnedLeftColumns: {},
      tableHiddenColumns: {},
      enableHiddenColumnMemory: true,
      pinnedSidebarTables: [],
      windowBounds: null,
      windowState: "normal" as const,
      sidebarWidth: 330,

      // AI 运行状态
      aiPanelVisible: false,
      aiChatOpenMode: "dock" as AIChatOpenMode,
      aiChatHistory: {},
      aiChatSessions: [],
      aiActiveSessionId: null,
      aiContexts: {},
      jvmDiagnosticDrafts: {},
      jvmDiagnosticOutputs: {},

      addConnection: (conn) =>
        set((state) => {
          const sanitized = sanitizeSavedConnection(
            conn,
            state.connections.length,
          );
          if (!sanitized) {
            return { connections: state.connections };
          }
          return { connections: [...state.connections, sanitized] };
        }),
      updateConnection: (conn) =>
        set((state) => {
          const sanitized = sanitizeSavedConnection(
            conn,
            state.connections.length,
          );
          if (!sanitized) {
            return { connections: state.connections };
          }
          return {
            connections: state.connections.map((c) =>
              c.id === conn.id ? sanitized : c,
            ),
          };
        }),
      removeConnection: (id) =>
        set((state) => {
          const nextConnections = state.connections.filter((c) => c.id !== id);
          const connectionToken = buildSidebarRootConnectionToken(id);
          const nextTags = state.connectionTags.map((tag) => ({
            ...tag,
            connectionIds: tag.connectionIds.filter((cid) => cid !== id),
            childOrder: sanitizeSidebarItemOrder(tag.childOrder).filter(
              (token) => token !== connectionToken,
            ),
          }));
          const normalized = normalizeConnectionTagTreeState(
            nextTags,
            state.sidebarRootOrder.filter(
              (token) => token !== connectionToken,
            ),
            nextConnections,
          );
          return {
            connections: nextConnections,
            connectionTags: normalized.connectionTags,
            recentConnectionTargets: state.recentConnectionTargets.filter(
              (target) => target.connectionId !== id,
            ),
            recentSQLFiles: state.recentSQLFiles.filter(
              (file) => file.connectionId !== id,
            ),
            tableAccessCount: removeConnectionTableAccessCounts(
              state.tableAccessCount,
              id,
              nextConnections.map((connection) => connection.id),
            ),
            sidebarRootOrder: normalized.sidebarRootOrder,
          };
        }),
      replaceConnections: (connections) =>
        set((state) => {
          const nextConnections = sanitizeConnections(connections);
          const normalized = normalizeConnectionTagTreeState(
            state.connectionTags,
            state.sidebarRootOrder,
            nextConnections,
          );
          return {
            connections: nextConnections,
            connectionTags: normalized.connectionTags,
            sidebarRootOrder: normalized.sidebarRootOrder,
            shortcutOptions:
              readPersistedShortcutOptions() ?? state.shortcutOptions,
          };
        }),

      addConnectionTag: (tag) =>
        set((state) => {
          const normalized = normalizeConnectionTagTreeState(
            state.connectionTags,
            state.sidebarRootOrder,
            state.connections,
          );
          const tagId = toTrimmedString(tag.id);
          if (
            !tagId ||
            normalized.connectionTags.some((candidate) => candidate.id === tagId)
          ) {
            return normalized;
          }

          const directConnectionIds = sanitizeStringArray(tag.connectionIds, 256);
          const directConnectionTokens = new Set(
            directConnectionIds.map(buildSidebarRootConnectionToken),
          );
          const nextTags = normalizeConnectionTagTree([
            ...normalized.connectionTags.map((candidate) => ({
              ...candidate,
              connectionIds: candidate.connectionIds.filter(
                (connectionId) => !directConnectionIds.includes(connectionId),
              ),
              childOrder: sanitizeSidebarItemOrder(candidate.childOrder).filter(
                (token) => !directConnectionTokens.has(token),
              ),
            })),
            {
              id: tagId,
              name:
                toTrimmedString(
                  tag.name,
                  indexedStoreFallback(
                    "store.fallback.connection_tag_name",
                    normalized.connectionTags.length,
                  ),
                ) ||
                indexedStoreFallback(
                  "store.fallback.connection_tag_name",
                  normalized.connectionTags.length,
                ),
              environmentType: normalizeConnectionEnvironmentType(
                tag.environmentType,
              ),
              parentTagId: toTrimmedString(tag.parentTagId) || undefined,
              connectionIds: directConnectionIds,
              childOrder: sanitizeSidebarItemOrder(tag.childOrder),
            },
          ]);
          const addedTag = nextTags.find((candidate) => candidate.id === tagId);
          const nextRootOrder = addedTag?.parentTagId
            ? normalized.sidebarRootOrder
            : insertSidebarRootTokenBeforeUngrouped(
                resolveSidebarRootOrderTokens(
                  normalized.sidebarRootOrder,
                  nextTags,
                  state.connections,
                ).filter(
                  (token) => token !== buildSidebarRootTagToken(tagId),
                ),
                buildSidebarRootTagToken(tagId),
              );
          return normalizeConnectionTagTreeState(
            nextTags,
            nextRootOrder,
            state.connections,
          );
        }),
      updateConnectionTag: (tag) =>
        set((state) => {
          const normalized = normalizeConnectionTagTreeState(
            state.connectionTags,
            state.sidebarRootOrder,
            state.connections,
          );
          const existing = normalized.connectionTags.find(
            (candidate) => candidate.id === tag.id,
          );
          if (!existing) return normalized;

          const requestedConnectionIds = sanitizeStringArray(
            tag.connectionIds,
            256,
          );
          const requestedConnectionTokens = new Set(
            requestedConnectionIds.map(buildSidebarRootConnectionToken),
          );
          const hasRequestedParent = Object.prototype.hasOwnProperty.call(
            tag,
            "parentTagId",
          );
          const requestedParentTagId = hasRequestedParent
            ? toTrimmedString(tag.parentTagId) || undefined
            : existing.parentTagId;
          const hasRequestedChildOrder = Object.prototype.hasOwnProperty.call(
            tag,
            "childOrder",
          );
          let nextTags: ConnectionTag[] = normalized.connectionTags.map((candidate) => {
            if (candidate.id === tag.id) {
              return {
                ...candidate,
                name: toTrimmedString(tag.name, candidate.name) || candidate.name,
                environmentType: normalizeConnectionEnvironmentType(
                  tag.environmentType ?? candidate.environmentType,
                ),
                connectionIds: requestedConnectionIds,
                childOrder: hasRequestedChildOrder
                  ? sanitizeSidebarItemOrder(tag.childOrder)
                  : candidate.childOrder,
              };
            }
            return {
              ...candidate,
              connectionIds: candidate.connectionIds.filter(
                (connectionId) => !requestedConnectionIds.includes(connectionId),
              ),
              childOrder: sanitizeSidebarItemOrder(candidate.childOrder).filter(
                (token) => !requestedConnectionTokens.has(token),
              ),
            };
          });
          nextTags = normalizeConnectionTagTree(nextTags);

          if (requestedParentTagId !== existing.parentTagId) {
            const moved = moveConnectionTagInTree(
              nextTags,
              normalized.sidebarRootOrder,
              state.connections,
              tag.id,
              requestedParentTagId ?? null,
            );
            if (moved) return moved;
          }
          return normalizeConnectionTagTreeState(
            nextTags,
            normalized.sidebarRootOrder,
            state.connections,
          );
        }),
      removeConnectionTag: (id) =>
        set((state) => {
          const normalized = normalizeConnectionTagTreeState(
            state.connectionTags,
            state.sidebarRootOrder,
            state.connections,
          );
          const removedTag = normalized.connectionTags.find(
            (tag) => tag.id === id,
          );
          if (!removedTag) return normalized;

          const removedToken = buildSidebarRootTagToken(id);
          const promotedOrder = resolveConnectionTagChildOrder(
            id,
            normalized.connectionTags,
          );
          const parentTagId = removedTag.parentTagId;
          let nextTags: ConnectionTag[] = normalized.connectionTags
            .filter((tag) => tag.id !== id)
            .map((tag) => {
              const isDirectChild = tag.parentTagId === id;
              const isParent = parentTagId && tag.id === parentTagId;
              return {
                ...tag,
                parentTagId: isDirectChild ? parentTagId : tag.parentTagId,
                connectionIds: isParent
                  ? [...tag.connectionIds, ...removedTag.connectionIds]
                  : tag.connectionIds,
              };
            });
          let nextRootOrder = normalized.sidebarRootOrder;

          if (parentTagId) {
            const parentOrder = resolveConnectionTagChildOrder(
              parentTagId,
              normalized.connectionTags,
            );
            nextTags = setConnectionTagChildOrder(
              nextTags,
              parentTagId,
              replaceSidebarItemToken(
                parentOrder,
                removedToken,
                promotedOrder,
              ),
            );
          } else {
            nextRootOrder = replaceSidebarItemToken(
              normalized.sidebarRootOrder,
              removedToken,
              promotedOrder,
            );
          }

          return normalizeConnectionTagTreeState(
            nextTags,
            nextRootOrder,
            state.connections,
          );
        }),
      moveConnectionToTag: (
        connectionId,
        targetTagId,
        targetToken,
        insertBefore = false,
      ) =>
        set((state) => {
          const moved = moveConnectionInTree(
            state.connectionTags,
            state.sidebarRootOrder,
            state.connections,
            connectionId,
            targetTagId,
            targetToken,
            insertBefore,
          );
          return moved || {
            connectionTags: state.connectionTags,
            sidebarRootOrder: state.sidebarRootOrder,
          };
        }),
      moveConnectionTag: (
        tagId,
        targetParentTagId,
        targetToken,
        insertBefore = false,
      ) =>
        set((state) => {
          const moved = moveConnectionTagInTree(
            state.connectionTags,
            state.sidebarRootOrder,
            state.connections,
            tagId,
            targetParentTagId,
            targetToken,
            insertBefore,
          );
          return moved || {
            connectionTags: state.connectionTags,
            sidebarRootOrder: state.sidebarRootOrder,
          };
        }),
      reorderConnections: (
        connectionId,
        targetConnectionId,
        targetTagId,
        insertBefore = false,
      ) =>
        set((state) => {
          if (
            !connectionId ||
            !targetConnectionId ||
            connectionId === targetConnectionId ||
            !state.connections.some(
              (connection) => connection.id === targetConnectionId,
            )
          ) {
            return {
              connections: state.connections,
              connectionTags: state.connectionTags,
            };
          }
          const moved = moveConnectionInTree(
            state.connectionTags,
            state.sidebarRootOrder,
            state.connections,
            connectionId,
            targetTagId,
            buildSidebarRootConnectionToken(targetConnectionId),
            insertBefore,
          );
          if (!moved) {
            return {
              connections: state.connections,
              connectionTags: state.connectionTags,
              sidebarRootOrder: state.sidebarRootOrder,
            };
          }
          const nextConnections = targetTagId
            ? state.connections
            : orderUngroupedConnectionsBySidebarRootOrder(
                state.connections,
                moved.connectionTags,
                moved.sidebarRootOrder,
              );
          return {
            connections: nextConnections,
            connectionTags: moved.connectionTags,
            sidebarRootOrder: resolveSidebarRootOrderTokens(
              moved.sidebarRootOrder,
              moved.connectionTags,
              nextConnections,
            ),
          };
        }),
      reorderTags: (tagIds) =>
        set((state) => {
          const normalized = normalizeConnectionTagTreeState(
            state.connectionTags,
            state.sidebarRootOrder,
            state.connections,
          );
          const rootTagIds = new Set(
            normalized.connectionTags
              .filter((tag) => !tag.parentTagId)
              .map((tag) => tag.id),
          );
          const requestedTagTokens = Array.from(
            new Set(
              tagIds
                .filter((id) => rootTagIds.has(id))
                .map(buildSidebarRootTagToken),
            ),
          );
          const orderedRootOrder = [
            ...requestedTagTokens,
            ...normalized.sidebarRootOrder.filter(
              (token) =>
                isSidebarRootTagToken(token) &&
                !requestedTagTokens.includes(token),
            ),
            ...normalized.sidebarRootOrder.filter(
              (token) => !isSidebarRootTagToken(token),
            ),
          ];
          return normalizeConnectionTagTreeState(
            normalized.connectionTags,
            orderedRootOrder,
            state.connections,
          );
        }),
      reorderSidebarRoot: (sourceToken, targetToken, insertBefore) =>
        set((state) => {
          const normalized = normalizeConnectionTagTreeState(
            state.connectionTags,
            state.sidebarRootOrder,
            state.connections,
          );
          const nextRootOrder = moveSidebarRootToken(
            normalized.sidebarRootOrder,
            sourceToken,
            targetToken,
            insertBefore,
          );
          return normalizeConnectionTagTreeState(
            normalized.connectionTags,
            nextRootOrder,
            state.connections,
          );
        }),

      addTab: (tab) =>
        set((state) => {
          const incomingTab =
            tab.type === "query" && tab.resultPanelVisible === undefined
              ? {
                  ...tab,
                  resultPanelVisible: state.queryOptions.showQueryResultsPanel,
                }
              : tab;
          const recentWorkbenchEntries = resolveRecentWorkbenchEntries(
            state,
            incomingTab,
          );
          const index = state.tabs.findIndex((t) => t.id === incomingTab.id);
          if (index !== -1) {
            // Update existing tab with new data (e.g. switch initialTab)
            const newTabs = [...state.tabs];
            newTabs[index] = { ...newTabs[index], ...incomingTab };
            return {
              tabs: newTabs,
              ...recentWorkbenchEntries,
              activeTabId: incomingTab.id,
              activeContext: resolveActiveContextForTabId(
                newTabs,
                incomingTab.id,
                state.activeContext,
              ),
            };
          }
          // 语义去重：对表相关标签页按 connectionId+dbName+tableName 匹配已有 Tab
          if (
            (
              incomingTab.type === "table" ||
              incomingTab.type === "design" ||
              incomingTab.type === "table-export"
            ) &&
            incomingTab.tableName &&
            incomingTab.connectionId &&
            incomingTab.dbName
          ) {
            const semanticIndex = state.tabs.findIndex(
              (t) =>
                t.type === incomingTab.type &&
                t.connectionId === incomingTab.connectionId &&
                t.dbName === incomingTab.dbName &&
                t.tableName === incomingTab.tableName,
            );
            if (semanticIndex !== -1) {
              const existingTab = state.tabs[semanticIndex];
              const newTabs = [...state.tabs];
              newTabs[semanticIndex] = {
                ...existingTab,
                ...incomingTab,
                id: existingTab.id,
              };
              return {
                tabs: newTabs,
                ...recentWorkbenchEntries,
                activeTabId: existingTab.id,
                activeContext: resolveActiveContextForTabId(
                  newTabs,
                  existingTab.id,
                  state.activeContext,
                ),
              };
            }
          }
          // 语义去重：对 query 类型按 savedQueryId 匹配已有 Tab（避免保存后重复打开）
          if (incomingTab.type === "query" && incomingTab.savedQueryId) {
            const savedQueryIndex = state.tabs.findIndex(
              (t) =>
                t.type === "query" &&
                (t.savedQueryId === incomingTab.savedQueryId ||
                  t.id === incomingTab.savedQueryId),
            );
            if (savedQueryIndex !== -1) {
              const existingTab = state.tabs[savedQueryIndex];
              const newTabs = [...state.tabs];
              newTabs[savedQueryIndex] = {
                ...existingTab,
                ...incomingTab,
                id: existingTab.id,
              };
              return {
                tabs: newTabs,
                ...recentWorkbenchEntries,
                activeTabId: existingTab.id,
                activeContext: resolveActiveContextForTabId(
                  newTabs,
                  existingTab.id,
                  state.activeContext,
                ),
              };
            }
          }
          const nextTabs = [...state.tabs, incomingTab];
          return {
            tabs: nextTabs,
            ...recentWorkbenchEntries,
            activeTabId: incomingTab.id,
            activeContext: resolveActiveContextForTabId(
              nextTabs,
              incomingTab.id,
              state.activeContext,
            ),
          };
        }),

      updateQueryTabDraft: (id, draft) =>
        set((state) => {
          const tabId = toTrimmedString(id);
          if (!tabId) return state;

          let changed = false;
          let contextChangedTab: TabData | null = null;
          const nextTabs = state.tabs.map((tab) => {
            if (tab.id !== tabId || tab.type !== "query") return tab;
            const nextTab: TabData = { ...tab };
            let connectionContextChanged = false;

            if (draft.query !== undefined) {
              const nextQuery = typeof draft.query === "string" ? draft.query.slice(0, MAX_PERSISTED_QUERY_LENGTH) : "";
              if (nextTab.query !== nextQuery) {
                nextTab.query = nextQuery;
                changed = true;
              }
            }
            if (draft.connectionId !== undefined) {
              const nextConnectionId = toTrimmedString(draft.connectionId);
              if (nextTab.connectionId !== nextConnectionId) {
                nextTab.connectionId = nextConnectionId;
                changed = true;
                connectionContextChanged = true;
              }
            }
            if (draft.dbName !== undefined) {
              const nextDbName = toTrimmedString(draft.dbName);
              if ((nextTab.dbName || "") !== nextDbName) {
                nextTab.dbName = nextDbName;
                changed = true;
                connectionContextChanged = true;
              }
            }
            if (draft.title !== undefined) {
              const nextTitle = toTrimmedString(draft.title, nextTab.title) || nextTab.title;
              if (nextTab.title !== nextTitle) {
                nextTab.title = nextTitle;
                changed = true;
              }
            }
            if (draft.resultPanelVisible !== undefined) {
              const nextResultPanelVisible = draft.resultPanelVisible === true;
              if (nextTab.resultPanelVisible !== nextResultPanelVisible) {
                nextTab.resultPanelVisible = nextResultPanelVisible;
                changed = true;
              }
            }
            if (Object.prototype.hasOwnProperty.call(draft, "formatRestoreSnapshot")) {
              const rawSnapshot = draft.formatRestoreSnapshot;
              const nextSnapshot =
                rawSnapshot && typeof rawSnapshot.query === "string"
                  ? {
                      query: rawSnapshot.query.slice(0, MAX_PERSISTED_QUERY_LENGTH),
                      createdAt: Number.isFinite(Number(rawSnapshot.createdAt))
                        ? Number(rawSnapshot.createdAt)
                        : Date.now(),
                    }
                  : undefined;
              const currentSnapshot = nextTab.formatRestoreSnapshot;
              if (
                currentSnapshot?.query !== nextSnapshot?.query ||
                currentSnapshot?.createdAt !== nextSnapshot?.createdAt
              ) {
                if (nextSnapshot?.query) {
                  nextTab.formatRestoreSnapshot = nextSnapshot;
                } else {
                  delete nextTab.formatRestoreSnapshot;
                }
                changed = true;
              }
            }

            if (connectionContextChanged) {
              contextChangedTab = nextTab;
            }
            return nextTab;
          });

          if (!changed) return state;
          return {
            tabs: nextTabs,
            ...(contextChangedTab
              ? resolveRecentWorkbenchEntries(state, contextChangedTab)
              : {}),
          };
        }),

      closeTab: (id) =>
        set((state) => {
          const closedTab = state.tabs.find((t) => t.id === id);
          if (isRunningDataImportTab(closedTab)) {
            return state;
          }
          if (closedTab?.type === "query") {
            clearQueryTabDraft(closedTab.id);
            clearQueryEditorResultSession(id);
          }
          const newTabs = state.tabs.filter((t) => t.id !== id);
          let newActiveId = state.activeTabId;
          if (state.activeTabId === id) {
            // Prefer next docked tab when closing the active one
            const dockedCandidates = newTabs.filter(
              (tab) =>
                !state.detachedWorkbenchWindows.some(
                  (windowState) => windowState.tabId === tab.id,
                ),
            );
            newActiveId =
              resolveCloseTabActiveTabId(closedTab, dockedCandidates) ||
              resolveCloseTabActiveTabId(closedTab, newTabs);
          }
          return {
            tabs: newTabs,
            activeTabId: newActiveId,
            activeContext: resolveActiveContextForTabId(
              newTabs,
              newActiveId,
              state.activeContext,
            ),
            detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
              (windowState) => windowState.tabId !== id,
            ),
            detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
              (windowState) => windowState.sourceQueryTabId !== id,
            ),
          };
        }),

      closeOtherTabs: (id) =>
        set((state) => {
          const keep = state.tabs.find((t) => t.id === id);
          if (!keep) return state;
          state.tabs
            .filter((tab) => tab.id !== id && tab.type === "query")
            .forEach((tab) => {
              clearQueryTabDraft(tab.id);
              clearQueryEditorResultSession(tab.id);
            });
          const newTabs = state.tabs.filter(
            (tab) => tab.id === id || isRunningDataImportTab(tab),
          );
          const keptIds = new Set(newTabs.map((tab) => tab.id));
          return {
            tabs: newTabs,
            activeTabId: id,
            activeContext: resolveActiveContextFromTab(keep),
            detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
              (windowState) => keptIds.has(windowState.tabId),
            ),
            detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
              (windowState) => keptIds.has(windowState.sourceQueryTabId),
            ),
          };
        }),

      closeTabsToLeft: (id) =>
        set((state) => {
          const index = state.tabs.findIndex((t) => t.id === id);
          if (index === -1) return state;
          state.tabs
            .slice(0, index)
            .filter((tab) => tab.type === "query")
            .forEach((tab) => {
              clearQueryTabDraft(tab.id);
              clearQueryEditorResultSession(tab.id);
            });
          const newTabs = state.tabs.filter(
            (tab, tabIndex) => tabIndex >= index || isRunningDataImportTab(tab),
          );
          const keptIds = new Set(newTabs.map((tab) => tab.id));
          const activeStillExists = state.activeTabId
            ? newTabs.some((t) => t.id === state.activeTabId)
            : false;
          return {
            tabs: newTabs,
            activeTabId: activeStillExists ? state.activeTabId : id,
            activeContext: resolveActiveContextForTabId(
              newTabs,
              activeStillExists ? state.activeTabId : id,
              state.activeContext,
            ),
            detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
              (windowState) => keptIds.has(windowState.tabId),
            ),
            detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
              (windowState) => keptIds.has(windowState.sourceQueryTabId),
            ),
          };
        }),

      closeTabsToRight: (id) =>
        set((state) => {
          const index = state.tabs.findIndex((t) => t.id === id);
          if (index === -1) return state;
          state.tabs
            .slice(index + 1)
            .filter((tab) => tab.type === "query")
            .forEach((tab) => {
              clearQueryTabDraft(tab.id);
              clearQueryEditorResultSession(tab.id);
            });
          const newTabs = state.tabs.filter(
            (tab, tabIndex) => tabIndex <= index || isRunningDataImportTab(tab),
          );
          const keptIds = new Set(newTabs.map((tab) => tab.id));
          const activeStillExists = state.activeTabId
            ? newTabs.some((t) => t.id === state.activeTabId)
            : false;
          return {
            tabs: newTabs,
            activeTabId: activeStillExists ? state.activeTabId : id,
            activeContext: resolveActiveContextForTabId(
              newTabs,
              activeStillExists ? state.activeTabId : id,
              state.activeContext,
            ),
            detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
              (windowState) => keptIds.has(windowState.tabId),
            ),
            detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
              (windowState) => keptIds.has(windowState.sourceQueryTabId),
            ),
          };
        }),

      closeTabsByConnection: (connectionId) =>
        set((state) => {
          const targetConnectionId = String(connectionId || "").trim();
          if (!targetConnectionId) return state;
          state.tabs
            .filter(
              (tab) =>
                tab.type === "query" &&
                String(tab.connectionId || "").trim() === targetConnectionId,
            )
            .forEach((tab) => {
              clearQueryTabDraft(tab.id);
              clearQueryEditorResultSession(tab.id);
            });
          const newTabs = state.tabs.filter(
            (tab) => (
              isRunningDataImportTab(tab)
              || String(tab.connectionId || "").trim() !== targetConnectionId
            ),
          );
          const activeStillExists = state.activeTabId
            ? newTabs.some((t) => t.id === state.activeTabId)
            : false;
          const nextActiveTabId = activeStillExists
            ? state.activeTabId
            : newTabs.length > 0
              ? newTabs[newTabs.length - 1].id
              : null;
          const nextFallbackContext =
            state.activeContext?.connectionId === targetConnectionId
              ? null
              : state.activeContext;
          const keptIds = new Set(newTabs.map((tab) => tab.id));
          return {
            tabs: newTabs,
            activeTabId: nextActiveTabId,
            activeContext: resolveActiveContextForTabId(
              newTabs,
              nextActiveTabId,
              nextFallbackContext,
            ),
            detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
              (windowState) => keptIds.has(windowState.tabId),
            ),
            detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
              (windowState) => keptIds.has(windowState.sourceQueryTabId),
            ),
          };
        }),

      closeTabsByDatabase: (connectionId, dbName) =>
        set((state) => {
          const targetConnectionId = String(connectionId || "").trim();
          const targetDbName = String(dbName || "").trim();
          if (!targetConnectionId || !targetDbName) return state;
          state.tabs
            .filter((tab) => {
              if (tab.type !== "query") return false;
              const sameConnection =
                String(tab.connectionId || "").trim() === targetConnectionId;
              const sameDb = String(tab.dbName || "").trim() === targetDbName;
              return sameConnection && sameDb;
            })
            .forEach((tab) => {
              clearQueryTabDraft(tab.id);
              clearQueryEditorResultSession(tab.id);
            });
          const newTabs = state.tabs.filter((tab) => {
            if (isRunningDataImportTab(tab)) return true;
            const sameConnection =
              String(tab.connectionId || "").trim() === targetConnectionId;
            const sameDb = String(tab.dbName || "").trim() === targetDbName;
            return !(sameConnection && sameDb);
          });
          const activeStillExists = state.activeTabId
            ? newTabs.some((t) => t.id === state.activeTabId)
            : false;
          const nextActiveTabId = activeStillExists
            ? state.activeTabId
            : newTabs.length > 0
              ? newTabs[newTabs.length - 1].id
              : null;
          const sameActiveContext =
            state.activeContext &&
            state.activeContext.connectionId === targetConnectionId &&
            state.activeContext.dbName === targetDbName;
          const nextFallbackContext = sameActiveContext
            ? null
            : state.activeContext;
          const keptIds = new Set(newTabs.map((tab) => tab.id));
          return {
            tabs: newTabs,
            activeTabId: nextActiveTabId,
            activeContext: resolveActiveContextForTabId(
              newTabs,
              nextActiveTabId,
              nextFallbackContext,
            ),
            detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
              (windowState) => keptIds.has(windowState.tabId),
            ),
            detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
              (windowState) => keptIds.has(windowState.sourceQueryTabId),
            ),
          };
        }),

      moveTab: (sourceId, targetId) =>
        set((state) => {
          const fromId = String(sourceId || "").trim();
          const toId = String(targetId || "").trim();
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

      closeAllTabs: () =>
        set((state) => {
          state.tabs
            .filter((tab) => tab.type === "query")
            .forEach((tab) => {
              clearQueryTabDraft(tab.id);
              clearQueryEditorResultSession(tab.id);
            });
          const newTabs = state.tabs.filter(isRunningDataImportTab);
          const keptIds = new Set(newTabs.map((tab) => tab.id));
          const activeStillExists = state.activeTabId
            ? keptIds.has(state.activeTabId)
            : false;
          const nextActiveTabId = activeStillExists
            ? state.activeTabId
            : (newTabs[0]?.id || null);
          return {
            tabs: newTabs,
            activeTabId: nextActiveTabId,
            activeContext: resolveActiveContextForTabId(
              newTabs,
              nextActiveTabId,
              null,
            ),
            detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
              (windowState) => keptIds.has(windowState.tabId),
            ),
            detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
              (windowState) => keptIds.has(windowState.sourceQueryTabId),
            ),
          };
        }),

      setActiveTab: (id) =>
        set((state) => {
          const tabId = String(id || "").trim();
          const isDetached = state.detachedWorkbenchWindows.some(
            (windowState) => windowState.tabId === tabId,
          );
          if (!isDetached) {
            return {
              activeTabId: tabId,
              activeContext: resolveActiveContextForTabId(
                state.tabs,
                tabId,
                state.activeContext,
              ),
            };
          }
          // Detached tab: keep active context, raise floating window
          const zIndex = nextDetachedZIndex(state.detachedWorkbenchWindows);
          return {
            activeTabId: tabId,
            activeContext: resolveActiveContextForTabId(
              state.tabs,
              tabId,
              state.activeContext,
            ),
            detachedWorkbenchWindows: state.detachedWorkbenchWindows.map(
              (windowState) =>
                windowState.tabId === tabId
                  ? { ...windowState, zIndex }
                  : windowState,
            ),
          };
        }),
      setActiveContext: (context) => set({ activeContext: context }),

      detachWorkbenchTab: (tabId, preferred) =>
        set((state) => {
          const id = String(tabId || "").trim();
          if (!id || !state.tabs.some((tab) => tab.id === id)) {
            return state;
          }
          const existing = state.detachedWorkbenchWindows.find(
            (windowState) => windowState.tabId === id,
          );
          if (existing) {
            const zIndex = nextDetachedZIndex(state.detachedWorkbenchWindows);
            return {
              activeTabId: id,
              activeContext: resolveActiveContextForTabId(
                state.tabs,
                id,
                state.activeContext,
              ),
              detachedWorkbenchWindows: state.detachedWorkbenchWindows.map(
                (windowState) =>
                  windowState.tabId === id
                    ? { ...windowState, zIndex }
                    : windowState,
              ),
            };
          }
          const bounds = createDefaultDetachedBounds(
            state.detachedWorkbenchWindows,
            preferred,
          );
          const detachedTab = state.tabs.find((tab) => tab.id === id);
          return {
            detachedWorkbenchWindows: [
              ...state.detachedWorkbenchWindows,
              { tabId: id, ...bounds },
            ],
            // Keep detached tab active so connection context and focus stay correct;
            // TabManager only renders docked tabs and falls back visually.
            activeTabId: id,
            activeContext: resolveActiveContextFromTab(detachedTab) ||
              resolveActiveContextForTabId(
                state.tabs,
                id,
                state.activeContext,
              ),
          };
        }),

      attachWorkbenchTab: (tabId) =>
        set((state) => {
          const id = String(tabId || "").trim();
          if (!id) return state;
          if (
            !state.detachedWorkbenchWindows.some(
              (windowState) => windowState.tabId === id,
            )
          ) {
            return {
              activeTabId: id,
              activeContext: resolveActiveContextForTabId(
                state.tabs,
                id,
                state.activeContext,
              ),
            };
          }
          return {
            detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
              (windowState) => windowState.tabId !== id,
            ),
            activeTabId: id,
            activeContext: resolveActiveContextForTabId(
              state.tabs,
              id,
              state.activeContext,
            ),
          };
        }),

      updateDetachedWorkbenchBounds: (tabId, bounds) =>
        set((state) => {
          const id = String(tabId || "").trim();
          if (!id) return state;
          return {
            detachedWorkbenchWindows: state.detachedWorkbenchWindows.map(
              (windowState) =>
                windowState.tabId === id
                  ? {
                      ...windowState,
                      ...(bounds.x !== undefined ? { x: bounds.x } : {}),
                      ...(bounds.y !== undefined ? { y: bounds.y } : {}),
                      ...(bounds.width !== undefined
                        ? { width: bounds.width }
                        : {}),
                      ...(bounds.height !== undefined
                        ? { height: bounds.height }
                        : {}),
                    }
                  : windowState,
            ),
          };
        }),

      focusDetachedWorkbenchTab: (tabId) =>
        set((state) => {
          const id = String(tabId || "").trim();
          if (
            !id ||
            !state.detachedWorkbenchWindows.some(
              (windowState) => windowState.tabId === id,
            )
          ) {
            return state;
          }
          const zIndex = nextDetachedZIndex(state.detachedWorkbenchWindows);
          return {
            activeTabId: id,
            activeContext: resolveActiveContextForTabId(
              state.tabs,
              id,
              state.activeContext,
            ),
            detachedWorkbenchWindows: state.detachedWorkbenchWindows.map(
              (windowState) =>
                windowState.tabId === id
                  ? { ...windowState, zIndex }
                  : windowState,
            ),
          };
        }),

      isWorkbenchTabDetached: (tabId): boolean => {
        const id = String(tabId || "").trim();
        return get().detachedWorkbenchWindows.some(
          (windowState) => windowState.tabId === id,
        );
      },

      detachQueryResultWindow: (windowState) =>
        set((state) => {
          const id = String(windowState.id || "").trim();
          if (!id) return state;
          const existingIndex = state.detachedQueryResultWindows.findIndex(
            (item) => item.id === id,
          );
          if (existingIndex >= 0) {
            const zIndex = nextDetachedZIndex(state.detachedQueryResultWindows);
            const next = [...state.detachedQueryResultWindows];
            next[existingIndex] = {
              ...next[existingIndex],
              ...windowState,
              zIndex,
            };
            return { detachedQueryResultWindows: next };
          }
          const bounds = createDefaultDetachedBounds(
            state.detachedQueryResultWindows,
            windowState,
          );
          return {
            detachedQueryResultWindows: [
              ...state.detachedQueryResultWindows,
              {
                id,
                sourceQueryTabId: String(windowState.sourceQueryTabId || ""),
                connectionId: String(windowState.connectionId || ""),
                dbName: windowState.dbName,
                title: String(windowState.title || id),
                result: windowState.result,
                ...bounds,
              },
            ],
          };
        }),

      attachQueryResultWindow: (id) => {
        const windowId = String(id || "").trim();
        if (!windowId) return null;
        const current = get().detachedQueryResultWindows;
        const found =
          current.find((windowState) => windowState.id === windowId) || null;
        if (!found) return null;
        set({
          detachedQueryResultWindows: current.filter(
            (windowState) => windowState.id !== windowId,
          ),
        });
        return found;
      },

      closeDetachedQueryResultWindow: (id) =>
        set((state) => ({
          detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
            (windowState) => windowState.id !== String(id || "").trim(),
          ),
        })),

      updateDetachedQueryResultBounds: (id, bounds) =>
        set((state) => {
          const windowId = String(id || "").trim();
          if (!windowId) return state;
          return {
            detachedQueryResultWindows: state.detachedQueryResultWindows.map(
              (windowState) =>
                windowState.id === windowId
                  ? {
                      ...windowState,
                      ...(bounds.x !== undefined ? { x: bounds.x } : {}),
                      ...(bounds.y !== undefined ? { y: bounds.y } : {}),
                      ...(bounds.width !== undefined
                        ? { width: bounds.width }
                        : {}),
                      ...(bounds.height !== undefined
                        ? { height: bounds.height }
                        : {}),
                    }
                  : windowState,
            ),
          };
        }),

      focusDetachedQueryResultWindow: (id) =>
        set((state) => {
          const windowId = String(id || "").trim();
          if (
            !windowId ||
            !state.detachedQueryResultWindows.some(
              (windowState) => windowState.id === windowId,
            )
          ) {
            return state;
          }
          const zIndex = nextDetachedZIndex(state.detachedQueryResultWindows);
          return {
            detachedQueryResultWindows: state.detachedQueryResultWindows.map(
              (windowState) =>
                windowState.id === windowId
                  ? { ...windowState, zIndex }
                  : windowState,
            ),
          };
        }),

      closeDetachedQueryResultWindowsBySourceTab: (sourceQueryTabId) =>
        set((state) => {
          const sourceId = String(sourceQueryTabId || "").trim();
          if (!sourceId) return state;
          return {
            detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
              (windowState) => windowState.sourceQueryTabId !== sourceId,
            ),
          };
        }),

      replaceSavedQueries: (queries) =>
        set({ savedQueries: sanitizeSavedQueries(queries) }),

      replaceSavedQueryGroups: (groups) =>
        set((state) => ({
          savedQueryGroups: normalizeSavedQueryGroups(
            groups,
            state.savedQueries.map((query) => query.id),
          ),
        })),

      reloadSavedQueryGroups: async () => {
        const groups = await getSavedQueryGroupsFromBackend(
          resolveSavedQueryBackend(),
        );
        const normalized = normalizeSavedQueryGroups(
          groups,
          get().savedQueries.map((query) => query.id),
        );
        set({ savedQueryGroups: normalized });
        return normalized;
      },

      saveSavedQueryGroup: async (group) => {
        const saved = await saveSavedQueryGroupToBackend(
          resolveSavedQueryBackend(),
          group,
        );
        // The backend normalizes ownership and mixed child order. Reload after
        // every write rather than applying an optimistic local patch.
        await get().reloadSavedQueryGroups();
        return saved;
      },

      deleteSavedQueryGroup: async (id) => {
        await deleteSavedQueryGroupFromBackend(resolveSavedQueryBackend(), id);
        await get().reloadSavedQueryGroups();
      },

      moveSavedQueryToGroup: async (queryId, groupId) => {
        await moveSavedQueryToGroupInBackend(
          resolveSavedQueryBackend(),
          queryId,
          groupId,
        );
        await get().reloadSavedQueryGroups();
      },

      moveSavedQueryGroup: async (groupId, parentGroupId) => {
        await moveSavedQueryGroupInBackend(
          resolveSavedQueryBackend(),
          groupId,
          parentGroupId,
        );
        await get().reloadSavedQueryGroups();
      },

      saveQuery: async (query) => {
        const saved = await saveSavedQueryToBackend(
          resolveSavedQueryBackend(),
          query,
        );
        set((state) => {
          const existing = state.savedQueries.find((q) => q.id === saved.id);
          if (existing) {
            return {
              savedQueries: state.savedQueries.map((q) =>
                q.id === saved.id ? saved : q,
              ),
            };
          }
          return { savedQueries: [...state.savedQueries, saved] };
        });
        return saved;
      },

      deleteQuery: async (id) => {
        await deleteSavedQueryFromBackend(resolveSavedQueryBackend(), id);
        const groups = await getSavedQueryGroupsFromBackend(
          resolveSavedQueryBackend(),
        );
        set((state) => ({
          savedQueries: state.savedQueries.filter((q) => q.id !== id),
          savedQueryGroups: normalizeSavedQueryGroups(
            groups,
            state.savedQueries
              .filter((query) => query.id !== id)
              .map((query) => query.id),
          ),
        }));
      },

      saveExternalSQLDirectory: (directory) =>
        set((state) => {
          const path = toTrimmedString(directory.path);
          if (!path) {
            return state;
          }
          const connectionId = toTrimmedString(directory.connectionId);
          const dbName = toTrimmedString(directory.dbName);
          const nextDirectory: ExternalSQLDirectory = {
            id:
              toTrimmedString(
                directory.id,
                buildExternalSQLDirectoryId(connectionId, dbName, path),
              ) || buildExternalSQLDirectoryId(connectionId, dbName, path),
            name: resolveExternalSQLDirectoryName(directory.name, path),
            path,
            ...(connectionId ? { connectionId } : {}),
            ...(dbName ? { dbName } : {}),
            createdAt: Number.isFinite(Number(directory.createdAt))
              ? Number(directory.createdAt)
              : Date.now(),
          };
          const existingIndex = state.externalSQLDirectories.findIndex(
            (item) => item.id === nextDirectory.id,
          );
          if (existingIndex === -1) {
            return {
              externalSQLDirectories: [
                ...state.externalSQLDirectories,
                nextDirectory,
              ],
            };
          }
          return {
            externalSQLDirectories: state.externalSQLDirectories.map(
              (item, index) => (index === existingIndex ? nextDirectory : item),
            ),
          };
        }),

      deleteExternalSQLDirectory: (id) =>
        set((state) => ({
          externalSQLDirectories: state.externalSQLDirectories.filter(
            (item) => item.id !== id,
          ),
        })),

      updateRecentSQLFilePath: (previousPath, nextPath) =>
        set((state) => {
          const previousKey = normalizeRecentSQLPath(previousPath);
          const normalizedNextPath = toTrimmedString(nextPath);
          if (!previousKey || !normalizedNextPath) return state;
          return {
            recentSQLFiles: sanitizeRecentSQLFiles(state.recentSQLFiles.map((file) => (
              normalizeRecentSQLPath(file.filePath) === previousKey
                ? {
                    ...file,
                    filePath: normalizedNextPath,
                    fileName: resolveRecentSQLFileName(normalizedNextPath, undefined),
                  }
                : file
            ))),
          };
        }),

      removeRecentSQLFilesByPath: (filePath) =>
        set((state) => {
          const pathKey = normalizeRecentSQLPath(filePath);
          if (!pathKey) return state;
          return {
            recentSQLFiles: state.recentSQLFiles.filter(
              (file) => normalizeRecentSQLPath(file.filePath) !== pathKey,
            ),
          };
        }),

      moveRecentSQLFilesByDirectory: (previousDirectoryPath, nextDirectoryPath) =>
        set((state) => {
          const previousPath = normalizeRecentSQLPath(previousDirectoryPath);
          const nextPath = normalizeRecentSQLPath(nextDirectoryPath);
          if (!previousPath || !nextPath) return state;
          return {
            recentSQLFiles: sanitizeRecentSQLFiles(state.recentSQLFiles.map((file) => {
              if (!isRecentSQLPathInDirectory(file.filePath, previousPath)) return file;
              const filePath = relocateRecentSQLFilePath(
                file.filePath,
                previousDirectoryPath,
                nextDirectoryPath,
              );
              return {
                ...file,
                filePath,
                fileName: resolveRecentSQLFileName(filePath, undefined),
              };
            })),
          };
        }),

      removeRecentSQLFilesByDirectory: (directoryPath) =>
        set((state) => ({
          recentSQLFiles: state.recentSQLFiles.filter(
            (file) => !isRecentSQLPathInDirectory(file.filePath, directoryPath),
          ),
        })),

      setTheme: (theme) => set({ theme }),
      setThemePreference: (themePreference) =>
        set({
          themePreference: sanitizeThemePreference(themePreference),
        }),
      setBrandIconId: (brandIconId) =>
        set({
          brandIconId: sanitizeBrandIconIdLocal(brandIconId),
        }),
      setLanguagePreference: (languagePreference) =>
        set({
          languagePreference: sanitizeLanguagePreference(languagePreference),
        }),
      setAppearance: (appearance) =>
        set((state) => ({
          appearance: sanitizeAppearance(
            { ...state.appearance, ...appearance },
            PERSIST_VERSION,
          ),
        })),
      setRedisDbAlias: (connectionId, dbIndex, alias) =>
        set((state) => ({
          appearance: sanitizeAppearance(
            {
              ...state.appearance,
              redisDbAliases: applyRedisDbAlias(
                state.appearance.redisDbAliases,
                connectionId,
                dbIndex,
                alias,
              ),
            },
            PERSIST_VERSION,
          ),
        })),
      setUiScale: (scale) => set({ uiScale: sanitizeUiScale(scale) }),
      setFontSize: (size) => set({ fontSize: sanitizeFontSize(size) }),
      setStartupFullscreen: (enabled) => {
        const nextValue = !!enabled;
        set({ startupFullscreen: nextValue });
        writePersistedStatePatch({ startupFullscreen: nextValue });
      },
      setAutoCheckForUpdates: (enabled) => {
        set({ autoCheckForUpdates: sanitizeAutoCheckForUpdates(enabled) });
      },
      setAutoCheckForUpdatesIntervalMinutes: (minutes) => {
        set({
          autoCheckForUpdatesIntervalMinutes:
            sanitizeAutoCheckForUpdatesIntervalMinutes(minutes),
        });
      },
      setGlobalProxy: (proxy) =>
        set((state) => ({
          globalProxy: sanitizeGlobalProxy({ ...state.globalProxy, ...proxy }),
        })),
      replaceGlobalProxy: (proxy) =>
        set((state) => ({
          globalProxy: sanitizeGlobalProxy({
            ...DEFAULT_GLOBAL_PROXY,
            ...proxy,
          }),
          shortcutOptions: readPersistedShortcutOptions() ?? state.shortcutOptions,
        })),
      setSqlFormatOptions: (options) => set({ sqlFormatOptions: options }),
      setQueryOptions: (options) =>
        set((state) => ({
          queryOptions: sanitizeQueryOptions({
            ...state.queryOptions,
            ...options,
          }),
        })),
      setDataEditTransactionOptions: (options) =>
        set((state) => ({
          dataEditTransactionOptions: sanitizeDataEditTransactionOptions({
            ...state.dataEditTransactionOptions,
            ...options,
          }),
        })),
      setSqlEditorTransactionOptions: (options) =>
        set((state) => ({
          sqlEditorTransactionOptions: sanitizeSqlEditorTransactionOptions({
            ...state.sqlEditorTransactionOptions,
            ...options,
          }),
        })),
      setSqlEditorPendingTransaction: (tabId, transaction) =>
        set((state) => {
          const safeTabId = String(tabId || "").trim();
          if (!safeTabId) {
            return {};
          }
          const next = { ...state.sqlEditorPendingTransactions };
          if (!transaction) {
            delete next[safeTabId];
            return { sqlEditorPendingTransactions: next };
          }
          next[safeTabId] = {
            ...transaction,
            tabId: safeTabId,
          };
          return { sqlEditorPendingTransactions: next };
        }),
      updateShortcut: (action, binding, platform) => {
        runWithExplicitShortcutPersistence(() => {
          const targetPlatform = platform ?? getShortcutPlatform();
          set((state) => ({
            shortcutOptions: {
              ...state.shortcutOptions,
              [action]: {
                ...state.shortcutOptions[action],
                [targetPlatform]: {
                  ...state.shortcutOptions[action][targetPlatform],
                  ...binding,
                },
              },
            },
          }));
        });
      },
      resetShortcutOptions: () => {
        runWithExplicitShortcutPersistence(() => {
          set({
            shortcutOptions: cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS),
          });
        });
      },

      saveSqlSnippet: (snippet) =>
        set((state) => {
          const existing = state.sqlSnippets.findIndex((s) => s.id === snippet.id);
          if (existing >= 0) {
            const updated = [...state.sqlSnippets];
            updated[existing] = snippet;
            return { sqlSnippets: updated };
          }
          return { sqlSnippets: [...state.sqlSnippets, snippet] };
        }),
      deleteSqlSnippet: (id) =>
        set((state) => ({
          sqlSnippets: state.sqlSnippets.filter(
            (s) => s.id !== id || s.isBuiltin,
          ),
        })),
      resetBuiltinSqlSnippet: (id) =>
        set((state) => {
          const original = BUILTIN_SNIPPET_MAP[id];
          if (!original) return state;
          return {
            sqlSnippets: state.sqlSnippets.map((s) =>
              s.id === id ? { ...original } : s,
            ),
          };
        }),

      addSqlLog: (log) =>
        set((state) => ({ sqlLogs: appendRuntimeSqlLog(state.sqlLogs, log) })),
      hideSqlLogFromRecent: (id) =>
        set((state) => ({
          sqlLogs: state.sqlLogs.map((log) => (
            log.id === id ? { ...log, hiddenFromRecent: true } : log
          )),
        })),
      clearRecentSqlLogs: () =>
        set((state) => ({
          sqlLogs: state.sqlLogs.map((log) => (
            log.hiddenFromRecent ? log : { ...log, hiddenFromRecent: true }
          )),
        })),
      clearSqlLogs: () => set({ sqlLogs: [] }),
      upsertTableExportHistory: (historyKey, entry) =>
        set((state) => {
          const safeHistoryKey = toTrimmedString(historyKey);
          const safeEntry = sanitizeTableExportHistoryEntry(entry);
          if (
            !safeHistoryKey
            || !safeEntry
            || (safeEntry.status !== "done" && safeEntry.status !== "error")
          ) {
            return state;
          }
          const existingEntries = state.tableExportHistories[safeHistoryKey] || [];
          const existingIndex = existingEntries.findIndex(
            (item) => item.jobId === safeEntry.jobId,
          );
          const nextEntries =
            existingIndex >= 0
              ? existingEntries.map((item, index) =>
                  index === existingIndex ? { ...item, ...safeEntry } : item,
                )
              : [safeEntry, ...existingEntries];
          const trimmedEntries = nextEntries.slice(0, MAX_TABLE_EXPORT_HISTORY_PER_TARGET);
          const unchanged =
            existingEntries.length === trimmedEntries.length &&
            existingEntries.every((item, index) =>
              JSON.stringify(item) === JSON.stringify(trimmedEntries[index]),
            );
          if (unchanged) {
            return state;
          }
          return {
            tableExportHistories: {
              ...state.tableExportHistories,
              [safeHistoryKey]: trimmedEntries,
            },
          };
        }),

      recordTableAccess: (connectionId, dbName, tableName) =>
        set((state) => {
          return {
            tableAccessCount: incrementTableAccessCount(
              state.tableAccessCount,
              connectionId,
              dbName,
              tableName,
            ),
          };
        }),

      setTableSortPreference: (connectionId, dbName, sortBy) =>
        set((state) => {
          const key = `${connectionId}-${dbName}`;
          return {
            tableSortPreference: {
              ...state.tableSortPreference,
              [key]: sortBy,
            },
          };
        }),

      setSidebarTablePinned: (connectionId, dbName, tableName, schemaName, pinned) =>
        set((state) => {
          const key = buildSidebarTablePinKey(connectionId, dbName, tableName, schemaName);
          if (!key) return state;
          const current = new Set(state.pinnedSidebarTables);
          if (pinned) {
            current.add(key);
          } else {
            current.delete(key);
          }
          return { pinnedSidebarTables: Array.from(current) };
        }),

      setTableColumnOrder: (connectionId, dbName, tableName, order) =>
        set((state) => {
          const key = `${connectionId}-${dbName}-${tableName}`;
          return {
            tableColumnOrders: {
              ...state.tableColumnOrders,
              [key]: order,
            },
          };
        }),

      clearTableColumnOrder: (connectionId, dbName, tableName) =>
        set((state) => {
          const key = `${connectionId}-${dbName}-${tableName}`;
          const newOrders = { ...state.tableColumnOrders };
          delete newOrders[key];
          return { tableColumnOrders: newOrders };
        }),

      setEnableColumnOrderMemory: (enabled) =>
        set({ enableColumnOrderMemory: !!enabled }),

      setTablePinnedLeftColumns: (connectionId, dbName, tableName, columns) =>
        set((state) => {
          const key = `${connectionId}-${dbName}-${tableName}`;
          const normalized = Array.isArray(columns)
            ? Array.from(new Set(columns.map((col) => String(col || "").trim()).filter(Boolean)))
            : [];
          if (normalized.length === 0) {
            const next = { ...state.tablePinnedLeftColumns };
            delete next[key];
            return { tablePinnedLeftColumns: next };
          }
          return {
            tablePinnedLeftColumns: {
              ...state.tablePinnedLeftColumns,
              [key]: normalized,
            },
          };
        }),

      clearTablePinnedLeftColumns: (connectionId, dbName, tableName) =>
        set((state) => {
          const key = `${connectionId}-${dbName}-${tableName}`;
          const next = { ...state.tablePinnedLeftColumns };
          delete next[key];
          return { tablePinnedLeftColumns: next };
        }),

      setTableHiddenColumns: (connectionId, dbName, tableName, hiddenColumns) =>
        set((state) => {
          const key = `${connectionId}-${dbName}-${tableName}`;
          return {
            tableHiddenColumns: {
              ...state.tableHiddenColumns,
              [key]: hiddenColumns,
            },
          };
        }),

      clearTableHiddenColumns: (connectionId, dbName, tableName) =>
        set((state) => {
          const key = `${connectionId}-${dbName}-${tableName}`;
          const newHidden = { ...state.tableHiddenColumns };
          delete newHidden[key];
          return { tableHiddenColumns: newHidden };
        }),

      setEnableHiddenColumnMemory: (enabled) =>
        set({ enableHiddenColumnMemory: !!enabled }),

      setWindowBounds: (bounds) => {
        const nextBounds = {
          width: Math.max(400, Math.trunc(bounds.width)),
          height: Math.max(300, Math.trunc(bounds.height)),
          x: Math.trunc(bounds.x),
          y: Math.trunc(bounds.y),
        };
        set({ windowBounds: nextBounds });
        // 与 startupFullscreen 一致：立即落盘，避免 Windows 退出时异步 persist 丢尺寸记忆
        writePersistedStatePatch({ windowBounds: nextBounds });
      },

      setWindowState: (state) => {
        const nextState = sanitizeWindowState(state);
        set({ windowState: nextState });
        // 与窗口尺寸一致即时落盘，避免退出阶段丢失最后一次观测状态。
        writePersistedStatePatch({ windowState: nextState });
      },

      setSidebarWidth: (width) =>
        set({ sidebarWidth: sanitizeSidebarWidth(width) }),

      // AI actions
      toggleAIPanel: () =>
        set((state) => {
          const nextVisible = !state.aiPanelVisible;
          // 关闭独立 AI 面板时保留窗口意图和尺寸。桌面端会把原生子窗
          // 隐藏保活，下一次打开可直接聚焦；浏览器浮窗也会被
          // aiPanelVisible 门禁隐藏，不会继续占用界面。
          if (!nextVisible) {
            const memory = state.detachedAIChatWindow
              ? toAIChatDetachedBoundsMemory(state.detachedAIChatWindow)
              : state.aiChatDetachedBoundsMemory;
            return {
              aiPanelVisible: false,
              detachedAIChatWindow: state.detachedAIChatWindow,
              aiChatDetachedBoundsMemory: memory,
            };
          }
          // 按默认打开形态展开
          if (state.aiChatOpenMode === "detached") {
            const peers = [
              ...state.detachedWorkbenchWindows,
              ...state.detachedQueryResultWindows,
              ...(state.detachedAIChatWindow ? [state.detachedAIChatWindow] : []),
            ];
            if (state.detachedAIChatWindow) {
              return {
                aiPanelVisible: true,
                detachedAIChatWindow: {
                  ...state.detachedAIChatWindow,
                  zIndex: nextDetachedZIndex(peers),
                },
              };
            }
            const nextBounds = createDefaultDetachedBounds(
              peers,
              resolveAIChatDetachPreferred(state.aiChatDetachedBoundsMemory),
              "ai-chat",
            );
            return {
              aiPanelVisible: true,
              detachedAIChatWindow: nextBounds,
              aiChatDetachedBoundsMemory: state.aiChatDetachedBoundsMemory?.coordinateSpace === "screen"
                ? state.aiChatDetachedBoundsMemory
                : toAIChatDetachedBoundsMemory(nextBounds),
            };
          }
          // 侧栏打开：若仍挂着独立窗则先记下尺寸再收拢
          if (state.detachedAIChatWindow) {
            return {
              aiPanelVisible: true,
              detachedAIChatWindow: null,
              aiChatDetachedBoundsMemory: toAIChatDetachedBoundsMemory(
                state.detachedAIChatWindow,
              ),
            };
          }
          return { aiPanelVisible: true, detachedAIChatWindow: null };
        }),
      setAIPanelVisible: (visible) =>
        set((state) => {
          if (!visible) {
            const memory = state.detachedAIChatWindow
              ? toAIChatDetachedBoundsMemory(state.detachedAIChatWindow)
              : state.aiChatDetachedBoundsMemory;
            return {
              aiPanelVisible: false,
              detachedAIChatWindow: state.detachedAIChatWindow,
              aiChatDetachedBoundsMemory: memory,
            };
          }
          if (state.aiChatOpenMode === "detached") {
            const peers = [
              ...state.detachedWorkbenchWindows,
              ...state.detachedQueryResultWindows,
              ...(state.detachedAIChatWindow ? [state.detachedAIChatWindow] : []),
            ];
            if (state.detachedAIChatWindow) {
              return {
                aiPanelVisible: true,
                detachedAIChatWindow: {
                  ...state.detachedAIChatWindow,
                  zIndex: nextDetachedZIndex(peers),
                },
              };
            }
            const nextBounds = createDefaultDetachedBounds(
              peers,
              resolveAIChatDetachPreferred(state.aiChatDetachedBoundsMemory),
              "ai-chat",
            );
            return {
              aiPanelVisible: true,
              detachedAIChatWindow: nextBounds,
              aiChatDetachedBoundsMemory: state.aiChatDetachedBoundsMemory?.coordinateSpace === "screen"
                ? state.aiChatDetachedBoundsMemory
                : toAIChatDetachedBoundsMemory(nextBounds),
            };
          }
          // 默认侧栏：打开时若之前是独立窗则收拢回侧栏，并记下尺寸
          if (state.detachedAIChatWindow) {
            return {
              aiPanelVisible: true,
              detachedAIChatWindow: null,
              aiChatDetachedBoundsMemory: toAIChatDetachedBoundsMemory(
                state.detachedAIChatWindow,
              ),
            };
          }
          return { aiPanelVisible: true, detachedAIChatWindow: null };
        }),
      setAIChatOpenMode: (mode) =>
        set({ aiChatOpenMode: sanitizeAIChatOpenMode(mode) }),
      detachAIChatPanel: (preferred) =>
        set((state) => {
          const peers = [
            ...state.detachedWorkbenchWindows,
            ...state.detachedQueryResultWindows,
            ...(state.detachedAIChatWindow ? [state.detachedAIChatWindow] : []),
          ];
          if (state.detachedAIChatWindow) {
            return {
              aiPanelVisible: true,
              detachedAIChatWindow: {
                ...state.detachedAIChatWindow,
                zIndex: nextDetachedZIndex(peers),
              },
            };
          }
          const nextBounds = createDefaultDetachedBounds(
            peers,
            resolveAIChatDetachPreferred(state.aiChatDetachedBoundsMemory, preferred),
            "ai-chat",
          );
          return {
            aiPanelVisible: true,
            detachedAIChatWindow: nextBounds,
            aiChatDetachedBoundsMemory: state.aiChatDetachedBoundsMemory?.coordinateSpace === "screen"
              ? state.aiChatDetachedBoundsMemory
              : toAIChatDetachedBoundsMemory(nextBounds),
          };
        }),
      attachAIChatPanel: () =>
        set((state) => {
          if (!state.detachedAIChatWindow) {
            return state;
          }
          return {
            aiPanelVisible: true,
            detachedAIChatWindow: null,
            aiChatDetachedBoundsMemory: toAIChatDetachedBoundsMemory(
              state.detachedAIChatWindow,
            ),
          };
        }),
      updateDetachedAIChatBounds: (bounds) =>
        set((state) => {
          if (!state.detachedAIChatWindow) {
            return state;
          }
          const nextWindow = {
            ...state.detachedAIChatWindow,
            ...bounds,
          };
          return {
            detachedAIChatWindow: nextWindow,
            aiChatDetachedBoundsMemory: toAIChatDetachedBoundsMemory(nextWindow),
          };
        }),
      focusDetachedAIChatPanel: () =>
        set((state) => {
          if (!state.detachedAIChatWindow) {
            return state;
          }
          const peers = [
            ...state.detachedWorkbenchWindows,
            ...state.detachedQueryResultWindows,
            state.detachedAIChatWindow,
          ];
          return {
            detachedAIChatWindow: {
              ...state.detachedAIChatWindow,
              zIndex: nextDetachedZIndex(peers),
            },
          };
        }),
      isAIChatDetached: () => Boolean(get().detachedAIChatWindow),
      addAIChatMessage: (sessionId, message) => {
        set((state) => {
          const history = { ...state.aiChatHistory };
          const messages = history[sessionId] || [];
          history[sessionId] = [...messages, message];

          let newSessions = [...state.aiChatSessions];
          const existingSession = newSessions.find((s) => s.id === sessionId);

          if (!existingSession) {
            let title =
              message.role === "user"
                ? message.content
                : translate("ai_chat.panel.session.default_title");
            if (title.length > 20) {
              title = title.substring(0, 20) + "...";
            }
            newSessions.unshift({
              id: sessionId,
              title,
              updatedAt: Date.now(),
            });
          } else {
            newSessions = newSessions.filter((s) => s.id !== sessionId);
            newSessions.unshift({ ...existingSession, updatedAt: Date.now() });
          }

          return { aiChatHistory: history, aiChatSessions: newSessions };
        });
        // 异步持久化到文件（fire-and-forget，防抖由外层控制）
        _debouncedPersistSession(sessionId);
      },
      updateAIChatMessage: (sessionId, messageId, updates) => {
        set((state) => {
          const messages = state.aiChatHistory[sessionId];
          if (!messages) return state;
          // Message IDs are unique within a session and are also used as React keys.
          // Streaming updates target the newest assistant message, so keep that hot path O(1).
          const lastIndex = messages.length - 1;
          const idx = lastIndex >= 0 && messages[lastIndex].id === messageId
            ? lastIndex
            : messages.findIndex((m) => m.id === messageId);
          if (idx < 0) return state;
          const newMessages = [...messages];
          newMessages[idx] = { ...newMessages[idx], ...updates };
          const history = { ...state.aiChatHistory, [sessionId]: newMessages };
          if (!isAIStreamingOnlyMessageUpdate(updates)) {
            let newSessions = [...state.aiChatSessions];
            const existingSession = newSessions.find((s) => s.id === sessionId);
            if (existingSession) {
              newSessions = newSessions.filter((s) => s.id !== sessionId);
              newSessions.unshift({
                ...existingSession,
                updatedAt: Date.now(),
              });
            }
            return { aiChatHistory: history, aiChatSessions: newSessions };
          }
          return { aiChatHistory: history };
        });
        // 流式打字高频调用，防抖 2 秒后才写磁盘
        _debouncedPersistSession(sessionId);
      },
      deleteAIChatMessage: (sessionId, messageId) => {
        set((state) => {
          const history = { ...state.aiChatHistory };
          if (history[sessionId]) {
            history[sessionId] = history[sessionId].filter(
              (m) => m.id !== messageId,
            );
          }
          return { aiChatHistory: history };
        });
        _debouncedPersistSession(sessionId);
      },
      truncateAIChatMessages: (sessionId, upToMessageId) => {
        set((state) => {
          const history = { ...state.aiChatHistory };
          const messages = history[sessionId];
          if (messages) {
            const idx = messages.findIndex((m) => m.id === upToMessageId);
            if (idx >= 0) {
              history[sessionId] = messages.slice(0, idx + 1);
            }
          }
          return { aiChatHistory: history };
        });
        _debouncedPersistSession(sessionId);
      },
      clearAIChatHistory: (sessionId) => {
        set((state) => {
          const history = { ...state.aiChatHistory };
          delete history[sessionId];
          return { aiChatHistory: history };
        });
        _debouncedPersistSession(sessionId);
      },
      replaceAIChatHistory: (sessionId, messages) => {
        set((state) => {
          const history = { ...state.aiChatHistory };
          history[sessionId] = messages;
          return { aiChatHistory: history };
        });
        _debouncedPersistSession(sessionId);
      },
      deleteAISession: (sessionId) => {
        set((state) => {
          const history = { ...state.aiChatHistory };
          delete history[sessionId];
          const newSessions = state.aiChatSessions.filter(
            (s) => s.id !== sessionId,
          );
          const newActive =
            state.aiActiveSessionId === sessionId
              ? null
              : state.aiActiveSessionId;
          return {
            aiChatHistory: history,
            aiChatSessions: newSessions,
            aiActiveSessionId: newActive,
          };
        });
        // 删除文件
        const Service = (window as any).go?.aiservice?.Service;
        Service?.AIDeleteSession?.(sessionId).catch(() => {});
      },
      createNewAISession: () =>
        set(() => {
          const newId = `session-${Date.now()}`;
          return { aiActiveSessionId: newId };
        }),
      setAIActiveSessionId: (sessionId) =>
        set({ aiActiveSessionId: sessionId }),
      updateAISessionTitle: (sessionId, title) => {
        set((state) => {
          const newSessions = [...state.aiChatSessions];
          const session = newSessions.find((s) => s.id === sessionId);
          if (session) {
            session.title = title;
          }
          return { aiChatSessions: newSessions };
        });
        _debouncedPersistSession(sessionId);
      },
      addAIContext: (connectionKey, context) =>
        set((state) => {
          const contexts = state.aiContexts[connectionKey] || [];
          if (
            contexts.find(
              (c) =>
                c.dbName === context.dbName &&
                c.tableName === context.tableName,
            )
          ) {
            return state;
          }
          return {
            aiContexts: {
              ...state.aiContexts,
              [connectionKey]: [...contexts, context],
            },
          };
        }),
      removeAIContext: (connectionKey, dbName, tableName) =>
        set((state) => {
          const contexts = state.aiContexts[connectionKey] || [];
          return {
            aiContexts: {
              ...state.aiContexts,
              [connectionKey]: contexts.filter(
                (c) => !(c.dbName === dbName && c.tableName === tableName),
              ),
            },
          };
        }),
      clearAIContexts: (connectionKey) =>
        set((state) => {
          const { [connectionKey]: _, ...rest } = state.aiContexts;
          return { aiContexts: rest };
        }),
      setJVMDiagnosticDraft: (tabId, draft) =>
        set((state) => ({
          jvmDiagnosticDrafts: {
            ...state.jvmDiagnosticDrafts,
            [tabId]: {
              command:
                draft.command ??
                state.jvmDiagnosticDrafts[tabId]?.command ??
                "",
              sessionId:
                draft.sessionId ?? state.jvmDiagnosticDrafts[tabId]?.sessionId,
              source: draft.source ?? state.jvmDiagnosticDrafts[tabId]?.source,
              reason: draft.reason ?? state.jvmDiagnosticDrafts[tabId]?.reason,
            },
          },
        })),
      appendJVMDiagnosticOutput: (tabId, chunks) =>
        set((state) => ({
          jvmDiagnosticOutputs: {
            ...state.jvmDiagnosticOutputs,
            [tabId]: [
              ...(state.jvmDiagnosticOutputs[tabId] || []),
              ...chunks,
            ],
          },
        })),
      clearJVMDiagnosticOutput: (tabId) =>
        set((state) => ({
          jvmDiagnosticOutputs: {
            ...state.jvmDiagnosticOutputs,
            [tabId]: [],
          },
        })),
    }),
    {
      name: PERSIST_STORAGE_KEY, // name of the item in the storage (must be unique)
      storage: appPersistStorage,
      skipHydration: isNativeDetachedWindowRoute(),
      version: PERSIST_VERSION,
      migrate: (persistedState: unknown, version: number) => {
        const state = unwrapPersistedAppState(
          persistedState,
        ) as Partial<AppState>;
        captureLegacySavedQueriesSnapshot(state.savedQueries, state.connections);
        const nextState: Partial<AppState> = { ...state };
        // 缺失连接表示由启动阶段从后端加载，迁移时不能把它写成空数组，
        // 否则会让持久化的侧栏根节点顺序提前丢失。
        nextState.connections =
          state.connections === undefined
            ? undefined
            : sanitizeConnections(state.connections);
        const safeTabs = sanitizeQueryTabs(state.tabs);
        nextState.tabs = safeTabs;
        nextState.activeTabId = sanitizeActiveTabId(state.activeTabId, safeTabs);
        if (version < 5) {
          nextState.connectionTags = sanitizeConnectionTags(
            state.connectionTags,
          );
        } else {
          nextState.connectionTags = sanitizeConnectionTags(
            state.connectionTags,
          );
        }
        nextState.sidebarRootOrder = resolveHydratedSidebarRootOrderTokens(
          state.sidebarRootOrder,
          state.connectionTags === undefined ? undefined : nextState.connectionTags,
          state.connections === undefined ? undefined : nextState.connections,
        );
        delete nextState.savedQueries;
        delete nextState.savedQueryGroups;
        nextState.externalSQLDirectories = sanitizeExternalSQLDirectories(
          state.externalSQLDirectories,
        );
        nextState.recentConnectionTargets = sanitizeRecentConnectionTargets(
          state.recentConnectionTargets,
        );
        nextState.recentSQLFiles = sanitizeRecentSQLFiles(state.recentSQLFiles);
        nextState.theme = sanitizeTheme(state.theme);
        nextState.themePreference = sanitizeThemePreference(
          state.themePreference,
          nextState.theme,
        );
        nextState.brandIconId = sanitizeBrandIconIdLocal(state.brandIconId);
        nextState.languagePreference = sanitizeLanguagePreference(
          state.languagePreference,
        );
        const appearance = sanitizeAppearance(state.appearance, version);
        // 旧版界面在窄布局下可能遮挡 SQL 编辑器。仅在本次版本升级时
        // 将已保存的选择迁移至 V2，之后用户仍可自行切换并保留偏好。
        nextState.appearance =
          version < UI_VERSION_V2_MIGRATION_VERSION
            ? { ...appearance, uiVersion: "v2" }
            : appearance;
        nextState.uiScale = sanitizeUiScale(state.uiScale);
        nextState.fontSize = sanitizeFontSize(state.fontSize);
        nextState.startupFullscreen = sanitizeStartupFullscreen(
          state.startupFullscreen,
        );
        nextState.autoCheckForUpdates = sanitizeAutoCheckForUpdates(
          state.autoCheckForUpdates,
        );
        nextState.autoCheckForUpdatesIntervalMinutes =
          sanitizeAutoCheckForUpdatesIntervalMinutes(
            state.autoCheckForUpdatesIntervalMinutes,
          );
        nextState.globalProxy = sanitizeGlobalProxy(state.globalProxy);
        nextState.sqlFormatOptions = sanitizeSqlFormatOptions(
          state.sqlFormatOptions,
        );
        nextState.queryOptions = sanitizeQueryOptions(state.queryOptions);
        nextState.dataEditTransactionOptions =
          sanitizeDataEditTransactionOptions(state.dataEditTransactionOptions);
        nextState.sqlEditorTransactionOptions =
          sanitizeSqlEditorTransactionOptions(state.sqlEditorTransactionOptions);
        nextState.shortcutOptions = sanitizePersistedShortcutOptions(
          state.shortcutOptions,
          version,
        );
        nextState.sqlLogs = sanitizeRuntimeSqlLogs(state.sqlLogs);
        nextState.tableExportHistories = sanitizeTableExportHistories(
          state.tableExportHistories,
        );
        const existingSnippets = sanitizeSqlSnippets(state.sqlSnippets);
        const existingSnippetIds = new Set(existingSnippets.map((s) => s.id));
        const missingSnippets = DEFAULT_SQL_SNIPPETS.filter(
          (d) => !existingSnippetIds.has(d.id),
        );
        nextState.sqlSnippets =
          missingSnippets.length > 0
            ? [...existingSnippets, ...missingSnippets]
            : existingSnippets;
        nextState.tableAccessCount = sanitizeTableAccessCount(
          state.tableAccessCount,
        );
        nextState.tableSortPreference = sanitizeTableSortPreference(
          state.tableSortPreference,
        );
        // 新增的列排序记忆状态不需要做版本特殊兼容，直接做基本的类型保护
        const safeOrders = sanitizeTableColumnOrders(state.tableColumnOrders);
        nextState.tableColumnOrders = safeOrders;
        nextState.enableColumnOrderMemory =
          state.enableColumnOrderMemory !== false;
        nextState.tablePinnedLeftColumns = sanitizeTableColumnOrders(
          state.tablePinnedLeftColumns,
        );
        const safeHidden = sanitizeTableHiddenColumns(state.tableHiddenColumns);
        nextState.tableHiddenColumns = safeHidden;
        nextState.enableHiddenColumnMemory =
          state.enableHiddenColumnMemory !== false;
        nextState.pinnedSidebarTables = sanitizePinnedSidebarTables(
          state.pinnedSidebarTables,
        );
        nextState.windowBounds = sanitizeWindowBounds(state.windowBounds);
        nextState.windowState = sanitizeWindowState(state.windowState);
        nextState.sidebarWidth = sanitizeSidebarWidth(state.sidebarWidth);
        nextState.aiChatOpenMode = sanitizeAIChatOpenMode(state.aiChatOpenMode);
        nextState.aiChatDetachedBoundsMemory = sanitizeAIChatDetachedBoundsMemory(
          state.aiChatDetachedBoundsMemory,
        );

        // 保留原有的 AI 持久化记录，或者为空（版本兼容）
        nextState.aiChatHistory =
          state.aiChatHistory && typeof state.aiChatHistory === "object"
            ? state.aiChatHistory
            : {};
        nextState.aiChatSessions = Array.isArray(state.aiChatSessions)
          ? state.aiChatSessions
          : [];
        return nextState as AppState;
      },
      merge: (persistedState, currentState) => {
        const state = unwrapPersistedAppState(
          persistedState,
        ) as Partial<AppState>;
        captureLegacySavedQueriesSnapshot(state.savedQueries, state.connections);
        const safeTabs = sanitizeQueryTabs(state.tabs);
        const persistedConnections =
          state.connections === undefined
            ? currentState.connections
            : sanitizeConnections(state.connections);
        const persistedConnectionTags =
          state.connectionTags === undefined
            ? currentState.connectionTags
            : sanitizeConnectionTags(state.connectionTags);
        const persistedSidebarRootOrder =
          state.sidebarRootOrder === undefined
            ? currentState.sidebarRootOrder
            : resolveHydratedSidebarRootOrderTokens(
                state.sidebarRootOrder,
                state.connectionTags === undefined
                  ? undefined
                  : persistedConnectionTags,
                state.connections === undefined ? undefined : persistedConnections,
              );
        return {
          ...currentState,
          ...state,
          connections: persistedConnections,
          connectionTags: persistedConnectionTags,
          sidebarRootOrder: persistedSidebarRootOrder,
          tabs: safeTabs,
          // Floating windows are session-only and must not be restored from disk.
          detachedWorkbenchWindows: [],
          detachedQueryResultWindows: [],
          detachedAIChatWindow: null,
          activeTabId: sanitizeActiveTabId(state.activeTabId, safeTabs),
          savedQueries: currentState.savedQueries,
          savedQueryGroups: currentState.savedQueryGroups,
          externalSQLDirectories: sanitizeExternalSQLDirectories(
            state.externalSQLDirectories,
          ),
          recentConnectionTargets: sanitizeRecentConnectionTargets(
            state.recentConnectionTargets,
          ),
          recentSQLFiles: sanitizeRecentSQLFiles(state.recentSQLFiles),
          theme: sanitizeTheme(state.theme),
          themePreference: sanitizeThemePreference(
            state.themePreference,
            sanitizeTheme(state.theme),
          ),
          brandIconId: sanitizeBrandIconIdLocal(state.brandIconId),
          languagePreference: sanitizeLanguagePreference(
            state.languagePreference,
          ),
          appearance: sanitizeAppearance(state.appearance, PERSIST_VERSION),
          uiScale: sanitizeUiScale(state.uiScale),
          fontSize: sanitizeFontSize(state.fontSize),
          startupFullscreen: sanitizeStartupFullscreen(state.startupFullscreen),
          autoCheckForUpdates: sanitizeAutoCheckForUpdates(
            state.autoCheckForUpdates,
          ),
          autoCheckForUpdatesIntervalMinutes:
            sanitizeAutoCheckForUpdatesIntervalMinutes(
              state.autoCheckForUpdatesIntervalMinutes,
            ),
          globalProxy: sanitizeGlobalProxy(state.globalProxy),
          tableSortPreference: sanitizeTableSortPreference(
            state.tableSortPreference,
          ),
          tableColumnOrders: sanitizeTableColumnOrders(state.tableColumnOrders),
          enableColumnOrderMemory: state.enableColumnOrderMemory !== false,
          tablePinnedLeftColumns: sanitizeTableColumnOrders(
            state.tablePinnedLeftColumns,
          ),
          tableHiddenColumns: sanitizeTableHiddenColumns(
            state.tableHiddenColumns,
          ),
          enableHiddenColumnMemory: state.enableHiddenColumnMemory !== false,
          pinnedSidebarTables: sanitizePinnedSidebarTables(
            state.pinnedSidebarTables,
          ),
          windowBounds: sanitizeWindowBounds(state.windowBounds),
          windowState: sanitizeWindowState(state.windowState),
          sidebarWidth: sanitizeSidebarWidth(state.sidebarWidth),
          aiChatOpenMode: sanitizeAIChatOpenMode(state.aiChatOpenMode),
          aiChatDetachedBoundsMemory: sanitizeAIChatDetachedBoundsMemory(
            state.aiChatDetachedBoundsMemory,
          ),

          sqlFormatOptions: sanitizeSqlFormatOptions(state.sqlFormatOptions),
          queryOptions: sanitizeQueryOptions(state.queryOptions),
          dataEditTransactionOptions: sanitizeDataEditTransactionOptions(
            state.dataEditTransactionOptions,
          ),
          sqlEditorTransactionOptions: sanitizeSqlEditorTransactionOptions(
            state.sqlEditorTransactionOptions,
          ),
          shortcutOptions: sanitizeShortcutOptions(state.shortcutOptions),
          sqlLogs: sanitizeRuntimeSqlLogs(state.sqlLogs),
          sqlSnippets: sanitizeSqlSnippets(state.sqlSnippets),
          tableAccessCount: sanitizeTableAccessCount(state.tableAccessCount),

          // AI 会话数据不再从 localStorage 恢复，改为从后端文件加载
          aiChatHistory: {},
          aiChatSessions: [],
        };
      },
      partialize: partializePersistedState,
    },
  ),
);
