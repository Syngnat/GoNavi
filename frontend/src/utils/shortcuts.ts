import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export type ShortcutAction =
  | 'runQuery'
  | 'focusSidebarSearch'
  | 'newQueryTab'
  | 'toggleLogPanel'
  | 'toggleTheme'
  | 'openShortcutManager';

export interface ShortcutBinding {
  combo: string;
  enabled: boolean;
}

export type ShortcutOptions = Record<ShortcutAction, ShortcutBinding>;

export interface ShortcutActionMeta {
  label: string;
  description: string;
  allowInEditable?: boolean;
}

const MODIFIER_ORDER = ['Ctrl', 'Meta', 'Alt', 'Shift'] as const;
const MODIFIER_SET = new Set(MODIFIER_ORDER);

const KEY_ALIASES: Record<string, string> = {
  control: 'Ctrl',
  ctrl: 'Ctrl',
  command: 'Meta',
  cmd: 'Meta',
  meta: 'Meta',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
  escape: 'Esc',
  esc: 'Esc',
  return: 'Enter',
  enter: 'Enter',
  tab: 'Tab',
  space: 'Space',
  ' ': 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  arrowup: 'Up',
  up: 'Up',
  arrowdown: 'Down',
  down: 'Down',
  arrowleft: 'Left',
  left: 'Left',
  arrowright: 'Right',
  right: 'Right',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  home: 'Home',
  end: 'End',
  insert: 'Insert',
  ',': ',',
  '.': '.',
  '/': '/',
  ';': ';',
  "'": "'",
  '[': '[',
  ']': ']',
  '\\': '\\',
  '-': '-',
  '=': '=',
  '`': '`',
};

export const SHORTCUT_ACTION_ORDER: ShortcutAction[] = [
  'runQuery',
  'focusSidebarSearch',
  'newQueryTab',
  'toggleLogPanel',
  'toggleTheme',
  'openShortcutManager',
];

export const SHORTCUT_ACTION_META: Record<ShortcutAction, ShortcutActionMeta> = {
  runQuery: {
    label: '执行 SQL',
    description: '在当前查询页执行 SQL',
  },
  focusSidebarSearch: {
    label: '聚焦侧边栏搜索',
    description: '定位到左侧连接树搜索框',
    allowInEditable: true,
  },
  newQueryTab: {
    label: '新建查询页',
    description: '创建一个新的 SQL 查询标签页',
  },
  toggleLogPanel: {
    label: '切换日志面板',
    description: '打开或关闭 SQL 执行日志面板',
  },
  toggleTheme: {
    label: '切换主题',
    description: '在亮色和暗色主题之间切换',
  },
  openShortcutManager: {
    label: '打开快捷键管理',
    description: '打开快捷键设置面板',
    allowInEditable: true,
  },
};

export const DEFAULT_SHORTCUT_OPTIONS: ShortcutOptions = {
  runQuery: { combo: 'Ctrl+Shift+R', enabled: true },
  focusSidebarSearch: { combo: 'Ctrl+F', enabled: true },
  newQueryTab: { combo: 'Ctrl+Shift+N', enabled: true },
  toggleLogPanel: { combo: 'Ctrl+Shift+L', enabled: true },
  toggleTheme: { combo: 'Ctrl+Shift+D', enabled: true },
  openShortcutManager: { combo: 'Ctrl+,', enabled: true },
};

const normalizeKeyToken = (value: string): string => {
  const token = String(value || '').trim();
  if (!token) return '';
  const alias = KEY_ALIASES[token.toLowerCase()];
  if (alias) return alias;
  if (/^f([1-9]|1[0-2])$/i.test(token)) {
    return token.toUpperCase();
  }
  if (token.length === 1) {
    return token === '+' ? '+' : token.toUpperCase();
  }
  return token.length > 1 ? token[0].toUpperCase() + token.slice(1).toLowerCase() : token;
};

export const normalizeShortcutCombo = (combo: string): string => {
  const raw = String(combo || '').trim();
  if (!raw) return '';

  const pieces = raw
    .split('+')
    .map(part => part.trim())
    .filter(Boolean);

  const modifiers: string[] = [];
  let key = '';

  pieces.forEach((part) => {
    const normalized = normalizeKeyToken(part);
    if (!normalized) return;
    if (MODIFIER_SET.has(normalized as typeof MODIFIER_ORDER[number])) {
      if (!modifiers.includes(normalized)) {
        modifiers.push(normalized);
      }
      return;
    }
    key = normalized;
  });

  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a as typeof MODIFIER_ORDER[number]) - MODIFIER_ORDER.indexOf(b as typeof MODIFIER_ORDER[number]));
  if (!key) {
    return modifiers.join('+');
  }
  return [...modifiers, key].join('+');
};

const normalizeKeyboardKey = (key: string): string => {
  const token = String(key || '').trim();
  if (!token) return '';
  const alias = KEY_ALIASES[token.toLowerCase()];
  if (alias) return alias;
  if (token.length === 1) {
    if (token === ' ') return 'Space';
    return token.toUpperCase();
  }
  if (/^f([1-9]|1[0-2])$/i.test(token)) {
    return token.toUpperCase();
  }
  return token.length > 1 ? token[0].toUpperCase() + token.slice(1) : token;
};

export const eventToShortcut = (event: KeyboardEvent | ReactKeyboardEvent): string => {
  const key = normalizeKeyboardKey(event.key);
  if (!key || MODIFIER_SET.has(key as typeof MODIFIER_ORDER[number])) {
    return '';
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.metaKey) modifiers.push('Meta');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');

  return normalizeShortcutCombo([...modifiers, key].join('+'));
};

export const isShortcutMatch = (event: KeyboardEvent | ReactKeyboardEvent, combo: string): boolean => {
  const expected = normalizeShortcutCombo(combo);
  if (!expected) return false;
  const actual = eventToShortcut(event);
  return actual === expected;
};

export const hasModifierKey = (combo: string): boolean => {
  const normalized = normalizeShortcutCombo(combo);
  if (!normalized) return false;
  return normalized.split('+').some(part => MODIFIER_SET.has(part as typeof MODIFIER_ORDER[number]));
};

export const cloneShortcutOptions = (value: ShortcutOptions): ShortcutOptions => {
  return SHORTCUT_ACTION_ORDER.reduce((acc, action) => {
    acc[action] = {
      combo: normalizeShortcutCombo(value[action]?.combo || DEFAULT_SHORTCUT_OPTIONS[action].combo),
      enabled: value[action]?.enabled !== false,
    };
    return acc;
  }, {} as ShortcutOptions);
};

export const sanitizeShortcutOptions = (value: unknown): ShortcutOptions => {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const defaults = cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS);

  SHORTCUT_ACTION_ORDER.forEach((action) => {
    const actionRaw = raw[action];
    if (!actionRaw || typeof actionRaw !== 'object') {
      return;
    }
    const binding = actionRaw as Record<string, unknown>;
    const combo = normalizeShortcutCombo(String(binding.combo || defaults[action].combo));
    defaults[action] = {
      combo: combo || defaults[action].combo,
      enabled: binding.enabled === false ? false : true,
    };
  });

  return defaults;
};

export const isEditableElement = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  if (target.isContentEditable) {
    return true;
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    return true;
  }
  if (target.closest('.monaco-editor, .monaco-inputbox, .ant-select, .ant-picker, .ant-input')) {
    return true;
  }
  return false;
};

export const getShortcutDisplay = (combo: string): string => {
  const normalized = normalizeShortcutCombo(combo);
  return normalized || '-';
};

