import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DataGrid, { GONAVI_ROW_KEY } from './DataGrid';
import DataGridPageFind from './DataGridPageFind';
import DataGridToolbarFrame from './DataGridToolbarFrame';
import { V2CellContextMenuView, V2ColumnHeaderContextMenuView, V2TableGroupContextMenuView } from './V2TableContextMenu';
import { setCurrentLanguage, t } from '../i18n';
import {
  storeState,
  backendApp,
  testRenderState,
  messageApi,
} from './dataGridDdlTestState';
import { textContent, findButton, renderHeaderText, waitForEffects, createRenderedCellTarget } from './dataGridDdlTestHelpers';
import { setUpDataGridDdlTest, tearDownDataGridDdlTest } from './dataGridDdlTestHooks';

vi.mock('../store', async () => (await import('./dataGridDdlTestState')).mockModule1());

vi.mock('../../wailsjs/go/app/App', async () => (await import('./dataGridDdlTestState')).mockModule2());

vi.mock('../../wailsjs/runtime/runtime', async () => (await import('./dataGridDdlTestState')).mockModule3());

vi.mock('react-dom', async () => (await import('./dataGridDdlTestState')).mockModule4());

vi.mock('@monaco-editor/react', async () => (await import('./dataGridDdlTestState')).mockModule5());

vi.mock('./ImportPreviewModal', async () => (await import('./dataGridDdlTestState')).mockModule6());

vi.mock('./TableDesigner', async () => (await import('./dataGridDdlTestState')).mockModule7());

vi.mock('@ant-design/icons', async () => (await import('./dataGridDdlTestState')).mockModule8());

vi.mock('@dnd-kit/core', async () => (await import('./dataGridDdlTestState')).mockModule9());

vi.mock('@dnd-kit/sortable', async () => (await import('./dataGridDdlTestState')).mockModule10());

vi.mock('@dnd-kit/utilities', async () => (await import('./dataGridDdlTestState')).mockModule11());

vi.mock('antd', async () => (await import('./dataGridDdlTestState')).mockModule12());

describe('DataGrid DDL interactions', () => {
  beforeEach(setUpDataGridDdlTest);

  afterEach(tearDownDataGridDdlTest);

  it('reloads authoritative rows and drops pending edits when ApplyChanges reports an unknown outcome', async () => {
    storeState.dataEditTransactionOptions = {
      commitMode: 'manual',
      autoCommitDelayMs: 5000,
    };
    messageApi.error.mockClear();
    messageApi.warning.mockClear();
    storeState.addSqlLog.mockClear();
    backendApp.ApplyChanges.mockResolvedValue({
      success: false,
      outcomeUnknown: true,
      message: 'response lost',
      data: {
        deletes: [],
        updates: [],
        inserts: ["INSERT INTO `users` (`id`, `name`) VALUES (NULL, NULL);"],
      },
    });
    const onReload = vi.fn(async () => {
      throw new Error('reload failed');
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' }]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
          onReload={onReload}
        />,
      );
    });
    await waitForEffects();
    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onAddRow();
    });
    await waitForEffects();
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(true);

    await act(async () => {
      await renderer!.root.findByType(DataGridToolbarFrame).props.onCommit();
    });
    await waitForEffects();

    expect(backendApp.ApplyChanges).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(messageApi.warning).toHaveBeenCalledWith(t('data_grid.message.commit_outcome_unknown', { detail: 'response lost' }));
    expect(messageApi.error).not.toHaveBeenCalled();
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(false);
    expect(storeState.addSqlLog).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'error',
      message: `response lost (${t('data_grid.message.transaction_outcome_unknown')})`,
      sql: expect.stringContaining('-- COMMIT outcome is unknown; do not replay this batch.'),
    }));
    const lastSqlLog = storeState.addSqlLog.mock.calls[storeState.addSqlLog.mock.calls.length - 1]?.[0];
    expect(String(lastSqlLog?.sql || '')).not.toContain(
      '-- COMMIT was not issued because this batch failed.',
    );

    await act(async () => {
      await renderer!.root.findByType(DataGridToolbarFrame).props.onCommit();
    });
    expect(backendApp.ApplyChanges).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it('keeps pending edits after a known ApplyChanges failure so the user can retry', async () => {
    storeState.dataEditTransactionOptions = {
      commitMode: 'manual',
      autoCommitDelayMs: 5000,
    };
    messageApi.error.mockClear();
    messageApi.warning.mockClear();
    backendApp.ApplyChanges.mockResolvedValue({
      success: false,
      message: 'constraint rejected',
      data: { deletes: [], updates: [], inserts: [] },
    });
    const onReload = vi.fn(async () => undefined);

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' }]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
          onReload={onReload}
        />,
      );
    });
    await waitForEffects();
    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onAddRow();
    });
    await waitForEffects();

    await act(async () => {
      await renderer!.root.findByType(DataGridToolbarFrame).props.onCommit();
    });
    await waitForEffects();

    expect(backendApp.ApplyChanges).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
    expect(messageApi.error).toHaveBeenCalledWith(t('data_grid.message.commit_failed', { detail: 'constraint rejected' }));
    expect(messageApi.warning).not.toHaveBeenCalled();
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(true);

    await act(async () => {
      await renderer!.root.findByType(DataGridToolbarFrame).props.onCommit();
    });
    expect(backendApp.ApplyChanges).toHaveBeenCalledTimes(2);
    renderer!.unmount();
  });

  it('does not auto replay after an unknown auto-commit outcome', async () => {
    vi.useFakeTimers();
    storeState.dataEditTransactionOptions = {
      commitMode: 'auto',
      autoCommitDelayMs: 3000,
    };
    messageApi.error.mockClear();
    messageApi.warning.mockClear();
    backendApp.ApplyChanges.mockResolvedValue({
      success: false,
      outcomeUnknown: true,
      message: 'response lost',
      data: {
        deletes: [],
        updates: [],
        inserts: ["INSERT INTO `users` (`id`, `name`) VALUES (NULL, NULL);"],
      },
    });
    const onReload = vi.fn(async () => undefined);

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' }]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
          onReload={onReload}
        />,
      );
    });
    await waitForEffects();
    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onAddRow();
    });
    await waitForEffects();
    expect(backendApp.ApplyChanges).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.ApplyChanges).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(messageApi.warning).toHaveBeenCalledWith(t('data_grid.message.auto_commit_outcome_unknown', { detail: 'response lost' }));
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.ApplyChanges).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it('commits pending edits with Meta+S on macOS and ignores save shortcuts outside or in read-only grids', async () => {

    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    backendApp.ApplyChanges.mockResolvedValue({ success: true, message: 'ok', data: { deletes: [], updates: [], inserts: [] } });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' }]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
    });
    await waitForEffects();
    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onAddRow();
    });
    await waitForEffects();
    const saveListeners = vi.mocked(window.addEventListener).mock.calls
      .filter(([type, _listener, options]) => type === 'keydown' && options === true)
      .map(([_type, listener]) => listener as EventListener)
      .filter(Boolean);
    const eventTarget = { closest: (selector: string) => selector === '.data-grid-root' ? {} : null };
    const metaEvent = {
      key: 's', code: 'KeyS', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
      isComposing: false, target: eventTarget,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    await act(async () => {
      saveListeners.forEach((listener) => listener(metaEvent));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(metaEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(backendApp.ApplyChanges).toHaveBeenCalledTimes(1);
    renderer!.unmount();

    const readOnlyRenderer = create(
      <DataGrid
        data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
        columnNames={['id']}
        loading={false}
        tableName="users"
        dbName="main"
        connectionId="conn-1"
        readOnly
      />,
    );
    await waitForEffects();
    const registrationsBefore = vi.mocked(window.addEventListener).mock.calls.length;
    const outsideEvent = {
      key: 's', code: 'KeyS', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
      isComposing: false, target: document.body,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    const keydownRegistrations = vi.mocked(window.addEventListener).mock.calls
      .filter(([type, _listener, options]) => type === 'keydown' && options === true);
    const latestListener = keydownRegistrations[keydownRegistrations.length - 1]?.[1] as EventListener | undefined;
    latestListener?.(outsideEvent);
    expect(vi.mocked(window.addEventListener).mock.calls.length).toBe(registrationsBefore);
    expect(outsideEvent.preventDefault).not.toHaveBeenCalled();
    readOnlyRenderer.unmount();
  });

  it('does not treat page-find highlighting as a deletable cell selection', async () => {
    messageApi.info.mockResolvedValue(undefined);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[
            { __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' },
            { __gonavi_row_key__: 'row-2', id: 2, name: 'Linus' },
          ]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
    });
    await waitForEffects();

    const shortcutListeners = vi.mocked(window.addEventListener).mock.calls
      .filter(([type, _listener, options]) => type === 'keydown' && options === true)
      .map(([_type, listener]) => listener as EventListener);
    await act(async () => {
      const invokeShortcut = (listener: EventListener, metaKey: boolean, ctrlKey: boolean) => listener({
          key: 'f', code: 'KeyF', metaKey, ctrlKey, altKey: false, shiftKey: false,
          isComposing: false, target: document.body,
          preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
        } as unknown as KeyboardEvent);
      shortcutListeners.forEach((listener) => {
        invokeShortcut(listener, false, true);
        invokeShortcut(listener, true, false);
      });
    });
    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onToggleCellEditMode();
    });
    await act(async () => {
      renderer!.root.findByType(DataGridPageFind).props.onPageFindTextChange('Ada');
    });
    await waitForEffects();

    const pageFind = renderer!.root.findByType(DataGridPageFind);
    expect(pageFind.props.matchCount).toBeGreaterThan(0);
    await act(async () => {
      pageFind.props.onNavigateNext();
    });
    await waitForEffects();

    const toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(toolbar.props.cellEditMode).toBe(true);
    expect(toolbar.props.selectedCellsSize).toBe(1);
    expect(toolbar.props.fillTemplateTargetRowCount).toBe(0);
    expect(toolbar.props.deleteTargetRowCount).toBe(0);
    expect(findButton(renderer!, t('data_grid.toolbar.delete_selected')).props.disabled).toBe(true);
    renderer!.unmount();
  });

  it('keeps checkbox-selected rows as the delete target when a cell selection also exists', async () => {
    messageApi.info.mockResolvedValue(undefined);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[
            { __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' },
            { __gonavi_row_key__: 'row-2', id: 2, name: 'Linus' },
          ]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
    });
    await waitForEffects();

    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onToggleCellEditMode();
    });
    const nameColumn = testRenderState.latestColumns.find((column) => column.key === 'name');
    const headerProps = nameColumn.onHeaderCell(nameColumn);
    await act(async () => {
      headerProps.onClickCapture({
        target: { closest: vi.fn(() => null) },
        currentTarget: { querySelector: vi.fn(() => null) },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
      testRenderState.latestTableProps.rowSelection.onChange(['row-1']);
    });
    await waitForEffects();

    let toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(toolbar.props.selectedCellsSize).toBe(2);
    expect(toolbar.props.selectedRowKeysLength).toBe(1);
    expect(toolbar.props.deleteTargetRowCount).toBe(1);

    await act(async () => {
      toolbar.props.onDeleteSelected();
    });
    await waitForEffects();

    toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(toolbar.props.pendingChangeCount).toBe(1);
    expect(toolbar.props.selectedCellsSize).toBe(0);
    expect(
      testRenderState.latestTableProps.dataSource.map((row: Record<string, unknown>) => (
        testRenderState.latestTableProps.rowClassName(row)
      )),
    ).toEqual(['row-deleted', '']);
    renderer!.unmount();
  });

  it('removes a newly added record selected only through its cells without leaving a pending delete', async () => {
    messageApi.info.mockResolvedValue(undefined);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
    });
    await waitForEffects();

    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onAddRow();
    });
    await waitForEffects();
    expect(testRenderState.latestTableProps.dataSource).toHaveLength(1);
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.pendingChangeCount).toBe(1);

    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onToggleCellEditMode();
    });
    await waitForEffects();

    const nameColumn = testRenderState.latestColumns.find((column) => column.key === 'name');
    expect(nameColumn?.editable).toBe(true);
    const headerProps = nameColumn.onHeaderCell(nameColumn);
    await act(async () => {
      headerProps.onClickCapture({
        target: { closest: vi.fn(() => null) },
        currentTarget: { querySelector: vi.fn(() => null) },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    let toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(toolbar.props.selectedRowKeysLength).toBe(0);
    expect(toolbar.props.selectedCellsSize).toBe(1);
    expect(toolbar.props.deleteTargetRowCount).toBe(1);

    await act(async () => {
      findButton(renderer!, t('data_grid.toolbar.delete_selected')).props.onClick();
    });
    await waitForEffects();

    toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(testRenderState.latestTableProps.dataSource).toHaveLength(0);
    expect(toolbar.props.pendingChangeCount).toBe(0);
    expect(toolbar.props.selectedCellsSize).toBe(0);
    expect(toolbar.props.deleteTargetRowCount).toBe(0);
    expect(findButton(renderer!, t('data_grid.toolbar.delete_selected')).props.disabled).toBe(true);
    renderer!.unmount();
  });

  it('allows sorter arrow clicks through while cell edit mode is active', async () => {
    messageApi.info.mockResolvedValue(undefined);
    const onSort = vi.fn();
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[
            { __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' },
            { __gonavi_row_key__: 'row-2', id: 2, name: 'Linus' },
          ]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
          onSort={onSort}
          sortInfoExternal={[]}
        />,
      );
    });
    await waitForEffects();

    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onToggleCellEditMode();
    });
    await waitForEffects();

    const nameColumn = testRenderState.latestColumns.find((column) => column.key === 'name');
    const headerProps = nameColumn.onHeaderCell(nameColumn);
    const upArrow = {
      getBoundingClientRect: () => ({ left: 100, right: 112, top: 20, bottom: 32 }),
    };
    const event = {
      target: { closest: vi.fn(() => null) },
      currentTarget: {
        querySelector: vi.fn((selector: string) => selector.includes('sorter-up') ? upArrow : null),
      },
      clientX: 106,
      clientY: 26,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      headerProps.onClickCapture(event);
    });

    const toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(toolbar.props.selectedCellsSize).toBe(0);
    renderer!.unmount();
  });

  it('opens the v2 column header context menu from table headers', async () => {
    setCurrentLanguage('en-US');

    storeState.queryOptions.showColumnComment = true;
    storeState.queryOptions.showColumnType = true;
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ Name: 'id', Type: 'bigint', Comment: '主键 ID' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
          columnNames={['id']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
    });
    await waitForEffects();

    const idColumn = testRenderState.latestColumns.find((column) => column.key === 'id');
    expect(idColumn).toBeTruthy();
    const headerProps = idColumn.onHeaderCell(idColumn);

    await act(async () => {
      headerProps.onContextMenu({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 120,
        clientY: 88,
      });
    });

    expect(renderer!.root.findByProps({ 'data-v2-column-context-menu': 'true' })).toBeTruthy();
    expect(textContent(renderer!.root)).toContain(t('sidebar.v2_table_menu.copy_section'));
    expect(textContent(renderer!.root)).toContain(t('data_grid.context_menu.copy_field_name'));
    expect(textContent(renderer!.root)).toContain(t('data_grid.context_menu.copy_column_comment'));
    expect(textContent(renderer!.root)).toContain(t('data_grid.context_menu.copy_column_data'));
    expect(textContent(renderer!.root)).toContain(t('data_grid.context_menu.sort_ascending'));
    expect(textContent(renderer!.root)).toContain(t('data_grid.context_menu.hide_column'));
    expect(textContent(renderer!.root)).toContain(t('data_grid.context_menu.hide_column_type'));
    expect(textContent(renderer!.root)).toContain(t('data_grid.context_menu.hide_column_comment'));
    expect(textContent(renderer!.root)).toContain('bigint');
    expect(textContent(renderer!.root)).toContain('主键 ID');

    await act(async () => {
      findButton(renderer!, t('data_grid.context_menu.copy_column_comment')).props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('主键 ID');
    renderer!.unmount();
  });

  it('applies ascending sort from the v2 column header context menu', async () => {
    setCurrentLanguage('zh-CN');

    const onSort = vi.fn();
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' }]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
          onSort={onSort}
          sortInfoExternal={[]}
        />,
      );
    });
    await waitForEffects();

    const nameColumn = testRenderState.latestColumns.find((column) => column.key === 'name');
    const headerProps = nameColumn.onHeaderCell(nameColumn);
    await act(async () => {
      headerProps.onContextMenu({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 120,
        clientY: 88,
      });
    });

    const ascendingButton = renderer!.root.findAll((node) => (
      node.type === 'button'
      && textContent(node) === t('data_grid.context_menu.sort_ascending')
    ))[0];
    expect(ascendingButton).toBeTruthy();

    await act(async () => {
      ascendingButton.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });

    expect(onSort).toHaveBeenCalledWith(
      JSON.stringify([{ columnKey: 'name', order: 'ascend', enabled: true }]),
      '',
    );
    renderer!.unmount();
  });

  it('pins a read-only query-result column with an independent pin scope', async () => {

    const columnPinScope = 'query-result:1a2b3c4d';
    const props = {
      data: [{ __gonavi_row_key__: 'row-1', id: 1, id_2: 2, order_id: 100 }],
      columnNames: ['id', 'id_2', 'order_id'],
      loading: false,
      dbName: 'main',
      connectionId: 'conn-1',
      columnPinScope,
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} />);
    });
    await waitForEffects();

    const duplicateIdColumn = testRenderState.latestColumns.find((column) => column.key === 'id_2');
    expect(duplicateIdColumn).toBeTruthy();
    expect(duplicateIdColumn.fixed).toBeUndefined();

    const headerProps = duplicateIdColumn.onHeaderCell(duplicateIdColumn);
    await act(async () => {
      headerProps.onContextMenu({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 120,
        clientY: 88,
      });
    });

    await act(async () => {
      findButton(renderer!, t('data_grid.context_menu.pin_column_left')).props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    expect(storeState.setTablePinnedLeftColumns).toHaveBeenCalledWith(
      'conn-1',
      'main',
      columnPinScope,
      ['id_2'],
    );

    storeState.tablePinnedLeftColumns = {
      'conn-1-main-query-result:1a2b3c4d': ['id_2'],
    };
    await act(async () => {
      renderer!.update(<DataGrid {...props} data={[...props.data]} />);
    });
    await waitForEffects();

    expect(testRenderState.latestColumns.find((column) => column.key === 'id_2').fixed).toBe('left');
    renderer!.unmount();
  });

  it('retries column metadata loading when the first response has no usable type or comment', async () => {
    storeState.queryOptions.showColumnComment = true;
    storeState.queryOptions.showColumnType = true;
    backendApp.DBGetColumns
      .mockResolvedValueOnce({
        success: true,
        data: [{ Name: 'id', Type: '', Comment: '' }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ Name: 'id', Type: 'bigint', Comment: '主键 ID' }],
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
          columnNames={['id']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
    });
    await waitForEffects();
    await waitForEffects();

    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(2);
    const headerText = renderHeaderText('id');
    expect(headerText).toContain('bigint');
    expect(headerText).toContain('主键 ID');
    renderer!.unmount();
  });

  it('defers Kingbase table metadata until the initial data query finishes', async () => {
    storeState.connections[0].config.type = 'kingbase';
    storeState.connections[0].config.port = 54321;
    backendApp.DBGetColumns.mockResolvedValue({
      success: true,
      data: [{ Name: 'andon_dash_events_id', Type: 'bigint' }],
    });

    const props = {
      data: [] as any[],
      columnNames: [] as string[],
      loading: true,
      tableName: 'ldf_server.andon_dash_events',
      dbName: 'ldf_server_dbs',
      connectionId: 'conn-1',
      exportScope: 'table' as const,
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} />);
    });
    await waitForEffects();

    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBGetIndexes).not.toHaveBeenCalled();
    expect(backendApp.DBGetForeignKeys).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.update(
        <DataGrid
          {...props}
          data={[{ __gonavi_row_key__: 'row-1', andon_dash_events_id: 2 }]}
          columnNames={['andon_dash_events_id']}
          loading={false}
        />,
      );
    });
    await waitForEffects();

    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetIndexes).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetForeignKeys).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it('reloads column metadata after clicking refresh', async () => {
    storeState.queryOptions.showColumnComment = true;
    storeState.queryOptions.showColumnType = true;
    backendApp.DBGetColumns
      .mockResolvedValueOnce({
        success: true,
        data: [{ Name: 'id', Type: 'bigint', Comment: '旧备注' }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ Name: 'id', Type: 'varchar(64)', Comment: '新备注' }],
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
          columnNames={['id']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
    });
    await waitForEffects();

    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(1);
    expect(renderHeaderText('id')).toContain('旧备注');

    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onRefresh();
    });
    await waitForEffects();
    await waitForEffects();

    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(2);
    const headerText = renderHeaderText('id');
    expect(headerText).toContain('varchar(64)');
    expect(headerText).toContain('新备注');
    renderer!.unmount();
  });

  it('keeps pending local changes visible after refreshing the grid', async () => {
    const reloadSpy = vi.fn();

    const Harness = () => {
      const [rows, setRows] = React.useState([
        { __gonavi_row_key__: 'row-1', id: 1, name: 'old' },
      ]);

      return (
        <DataGrid
          data={rows}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
          editLocator={{
            strategy: 'primary-key',
            columns: ['id'],
            valueColumns: ['id'],
            readOnly: false,
          }}
          onReload={() => {
            reloadSpy();
            setRows([{ __gonavi_row_key__: 'row-1', id: 1, name: 'old' }]);
          }}
        />
      );
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await waitForEffects();

    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onAddRow();
    });
    await waitForEffects();

    expect(testRenderState.latestTableProps.dataSource).toHaveLength(2);
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.pendingChangeCount).toBe(1);

    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onRefresh();
    });
    await waitForEffects();
    await waitForEffects();

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(testRenderState.latestTableProps.dataSource).toHaveLength(2);
    expect(testRenderState.latestTableProps.dataSource[1][GONAVI_ROW_KEY]).toContain('new-');
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.pendingChangeCount).toBe(1);
    renderer!.unmount();
  });

  it('localizes v2 column header fallback labels', () => {
    setCurrentLanguage('en-US');

    const renderer = create(
      <V2ColumnHeaderContextMenuView
        fieldName=""
        columnType=""
        columnComment=""
        showColumnType={false}
        showColumnComment={false}
      />,
    );

    const content = textContent(renderer.root);
    expect(content).toContain(t('data_grid.context_menu.column_unnamed_field'));
    expect(content).toContain(t('data_grid.context_menu.column_unknown_type'));
    expect(content).toContain(t('data_grid.context_menu.column_no_comment'));
    expect(content).not.toContain(t('data_grid.context_menu.copy_column_comment'));
    expect(content).toContain(t('data_grid.context_menu.show_column_type'));
    expect(content).toContain(t('data_grid.context_menu.show_column_comment'));
    renderer.unmount();
  });

  it('localizes v2 table group menu labels and fallback metadata', () => {
    setCurrentLanguage('en-US');

    const renderer = create(
      <V2TableGroupContextMenuView
        dbName=""
        count={2}
        currentSort="frequency"
      />,
    );

    const content = textContent(renderer.root);
    expect(content).toContain(t('sidebar.v2_table_group_menu.title'));
    expect(content).toContain(t('sidebar.v2_table_group_menu.current_database'));
    expect(content).toContain(t('sidebar.v2_table_group_menu.sort_frequency'));
    expect(content).toContain(t('sidebar.menu.create_table'));
    expect(content).toContain(t('sidebar.menu.refresh'));
    expect(content).toContain(t('data_grid.context_menu.sort_section'));
    expect(content).toContain(t('sidebar.menu.sort_by_name'));
    expect(content).toContain(t('sidebar.menu.sort_by_frequency'));
    expect(content).toContain(t('data_grid.context_menu.current_marker'));
    ['表 · tables', '使用频率', '当前数据库', '张表', '当前按', '新建表', '排序', '按名称排序', '按使用频率排序', '当前'].forEach((rawSnippet) => {
      expect(content).not.toContain(rawSnippet);
    });
    renderer.unmount();
  });

  it('localizes v2 cell editing labels and fallback metadata', () => {
    setCurrentLanguage('en-US');

    const renderer = create(
      <V2CellContextMenuView
        fieldName=""
        tableName=""
        rowLabel=""
        selectedRowCount={3}
        selectedCellCount={4}
        canModifyData
        canEditCell
        copiedRowCount={2}
        canPasteCopiedColumns
      />,
    );

    const content = textContent(renderer.root);
    expect(content).toContain(t('data_grid.context_menu.column_unnamed_field'));
    expect(content).toContain(t('data_grid.context_menu.current_row'));
    expect(content).toContain(t('data_grid.context_menu.copy_field_name'));
    expect(content).toContain(t('data_grid.context_menu.edit_section'));
    expect(content).toContain(t('data_grid.context_menu.edit_cell_in_editor'));
    expect(content).toContain(t('data_grid.batch_fill.set_null'));
    expect(content).toContain(t('data_grid.batch_fill.set_null_selected'));
    expect(content).toContain(t('data_grid.context_menu.edit_row'));
    expect(content).toContain(t('data_grid.context_menu.copy_row_as_new'));
    expect(content).toContain(t('data_grid.context_menu.paste_row_as_new_count', { count: 2 }));
    expect(content).toContain(t('data_grid.context_menu.fill_to_selected_rows', { count: '3' }));
    expect(content).toContain(t('data_grid.context_menu.paste_copied_columns'));
    ['未命名字段', '当前行', '当前单元格', '复制字段名称', '编辑', '在编辑器中打开', '设置为 NULL', '编辑本行', '复制本行为新增行', '粘贴为新增行', '填充到选中行', '将填充模板应用到此行'].forEach((rawSnippet) => {
      expect(content).not.toContain(rawSnippet);
    });
    renderer.unmount();
  });

  it('exposes a distinct action for setting the selected cells to NULL', () => {
    const onAction = vi.fn();
    const renderer = create(
      <V2CellContextMenuView
        fieldName="status"
        selectedCellCount={2}
        canModifyData
        onAction={onAction}
      />,
    );

    const label = t('data_grid.batch_fill.set_null_selected');
    const button = findButton(renderer, label);
    expect(button).toBeTruthy();
    expect(button.props.disabled).toBe(false);

    act(() => {
      button.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onAction).toHaveBeenCalledWith('set-null-selected');
    renderer.unmount();

    const emptyRenderer = create(
      <V2CellContextMenuView
        fieldName="status"
        selectedCellCount={0}
        canModifyData
      />,
    );
    expect(findButton(emptyRenderer, label).props.disabled).toBe(true);
    emptyRenderer.unmount();
  });

  it('opens the v2 cell context menu for table cells instead of the legacy inline menu', async () => {


    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
          columnNames={['id']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    const idColumn = testRenderState.latestColumns.find((column) => column.key === 'id');
    const cellProps = idColumn.onCell({ __gonavi_row_key__: 'row-1', id: 1 });
    const contextTarget = {
      closest: (selector: string) => selector === '[data-row-key][data-col-name]'
        ? {
            getAttribute: (name: string) => {
              if (name === 'data-row-key') return 'row-1';
              if (name === 'data-col-name') return 'id';
              return null;
            },
          }
        : null,
    } as unknown as HTMLElement;
    await act(async () => {
      cellProps.onContextMenu({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 160,
        clientY: 120,
        currentTarget: contextTarget,
        target: contextTarget,
      });
    });

    expect(renderer!.root.findByProps({ 'data-v2-cell-context-menu': 'true' })).toBeTruthy();
    expect(textContent(renderer!.root)).toContain(t('data_grid.context_menu.copy_field_name'));
    expect(textContent(renderer!.root)).toContain(t('data_grid.context_menu.copy_row_data'));
    expect(textContent(renderer!.root)).toContain(t('data_grid.context_menu.copy_column_data'));
    expect(textContent(renderer!.root)).toContain(t('data_grid.context_menu.copy_as_insert'));
    expect(textContent(renderer!.root)).toContain(t('data_grid.toolbar.export'));
    renderer!.unmount();
  });

  it('opens a short non-JSON cell in the full editor from the v2 context menu', async () => {

    const rawText = 'hello "GoNavi"';
    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, notes: rawText }];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['id', 'notes']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
    });
    await waitForEffects();

    const notesColumn = testRenderState.latestColumns.find((column) => column.key === 'notes');
    const cellProps = notesColumn.onCell(rows[0]);
    const contextTarget = createRenderedCellTarget('row-1', 'notes');
    await act(async () => {
      cellProps.onContextMenu({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 160,
        clientY: 120,
        currentTarget: contextTarget,
        target: contextTarget,
      });
    });

    const openEditorButton = findButton(renderer!, t('data_grid.context_menu.edit_cell_in_editor'));
    expect(openEditorButton).toBeTruthy();
    await act(async () => {
      openEditorButton.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });

    const editor = renderer!.root.findByProps({
      'data-modal-title': t('data_grid.cell_editor.title_with_column', { column: 'notes' }),
    });
    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(rawText);
    expect(editor.findByProps({ 'data-grid-cell-editor-escape': 'true' })).toBeTruthy();
    expect(editor.findByProps({ 'data-grid-cell-editor-unescape': 'true' })).toBeTruthy();

    await act(async () => {
      editor.findByProps({ 'data-grid-cell-editor-escape': 'true' }).props.onClick();
    });
    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe('hello \\"GoNavi\\"');

    await act(async () => {
      findButton(renderer!, t('common.save')).props.onClick();
    });
    expect(testRenderState.latestTableProps.dataSource[0].notes).toBe('hello \\"GoNavi\\"');
    renderer!.unmount();
  });
});
