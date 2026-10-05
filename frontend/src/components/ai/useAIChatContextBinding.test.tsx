import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messageApi = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));

const dbGetDatabasesMock = vi.hoisted(() => vi.fn());
const dbGetTablesMock = vi.hoisted(() => vi.fn());
const dbGetColumnsMock = vi.hoisted(() => vi.fn());
const dbShowCreateTableMock = vi.hoisted(() => vi.fn());

vi.mock('antd', () => ({
  message: messageApi,
}));

vi.mock('../../../wailsjs/go/app/App', () => ({
  DBGetDatabases: dbGetDatabasesMock,
  DBGetTables: dbGetTablesMock,
  DBGetColumns: dbGetColumnsMock,
  DBShowCreateTable: dbShowCreateTableMock,
}));

import { useStore } from '../../store';
import {
  clearAIEditorSelection,
  publishAIEditorSelection,
  registerAIEditorSelectionRefresher,
} from './aiEditorSelectionContext';
import { useAIChatContextBinding } from './useAIChatContextBinding';

type HarnessProps = Parameters<typeof useAIChatContextBinding>[0];

let latestHook: ReturnType<typeof useAIChatContextBinding> | undefined;

const addAIContextMock = vi.fn();
const removeAIContextMock = vi.fn();

const baseProps: HarnessProps = {
  activeContext: { connectionId: 'conn-1', dbName: 'analytics' },
  activeContextItems: [],
  connectionKey: 'conn-1::analytics',
  addAIContext: addAIContextMock,
  removeAIContext: removeAIContextMock,
};

const HookHarness = (props: Partial<HarnessProps>) => {
  latestHook = useAIChatContextBinding({
    ...baseProps,
    ...props,
  });
  return null;
};

describe('useAIChatContextBinding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestHook = undefined;
    useStore.setState({
      connections: [{
        id: 'conn-1',
        name: 'analytics-primary',
        config: {
          type: 'mysql',
          host: '127.0.0.1',
          port: 3306,
          user: 'root',
        },
      }],
    } as any);
  });

  afterEach(() => {
    useStore.setState({ connections: [] } as any);
  });

  it('falls back to the English warning when no active database context is selected', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<HookHarness activeContext={null} />);
    });

    await act(async () => {
      await latestHook!.handleOpenContext();
    });

    expect(messageApi.warning).toHaveBeenCalledWith('Select a database on the left before attaching chat context');

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('surfaces the English table-load failure instead of silently swallowing failed context-table fetches', async () => {
    dbGetDatabasesMock.mockResolvedValue({
      success: true,
      data: [{ name: 'analytics' }],
    });
    dbGetTablesMock.mockResolvedValue({
      success: false,
      message: 'permission denied',
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<HookHarness activeContext={{ connectionId: 'conn-1', dbName: 'analytics' }} />);
    });

    await act(async () => {
      await latestHook!.handleOpenContext();
    });

    expect(messageApi.error).toHaveBeenCalledWith('Failed to load tables: permission denied');

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('uses the named table field instead of metadata values such as row counts', async () => {
    dbGetDatabasesMock.mockResolvedValue({
      success: true,
      data: [{ Database: 'analytics' }],
    });
    dbGetTablesMock.mockResolvedValue({
      success: true,
      data: [
        { Rows: '128', Table: 'users', Data_length: '4096' },
        { Index_length: '2048', table_name: 'orders', Rows: '42' },
        { Name: 'metadata-label', Rows: '7', TABLE: 'customers' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<HookHarness />);
    });

    await act(async () => {
      await latestHook!.handleOpenContext();
    });

    expect(latestHook!.filteredTables).toEqual([
      { name: 'users' },
      { name: 'orders' },
      { name: 'customers' },
    ]);

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('falls back to the English unchanged-selection info message after a no-op sync', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<HookHarness />);
    });

    await act(async () => {
      await latestHook!.handleAppendContext();
    });

    expect(messageApi.info).toHaveBeenCalledWith('Selected tables did not change');

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('attaches the active editor selection as a typed context item', async () => {
    dbGetDatabasesMock.mockResolvedValue({ success: true, data: [{ Database: 'analytics' }] });
    dbGetTablesMock.mockResolvedValue({ success: true, data: [] });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<HookHarness activeEditorSelection={{
        tabId: 'query-1',
        tabTitle: 'Orders query',
        connectionId: 'conn-1',
        dbName: 'analytics',
        text: 'select * from orders',
      }} />);
    });

    await act(async () => {
      await latestHook!.handleOpenContext();
    });
    await act(async () => {
      latestHook!.setSelectedEditorSelection(true);
    });
    expect(latestHook!.selectedEditorSelection).toBe(true);
    await act(async () => {
      await latestHook!.handleAppendContext();
    });

    expect(addAIContextMock).toHaveBeenCalledWith('conn-1::analytics', expect.objectContaining({
      kind: 'editor_selection',
      content: 'select * from orders',
      source: expect.objectContaining({ tabId: 'query-1' }),
    }));

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('binds the active editor selection directly from the composer action', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<HookHarness activeEditorSelection={{
        tabId: 'query-direct',
        tabTitle: 'Orders query',
        connectionId: 'conn-1',
        dbName: 'analytics',
        text: 'select count(*) from orders',
      }} />);
    });

    await act(async () => {
      latestHook!.handleBindEditorSelection();
    });

    expect(addAIContextMock).toHaveBeenCalledWith('conn-1::analytics', expect.objectContaining({
      kind: 'editor_selection',
      content: 'select count(*) from orders',
    }));
    expect(messageApi.success).toHaveBeenCalledWith('Editor selection attached to AI context');

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('reads the live editor selection when the stored copy is stale (select-all, then click)', async () => {
    publishAIEditorSelection({ tabId: 'tab-live', connectionId: 'conn-1', dbName: 'analytics', text: 'SELECT 1' });
    useStore.setState({ activeTabId: 'tab-live' } as any);
    // The editor now holds the whole document, but no event delivered it.
    registerAIEditorSelectionRefresher('tab-live', () => publishAIEditorSelection({
      tabId: 'tab-live', connectionId: 'conn-1', dbName: 'analytics', text: 'WITH rfm AS (SELECT 1) SELECT * FROM rfm',
    }));
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<HookHarness activeEditorSelection={{ tabId: 'tab-live', text: 'SELECT 1' }} />);
    });

    await act(async () => {
      latestHook!.handleBindEditorSelection();
    });

    expect(addAIContextMock).toHaveBeenCalledWith('conn-1::analytics', expect.objectContaining({
      content: 'WITH rfm AS (SELECT 1) SELECT * FROM rfm',
    }));
    expect(messageApi.warning).not.toHaveBeenCalled();
    await act(async () => { renderer!.unmount(); });
    clearAIEditorSelection('tab-live');
  });

  it('binds under the selection own connection when the sidebar has no active context', async () => {
    const setActiveContext = vi.fn();
    useStore.setState({ activeTabId: 'tab-own', setActiveContext } as any);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<HookHarness
        activeContext={null}
        connectionKey=""
        activeEditorSelection={{ tabId: 'tab-own', connectionId: 'conn-1', dbName: 'dbms_job', text: 'SELECT 2' }}
      />);
    });

    await act(async () => {
      latestHook!.handleBindEditorSelection();
    });

    expect(setActiveContext).toHaveBeenCalledWith({ connectionId: 'conn-1', dbName: 'dbms_job' });
    expect(addAIContextMock).toHaveBeenCalledWith('conn-1:dbms_job', expect.objectContaining({ content: 'SELECT 2' }));
    expect(messageApi.warning).not.toHaveBeenCalled();
    await act(async () => { renderer!.unmount(); });
  });

  it('tells apart "nothing selected" from "no database context"', async () => {
    useStore.setState({ activeTabId: 'tab-none' } as any);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<HookHarness activeEditorSelection={null} />);
    });
    await act(async () => { latestHook!.handleBindEditorSelection(); });
    expect(messageApi.warning).toHaveBeenLastCalledWith('Select non-empty text in the editor before binding it to AI context');

    await act(async () => {
      renderer!.update(<HookHarness activeContext={null} activeEditorSelection={{ tabId: 'tab-none', text: 'SELECT 3' }} />);
    });
    await act(async () => { latestHook!.handleBindEditorSelection(); });
    expect(messageApi.warning).toHaveBeenLastCalledWith('Select a database on the left before attaching chat context');
    expect(addAIContextMock).not.toHaveBeenCalled();
    await act(async () => { renderer!.unmount(); });
  });
});
