import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DataGrid, { formatCellDisplayText } from './DataGrid';
import DataGridToolbarFrame from './DataGridToolbarFrame';
import { t } from '../i18n';
import { storeState, testRenderState, messageApi } from './dataGridDdlTestState';
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

  it('opens the complete cell value in a read-only viewer on double-click', async () => {

    const fullValue = `${'A long query-result segment. '.repeat(12)}END-OF-CELL-VALUE`;
    const rows = [{ __gonavi_row_key__: 'row-1', payload: fullValue }];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['payload']}
          loading={false}
          tableName="query_result"
          dbName="main"
          connectionId="conn-1"
          readOnly
        />,
      );
    });
    await waitForEffects();

    expect(fullValue.length).toBeGreaterThan(240);
    const previewText = formatCellDisplayText(fullValue);
    expect(previewText).toContain('…');
    expect(previewText).not.toContain('END-OF-CELL-VALUE');

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    expect(doubleClickSurface).toBeTruthy();

    const cellTarget = {
      closest: (selector: string) => selector === '[data-row-key][data-col-name]'
        ? {
            getAttribute: (name: string) => {
              if (name === 'data-row-key') return 'row-1';
              if (name === 'data-col-name') return 'payload';
              return null;
            },
          }
        : null,
    } as unknown as HTMLElement;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: cellTarget,
        preventDefault,
        stopPropagation,
      });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    const viewerTitle = t('data_grid.cell_viewer.title_with_column', { column: 'payload' });
    const viewer = renderer!.root.findByProps({ 'data-modal-title': viewerTitle });
    expect(textContent(viewer)).toContain(fullValue);
    expect(viewer.findByProps({ 'data-monaco-editor': 'true' }).props['data-read-only']).toBe('true');
    expect(viewer.findByProps({ 'data-monaco-editor': 'true' }).props['data-dom-read-only']).toBe('true');
    expect(viewer.findAll((node) => node.type === 'button' && textContent(node).includes(t('common.save')))).toHaveLength(0);
    expect(viewer.findAll((node) => node.type === 'button' && textContent(node).includes(t('common.close')))).toHaveLength(1);
    expect(viewer.findAll((node) => node.type === 'button')).toHaveLength(1);
    renderer!.unmount();
  });

  it('formats JSON in a protected read-only cell viewer without enabling save', async () => {
    const compactJson = '{"billType":"YDApp","data":{"items":[{"count":100}]}}';
    const formattedJson = JSON.stringify(JSON.parse(compactJson), null, 2);
    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, payload: compactJson }];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['id', 'payload']}
          loading={false}
          tableName="orders"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
          readOnly
        />,
      );
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

    const viewer = renderer!.root.findByProps({
      'data-modal-title': t('data_grid.cell_viewer.title_with_column', { column: 'payload' }),
    });
    const formatButton = viewer.findByProps({ 'data-grid-cell-editor-format': 'true' });
    expect(viewer.findByProps({ 'data-monaco-editor': 'true' }).props['data-read-only']).toBe('true');
    expect(viewer.findByProps({ 'data-grid-cell-editor-compact-json': 'true' })).toBeTruthy();
    expect(viewer.findAllByProps({ 'data-grid-cell-editor-escape': 'true' })).toHaveLength(0);
    expect(viewer.findAllByProps({ 'data-grid-cell-editor-unescape': 'true' })).toHaveLength(0);
    expect(viewer.findAll((node) => node.type === 'button' && textContent(node).includes(t('common.save')))).toHaveLength(0);

    await act(async () => {
      formatButton.props.onClick();
    });

    expect(textContent(viewer.findByProps({ 'data-monaco-editor': 'true' }))).toBe(formattedJson);
    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(compactJson);
    renderer!.unmount();
  });

  it('formats a writable JSON cell from the toolbar before saving the draft', async () => {

    const compactJson = '{"billType":"YDApp","data":{"items":[{"count":100}]}}';
    const formattedJson = JSON.stringify(JSON.parse(compactJson), null, 2);
    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, payload: compactJson }];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['id', 'payload']}
          loading={false}
          tableName="orders"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
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

    const editorTitle = t('data_grid.cell_editor.title_with_column', { column: 'payload' });
    const editor = renderer!.root.findByProps({ 'data-modal-title': editorTitle });
    const toolbar = editor.findByProps({ 'data-grid-cell-editor-toolbar': 'true' });
    const formatButton = toolbar.findByProps({ 'data-grid-cell-editor-format': 'true' });
    const compactButton = toolbar.findByProps({ 'data-grid-cell-editor-compact-json': 'true' });
    const escapeButton = toolbar.findByProps({ 'data-grid-cell-editor-escape': 'true' });
    const unescapeButton = toolbar.findByProps({ 'data-grid-cell-editor-unescape': 'true' });
    expect(formatButton.props.icon).toBeTruthy();
    expect(compactButton.props.icon).toBeTruthy();
    expect(escapeButton.props.icon).toBeTruthy();
    expect(unescapeButton.props.icon).toBeTruthy();
    expect(formatButton.props.disabled).not.toBe(true);
    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(compactJson);

    await act(async () => {
      formatButton.props.onClick();
    });

    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(formattedJson);
    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(compactJson);

    await act(async () => {
      escapeButton.props.onClick();
    });

    const escapedFormattedJson = formattedJson
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(escapedFormattedJson);
    expect(escapedFormattedJson.split('\n')).toHaveLength(formattedJson.split('\n').length);
    expect(escapedFormattedJson).not.toContain('\\n');
    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(compactJson);
    expect(editor.findByProps({ 'data-grid-cell-editor-escape': 'true' }).props.disabled).toBe(true);
    expect(editor.findByProps({ 'data-grid-cell-editor-format': 'true' }).props.disabled).toBe(true);
    expect(editor.findByProps({ 'data-grid-cell-editor-compact-json': 'true' }).props.disabled).toBe(true);

    await act(async () => {
      editor.findByProps({ 'data-grid-cell-editor-escape': 'true' }).props.onClick();
    });

    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(escapedFormattedJson);

    await act(async () => {
      unescapeButton.props.onClick();
    });

    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(formattedJson);
    expect(editor.findByProps({ 'data-grid-cell-editor-escape': 'true' }).props.disabled).not.toBe(true);
    expect(editor.findByProps({ 'data-grid-cell-editor-format': 'true' }).props.disabled).not.toBe(true);
    expect(editor.findByProps({ 'data-grid-cell-editor-compact-json': 'true' }).props.disabled).not.toBe(true);

    await act(async () => {
      findButton(renderer!, t('common.save')).props.onClick();
    });

    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(formattedJson);
    renderer!.unmount();
  });

  it('compacts a writable JSON cell without changing the row before saving', async () => {

    const payload = { billType: 'YDApp', data: { items: [{ count: 100 }] } };
    const formattedJson = JSON.stringify(payload, null, 2);
    const compactJson = JSON.stringify(payload);
    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, payload: formattedJson }];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['id', 'payload']}
          loading={false}
          tableName="orders"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
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

    const editor = renderer!.root.findByProps({
      'data-modal-title': t('data_grid.cell_editor.title_with_column', { column: 'payload' }),
    });
    const compactButton = editor.findByProps({ 'data-grid-cell-editor-compact-json': 'true' });
    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(formattedJson);

    await act(async () => {
      compactButton.props.onClick();
    });

    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(compactJson);
    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(formattedJson);

    await act(async () => {
      findButton(renderer!, t('common.save')).props.onClick();
    });

    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(compactJson);
    renderer!.unmount();
  });

  it('escapes and unescapes a writable text cell from the editor toolbar', async () => {

    const rawText = 'line 1\n"quoted"\\path\tend';
    const escapedText = 'line 1\n\\"quoted\\"\\\\path\tend';
    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, notes: rawText }];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['id', 'notes']}
          loading={false}
          tableName="orders"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'notes'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const editor = renderer!.root.findByProps({
      'data-modal-title': t('data_grid.cell_editor.title_with_column', { column: 'notes' }),
    });
    const escapeButton = editor.findByProps({ 'data-grid-cell-editor-escape': 'true' });
    const unescapeButton = editor.findByProps({ 'data-grid-cell-editor-unescape': 'true' });
    expect(editor.findAllByProps({ 'data-grid-cell-editor-format': 'true' })).toHaveLength(0);
    expect(editor.findAllByProps({ 'data-grid-cell-editor-compact-json': 'true' })).toHaveLength(0);

    await act(async () => {
      escapeButton.props.onClick();
    });
    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(escapedText);
    expect(testRenderState.latestTableProps.dataSource[0].notes).toBe(rawText);

    await act(async () => {
      unescapeButton.props.onClick();
    });
    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(rawText);

    await act(async () => {
      escapeButton.props.onClick();
    });
    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(escapedText);

    await act(async () => {
      findButton(renderer!, t('common.save')).props.onClick();
    });

    expect(testRenderState.latestTableProps.dataSource[0].notes).toBe(escapedText);
    renderer!.unmount();
  });

  it('preserves spaced and empty quoted column aliases when resolving a read-only cell', async () => {

    const columnNames = [' payload ', ''];
    const expectedValues: Record<string, string> = {
      ' payload ': 'value under a spaced alias',
      '': 'value under an empty alias',
    };
    const rows = [{ __gonavi_row_key__: 'row-1', ...expectedValues }];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={columnNames}
          loading={false}
          tableName="query_result"
          dbName="main"
          connectionId="conn-1"
          readOnly
        />,
      );
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    for (const columnName of columnNames) {
      await act(async () => {
        doubleClickSurface.props.onDoubleClickCapture({
          target: createRenderedCellTarget('row-1', columnName),
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });

      const viewerTitle = t('data_grid.cell_viewer.title_with_column', { column: columnName });
      const viewer = renderer!.root.findByProps({ 'data-modal-title': viewerTitle });
      expect(textContent(viewer.findByProps({ 'data-monaco-editor': 'true' }))).toBe(expectedValues[columnName]);
      await act(async () => {
        findButton(renderer!, t('common.close')).props.onClick();
      });
    }
    renderer!.unmount();
  });

  it('preserves raw MongoDB strings and nested values in the read-only viewer', async () => {

    storeState.connections[0].config.type = 'mongodb';
    const merchantId = '5a7fb5b93560e06a6e1e4950';
    const payload = {
      merchantId,
      updateTime: '2018-06-24 07:42:51.8',
    };
    const rows = [{ __gonavi_row_key__: 'row-1', merchantId, payload }];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['merchantId', 'payload']}
          loading={false}
          tableName="query_result"
          dbName="main"
          connectionId="conn-1"
          readOnly
        />,
      );
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    const openViewer = async (columnName: string) => {
      await act(async () => {
        doubleClickSurface.props.onDoubleClickCapture({
          target: createRenderedCellTarget('row-1', columnName),
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });
      return renderer!.root.findByProps({
        'data-modal-title': t('data_grid.cell_viewer.title_with_column', { column: columnName }),
      });
    };

    let viewer = await openViewer('merchantId');
    expect(textContent(viewer.findByProps({ 'data-monaco-editor': 'true' }))).toBe(merchantId);
    expect(textContent(viewer)).not.toContain('ObjectId(');
    await act(async () => {
      findButton(renderer!, t('common.close')).props.onClick();
    });

    viewer = await openViewer('payload');
    expect(textContent(viewer.findByProps({ 'data-monaco-editor': 'true' }))).toBe(JSON.stringify(payload, null, 2));
    expect(textContent(viewer)).not.toContain('ISODate(');
    renderer!.unmount();
  });

  it('opens non-writable projected cells in the viewer while the result remains editable', async () => {

    const rows = [{
      __gonavi_row_key__: 'row-1',
      id: 1,
      computed_label: 'computed value that cannot be written back',
      notes: 'writable value',
    }];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['id', 'computed_label', 'notes']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          editLocator={{
            strategy: 'primary-key',
            columns: ['id'],
            valueColumns: ['id'],
            readOnly: false,
            writableColumns: {
              id: 'id',
              notes: 'notes',
            },
          }}
        />,
      );
    });
    await waitForEffects();

    expect(testRenderState.latestColumns.find((column) => column.key === 'computed_label')?.editable).toBe(false);
    expect(testRenderState.latestColumns.find((column) => column.key === 'notes')?.editable).toBe(true);
    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'computed_label'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const viewerTitle = t('data_grid.cell_viewer.title_with_column', { column: 'computed_label' });
    const viewer = renderer!.root.findByProps({ 'data-modal-title': viewerTitle });
    expect(textContent(viewer.findByProps({ 'data-monaco-editor': 'true' }))).toBe(rows[0].computed_label);
    expect(viewer.findAll((node) => node.type === 'button')).toHaveLength(1);
    renderer!.unmount();
  });

  it('shows a pending edited value when the field later becomes read-only', async () => {

    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, payload: 'original value' }];
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
      data: rows,
      columnNames: ['id', 'payload'],
      loading: false,
      tableName: 'users',
      dbName: 'main',
      connectionId: 'conn-1',
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} editLocator={writableEditLocator} />);
    });
    await waitForEffects();

    let doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'payload'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const record = testRenderState.latestTableProps.dataSource[0];
    const payloadColumn = testRenderState.latestColumns.find((item) => item.key === 'payload');
    const editingCell = create(<div>{payloadColumn.render(record.payload, record, 0)}</div>);
    const blur = editingCell.root.findByProps({ className: 'data-grid-inline-editor-input' }).props.onBlur;
    testRenderState.formGetFieldValue.mockReturnValue('pending edited value');
    await act(async () => {
      blur();
      await Promise.resolve();
      await Promise.resolve();
    });
    editingCell.unmount();
    await waitForEffects();

    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe('pending edited value');

    await act(async () => {
      renderer!.update(
        <DataGrid
          {...props}
          editLocator={{ ...writableEditLocator, writableColumns: { id: 'id' } }}
        />,
      );
    });
    await waitForEffects();

    doubleClickSurface = renderer!.root.findAll(
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
    const viewer = renderer!.root.findByProps({ 'data-modal-title': viewerTitle });
    expect(textContent(viewer.findByProps({ 'data-monaco-editor': 'true' }))).toBe('pending edited value');
    renderer!.unmount();
  });

  it('marks the whole cell only after an inline edit becomes pending', async () => {

    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, payload: 'original value' }];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['id', 'payload']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          editLocator={{
            strategy: 'primary-key',
            columns: ['id'],
            valueColumns: ['id'],
            readOnly: false,
            writableColumns: {
              id: 'id',
              payload: 'payload',
            },
          }}
        />,
      );
    });
    await waitForEffects();

    const getPayloadCellState = () => {
      const record = testRenderState.latestTableProps.dataSource[0];
      const column = testRenderState.latestColumns.find((item) => item.key === 'payload');
      return { record, column, cellProps: column.onCell(record) };
    };
    const openPayloadEditor = async () => {
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
      return getPayloadCellState();
    };
    const blurPayloadEditor = async (nextValue: string) => {
      const { record, column } = getPayloadCellState();
      const editingCell = create(<div>{column.render(record.payload, record, 0)}</div>);
      const blur = editingCell.root.findByProps({ className: 'data-grid-inline-editor-input' }).props.onBlur;
      testRenderState.formGetFieldValue.mockReturnValue(nextValue);
      await act(async () => {
        blur();
        await Promise.resolve();
        await Promise.resolve();
      });
      editingCell.unmount();
      await waitForEffects();
      return getPayloadCellState();
    };

    let cellState = getPayloadCellState();
    expect(cellState.cellProps['data-cell-modified']).toBeUndefined();

    cellState = await openPayloadEditor();
    expect(cellState.cellProps['data-cell-modified']).toBeUndefined();
    expect(cellState.cellProps['data-cell-editing']).toBe('true');

    cellState = await blurPayloadEditor('pending edited value');
    expect(cellState.cellProps['data-cell-modified']).toBe('true');
    expect(cellState.cellProps['data-cell-editing']).toBeUndefined();

    const pendingCell = cellState.column.render(cellState.record.payload, cellState.record, 0);
    expect(pendingCell?.props?.style?.backgroundColor).toBeUndefined();

    cellState = await openPayloadEditor();
    expect(cellState.cellProps['data-cell-modified']).toBeUndefined();
    expect(cellState.cellProps['data-cell-editing']).toBe('true');

    cellState = await blurPayloadEditor('pending edited value');
    expect(cellState.cellProps['data-cell-modified']).toBe('true');
    expect(cellState.cellProps['data-cell-editing']).toBeUndefined();

    await openPayloadEditor();
    cellState = await blurPayloadEditor('original value');
    expect(cellState.record.payload).toBe('original value');
    expect(cellState.cellProps['data-cell-modified']).toBeUndefined();
    expect(cellState.cellProps['data-cell-editing']).toBeUndefined();
    renderer!.unmount();
  });

  it('keeps a pending MongoDB value in the viewer after the field becomes read-only', async () => {

    storeState.connections[0].config.type = 'mongodb';
    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, payload: 'original MongoDB value' }];
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
      data: rows,
      columnNames: ['id', 'payload'],
      loading: false,
      tableName: 'users',
      dbName: 'main',
      connectionId: 'conn-1',
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} editLocator={writableEditLocator} />);
    });
    await waitForEffects();

    let doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'payload'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const record = testRenderState.latestTableProps.dataSource[0];
    const payloadColumn = testRenderState.latestColumns.find((item) => item.key === 'payload');
    const editingCell = create(<div>{payloadColumn.render(record.payload, record, 0)}</div>);
    const blur = editingCell.root.findByProps({ className: 'data-grid-inline-editor-input' }).props.onBlur;
    testRenderState.formGetFieldValue.mockReturnValue('pending MongoDB value');
    await act(async () => {
      blur();
      await Promise.resolve();
      await Promise.resolve();
    });
    editingCell.unmount();
    await waitForEffects();

    await act(async () => {
      renderer!.update(
        <DataGrid
          {...props}
          editLocator={{ ...writableEditLocator, writableColumns: { id: 'id' } }}
        />,
      );
    });
    await waitForEffects();

    doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'payload'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const viewer = renderer!.root.findByProps({
      'data-modal-title': t('data_grid.cell_viewer.title_with_column', { column: 'payload' }),
    });
    expect(textContent(viewer.findByProps({ 'data-monaco-editor': 'true' }))).toBe('pending MongoDB value');
    renderer!.unmount();
  });

  it('keeps a batch-filled MongoDB draft after another cell edit creates a full-row patch', async () => {

    storeState.connections[0].config.type = 'mongodb';
    messageApi.info.mockResolvedValue(undefined);
    const rows = [{
      __gonavi_row_key__: 'row-1',
      id: 1,
      notes: 'original notes',
      payload: 'original payload',
    }];
    const writableEditLocator = {
      strategy: 'primary-key' as const,
      columns: ['id'],
      valueColumns: ['id'],
      readOnly: false,
      writableColumns: {
        id: 'id',
        notes: 'notes',
        payload: 'payload',
      },
    };
    const props = {
      data: rows,
      columnNames: ['id', 'notes', 'payload'],
      loading: false,
      tableName: 'users',
      dbName: 'main',
      connectionId: 'conn-1',
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} editLocator={writableEditLocator} />);
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'notes'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const record = testRenderState.latestTableProps.dataSource[0];
    const notesColumn = testRenderState.latestColumns.find((item) => item.key === 'notes');
    const editingCell = create(<div>{notesColumn.render(record.notes, record, 0)}</div>);
    testRenderState.formGetFieldValue.mockReturnValue('edited notes');
    await act(async () => {
      editingCell.root.findByProps({ className: 'data-grid-inline-editor-input' }).props.onBlur();
      await Promise.resolve();
      await Promise.resolve();
    });
    editingCell.unmount();
    await waitForEffects();

    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onToggleCellEditMode();
    });
    await waitForEffects();

    const payloadColumn = testRenderState.latestColumns.find((item) => item.key === 'payload');
    const payloadHeaderProps = payloadColumn.onHeaderCell(payloadColumn);
    await act(async () => {
      payloadHeaderProps.onClickCapture({
        target: { closest: vi.fn(() => null) },
        currentTarget: { querySelector: vi.fn(() => null) },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onOpenBatchEditModal();
    });

    let batchEditor = renderer!.root.findAll(
      (node) => typeof node.props.onApplyBatchFill === 'function',
    )[0];
    await act(async () => {
      batchEditor.props.onBatchEditValueChange('batch-filled draft');
    });
    batchEditor = renderer!.root.findAll(
      (node) => typeof node.props.onApplyBatchFill === 'function',
    )[0];
    await act(async () => {
      batchEditor.props.onApplyBatchFill();
    });
    await waitForEffects();

    expect(testRenderState.latestTableProps.dataSource[0]).toMatchObject({
      notes: 'edited notes',
      payload: 'batch-filled draft',
    });

    await act(async () => {
      renderer!.update(
        <DataGrid
          {...props}
          editLocator={{
            ...writableEditLocator,
            writableColumns: { id: 'id', notes: 'notes' },
          }}
        />,
      );
    });
    await waitForEffects();

    const readOnlyDoubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      readOnlyDoubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'payload'),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const viewer = renderer!.root.findByProps({
      'data-modal-title': t('data_grid.cell_viewer.title_with_column', { column: 'payload' }),
    });
    expect(textContent(viewer.findByProps({ 'data-monaco-editor': 'true' }))).toBe('batch-filled draft');
    renderer!.unmount();
  });

  it('closes an open cell editor without exposing its draft when permissions change', async () => {

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
    const restrictedEditLocator = {
      ...writableEditLocator,
      writableColumns: {
        id: 'id',
      },
    };
    const props = {
      data: [{ __gonavi_row_key__: 'row-1', id: 1, payload: 'line one\nline two' }],
      columnNames: ['id', 'payload'],
      loading: false,
      tableName: 'users',
      dbName: 'main',
      connectionId: 'conn-1',
      editLocator: writableEditLocator,
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} />);
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    const cellTarget = createRenderedCellTarget('row-1', 'payload');

    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: cellTarget,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const editorTitle = t('data_grid.cell_editor.title_with_column', { column: 'payload' });
    const editor = renderer!.root.findByProps({ 'data-modal-title': editorTitle });
    expect(editor.findByProps({ 'data-monaco-editor': 'true' }).props['data-read-only']).toBe('false');
    expect(editor.findAll((node) => node.type === 'button' && textContent(node).includes(t('common.save')))).toHaveLength(1);
    let modalController = renderer!.root.findAll(
      (node) => typeof node.props.onCellEditorValueChange === 'function',
    )[0];
    await act(async () => {
      modalController.props.onCellEditorValueChange('UNSAVED-PERMISSION-DRAFT');
    });
    expect(textContent(renderer!.root.findByProps({ 'data-monaco-editor': 'true' }))).toBe('UNSAVED-PERMISSION-DRAFT');
    modalController = renderer!.root.findAll(
      (node) => typeof node.props.onCellEditorValueChange === 'function',
    )[0];
    const staleSave = modalController.props.onSaveCellEditor as () => void;

    messageApi.info.mockClear();
    const flushableRenderer = renderer! as ReactTestRenderer & {
      unstable_flushSync: (callback: () => void) => void;
    };
    flushableRenderer.unstable_flushSync(() => {
      renderer!.update(<DataGrid {...props} editLocator={restrictedEditLocator} />);
    });
    staleSave();
    await waitForEffects();

    const viewerTitle = t('data_grid.cell_viewer.title_with_column', { column: 'payload' });
    expect(renderer!.root.findAll((node) => node.props['data-modal-title'] === editorTitle)).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props['data-modal-title'] === viewerTitle)).toHaveLength(0);
    expect(messageApi.info).toHaveBeenCalledWith(t('data_grid.message.current_field_not_editable'));
    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(props.data[0].payload);

    const readOnlyDoubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      readOnlyDoubleClickSurface.props.onDoubleClickCapture({
        target: cellTarget,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const viewer = renderer!.root.findByProps({ 'data-modal-title': viewerTitle });
    expect(textContent(viewer.findByProps({ 'data-monaco-editor': 'true' }))).toBe(props.data[0].payload);
    expect(textContent(viewer)).not.toContain('UNSAVED-PERMISSION-DRAFT');
    expect(messageApi.info).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it('renders only null as SQL NULL in the read-only cell viewer', async () => {

    const rows = [
      { __gonavi_row_key__: 'row-null', payload: null },
      { __gonavi_row_key__: 'row-undefined' },
      { __gonavi_row_key__: 'row-empty', payload: '' },
    ];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['payload']}
          loading={false}
          tableName="query_result"
          dbName="main"
          connectionId="conn-1"
          readOnly
        />,
      );
    });
    await waitForEffects();

    const doubleClickSurface = renderer!.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    const openViewerForRow = async (rowKey: string) => {
      await act(async () => {
        doubleClickSurface.props.onDoubleClickCapture({
          target: createRenderedCellTarget(rowKey, 'payload'),
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });
      return renderer!.root.findByProps({ 'data-monaco-editor': 'true' });
    };

    expect(textContent(await openViewerForRow('row-null'))).toBe('NULL');
    expect(textContent(await openViewerForRow('row-undefined'))).toBe('undefined');
    expect(textContent(await openViewerForRow('row-empty'))).toBe('');
    renderer!.unmount();
  });

  it('closes the read-only cell viewer when the grid becomes inactive', async () => {

    const props = {
      data: [{ __gonavi_row_key__: 'row-1', payload: 'old result value' }],
      columnNames: ['payload'],
      loading: false,
      tableName: 'query_result',
      dbName: 'main',
      connectionId: 'conn-1',
      readOnly: true,
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGrid {...props} isActive />);
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

    messageApi.info.mockClear();
    await act(async () => {
      renderer!.update(<DataGrid {...props} isActive={false} />);
    });
    await waitForEffects();

    expect(renderer!.root.findAll((node) => node.props['data-modal-title'] === viewerTitle)).toHaveLength(0);
    expect(messageApi.info).not.toHaveBeenCalled();
    renderer!.unmount();
  });

  it('closes the read-only cell viewer when the data reference refreshes', async () => {

    const initialData = [{ __gonavi_row_key__: 'row-1', payload: 'old result value' }];
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

    messageApi.info.mockClear();
    await act(async () => {
      renderer!.update(
        <DataGrid
          {...props}
          data={[{ __gonavi_row_key__: 'row-1', payload: 'new result value' }]}
        />,
      );
    });
    await waitForEffects();

    expect(renderer!.root.findAll((node) => node.props['data-modal-title'] === viewerTitle)).toHaveLength(0);
    expect(messageApi.info).not.toHaveBeenCalled();
    renderer!.unmount();
  });
});
