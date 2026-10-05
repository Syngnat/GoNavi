import type { InstalledFontFamily } from '../utils/fontFamilies';

export const MIN_UI_SCALE = 0.8;
export const MAX_UI_SCALE = 1.25;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 20;

/** 设置页 Slider 底部预设刻度 */
export const UI_SCALE_SLIDER_MARKS: Record<number, string> = {
  0.8: '80%',
  0.9: '90%',
  1: '100%',
  1.1: '110%',
  1.25: '125%',
};
export const FONT_SIZE_SLIDER_MARKS: Record<number, string> = {
  12: '12',
  14: '14',
  16: '16',
  18: '18',
  20: '20',
};
export const SIDEBAR_RAIL_SCALE_SLIDER_MARKS: Record<number, string> = {
  1: '100%',
  1.25: '125%',
  1.5: '150%',
  1.8: '180%',
};
export const TAB_ENVIRONMENT_ACCENT_THICKNESS_SLIDER_MARKS: Record<number, string> = {
  1: '1',
  2: '2',
  4: '4',
  6: '6',
};
export const OPACITY_SLIDER_MARKS: Record<number, string> = {
  0.1: '10%',
  0.5: '50%',
  1: '100%',
};
export const BLUR_SLIDER_MARKS: Record<number, string> = {
  0: '0',
  6: '6',
  12: '12',
  20: '20',
};
export const DATA_TABLE_FONT_SLIDER_MARKS: Record<number, string> = {
  10: '10',
  12: '12',
  14: '14',
  16: '16',
  18: '18',
};
export const SQL_EDITOR_FONT_SLIDER_MARKS: Record<number, string> = {
  ...DATA_TABLE_FONT_SLIDER_MARKS,
  20: '20',
};
export const DEFAULT_UI_SCALE = 1.0;
export const DEFAULT_FONT_SIZE = 14;
export const EMPTY_INSTALLED_FONT_FAMILIES: InstalledFontFamily[] = [];
