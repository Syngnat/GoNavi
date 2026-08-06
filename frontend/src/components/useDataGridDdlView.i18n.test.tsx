import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDataGridDdlView } from './useDataGridDdlView';
import { t as catalogTranslate } from '../i18n/catalog';

const backendApp = vi.hoisted(() => ({
  DBShowCreateTable: vi.fn(),
}));

vi.mock('../../wailsjs/go/app/App', () => backendApp);

describe('useDataGridDdlView i18n', () => {
  let controller: ReturnType<typeof useDataGridDdlView> | null = null;
  let renderer: ReactTestRenderer | null = null;
  const messageApi = {
    error: vi.fn(),
  };

  const translate = (key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params);

  const renderHook = (overrides: Partial<Parameters<typeof useDataGridDdlView>[0]> = {}) => {
    const Harness = () => {
      controller = useDataGridDdlView({
        canViewDdl: true,
        currentConnConfig: { type: 'mysql', host: '127.0.0.1', port: 3306 },
        dbName: 'app',
        tableName: 'users',
        dbType: 'mysql',
        isV2Ui: true,
        cellEditMode: false,
        selectedRowKeys: [],
        mergedDisplayDataRef: { current: [] },
        rowKeyStr: (key) => String(key),
        closeCellEditModeRef: { current: vi.fn() },
        setTextRecordIndex: vi.fn(),
        messageApi,
        translate,
        ...overrides,
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
    messageApi.error.mockReset();
    backendApp.DBShowCreateTable.mockReset();
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
  });

  it('uses the active language for local DDL validation and fallback errors', async () => {
    renderHook({ tableName: '' });

    await act(async () => {
      await controller?.handleOpenTableDdl();
    });

    expect(messageApi.error).toHaveBeenCalledWith('The current table is missing a connection or table name, so DDL cannot be viewed');
    expect(backendApp.DBShowCreateTable).not.toHaveBeenCalled();

    act(() => {
      renderer?.unmount();
      renderer = null;
    });

    backendApp.DBShowCreateTable.mockResolvedValueOnce({ success: false });
    renderHook();

    await act(async () => {
      await controller?.handleOpenTableDdl();
    });

    expect(messageApi.error).toHaveBeenLastCalledWith('Failed to load DDL');
  });

  it('keeps backend DDL error text raw', async () => {
    backendApp.DBShowCreateTable.mockResolvedValueOnce({
      success: false,
      message: 'ORA-31603: object "USERS" not found',
    });
    renderHook();

    await act(async () => {
      await controller?.handleOpenTableDdl();
    });

    expect(messageApi.error).toHaveBeenCalledWith('ORA-31603: object "USERS" not found');
  });

  it('honors an explicit text row when opening from the row number', () => {
    const setTextRecordIndex = vi.fn();
    renderHook({
      selectedRowKeys: ['row-10'],
      mergedDisplayDataRef: {
        current: [
          { __gonavi_row_key__: 'row-8' },
          { __gonavi_row_key__: 'row-10' },
        ],
      },
      setTextRecordIndex,
    });

    act(() => {
      controller?.handleViewModeChange('text', { textRecordIndex: 0 });
    });

    expect(setTextRecordIndex).toHaveBeenCalledWith(0);
  });
});
