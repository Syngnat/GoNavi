import { normalizeLanguage } from '../i18n/resolveLanguage';
import type { SupportedLanguage } from '../i18n/types';
import { sanitizeHostAppearance, type PluginHostAppearance } from './hostAppearance';

export type PluginHostPalette = Partial<Record<'bg' | 'panel' | 'input' | 'code' | 'text' | 'muted' | 'border' | 'border1' | 'accent' | 'accentSoft' | 'ok' | 'warn' | 'warnBg' | 'chip' | 'hover', string>>;
export interface PluginHostPreferences { locale: SupportedLanguage; theme: 'light' | 'dark'; palette?: PluginHostPalette; appearance?: PluginHostAppearance }

export function sanitizeHostPalette(value: unknown): PluginHostPalette | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof document === 'undefined') return undefined;
  const palette: PluginHostPalette = {};
  const style = document.createElement('span').style;
  const keys = ['bg', 'panel', 'input', 'code', 'text', 'muted', 'border', 'border1', 'accent', 'accentSoft', 'ok', 'warn', 'warnBg', 'chip', 'hover'] as const;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const color = (value as Record<string, unknown>)[key];
    if (typeof color !== 'string' || color.length > 128) continue;
    const trimmed = color.trim();
    if (!trimmed || /[\\;<>\x00-\x1f\x7f]|(?:url|var|expression)\s*\(/i.test(trimmed)) continue;
    if (!/^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|hwb|color|lab|lch|oklab|oklch)\([\w\s.,%+\/-]+\))$/i.test(trimmed)) continue;
    if (/^color\(/i.test(trimmed) && !/^color\(\s*(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)\s/i.test(trimmed)) continue;
    style.color = '';
    style.color = trimmed;
    if (style.color && style.color.length <= 128) palette[key] = style.color;
  }
  return Object.keys(palette).length ? palette : undefined;
}

export const pluginHostPreferences = (locale: unknown, theme: unknown, colors?: unknown, metrics?: unknown): PluginHostPreferences => {
  const palette = sanitizeHostPalette(colors);
  const appearance = sanitizeHostAppearance(metrics);
  return { locale: normalizeLanguage(locale) ?? 'en-US', theme: theme === 'dark' ? 'dark' : 'light', ...(palette ? { palette } : {}), ...(appearance ? { appearance } : {}) };
};

export const serializeHostPreferences = (preferences: PluginHostPreferences): string =>
  JSON.stringify(pluginHostPreferences(preferences.locale, preferences.theme, preferences.palette, preferences.appearance))
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
