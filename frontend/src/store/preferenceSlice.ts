import {
  sanitizeThemePreference,
  sanitizeLanguagePreference,
  sanitizeAppearance,
  sanitizeUiScale,
  sanitizeFontSize,
  sanitizeAutoCheckForUpdates,
  sanitizeAutoCheckForUpdatesIntervalMinutes,
  sanitizeGlobalProxy,
  readPersistedShortcutOptions,
  sanitizeQueryOptions,
  sanitizeDataEditTransactionOptions,
  sanitizeSqlEditorTransactionOptions,
  runWithExplicitShortcutPersistence,
  appendRuntimeSqlLog,
} from "./storeSettingsSanitizers";
import { PERSIST_VERSION, DEFAULT_GLOBAL_PROXY, sanitizeBrandIconIdLocal } from "./storeConstants";
import { setRedisDbAlias as applyRedisDbAlias } from "../utils/redisDbAlias";
import { writePersistedStatePatch } from "./storeConnectionSanitizers";
import {
  getShortcutPlatform,
  cloneShortcutOptions,
  DEFAULT_SHORTCUT_OPTIONS,
} from "../utils/shortcuts";
import { BUILTIN_SNIPPET_MAP } from "../utils/sqlSnippetDefaults";
import type { AppState } from "./storeStateTypes";
import type { StoreGet, StoreSet } from "./storeSliceTypes";

export type PreferenceSliceState = Pick<AppState, 
  | 'setTheme'
  | 'setThemePreference'
  | 'setBrandIconId'
  | 'setLanguagePreference'
  | 'setAppearance'
  | 'setRedisDbAlias'
  | 'setUiScale'
  | 'setFontSize'
  | 'setStartupFullscreen'
  | 'setAutoCheckForUpdates'
  | 'setAutoCheckForUpdatesIntervalMinutes'
  | 'setGlobalProxy'
  | 'replaceGlobalProxy'
  | 'setSqlFormatOptions'
  | 'setQueryOptions'
  | 'setDataEditTransactionOptions'
  | 'setSqlEditorTransactionOptions'
  | 'setSqlEditorPendingTransaction'
  | 'updateShortcut'
  | 'resetShortcutOptions'
  | 'saveSqlSnippet'
  | 'deleteSqlSnippet'
  | 'resetBuiltinSqlSnippet'
  | 'addSqlLog'
  | 'hideSqlLogFromRecent'
  | 'clearRecentSqlLogs'
  | 'clearSqlLogs'
>;

export const createPreferenceSlice = (set: StoreSet, _get: StoreGet): PreferenceSliceState => ({
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
});
