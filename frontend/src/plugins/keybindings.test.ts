import { describe, expect, it } from 'vitest';
import { matchPluginKeybinding, parsePluginKeybinding } from './keybindings';

describe('plugin keybindings', () => {
  it('maps CmdOrCtrl to Meta on macOS and Ctrl elsewhere', () => {
    const mac = parsePluginKeybinding('CmdOrCtrl+Shift+T', true);
    const other = parsePluginKeybinding('CmdOrCtrl+Shift+T', false);
    expect(mac).toEqual({ key: 't', ctrl: false, meta: true, shift: true, alt: false });
    expect(other).toEqual({ key: 't', ctrl: true, meta: false, shift: true, alt: false });
  });

  it('rejects unknown modifiers and malformed keys', () => {
    expect(parsePluginKeybinding('Hyper+T', true)).toBeNull();
    expect(parsePluginKeybinding('Ctrl+', true)).toBeNull();
    expect(parsePluginKeybinding('Ctrl+F1', true)).toMatchObject({ key: 'f1' });
  });

  it('matches modifiers exactly', () => {
    const matcher = parsePluginKeybinding('Cmd+T', true)!;
    expect(matchPluginKeybinding({ key: 't', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }, matcher)).toBe(true);
    expect(matchPluginKeybinding({ key: 't', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, matcher)).toBe(false);
    expect(matchPluginKeybinding({ key: 't', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false }, matcher)).toBe(false);
  });
});
