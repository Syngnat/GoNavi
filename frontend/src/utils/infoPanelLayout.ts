/** 侧栏底部「对象 / 信息」面板（Navicat 格局）的高度契约：默认 194px，夹在 120–420 之间。 */
export const DEFAULT_SIDE_INFO_PANEL_HEIGHT = 194;
export const MIN_SIDE_INFO_PANEL_HEIGHT = 120;
export const MAX_SIDE_INFO_PANEL_HEIGHT = 420;

export const sanitizeSideInfoPanelHeight = (value: unknown): number => {
  const height = Number(value);
  if (!Number.isFinite(height) || height <= 0) {
    return DEFAULT_SIDE_INFO_PANEL_HEIGHT;
  }
  return Math.min(MAX_SIDE_INFO_PANEL_HEIGHT, Math.max(MIN_SIDE_INFO_PANEL_HEIGHT, Math.round(height)));
};

export type SideInfoPanelTab = 'objects' | 'info';

export const sanitizeSideInfoPanelTab = (value: unknown): SideInfoPanelTab => (
  value === 'objects' ? 'objects' : 'info'
);
