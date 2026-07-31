import { describe, expect, it } from 'vitest';

import { resolveV2SelectedDatabaseName } from './sidebarV2Utils';

describe('resolveV2SelectedDatabaseName', () => {
  it('keeps a selected database only when it belongs to the active connection', () => {
    expect(resolveV2SelectedDatabaseName({
      activeConnectionId: 'conn-local',
      activeContextConnectionId: 'conn-local',
      activeContextDbName: 'reporting',
    })).toBe('reporting');

    expect(resolveV2SelectedDatabaseName({
      activeConnectionId: 'conn-local',
      activeContextConnectionId: 'conn-other',
      activeContextDbName: 'analytics',
    })).toBe('');
  });

  it('does not bind a connection-level query to an empty selected database', () => {
    expect(resolveV2SelectedDatabaseName({
      activeConnectionId: 'conn-local',
      activeContextConnectionId: 'conn-local',
      activeContextDbName: '   ',
    })).toBe('');
  });
});
