import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabData } from '../types';
import DataSyncWorkbench from './DataSyncWorkbench';

const closeTab = vi.fn();
const requestCloseWorkbenchTabs = vi.hoisted(() => vi.fn());
const storeState = {
  closeTab,
  addTab: vi.fn(),
  setAIPanelVisible: vi.fn(),
  aiPanelVisible: false,
  connections: [] as Array<Record<string, unknown>>,
  connectionTags: [] as Array<Record<string, unknown>>,
  sidebarRootOrder: [] as string[],
};

vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const useStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  );
  return {
    ...actual,
    useStore,
  };
});

vi.mock('../utils/workbenchTabCloseProtection', () => ({
  requestCloseWorkbenchTabs,
}));

vi.mock('./data-sync', () => ({
  createWailsDataSyncWorkbenchGateway: () => ({ kind: 'test-gateway' }),
  DataSyncWorkbenchShell: ({ initialTasks, connectionTree, locale, onClose, workbenchFamily }: {
    initialTasks: Array<Record<string, unknown>>;
    connectionTree?: Array<Record<string, unknown>>;
    locale?: string;
    onClose: () => void;
    workbenchFamily?: string;
  }) => (
    <button
      type="button"
      data-data-sync-shell="true"
      data-workbench-family={String(workbenchFamily || '')}
      data-initial-task-count={String((initialTasks || []).length)}
      data-kind={String(initialTasks[0]?.kind || '')}
      data-compare-mode={String(initialTasks[0]?.compareMode || '')}
      data-content={String(initialTasks[0]?.content || '')}
      data-task-id={String(initialTasks[0]?.id || '')}
      data-source={JSON.stringify(initialTasks[0]?.source || null)}
      data-target={JSON.stringify(initialTasks[0]?.target || null)}
      data-mappings={JSON.stringify(initialTasks[0]?.mappings || [])}
      data-connection-tree={JSON.stringify(connectionTree || [])}
      data-locale={locale}
      onClick={onClose}
    />
  ),
}));

const tab: TabData = {
  id: 'data-sync-workbench-schema-compare',
  title: '表结构比对',
  type: 'data-sync',
  connectionId: '',
  dataSyncEntryMode: 'schemaCompare',
};

describe('DataSyncWorkbench', () => {
  beforeEach(() => {
    closeTab.mockReset();
    requestCloseWorkbenchTabs.mockReset();
    storeState.connections = [];
    storeState.connectionTags = [];
    storeState.sidebarRootOrder = [];
  });

  it('maps schema compare mode onto the unified compare workbench and closes its tab', () => {
    const markup = renderToStaticMarkup(<DataSyncWorkbench tab={tab} />);
    expect(markup).toContain('data-data-sync-workbench="true"');
    expect(markup).toContain('data-data-sync-shell="true"');
    expect(markup).toContain('data-workbench-family="compare"');
    expect(markup).toContain('data-initial-task-count="0"');
    expect(markup).toContain('data-kind=""');
    expect(markup).toContain('data-compare-mode=""');
    expect(markup).toContain('data-content=""');

    const renderer = TestRenderer.create(<DataSyncWorkbench tab={tab} />);
    act(() => {
      renderer.root.findByProps({ 'data-data-sync-shell': 'true' }).props.onClick();
    });

    expect(requestCloseWorkbenchTabs).toHaveBeenCalledWith([tab.id]);
  });

  it('keeps the host tab when the workbench is embedded in settings', () => {
    const renderer = TestRenderer.create(<DataSyncWorkbench embedded tab={tab} />);
    expect(renderer.root.findByProps({ 'data-data-sync-shell': 'true' }).props.onClose).toBeUndefined();
  });

  it('maps data compare mode onto the unified compare workbench', () => {
    const dataCompareTab: TabData = {
      ...tab,
      id: 'data-sync-workbench-data-compare',
      title: '数据比对',
      dataSyncEntryMode: 'dataCompare',
    };

    const markup = renderToStaticMarkup(<DataSyncWorkbench tab={dataCompareTab} />);

    expect(markup).toContain('data-workbench-family="compare"');
    expect(markup).toContain('data-initial-task-count="0"');
    expect(markup).toContain('data-kind=""');
    expect(markup).toContain('data-compare-mode=""');
    expect(markup).toContain('data-content=""');
  });

  it('opens the sync workbench with a writable sync draft', () => {
    const syncTab: TabData = {
      ...tab,
      id: 'data-sync-workbench-sync',
      title: '数据同步',
      dataSyncEntryMode: 'sync',
    };

    const markup = renderToStaticMarkup(<DataSyncWorkbench tab={syncTab} />);

    expect(markup).toContain('data-workbench-family="sync"');
    expect(markup).toContain('data-initial-task-count="1"');
    expect(markup).toContain('data-kind="reconcile"');
  });

  it('opens pasted tables as a prefilled migration task', () => {
    storeState.connections = [
      {
        id: 'source-conn',
        name: 'Source MySQL',
        type: 'mysql',
        config: { type: 'mysql' },
      },
      {
        id: 'target-conn',
        name: 'Target PostgreSQL',
        type: 'postgres',
        config: { type: 'postgres' },
      },
    ];
    const pasteTab: TabData = {
      ...tab,
      id: 'data-sync-workbench-paste-100',
      title: '数据同步 · orders',
      dataSyncEntryMode: 'sync',
      dataSyncFocusTaskId: 'data-sync-paste-task-100',
      dataSyncPastePrefill: {
        source: {
          connectionId: 'source-conn',
          database: 'shop',
          table: 'orders',
        },
        target: {
          connectionId: 'target-conn',
          database: 'archive',
          schema: 'public',
        },
      },
    };

    const renderer = TestRenderer.create(<DataSyncWorkbench tab={pasteTab} />);
    const shell = renderer.root.findByProps({ 'data-data-sync-shell': 'true' });

    expect(shell.props['data-kind']).toBe('migration');
    expect(shell.props['data-content']).toBe('both');
    expect(shell.props['data-task-id']).toBe('data-sync-paste-task-100');
    expect(JSON.parse(shell.props['data-source'])).toEqual({
      connectionId: 'source-conn',
      connectionName: 'Source MySQL',
      type: 'mysql',
      database: 'shop',
      schema: '',
    });
    expect(JSON.parse(shell.props['data-target'])).toEqual({
      connectionId: 'target-conn',
      connectionName: 'Target PostgreSQL',
      type: 'postgres',
      database: 'archive',
      schema: 'public',
    });
    expect(JSON.parse(shell.props['data-mappings'])).toEqual([
      expect.objectContaining({
        sourceObject: 'orders',
        targetObject: 'orders',
        targetMode: 'create_or_reuse',
        targetModeExplicit: true,
      }),
    ]);
  });

  it('creates one migration mapping for every pasted table', () => {
    storeState.connections = [
      {
        id: 'source-conn',
        name: 'Source MySQL',
        type: 'mysql',
        config: { type: 'mysql' },
      },
      {
        id: 'target-conn',
        name: 'Target PostgreSQL',
        type: 'postgres',
        config: { type: 'postgres' },
      },
    ];
    const pasteTab: TabData = {
      ...tab,
      id: 'data-sync-workbench-paste-101',
      title: '数据同步 · 2 张表',
      dataSyncEntryMode: 'sync',
      dataSyncFocusTaskId: 'data-sync-paste-task-101',
      dataSyncPastePrefill: {
        source: {
          connectionId: 'source-conn',
          database: 'shop',
          tables: ['orders', 'customers'],
        },
        target: {
          connectionId: 'target-conn',
          database: 'archive',
        },
      },
    };

    const renderer = TestRenderer.create(<DataSyncWorkbench tab={pasteTab} />);
    const shell = renderer.root.findByProps({ 'data-data-sync-shell': 'true' });
    const mappings = JSON.parse(shell.props['data-mappings']);

    expect(mappings).toHaveLength(2);
    expect(mappings).toEqual([
      expect.objectContaining({
        sourceObject: 'orders',
        targetObject: 'orders',
        targetMode: 'create_or_reuse',
        targetModeExplicit: true,
      }),
      expect.objectContaining({
        sourceObject: 'customers',
        targetObject: 'customers',
        targetMode: 'create_or_reuse',
        targetModeExplicit: true,
      }),
    ]);
  });

  it('projects sidebar groups without exposing saved connection config', () => {
    storeState.connections = [
      {
        id: 'secret-connection',
        name: 'Private database',
        type: 'mysql',
        config: { password: 'must-not-reach-shell', sshPassword: 'also-secret' },
      },
      { id: 'ungrouped', name: 'Loose host', type: 'sqlite' },
    ];
    storeState.connectionTags = [
      {
        id: 'parent',
        name: 'Production',
        connectionIds: [],
        childOrder: ['tag:child'],
      },
      {
        id: 'child',
        name: 'Primary',
        parentTagId: 'parent',
        connectionIds: ['secret-connection'],
        childOrder: ['connection:secret-connection'],
      },
    ];
    storeState.sidebarRootOrder = ['connection:ungrouped', 'tag:parent'];

    const renderer = TestRenderer.create(<DataSyncWorkbench tab={tab} />);
    const projectedTree = renderer.root.findByProps({
      'data-data-sync-shell': 'true',
    }).props['data-connection-tree'];

    expect(JSON.parse(projectedTree)).toEqual([
      { kind: 'connection', connectionId: 'ungrouped' },
      {
        kind: 'group',
        id: 'parent',
        name: 'Production',
        children: [
          {
            kind: 'group',
            id: 'child',
            name: 'Primary',
            children: [
              { kind: 'connection', connectionId: 'secret-connection' },
            ],
          },
        ],
      },
    ]);
    expect(projectedTree).not.toContain('must-not-reach-shell');
    expect(projectedTree).not.toContain('sshPassword');
  });
});
