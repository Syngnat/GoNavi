export const CUSTOM_THEME_SCHEMA_VERSION = 1;
export const CUSTOM_THEME_MAX_COUNT = 12;
export const CUSTOM_THEME_MAX_BYTES = 256 * 1024;
export const CUSTOM_THEME_MAX_TOTAL_BYTES = 1024 * 1024;
export const CUSTOM_THEME_STYLE_ID = 'gonavi-custom-theme-style';

export type CustomThemeBaseMode = 'system' | 'light' | 'dark';

export interface CustomThemeDefinition {
  schemaVersion: typeof CUSTOM_THEME_SCHEMA_VERSION;
  id: string;
  name: string;
  sourceFileName: string;
  baseMode: CustomThemeBaseMode;
  css: string;
  createdAt: number;
  updatedAt: number;
}

export type CustomThemeValidationReason =
  | 'empty'
  | 'too-large'
  | 'invalid-syntax'
  | 'unsafe-import'
  | 'unsafe-url'
  | 'unsafe-font-face'
  | 'unsafe-legacy-script';

export type CustomThemeValidationResult =
  | { ok: true; css: string; byteLength: number }
  | { ok: false; reason: CustomThemeValidationReason; byteLength: number };

export type CustomThemeAntTokens = Partial<{
  primary: string;
  primaryContrast: string;
  primaryHover: string;
  primaryActive: string;
  primaryBg: string;
  primaryBgHover: string;
  primaryBorder: string;
  primaryBorderHover: string;
  controlActiveBg: string;
  controlActiveHoverBg: string;
  controlOutline: string;
  bgContainer: string;
  bgElevated: string;
  fillAlter: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
  rowHoverBg: string;
  info: string;
  infoContrast: string;
  dangerContrast: string;
}>;

const textEncoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder();

export const getCustomThemeByteLength = (value: string): number => {
  if (textEncoder) return textEncoder.encode(value).byteLength;
  return unescape(encodeURIComponent(value)).length;
};

const stripCssComments = (value: string): string => {
  let result = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];
    if (quote) {
      result += current;
      if (current === '\\' && next !== undefined) {
        result += next;
        index += 1;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === '\\' && next !== undefined) {
      result += current + next;
      index += 1;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      result += current;
      continue;
    }
    if (current === '/' && next === '*') {
      const end = value.indexOf('*/', index + 2);
      if (end < 0) return result;
      index = end + 1;
      continue;
    }
    result += current;
  }
  return result;
};

const decodeCssEscapes = (value: string): string => value
  .replace(/\\\r?\n/g, '')
  .replace(/\\([0-9a-f]{1,6})(?:\s)?/gi, (_match, codePoint: string) => {
    const valueNumber = Number.parseInt(codePoint, 16);
    if (!Number.isFinite(valueNumber) || valueNumber <= 0 || valueNumber > 0x10ffff) return '';
    return String.fromCodePoint(valueNumber);
  })
  .replace(/\\(.)/gs, '$1');

const hasBalancedCssBlocks = (value: string): boolean => {
  const stack: string[] = [];
  let sawBlock = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];
    if (!quote && current === '/' && next === '*') {
      const end = value.indexOf('*/', index + 2);
      if (end < 0) return false;
      index = end + 1;
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === '\\') {
      index += 1;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      continue;
    }
    if (current === '{' || current === '(' || current === '[') {
      if (current === '{') sawBlock = true;
      stack.push(current);
    } else if (current === '}' || current === ')' || current === ']') {
      const expected = current === '}' ? '{' : current === ')' ? '(' : '[';
      if (stack.pop() !== expected) return false;
    }
  }
  return sawBlock && stack.length === 0 && quote === null;
};

export const validateCustomThemeCss = (value: unknown): CustomThemeValidationResult => {
  const css = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
  const byteLength = getCustomThemeByteLength(css);
  if (!css) return { ok: false, reason: 'empty', byteLength };
  if (byteLength > CUSTOM_THEME_MAX_BYTES) {
    return { ok: false, reason: 'too-large', byteLength };
  }
  if (css.includes('\0') || !hasBalancedCssBlocks(css)) {
    return { ok: false, reason: 'invalid-syntax', byteLength };
  }

  // Decode CSS escapes before scanning so constructs such as @\69mport and
  // u\72l(...) cannot bypass the external-resource boundary.
  const scanText = decodeCssEscapes(stripCssComments(css)).toLowerCase().replace(/\\/g, '/');
  if (/@\s*import\b/.test(scanText)) {
    return { ok: false, reason: 'unsafe-import', byteLength };
  }
  if (
    /\burl\s*\(/.test(scanText)
    || /(?:^|[^a-z0-9_-])(?:-webkit-)?(?:image-set|image|cross-fade|src)\s*\(/.test(scanText)
    || /\b(?:https?|ftp|file|data|blob)\s*:/.test(scanText)
    || /(?:^|[\s('"=])\/\/[a-z0-9]/i.test(scanText)
  ) {
    return { ok: false, reason: 'unsafe-url', byteLength };
  }
  if (/@\s*font-face\b/.test(scanText)) {
    return { ok: false, reason: 'unsafe-font-face', byteLength };
  }
  if (
    /\bexpression\s*\(/.test(scanText)
    || /(?:^|[;{])\s*behavior\s*:/.test(scanText)
    || /-moz-binding\s*:/.test(scanText)
    || /(?:java|vb)script\s*:/.test(scanText)
    || /<\s*\/\s*style\b/.test(scanText)
  ) {
    return { ok: false, reason: 'unsafe-legacy-script', byteLength };
  }
  return { ok: true, css, byteLength };
};

export const sanitizeCustomThemeName = (value: unknown, fallback = 'Custom theme'): string => {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  return (name || fallback).slice(0, 80);
};

export const sanitizeCustomThemeFileName = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const fileName = value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim() || '';
  return fileName.slice(0, 160);
};

export const deriveCustomThemeName = (fileName: string): string => {
  const safeFileName = sanitizeCustomThemeFileName(fileName);
  return sanitizeCustomThemeName(safeFileName.replace(/\.css$/i, ''), 'Custom theme');
};

export const sanitizeCustomThemeBaseMode = (value: unknown): CustomThemeBaseMode => {
  if (value === 'light' || value === 'dark') return value;
  return 'system';
};

export const createCustomThemeId = (): string => {
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `theme-${randomId.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`.slice(0, 80);
};

/**
 * Ensure Monaco surface token exists for hand-written custom themes.
 * Presets already define it; hand-written CSS still needs the shared theme surface default.
 * If the theme already declares --gn-monaco-bg, leave it alone (user override wins).
 */
export const ensureCustomThemeMonacoSurfaceVars = (css: string): string => {
  const source = String(css || '');
  if (/--gn-monaco-bg\s*:/.test(source)) return source;
  const surfaceVar = /--gn-bg-panel-2\s*:/.test(source) ? '--gn-bg-panel-2' : '--gn-bg-panel';
  const trimmed = source.trimEnd();
  const appendix = [
    '',
    `/* GoNavi: Monaco surface follows ${surfaceVar} unless the theme overrides --gn-monaco-bg */`,
    'body[data-custom-theme],',
    'body[data-custom-theme][data-ui-version="v2"] {',
    `  --gn-monaco-bg: var(${surfaceVar});`,
    '}',
    '',
  ].join('\n');
  return trimmed ? `${trimmed}\n${appendix}` : appendix.trimStart();
};

export const sanitizeCustomThemeDefinition = (value: unknown): CustomThemeDefinition | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== CUSTOM_THEME_SCHEMA_VERSION) return null;
  const id = typeof raw.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(raw.id)
    ? raw.id
    : '';
  if (!id) return null;
  const validation = validateCustomThemeCss(raw.css);
  if (!validation.ok) return null;
  const now = Date.now();
  const createdAt = Number.isFinite(Number(raw.createdAt)) && Number(raw.createdAt) > 0
    ? Number(raw.createdAt)
    : now;
  const updatedAt = Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0
    ? Number(raw.updatedAt)
    : createdAt;
  const sourceFileName = sanitizeCustomThemeFileName(raw.sourceFileName);
  return {
    schemaVersion: CUSTOM_THEME_SCHEMA_VERSION,
    id,
    name: sanitizeCustomThemeName(raw.name, deriveCustomThemeName(sourceFileName)),
    sourceFileName,
    baseMode: sanitizeCustomThemeBaseMode(raw.baseMode),
    css: ensureCustomThemeMonacoSurfaceVars(validation.css),
    createdAt,
    updatedAt,
  };
};

export const sanitizeCustomThemeList = (value: unknown): CustomThemeDefinition[] => {
  if (!Array.isArray(value)) return [];
  const themes: CustomThemeDefinition[] = [];
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const item of value) {
    if (themes.length >= CUSTOM_THEME_MAX_COUNT) break;
    const theme = sanitizeCustomThemeDefinition(item);
    if (!theme || ids.has(theme.id)) continue;
    const nextBytes = getCustomThemeByteLength(theme.css);
    if (totalBytes + nextBytes > CUSTOM_THEME_MAX_TOTAL_BYTES) continue;
    ids.add(theme.id);
    totalBytes += nextBytes;
    themes.push(theme);
  }
  return themes;
};

export const resolveActiveCustomTheme = (
  themes: CustomThemeDefinition[],
  activeThemeId: unknown,
): CustomThemeDefinition | null => {
  if (typeof activeThemeId !== 'string' || !activeThemeId) return null;
  return themes.find((theme) => theme.id === activeThemeId) ?? null;
};

const CSS_COLOR_VALUE = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([^;{}]+\)|hsla?\([^;{}]+\))$/i;
const CSS_COLOR_COMPONENT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:%|deg|grad|rad|turn)?$/i;

const isSyntacticallyValidFunctionalColor = (candidate: string): boolean => {
  const body = candidate.slice(candidate.indexOf('(') + 1, -1).trim();
  if (!body || !/^[\d\s.,%+\-/a-z]*$/i.test(body)) return false;
  if (body.includes(',')) {
    const components = body.split(',').map((part) => part.trim());
    return (components.length === 3 || components.length === 4)
      && components.every((part) => CSS_COLOR_COMPONENT.test(part));
  }
  const slashParts = body.split('/').map((part) => part.trim());
  if (slashParts.length > 2 || (slashParts.length === 2 && !CSS_COLOR_COMPONENT.test(slashParts[1]))) {
    return false;
  }
  const components = slashParts[0].split(/\s+/).filter(Boolean);
  return components.length === 3 && components.every((part) => CSS_COLOR_COMPONENT.test(part));
};

const normalizeCustomThemeColor = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  if (!candidate || !CSS_COLOR_VALUE.test(candidate)) return undefined;
  const cssApi = typeof globalThis.CSS === 'undefined' ? null : globalThis.CSS;
  if (cssApi && typeof cssApi.supports === 'function' && !cssApi.supports('color', candidate)) {
    return undefined;
  }
  if (/^(?:rgb|hsl)a?\(/i.test(candidate)) {
    if (!isSyntacticallyValidFunctionalColor(candidate)) return undefined;
  }
  return candidate;
};

const readCustomProperty = (css: string, property: string): string | undefined => {
  const source = stripCssComments(css);
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`(?:^|[;{])\\s*${escapedProperty}\\s*:\\s*([^;}]+)`, 'gi');
  let value: string | undefined;
  for (const match of source.matchAll(matcher)) {
    const candidate = match[1]?.trim();
    const color = normalizeCustomThemeColor(candidate);
    if (color) value = color;
  }
  return value;
};

const extractCustomThemeAntTokensWith = (
  readProperty: (property: string) => string | undefined,
): CustomThemeAntTokens => {
  const accent = normalizeCustomThemeColor(readProperty('--gn-accent'));
  const onAccent = normalizeCustomThemeColor(readProperty('--gn-on-accent'));
  const accent2 = normalizeCustomThemeColor(readProperty('--gn-accent-2'));
  const accentSoft = normalizeCustomThemeColor(readProperty('--gn-accent-soft'));
  const read = (property: string, fallback?: string) => (
    normalizeCustomThemeColor(readProperty(property)) ?? fallback
  );
  return {
    primary: read('--gn-ant-primary', accent),
    primaryContrast: read('--gn-ant-on-primary', onAccent),
    primaryHover: read('--gn-ant-primary-hover', accent2 ?? accent),
    primaryActive: read('--gn-ant-primary-active', accent2 ?? accent),
    primaryBg: read('--gn-ant-primary-bg', accentSoft),
    primaryBgHover: read('--gn-ant-primary-bg-hover', accentSoft),
    primaryBorder: read('--gn-ant-primary-border', accent),
    primaryBorderHover: read('--gn-ant-primary-border-hover', accent2 ?? accent),
    controlActiveBg: read('--gn-ant-control-active-bg', accentSoft),
    controlActiveHoverBg: read('--gn-ant-control-active-hover-bg', accentSoft),
    controlOutline: read('--gn-ant-control-outline', accent),
    bgContainer: read('--gn-bg-panel'),
    bgElevated: read('--gn-bg-panel'),
    fillAlter: read('--gn-bg-panel-2'),
    textPrimary: read('--gn-fg-1'),
    textSecondary: read('--gn-fg-3'),
    border: read('--gn-br-2'),
    rowHoverBg: read('--gn-bg-hover'),
    info: read('--gn-info'),
    infoContrast: read('--gn-on-info'),
    dangerContrast: read('--gn-on-danger'),
  };
};

export const extractCustomThemeAntTokens = (css: string): CustomThemeAntTokens => (
  extractCustomThemeAntTokensWith((property) => readCustomProperty(css, property))
);

export const extractComputedCustomThemeAntTokens = (
  computedStyle: Pick<CSSStyleDeclaration, 'getPropertyValue'> | null,
): CustomThemeAntTokens => {
  if (!computedStyle) return {};
  return extractCustomThemeAntTokensWith((property) => computedStyle.getPropertyValue(property));
};

export const CUSTOM_THEME_TEMPLATE = `/*
 * GoNavi custom theme template
 * Choose the light/dark/system base mode in Theme Settings.
 * External @import, url() and @font-face resources are intentionally blocked.
 */
body[data-custom-theme][data-ui-version="v2"] {
  --gn-bg-app: #11131a;
  --gn-bg-chrome: #171a23;
  --gn-bg-panel: #1d202b;
  --gn-bg-panel-2: #232733;
  --gn-monaco-bg: var(--gn-bg-panel-2);
  --gn-bg-hover: rgba(255, 255, 255, 0.06);
  --gn-bg-active: rgba(255, 255, 255, 0.10);
  --gn-bg-selected: rgba(139, 92, 246, 0.18);
  --gn-bg-input: #141720;

  --gn-fg-1: #f5f3ff;
  --gn-fg-2: #e9e5ff;
  --gn-fg-3: #c4b5fd;
  --gn-fg-4: #a78bfa;
  --gn-fg-5: #7c6aa8;

  --gn-br-1: rgba(196, 181, 253, 0.10);
  --gn-br-2: rgba(196, 181, 253, 0.18);
  --gn-br-3: rgba(196, 181, 253, 0.28);

  --gn-accent: #8b5cf6;
  --gn-accent-2: #7c3aed;
  --gn-accent-soft: rgba(139, 92, 246, 0.18);
  --gn-on-accent: #ffffff;
  --gn-info: #38bdf8;
  --gn-on-info: #08131a;
  --gn-danger: #ef4444;
  --gn-danger-strong: #dc2626;
  --gn-on-danger: #ffffff;

  /* Optional Ant Design token bridge. */
  --gn-ant-primary: #8b5cf6;
  --gn-ant-on-primary: #ffffff;
  --gn-ant-primary-hover: #a78bfa;
  --gn-ant-primary-active: #7c3aed;
  --gn-ant-primary-bg: rgba(139, 92, 246, 0.18);
  --gn-ant-primary-bg-hover: rgba(139, 92, 246, 0.26);
  --gn-ant-primary-border: #8b5cf6;
  --gn-ant-primary-border-hover: #a78bfa;
  --gn-ant-control-active-bg: rgba(139, 92, 246, 0.16);
  --gn-ant-control-active-hover-bg: rgba(139, 92, 246, 0.24);
  --gn-ant-control-outline: rgba(139, 92, 246, 0.38);
}
`;
