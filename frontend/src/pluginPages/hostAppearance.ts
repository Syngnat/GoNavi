export interface PluginHostAppearance {
  fontFamily?: string;
  monoFontFamily?: string;
  fontSize?: number;
  monoFontSize?: number;
  radius?: number;
  opacity?: number;
  background?: { enabled: boolean; tint?: number };
}

export function sanitizeHostAppearance(value: unknown): PluginHostAppearance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const appearance: PluginHostAppearance = {};
  for (const key of ['fontFamily', 'monoFontFamily'] as const) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const font = source[key];
    if (typeof font !== 'string' || !font.trim() || font.length > 512
      || /^(?:inherit|initial|unset|revert|revert-layer)$/i.test(font.trim())
      || /[\\;<>@\x00-\x1f\x7f]|(?:url|var|env|expression)\s*\(/i.test(font)
      || !/^(?:\s*(?:"[^"\\]+"|'[^'\\]+'|[-\w ]+)\s*)(?:,\s*(?:"[^"\\]+"|'[^'\\]+'|[-\w ]+)\s*)*$/.test(font)
      || typeof document === 'undefined') continue;
    const style = document.createElement('span').style;
    style.fontFamily = font;
    if (style.fontFamily && style.fontFamily.length <= 512) appearance[key] = style.fontFamily;
  }
  for (const [key, min, max] of [['fontSize', 8, 48], ['monoFontSize', 8, 48], ['radius', 0, 32], ['opacity', .1, 1]] as const) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const number = source[key];
    if (typeof number === 'number' && Number.isFinite(number) && number >= min && number <= max) appearance[key] = number;
  }
  const background = Object.prototype.hasOwnProperty.call(source, 'background') ? source.background : undefined;
  if (background && typeof background === 'object' && !Array.isArray(background)) {
    const raw = background as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(raw, 'enabled') && typeof raw.enabled === 'boolean') {
      appearance.background = { enabled: raw.enabled };
      if (Object.prototype.hasOwnProperty.call(raw, 'tint') && typeof raw.tint === 'number' && Number.isFinite(raw.tint) && raw.tint >= .7 && raw.tint <= .95) appearance.background.tint = raw.tint;
    }
  }
  return Object.keys(appearance).length ? appearance : undefined;
}

export function readHostAppearance(): PluginHostAppearance | undefined {
  if (typeof document === 'undefined' || !document.body || !document.defaultView) return undefined;
  const view = document.defaultView;
  const body = view.getComputedStyle(document.body);
  const html = view.getComputedStyle(document.documentElement);
  const property = (key: string) => body.getPropertyValue(key).trim() || html.getPropertyValue(key).trim();
  const pixels = (raw: string) => /^\d+(?:\.\d+)?px$/.test(raw.trim()) ? Number.parseFloat(raw) : undefined;
  const opacity = html.getPropertyValue('--gn-window-opacity').trim();
  const input = document.querySelector('.ant-input, .ant-input-affix-wrapper, .ant-select-selector');
  const root = document.querySelector<HTMLElement>('.gn-v2-app-root');
  const tint = root ? view.getComputedStyle(root).getPropertyValue('--gn-background-tint').trim() : '';
  return sanitizeHostAppearance({
    fontFamily: body.fontFamily || property('--gn-font-sans'),
    monoFontFamily: property('--gn-font-mono'),
    fontSize: pixels(body.fontSize) ?? pixels(property('--gn-font-size')),
    monoFontSize: pixels(property('--gn-font-size-mono')),
    radius: input ? pixels(view.getComputedStyle(input).borderTopLeftRadius || view.getComputedStyle(input).borderRadius) : undefined,
    opacity: /^(?:\d+\.?\d*|\.\d+)$/.test(opacity) ? Number(opacity) : undefined,
    background: root ? { enabled: root.dataset.backgroundImage === 'true', tint: /^\d+(?:\.\d+)?%$/.test(tint) ? Number.parseFloat(tint) / 100 : undefined } : undefined,
  });
}
