import { SchemaVisibilityRule } from "../types";
import {
  resolveOceanBaseProtocolFromConfig,
  normalizeOceanBaseProtocol,
  resolveOceanBaseProtocolFromQueryText,
} from "../utils/oceanBaseProtocol";
import { t as translate } from "../i18n";
import type { SavedQueryBackend } from "../utils/savedQueryPersistence";
import { CONNECTION_TYPE_GROUPS } from "../utils/connectionTypeCatalog";
import { normalizeDriverType } from "../utils/connectionDriverType";
import {
  PERSIST_STORAGE_KEY,
  PERSIST_VERSION,
  MAX_HOST_ENTRY_LENGTH,
  MAX_HOST_ENTRIES,
  DEFAULT_CONNECTION_TYPE,
} from "./storeConstants";

export const isFrontendTestRuntime = (): boolean => {
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env || {};
  return env.MODE === "test" || env.VITEST === true || env.VITEST === "true";
};

export const resolveSavedQueryBackend = (): SavedQueryBackend | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (window as unknown as { go?: { app?: { App?: SavedQueryBackend } } }).go?.app?.App;
};

export const writePersistedStatePatch = (
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

export const resolveOceanBaseProtocol = (
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

export const toTrimmedString = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return fallback;
};

export const indexedStoreFallback = (
  key:
    | "store.fallback.connection_name"
    | "store.fallback.connection_tag_name"
    | "store.fallback.sql_snippet_name",
  index: number,
): string => translate(key, { index: index + 1 });

export const normalizeClickHouseProtocol = (
  value: unknown,
): "auto" | "http" | "native" => {
  const text = toTrimmedString(value).toLowerCase();
  if (text === "http" || text === "https") return "http";
  if (text === "native" || text === "tcp") return "native";
  return "auto";
};

export const normalizePort = (value: unknown, fallbackPort: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackPort;
  const port = Math.trunc(parsed);
  if (port <= 0 || port > 65535) return fallbackPort;
  return port;
};

const isValidHostEntry = (entry: string): boolean => {
  if (!entry) return false;
  if (entry.length > MAX_HOST_ENTRY_LENGTH) return false;
  if (/[()\\/\s]/.test(entry)) return false;
  return true;
};

export const sanitizeStringArray = (value: unknown, maxLength = 256): string[] => {
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

const DATABASE_FILTER_PATTERN_LIMIT = 256;
const utf8Encoder = new TextEncoder();

export const sanitizeDatabasePatternArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const normalized = toTrimmedString(entry);
    if (!normalized || utf8Encoder.encode(normalized).byteLength > DATABASE_FILTER_PATTERN_LIMIT) {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= DATABASE_FILTER_PATTERN_LIMIT) break;
  }
  return result;
};

export const sanitizeSchemaVisibilityByDatabase = (
  value: unknown,
  caseSensitive: boolean,
): Record<string, SchemaVisibilityRule> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, SchemaVisibilityRule> = {};
  const seenDatabases = new Set<string>();
  Object.entries(value as Record<string, unknown>).some(([rawDatabase, rawRule]) => {
    if (Object.keys(result).length >= 128) return true;
    const database = toTrimmedString(rawDatabase);
    const databaseKey = caseSensitive ? database : database.toLocaleLowerCase();
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
        const schemaKey = caseSensitive ? schema : schema.toLocaleLowerCase();
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

export const sanitizeNumberArray = (
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

export const sanitizeAddressList = (value: unknown): string[] => {
  const all = sanitizeStringArray(value, MAX_HOST_ENTRY_LENGTH).filter(
    (entry) => isValidHostEntry(entry),
  );
  return all.slice(0, MAX_HOST_ENTRIES);
};

export const sanitizeConnectionIconType = (value: unknown): string | undefined => {
  const iconType = toTrimmedString(value).toLowerCase();
  return iconType || undefined;
};

export const sanitizeConnectionIconColor = (value: unknown): string | undefined => {
  const color = toTrimmedString(value);
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)
    ? color
    : undefined;
};

export const normalizeConnectionType = (value: unknown): string => {
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
    type === "intersystems-cache" ||
    type === "intersystemscache" ||
    type === "inter-systems-cache" ||
    type === "intersystems-cache-database" ||
    type === "cache-db" ||
    type === "cachedb"
  ) {
    return "cache";
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

export const sanitizeJVMModes = (
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

export const unwrapPersistedAppState = (
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
