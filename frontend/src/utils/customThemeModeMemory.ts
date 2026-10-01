import type { CustomThemeDefinition } from './customTheme';
import { resolveAvailableCustomTheme } from './customThemePresets';

/**
 * 亮 / 暗模式各自记住上次应用的主题（内置 GoNavi 主题或用户 CSS 主题）。
 *
 * 一键切换明暗时按目标模式恢复对应主题；主题的 baseMode 必须与记忆的模式一致，
 * baseMode 为 system 的用户主题不参与记忆（它不属于任何一个固定模式）。
 */
export type RememberedThemeMode = 'light' | 'dark';

export type RememberedCustomThemeIds = Record<RememberedThemeMode, string | null>;

export const EMPTY_REMEMBERED_CUSTOM_THEME_IDS: RememberedCustomThemeIds = { light: null, dark: null };

const REMEMBERED_THEME_MODES: readonly RememberedThemeMode[] = ['light', 'dark'];

const isRememberedThemeMode = (mode: unknown): mode is RememberedThemeMode => (
  mode === 'light' || mode === 'dark'
);

/** 清洗持久化 / 变更后的记忆：主题已不存在或 baseMode 已改变的条目一律丢弃。 */
export const sanitizeRememberedCustomThemeIds = (
  value: unknown,
  themes: CustomThemeDefinition[],
): RememberedCustomThemeIds => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const next = { ...EMPTY_REMEMBERED_CUSTOM_THEME_IDS };
  for (const mode of REMEMBERED_THEME_MODES) {
    const theme = resolveAvailableCustomTheme(themes, raw[mode]);
    next[mode] = theme?.baseMode === mode ? theme.id : null;
  }
  return next;
};

/** 选中主题时按其 baseMode 记下；system 主题或取消选中不改变记忆。 */
export const rememberCustomThemeForMode = (
  remembered: RememberedCustomThemeIds,
  theme: CustomThemeDefinition | null,
): RememberedCustomThemeIds => (
  theme && isRememberedThemeMode(theme.baseMode)
    ? { ...remembered, [theme.baseMode]: theme.id }
    : remembered
);

/** 用户主动退回基础主题时，忘掉指向该主题的记忆，避免下次切换又被套回来。 */
export const forgetCustomTheme = (
  remembered: RememberedCustomThemeIds,
  themeId: string | null,
): RememberedCustomThemeIds => {
  if (!themeId) return remembered;
  const next = { ...remembered };
  for (const mode of REMEMBERED_THEME_MODES) {
    if (next[mode] === themeId) next[mode] = null;
  }
  return next;
};

/** 切换到某个偏好模式时应当激活的主题：亮 / 暗取记忆，跟随系统回到基础主题。 */
export const resolveRememberedCustomThemeId = (
  remembered: RememberedCustomThemeIds,
  mode: RememberedThemeMode | 'system',
): string | null => (isRememberedThemeMode(mode) ? remembered[mode] : null);
