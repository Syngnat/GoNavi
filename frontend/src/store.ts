import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SavedConnection, TabData, SavedQuery } from './types';

export interface SqlLog {
  id: string;
  timestamp: number;
  sql: string;
  status: 'success' | 'error';
  duration: number;
  message?: string;
  dbName?: string;
  affectedRows?: number;
}

interface AppState {
  connections: SavedConnection[];
  tabs: TabData[];
  activeTabId: string | null;
  activeContext: { connectionId: string; dbName: string } | null;
  savedQueries: SavedQuery[];
  theme: 'light' | 'dark';
  appearance: { opacity: number; blur: number };
  sqlFormatOptions: { keywordCase: 'upper' | 'lower' };
  queryOptions: { maxRows: number };
  sqlLogs: SqlLog[];
  
  addConnection: (conn: SavedConnection) => void;
  updateConnection: (conn: SavedConnection) => void;
  removeConnection: (id: string) => void;
  
  addTab: (tab: TabData) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToLeft: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (id: string) => void;
  setActiveContext: (context: { connectionId: string; dbName: string } | null) => void;

  saveQuery: (query: SavedQuery) => void;
  deleteQuery: (id: string) => void;

  setTheme: (theme: 'light' | 'dark') => void;
  setAppearance: (appearance: Partial<{ opacity: number; blur: number }>) => void;
  setSqlFormatOptions: (options: { keywordCase: 'upper' | 'lower' }) => void;
  setQueryOptions: (options: Partial<{ maxRows: number }>) => void;
  
  addSqlLog: (log: SqlLog) => void;
  clearSqlLogs: () => void;
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      connections: [],
      tabs: [],
      activeTabId: null,
      activeContext: null,
      savedQueries: [],
      theme: 'light',
      appearance: { opacity: 0.95, blur: 0 },
      sqlFormatOptions: { keywordCase: 'upper' },
      queryOptions: { maxRows: 5000 },
      sqlLogs: [],

      addConnection: (conn) => set((state) => ({ connections: [...state.connections, conn] })),
      updateConnection: (conn) => set((state) => ({ 
          connections: state.connections.map(c => c.id === conn.id ? conn : c) 
      })),
      removeConnection: (id) => set((state) => ({ connections: state.connections.filter(c => c.id !== id) })),

      addTab: (tab) => set((state) => {
        const index = state.tabs.findIndex(t => t.id === tab.id);
        if (index !== -1) {
            // Update existing tab with new data (e.g. switch initialTab)
            const newTabs = [...state.tabs];
            newTabs[index] = { ...newTabs[index], ...tab };
            return { tabs: newTabs, activeTabId: tab.id };
        }
        return { tabs: [...state.tabs, tab], activeTabId: tab.id };
      }),
      
      closeTab: (id) => set((state) => {
        const newTabs = state.tabs.filter(t => t.id !== id);
        let newActiveId = state.activeTabId;
        if (state.activeTabId === id) {
          newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
        }
        return { tabs: newTabs, activeTabId: newActiveId };
      }),

      closeOtherTabs: (id) => set((state) => {
        const keep = state.tabs.find(t => t.id === id);
        if (!keep) return state;
        return { tabs: [keep], activeTabId: id };
      }),

      closeTabsToLeft: (id) => set((state) => {
        const index = state.tabs.findIndex(t => t.id === id);
        if (index === -1) return state;
        const newTabs = state.tabs.slice(index);
        const activeStillExists = state.activeTabId ? newTabs.some(t => t.id === state.activeTabId) : false;
        return { tabs: newTabs, activeTabId: activeStillExists ? state.activeTabId : id };
      }),

      closeTabsToRight: (id) => set((state) => {
        const index = state.tabs.findIndex(t => t.id === id);
        if (index === -1) return state;
        const newTabs = state.tabs.slice(0, index + 1);
        const activeStillExists = state.activeTabId ? newTabs.some(t => t.id === state.activeTabId) : false;
        return { tabs: newTabs, activeTabId: activeStillExists ? state.activeTabId : id };
      }),

      closeAllTabs: () => set(() => ({ tabs: [], activeTabId: null })),
      
      setActiveTab: (id) => set({ activeTabId: id }),
      setActiveContext: (context) => set({ activeContext: context }),

      saveQuery: (query) => set((state) => {
        // If query with same ID exists, update it
        const existing = state.savedQueries.find(q => q.id === query.id);
        if (existing) {
             return { savedQueries: state.savedQueries.map(q => q.id === query.id ? query : q) };
        }
        return { savedQueries: [...state.savedQueries, query] };
      }),

      deleteQuery: (id) => set((state) => ({ savedQueries: state.savedQueries.filter(q => q.id !== id) })),

      setTheme: (theme) => set({ theme }),
      setAppearance: (appearance) => set((state) => ({ appearance: { ...state.appearance, ...appearance } })),
      setSqlFormatOptions: (options) => set({ sqlFormatOptions: options }),
      setQueryOptions: (options) => set((state) => ({ queryOptions: { ...state.queryOptions, ...options } })),
      
      addSqlLog: (log) => set((state) => ({ sqlLogs: [log, ...state.sqlLogs].slice(0, 1000) })), // Keep last 1000 logs
      clearSqlLogs: () => set({ sqlLogs: [] }),
    }),
    {
      name: 'lite-db-storage', // name of the item in the storage (must be unique)
      partialize: (state) => ({ connections: state.connections, savedQueries: state.savedQueries, theme: state.theme, appearance: state.appearance, sqlFormatOptions: state.sqlFormatOptions, queryOptions: state.queryOptions }), // Don't persist logs
    }
  )
);
