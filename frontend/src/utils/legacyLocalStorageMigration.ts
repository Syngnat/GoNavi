export const LEGACY_PERSIST_STORAGE_KEY = 'lite-db-storage';
export const LEGACY_LOCAL_STORAGE_ENDPOINT = '/__gonavi/legacy-local-storage';
export const LEGACY_LOCAL_STORAGE_MARKER = 'gonavi-legacy-local-storage-migrated-v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type LegacyResponse = { found?: unknown; items?: unknown; hasSavedConnections?: unknown };
export type LegacyLocalStorageTransport = () => string | null;

type PersistedState = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export function requestLegacyLocalStorage(): string | null {
  if (typeof XMLHttpRequest === 'undefined') {
    return null;
  }
  try {
    const xhr = new XMLHttpRequest();
    // Synchronous on purpose: the legacy payload has to be in localStorage
    // before bootstrap imports the store module and Zustand hydrates.
    xhr.open('GET', LEGACY_LOCAL_STORAGE_ENDPOINT, false);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.send(null);
    if (xhr.status < 200 || xhr.status >= 300) {
      return null;
    }
    return xhr.responseText;
  } catch {
    return null;
  }
}

const persistedStateOf = (raw: string | null): PersistedState | null => {
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null');
    if (!isRecord(parsed)) {
      return null;
    }
    return isRecord(parsed.state) ? parsed.state : parsed;
  } catch {
    return null;
  }
};

const listSize = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

// The persisted defaults use "light" for both theme fields; older code only
// treated "system" as default and therefore refused to restore a freshly
// downgraded v3 profile that had already written its default payload.
const DEFAULT_THEME_VALUES = new Set(['', 'light', 'system']);
const DEFAULT_LANGUAGE_VALUES = new Set(['', 'auto']);

const hasUserSettings = (state: PersistedState | null): boolean => {
  if (!state) {
    return false;
  }
  if (listSize(state.connections) > 0 || listSize(state.savedQueries) > 0 || listSize(state.aiChatSessions) > 0) {
    return true;
  }
  if (listSize(state.tabs) > 1) {
    return true;
  }
  const themePreference = typeof state.themePreference === 'string' ? state.themePreference.trim() : '';
  if (!DEFAULT_THEME_VALUES.has(themePreference)) {
    return true;
  }
  const theme = typeof state.theme === 'string' ? state.theme.trim() : '';
  if (!DEFAULT_THEME_VALUES.has(theme)) {
    return true;
  }
  const language = typeof state.languagePreference === 'string' ? state.languagePreference.trim() : '';
  if (!DEFAULT_LANGUAGE_VALUES.has(language)) {
    return true;
  }
  return isRecord(state.aiChatHistory) && Object.keys(state.aiChatHistory).length > 0;
};

export function shouldReplacePersistedSettings(currentRaw: string | null, legacyRaw: string): boolean {
  if (!legacyRaw) {
    return false;
  }
  if (!currentRaw) {
    return true;
  }
  const current = persistedStateOf(currentRaw);
  if (!current) {
    return true;
  }
  const legacy = persistedStateOf(legacyRaw);
  if (!legacy) {
    return false;
  }
  // Connections are the highest-value payload. A v3 profile can already
  // contain a default theme/tab while still missing every saved connection;
  // in that case the legacy store must win even though hasUserSettings()
  // would otherwise treat the current profile as authoritative.
  if (listSize(legacy.connections) > 0 && listSize(current.connections) === 0) {
    return true;
  }
  return !hasUserSettings(current);
}

// Connections and the global proxy are owned by the Go backend in v3. Once the
// backend has saved connections, restoring the whole legacy Zustand payload
// would re-import connections the user deleted after upgrading, so only the
// UI portion of the old store may be restored.
export function stripBackendOwnedPersistedState(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isRecord(parsed)) {
    return raw;
  }
  const state = isRecord(parsed.state) ? parsed.state : parsed;
  if (!isRecord(state)) {
    return raw;
  }
  delete state.connections;
  delete state.globalProxy;
  return JSON.stringify(parsed);
}

const writeIfMissing = (storage: StorageLike, key: string, value: string): boolean => {
  try {
    if (storage.getItem(key) === null) {
      storage.setItem(key, value);
    }
    return true;
  } catch {
    return false;
  }
};

export function migrateLegacyLocalStorage(
  storage: StorageLike,
  transport: LegacyLocalStorageTransport = requestLegacyLocalStorage,
): boolean {
  try {
    if (storage.getItem(LEGACY_LOCAL_STORAGE_MARKER)) {
      return false;
    }
  } catch {
    return false;
  }

  const raw = transport();
  if (!raw) {
    return false;
  }

  let response: LegacyResponse;
  try {
    response = JSON.parse(raw) as LegacyResponse;
  } catch {
    return false;
  }
  if (!isRecord(response.items) || response.found !== true) {
    return false;
  }

  const entries = Object.entries(response.items).filter((entry): entry is [string, string] => (
    typeof entry[0] === 'string' && entry[0].length > 0 && typeof entry[1] === 'string' && entry[1].length > 0
  ));
  const legacyPersist = response.items[LEGACY_PERSIST_STORAGE_KEY];
  if (typeof legacyPersist === 'string' && legacyPersist) {
    try {
      const current = storage.getItem(LEGACY_PERSIST_STORAGE_KEY);
      if (shouldReplacePersistedSettings(current, legacyPersist)) {
        const restoredPersist = response.hasSavedConnections === true
          ? stripBackendOwnedPersistedState(legacyPersist)
          : legacyPersist;
        storage.setItem(LEGACY_PERSIST_STORAGE_KEY, restoredPersist);
      }
    } catch {
      return false;
    }
  }

  for (const [key, value] of entries) {
    if (key === LEGACY_PERSIST_STORAGE_KEY) {
      continue;
    }
    writeIfMissing(storage, key, value);
  }

  try {
    storage.setItem(LEGACY_LOCAL_STORAGE_MARKER, '1');
  } catch {
    // The migration itself succeeded; a missing marker only means a retry next launch.
  }
  return true;
}

export function migrateLegacyLocalStorageIfNeeded(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false;
  }
  try {
    return migrateLegacyLocalStorage(window.localStorage);
  } catch {
    return false;
  }
}
