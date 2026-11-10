import { describe, expect, it } from 'vitest';
import {
  LEGACY_LOCAL_STORAGE_MARKER,
  LEGACY_LOCAL_STORAGE_MARKER_VERSION,
  LEGACY_PERSIST_STORAGE_KEY,
  isLegacyV2LocalStorageOrigin,
  legacyPersistDigest,
  migrateLegacyLocalStorage,
  shouldReplacePersistedSettings,
  stripBackendOwnedPersistedState,
} from './legacyLocalStorageMigration';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const response = (items: Record<string, string>, hasSavedConnections = false, fingerprint = '') => JSON.stringify({
  found: true,
  items,
  hasSavedConnections,
  source: 'test-source',
  fingerprint,
});

const markerOf = (storage: MemoryStorage): Record<string, unknown> => {
  const raw = storage.getItem(LEGACY_LOCAL_STORAGE_MARKER);
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
};

describe('legacyLocalStorageMigration', () => {
  it('restores the legacy persist payload when the current state is still default', () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_PERSIST_STORAGE_KEY, JSON.stringify({
      state: { connections: [], tabs: [], themePreference: 'system' },
    }));

    const migrated = migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: JSON.stringify({
        state: { connections: [{ id: 'legacy' }], themePreference: 'dark' },
      }),
      'gonavi-background-image-v1': JSON.stringify({ version: 1 }),
    }, false, 'fp-1'));

    expect(migrated).toBe(true);
    expect(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)).toContain('legacy');
    expect(storage.getItem('gonavi-background-image-v1')).toContain('version');
    const marker = markerOf(storage);
    expect(marker.version).toBe(LEGACY_LOCAL_STORAGE_MARKER_VERSION);
    expect(marker.fingerprint).toBe('fp-1');
    expect(marker.importedDigest).toBe(legacyPersistDigest(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)));
  });

  it('keeps settings that a v3 user already changed', () => {
    const storage = new MemoryStorage();
    const current = JSON.stringify({
      state: { connections: [{ id: 'current' }], themePreference: 'dark' },
    });
    storage.setItem(LEGACY_PERSIST_STORAGE_KEY, current);

    migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: JSON.stringify({
        state: { connections: [{ id: 'legacy' }], themePreference: 'light' },
      }),
      'gonavi-background-image-v1': JSON.stringify({ version: 1 }),
    }, false, 'fp-1'));

    expect(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)).toBe(current);
    expect(storage.getItem('gonavi-background-image-v1')).toContain('version');
  });

  it('does not overwrite existing keys and stops at the unchanged source', () => {
    const storage = new MemoryStorage();
    storage.setItem('gonavi-background-image-v1', 'current');

    let calls = 0;
    const transport = () => {
      calls += 1;
      return response({
        [LEGACY_PERSIST_STORAGE_KEY]: JSON.stringify({ state: { themePreference: 'dark' } }),
        'gonavi-background-image-v1': 'legacy',
      }, false, 'fp-1');
    };

    expect(migrateLegacyLocalStorage(storage, transport)).toBe(true);
    expect(storage.getItem('gonavi-background-image-v1')).toBe('current');
    expect(migrateLegacyLocalStorage(storage, transport)).toBe(false);
    expect(calls).toBe(2);
    expect(storage.getItem('gonavi-background-image-v1')).toBe('current');
    expect(markerOf(storage).version).toBe(LEGACY_LOCAL_STORAGE_MARKER_VERSION);
  });

  it('does not mark a failed request as migrated', () => {
    const storage = new MemoryStorage();
    expect(migrateLegacyLocalStorage(storage, () => null)).toBe(false);
    expect(storage.getItem(LEGACY_LOCAL_STORAGE_MARKER)).toBeNull();
  });

  it('treats an empty or default current payload as replaceable', () => {
    expect(shouldReplacePersistedSettings(null, '{}')).toBe(true);
    expect(shouldReplacePersistedSettings(
      JSON.stringify({ state: { connections: [], themePreference: 'system', languagePreference: 'auto' } }),
      '{}',
    )).toBe(true);
    // "light" is the persisted default, not a user choice.
    expect(shouldReplacePersistedSettings(
      JSON.stringify({ state: { connections: [], theme: 'light', themePreference: 'light', languagePreference: 'auto' } }),
      '{}',
    )).toBe(true);
  });

  it('treats a current payload with user data as authoritative', () => {
    expect(shouldReplacePersistedSettings(
      JSON.stringify({ state: { connections: [{ id: 'current' }] } }),
      '{}',
    )).toBe(false);
    expect(shouldReplacePersistedSettings(
      JSON.stringify({ state: { themePreference: 'dark' } }),
      '{}',
    )).toBe(false);
    expect(shouldReplacePersistedSettings(
      JSON.stringify({ state: { aiChatHistory: { session: {} } } }),
      '{}',
    )).toBe(false);
  });

  it('restores legacy connections even when the current profile already has a custom theme', () => {
    const legacy = JSON.stringify({
      state: { connections: [{ id: 'legacy' }], themePreference: 'dark' },
    });
    expect(shouldReplacePersistedSettings(
      JSON.stringify({ state: { connections: [], themePreference: 'dark' } }),
      legacy,
    )).toBe(true);
  });

  it('keeps current connections when both profiles already have them', () => {
    const legacy = JSON.stringify({
      state: { connections: [{ id: 'legacy' }] },
    });
    expect(shouldReplacePersistedSettings(
      JSON.stringify({ state: { connections: [{ id: 'current' }] } }),
      legacy,
    )).toBe(false);
  });

  it('restores only UI settings when the v3 backend already owns connections', () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_PERSIST_STORAGE_KEY, JSON.stringify({
      state: { connections: [], themePreference: 'light' },
    }));

    const migrated = migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: JSON.stringify({
        state: {
          connections: [{ id: 'legacy' }],
          globalProxy: { enabled: true, host: 'proxy.local' },
          themePreference: 'dark',
          tabs: [{ id: 'legacy-tab' }],
        },
      }),
    }, true, 'fp-1'));

    expect(migrated).toBe(true);
    const restored = JSON.parse(storage.getItem(LEGACY_PERSIST_STORAGE_KEY) ?? '{}') as {
      state?: Record<string, unknown>;
    };
    expect(restored.state?.themePreference).toBe('dark');
    expect(restored.state?.tabs).toEqual([{ id: 'legacy-tab' }]);
    expect(restored.state).not.toHaveProperty('connections');
    expect(restored.state).not.toHaveProperty('globalProxy');
  });

  it('keeps legacy connections when the backend has no saved connections yet', () => {
    const storage = new MemoryStorage();
    const migrated = migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: JSON.stringify({
        state: { connections: [{ id: 'legacy' }], themePreference: 'dark' },
      }),
    }, false, 'fp-1'));

    expect(migrated).toBe(true);
    expect(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)).toContain('legacy');
  });

  it('strips backend-owned fields without disturbing other state', () => {
    const stripped = JSON.parse(stripBackendOwnedPersistedState(JSON.stringify({
      state: {
        connections: [{ id: 'legacy' }],
        globalProxy: { enabled: true },
        themePreference: 'dark',
      },
    }))) as { state?: Record<string, unknown> };
    expect(stripped.state).toEqual({ themePreference: 'dark' });
  });

  it('is a no-op when the legacy source fingerprint is unchanged', () => {
    const storage = new MemoryStorage();
    const legacy = JSON.stringify({ state: { themePreference: 'dark' } });
    expect(migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: legacy,
    }, false, 'fp-1'))).toBe(true);
    const imported = storage.getItem(LEGACY_PERSIST_STORAGE_KEY);

    expect(migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: legacy,
    }, false, 'fp-1'))).toBe(false);
    expect(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)).toBe(imported);
  });

  it('re-imports after a v2 rollback when the v3 profile was not edited', () => {
    const storage = new MemoryStorage();
    const first = JSON.stringify({ state: { themePreference: 'dark', sidebarWidth: 460 } });
    expect(migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: first,
    }, false, 'fp-1'))).toBe(true);

    const second = JSON.stringify({ state: { themePreference: 'light', sidebarWidth: 500 } });
    expect(migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: second,
    }, false, 'fp-2'))).toBe(true);
    expect(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)).toContain('500');
    expect(markerOf(storage).fingerprint).toBe('fp-2');
  });

  it('keeps v3 edits when the legacy source changed meanwhile', () => {
    const storage = new MemoryStorage();
    const first = JSON.stringify({ state: { themePreference: 'dark', sidebarWidth: 460 } });
    migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: first,
    }, false, 'fp-1'));

    const edited = JSON.stringify({ state: { themePreference: 'dark', sidebarWidth: 520 } });
    storage.setItem(LEGACY_PERSIST_STORAGE_KEY, edited);
    expect(migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: JSON.stringify({ state: { themePreference: 'light', sidebarWidth: 500 } }),
    }, false, 'fp-2'))).toBe(false);
    expect(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)).toBe(edited);
  });

  it('upgrades the one-shot marker and re-imports after a later rollback when the profile still matches', () => {
    const storage = new MemoryStorage();
    const current = JSON.stringify({ state: { themePreference: 'dark', sidebarWidth: 500 } });
    storage.setItem(LEGACY_PERSIST_STORAGE_KEY, current);
    storage.setItem(LEGACY_LOCAL_STORAGE_MARKER, '1');

    expect(migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: current,
    }, false, 'fp-1'))).toBe(false);
    expect(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)).toBe(current);
    const marker = markerOf(storage);
    expect(marker.version).toBe(LEGACY_LOCAL_STORAGE_MARKER_VERSION);
    expect(marker.importedDigest).toBe(legacyPersistDigest(current));

    // The user runs v2 again, changes settings, and upgrades again. The v3
    // profile still equals the imported payload, so the newer v2 store wins.
    expect(migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: JSON.stringify({ state: { themePreference: 'light', sidebarWidth: 540 } }),
    }, false, 'fp-2'))).toBe(true);
    expect(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)).toContain('540');
  });

  it('does not enable auto re-import when the one-shot marker predates v3 edits', () => {
    const storage = new MemoryStorage();
    const edited = JSON.stringify({ state: { themePreference: 'dark', sidebarWidth: 520 } });
    storage.setItem(LEGACY_PERSIST_STORAGE_KEY, edited);
    storage.setItem(LEGACY_LOCAL_STORAGE_MARKER, '1');

    expect(migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: JSON.stringify({ state: { themePreference: 'light', sidebarWidth: 500 } }),
    }, false, 'fp-1'))).toBe(false);
    expect(markerOf(storage).importedDigest).toBe('');

    expect(migrateLegacyLocalStorage(storage, () => response({
      [LEGACY_PERSIST_STORAGE_KEY]: JSON.stringify({ state: { themePreference: 'light', sidebarWidth: 540 } }),
    }, false, 'fp-2'))).toBe(false);
    expect(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)).toBe(edited);
  });

  it('changes the persisted digest when the payload changes', () => {
    expect(legacyPersistDigest(null)).toBe('');
    expect(legacyPersistDigest('same')).toBe(legacyPersistDigest('same'));
    expect(legacyPersistDigest('same')).not.toBe(legacyPersistDigest('different'));
  });

  it('recognises the v2 origins that current v3 now pins', () => {
    expect(isLegacyV2LocalStorageOrigin('wails://wails')).toBe(true);
    expect(isLegacyV2LocalStorageOrigin('wails://wails/')).toBe(true);
    expect(isLegacyV2LocalStorageOrigin('http://wails.localhost')).toBe(true);
    expect(isLegacyV2LocalStorageOrigin('wails://localhost')).toBe(false);
    expect(isLegacyV2LocalStorageOrigin('http://wails.localhost:9245')).toBe(false);
    expect(isLegacyV2LocalStorageOrigin(undefined)).toBe(false);
  });

  it('does not migrate a v3 window already running on the v2 origin', () => {
    const storage = new MemoryStorage();
    const current = JSON.stringify({ state: { themePreference: 'dark', sidebarWidth: 460 } });
    storage.setItem(LEGACY_PERSIST_STORAGE_KEY, current);
    let calls = 0;

    const migrated = migrateLegacyLocalStorage(storage, () => {
      calls += 1;
      return response({ [LEGACY_PERSIST_STORAGE_KEY]: current }, false, 'fp-1');
    }, 'wails://wails');

    expect(migrated).toBe(false);
    expect(calls).toBe(0);
    expect(storage.getItem(LEGACY_LOCAL_STORAGE_MARKER)).toBeNull();
  });
});
