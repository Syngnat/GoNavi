import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage implements Storage {
  data = new Map<string, string>();
  failWrites = false;
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    this.data.set(key, String(value));
  }
}

const importThemeStore = async () => import('./customThemeStore');

describe('custom theme store', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('imports, selects, updates, persists and removes custom themes independently', async () => {
    let module = await importThemeStore();
    const imported = module.useCustomThemeStore.getState().importCustomTheme({
      name: 'Purple Night',
      sourceFileName: 'purple.css',
      baseMode: 'dark',
      css: 'body[data-custom-theme] { --gn-accent: #8b5cf6; }',
    });
    expect(imported.ok).toBe(true);
    const themeId = imported.ok ? imported.theme?.id : undefined;
    expect(themeId).toBeTruthy();
    expect(module.useCustomThemeStore.getState().activeThemeId).toBeNull();

    expect(module.useCustomThemeStore.getState().selectCustomTheme(themeId!)).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(module.useCustomThemeStore.getState().updateCustomTheme(themeId!, { baseMode: 'system' })).toEqual(
      expect.objectContaining({ ok: true }),
    );

    vi.resetModules();
    module = await importThemeStore();
    expect(module.useCustomThemeStore.getState().activeThemeId).toBe(themeId);
    expect(module.useCustomThemeStore.getState().themes[0].baseMode).toBe('system');

    expect(module.useCustomThemeStore.getState().removeCustomTheme(themeId!)).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(module.useCustomThemeStore.getState().themes).toEqual([]);
    expect(module.useCustomThemeStore.getState().activeThemeId).toBeNull();
  });

  it('selects and restores built-in themes without consuming the custom theme quota', async () => {
    let module = await importThemeStore();
    const selected = module.useCustomThemeStore.getState().selectCustomTheme('builtin-comfort-dark');
    expect(selected).toEqual(expect.objectContaining({
      ok: true,
      theme: expect.objectContaining({
        id: 'builtin-comfort-dark',
        baseMode: 'dark',
      }),
    }));
    expect(module.useCustomThemeStore.getState().themes).toEqual([]);
    expect(module.useCustomThemeStore.getState().activeThemeId).toBe('builtin-comfort-dark');

    const imported = module.useCustomThemeStore.getState().importCustomTheme({
      name: 'User while built-in is active',
      sourceFileName: 'user.css',
      css: 'body { color: red; }',
    });
    expect(imported.ok).toBe(true);
    const userThemeId = imported.ok ? imported.theme?.id : '';
    expect(module.useCustomThemeStore.getState().activeThemeId).toBe('builtin-comfort-dark');
    expect(module.useCustomThemeStore.getState().removeCustomTheme(userThemeId!)).toEqual({ ok: true });
    expect(module.useCustomThemeStore.getState().activeThemeId).toBe('builtin-comfort-dark');

    vi.resetModules();
    module = await importThemeStore();
    expect(module.useCustomThemeStore.getState().themes).toEqual([]);
    expect(module.useCustomThemeStore.getState().activeThemeId).toBe('builtin-comfort-dark');

    storage.clear();
    module.useCustomThemeStore.getState().reloadCustomThemes();
    expect(module.useCustomThemeStore.getState().activeThemeId).toBeNull();
  });

  it('reserves built-in IDs when hydrating untrusted user theme data', async () => {
    storage.setItem('gonavi-custom-themes-v1', JSON.stringify({
      version: 1,
      activeThemeId: 'builtin-warm-paper',
      themes: [{
        schemaVersion: 1,
        id: 'builtin-warm-paper',
        name: 'Shadow copy',
        sourceFileName: 'shadow.css',
        baseMode: 'dark',
        css: 'body { color: red; }',
        createdAt: 1,
        updatedAt: 1,
      }],
    }));
    const { useCustomThemeStore } = await importThemeStore();
    expect(useCustomThemeStore.getState().themes).toEqual([]);
    expect(useCustomThemeStore.getState().activeThemeId).toBe('builtin-warm-paper');
    expect(useCustomThemeStore.getState().selectCustomTheme('builtin-warm-paper')).toEqual(
      expect.objectContaining({
        ok: true,
        theme: expect.objectContaining({ name: 'Warm Paper', baseMode: 'light' }),
      }),
    );
  });

  it('drops an invalid persisted active id and unsafe persisted CSS', async () => {
    storage.setItem('gonavi-custom-themes-v1', JSON.stringify({
      version: 1,
      activeThemeId: 'missing',
      themes: [
        {
          schemaVersion: 1,
          id: 'unsafe-theme',
          name: 'Unsafe',
          sourceFileName: 'unsafe.css',
          baseMode: 'dark',
          css: 'body { background: url(https://example.com/pixel); }',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }));
    const { useCustomThemeStore } = await importThemeStore();
    expect(useCustomThemeStore.getState().themes).toEqual([]);
    expect(useCustomThemeStore.getState().activeThemeId).toBeNull();
  });

  it('does not interpret a future persisted schema as the current format', async () => {
    storage.setItem('gonavi-custom-themes-v1', JSON.stringify({
      version: 2,
      activeThemeId: 'theme-future',
      themes: [{
        schemaVersion: 2,
        id: 'theme-future',
        name: 'Future',
        sourceFileName: 'future.css',
        baseMode: 'dark',
        css: 'body { color: red; }',
        createdAt: 1,
        updatedAt: 1,
      }],
    }));
    const { useCustomThemeStore } = await importThemeStore();
    expect(useCustomThemeStore.getState().themes).toEqual([]);
    expect(useCustomThemeStore.getState().activeThemeId).toBeNull();
  });

  it('reports storage failures without claiming that an import succeeded', async () => {
    storage.failWrites = true;
    const { useCustomThemeStore } = await importThemeStore();
    const result = useCustomThemeStore.getState().importCustomTheme({
      name: 'No space',
      sourceFileName: 'no-space.css',
      css: 'body { color: red; }',
    });
    expect(result).toEqual({ ok: false, reason: 'storage-failed' });
    expect(useCustomThemeStore.getState().themes).toEqual([]);
  });

  it('reports unavailable browser storage instead of creating a temporary theme', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', undefined);
    vi.resetModules();
    const { useCustomThemeStore } = await importThemeStore();
    const result = useCustomThemeStore.getState().importCustomTheme({
      name: 'Unavailable storage',
      sourceFileName: 'unavailable.css',
      css: 'body { color: red; }',
    });
    expect(result).toEqual({ ok: false, reason: 'storage-failed' });
    expect(useCustomThemeStore.getState().themes).toEqual([]);
  });

  it('keeps the in-memory escape hatch when persistence is unavailable', async () => {
    const { useCustomThemeStore } = await importThemeStore();
    const imported = useCustomThemeStore.getState().importCustomTheme({
      name: 'Escape hatch',
      sourceFileName: 'escape.css',
      css: 'body { color: red; }',
    });
    expect(imported.ok).toBe(true);
    const themeId = imported.ok ? imported.theme?.id : '';
    useCustomThemeStore.getState().selectCustomTheme(themeId!);
    storage.failWrites = true;
    const result = useCustomThemeStore.getState().selectCustomTheme(null);
    expect(result).toEqual({ ok: false, reason: 'storage-failed' });
    expect(useCustomThemeStore.getState().activeThemeId).toBeNull();
  });

  it('remembers the last theme per light / dark mode and restores it when switching modes', async () => {
    let module = await importThemeStore();
    const store = () => module.useCustomThemeStore.getState();
    store().selectCustomTheme('builtin-warm-paper');
    store().selectCustomTheme('builtin-nord-slate');
    expect(store().rememberedThemeIds).toEqual({ light: 'builtin-warm-paper', dark: 'builtin-nord-slate' });

    expect(store().activateRememberedCustomTheme('light')).toEqual(expect.objectContaining({ ok: true }));
    expect(store().activeThemeId).toBe('builtin-warm-paper');

    vi.resetModules();
    module = await importThemeStore();
    expect(store().rememberedThemeIds).toEqual({ light: 'builtin-warm-paper', dark: 'builtin-nord-slate' });
    store().activateRememberedCustomTheme('dark');
    expect(store().activeThemeId).toBe('builtin-nord-slate');

    store().activateRememberedCustomTheme('system');
    expect(store().activeThemeId).toBeNull();
    expect(store().rememberedThemeIds).toEqual({ light: 'builtin-warm-paper', dark: 'builtin-nord-slate' });
  });

  it('forgets a theme when the user explicitly returns to the base theme', async () => {
    const { useCustomThemeStore } = await importThemeStore();
    const store = () => useCustomThemeStore.getState();
    store().selectCustomTheme('builtin-warm-paper');
    store().selectCustomTheme('builtin-nord-slate');

    expect(store().deactivateCustomTheme()).toEqual({ ok: true });
    expect(store().activeThemeId).toBeNull();
    expect(store().rememberedThemeIds).toEqual({ light: 'builtin-warm-paper', dark: null });

    store().activateRememberedCustomTheme('dark');
    expect(store().activeThemeId).toBeNull();
  });

  it('corrects the memory when a remembered user theme is re-moded or removed', async () => {
    const { useCustomThemeStore } = await importThemeStore();
    const store = () => useCustomThemeStore.getState();
    const imported = store().importCustomTheme({
      name: 'Night',
      sourceFileName: 'night.css',
      baseMode: 'dark',
      css: 'body[data-custom-theme] { --gn-titlebar-icon-primary: #ff00aa; }',
    });
    const themeId = imported.ok ? imported.theme!.id : '';
    store().selectCustomTheme(themeId);
    expect(store().rememberedThemeIds.dark).toBe(themeId);

    store().updateCustomTheme(themeId, { baseMode: 'system' });
    expect(store().rememberedThemeIds.dark).toBeNull();

    store().updateCustomTheme(themeId, { baseMode: 'dark' });
    store().selectCustomTheme(themeId);
    store().removeCustomTheme(themeId);
    expect(store().rememberedThemeIds).toEqual({ light: null, dark: null });
  });

  it('drops persisted memory entries that no longer match an available theme mode', async () => {
    storage.setItem('gonavi-custom-themes-v1', JSON.stringify({
      version: 1,
      activeThemeId: null,
      themes: [],
      rememberedThemeIds: { light: 'builtin-nord-slate', dark: 'missing' },
    }));
    const { useCustomThemeStore } = await importThemeStore();
    expect(useCustomThemeStore.getState().rememberedThemeIds).toEqual({ light: null, dark: null });
  });
});
