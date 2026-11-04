import { create } from 'zustand';

/** One declared page docked to the right-hand workbench surface. */
export interface PluginViewEntry {
  key: string;
  pluginID: string;
  viewID: string;
  pageID: string;
  title: string;
  launch?: unknown;
}

interface PluginViewState {
  views: PluginViewEntry[];
  activeKey: string | null;
  open: (entry: PluginViewEntry) => void;
  close: (key: string) => void;
  activate: (key: string) => void;
  removePlugin: (pluginID: string) => void;
  closeAll: () => void;
}

/** Dock state lives outside the tab store: views are not workbench tabs. */
export const usePluginViewStore = create<PluginViewState>((set) => ({
  views: [],
  activeKey: null,
  open: (entry) => set((state) => ({
    views: state.views.some((view) => view.key === entry.key)
      ? state.views.map((view) => (view.key === entry.key ? entry : view))
      : [...state.views, entry],
    activeKey: entry.key,
  })),
  close: (key) => set((state) => {
    const index = state.views.findIndex((view) => view.key === key);
    const views = state.views.filter((view) => view.key !== key);
    const activeKey = state.activeKey !== key
      ? state.activeKey
      : (views[Math.min(index, views.length - 1)]?.key ?? null);
    return { views, activeKey };
  }),
  activate: (key) => set({ activeKey: key }),
  removePlugin: (pluginID) => set((state) => {
    const views = state.views.filter((view) => view.pluginID !== pluginID);
    return {
      views,
      activeKey: views.some((view) => view.key === state.activeKey) ? state.activeKey : (views[0]?.key ?? null),
    };
  }),
  closeAll: () => set({ views: [], activeKey: null }),
}));

export function openPluginView(entry: PluginViewEntry): void {
  usePluginViewStore.getState().open(entry);
}
