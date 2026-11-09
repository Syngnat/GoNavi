import { describe, expect, it } from 'vitest';
import {
  LEGACY_LOCAL_STORAGE_MARKER,
  LEGACY_PERSIST_STORAGE_KEY,
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

const response = (items: Record<string, string>, hasSavedConnections = false) => JSON.stringify({
  found: true,
  items,
  hasSavedConnections,
});

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
    }));

    expect(migrated).toBe(true);
    expect(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)).toContain('legacy');
    expect(storage.getItem('gonavi-background-image-v1')).toContain('version');
    expect(storage.getItem(LEGACY_LOCAL_STORAGE_MARKER)).toBe('1');
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
    }));

    expect(storage.getItem(LEGACY_PERSIST_STORAGE_KEY)).toBe(current);
    expect(storage.getItem('gonavi-background-image-v1')).toContain('version');
  });

  it('does not overwrite keys that already exist and writes the marker once', () => {
    const storage = new MemoryStorage();
    storage.setItem('gonavi-background-image-v1', 'current');

    let calls = 0;
    const transport = () => {
      calls += 1;
      return response({
        [LEGACY_PERSIST_STORAGE_KEY]: JSON.stringify({ state: { themePreference: 'dark' } }),
        'gonavi-background-image-v1': 'legacy',
      });
    };

    expect(migrateLegacyLocalStorage(storage, transport)).toBe(true);
    expect(storage.getItem('gonavi-background-image-v1')).toBe('current');
    expect(migrateLegacyLocalStorage(storage, transport)).toBe(false);
    expect(calls).toBe(1);
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
    }, true));

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
    }));

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
});
