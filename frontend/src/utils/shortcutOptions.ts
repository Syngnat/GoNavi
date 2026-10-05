import {
  type ShortcutAction,
  SHORTCUT_ACTION_META,
  type ShortcutPlatform,
  type ShortcutPlatformBinding,
  DEFAULT_SHORTCUT_OPTIONS,
  type ShortcutOptions,
  SHORTCUT_ACTION_ORDER,
} from './shortcutDefinitions';
import {
  normalizeShortcutCombo,
  getShortcutKeyToken,
  getShortcutModifierTokens,
  hasModifierKey,
} from './shortcutKeyboard';

export const canRecordShortcutForAction = (action: ShortcutAction, combo: string): boolean => {
  const normalized = normalizeShortcutCombo(combo);
  if (!normalized || !getShortcutKeyToken(normalized)) {
    return false;
  }

  const meta = SHORTCUT_ACTION_META[action];
  if (meta.requiredKey && getShortcutKeyToken(normalized) !== normalizeShortcutCombo(meta.requiredKey)) {
    return false;
  }
  if (meta.disallowShift && normalized.split('+').includes('Shift')) {
    return false;
  }
  if (meta.allowWithoutModifier) {
    return getShortcutModifierTokens(normalized).length <= 1;
  }
  return hasModifierKey(normalized);
};

const cloneShortcutPlatformBinding = (
  action: ShortcutAction,
  platform: ShortcutPlatform,
  value?: Partial<ShortcutPlatformBinding> | null,
): ShortcutPlatformBinding => {
  const fallback = DEFAULT_SHORTCUT_OPTIONS[action]?.[platform] ?? { combo: '', enabled: false };
  const normalized = normalizeShortcutCombo(value?.combo || fallback.combo);
  return {
    combo: normalized && canRecordShortcutForAction(action, normalized) ? normalized : fallback.combo,
    enabled: value?.enabled === false ? false : fallback.enabled !== false,
  };
};

export const cloneShortcutOptions = (value: ShortcutOptions): ShortcutOptions => {
  return SHORTCUT_ACTION_ORDER.reduce((acc, action) => {
    acc[action] = {
      mac: cloneShortcutPlatformBinding(action, 'mac', value[action]?.mac),
      windows: cloneShortcutPlatformBinding(action, 'windows', value[action]?.windows),
    };
    return acc;
  }, {} as ShortcutOptions);
};

const isLegacyShortcutBinding = (value: Record<string, unknown>): boolean => (
  Object.prototype.hasOwnProperty.call(value, 'combo')
  || Object.prototype.hasOwnProperty.call(value, 'enabled')
);

const sanitizeShortcutPlatformBinding = (
  action: ShortcutAction,
  platform: ShortcutPlatform,
  value: unknown,
  fallback: ShortcutPlatformBinding,
): ShortcutPlatformBinding => {
  if (!value || typeof value !== 'object') {
    return { ...fallback };
  }
  const binding = value as Record<string, unknown>;
  const combo = normalizeShortcutCombo(String(binding.combo || fallback.combo));
  return {
    combo: combo && canRecordShortcutForAction(action, combo) ? combo : fallback.combo,
    enabled: binding.enabled === false ? false : true,
  };
};

export const sanitizeShortcutOptions = (value: unknown): ShortcutOptions => {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const defaults = cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS);
  const hasPersistedCloseActiveTab = Object.prototype.hasOwnProperty.call(raw, 'closeActiveTab');
  const hasPersistedShortcutAction = SHORTCUT_ACTION_ORDER.some((action) => (
    action !== 'closeActiveTab' && Object.prototype.hasOwnProperty.call(raw, action)
  ));

  SHORTCUT_ACTION_ORDER.forEach((action) => {
    const actionRaw = raw[action];
    if (!actionRaw || typeof actionRaw !== 'object') {
      return;
    }
    const binding = actionRaw as Record<string, unknown>;
    if (isLegacyShortcutBinding(binding)) {
      defaults[action] = {
        mac: sanitizeShortcutPlatformBinding(action, 'mac', binding, defaults[action].mac),
        windows: sanitizeShortcutPlatformBinding(action, 'windows', binding, defaults[action].windows),
      };
      return;
    }
    defaults[action] = {
      mac: sanitizeShortcutPlatformBinding(action, 'mac', binding.mac, defaults[action].mac),
      windows: sanitizeShortcutPlatformBinding(action, 'windows', binding.windows, defaults[action].windows),
    };
  });

  if (!hasPersistedCloseActiveTab && hasPersistedShortcutAction) {
    (['mac', 'windows'] as const).forEach((platform) => {
      const closeBinding = defaults.closeActiveTab[platform];
      const closeCombo = normalizeShortcutCombo(closeBinding.combo);
      const occupied = SHORTCUT_ACTION_ORDER.some((action) => {
        if (action === 'closeActiveTab') return false;
        const binding = defaults[action][platform];
        return binding.enabled && normalizeShortcutCombo(binding.combo) === closeCombo;
      });
      if (occupied) {
        defaults.closeActiveTab[platform] = { ...closeBinding, enabled: false };
      }
    });
  }

  return defaults;
};

const LEGACY_SIDEBAR_SEARCH_DEFAULTS: Record<ShortcutPlatform, readonly string[]> = {
  // The pre-platform schema stored one Ctrl+F binding and copied it into the mac slot.
  mac: ['Meta+F', 'Ctrl+F'],
  windows: ['Ctrl+F'],
};

export const migrateLegacySidebarSearchShortcutOptions = (value: unknown): ShortcutOptions => {
  const options = sanitizeShortcutOptions(value);

  (['mac', 'windows'] as const).forEach((platform) => {
    const binding = options.focusSidebarSearch[platform];
    if (!LEGACY_SIDEBAR_SEARCH_DEFAULTS[platform].includes(normalizeShortcutCombo(binding.combo))) {
      return;
    }
    options.focusSidebarSearch[platform] = {
      ...binding,
      combo: DEFAULT_SHORTCUT_OPTIONS.focusSidebarSearch[platform].combo,
    };
  });

  return options;
};

// 改键冲突检测：目标组合键是否已被其它已启用动作占用（设置中心改键与
// 快捷键搜索共用）。返回按注册顺序排列的冲突动作列表。
export const findEnabledActionConflicts = (
  options: ShortcutOptions,
  targetAction: ShortcutAction,
  normalizedCombo: string,
  platform: ShortcutPlatform,
): ShortcutAction[] => SHORTCUT_ACTION_ORDER.filter((action) => {
  if (action === targetAction) {
    return false;
  }
  const binding = resolveShortcutBinding(options, action, platform);
  return Boolean(binding?.enabled)
    && normalizeShortcutCombo(String(binding?.combo || '')) === normalizedCombo;
});

export const resolveShortcutBinding = (
  options: Partial<ShortcutOptions> | null | undefined,
  action: ShortcutAction,
  platform: ShortcutPlatform,
): ShortcutPlatformBinding => {
  const defaults = DEFAULT_SHORTCUT_OPTIONS[action];
  const binding = options?.[action];
  return cloneShortcutPlatformBinding(action, platform, binding?.[platform] ?? defaults[platform]);
};

export const isEditableElement = (target: EventTarget | null): boolean => {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
    return false;
  }
  const element = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    closest?: (selector: string) => unknown;
  };
  if (element.isContentEditable === true) {
    return true;
  }
  const tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    return true;
  }
  if (typeof element.closest === 'function') {
    try {
      return Boolean(element.closest('.monaco-editor, .monaco-inputbox, .ant-select, .ant-select-dropdown, .ant-picker, .ant-picker-dropdown, .ant-picker-panel, .ant-input'));
    } catch {
      return false;
    }
  }
  return false;
};

export const getShortcutDisplay = (combo: string): string => {
  const normalized = normalizeShortcutCombo(combo);
  return normalized || '-';
};

const DISPLAY_SYMBOLS: Record<string, string> = {
  Ctrl: '⌃',
  Meta: '⌘',
  Alt: '⌥',
  Shift: '⇧',
  Enter: '↵',
  Esc: 'Esc',
  Space: 'Space',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
};

export const getShortcutDisplayLabel = (
  combo: string,
  platform: ShortcutPlatform,
): string => {
  const normalized = normalizeShortcutCombo(combo);
  if (!normalized) return '-';
  if (platform !== 'mac') return normalized;
  return normalized
    .split('+')
    .filter(Boolean)
    .map((part) => DISPLAY_SYMBOLS[part] || part)
    .join('');
};

export const getShortcutPrimaryModifierDisplayLabel = (
  platform: ShortcutPlatform,
): string => getShortcutDisplayLabel(platform === 'mac' ? 'Meta' : 'Ctrl', platform);

export const getPrimaryShortcutDisplayLabel = (
  key: string,
  platform: ShortcutPlatform,
): string => getShortcutDisplayLabel(`${platform === 'mac' ? 'Meta' : 'Ctrl'}+${key}`, platform);

export const resolveShortcutDisplay = (
  options: Partial<ShortcutOptions> | null | undefined,
  action: ShortcutAction,
  platform: ShortcutPlatform,
): string => {
  const binding = resolveShortcutBinding(options, action, platform);
  if (!binding.enabled) return '-';
  return getShortcutDisplayLabel(binding.combo, platform);
};
