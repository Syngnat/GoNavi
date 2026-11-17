import { afterEach, describe, expect, it } from 'vitest';

import { setCurrentLanguage, t } from '../i18n';
import { getTabDisplayKindLabel } from './tabDisplay';
import {
  buildDataSyncPasteWorkbenchTab,
  buildDataSyncWorkbenchTab,
  resolveDataSyncWorkbenchTabId,
  resolveExistingDataSyncWorkbenchTabId,
} from './dataSyncTab';

describe('dataSyncTab', () => {
  afterEach(() => {
    setCurrentLanguage('zh-CN');
  });

  it('builds one stable workbench tab for each data workflow entry', () => {
    expect(resolveDataSyncWorkbenchTabId('sync')).toBe('data-sync-workbench-sync');
    expect(resolveDataSyncWorkbenchTabId('compare')).toBe('data-sync-workbench-compare');
    expect(resolveDataSyncWorkbenchTabId('schemaCompare')).toBe('data-sync-workbench-compare');
    expect(resolveDataSyncWorkbenchTabId('dataCompare')).toBe('data-sync-workbench-compare');

    expect(buildDataSyncWorkbenchTab({ entryMode: 'schemaCompare' })).toMatchObject({
      id: 'data-sync-workbench-compare',
      title: t('data_sync.entry_mode.compare.title'),
      type: 'data-sync',
      connectionId: '',
      dataSyncEntryMode: 'compare',
    });
    expect(getTabDisplayKindLabel(buildDataSyncWorkbenchTab({ entryMode: 'sync' }))).toBe('SYNC');
    expect(getTabDisplayKindLabel(buildDataSyncWorkbenchTab({ entryMode: 'compare' }))).toBe('COMPARE');
  });

  it('localizes default titles without changing stable tab ids', () => {
    setCurrentLanguage('en-US');

    const tab = buildDataSyncWorkbenchTab({ entryMode: 'dataCompare' });

    expect(tab.id).toBe('data-sync-workbench-compare');
    expect(tab.title).toBe(t('data_sync.entry_mode.compare.title'));
  });

  it('reuses a legacy schema or data compare tab as the unified compare workbench', () => {
    expect(
      resolveExistingDataSyncWorkbenchTabId('compare', [
        {
          id: 'data-sync-workbench-schema-compare',
          type: 'data-sync',
          dataSyncEntryMode: 'schemaCompare',
        },
      ]),
    ).toBe('data-sync-workbench-schema-compare');
  });

  it('builds a unique paste workbench tab that focuses the prefilled endpoints', () => {
    const pastePrefill = {
      source: {
        connectionId: 'source-conn',
        database: 'shop',
        schema: 'public',
        table: 'orders',
      },
      target: {
        connectionId: 'target-conn',
        database: 'archive',
      },
    };

    const tab = buildDataSyncPasteWorkbenchTab({
      entryMode: 'sync',
      pastePrefill,
      requestId: 100,
    });
    const nextTab = buildDataSyncPasteWorkbenchTab({
      entryMode: 'sync',
      pastePrefill,
      requestId: 101,
    });

    expect(tab).toMatchObject({
      id: 'data-sync-workbench-paste-100',
      type: 'data-sync',
      connectionId: '',
      dataSyncEntryMode: 'sync',
      dataSyncPastePrefill: pastePrefill,
      dataSyncFocusTaskId: 'data-sync-paste-task-100',
      dataSyncFocusStage: 'endpoints',
      dataSyncFocusRequestId: '100',
    });
    expect(tab.title).toContain('orders');
    expect(nextTab.id).toBe('data-sync-workbench-paste-101');
    expect(nextTab.id).not.toBe(tab.id);
  });

  it('labels a multi-table paste tab with the selected table count', () => {
    const pastePrefill = {
      source: {
        connectionId: 'source-conn',
        database: 'shop',
        tables: ['orders', 'customers'],
      },
      target: {
        connectionId: 'target-conn',
        database: 'archive',
      },
    };

    const tab = buildDataSyncPasteWorkbenchTab({
      entryMode: 'sync',
      pastePrefill,
      requestId: 102,
    });

    expect(tab.title).toContain(t('sidebar.table_clipboard.multi_tab_title', { count: 2 }));
  });
});
