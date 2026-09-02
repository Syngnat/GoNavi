export const TOOLBAR_BUTTON_COLOR_TARGETS = ['query', 'result'] as const;
export type ToolbarButtonColorTarget = (typeof TOOLBAR_BUTTON_COLOR_TARGETS)[number];
export type ToolbarButtonColorScope = ToolbarButtonColorTarget | 'all';

export const TOOLBAR_BUTTON_KINDS = ['button', 'primary'] as const;
export type ToolbarButtonKind = (typeof TOOLBAR_BUTTON_KINDS)[number];
export const TOOLBAR_BUTTON_STATES = ['default', 'hover', 'active', 'disabled'] as const;
export type ToolbarButtonState = (typeof TOOLBAR_BUTTON_STATES)[number];
export const TOOLBAR_BUTTON_COLOR_CHANNELS = ['fg', 'bg', 'border'] as const;
export type ToolbarButtonColorChannel = (typeof TOOLBAR_BUTTON_COLOR_CHANNELS)[number];

export const TOOLBAR_BUTTON_COLOR_TOKENS = [
  'button-fg',
  'button-bg',
  'button-border',
  'button-hover-fg',
  'button-hover-bg',
  'button-hover-border',
  'button-active-fg',
  'button-active-bg',
  'button-active-border',
  'button-disabled-fg',
  'button-disabled-bg',
  'button-disabled-border',
  'primary-fg',
  'primary-bg',
  'primary-border',
  'primary-hover-fg',
  'primary-hover-bg',
  'primary-hover-border',
  'primary-active-fg',
  'primary-active-bg',
  'primary-active-border',
  'primary-disabled-fg',
  'primary-disabled-bg',
  'primary-disabled-border',
] as const;

export type ToolbarButtonColorToken = (typeof TOOLBAR_BUTTON_COLOR_TOKENS)[number];
export type ToolbarButtonColorTargetOverrides = Partial<Record<ToolbarButtonColorToken, string>>;
export type ToolbarButtonColorOverrides = Partial<
  Record<ToolbarButtonColorTarget, ToolbarButtonColorTargetOverrides>
>;

export const DEFAULT_TOOLBAR_BUTTON_COLOR_OVERRIDES: ToolbarButtonColorOverrides = {};

export const getToolbarButtonColorToken = (
  kind: ToolbarButtonKind,
  state: ToolbarButtonState,
  channel: ToolbarButtonColorChannel,
): ToolbarButtonColorToken => (
  `${kind}${state === 'default' ? '' : `-${state}`}-${channel}` as ToolbarButtonColorToken
);

const TOOLBAR_BUTTON_COLOR_TOKEN_SET = new Set<string>(TOOLBAR_BUTTON_COLOR_TOKENS);
const CSS_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CSS_COLOR_FUNCTION = /^(rgb|rgba|hsl|hsla)\((.*)\)$/i;
const CSS_NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const CSS_PERCENTAGE = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))%$/;
const CSS_HUE = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))(?:deg|grad|rad|turn)?$/i;
const MAX_CSS_COLOR_LENGTH = 96;

const parseFiniteNumber = (value: string): number | null => {
  if (!CSS_NUMBER.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parsePercentage = (value: string): number | null => {
  const match = CSS_PERCENTAGE.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
};

const parseAlpha = (value: string): number | null => {
  const percentage = parsePercentage(value);
  if (percentage !== null) return percentage / 100;
  const parsed = parseFiniteNumber(value);
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
};

const isRgbChannel = (value: string): boolean => {
  const percentage = parsePercentage(value);
  if (percentage !== null) return true;
  const parsed = parseFiniteNumber(value);
  return parsed !== null && parsed >= 0 && parsed <= 255;
};

const isHue = (value: string): boolean => {
  const match = CSS_HUE.exec(value);
  return !!match && Number.isFinite(Number(match[1]));
};

const splitFunctionalColorBody = (
  body: string,
): { components: string[]; alpha: string | null; commaSyntax: boolean } | null => {
  if (!body || /[();{}]/.test(body)) return null;
  if (body.includes(',')) {
    if (body.includes('/')) return null;
    const components = body.split(',').map((part) => part.trim());
    if (
      components.some((part) => !part)
      || (components.length !== 3 && components.length !== 4)
    ) return null;
    return {
      components: components.slice(0, 3),
      alpha: components.length === 4 ? components[3] : null,
      commaSyntax: true,
    };
  }
  const slashParts = body.split('/').map((part) => part.trim());
  if (slashParts.length > 2 || slashParts.some((part) => !part)) return null;
  const components = slashParts[0].split(/\s+/).filter(Boolean);
  return {
    components,
    alpha: slashParts.length === 2 ? slashParts[1] : null,
    commaSyntax: false,
  };
};

const isStrictFunctionalColor = (candidate: string): boolean => {
  const match = CSS_COLOR_FUNCTION.exec(candidate);
  if (!match) return false;
  const functionName = match[1].toLowerCase();
  const parsed = splitFunctionalColorBody(match[2].trim());
  if (!parsed || parsed.components.length !== 3) return false;

  const requiresAlpha = functionName === 'rgba' || functionName === 'hsla';
  if (parsed.commaSyntax && requiresAlpha !== (parsed.alpha !== null)) return false;
  if (parsed.alpha !== null && parseAlpha(parsed.alpha) === null) return false;

  if (functionName === 'rgb' || functionName === 'rgba') {
    return parsed.components.every(isRgbChannel);
  }
  return isHue(parsed.components[0])
    && parsePercentage(parsed.components[1]) !== null
    && parsePercentage(parsed.components[2]) !== null;
};

/**
 * Accept only concrete CSS colors produced by the client picker. Theme
 * references and arbitrary CSS functions belong in a custom theme instead.
 */
export const sanitizeToolbarButtonCssColor = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_CSS_COLOR_LENGTH) return null;
  if (CSS_HEX_COLOR.test(candidate)) return candidate.toLowerCase();
  if (!isStrictFunctionalColor(candidate)) return null;
  const cssApi = typeof globalThis.CSS === 'undefined' ? null : globalThis.CSS;
  if (cssApi && typeof cssApi.supports === 'function' && !cssApi.supports('color', candidate)) {
    return null;
  }
  return candidate;
};

export const sanitizeToolbarButtonColorOverrides = (
  value: unknown,
): ToolbarButtonColorOverrides => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const result: ToolbarButtonColorOverrides = {};
  for (const target of TOOLBAR_BUTTON_COLOR_TARGETS) {
    const rawTarget = raw[target];
    if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) continue;
    const safeTarget: ToolbarButtonColorTargetOverrides = {};
    for (const [token, rawColor] of Object.entries(rawTarget as Record<string, unknown>)) {
      if (!TOOLBAR_BUTTON_COLOR_TOKEN_SET.has(token)) continue;
      const color = sanitizeToolbarButtonCssColor(rawColor);
      if (color) safeTarget[token as ToolbarButtonColorToken] = color;
    }
    if (Object.keys(safeTarget).length > 0) result[target] = safeTarget;
  }
  return result;
};

const targetsForScope = (scope: ToolbarButtonColorScope): readonly ToolbarButtonColorTarget[] => (
  scope === 'all' ? TOOLBAR_BUTTON_COLOR_TARGETS : [scope]
);

/** Apply one client selection; `all` deliberately fans out to both scoped vars. */
export const applyToolbarButtonColorOverride = (
  current: unknown,
  scope: ToolbarButtonColorScope,
  token: ToolbarButtonColorToken,
  value: unknown,
): ToolbarButtonColorOverrides => {
  const result = sanitizeToolbarButtonColorOverrides(current);
  const color = sanitizeToolbarButtonCssColor(value);
  for (const target of targetsForScope(scope)) {
    const nextTarget: ToolbarButtonColorTargetOverrides = { ...(result[target] ?? {}) };
    if (color) nextTarget[token] = color;
    else delete nextTarget[token];
    if (Object.keys(nextTarget).length > 0) result[target] = nextTarget;
    else delete result[target];
  }
  return result;
};

export const clearToolbarButtonColorOverrides = (
  current: unknown,
  scope: ToolbarButtonColorScope,
): ToolbarButtonColorOverrides => {
  const result = sanitizeToolbarButtonColorOverrides(current);
  for (const target of targetsForScope(scope)) delete result[target];
  return result;
};

export const getToolbarButtonCssVariableName = (
  target: ToolbarButtonColorTarget,
  token: ToolbarButtonColorToken,
): `--gn-${ToolbarButtonColorTarget}-toolbar-${ToolbarButtonColorToken}` => (
  `--gn-${target}-toolbar-${token}`
);

export const getToolbarButtonClientCssVariableName = (
  target: ToolbarButtonColorTarget,
  token: ToolbarButtonColorToken,
): `--gn-client-${ToolbarButtonColorTarget}-toolbar-${ToolbarButtonColorToken}` => (
  `--gn-client-${target}-toolbar-${token}`
);

export const TOOLBAR_BUTTON_CLIENT_COLOR_CSS_VARIABLES = TOOLBAR_BUTTON_COLOR_TARGETS.flatMap(
  (target) => TOOLBAR_BUTTON_COLOR_TOKENS.map(
    (token) => getToolbarButtonClientCssVariableName(target, token),
  ),
);

export const buildToolbarButtonClientCssVariableOverrides = (
  value: unknown,
): Record<string, string> => {
  const overrides = sanitizeToolbarButtonColorOverrides(value);
  const result: Record<string, string> = {};
  for (const target of TOOLBAR_BUTTON_COLOR_TARGETS) {
    const targetOverrides = overrides[target];
    if (!targetOverrides) continue;
    for (const token of TOOLBAR_BUTTON_COLOR_TOKENS) {
      const color = targetOverrides[token];
      if (color) result[getToolbarButtonClientCssVariableName(target, token)] = color;
    }
  }
  return result;
};
