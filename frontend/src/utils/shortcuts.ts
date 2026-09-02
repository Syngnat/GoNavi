import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { getCurrentLanguage, t } from '../i18n';

export type ShortcutAction =
  | 'runQuery'
  | 'selectCurrentStatement'
  | 'duplicateCurrentLine'
  | 'saveQuery'
  | 'saveQueryAs'
  | 'formatSql'
  | 'triggerSqlAiCompletion'
  | 'acceptSqlAiCompletion'
  | 'toggleQueryResultsPanel'
  | 'sendAIChatMessage'
  | 'focusSidebarSearch'
  | 'newQueryTab'
  | 'closeActiveTab'
  | 'switchToNextTab'
  | 'switchToPreviousTab'
  | 'newConnection'
  | 'toggleAIPanel'
  | 'toggleLogPanel'
  | 'toggleTheme'
  | 'openShortcutManager'
  | 'toggleMacFullscreen'
  | 'resetWindowZoom'
  | 'diagnoseQuery'
  | 'showSlowQueries';

export type ShortcutPlatform = 'mac' | 'windows';

export interface ShortcutPlatformBinding {
  combo: string;
  enabled: boolean;
}

export type ShortcutBinding = Record<ShortcutPlatform, ShortcutPlatformBinding>;

export type ShortcutOptions = Record<ShortcutAction, ShortcutBinding>;

export interface ShortcutActionMeta {
  label: string;
  description: string;
  allowInEditable?: boolean;
  allowWithoutModifier?: boolean;
  scope?: 'global' | 'aiComposer' | 'queryEditor';
  requiredKey?: string;
  disallowShift?: boolean;
  platformOnly?: 'mac';
  allowedReservedMonacoCommandIds?: string[];
}

interface ShortcutActionMetaDefinition extends Omit<ShortcutActionMeta, 'label' | 'description'> {
  label?: string;
  description?: string;
  labelKey?: string;
  descriptionKey?: string;
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
  'selectCurrentStatement',
  'duplicateCurrentLine',
  'saveQuery',
  'saveQueryAs',
  'formatSql',
  'triggerSqlAiCompletion',
  'acceptSqlAiCompletion',
  'toggleQueryResultsPanel',
  'sendAIChatMessage',
  'focusSidebarSearch',
  'newQueryTab',
  'closeActiveTab',
  'switchToNextTab',
  'switchToPreviousTab',
  'newConnection',
  'toggleAIPanel',
  'toggleLogPanel',
  'toggleTheme',
  'diagnoseQuery',
  'showSlowQueries',
  'openShortcutManager',
  'toggleMacFullscreen',
  'resetWindowZoom',
];

const localizeShortcut = (key: string): string => t(key, undefined, getCurrentLanguage());

const createShortcutActionMeta = (
  definition: ShortcutActionMetaDefinition,
): ShortcutActionMeta => ({
  get label() {
    return definition.label ?? localizeShortcut(definition.labelKey || '');
  },
  get description() {
    return definition.description ?? localizeShortcut(definition.descriptionKey || '');
  },
  allowInEditable: definition.allowInEditable,
  allowWithoutModifier: definition.allowWithoutModifier,
  scope: definition.scope,
  requiredKey: definition.requiredKey,
  disallowShift: definition.disallowShift,
  platformOnly: definition.platformOnly,
  allowedReservedMonacoCommandIds: definition.allowedReservedMonacoCommandIds,
});

const SHORTCUT_ACTION_META_DEFINITIONS: Record<ShortcutAction, ShortcutActionMetaDefinition> = {
  runQuery: {
    labelKey: 'app.shortcuts.action.runQuery.label',
    descriptionKey: 'app.shortcuts.action.runQuery.description',
  },
  selectCurrentStatement: {
    labelKey: 'app.shortcuts.action.selectCurrentStatement.label',
    descriptionKey: 'app.shortcuts.action.selectCurrentStatement.description',
    scope: 'queryEditor',
  },
  duplicateCurrentLine: {
    labelKey: 'app.shortcuts.action.duplicateCurrentLine.label',
    descriptionKey: 'app.shortcuts.action.duplicateCurrentLine.description',
    scope: 'queryEditor',
    allowInEditable: true,
    allowedReservedMonacoCommandIds: ['editor.action.addSelectionToNextFindMatch'],
  },
  saveQuery: {
    labelKey: 'app.shortcuts.action.saveQuery.label',
    descriptionKey: 'app.shortcuts.action.saveQuery.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  saveQueryAs: {
    labelKey: 'app.shortcuts.action.saveQueryAs.label',
    descriptionKey: 'app.shortcuts.action.saveQueryAs.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  formatSql: {
    labelKey: 'app.shortcuts.action.formatSql.label',
    descriptionKey: 'app.shortcuts.action.formatSql.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  triggerSqlAiCompletion: {
    labelKey: 'app.shortcuts.action.triggerSqlAiCompletion.label',
    descriptionKey: 'app.shortcuts.action.triggerSqlAiCompletion.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  acceptSqlAiCompletion: {
    labelKey: 'app.shortcuts.action.acceptSqlAiCompletion.label',
    descriptionKey: 'app.shortcuts.action.acceptSqlAiCompletion.description',
    scope: 'queryEditor',
    allowInEditable: true,
    allowWithoutModifier: true,
  },
  toggleQueryResultsPanel: {
    labelKey: 'app.shortcuts.action.toggleQueryResultsPanel.label',
    descriptionKey: 'app.shortcuts.action.toggleQueryResultsPanel.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  sendAIChatMessage: {
    labelKey: 'app.shortcuts.action.sendAIChatMessage.label',
    descriptionKey: 'app.shortcuts.action.sendAIChatMessage.description',
    allowInEditable: true,
    allowWithoutModifier: true,
    scope: 'aiComposer',
    requiredKey: 'Enter',
    disallowShift: true,
  },
  focusSidebarSearch: {
    labelKey: 'app.shortcuts.action.focusSidebarSearch.label',
    descriptionKey: 'app.shortcuts.action.focusSidebarSearch.description',
    allowInEditable: true,
  },
  newQueryTab: {
    labelKey: 'app.shortcuts.action.newQueryTab.label',
    descriptionKey: 'app.shortcuts.action.newQueryTab.description',
    allowInEditable: true,
  },
  closeActiveTab: {
    labelKey: 'app.shortcuts.action.closeActiveTab.label',
    descriptionKey: 'app.shortcuts.action.closeActiveTab.description',
    scope: 'global',
    allowInEditable: true,
  },
  switchToNextTab: {
    labelKey: 'app.shortcuts.action.switchToNextTab.label',
    descriptionKey: 'app.shortcuts.action.switchToNextTab.description',
    allowInEditable: true,
  },
  switchToPreviousTab: {
    labelKey: 'app.shortcuts.action.switchToPreviousTab.label',
    descriptionKey: 'app.shortcuts.action.switchToPreviousTab.description',
    allowInEditable: true,
  },
  newConnection: {
    labelKey: 'app.shortcuts.action.newConnection.label',
    descriptionKey: 'app.shortcuts.action.newConnection.description',
  },
  toggleAIPanel: {
    labelKey: 'app.shortcuts.action.toggleAIPanel.label',
    descriptionKey: 'app.shortcuts.action.toggleAIPanel.description',
    allowInEditable: true,
  },
  toggleLogPanel: {
    labelKey: 'app.shortcuts.action.toggleLogPanel.label',
    descriptionKey: 'app.shortcuts.action.toggleLogPanel.description',
  },
  toggleTheme: {
    labelKey: 'app.shortcuts.action.toggleTheme.label',
    descriptionKey: 'app.shortcuts.action.toggleTheme.description',
  },
  diagnoseQuery: {
    labelKey: 'app.shortcuts.action.diagnoseQuery.label',
    descriptionKey: 'app.shortcuts.action.diagnoseQuery.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  showSlowQueries: {
    labelKey: 'app.shortcuts.action.showSlowQueries.label',
    descriptionKey: 'app.shortcuts.action.showSlowQueries.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  openShortcutManager: {
    labelKey: 'app.shortcuts.action.openShortcutManager.label',
    descriptionKey: 'app.shortcuts.action.openShortcutManager.description',
    allowInEditable: true,
  },
  toggleMacFullscreen: {
    labelKey: 'app.shortcuts.action.toggleMacFullscreen.label',
    descriptionKey: 'app.shortcuts.action.toggleMacFullscreen.description',
    platformOnly: 'mac',
  },
  resetWindowZoom: {
    labelKey: 'app.shortcuts.action.resetWindowZoom.label',
    descriptionKey: 'app.shortcuts.action.resetWindowZoom.description',
    allowInEditable: true,
  },
};

export const SHORTCUT_ACTION_META: Record<ShortcutAction, ShortcutActionMeta> = Object.fromEntries(
  SHORTCUT_ACTION_ORDER.map((action) => [
    action,
    createShortcutActionMeta(SHORTCUT_ACTION_META_DEFINITIONS[action]),
  ]),
) as Record<ShortcutAction, ShortcutActionMeta>;

export const DEFAULT_SHORTCUT_OPTIONS: ShortcutOptions = {
  runQuery: {
    mac: { combo: 'Meta+R', enabled: true },
    windows: { combo: 'Ctrl+R', enabled: true },
  },
  selectCurrentStatement: {
    mac: { combo: 'Meta+E', enabled: true },
    windows: { combo: 'Ctrl+E', enabled: true },
  },
  duplicateCurrentLine: {
    mac: { combo: 'Meta+D', enabled: true },
    windows: { combo: 'Ctrl+D', enabled: true },
  },
  saveQuery: {
    mac: { combo: 'Meta+S', enabled: true },
    windows: { combo: 'Ctrl+S', enabled: true },
  },
  saveQueryAs: {
    mac: { combo: 'Meta+Shift+S', enabled: true },
    windows: { combo: 'Ctrl+Shift+S', enabled: true },
  },
  formatSql: {
    mac: { combo: 'Alt+Shift+F', enabled: true },
    windows: { combo: 'Alt+Shift+F', enabled: true },
  },
  triggerSqlAiCompletion: {
    mac: { combo: 'Alt+\\', enabled: true },
    windows: { combo: 'Alt+\\', enabled: true },
  },
  acceptSqlAiCompletion: {
    mac: { combo: 'Tab', enabled: true },
    windows: { combo: 'Tab', enabled: true },
  },
  toggleQueryResultsPanel: {
    mac: { combo: 'Meta+Shift+M', enabled: true },
    windows: { combo: 'Ctrl+Shift+M', enabled: true },
  },
  sendAIChatMessage: {
    mac: { combo: 'Enter', enabled: true },
    windows: { combo: 'Enter', enabled: true },
  },
  focusSidebarSearch: {
    mac: { combo: 'Meta+K', enabled: true },
    windows: { combo: 'Ctrl+K', enabled: true },
  },
  newQueryTab: {
    mac: { combo: 'Meta+N', enabled: true },
    windows: { combo: 'Ctrl+N', enabled: true },
  },
  closeActiveTab: {
    mac: { combo: 'Meta+W', enabled: true },
    windows: { combo: 'Ctrl+W', enabled: true },
  },
  switchToNextTab: {
    mac: { combo: 'Ctrl+Tab', enabled: true },
    windows: { combo: 'Ctrl+Tab', enabled: true },
  },
  switchToPreviousTab: {
    mac: { combo: 'Ctrl+Shift+Tab', enabled: true },
    windows: { combo: 'Ctrl+Shift+Tab', enabled: true },
  },
  newConnection: {
    mac: { combo: 'Meta+Shift+N', enabled: true },
    windows: { combo: 'Ctrl+Shift+N', enabled: true },
  },
  toggleAIPanel: {
    mac: { combo: 'Meta+J', enabled: true },
    windows: { combo: 'Ctrl+J', enabled: true },
  },
  toggleLogPanel: {
    mac: { combo: 'Meta+Shift+H', enabled: true },
    windows: { combo: 'Ctrl+H', enabled: true },
  },
  toggleTheme: {
    mac: { combo: 'Meta+Shift+D', enabled: true },
    windows: { combo: 'Ctrl+Shift+D', enabled: true },
  },
  // SQL 诊断：避开 toggleTheme 的 Ctrl+Shift+D，用 Ctrl+Shift+P（P = Plan）
  diagnoseQuery: {
    mac: { combo: 'Meta+Shift+P', enabled: true },
    windows: { combo: 'Ctrl+Shift+P', enabled: true },
  },
  // 慢查询历史：避开 toggleLogPanel 的 Ctrl+H / Meta+Shift+H，用 Ctrl+Shift+L（L = Log）
  showSlowQueries: {
    mac: { combo: 'Meta+Shift+L', enabled: true },
    windows: { combo: 'Ctrl+Shift+L', enabled: true },
  },
  openShortcutManager: {
    mac: { combo: 'Meta+,', enabled: true },
    windows: { combo: 'Ctrl+,', enabled: true },
  },
  toggleMacFullscreen: {
    mac: { combo: 'Ctrl+Meta+F', enabled: true },
    windows: { combo: '', enabled: false },
  },
  resetWindowZoom: {
    mac: { combo: '', enabled: false },
    windows: { combo: 'Ctrl+Shift+0', enabled: true },
  },
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

const KEYBOARD_CODE_ALIASES: Record<string, string> = {
  Backslash: '\\',
  IntlBackslash: '\\',
  Slash: '/',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

const KEY_CODE_ALIASES: Record<number, string> = {
  186: ';',
  187: '=',
  188: ',',
  189: '-',
  190: '.',
  191: '/',
  192: '`',
  219: '[',
  220: '\\',
  226: '\\',
  221: ']',
  222: "'",
};

const normalizeKeyboardEventCode = (
  event: (KeyboardEvent | ReactKeyboardEvent) & {
    code?: string;
    keyCode?: number;
    which?: number;
    nativeEvent?: { code?: string; keyCode?: number; which?: number };
  },
): string => {
  const code = String(event.code || event.nativeEvent?.code || '').trim();
  if (code) {
    const alias = KEYBOARD_CODE_ALIASES[code];
    if (alias) return alias;
  }

  const keyCode = Number(event.keyCode ?? event.nativeEvent?.keyCode ?? event.which ?? event.nativeEvent?.which ?? 0);
  return KEY_CODE_ALIASES[keyCode] || '';
};

let globalImeCompositionActive = false;
let globalShortcutCaptureActive = false;

export const setGlobalImeCompositionActive = (active: boolean): void => {
  globalImeCompositionActive = active === true;
};

export const isGlobalImeCompositionActive = (): boolean => globalImeCompositionActive;

export const setGlobalShortcutCaptureActive = (active: boolean): void => {
  globalShortcutCaptureActive = active === true;
};

export const isGlobalShortcutCaptureActive = (): boolean => globalShortcutCaptureActive;

type ImeCompositionEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type ImeCompositionDocumentTarget = Pick<Document, 'addEventListener' | 'removeEventListener'> & {
  visibilityState?: DocumentVisibilityState;
};

export const installGlobalImeCompositionTracking = (
  eventTarget: ImeCompositionEventTarget = window,
  documentTarget: ImeCompositionDocumentTarget | null = document,
): (() => void) => {
  const handleCompositionStart = () => setGlobalImeCompositionActive(true);
  const handleCompositionEnd = () => setGlobalImeCompositionActive(false);
  const handleBlur = () => setGlobalImeCompositionActive(false);
  const handleVisibilityChange = () => {
    if (!documentTarget || documentTarget.visibilityState === 'hidden') {
      setGlobalImeCompositionActive(false);
    }
  };

  eventTarget.addEventListener('compositionstart', handleCompositionStart, true);
  eventTarget.addEventListener('compositionend', handleCompositionEnd, true);
  eventTarget.addEventListener('blur', handleBlur, true);
  documentTarget?.addEventListener('visibilitychange', handleVisibilityChange, true);

  return () => {
    eventTarget.removeEventListener('compositionstart', handleCompositionStart, true);
    eventTarget.removeEventListener('compositionend', handleCompositionEnd, true);
    eventTarget.removeEventListener('blur', handleBlur, true);
    documentTarget?.removeEventListener('visibilitychange', handleVisibilityChange, true);
    setGlobalImeCompositionActive(false);
  };
};

const isMonacoImeInputTarget = (target: EventTarget | null | undefined): boolean => {
  if (!target || typeof target !== 'object') {
    return false;
  }

  const element = target as Element & {
    className?: unknown;
    classList?: { contains?: (name: string) => boolean };
    closest?: (selector: string) => Element | null;
  };
  if (typeof element.classList?.contains === 'function' && element.classList.contains('ime-input')) {
    return true;
  }
  if (typeof element.className === 'string' && /\bime-input\b/.test(element.className)) {
    return true;
  }
  if (typeof element.closest === 'function') {
    return Boolean(element.closest('.monaco-editor .inputarea.ime-input, .monaco-editor textarea.ime-input, .ime-input'));
  }
  return false;
};

export const isImeComposingKeyEvent = (
  event: (KeyboardEvent | ReactKeyboardEvent | null | undefined) & {
    nativeEvent?: {
      isComposing?: boolean;
      keyCode?: number;
      which?: number;
    };
    keyCode?: number;
    which?: number;
    isComposing?: boolean;
    key?: string;
    target?: EventTarget | null;
  },
): boolean => {
  if (!event) {
    return false;
  }

  const nativeEvent = event.nativeEvent;
  const key = String(event.key || '').trim();
  const keyCode = Number(event.keyCode ?? nativeEvent?.keyCode ?? 0);
  const which = Number(event.which ?? nativeEvent?.which ?? 0);
  const hasModifier = Boolean(event.ctrlKey || event.metaKey || event.altKey);

  // Primary IME indicators — reliable across all browsers/WebViews.
  if (
    globalImeCompositionActive
    || event.isComposing
    || nativeEvent?.isComposing
    || keyCode === 229
    || which === 229
    || (key === 'Process' && !hasModifier)
  ) {
    return true;
  }

  // Fallback: some WebViews (notably older Wails/macOS WKWebView builds) emit
  // real key codes (e.g. keyCode 49 for digit "1") during IME candidate
  // selection without setting isComposing or keyCode 229.  In that case the
  // only observable signal is the `ime-input` CSS class on the Monaco
  // textarea.  However, we must NOT use the CSS class alone for events that
  // carry a modifier key (Ctrl / Meta / Alt), because the class can persist
  // even when the user is pressing a shortcut (e.g. Cmd+E) while a CJK input
  // method is simply *enabled* (not actively composing).  Blocking modifier-
  // key combos would break all window-level shortcuts for CJK users.
  if (!hasModifier && isMonacoImeInputTarget(event.target)) {
    return true;
  }

  return false;
};

const resolveShortcutModifiersFromEvent = (event: KeyboardEvent | ReactKeyboardEvent): string[] => {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.metaKey) modifiers.push('Meta');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  return modifiers;
};

const normalizeShortcutCandidate = (modifiers: string[], key: string): string => {
  if (!key || MODIFIER_SET.has(key as typeof MODIFIER_ORDER[number])) {
    return '';
  }
  return normalizeShortcutCombo([...modifiers, key].join('+'));
};

const isUsableShortcutKey = (key: string): boolean => (
  Boolean(key)
  && !MODIFIER_SET.has(key as typeof MODIFIER_ORDER[number])
  && key !== 'Process'
  && key !== 'Unidentified'
  && key !== 'Dead'
);

const eventToPhysicalShortcutCandidates = (event: KeyboardEvent | ReactKeyboardEvent): string[] => {
  const modifiers = resolveShortcutModifiersFromEvent(event);
  const candidates: string[] = [];
  const pushCandidate = (key: string) => {
    const candidate = normalizeShortcutCandidate(modifiers, key);
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  const key = normalizeKeyboardKey(event.key);
  if (isUsableShortcutKey(key)) {
    pushCandidate(key);
  }

  const codeKey = normalizeKeyboardEventCode(event);
  if (
    codeKey
    && (
      !isUsableShortcutKey(key)
      || key.length !== 1
    )
  ) {
    pushCandidate(codeKey);
  }

  return candidates;
};

const eventToShortcutCandidates = (event: KeyboardEvent | ReactKeyboardEvent): string[] => {
  if (isImeComposingKeyEvent(event)) {
    return [];
  }
  return eventToPhysicalShortcutCandidates(event);
};

export const eventToShortcut = (event: KeyboardEvent | ReactKeyboardEvent): string => {
  return eventToShortcutCandidates(event)[0] || '';
};

export const isShortcutMatch = (event: KeyboardEvent | ReactKeyboardEvent, combo: string): boolean => {
  if (globalShortcutCaptureActive) return false;
  const expected = normalizeShortcutCombo(combo);
  if (!expected) return false;
  return eventToShortcutCandidates(event).includes(expected);
};

export const isShortcutPhysicalMatch = (event: KeyboardEvent | ReactKeyboardEvent, combo: string): boolean => {
  const expected = normalizeShortcutCombo(combo);
  if (!expected) return false;
  return eventToPhysicalShortcutCandidates(event).includes(expected);
};

export const getShortcutPlatform = (isMacRuntime?: boolean): ShortcutPlatform => (
  isMacRuntime ? 'mac' : 'windows'
);

export const hasModifierKey = (combo: string): boolean => {
  const normalized = normalizeShortcutCombo(combo);
  if (!normalized) return false;
  return normalized.split('+').some(part => MODIFIER_SET.has(part as typeof MODIFIER_ORDER[number]));
};

const getShortcutKeyToken = (combo: string): string => {
  const parts = normalizeShortcutCombo(combo).split('+').filter(Boolean);
  const key = parts[parts.length - 1] || '';
  return MODIFIER_SET.has(key as typeof MODIFIER_ORDER[number]) ? '' : key;
};

const getShortcutModifierTokens = (combo: string): string[] => (
  normalizeShortcutCombo(combo)
    .split('+')
    .filter(part => MODIFIER_SET.has(part as typeof MODIFIER_ORDER[number]))
);

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

export type ConflictContext = 'global' | 'monaco' | 'datagrid';

export interface ReservedShortcut {
  combo: string;
  label: string;
  context: ConflictContext;
  monacoCommandId?: string;
  platforms?: ShortcutPlatform[];
}

interface ReservedShortcutDefinition extends Omit<ReservedShortcut, 'label'> {
  labelKey: string;
}

export interface ConflictInfo {
  label: string;
  context: ConflictContext;
  monacoCommandId?: string;
}

const RESERVED_SHORTCUT_DEFINITIONS: ReservedShortcutDefinition[] = [
  // Browser / WebView built-in shortcuts
  { combo: 'Ctrl+S',           labelKey: 'app.shortcuts.reserved.browser_save',                 context: 'global' },
  { combo: 'Ctrl+P',           labelKey: 'app.shortcuts.reserved.browser_print',                context: 'global' },
  { combo: 'Ctrl+T',           labelKey: 'app.shortcuts.reserved.browser_new_tab',              context: 'global' },
  { combo: 'Ctrl+N',           labelKey: 'app.shortcuts.reserved.browser_new_window',           context: 'global' },
  { combo: 'Ctrl+Shift+N',     labelKey: 'app.shortcuts.reserved.browser_new_incognito_window', context: 'global' },

  // Monaco editor built-in shortcuts
  { combo: 'Ctrl+F',           labelKey: 'app.shortcuts.reserved.editor_find',               context: 'monaco', monacoCommandId: 'actions.find', platforms: ['windows'] },
  { combo: 'Meta+F',           labelKey: 'app.shortcuts.reserved.editor_find',               context: 'monaco', monacoCommandId: 'actions.find', platforms: ['mac'] },
  { combo: 'Ctrl+H',           labelKey: 'app.shortcuts.reserved.editor_replace',            context: 'monaco', monacoCommandId: 'editor.action.startFindReplaceAction', platforms: ['windows'] },
  { combo: 'Meta+H',           labelKey: 'app.shortcuts.reserved.editor_replace',            context: 'monaco', monacoCommandId: 'editor.action.startFindReplaceAction', platforms: ['mac'] },
  { combo: 'Ctrl+G',           labelKey: 'app.shortcuts.reserved.editor_goto_line',          context: 'monaco', monacoCommandId: 'editor.action.gotoLine', platforms: ['windows'] },
  { combo: 'Meta+G',           labelKey: 'app.shortcuts.reserved.editor_goto_line',          context: 'monaco', monacoCommandId: 'editor.action.gotoLine', platforms: ['mac'] },
  { combo: 'Ctrl+P',           labelKey: 'app.shortcuts.reserved.editor_quick_open',         context: 'monaco', monacoCommandId: 'actions.quickOpen', platforms: ['windows'] },
  { combo: 'Meta+P',           labelKey: 'app.shortcuts.reserved.editor_quick_open',         context: 'monaco', monacoCommandId: 'actions.quickOpen', platforms: ['mac'] },
  { combo: 'Ctrl+Shift+F',     labelKey: 'app.shortcuts.reserved.editor_find_global',        context: 'monaco', monacoCommandId: 'actions.quickOpenNavigate', platforms: ['windows'] },
  { combo: 'Meta+Shift+F',     labelKey: 'app.shortcuts.reserved.editor_find_global',        context: 'monaco', monacoCommandId: 'actions.quickOpenNavigate', platforms: ['mac'] },
  { combo: 'Ctrl+D',           labelKey: 'app.shortcuts.reserved.editor_add_selection',      context: 'monaco', monacoCommandId: 'editor.action.addSelectionToNextFindMatch', platforms: ['windows'] },
  { combo: 'Meta+D',           labelKey: 'app.shortcuts.reserved.editor_add_selection',      context: 'monaco', monacoCommandId: 'editor.action.addSelectionToNextFindMatch', platforms: ['mac'] },
  { combo: 'Ctrl+Shift+K',     labelKey: 'app.shortcuts.reserved.editor_delete_line',        context: 'monaco', monacoCommandId: 'editor.action.deleteLines', platforms: ['windows'] },
  { combo: 'Meta+Shift+K',     labelKey: 'app.shortcuts.reserved.editor_delete_line',        context: 'monaco', monacoCommandId: 'editor.action.deleteLines', platforms: ['mac'] },
  { combo: 'Ctrl+Enter',       labelKey: 'app.shortcuts.reserved.editor_insert_line_after',  context: 'monaco', monacoCommandId: 'editor.action.insertLineAfter', platforms: ['windows'] },
  { combo: 'Meta+Enter',       labelKey: 'app.shortcuts.reserved.editor_insert_line_after',  context: 'monaco', monacoCommandId: 'editor.action.insertLineAfter', platforms: ['mac'] },
  { combo: 'Ctrl+Shift+Enter', labelKey: 'app.shortcuts.reserved.editor_insert_line_before', context: 'monaco', monacoCommandId: 'editor.action.insertLineBefore', platforms: ['windows'] },
  { combo: 'Meta+Shift+Enter', labelKey: 'app.shortcuts.reserved.editor_insert_line_before', context: 'monaco', monacoCommandId: 'editor.action.insertLineBefore', platforms: ['mac'] },
  { combo: 'F2',               labelKey: 'app.shortcuts.reserved.editor_rename_symbol',      context: 'monaco', monacoCommandId: 'editor.action.rename' },

  // DataGrid shortcuts
  { combo: 'Ctrl+C',           labelKey: 'app.shortcuts.reserved.datagrid_copy', context: 'datagrid', platforms: ['windows'] },
  { combo: 'Meta+C',           labelKey: 'app.shortcuts.reserved.datagrid_copy', context: 'datagrid', platforms: ['mac'] },
];

export const RESERVED_SHORTCUTS: ReservedShortcut[] = RESERVED_SHORTCUT_DEFINITIONS.map((definition) => ({
  ...definition,
  get label() {
    return localizeShortcut(definition.labelKey);
  },
}));

const CONTEXT_DESCRIPTION_KEYS: Record<ConflictContext, string> = {
  global: 'app.shortcuts.context.global',
  monaco: 'app.shortcuts.context.monaco',
  datagrid: 'app.shortcuts.context.datagrid',
};

export const describeConflictContext = (context: ConflictContext): string => {
  const key = CONTEXT_DESCRIPTION_KEYS[context];
  return key ? localizeShortcut(key) : context;
};

export const splitConflictsByContext = (conflicts: ConflictInfo[]) => {
  const monaco = conflicts.filter(c => c.context === 'monaco');
  const other = conflicts.filter(c => c.context !== 'monaco');
  const dedupe = (items: ConflictInfo[], fn: (c: ConflictInfo) => string) =>
    [...new Set(items.map(fn))].join('、');
  return {
    monacoLabels: dedupe(monaco, c => c.label),
    otherLabels: dedupe(other, c => c.label),
    otherContexts: dedupe(other, c => describeConflictContext(c.context)),
    hasMonaco: monaco.length > 0,
    hasOther: other.length > 0,
  };
};

export const findReservedConflict = (normalizedCombo: string): ConflictInfo | null => {
  const conflict = findReservedConflicts(normalizedCombo)[0];
  if (!conflict) return null;
  return conflict;
};

export const findReservedConflicts = (normalizedCombo: string, platform?: ShortcutPlatform): ConflictInfo[] => {
  return RESERVED_SHORTCUTS
    .filter((r) => r.combo === normalizedCombo && (!platform || !r.platforms || r.platforms.includes(platform)))
    .map((r) => ({ label: r.label, context: r.context, monacoCommandId: r.monacoCommandId }));
};

export const findReservedConflictsForAction = (
  action: ShortcutAction,
  normalizedCombo: string,
  platform?: ShortcutPlatform,
): ConflictInfo[] => {
  const conflicts = findReservedConflicts(normalizedCombo, platform);
  const allowedMonacoCommandIds = new Set(
    SHORTCUT_ACTION_META[action].allowedReservedMonacoCommandIds || [],
  );
  if (allowedMonacoCommandIds.size === 0) {
    return conflicts;
  }
  return conflicts.filter((conflict) => (
    conflict.context !== 'monaco'
    || !conflict.monacoCommandId
    || !allowedMonacoCommandIds.has(conflict.monacoCommandId)
  ));
};

export interface MonacoKeyBinding {
  keyMod: number;
  keyCode: number;
}

/** Map key token (after normalization) to a function that returns KeyCode.
 *  The function receives the KeyCode enum to avoid importing monaco at module level. */
type KeyCodeResolver = (kc: Record<string, number>) => number;

const MONACO_KEY_MAP: Record<string, KeyCodeResolver> = {
  Enter:          (kc) => kc.Enter,
  Tab:            (kc) => kc.Tab,
  Esc:            (kc) => kc.Escape,
  Space:          (kc) => kc.Space,
  Backspace:      (kc) => kc.Backspace,
  Delete:         (kc) => kc.Delete,
  Home:           (kc) => kc.Home,
  End:            (kc) => kc.End,
  PageUp:         (kc) => kc.PageUp,
  PageDown:       (kc) => kc.PageDown,
  Up:             (kc) => kc.UpArrow,
  Down:           (kc) => kc.DownArrow,
  Left:           (kc) => kc.LeftArrow,
  Right:          (kc) => kc.RightArrow,
  Insert:         (kc) => kc.Insert,
  '/':            (kc) => kc.Oem2,
  ',':            (kc) => kc.OemComma,
  '-':            (kc) => kc.OemMinus,
  '=':            (kc) => kc.OemPlus,
  '.':            (kc) => kc.OemPeriod,
  ';':            (kc) => kc.Oem1,
  "'":            (kc) => kc.Oem7,
  '[':            (kc) => kc.Oem4,
  ']':            (kc) => kc.Oem6,
  '\\':           (kc) => kc.Oem5,
  '`':            (kc) => kc.Oem3,
};

function resolveKeyCode(token: string, kc: Record<string, number>): number | null {
  // F1-F12
  const fMatch = token.match(/^F([1-9]|1[0-2])$/);
  if (fMatch) {
    return kc['F' + fMatch[1]] ?? null;
  }
  // A-Z
  if (/^[A-Z]$/.test(token)) {
    return kc['Key' + token] ?? null;
  }
  // 0-9
  if (/^[0-9]$/.test(token)) {
    return kc['Digit' + token] ?? null;
  }
  // Special keys map
  const resolver = MONACO_KEY_MAP[token];
  if (resolver) {
    return resolver(kc);
  }
  return null;
}

export const comboToMonacoKeyBinding = (
  combo: string,
  keyModEnum: Record<string, number>,
  keyCodeEnum: Record<string, number>,
  platform: ShortcutPlatform,
): MonacoKeyBinding | null => {
  const normalized = normalizeShortcutCombo(combo);
  if (!normalized) return null;

  const pieces = normalized.split('+');
  let keyMod = 0;
  let keyCode: number | null = null;
  // Monaco 的 CtrlCmd / WinCtrl 是平台抽象：Windows/Linux 下分别表示
  // Ctrl / Meta，macOS 下则分别表示 Command / Control。
  const ctrlKeyMod = platform === 'mac'
    ? (keyModEnum.WinCtrl ?? 0)
    : (keyModEnum.CtrlCmd ?? 0);
  const metaKeyMod = platform === 'mac'
    ? (keyModEnum.CtrlCmd ?? 0)
    : (keyModEnum.WinCtrl ?? 0);

  for (const piece of pieces) {
    if (piece === 'Ctrl') {
      keyMod |= ctrlKeyMod;
    } else if (piece === 'Meta') {
      keyMod |= metaKeyMod;
    } else if (piece === 'Alt') {
      keyMod |= keyModEnum.Alt ?? 0;
    } else if (piece === 'Shift') {
      keyMod |= keyModEnum.Shift ?? 0;
    } else {
      keyCode = resolveKeyCode(piece, keyCodeEnum);
    }
  }

  if (keyCode == null) return null;
  return { keyMod, keyCode };
};
