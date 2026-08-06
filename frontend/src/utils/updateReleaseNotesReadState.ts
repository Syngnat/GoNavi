/**
 * 本地缓存「已读」的更新日志版本，用于关于页/更新提示条上的未读提示。
 * key 形态：channel:version（与安装包名无关，便于同一版本多包形态共用已读状态）
 */

const STORAGE_KEY = 'gonavi.updateReleaseNotes.readKeys.v1';
const MAX_KEYS = 40;

export type ReleaseNotesReadIdentity = {
  channel?: string | null;
  latestVersion?: string | null;
};

export const buildReleaseNotesReadKey = (
  info: ReleaseNotesReadIdentity | null | undefined,
): string => {
  const version = String(info?.latestVersion || '').trim();
  if (!version) return '';
  const channel = String(info?.channel || 'latest').trim().toLowerCase() || 'latest';
  return `${channel}:${version}`;
};

const readStorage = (): string[] => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const writeStorage = (keys: string[]): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys.slice(0, MAX_KEYS)));
  } catch {
    // ignore quota / private mode
  }
};

export const loadReadReleaseNotesKeys = (): Set<string> => new Set(readStorage());

export const isReleaseNotesRead = (key: string): boolean => {
  const normalized = String(key || '').trim();
  if (!normalized) return false;
  return loadReadReleaseNotesKeys().has(normalized);
};

/** 标记已读；返回是否状态发生变化。 */
export const markReleaseNotesRead = (key: string): boolean => {
  const normalized = String(key || '').trim();
  if (!normalized) return false;
  const current = readStorage();
  if (current.includes(normalized)) return false;
  writeStorage([normalized, ...current.filter((item) => item !== normalized)]);
  return true;
};

export const clearReleaseNotesReadState = (): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};
