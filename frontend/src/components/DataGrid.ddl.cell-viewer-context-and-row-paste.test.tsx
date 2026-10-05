import dayjs from 'dayjs';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DataGrid, { GONAVI_ROW_KEY } from './DataGrid';
import { t } from '../i18n';
import { backendApp, testRenderState, messageApi } from './dataGridDdlTestState';
import { textContent, findButton, waitForEffects, createRenderedCellTarget } from './dataGridDdlTestHelpers';
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

  it('hides the cell viewer immediately when the data-source context changes', async () => {

    const rows = [{ __gonavi_row_key__: 'row-1', payload: 'value from the previous table' }];
    const props = {
      data: rows,
      columnNames: ['payload'],
      loading: false,
      dbName: 'main',
      connectionId: 'conn-1',
      readOnly: true,
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} tableName="query_result_a" />);
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'payload'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const viewerTitle = t('data_grid.cell_viewer.title_with_column', { column: 'payload' });
    expect(renderer!.root.findByProps({ 'data-modal-title': viewerTitle })).toBeTruthy();

    const flushableRenderer = renderer! as ReactTestRenderer & {
      unstable_flushSync: (callback: () => void) => void;
    };
    flushableRenderer.unstable_flushSync(() => {
      renderer!.update(<DataGrid {...props} tableName="query_result_b" />);
    });

    expect(renderer!.root.findAll((node) => node.props['data-modal-title'] === viewerTitle)).toHaveLength(0);
    renderer!.unmount();
  });

  it('rejects a stale cell editor save after the result data refreshes', async () => {

    const initialData = [{ __gonavi_row_key__: 'row-1', id: 1, payload: 'old line one\nold line two' }];
    const refreshedData = [{ __gonavi_row_key__: 'row-1', id: 1, payload: 'fresh line one\nfresh line two' }];
    const props = {
      columnNames: ['id', 'payload'],
      loading: false,
      tableName: 'users',
      dbName: 'main',
      connectionId: 'conn-1',
      pkColumns: ['id'],
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} data={initialData} />);
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'payload'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    let modalController = renderer!.root.findAll(
      (node) => typeof node.props.onCellEditorValueChange === 'function',
    )[0];
    await act(async () => {
      modalController.props.onCellEditorValueChange('STALE-EDITOR-DRAFT');
    });
    modalController = renderer!.root.findAll(
      (node) => typeof node.props.onCellEditorValueChange === 'function',
    )[0];
    const staleSave = modalController.props.onSaveCellEditor as () => void;

    await act(async () => {
      renderer!.update(<DataGrid {...props} data={refreshedData} />);
    });
    await waitForEffects();
    await act(async () => {
      staleSave();
    });
    await waitForEffects();

    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(refreshedData[0].payload);
    expect(testRenderState.latestTableProps.dataSource[0].payload).not.toBe('STALE-EDITOR-DRAFT');
    renderer!.unmount();
  });

  it('rejects a stale cell editor save after the data-source context changes', async () => {

    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, payload: 'old line one\nold line two' }];
    const props = {
      data: rows,
      columnNames: ['id', 'payload'],
      loading: false,
      dbName: 'main',
      connectionId: 'conn-1',
      pkColumns: ['id'],
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} tableName="users_a" />);
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'payload'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    let modalController = renderer!.root.findAll(
      (node) => typeof node.props.onCellEditorValueChange === 'function',
    )[0];
    await act(async () => {
      modalController.props.onCellEditorValueChange('STALE-CONTEXT-DRAFT');
    });
    modalController = renderer!.root.findAll(
      (node) => typeof node.props.onCellEditorValueChange === 'function',
    )[0];
    const staleSave = modalController.props.onSaveCellEditor as () => void;

    const flushableRenderer = renderer! as ReactTestRenderer & {
      unstable_flushSync: (callback: () => void) => void;
    };
    flushableRenderer.unstable_flushSync(() => {
      renderer!.update(<DataGrid {...props} tableName="users_b" />);
    });
    await act(async () => {
      staleSave();
    });

    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(rows[0].payload);
    expect(testRenderState.latestTableProps.dataSource[0].payload).not.toBe('STALE-CONTEXT-DRAFT');
    renderer!.unmount();
  });

  it.each(['data refresh', 'inactive result', 'permission loss'] as const)(
    'rejects a pending virtual inline save after %s',
    async (scenario) => {

      const initialData = [{ __gonavi_row_key__: 'row-1', id: 1, payload: 'old value' }];
      const refreshedData = [{ __gonavi_row_key__: 'row-1', id: 1, payload: 'fresh value' }];
      const writableEditLocator = {
        strategy: 'primary-key' as const,
        columns: ['id'],
        valueColumns: ['id'],
        readOnly: false,
        writableColumns: {
          id: 'id',
          payload: 'payload',
        },
      };
      const props = {
        columnNames: ['id', 'payload'],
        loading: false,
        tableName: 'users',
        dbName: 'main',
        connectionId: 'conn-1',
        editLocator: writableEditLocator,
      };

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<DataGrid {...props} data={initialData} isActive />);
      });
      await waitForEffects();

      const doubleClickSurface = renderer!.root.findAll(
        (node) => typeof node.props.onDoubleClickCapture === 'function',
      )[0];
      await act(async () => {
        doubleClickSurface.props.onDoubleClickCapture({
          target: createRenderedCellTarget('row-1', 'payload'),
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });

      const renderLatestPayloadCell = () => {
        const record = testRenderState.latestTableProps.dataSource[0];
        const column = testRenderState.latestColumns.find((item) => item.key === 'payload');
        return create(<div data-cell-harness="true">{column.render(record.payload, record, 0)}</div>);
      };
      const editingCell = renderLatestPayloadCell();
      const staleBlur = editingCell.root.findByProps({ className: 'data-grid-inline-editor-input' }).props.onBlur;
      editingCell.unmount();

      let resolveValidation!: (value: Record<string, unknown>) => void;
      testRenderState.formValidateFields.mockImplementationOnce(() => new Promise((resolve) => {
        resolveValidation = resolve;
      }));
      testRenderState.formGetFieldValue.mockReturnValue('STALE-VIRTUAL-DRAFT');
      await act(async () => {
        staleBlur();
        await Promise.resolve();
      });
      expect(testRenderState.formValidateFields).toHaveBeenCalledOnce();

      const flushableRenderer = renderer! as ReactTestRenderer & {
        unstable_flushSync: (callback: () => void) => void;
      };
      flushableRenderer.unstable_flushSync(() => {
        if (scenario === 'data refresh') {
          renderer!.update(<DataGrid {...props} data={refreshedData} isActive />);
        } else if (scenario === 'inactive result') {
          renderer!.update(<DataGrid {...props} data={initialData} isActive={false} />);
        } else {
          renderer!.update(
            <DataGrid
              {...props}
              data={initialData}
              isActive
              editLocator={{ ...writableEditLocator, writableColumns: { id: 'id' } }}
            />,
          );
        }
      });

      const hiddenCell = renderLatestPayloadCell();
      expect(hiddenCell.root.findAll(
        (node) => node.props.className === 'data-grid-inline-editor-input',
      )).toHaveLength(0);
      hiddenCell.unmount();

      await act(async () => {
        resolveValidation({});
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitForEffects();

      const expectedValue = scenario === 'data refresh' ? refreshedData[0].payload : initialData[0].payload;
      expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(expectedValue);
      expect(testRenderState.latestTableProps.dataSource[0].payload).not.toBe('STALE-VIRTUAL-DRAFT');
      expect(testRenderState.formGetFieldValue).not.toHaveBeenCalled();
      renderer!.unmount();
    },
  );

  it('ignores an old inline blur after reopening the same virtual cell', async () => {

    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, payload: 'old value' }];
    const props = {
      data: rows,
      columnNames: ['id', 'payload'],
      loading: false,
      tableName: 'users',
      dbName: 'main',
      connectionId: 'conn-1',
      pkColumns: ['id'],
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} />);
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    const openCell = async (target = createRenderedCellTarget('row-1', 'payload')) => {
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      await act(async () => {
        doubleClickSurface.props.onDoubleClickCapture({ target, preventDefault, stopPropagation });
      });
      return { preventDefault, stopPropagation };
    };
    const renderPayloadCell = () => {
      const record = testRenderState.latestTableProps.dataSource[0];
      const column = testRenderState.latestColumns.find((item) => item.key === 'payload');
      return create(<div>{column.render(record.payload, record, 0)}</div>);
    };

    await openCell();
    const firstCell = renderPayloadCell();
    const staleBlur = firstCell.root.findByProps({ className: 'data-grid-inline-editor-input' }).props.onBlur;
    firstCell.unmount();

    await openCell();
    const secondCell = renderPayloadCell();
    expect(secondCell.root.findByProps({ className: 'data-grid-inline-editor-input' })).toBeTruthy();
    secondCell.unmount();

    const inlineTarget = {
      closest: (selector: string) => {
        if (selector === '.data-grid-virtual-inline-editing') return {};
        return createRenderedCellTarget('row-1', 'payload').closest(selector);
      },
    } as unknown as HTMLElement;
    const inlineDoubleClick = await openCell(inlineTarget);
    expect(inlineDoubleClick.preventDefault).not.toHaveBeenCalled();
    expect(inlineDoubleClick.stopPropagation).not.toHaveBeenCalled();

    testRenderState.formValidateFields.mockClear();
    await act(async () => {
      staleBlur();
      await Promise.resolve();
    });

    expect(testRenderState.formValidateFields).not.toHaveBeenCalled();
    const currentCell = renderPayloadCell();
    expect(currentCell.root.findByProps({ className: 'data-grid-inline-editor-input' })).toBeTruthy();
    currentCell.unmount();
    renderer!.unmount();
  });

  it('ignores old datetime save and close timers after reopening the same virtual cell', async () => {
    vi.useFakeTimers();

    backendApp.DBGetColumns.mockResolvedValue({
      success: true,
      data: [
        { name: 'id', type: 'bigint' },
        { name: 'created_at', type: 'datetime' },
      ],
    });
    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, created_at: '2026-07-22 12:34:56' }];
    const props = {
      data: rows,
      columnNames: ['id', 'created_at'],
      loading: false,
      tableName: 'users',
      dbName: 'main',
      connectionId: 'conn-1',
      pkColumns: ['id'],
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} />);
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    const openDateCell = async () => {
      await act(async () => {
        doubleClickSurface.props.onDoubleClickCapture({
          target: createRenderedCellTarget('row-1', 'created_at'),
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });
      const record = testRenderState.latestTableProps.dataSource[0];
      const column = testRenderState.latestColumns.find((item) => item.key === 'created_at');
      const cell = create(<div>{column.render(record.created_at, record, 0)}</div>);
      expect(cell.root.findByProps({ 'data-date-picker': 'true' })).toBeTruthy();
      return cell;
    };

    const firstCell = await openDateCell();
    const stalePickerProps = testRenderState.latestDatePickerProps;
    expect(stalePickerProps).toBeTruthy();
    firstCell.unmount();

    act(() => {
      stalePickerProps.onOk(null);
      stalePickerProps.onOpenChange(false);
      stalePickerProps.onBlur();
    });
    const secondCell = await openDateCell();
    secondCell.unmount();

    testRenderState.formValidateFields.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testRenderState.formValidateFields).not.toHaveBeenCalled();
    const currentRecord = testRenderState.latestTableProps.dataSource[0];
    const currentColumn = testRenderState.latestColumns.find((item) => item.key === 'created_at');
    const currentCell = create(<div>{currentColumn.render(currentRecord.created_at, currentRecord, 0)}</div>);
    expect(currentCell.root.findByProps({ 'data-date-picker': 'true' })).toBeTruthy();
    currentCell.unmount();
    renderer!.unmount();
  });

  it('keeps a virtual datetime editor open while the picker briefly blurs during panel navigation', async () => {
    vi.useFakeTimers();

    backendApp.DBGetColumns.mockResolvedValue({
      success: true,
      data: [
        { name: 'id', type: 'bigint' },
        { name: 'created_at', type: 'datetime' },
      ],
    });
    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, created_at: '2026-07-22 12:34:56' }];
    const props = {
      data: rows,
      columnNames: ['id', 'created_at'],
      loading: false,
      tableName: 'users',
      dbName: 'main',
      connectionId: 'conn-1',
      pkColumns: ['id'],
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} />);
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'created_at'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const renderDateCell = () => {
      const record = testRenderState.latestTableProps.dataSource[0];
      const column = testRenderState.latestColumns.find((item) => item.key === 'created_at');
      return create(<div>{column.render(record.created_at, record, 0)}</div>);
    };
    const cell = renderDateCell();
    const pickerProps = testRenderState.latestDatePickerProps;
    expect(pickerProps).toBeTruthy();

    // rc-picker can emit input blur/open=false before the panel receives focus.
    act(() => {
      pickerProps.onBlur();
      pickerProps.onOpenChange(false);
      vi.advanceTimersByTime(0);
    });
    const stillEditing = renderDateCell();
    expect(stillEditing.root.findByProps({ 'data-date-picker': 'true' })).toBeTruthy();

    // Once the panel regains focus, the delayed blur guard must not close it.
    act(() => {
      pickerProps.onOpenChange(true);
      vi.advanceTimersByTime(200);
    });
    const afterPanelFocus = renderDateCell();
    expect(afterPanelFocus.root.findByProps({ 'data-date-picker': 'true' })).toBeTruthy();

    // Confirm still receives the complete datetime value.
    testRenderState.formGetFieldValue.mockReturnValue(undefined);
    act(() => {
      pickerProps.onOk(dayjs('2026-07-22 13:45:12'));
      vi.runAllTimers();
    });
    await waitForEffects();
    expect(testRenderState.latestTableProps.dataSource[0].created_at).toBe('2026-07-22 13:45:12');

    cell.unmount();
    stillEditing.unmount();
    afterPanelFocus.unmount();
    renderer!.unmount();
  });

  it('keeps a virtual date editor open during panel navigation and preserves its original time on save', async () => {
    vi.useFakeTimers();

    backendApp.DBGetColumns.mockResolvedValue({
      success: true,
      data: [
        { name: 'id', type: 'bigint' },
        { name: 'register_date', type: 'date' },
      ],
    });
    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, register_date: '2020-01-05 12:34:56' }];
    const props = {
      data: rows,
      columnNames: ['id', 'register_date'],
      loading: false,
      tableName: 'users',
      dbName: 'main',
      connectionId: 'conn-1',
      pkColumns: ['id'],
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} />);
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'register_date'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const renderDateCell = () => {
      const record = testRenderState.latestTableProps.dataSource[0];
      const column = testRenderState.latestColumns.find((item) => item.key === 'register_date');
      return create(<div>{column.render(record.register_date, record, 0)}</div>);
    };
    const cell = renderDateCell();
    const pickerProps = testRenderState.latestDatePickerProps;
    expect(pickerProps).toBeTruthy();
    expect(pickerProps.picker).toBe('date');

    // Navigating the portal panel must not commit or dismiss the cell editor.
    act(() => {
      pickerProps.onBlur();
      pickerProps.onOpenChange(false);
      vi.advanceTimersByTime(0);
      pickerProps.onOpenChange(true);
      vi.advanceTimersByTime(200);
    });
    const afterPanelNavigation = renderDateCell();
    expect(afterPanelNavigation.root.findByProps({ 'data-date-picker': 'true' })).toBeTruthy();

    // Selecting a day submits the new date but keeps the source HH:mm:ss portion.
    testRenderState.formGetFieldValue.mockReturnValue(undefined);
    act(() => {
      pickerProps.onChange(dayjs('2020-01-06'));
      pickerProps.onOpenChange(false);
      vi.advanceTimersByTime(200);
    });
    await waitForEffects();
    expect(testRenderState.latestTableProps.dataSource[0].register_date).toBe('2020-01-06 12:34:56');

    cell.unmount();
    afterPanelNavigation.unmount();
    renderer!.unmount();
  });

  it('opens a refreshed row value without waiting for passive effects', async () => {

    const initialData = [{ __gonavi_row_key__: 'row-1', payload: 'old result value' }];
    const refreshedData = [{ __gonavi_row_key__: 'row-1', payload: 'fresh result value' }];
    const props = {
      columnNames: ['payload'],
      loading: false,
      tableName: 'query_result',
      dbName: 'main',
      connectionId: 'conn-1',
      readOnly: true,
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} data={initialData} />);
    });
    await waitForEffects();

    const flushableRenderer = renderer! as ReactTestRenderer & {
      unstable_flushSync: (callback: () => void) => void;
    };
    flushableRenderer.unstable_flushSync(() => {
      renderer!.update(<DataGrid {...props} data={refreshedData} />);
    });
    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'payload'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
    await waitForEffects();

    const viewerTitle = t('data_grid.cell_viewer.title_with_column', { column: 'payload' });
    const viewer = renderer!.root.findByProps({ 'data-modal-title': viewerTitle });
    expect(textContent(viewer.findByProps({ 'data-monaco-editor': 'true' }))).toBe(refreshedData[0].payload);
    renderer!.unmount();
  });

  it('exports query-result rows as INSERT SQL with an empty target table without rerunning ExportQuery', async () => {
    backendApp.ExportDataWithOptions.mockResolvedValue({ success: true });
    backendApp.ExportQueryWithOptions.mockResolvedValue({ success: true });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[
            { __gonavi_row_key__: 'row-1', owner: 'sa' },
            { __gonavi_row_key__: 'row-2', owner: 'dbo' },
          ]}
          columnNames={['owner']}
          loading={false}
          exportScope="queryResult"
          resultSql="EXEC sp_helpdb"
          dbName="master"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    act(() => {
      findButton(renderer!, t('data_grid.toolbar.export')).props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      await renderer!.root.findByProps({ 'data-select-option': 'sql' }).props.onClick();
    });
    await act(async () => {
      await renderer!.root.findByProps({ 'data-select-option': 'page' }).props.onClick();
    });
    await act(async () => {
      await findButton(renderer!, '开始导出').props.onClick();
    });
    await waitForEffects();

    expect(backendApp.ExportDataWithOptions).toHaveBeenCalledTimes(1);
    expect(backendApp.ExportDataWithOptions).toHaveBeenCalledWith(
      [{ owner: 'sa' }, { owner: 'dbo' }],
      ['owner'],
      'export',
      expect.objectContaining({
        format: 'sql',
        insertSQLDialect: 'mysql',
        insertSQLTargetTable: '',
        insertSQLAllowEmptyTargetTable: true,
        totalRowsHint: 2,
        totalRowsKnown: true,
      }),
    );
    expect(backendApp.ExportQueryWithOptions).not.toHaveBeenCalled();
  });

  it('exports known-table query results as INSERT SQL', async () => {
    backendApp.ExportDataWithOptions.mockResolvedValue({ success: true });
    backendApp.DBGetColumns.mockResolvedValue({
      success: true,
      data: [
        { name: 'id', type: 'int' },
        { name: 'name', type: 'varchar' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[
            { __gonavi_row_key__: 'row-1', id: 1, name: "O'Brien" },
            { __gonavi_row_key__: 'row-2', id: 2, name: null },
          ]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          exportScope="queryResult"
          resultSql="SELECT id, name FROM users"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    act(() => {
      findButton(renderer!, t('data_grid.toolbar.export')).props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      await renderer!.root.findByProps({ 'data-select-option': 'sql' }).props.onClick();
    });
    await act(async () => {
      await renderer!.root.findByProps({ 'data-select-option': 'page' }).props.onClick();
    });
    await act(async () => {
      await findButton(renderer!, '开始导出').props.onClick();
    });
    await waitForEffects();

    expect(backendApp.ExportDataWithOptions).toHaveBeenCalledWith(
      [
        { id: 1, name: "O'Brien" },
        { id: 2, name: null },
      ],
      ['id', 'name'],
      'users',
      expect.objectContaining({
        format: 'sql',
        insertSQLDialect: 'mysql',
        insertSQLTargetTable: 'users',
        totalRowsHint: 2,
        totalRowsKnown: true,
      }),
    );
  });

  it('requeries all known-table rows when exporting INSERT SQL', async () => {
    backendApp.ExportQueryWithOptions.mockResolvedValue({ success: true });
    backendApp.DBGetColumns.mockResolvedValue({
      success: true,
      data: [{ name: 'id', type: 'int' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
          columnNames={['id']}
          loading={false}
          tableName="users"
          exportScope="queryResult"
          resultSql="SELECT id FROM users"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    act(() => {
      findButton(renderer!, t('data_grid.toolbar.export')).props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      await renderer!.root.findByProps({ 'data-select-option': 'sql' }).props.onClick();
    });
    await act(async () => {
      await findButton(renderer!, '开始导出').props.onClick();
    });
    await waitForEffects();

    expect(backendApp.ExportQueryWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql', database: 'main' }),
      'main',
      'SELECT id FROM users',
      'users',
      expect.objectContaining({
        format: 'sql',
        insertSQLDialect: 'mysql',
        insertSQLTargetTable: 'users',
        totalRowsHint: 0,
        totalRowsKnown: false,
      }),
    );
    expect(backendApp.ExportDataWithOptions).not.toHaveBeenCalled();
  });

  it('exports unmatched query-result columns with an empty INSERT target table', async () => {
    backendApp.ExportDataWithOptions.mockResolvedValue({ success: true });
    backendApp.DBGetColumns.mockResolvedValue({
      success: true,
      data: [{ name: 'id', type: 'int' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', user_id: 1 }]}
          columnNames={['user_id']}
          loading={false}
          tableName="users"
          exportScope="queryResult"
          resultSql="SELECT id AS user_id FROM users"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    act(() => {
      findButton(renderer!, t('data_grid.toolbar.export')).props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      await renderer!.root.findByProps({ 'data-select-option': 'sql' }).props.onClick();
    });
    await act(async () => {
      await renderer!.root.findByProps({ 'data-select-option': 'page' }).props.onClick();
    });
    await act(async () => {
      await findButton(renderer!, '开始导出').props.onClick();
    });
    await waitForEffects();

    expect(backendApp.ExportDataWithOptions).toHaveBeenCalledWith(
      [{ user_id: 1 }],
      ['user_id'],
      'users',
      expect.objectContaining({
        format: 'sql',
        insertSQLTargetTable: '',
        insertSQLAllowEmptyTargetTable: true,
      }),
    );
  });

  it('copies loaded column data from the v2 column header context menu', async () => {


    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[
            { __gonavi_row_key__: 'row-1', id: 1, name: 'alpha' },
            { __gonavi_row_key__: 'row-2', id: 2, name: 'beta' },
          ]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    const idColumn = testRenderState.latestColumns.find((column) => column.key === 'id');
    const headerProps = idColumn.onHeaderCell(idColumn);
    await act(async () => {
      headerProps.onContextMenu({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 120,
        clientY: 88,
      });
    });

    await act(async () => {
      findButton(renderer!, t('data_grid.context_menu.copy_column_data')).props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('1\n2');
    renderer!.unmount();
  });

  it('copies row and column data from the v2 cell context menu', async () => {


    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[
            { __gonavi_row_key__: 'row-1', id: 1, name: 'alpha' },
            { __gonavi_row_key__: 'row-2', id: 2, name: 'beta' },
          ]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    const nameColumn = testRenderState.latestColumns.find((column) => column.key === 'name');
    const cellProps = nameColumn.onCell({ __gonavi_row_key__: 'row-1', id: 1, name: 'alpha' });
    const contextTarget = {
      closest: (selector: string) => selector === '[data-row-key][data-col-name]'
        ? {
            getAttribute: (name: string) => {
              if (name === 'data-row-key') return 'row-1';
              if (name === 'data-col-name') return 'name';
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

    await act(async () => {
      findButton(renderer!, t('data_grid.context_menu.copy_row_data')).props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('id\tname\n1\talpha');

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
    await act(async () => {
      findButton(renderer!, t('data_grid.context_menu.copy_column_data')).props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('alpha\nbeta');
    renderer!.unmount();
  });

  it('copies the current row for paste and pastes it as a new row from the v2 cell context menu', async () => {


    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[
            { __gonavi_row_key__: 'row-1', id: 1, name: 'alpha' },
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

    const nameColumn = testRenderState.latestColumns.find((column) => column.key === 'name');
    const contextTarget = {
      closest: (selector: string) => selector === '[data-row-key][data-col-name]'
        ? {
            getAttribute: (name: string) => {
              if (name === 'data-row-key') return 'row-1';
              if (name === 'data-col-name') return 'name';
              return null;
            },
          }
        : null,
    } as unknown as HTMLElement;

    const openMenu = async () => {
      const cellProps = nameColumn.onCell({ __gonavi_row_key__: 'row-1', id: 1, name: 'alpha' });
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
    };

    await openMenu();
    await act(async () => {
      findButton(renderer!, t('data_grid.context_menu.copy_row_as_new')).props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    expect(messageApi.success).toHaveBeenCalledWith(t('data_grid.message.copied_rows', { count: 1 }));

    await openMenu();
    await act(async () => {
      findButton(renderer!, t('data_grid.context_menu.paste_row_as_new_count', { count: 1 })).props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    expect(messageApi.success).toHaveBeenCalledWith(t('data_grid.message.pasted_rows_as_new', { count: 1 }));
    expect(testRenderState.latestTableProps.dataSource).toHaveLength(2);
    expect(testRenderState.latestTableProps.dataSource[1][GONAVI_ROW_KEY]).toContain('paste-');
    renderer!.unmount();
  });
});
