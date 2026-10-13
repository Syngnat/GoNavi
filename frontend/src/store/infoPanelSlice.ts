import {
  sanitizeSideInfoPanelHeight,
  sanitizeSideInfoPanelTab,
} from "../utils/infoPanelLayout";
import type { AppState } from "./storeStateTypes";
import type { StoreGet, StoreSet } from "./storeSliceTypes";

export type InfoPanelSliceState = Pick<AppState,
  | 'setInfoPanelVisible'
  | 'toggleInfoPanel'
  | 'setSideInfoPanelHeight'
  | 'setSideInfoPanelActiveTab'
>;

/** 侧栏底部「对象 / 信息」面板（Navicat 格局）。状态默认值在 initialStateSlice。 */
export const createInfoPanelSlice = (set: StoreSet, _get: StoreGet): InfoPanelSliceState => ({
  setInfoPanelVisible: (visible) => set({ infoPanelVisible: visible === true }),
  toggleInfoPanel: () => set((state) => ({ infoPanelVisible: !state.infoPanelVisible })),
  setSideInfoPanelHeight: (height) => set({ sideInfoPanelHeight: sanitizeSideInfoPanelHeight(height) }),
  setSideInfoPanelActiveTab: (tab) => set({ sideInfoPanelActiveTab: sanitizeSideInfoPanelTab(tab) }),
});
