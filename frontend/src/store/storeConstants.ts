import { GlobalProxyConfig } from "../types";
import { DEFAULT_BRAND_ICON_ID, sanitizeBrandIconId } from "../brand/brandIcons";
import { DEFAULT_DATA_GRID_DISPLAY_SETTINGS } from "../utils/dataGridDisplay";
import { DEFAULT_SQL_EDITOR_TYPOGRAPHY_SETTINGS } from "../utils/sqlEditorTypography";
import { DEFAULT_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS } from "../utils/titlebarActionsPlacement";
import type { LanguagePreference } from "../i18n";
import { DEFAULT_TAB_DISPLAY_SETTINGS } from "../utils/tabDisplay";
import { DEFAULT_REDIS_DB_ALIASES } from "../utils/redisDbAlias";
import { DEFAULT_TOOLBAR_BUTTON_COLOR_OVERRIDES } from "../utils/toolbarAppearance";
import type {
  AppearanceSettings,
  TableDoubleClickAction,
  QueryTableCtrlClickAction,
} from "./storeStateTypes";

export const sanitizeBrandIconIdLocal = (value: unknown): string =>
  sanitizeBrandIconId(value) || DEFAULT_BRAND_ICON_ID;

export const DEFAULT_V2_SIDEBAR_RAIL_SCALE = 1.0;
export const MIN_V2_SIDEBAR_RAIL_SCALE = 1.0;
export const MAX_V2_SIDEBAR_RAIL_SCALE = 1.8;
export const DEFAULT_TAB_ENVIRONMENT_ACCENT_THICKNESS = 2;
export const MIN_TAB_ENVIRONMENT_ACCENT_THICKNESS = 1;
export const MAX_TAB_ENVIRONMENT_ACCENT_THICKNESS = 6;

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  enabled: true,
  opacity: 1.0,
  blur: 0,
  tableDoubleClickAction: "open-data",
  queryTableCtrlClickAction: "open-design",
  v2SidebarSearchMode: "command",
  v2SidebarPersistedFilter: "",
  v2SidebarRailScale: DEFAULT_V2_SIDEBAR_RAIL_SCALE,
  tabEnvironmentAccentThickness: DEFAULT_TAB_ENVIRONMENT_ACCENT_THICKNESS,
  toolbarButtonColorOverrides: { ...DEFAULT_TOOLBAR_BUTTON_COLOR_OVERRIDES },
  sidebarSingleDatabaseExpansion: false,
  sidebarHiddenObjectGroups: [],
  customUIFontFamily: null,
  customMonoFontFamily: null,
  newQuerySqlTemplate: null,
  autoAddTableAlias: true,
  customTableAliasPrefixEnabled: false,
  customTableAliasPrefix: '',
  tabDisplay: DEFAULT_TAB_DISPLAY_SETTINGS,
  redisDbAliases: DEFAULT_REDIS_DB_ALIASES,
  ...DEFAULT_DATA_GRID_DISPLAY_SETTINGS,
  ...DEFAULT_SQL_EDITOR_TYPOGRAPHY_SETTINGS,
  ...DEFAULT_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS,
};
export const DEFAULT_UI_SCALE = 1.0;
export const MIN_UI_SCALE = 0.8;
export const MAX_UI_SCALE = 1.25;
export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 20;
export const DEFAULT_STARTUP_FULLSCREEN = false;
export const DEFAULT_AUTO_CHECK_FOR_UPDATES = true;
/** 自动检查更新间隔（分钟）；与关于页 Select 选项保持一致 */
export const AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS = [
  15, 30, 60, 120, 360, 720, 1440,
] as const;
export const DEFAULT_AUTO_CHECK_FOR_UPDATES_INTERVAL_MINUTES = 30;
export const AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS_SET = new Set<number>(
  AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS,
);
export const LEGACY_DEFAULT_OPACITY = 0.95;
export const OPACITY_EPSILON = 1e-6;
const MAX_SIDEBAR_PERSISTED_FILTER_LENGTH = 120;
const MAX_NEW_QUERY_SQL_TEMPLATE_LENGTH = 32 * 1024;

export const sanitizeV2SidebarSearchMode = (
  value: unknown,
): AppearanceSettings["v2SidebarSearchMode"] => {
  return value === "filter" ? "filter" : DEFAULT_APPEARANCE.v2SidebarSearchMode;
};

export const sanitizeTableDoubleClickAction = (
  value: unknown,
): TableDoubleClickAction => {
  return value === "open-design" ? "open-design" : DEFAULT_APPEARANCE.tableDoubleClickAction;
};

export const sanitizeQueryTableCtrlClickAction = (
  value: unknown,
): QueryTableCtrlClickAction => {
  return value === "locate" ? "locate" : DEFAULT_APPEARANCE.queryTableCtrlClickAction;
};

export const sanitizeV2SidebarPersistedFilter = (value: unknown): string => {
  if (typeof value !== "string") {
    return DEFAULT_APPEARANCE.v2SidebarPersistedFilter;
  }
  return value.trim().slice(0, MAX_SIDEBAR_PERSISTED_FILTER_LENGTH);
};

export const sanitizeNewQuerySqlTemplate = (value: unknown): string | null => {
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

export const sanitizeTabEnvironmentAccentThickness = (value: unknown): number => {
  return normalizeIntegerInRange(
    value,
    DEFAULT_TAB_ENVIRONMENT_ACCENT_THICKNESS,
    MIN_TAB_ENVIRONMENT_ACCENT_THICKNESS,
    MAX_TAB_ENVIRONMENT_ACCENT_THICKNESS,
  );
};

export const MAX_URI_LENGTH = 4096;
export const MAX_HOST_ENTRY_LENGTH = 512;
export const MAX_HOST_ENTRIES = 64;
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 3600;
export const DEFAULT_KEEPALIVE_INTERVAL_MINUTES = 240;
export const MIN_KEEPALIVE_INTERVAL_MINUTES = 1;
export const MAX_KEEPALIVE_INTERVAL_MINUTES = 1440;
export const DEFAULT_DIAGNOSTIC_TIMEOUT_SECONDS = 15;
export const MAX_DIAGNOSTIC_TIMEOUT_SECONDS = 300;
export const PERSIST_VERSION = 21;
export const SQL_EDITOR_FONT_SIZE_SPLIT_VERSION = 19;
export const TAB_DISPLAY_DEFAULT_MIGRATION_VERSION = 20;
export const SIDEBAR_SEARCH_SHORTCUT_MIGRATION_VERSION = 18;
export const PERSIST_STORAGE_KEY = "lite-db-storage";
export const PERSIST_WRITE_DEBOUNCE_MS = 160;
export const MAX_PERSISTED_QUERY_TABS = 20;
export const MAX_PERSISTED_QUERY_LENGTH = 1024 * 1024;
export const MAX_RUNTIME_SQL_LOGS = 120;
export const MAX_RUNTIME_SQL_LOG_LENGTH = 12 * 1024;
export const MAX_RUNTIME_SQL_LOG_MESSAGE_LENGTH = 1024;
export const MAX_PERSISTED_SQL_LOGS = 200;
export const MAX_PERSISTED_SQL_LOG_LENGTH = 24 * 1024;
export const MAX_PERSISTED_SQL_LOG_MESSAGE_LENGTH = 2 * 1024;
export const MAX_TABLE_EXPORT_HISTORY_PER_TARGET = 20;
export const MAX_TABLE_EXPORT_HISTORY_TARGETS = 200;
export const MAX_RECENT_WORKBENCH_TARGETS = 8;
export const MAX_RECENT_SQL_FILES = 8;
export const MAX_RECENT_TARGET_DATABASE_LENGTH = 256;
export const MAX_RECENT_SQL_FILE_NAME_LENGTH = 256;
export const DEFAULT_CONNECTION_TYPE = "mysql";
export const DEFAULT_JVM_PORT = 9010;
export const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = "system";
export const MAX_REDIS_DATABASE_INDEX = Number.MAX_SAFE_INTEGER;
export const DEFAULT_GLOBAL_PROXY: GlobalProxyConfig = {
  enabled: false,
  type: "socks5",
  host: "",
  port: 1080,
  user: "",
  password: "",
  hasPassword: false,
};

export const normalizeIntegerInRange = (
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

export const normalizeFloatInRange = (
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
