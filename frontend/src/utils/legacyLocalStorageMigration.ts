export const LEGACY_PERSIST_STORAGE_KEY = 'lite-db-storage';
export const LEGACY_LOCAL_STORAGE_ENDPOINT = '/__gonavi/legacy-local-storage';
export const LEGACY_LOCAL_STORAGE_MARKER = 'gonavi-legacy-local-storage-migrated-v1';
export const LEGACY_LOCAL_STORAGE_MARKER_VERSION = 2;

// Wails v2 used these origins. Current v3 builds pin the window to them, so the
// "legacy" source and the live store are the same database and running the
// migration would rewrite the profile from itself on every launch. Only v3
// builds that still use the v3 default origin need the import.
export const LEGACY_V2_LOCAL_STORAGE_ORIGINS = ['wails://wails', 'http://wails.localhost'];

export function isLegacyV2LocalStorageOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return false;
  }
  return LEGACY_V2_LOCAL_STORAGE_ORIGINS.includes(origin.replace(/\/+$/, '').toLowerCase());
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type LegacyResponse = {
  found?: unknown;
  items?: unknown;
  hasSavedConnections?: unknown;
  source?: unknown;
  fingerprint?: unknown;
};
export type LegacyLocalStorageTransport = () => string | null;

type PersistedState = Record<string, unknown>;
type MigrationMarker = {
  version: number;
  source?: string;
  fingerprint?: string;
  importedDigest?: string;
};

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

// A cheap synchronous digest. It is only used to decide whether the profile
// still equals the payload imported last time, so a hash collision would at
// worst cause one unnecessary re-import, never a security issue.
export function legacyPersistDigest(value: string | null): string {
  if (value === null) {
    return '';
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const parseMarker = (raw: string | null): MigrationMarker | null => {
  if (!raw) {
    return null;
  }
  // Profiles migrated before the fingerprint existed only stored "1".
  if (raw === '1') {
    return { version: 1 };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 0,
      source: typeof parsed.source === 'string' ? parsed.source : undefined,
      fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : undefined,
      importedDigest: typeof parsed.importedDigest === 'string' ? parsed.importedDigest : undefined,
    };
  } catch {
    return null;
  }
};

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
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

export function migrateLegacyLocalStorage(
  storage: StorageLike,
  transport: LegacyLocalStorageTransport = requestLegacyLocalStorage,
  currentOrigin: string | undefined = typeof window !== 'undefined' ? window.location.origin : undefined,
): boolean {
  if (isLegacyV2LocalStorageOrigin(currentOrigin)) {
    return false;
  }
  let markerRaw: string | null;
  let current: string | null;
  try {
    markerRaw = storage.getItem(LEGACY_LOCAL_STORAGE_MARKER);
    current = storage.getItem(LEGACY_PERSIST_STORAGE_KEY);
  } catch {
    return false;
  }

  const marker = parseMarker(markerRaw);
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

  const fingerprint = typeof response.fingerprint === 'string' ? response.fingerprint : '';
  const source = typeof response.source === 'string' ? response.source : '';

  // The legacy profile the previous launch copied is unchanged, so there is
  // nothing to merge. The request still runs because a v2 rollback can change
  // the source at any time and the fingerprint is the only way to notice.
  if (
    marker?.version === LEGACY_LOCAL_STORAGE_MARKER_VERSION
    && marker.fingerprint
    && fingerprint
    && marker.fingerprint === fingerprint
  ) {
    return false;
  }

  const entries = Object.entries(response.items).filter((entry): entry is [string, string] => (
    typeof entry[0] === 'string' && entry[0].length > 0 && typeof entry[1] === 'string' && entry[1].length > 0
  ));
  const legacyPersist = response.items[LEGACY_PERSIST_STORAGE_KEY];
  let changed = false;
  let importedDigest = marker?.version === LEGACY_LOCAL_STORAGE_MARKER_VERSION
    ? (marker.importedDigest ?? '')
    : '';

  if (typeof legacyPersist === 'string' && legacyPersist) {
    try {
      const currentDigest = legacyPersistDigest(current);
      let replace = shouldReplacePersistedSettings(current, legacyPersist);
      // A v2 rollback: the legacy source changed while the v3 profile still
      // equals the payload imported last time, so this is the same user
      // editing v2, not a v3 user overwriting the migration.
      if (
        !replace
        && marker?.version === LEGACY_LOCAL_STORAGE_MARKER_VERSION
        && marker.importedDigest
        && currentDigest === marker.importedDigest
      ) {
        replace = true;
      }
      if (replace) {
        const restoredPersist = response.hasSavedConnections === true
          ? stripBackendOwnedPersistedState(legacyPersist)
          : legacyPersist;
        storage.setItem(LEGACY_PERSIST_STORAGE_KEY, restoredPersist);
        importedDigest = legacyPersistDigest(restoredPersist);
        changed = true;
      } else if (marker && marker.version !== LEGACY_LOCAL_STORAGE_MARKER_VERSION) {
        // Upgrading from the one-shot marker: only claim the current payload
        // as "imported" when it still equals the legacy one. Otherwise the
        // profile was edited in v3 and must not be auto-replaced on a later
        // v2 change.
        // Compare against both the full and the backend-stripped payload:
        // whether the first migration stripped connections depended on the
        // backend state at that time, which may have changed since.
        const expectedImports = [
          legacyPersist,
          stripBackendOwnedPersistedState(legacyPersist),
        ];
        if (expectedImports.some((value) => currentDigest === legacyPersistDigest(value))) {
          importedDigest = currentDigest;
        }
      }
    } catch {
      return false;
    }
  }

  for (const [key, value] of entries) {
    if (key === LEGACY_PERSIST_STORAGE_KEY) {
      continue;
    }
    if (writeIfMissing(storage, key, value)) {
      changed = true;
    }
  }

  const markerOutdated = (
    !marker
    || marker.version !== LEGACY_LOCAL_STORAGE_MARKER_VERSION
    || (fingerprint !== '' && marker.fingerprint !== fingerprint)
    || (marker.importedDigest ?? '') !== importedDigest
  );
  if (markerOutdated) {
    try {
      storage.setItem(LEGACY_LOCAL_STORAGE_MARKER, JSON.stringify({
        version: LEGACY_LOCAL_STORAGE_MARKER_VERSION,
        source,
        fingerprint,
        importedDigest,
      }));
    } catch {
      // The migration itself succeeded; a missing marker only means a retry next launch.
    }
  }
  return changed;
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
