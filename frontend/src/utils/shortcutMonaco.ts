import type { ShortcutPlatform } from './shortcutDefinitions';
import { normalizeShortcutCombo } from './shortcutKeyboard';

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
  '/':            (kc) => kc.Slash,
  ',':            (kc) => kc.Comma,
  '-':            (kc) => kc.Minus,
  '=':            (kc) => kc.Equal,
  '.':            (kc) => kc.Period,
  ';':            (kc) => kc.Semicolon,
  "'":            (kc) => kc.Quote,
  '[':            (kc) => kc.BracketLeft,
  ']':            (kc) => kc.BracketRight,
  '\\':           (kc) => kc.Backslash,
  '`':            (kc) => kc.Backquote,
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
