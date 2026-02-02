import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SavedConnection, TabData, SavedQuery } from './types';

interface AppState {
  connections: SavedConnection[];
  tabs: TabData[];
  activeTabId: string | null;
  savedQueries: SavedQuery[];
  darkMode: boolean;
  sqlFormatOptions: { keywordCase: 'upper' | 'lower' };
  
  addConnection: (conn: SavedConnection) => void;
  removeConnection: (id: string) => void;
  
  addTab: (tab: TabData) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;

  saveQuery: (query: SavedQuery) => void;
  deleteQuery: (id: string) => void;

  toggleDarkMode: () => void;
  setSqlFormatOptions: (options: { keywordCase: 'upper' | 'lower' }) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      connections: [],
      tabs: [],
      activeTabId: null,
      savedQueries: [],
      darkMode: false,
      sqlFormatOptions: { keywordCase: 'upper' },

      addConnection: (conn) => set((state) => ({ connections: [...state.connections, conn] })),
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
      
      setActiveTab: (id) => set({ activeTabId: id }),

      saveQuery: (query) => set((state) => {
        // If query with same ID exists, update it
        const existing = state.savedQueries.find(q => q.id === query.id);
        if (existing) {
             return { savedQueries: state.savedQueries.map(q => q.id === query.id ? query : q) };
        }
        return { savedQueries: [...state.savedQueries, query] };
      }),

      deleteQuery: (id) => set((state) => ({ savedQueries: state.savedQueries.filter(q => q.id !== id) })),

      toggleDarkMode: () => set((state) => ({ darkMode: !state.darkMode })),
      setSqlFormatOptions: (options) => set({ sqlFormatOptions: options }),
    }),
    {
      name: 'lite-db-storage', // name of the item in the storage (must be unique)
      partialize: (state) => ({ connections: state.connections, savedQueries: state.savedQueries, darkMode: state.darkMode, sqlFormatOptions: state.sqlFormatOptions }), // Persist darkMode too
    }
  )
);