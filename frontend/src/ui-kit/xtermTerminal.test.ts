import { describe, expect, it } from 'vitest';
import { gonaviXtermTheme } from './xtermTerminal';

describe('xterm theme', () => {
  it('uses distinct light and dark palettes', () => {
    expect(gonaviXtermTheme(true).background).toBe('#0d1117');
    expect(gonaviXtermTheme(false).background).toBe('#ffffff');
    expect(gonaviXtermTheme(true).foreground).not.toBe(gonaviXtermTheme(false).foreground);
  });
});
