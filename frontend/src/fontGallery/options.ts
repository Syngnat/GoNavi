import { MONO_FONT_FALLBACK_STACK, UI_FONT_FALLBACK_STACK, type FontFamilyOption } from '../utils/fontFamilies';
import type { FontInstalled } from './types';
import { getPrimaryFontFamily } from '../utils/fontFamilyDisplay';
import { RECOMMENDED_FONTS } from './recommendedCatalog';

export const fontFamilyKey = (family: string): string => family.trim().replace(/\s+/g, ' ').toLowerCase();

// 目录里为字体维护的中文显示名：选择器显示名与画廊保持一致，
// 存储的 CSS 值仍是系统 family；与原始 family 同名的条目（如 Inter）不进入映射。
const CATALOG_FAMILY_ALIAS = new Map<string, string>();
for (const item of RECOMMENDED_FONTS) {
  const key = fontFamilyKey(item.family);
  const alias = item.names['zh-CN'] || item.names['en-US'] || '';
  if (key && alias && key !== fontFamilyKey(alias)) CATALOG_FAMILY_ALIAS.set(key, alias);
}

const applyCatalogAliases = (options: FontFamilyOption[]): FontFamilyOption[] =>
  options.map(option => {
    // 默认项的 label 是 i18n 文案，任何目录别名都不应覆盖它。
    if (option.labelKey) return option;
    const alias = CATALOG_FAMILY_ALIAS.get(fontFamilyKey(getPrimaryFontFamily(option.value)));
    if (!alias) return option;
    return {
      ...option,
      label: alias,
      keywords: [...(option.keywords ?? []), option.label, alias],
    };
  });

export function cssStack(family: string, kind: 'ui' | 'mono'): string {
  const fallback = kind === 'ui' ? UI_FONT_FALLBACK_STACK : MONO_FONT_FALLBACK_STACK;
  return '"' + family.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '", ' + fallback;
}

export function mergeDownloadedFontOptions(
  base: FontFamilyOption[],
  installed: FontInstalled[],
  kind: 'ui' | 'mono',
  activeValue?: string | null,
): FontFamilyOption[] {
  const result: FontFamilyOption[] = [];
  const positions = new Map<string, number>();
  for (const option of base) {
    const key = option.isDefault ? 'default' : fontFamilyKey(getPrimaryFontFamily(option.value));
    if (positions.has(key)) continue;
    positions.set(key, result.length);
    result.push(option);
  }
  const activeFamily = activeValue ? fontFamilyKey(getPrimaryFontFamily(activeValue)) : '';
  // 已下载字体同时进入两个槽位：kind 匹配的排在前，其余排后。目录里的 kind 只是建议用途，
  // 用户明确要求下载的代码字体也能设为界面字体，跨槽位启用后必须在对应下拉中保持可见。
  const ordered = [
    ...installed.filter(item => item.entry.kind === kind),
    ...installed.filter(item => item.entry.kind !== kind),
  ];
  for (const item of ordered) {
    const key = fontFamilyKey(item.entry.family);
    const position = positions.get(key);
    const active = activeFamily === fontFamilyKey(item.family);
    // 同名字体优先保留本机版本，但不改写用户当前使用的下载字体配置。
    if (position !== undefined && !active) continue;
    const option = {
      value: active && activeValue ? activeValue : cssStack(item.family, kind),
      label: item.entry.names['zh-CN'] || item.entry.names['en-US'] || item.entry.family,
      keywords: ['downloaded', 'installed', item.entry.family.toLowerCase(), item.entry.id],
    };
    if (position !== undefined) result[position] = option;
    else {
      positions.set(key, result.length);
      result.push(option);
    }
  }
  return applyCatalogAliases(result);
}

export function systemHasFamily(families: Array<{ family: string } | string>, name: string): boolean {
  const needle = fontFamilyKey(name);
  return families.some(entry => {
    const family = typeof entry === 'string' ? entry : entry.family;
    return fontFamilyKey(family) === needle;
  });
}
