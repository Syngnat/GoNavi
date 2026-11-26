const TABLE_DDL_OPEN_STORAGE_KEY = 'gonavi.sidebar.openTableDdlOnClick';

let cachedOpenTableDdl = false;
let cacheLoaded = false;
const listeners = new Set<(enabled: boolean) => void>();

const readStoredPreference = (): boolean => {
  try {
    if (typeof window === 'undefined') return false;
    return window.localStorage?.getItem(TABLE_DDL_OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

export const readTableDdlOpenOnClick = (): boolean => {
  if (!cacheLoaded) {
    cachedOpenTableDdl = readStoredPreference();
    cacheLoaded = true;
  }
  return cachedOpenTableDdl;
};

export const writeTableDdlOpenOnClick = (enabled: boolean): void => {
  cachedOpenTableDdl = enabled;
  cacheLoaded = true;
  try {
    if (typeof window !== 'undefined') {
      if (enabled) {
        window.localStorage?.setItem(TABLE_DDL_OPEN_STORAGE_KEY, '1');
      } else {
        window.localStorage?.removeItem(TABLE_DDL_OPEN_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore storage failures in restricted runtimes.
  }
  listeners.forEach((listener) => listener(enabled));
};

export const subscribeTableDdlOpenOnClick = (
  listener: (enabled: boolean) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const resetTableDdlOpenPreferenceForTests = (): void => {
  cacheLoaded = false;
  cachedOpenTableDdl = false;
  listeners.clear();
};
