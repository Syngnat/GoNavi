export type GonaviMonacoTypography = 'code' | 'data' | 'sql';

/** Unified host class for all GoNavi Monaco instances (theme bg via --gn-monaco-bg). */
export const GONAVI_MONACO_SURFACE_CLASS = 'gn-monaco-surface';
/** CSS variable used by .gn-monaco-surface; defaults to --gn-bg-panel in theme sheets. */
export const GONAVI_MONACO_BG_CSS_VAR = '--gn-monaco-bg';

export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 20;
export const PRINTABLE_INPUT_FALLBACK_DELAY_MS = 80;
export const SHORTCUT_INPUT_GUARD_WINDOW_MS = 250;
export const NON_PRINTABLE_INPUT_PATTERN = /[\u0000-\u001f\u007f]/;
