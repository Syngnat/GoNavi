import { create } from 'zustand';
import {
  CUSTOM_THEME_MAX_COUNT,
  CUSTOM_THEME_MAX_TOTAL_BYTES,
  CUSTOM_THEME_SCHEMA_VERSION,
  createCustomThemeId,
  getCustomThemeByteLength,
  sanitizeCustomThemeBaseMode,
  sanitizeCustomThemeDefinition,
  sanitizeCustomThemeFileName,
  sanitizeCustomThemeList,
  sanitizeCustomThemeName,
  validateCustomThemeCss,
  type CustomThemeBaseMode,
  type CustomThemeDefinition,
  type CustomThemeValidationReason,
} from './utils/customTheme';
import {
  resolveAvailableCustomTheme,
  resolveBuiltinCustomThemePreset,
} from './utils/customThemePresets';
import {
  EMPTY_REMEMBERED_CUSTOM_THEME_IDS,
  forgetCustomTheme,
  rememberCustomThemeForMode,
  resolveRememberedCustomThemeId,
  sanitizeRememberedCustomThemeIds,
  type RememberedCustomThemeIds,
  type RememberedThemeMode,
} from './utils/customThemeModeMemory';

export const CUSTOM_THEME_STORAGE_KEY = 'gonavi-custom-themes-v1';

type CustomThemeStoreError =
  | CustomThemeValidationReason
  | 'max-count'
  | 'max-total-size'
  | 'not-found'
  | 'storage-failed';

export type CustomThemeStoreResult =
  | { ok: true; theme?: CustomThemeDefinition }
  | { ok: false; reason: CustomThemeStoreError };

type CustomThemeSnapshot = {
  version: 1;
  themes: CustomThemeDefinition[];
  activeThemeId: string | null;
  /** 亮 / 暗模式各自上次应用的主题，一键切换明暗时据此恢复。 */
  rememberedThemeIds: RememberedCustomThemeIds;
};

type CustomThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

type ImportCustomThemeInput = {
  name: string;
  sourceFileName: string;
  baseMode?: CustomThemeBaseMode;
  css: string;
};

type UpdateCustomThemeInput = Partial<Pick<
  CustomThemeDefinition,
  'name' | 'sourceFileName' | 'baseMode' | 'css'
>>;

interface CustomThemeState extends CustomThemeSnapshot {
  importCustomTheme: (input: ImportCustomThemeInput) => CustomThemeStoreResult;
  updateCustomTheme: (id: string, patch: UpdateCustomThemeInput) => CustomThemeStoreResult;
  selectCustomTheme: (id: string | null) => CustomThemeStoreResult;
  /** 用户主动退回基础主题：关闭当前主题并忘掉它在所属模式下的记忆。 */
  deactivateCustomTheme: () => CustomThemeStoreResult;
  /** 切换到某个明暗偏好时恢复该模式记住的主题；跟随系统或无记忆时回到基础主题。 */
  activateRememberedCustomTheme: (mode: RememberedThemeMode | 'system') => CustomThemeStoreResult;
  removeCustomTheme: (id: string) => CustomThemeStoreResult;
  reloadCustomThemes: () => void;
}

const EMPTY_CUSTOM_THEME_SNAPSHOT: CustomThemeSnapshot = {
  version: 1,
  themes: [],
  activeThemeId: null,
  rememberedThemeIds: EMPTY_REMEMBERED_CUSTOM_THEME_IDS,
};

const getBrowserStorage = (): CustomThemeStorage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

export const sanitizeCustomThemeSnapshot = (value: unknown): CustomThemeSnapshot => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (raw.version !== CUSTOM_THEME_SCHEMA_VERSION) return { ...EMPTY_CUSTOM_THEME_SNAPSHOT };
  // builtin-* IDs are a reserved catalog namespace. Persisted user data is an
  // untrusted boundary and must not shadow an immutable built-in theme.
  const themes = sanitizeCustomThemeList(raw.themes).filter(
    (theme) => !resolveBuiltinCustomThemePreset(theme.id),
  );
  const activeTheme = resolveAvailableCustomTheme(themes, raw.activeThemeId);
  return {
    version: 1,
    themes,
    activeThemeId: activeTheme?.id ?? null,
    rememberedThemeIds: sanitizeRememberedCustomThemeIds(raw.rememberedThemeIds, themes),
  };
};

export const loadCustomThemeSnapshot = (
  storage: CustomThemeStorage | null = getBrowserStorage(),
): CustomThemeSnapshot => {
  if (!storage) return { ...EMPTY_CUSTOM_THEME_SNAPSHOT };
  try {
    const raw = storage.getItem(CUSTOM_THEME_STORAGE_KEY);
    if (!raw) return { ...EMPTY_CUSTOM_THEME_SNAPSHOT };
    return sanitizeCustomThemeSnapshot(JSON.parse(raw));
  } catch {
    return { ...EMPTY_CUSTOM_THEME_SNAPSHOT };
  }
};

const persistCustomThemeSnapshot = (snapshot: CustomThemeSnapshot): boolean => {
  const storage = getBrowserStorage();
  // Server-side/test imports may intentionally run without a browser. In an
  // actual app window, unavailable storage must not be reported as persisted.
  if (!storage) return typeof window === 'undefined';
  try {
    storage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
};

const getTotalThemeBytes = (themes: CustomThemeDefinition[]): number => themes.reduce(
  (total, theme) => total + getCustomThemeByteLength(theme.css),
  0,
);

const createSnapshot = (
  themes: CustomThemeDefinition[],
  activeThemeId: string | null,
  rememberedThemeIds: RememberedCustomThemeIds,
): CustomThemeSnapshot => ({
  version: 1,
  themes,
  activeThemeId,
  // 主题被删除或 baseMode 被改动后，记忆必须随之校正。
  rememberedThemeIds: sanitizeRememberedCustomThemeIds(rememberedThemeIds, themes),
});

const initialSnapshot = loadCustomThemeSnapshot();

export const useCustomThemeStore = create<CustomThemeState>((set, get) => ({
  ...initialSnapshot,

  importCustomTheme: (input) => {
    const validation = validateCustomThemeCss(input.css);
    if (!validation.ok) return { ok: false, reason: validation.reason };
    const state = get();
    if (state.themes.length >= CUSTOM_THEME_MAX_COUNT) {
      return { ok: false, reason: 'max-count' };
    }
    if (getTotalThemeBytes(state.themes) + validation.byteLength > CUSTOM_THEME_MAX_TOTAL_BYTES) {
      return { ok: false, reason: 'max-total-size' };
    }
    let id = createCustomThemeId();
    const existingIds = new Set(state.themes.map((theme) => theme.id));
    while (existingIds.has(id)) id = createCustomThemeId();
    const now = Date.now();
    const theme = sanitizeCustomThemeDefinition({
      schemaVersion: CUSTOM_THEME_SCHEMA_VERSION,
      id,
      name: sanitizeCustomThemeName(input.name),
      sourceFileName: sanitizeCustomThemeFileName(input.sourceFileName),
      baseMode: sanitizeCustomThemeBaseMode(input.baseMode),
      css: validation.css,
      createdAt: now,
      updatedAt: now,
    });
    if (!theme) return { ok: false, reason: 'invalid-syntax' };
    const nextSnapshot = createSnapshot([theme, ...state.themes], state.activeThemeId, state.rememberedThemeIds);
    if (!persistCustomThemeSnapshot(nextSnapshot)) {
      return { ok: false, reason: 'storage-failed' };
    }
    set(nextSnapshot);
    return { ok: true, theme };
  },

  updateCustomTheme: (id, patch) => {
    const state = get();
    const currentIndex = state.themes.findIndex((theme) => theme.id === id);
    if (currentIndex < 0) return { ok: false, reason: 'not-found' };
    const current = state.themes[currentIndex];
    const nextCss = patch.css ?? current.css;
    const validation = validateCustomThemeCss(nextCss);
    if (!validation.ok) return { ok: false, reason: validation.reason };
    const otherBytes = getTotalThemeBytes(state.themes) - getCustomThemeByteLength(current.css);
    if (otherBytes + validation.byteLength > CUSTOM_THEME_MAX_TOTAL_BYTES) {
      return { ok: false, reason: 'max-total-size' };
    }
    const nextTheme = sanitizeCustomThemeDefinition({
      ...current,
      ...patch,
      schemaVersion: CUSTOM_THEME_SCHEMA_VERSION,
      name: sanitizeCustomThemeName(patch.name ?? current.name, current.name),
      sourceFileName: sanitizeCustomThemeFileName(patch.sourceFileName ?? current.sourceFileName),
      baseMode: sanitizeCustomThemeBaseMode(patch.baseMode ?? current.baseMode),
      css: validation.css,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    });
    if (!nextTheme) return { ok: false, reason: 'invalid-syntax' };
    const themes = state.themes.map((theme, index) => index === currentIndex ? nextTheme : theme);
    const nextSnapshot = createSnapshot(themes, state.activeThemeId, state.rememberedThemeIds);
    if (!persistCustomThemeSnapshot(nextSnapshot)) {
      return { ok: false, reason: 'storage-failed' };
    }
    set(nextSnapshot);
    return { ok: true, theme: nextTheme };
  },

  selectCustomTheme: (id) => {
    const state = get();
    if (id !== null && !resolveAvailableCustomTheme(state.themes, id)) {
      return { ok: false, reason: 'not-found' };
    }
    const theme = resolveAvailableCustomTheme(state.themes, id);
    const nextSnapshot = createSnapshot(
      state.themes,
      id,
      rememberCustomThemeForMode(state.rememberedThemeIds, theme),
    );
    if (!persistCustomThemeSnapshot(nextSnapshot)) {
      // Deactivation is also the recovery path for a malformed theme. It must
      // remain available in-memory even when localStorage is blocked or full.
      if (id === null) set(nextSnapshot);
      return { ok: false, reason: 'storage-failed' };
    }
    set(nextSnapshot);
    return { ok: true, theme: theme ?? undefined };
  },

  deactivateCustomTheme: () => {
    const state = get();
    const nextSnapshot = createSnapshot(
      state.themes,
      null,
      forgetCustomTheme(state.rememberedThemeIds, state.activeThemeId),
    );
    if (!persistCustomThemeSnapshot(nextSnapshot)) {
      // Same recovery contract as selectCustomTheme(null): always leave the theme in-memory.
      set(nextSnapshot);
      return { ok: false, reason: 'storage-failed' };
    }
    set(nextSnapshot);
    return { ok: true };
  },

  activateRememberedCustomTheme: (mode) => {
    const state = get();
    const targetId = resolveRememberedCustomThemeId(state.rememberedThemeIds, mode);
    if (targetId === state.activeThemeId) return { ok: true };
    return get().selectCustomTheme(targetId);
  },

  removeCustomTheme: (id) => {
    const state = get();
    if (!state.themes.some((theme) => theme.id === id)) {
      return { ok: false, reason: 'not-found' };
    }
    const themes = state.themes.filter((theme) => theme.id !== id);
    const activeThemeId = state.activeThemeId === id ? null : state.activeThemeId;
    const nextSnapshot = createSnapshot(themes, activeThemeId, state.rememberedThemeIds);
    if (!persistCustomThemeSnapshot(nextSnapshot)) {
      return { ok: false, reason: 'storage-failed' };
    }
    set(nextSnapshot);
    return { ok: true };
  },

  reloadCustomThemes: () => set(loadCustomThemeSnapshot()),
}));
