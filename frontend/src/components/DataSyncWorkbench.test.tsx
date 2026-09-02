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
  connections: [] as Array<Record<string, unknown>>,
  connectionTags: [] as Array<Record<string, unknown>>,
  sidebarRootOrder: [] as string[],
};

vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  return {
    ...actual,
    useStore: (selector: (state: typeof storeState) => unknown) =>
      selector(storeState),
  };
});

vi.mock('../utils/workbenchTabCloseProtection', () => ({
  requestCloseWorkbenchTabs,
}));

vi.mock('./data-sync', () => ({
  createDataSyncTaskDraft: (input: Record<string, unknown>) => input,
  createWailsDataSyncWorkbenchGateway: () => ({ kind: 'test-gateway' }),
  DataSyncWorkbenchShell: ({ initialTasks, connectionTree, locale, onClose }: {
    initialTasks: Array<Record<string, unknown>>;
    connectionTree?: Array<Record<string, unknown>>;
    locale?: string;
    onClose: () => void;
  }) => (
    <button
      type="button"
      data-data-sync-shell="true"
      data-kind={String(initialTasks[0]?.kind || '')}
      data-compare-mode={String(initialTasks[0]?.compareMode || '')}
      data-content={String(initialTasks[0]?.content || '')}
      data-task-id={String(initialTasks[0]?.id || '')}
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

  it('maps schema compare mode without setting migration content and closes its tab', () => {
    const markup = renderToStaticMarkup(<DataSyncWorkbench tab={tab} />);
    expect(markup).toContain('data-data-sync-workbench="true"');
    expect(markup).toContain('data-data-sync-shell="true"');
    expect(markup).toContain('data-kind="compare"');
    expect(markup).toContain('data-compare-mode="schema"');
    expect(markup).toContain('data-content=""');
    expect(markup).toContain(
      'data-task-id="data-sync-local-data-sync-workbench-schema-compare"',
    );

    const renderer = TestRenderer.create(<DataSyncWorkbench tab={tab} />);
    act(() => {
      renderer.root.findByProps({ 'data-data-sync-shell': 'true' }).props.onClick();
    });

    expect(requestCloseWorkbenchTabs).toHaveBeenCalledWith([tab.id]);
  });

  it('maps data compare mode without setting migration content', () => {
    const dataCompareTab: TabData = {
      ...tab,
      id: 'data-sync-workbench-data-compare',
      title: '数据比对',
      dataSyncEntryMode: 'dataCompare',
    };

    const markup = renderToStaticMarkup(<DataSyncWorkbench tab={dataCompareTab} />);

    expect(markup).toContain('data-kind="compare"');
    expect(markup).toContain('data-compare-mode="data"');
    expect(markup).toContain('data-content=""');
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
