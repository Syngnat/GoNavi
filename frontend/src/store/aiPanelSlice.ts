import {
  toAIChatDetachedBoundsMemory,
  nextDetachedZIndex,
  createDefaultDetachedBounds,
} from "../utils/detachedWindow";
import { resolveAIChatDetachPreferred, sanitizeAIChatOpenMode } from "./storeSettingsSanitizers";
import { t as translate } from "../i18n";
import { isAIStreamingOnlyMessageUpdate } from "./storeWorkbenchSanitizers";
import type { AppState } from "./storeStateTypes";
import type { StoreGet, StoreSet } from "./storeSliceTypes";

export type AIPanelSliceState = Pick<AppState, 
  | 'toggleAIPanel'
  | 'setAIPanelVisible'
  | 'setAIChatOpenMode'
  | 'detachAIChatPanel'
  | 'attachAIChatPanel'
  | 'updateDetachedAIChatBounds'
  | 'focusDetachedAIChatPanel'
  | 'isAIChatDetached'
  | 'addAIChatMessage'
  | 'updateAIChatMessage'
  | 'deleteAIChatMessage'
  | 'truncateAIChatMessages'
  | 'clearAIChatHistory'
  | 'replaceAIChatHistory'
  | 'deleteAISession'
  | 'createNewAISession'
  | 'setAIActiveSessionId'
  | 'updateAISessionTitle'
  | 'addAIContext'
  | 'removeAIContext'
  | 'clearAIContexts'
>;

export const createAIPanelSlice = (set: StoreSet, get: StoreGet): AIPanelSliceState => ({
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
  },
  clearAIChatHistory: (sessionId) => {
    set((state) => {
      const history = { ...state.aiChatHistory };
      delete history[sessionId];
      return { aiChatHistory: history };
    });
  },
  replaceAIChatHistory: (sessionId, messages) => {
    set((state) => {
      const history = { ...state.aiChatHistory };
      history[sessionId] = messages;
      return { aiChatHistory: history };
    });
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
});
