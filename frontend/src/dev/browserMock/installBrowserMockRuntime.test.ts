import { describe, expect, it } from 'vitest';
import { shouldInstallBrowserMockScriptWorkbench } from './installBrowserMockRuntime';

describe('browser mock script workbench installation', () => {
  it('only installs script demo bindings when App and AI bindings are both absent', () => {
    expect(shouldInstallBrowserMockScriptWorkbench(false, false)).toBe(true);
    expect(shouldInstallBrowserMockScriptWorkbench(true, false)).toBe(false);
    expect(shouldInstallBrowserMockScriptWorkbench(false, true)).toBe(false);
    expect(shouldInstallBrowserMockScriptWorkbench(true, true)).toBe(false);
  });
});
