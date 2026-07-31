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
});
