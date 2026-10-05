import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  KEY_ALIASES,
  MODIFIER_SET,
  MODIFIER_ORDER,
  type ShortcutPlatform,
} from './shortcutDefinitions';

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

export const getShortcutKeyToken = (combo: string): string => {
  const parts = normalizeShortcutCombo(combo).split('+').filter(Boolean);
  const key = parts[parts.length - 1] || '';
  return MODIFIER_SET.has(key as typeof MODIFIER_ORDER[number]) ? '' : key;
};

export const getShortcutModifierTokens = (combo: string): string[] => (
  normalizeShortcutCombo(combo)
    .split('+')
    .filter(part => MODIFIER_SET.has(part as typeof MODIFIER_ORDER[number]))
);
