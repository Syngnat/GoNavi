export interface GonaviKeybindingMatcher {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * Parses `CmdOrCtrl+Shift+T` into a platform-aware matcher. CmdOrCtrl becomes
 * Meta on macOS and Ctrl elsewhere; unknown modifiers yield null so a typo can
 * never register a shortcut that fires for the wrong keys.
 */
export function parsePluginKeybinding(keys: string, isMac: boolean): GonaviKeybindingMatcher | null {
  const rawParts = keys.split('+');
  if (rawParts.length === 0 || rawParts.length > 5) return null;
  const parts = rawParts.map((part) => part.trim());
  if (parts.some((part) => part === '')) return null;
  const main = parts.pop();
  if (!main || !/^[A-Za-z0-9]{1,16}$/.test(main)) return null;
  if (['CmdOrCtrl', 'Ctrl', 'Cmd', 'Alt', 'Shift'].includes(main)) return null;
  const matcher: GonaviKeybindingMatcher = { key: main.toLowerCase(), ctrl: false, meta: false, shift: false, alt: false };
  for (const part of parts) {
    switch (part) {
      case 'CmdOrCtrl': if (isMac) matcher.meta = true; else matcher.ctrl = true; break;
      case 'Cmd': matcher.meta = true; break;
      case 'Ctrl': matcher.ctrl = true; break;
      case 'Alt': matcher.alt = true; break;
      case 'Shift': matcher.shift = true; break;
      default: return null;
    }
  }
  return matcher;
}

export interface GonaviKeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Exact modifier match: a Ctrl binding never fires for Cmd, and vice versa. */
export function matchPluginKeybinding(event: GonaviKeyEventLike, matcher: GonaviKeybindingMatcher): boolean {
  return event.key.toLowerCase() === matcher.key
    && event.ctrlKey === matcher.ctrl
    && event.metaKey === matcher.meta
    && event.shiftKey === matcher.shift
    && event.altKey === matcher.alt;
}
