import { describe, expect, it } from 'vitest';

import {
  resolveSidebarTitlebarObjectName,
  shouldDeferSidebarTitlebarSelection,
} from './sidebarHelpers';
import { resolveTitlebarConnectionStatus } from '../../utils/titlebarContext';

describe('resolveSidebarTitlebarObjectName', () => {
  it.each([
    [{
      type: 'db-trigger',
      title: 'TRG_AUDIT (orders)',
      dataRef: { triggerName: 'TRG_AUDIT', tableName: 'orders' },
    }, 'TRG_AUDIT'],
    [{
      type: 'routine',
      title: '[P] refresh_stats',
      dataRef: { routineName: 'refresh_stats' },
    }, 'refresh_stats'],
    [{
      type: 'db-event',
      title: 'nightly_cleanup',
      dataRef: { eventName: 'nightly_cleanup' },
    }, 'nightly_cleanup'],
    [{
      type: 'sequence',
      title: 'order_id_seq',
      dataRef: { sequenceName: 'order_id_seq' },
    }, 'order_id_seq'],
    [{
      type: 'package',
      title: 'PKG_ORDERS',
      dataRef: { packageName: 'PKG_ORDERS' },
    }, 'PKG_ORDERS'],
  ])('uses the selected object name for compact context', (node, expectedName) => {
    expect(resolveSidebarTitlebarObjectName(node)).toBe(expectedName);
  });

  it('keeps the exact message object name used by the sidebar', () => {
    expect(resolveSidebarTitlebarObjectName({
      type: 'message-object',
      title: 'Telemetry',
      dataRef: {
        messageObjectName: 'devices/+/telemetry',
      },
    })).toBe('devices/+/telemetry');
  });

  it.each(['object-group', 'schema', 'queries-folder', 'nacos-namespace'])
    ('does not treat %s rows as a table context', (type) => {
      expect(resolveSidebarTitlebarObjectName({
        type,
        title: '表',
        dataRef: { tableName: 'stale_table' },
      })).toBe('');
    });

  it('treats a reselected Host as default until a new load result arrives', () => {
    const previouslyLoadedHost = {
      key: 'local',
      type: 'connection',
      children: [{ key: 'local-main', type: 'database' }],
    };
    expect(resolveTitlebarConnectionStatus({
      connectionId: previouslyLoadedHost.key,
      sidebarStateKey: previouslyLoadedHost.key,
      hasConnection: true,
      connectionStates: {},
    })).toBe('default');
  });
});

describe('shouldDeferSidebarTitlebarSelection', () => {
  it('does not defer when the selected node is available', () => {
    expect(shouldDeferSidebarTitlebarSelection({
      selectedKey: 'local-missav_bot',
      selectedNode: { key: 'local-missav_bot' },
      connectionIds: ['local'],
    })).toBe(false);
  });

  it('does not defer an empty selection so it can clear the snapshot', () => {
    expect(shouldDeferSidebarTitlebarSelection({
      selectedKey: '',
      selectedNode: null,
      connectionIds: ['local'],
    })).toBe(false);
  });

  it.each([
    'local',
    'local-missav_bot-table-messages',
  ])('defers a temporarily missing Host or descendant key: %s', (selectedKey) => {
    expect(shouldDeferSidebarTitlebarSelection({
      selectedKey,
      selectedNode: undefined,
      connectionIds: ['local'],
    })).toBe(true);
  });

  it('allows clearing a key whose Host was removed', () => {
    expect(shouldDeferSidebarTitlebarSelection({
      selectedKey: 'deleted-missav_bot',
      selectedNode: null,
      connectionIds: ['local'],
    })).toBe(false);
  });
});
