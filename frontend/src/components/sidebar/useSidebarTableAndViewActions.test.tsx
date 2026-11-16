import React from 'react';
import { message } from 'antd';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  DBQuery: vi.fn(),
  DBShowCreateTable: vi.fn(),
  DropView: vi.fn(),
  RenameView: vi.fn(),
}));

vi.mock('../../../wailsjs/go/app/App', () => backend);

import { useSidebarTableAndViewActions } from './useSidebarTableAndViewActions';

describe('useSidebarTableAndViewActions view edit', () => {
  let controller: ReturnType<typeof useSidebarTableAndViewActions> | null = null;
  let renderer: ReactTestRenderer | null = null;
  const addTab = vi.fn();

  const renderHook = () => {
    const Harness = () => {
      controller = useSidebarTableAndViewActions({
        buildRuntimeConfig: (conn: any) => conn.config,
        addSqlLog: vi.fn(),
        loadTables: vi.fn(),
        getDatabaseNodeRef: vi.fn(),
        confirmSidebarMutation: vi.fn(),
        addTab,
        renameViewTarget: null,
        renameViewForm: {} as any,
        extractObjectName: (name: string) => name,
        setIsRenameViewModalOpen: vi.fn(),
        setRenameViewTarget: vi.fn(),
      });
      return null;
    };
    act(() => {
      renderer = create(<Harness />);
    });
  };

  beforeEach(() => {
    controller = null;
    renderer = null;
    addTab.mockReset();
    backend.DBQuery.mockReset();
    backend.DBShowCreateTable.mockReset();
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    vi.restoreAllMocks();
  });

  it('opens the real Oracle view DDL from the sidebar edit action', async () => {
    const rawDdl = 'CREATE OR REPLACE FORCE VIEW PAIFILE.V_FILES AS SELECT id, name FROM PAIFILE.FILES';
    backend.DBShowCreateTable.mockResolvedValueOnce({ success: true, data: rawDdl });
    renderHook();

    await act(async () => {
      await controller?.openEditView({
        key: 'conn-1-PAIFILE-view-PAIFILE.V_FILES',
        dataRef: {
          id: 'conn-1',
          dbName: 'PAIFILE',
          viewName: 'PAIFILE.V_FILES',
          schemaName: 'PAIFILE',
          config: { type: 'oracle', host: '127.0.0.1', port: 1521 },
        },
      });
    });

    expect(backend.DBShowCreateTable).toHaveBeenCalledWith(
      expect.anything(),
      'PAIFILE',
      'PAIFILE.V_FILES',
    );
    expect(backend.DBQuery).not.toHaveBeenCalled();
    const tab = addTab.mock.calls[0][0];
    expect(tab.query).toContain(rawDdl);
    expect(tab.query).not.toContain('your_table');
    expect(tab.queryMode).toBe('object-edit');
    expect(tab.viewName).toBe('PAIFILE.V_FILES');
  });

  it('warns when no supported definition path can load the view DDL', async () => {
    const warningSpy = vi.spyOn(message, 'warning').mockImplementation(() => ({} as any));
    backend.DBShowCreateTable.mockResolvedValueOnce({ success: false, message: 'not supported' });
    backend.DBQuery.mockResolvedValue({ success: false, message: 'not supported' });
    renderHook();

    await act(async () => {
      await controller?.openEditView({
        key: 'conn-2-view-V_FILES',
        dataRef: {
          id: 'conn-2',
          dbName: 'app',
          viewName: 'V_FILES',
          schemaName: 'app',
          config: { type: 'custom', driver: 'unknown', host: '127.0.0.1', port: 1 },
        },
      });
    });

    expect(warningSpy).toHaveBeenCalledWith(expect.any(String));
    const tab = addTab.mock.calls[0][0];
    expect(tab.query).toContain('your_table');
  });
});
