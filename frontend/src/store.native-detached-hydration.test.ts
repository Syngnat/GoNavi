import { afterEach, describe, expect, it, vi } from 'vitest';

describe('native detached store startup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('skips persisted main-window hydration before bootstrap state arrives', async () => {
    const getItem = vi.fn(() => JSON.stringify({
      state: { tabs: [{ id: 'stale-main-tab', type: 'query' }] },
      version: 7,
    }));
    vi.stubGlobal('window', {
      __GONAVI_DETACHED__: { active: true },
      location: { pathname: '/', search: '' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('localStorage', {
      getItem,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.resetModules();

    const { useStore } = await import('./store');

    expect(getItem).not.toHaveBeenCalled();
    expect(useStore.persist.hasHydrated()).toBe(false);
    expect(useStore.getState().tabs).toEqual([]);
  }, 30000);
});
