import { describe, expect, it } from 'vitest';

import type { SavedConnection, TabData } from '../types';
import { clearSidebarHostConnectionState } from '../components/sidebar/sidebarHelpers';
import {
  mergeTitlebarSidebarSnapshot,
  resolveTitlebarConnectionStatus,
  resolveTitlebarContext,
  updateTitlebarSidebarSelection,
} from './titlebarContext';

const localConnection: SavedConnection = {
  id: 'local',
  name: '本地',
  config: {
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    database: 'missav_bot',
  },
};

const otherConnection: SavedConnection = {
  id: 'other',
  name: '测试库',
  config: {
    type: 'postgresql',
    host: 'db.example.test',
    port: 5432,
    user: 'postgres',
    database: 'analytics',
  },
};

const makeTableTab = (overrides: Partial<TabData> = {}): TabData => ({
  id: 'messages',
  title: 'messages',
  type: 'table',
  connectionId: 'local',
  dbName: 'missav_bot',
  tableName: 'messages',
  ...overrides,
});

describe('resolveTitlebarContext', () => {
  it('prefers the current Sidebar selection over an unrelated active tab', () => {
    const context = resolveTitlebarContext({
      activeContext: { connectionId: 'other', dbName: 'analytics' },
      sidebarContext: { connectionId: 'local', dbName: 'missav_bot', sidebarStateKey: 'local' },
      activeTab: makeTableTab({
        connectionId: 'other',
        dbName: 'analytics',
        tableName: 'events',
      }),
      connections: [localConnection, otherConnection],
    });

    expect(context).toMatchObject({
      connectionId: 'local',
      connectionName: '本地',
      databaseName: 'missav_bot',
      tableName: '',
      sidebarStateKey: 'local',
    });
  });

  it('shows the selected Host and matching active database and table', () => {
    const context = resolveTitlebarContext({
      activeContext: { connectionId: 'local', dbName: 'missav_bot' },
      activeTab: makeTableTab(),
      connections: [localConnection, otherConnection],
    });

    expect(context).toMatchObject({
      connectionId: 'local',
      connectionName: '本地',
      hostSummary: '127.0.0.1',
      databaseName: 'missav_bot',
      tableName: 'messages',
      sidebarStateKey: '',
    });
  });

  it('keeps a newly selected database but hides a table from a different active tab', () => {
    const context = resolveTitlebarContext({
      activeContext: { connectionId: 'local', dbName: 'information_schema' },
      activeTab: makeTableTab(),
      connections: [localConnection],
    });

    expect(context.databaseName).toBe('information_schema');
    expect(context.tableName).toBe('');
  });

  it('uses the selected table before an older active tab from the same database', () => {
    const context = resolveTitlebarContext({
      activeContext: {
        connectionId: 'local',
        dbName: 'missav_bot',
        tableName: 'users',
      },
      activeTab: makeTableTab(),
      connections: [localConnection],
    });

    expect(context.tableName).toBe('users');
  });

  it('falls back to the active tab when no sidebar context is selected', () => {
    const context = resolveTitlebarContext({
      activeContext: null,
      activeTab: makeTableTab(),
      connections: [localConnection],
    });

    expect(context).toMatchObject({
      connectionId: 'local',
      databaseName: 'missav_bot',
      tableName: 'messages',
    });
  });

  it('does not display a table after selecting only its Host', () => {
    const context = resolveTitlebarContext({
      activeContext: { connectionId: 'local', dbName: '' },
      activeTab: makeTableTab(),
      connections: [localConnection],
    });

    expect(context.databaseName).toBe('');
    expect(context.tableName).toBe('');
  });

  it('stays empty when the selected connection no longer exists', () => {
    const context = resolveTitlebarContext({
      activeContext: { connectionId: 'deleted', dbName: 'gone' },
      activeTab: makeTableTab(),
      connections: [localConnection],
    });

    expect(context).toMatchObject({
      connection: null,
      connectionId: 'deleted',
      connectionName: '',
      hostSummary: '',
      databaseName: '',
      tableName: '',
    });
  });
});

describe('resolveTitlebarConnectionStatus', () => {
  it('returns idle when no connection is selected', () => {
    expect(resolveTitlebarConnectionStatus({ connectionId: '', hasConnection: false, connectionStates: {} })).toBe('idle');
  });

  it('returns idle when a Host id is selected but its connection is unavailable', () => {
    expect(resolveTitlebarConnectionStatus({
      connectionId: 'local',
      hasConnection: false,
      connectionStates: { local: 'success' },
    })).toBe('idle');
  });

  it('returns default when a Host is selected without a Sidebar result', () => {
    expect(resolveTitlebarConnectionStatus({ connectionId: 'local', hasConnection: true, connectionStates: {} })).toBe('default');
  });

  it('preserves the Sidebar loading state for the selected connection', () => {
    expect(resolveTitlebarConnectionStatus({
      connectionId: 'local',
      hasConnection: true,
      connectionStates: { local: 'loading' },
    })).toBe('loading');
  });

  it('follows the Host state when a database row has a different transient state', () => {
    expect(resolveTitlebarConnectionStatus({
      connectionId: 'local',
      hasConnection: true,
      connectionStates: {
        local: 'success',
        'local-missav_bot': 'loading',
      },
    })).toBe('success');
  });

  it('does not infer a Host connection from a selected row state', () => {
    expect(resolveTitlebarConnectionStatus({
      connectionId: 'local',
      hasConnection: true,
      connectionStates: { 'local-missav_bot': 'loading' },
    })).toBe('default');
  });

  it('follows a successful Sidebar Host metadata load', () => {
    expect(resolveTitlebarConnectionStatus({
      connectionId: 'local',
      hasConnection: true,
      connectionStates: { local: 'success' },
    })).toBe('success');
  });

  it('clears a stale Host result from the titlebar snapshot on reselection', () => {
    const snapshot = {
      selection: { connectionId: 'local', dbName: '', sidebarStateKey: 'local' },
      connectionStates: { local: 'success' as const },
    };
    const clearedSnapshot = {
      ...snapshot,
      connectionStates: clearSidebarHostConnectionState(snapshot.connectionStates, 'local'),
    };

    expect(clearedSnapshot.selection).toEqual(snapshot.selection);
    expect(resolveTitlebarConnectionStatus({
      connectionId: clearedSnapshot.selection.connectionId,
      sidebarStateKey: clearedSnapshot.selection.sidebarStateKey,
      hasConnection: true,
      connectionStates: clearedSnapshot.connectionStates,
    })).toBe('default');
  });

  it('keeps an in-flight Host loading state when the row is selected again', () => {
    const states = { local: 'loading' as const };
    expect(clearSidebarHostConnectionState(states, 'local')).toBe(states);
    expect(resolveTitlebarConnectionStatus({
      connectionId: 'local',
      hasConnection: true,
      connectionStates: states,
    })).toBe('loading');
  });


  it('ignores a child-row state key when it is not the Host key', () => {
    expect(resolveTitlebarConnectionStatus({
      connectionId: 'local',
      sidebarStateKey: 'local-missav_bot',
      hasConnection: true,
      connectionStates: {
        local: 'success',
        'local-missav_bot': 'loading',
      },
    })).toBe('success');
  });

  it('maps a failed Sidebar load to error and ignores another connection', () => {
    expect(resolveTitlebarConnectionStatus({
      connectionId: 'local',
      hasConnection: true,
      connectionStates: { other: 'error' },
    })).toBe('default');
    expect(resolveTitlebarConnectionStatus({
      connectionId: 'local',
      hasConnection: true,
      connectionStates: { local: 'error' },
    })).toBe('error');
  });
});

describe('updateTitlebarSidebarSelection', () => {
  it('changes the selected row without dropping the latest Host state', () => {
    const snapshot = {
      selection: { connectionId: 'local', dbName: '', sidebarStateKey: 'local' },
      connectionStates: { local: 'success' as const },
    };

    expect(updateTitlebarSidebarSelection(snapshot, {
      connectionId: 'other',
      dbName: '',
      sidebarStateKey: 'other',
    })).toEqual({
      selection: { connectionId: 'other', dbName: '', sidebarStateKey: 'other' },
      connectionStates: { local: 'success' },
    });
  });

  it('returns a functional update that preserves a newer Host state map', () => {
    const update = updateTitlebarSidebarSelection({
      connectionId: 'other',
      dbName: 'analytics',
      sidebarStateKey: 'other',
    });
    expect(typeof update).toBe('function');
    expect(update({
      selection: { connectionId: 'local', dbName: '', sidebarStateKey: 'local' },
      connectionStates: { other: 'loading' },
    })).toEqual({
      selection: { connectionId: 'other', dbName: 'analytics', sidebarStateKey: 'other' },
      connectionStates: { other: 'loading' },
    });
  });
});

describe('mergeTitlebarSidebarSnapshot', () => {
  it('rejects an older render after the selected Host changes', () => {
    const current = {
      selection: { connectionId: 'host-b', dbName: '', sidebarStateKey: 'host-b' },
      connectionStates: { 'host-b': 'loading' as const },
      revision: 8,
    };
    const stale = {
      selection: { connectionId: 'host-a', dbName: '', sidebarStateKey: 'host-a' },
      connectionStates: { 'host-a': 'success' as const },
      revision: 7,
    };

    expect(mergeTitlebarSidebarSnapshot(current, stale)).toBe(current);
    expect(resolveTitlebarConnectionStatus({
      connectionId: current.selection.connectionId,
      sidebarStateKey: current.selection.sidebarStateKey,
      hasConnection: true,
      connectionStates: current.connectionStates,
    })).toBe('loading');
  });

  it('accepts the newest complete snapshot and preserves both Host states', () => {
    const current = {
      selection: { connectionId: 'host-a', dbName: '', sidebarStateKey: 'host-a' },
      connectionStates: { 'host-a': 'success' as const },
      revision: 3,
    };
    const next = {
      selection: { connectionId: 'host-b', dbName: '', sidebarStateKey: 'host-b' },
      connectionStates: {
        'host-a': 'success' as const,
        'host-b': 'loading' as const,
      },
      revision: 4,
    };

    const merged = mergeTitlebarSidebarSnapshot(current, next);
    expect(merged).toBe(next);
    expect(resolveTitlebarConnectionStatus({
      connectionId: merged.selection?.connectionId,
      sidebarStateKey: merged.selection?.sidebarStateKey,
      hasConnection: true,
      connectionStates: merged.connectionStates,
    })).toBe('loading');
  });
});
