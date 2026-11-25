/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useSidebarCopyExportActions } from './useSidebarCopyExportActions';

const messageApi = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => vi.fn()),
}));

vi.mock('antd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('antd')>()),
  message: messageApi,
}));

const connection = {
  id: 'conn-1',
  name: 'shop',
  environmentType: 'local',
  config: {
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'shop',
  },
};

const viewNode = {
  key: 'conn-1-shop-view-active-orders',
  title: 'active_orders',
  type: 'view',
  dataRef: {
    ...connection,
    dbName: 'shop',
    schemaName: '',
    viewName: 'active_orders',
    tableName: 'active_orders',
  },
};

const captureActions = () => {
  let api: ReturnType<typeof useSidebarCopyExportActions> | null = null;
  const noop = vi.fn();
  const Probe = () => {
    api = useSidebarCopyExportActions({
      connections: [connection] as any,
      buildRuntimeConfig: (target: any) => ({ ...target.config, database: target.dbName }),
      loadTables: noop,
      getDatabaseNodeRef: noop,
      connectionIds: ['conn-1'],
      addTab: noop,
      runExportWithProgress: noop,
      openDesign: noop,
      onDoubleClick: noop,
      addAIContext: noop,
      setAIPanelVisible: noop,
    });
    return null;
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return api as unknown as ReturnType<typeof useSidebarCopyExportActions>;
};

describe('sidebar view copy action', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  it('invokes the host CopyView command for a view node', async () => {
    const copyView = vi.fn(async () => ({
      success: true,
      data: 'active_orders_copy1',
      message: 'copied',
    }));
    (window as any).go = { app: { App: { CopyView: copyView } } };
    const refresh = vi.fn();
    window.addEventListener('gonavi:sidebar-table-created', refresh);

    const actions = captureActions();
    await act(async () => {
      await (actions.handleCopyTable as (
        node: any,
        target?: { connectionId: string; database: string; schema: string },
      ) => Promise<void>)(viewNode, {
        connectionId: 'conn-1',
        database: 'archive',
        schema: '',
      });
    });

    expect(copyView).toHaveBeenCalledWith(
      expect.anything(),
      'shop',
      '',
      'active_orders',
      'archive',
      '',
    );
    expect(messageApi.success).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    expect((refresh.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      connectionId: 'conn-1',
      dbName: 'archive',
      tableName: 'active_orders_copy1',
    });

    window.removeEventListener('gonavi:sidebar-table-created', refresh);
    delete (window as any).go;
  });
});
