import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DataGrid from './DataGrid';
import { t } from '../i18n';
import {
  storeState,
  backendApp,
  testRenderState,
  messageApi,
} from './dataGridDdlTestState';
import { textContent, findButton, waitForEffects } from './dataGridDdlTestHelpers';
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

  it('auto commits pending table edits with the query result connection params override', async () => {
    vi.useFakeTimers();

    storeState.dataEditTransactionOptions = {
      commitMode: 'auto',
      autoCommitDelayMs: 3000,
    };
    backendApp.ApplyChanges.mockResolvedValue({
      success: true,
      message: 'ok',
      data: {
        deletes: [],
        updates: [],
        inserts: ["INSERT INTO `users` (`id`, `name`) VALUES (1, 'alpha');"],
      },
    });

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
          connectionParamsOverride={'application_name=gonavi&search_path=%22sales%22%2C%22public%22'}
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
      findButton(renderer!, '复制本行为新增行').props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
    await openMenu();
    await act(async () => {
      findButton(renderer!, t('data_grid.context_menu.paste_row_as_new_count', { count: 1 })).props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    expect(backendApp.ApplyChanges).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2999);
      await Promise.resolve();
    });
    expect(backendApp.ApplyChanges).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.ApplyChanges).toHaveBeenCalledTimes(1);
    const appliedConfig = backendApp.ApplyChanges.mock.calls[0][0];
    const appliedConnectionParams = new URLSearchParams(String(appliedConfig?.connectionParams || ''));
    expect(appliedConnectionParams.get('application_name')).toBe('gonavi');
    expect(appliedConnectionParams.get('search_path')).toBe('"sales","public"');
    expect(backendApp.ApplyChanges.mock.calls[0][3]).toMatchObject({
      inserts: [
        expect.objectContaining({
          id: 1,
          name: 'alpha',
        }),
      ],
      updates: [],
      deletes: [],
      locatorStrategy: 'primary-key',
    });
    expect(storeState.addSqlLog).toHaveBeenLastCalledWith(expect.objectContaining({
      sql: [
        '/* Batch Apply on users */',
        'START TRANSACTION;',
        "INSERT INTO `users` (`id`, `name`) VALUES (1, 'alpha');",
        'COMMIT;',
      ].join('\n'),
      status: 'success',
    }));
    expect(messageApi.success).toHaveBeenCalledWith('自动提交成功');
    renderer!.unmount();
  });

  it('switches the v2 footer object tab into the embedded designer view', async () => {

    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'id', type: 'bigint', key: 'PRI', nullable: 'NO', default: '', comment: '' },
        { name: 'name', type: 'varchar(255)', key: '', nullable: 'YES', default: '', comment: '' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'alpha' }]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    await act(async () => {
      findButton(renderer!, '对象设计').props.onClick();
    });

    const content = textContent(renderer!.root);
    expect(content).toContain('SCHEMA DESIGNER');
    expect(content).toContain('id');
    expect(content).toContain('name');
  });

  it('opens the embedded object designer from an initial v2 table view request', async () => {

    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'id', type: 'bigint', key: 'PRI', nullable: 'NO', default: '', comment: '' },
        { name: 'name', type: 'varchar(255)', key: '', nullable: 'YES', default: '', comment: '' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'alpha' }]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          initialViewMode="fields"
          initialViewModeRequestId="query-editor-jump-1"
        />,
      );
    });
    await waitForEffects();

    const content = textContent(renderer!.root);
    expect(content).toContain('SCHEMA DESIGNER');
    expect(content).toContain('id');
    expect(content).toContain('name');
  });

  it('notifies deferred data loading only after leaving the embedded object designer', async () => {

    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'id', type: 'bigint', key: 'PRI', nullable: 'NO', default: '', comment: '' },
        { name: 'name', type: 'varchar(255)', key: '', nullable: 'YES', default: '', comment: '' },
      ],
    });
    const handleDataViewActivate = vi.fn();

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'alpha' }]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          initialViewMode="fields"
          initialViewModeRequestId="query-editor-jump-2"
          onDataViewActivate={handleDataViewActivate}
        />,
      );
    });
    await waitForEffects();

    expect(handleDataViewActivate).not.toHaveBeenCalled();

    await act(async () => {
      findButton(renderer!, '数据预览').props.onClick();
    });
    await waitForEffects();

    expect(handleDataViewActivate).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it('keeps the v2 fields tab as read-only field info for views', async () => {

    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'id', type: 'bigint', key: '', nullable: 'NO', default: '', comment: '' },
        { name: 'name', type: 'varchar(255)', key: '', nullable: 'YES', default: '', comment: '' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'alpha' }]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="user_view"
          dbName="main"
          connectionId="conn-1"
          objectType="view"
        />,
      );
    });
    await waitForEffects();

    expect(findButton(renderer!, '字段信息')).toBeTruthy();
    expect(findButton(renderer!, '对象设计')).toBeUndefined();

    await act(async () => {
      findButton(renderer!, '字段信息').props.onClick();
    });

    const content = textContent(renderer!.root);
    expect(content).toContain(t('data_grid.metadata_view.fields_badge'));
    expect(content).toContain(t('data_grid.metadata_view.field_count', { count: 2 }));
    expect(content).toContain('id');
    expect(content).toContain('name');
    expect(content).not.toContain('SCHEMA DESIGNER');
  });

  it('renders the v2 footer DDL view with the Monaco SQL editor', async () => {

    backendApp.DBShowCreateTable.mockResolvedValueOnce({
      success: true,
      data: 'CREATE TABLE users (`id` bigint)',
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
        />,
      );
    });
    await waitForEffects();

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();

    const editors = renderer!.root.findAll((node) => node.props['data-monaco-editor'] === 'true');
    expect(editors).toHaveLength(1);
    expect(editors[0].props['data-language']).toBe('sql');
    expect(editors[0].props['data-read-only']).toBe('true');
    expect(textContent(editors[0])).toContain('CREATE TABLE');
    expect(textContent(editors[0])).toContain('users');
    expect(renderer!.root.findAll((node) => node.type === 'pre' && textContent(node).includes('CREATE TABLE users'))).toHaveLength(0);
  });

  it('formats DuckDB DDL into readable multiline SQL in the v2 view', async () => {

    storeState.connections[0].config.type = 'duckdb';
    backendApp.DBShowCreateTable.mockResolvedValueOnce({
      success: true,
      data: 'CREATE TABLE customers(customer_id BIGINT, customer_code VARCHAR, city VARCHAR, tier VARCHAR, signup_date DATE, lifetime_value DECIMAL(12,2), PRIMARY KEY(customer_id));',
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', customer_id: 1 }]}
          columnNames={['customer_id']}
          loading={false}
          tableName="example.main.customers"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();

    const editors = renderer!.root.findAll((node) => node.props['data-monaco-editor'] === 'true');
    expect(editors).toHaveLength(1);
    const ddlText = textContent(editors[0]);
    expect(ddlText).toContain('CREATE TABLE customers (');
    expect(ddlText).toContain('customer_id BIGINT,');
    expect(ddlText).toContain('PRIMARY KEY (customer_id)');
    expect(ddlText).toContain('\n');
  });

  it('opens the v2 DDL view as a right sidebar while keeping the table visible', async () => {

    backendApp.DBShowCreateTable.mockResolvedValueOnce({
      success: true,
      data: 'CREATE TABLE users (`id` bigint)',
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
        />,
      );
    });
    await waitForEffects();

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      renderer!.root.findByProps({ 'data-segmented-option': 'side' }).props.onClick();
    });

    const sideWorkspace = renderer!.root.findByProps({ 'data-grid-ddl-layout': 'side' });
    expect(sideWorkspace.props.className).toBe('gn-v2-data-grid-split-workspace');
    expect(renderer!.root.findByProps({ 'aria-label': '表 DDL 侧栏' }).props.className).toBe('gn-v2-data-grid-ddl-sidebar');
    expect(renderer!.root.findByProps({ 'data-grid-ddl-view': 'side' }).props.className).toContain('is-side');
    expect(renderer!.root.findAllByType('table')).toHaveLength(1);
    expect(sideWorkspace.props.style.gridTemplateColumns).toBe('minmax(0, 1fr) 8px 420px');
    expect(sideWorkspace.props.style['--gn-v2-ddl-sidebar-width']).toBe('420px');
    expect(renderer!.root.findByProps({ 'data-grid-ddl-resizer': 'true' }).props['aria-valuenow']).toBe(420);

    const editors = renderer!.root.findAll((node) => node.props['data-monaco-editor'] === 'true');
    expect(editors).toHaveLength(1);
    expect(editors[0].props['data-language']).toBe('sql');
    expect(textContent(editors[0])).toContain('CREATE TABLE users');
    expect(editors[0].props['data-dom-read-only']).toBe('true');
    expect(editors[0].props['data-mouse-style']).toBe('default');
    expect(editors[0].props['data-render-line-highlight']).toBe('none');
    expect(editors[0].props['data-glyph-margin']).toBe('false');
    expect(editors[0].props['data-folding']).toBe('false');
    expect(editors[0].props['data-line-decorations-width']).toBe('8');
    expect(editors[0].props['data-line-numbers-min-chars']).toBe('2');

    const mouseTargetType = testRenderState.latestMonacoMouseTargetType!;
    const ddlMouseDown = testRenderState.latestMonacoMouseDownListeners[testRenderState.latestMonacoMouseDownListeners.length - 1];
    const ddlMouseUp = testRenderState.latestMonacoMouseUpListeners[testRenderState.latestMonacoMouseUpListeners.length - 1];
    const ddlScrollChange = testRenderState.latestMonacoScrollChangeListeners[testRenderState.latestMonacoScrollChangeListeners.length - 1];
    expect(ddlMouseDown).toBeTypeOf('function');
    expect(ddlMouseUp).toBeTypeOf('function');
    expect(ddlScrollChange).toBeTypeOf('function');
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    testRenderState.latestMonacoScrollLeft = 120;
    ddlMouseDown({
      target: { type: mouseTargetType.CONTENT_TEXT },
      event: {
        browserEvent: { button: 0, clientX: 180, clientY: 24 },
        leftButton: true,
        posx: 180,
        posy: 24,
        preventDefault,
        stopPropagation,
      },
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    testRenderState.latestMonacoScrollLeft = 480;
    ddlMouseUp({
      target: { type: mouseTargetType.CONTENT_TEXT },
      event: {
        browserEvent: { button: 0, clientX: 181, clientY: 25 },
        posx: 181,
        posy: 25,
      },
    });
    expect(testRenderState.latestMonacoEditor.setScrollLeft).toHaveBeenCalledWith(120);
    expect(testRenderState.latestMonacoScrollLeft).toBe(120);

    testRenderState.latestMonacoEditor.setScrollLeft.mockClear();
    testRenderState.latestMonacoScrollLeft = 120;
    const dragPreventDefault = vi.fn();
    const dragStopPropagation = vi.fn();
    ddlMouseDown({
      target: { type: mouseTargetType.CONTENT_TEXT },
      event: {
        browserEvent: { button: 0, clientX: 180, clientY: 24 },
        leftButton: true,
        posx: 180,
        posy: 24,
        preventDefault: dragPreventDefault,
        stopPropagation: dragStopPropagation,
      },
    });
    expect(dragPreventDefault).not.toHaveBeenCalled();
    expect(dragStopPropagation).not.toHaveBeenCalled();
    testRenderState.latestMonacoScrollLeft = 480;
    ddlScrollChange({ scrollLeftChanged: true });
    expect(testRenderState.latestMonacoEditor.setScrollLeft).toHaveBeenCalledWith(120);
    expect(testRenderState.latestMonacoScrollLeft).toBe(120);

    testRenderState.latestMonacoEditor.setScrollLeft.mockClear();
    testRenderState.latestMonacoScrollLeft = 480;
    ddlMouseUp({
      target: { type: mouseTargetType.CONTENT_TEXT },
      event: {
        browserEvent: { button: 0, clientX: 225, clientY: 24 },
        posx: 225,
        posy: 24,
      },
    });
    expect(testRenderState.latestMonacoEditor.setScrollLeft).toHaveBeenCalledWith(120);
    expect(testRenderState.latestMonacoScrollLeft).toBe(120);

    const scrollbarPreventDefault = vi.fn();
    ddlMouseDown({
      target: { type: mouseTargetType.SCROLLBAR },
      event: {
        browserEvent: { button: 0 },
        preventDefault: scrollbarPreventDefault,
        stopPropagation: vi.fn(),
      },
    });
    expect(scrollbarPreventDefault).not.toHaveBeenCalled();
  });

  it('keeps the v2 DDL view open on the next table and reloads that table DDL', async () => {

    backendApp.DBShowCreateTable
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users (`id` bigint)' })
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE orders (`id` bigint)' });

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

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      renderer!.root.findByProps({ 'data-segmented-option': 'side' }).props.onClick();
    });

    await act(async () => {
      renderer!.update(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-2', id: 2 }]}
          columnNames={['id']}
          loading={false}
          tableName="orders"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    expect(backendApp.DBShowCreateTable).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'mysql' }),
      'main',
      'users',
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'mysql' }),
      'main',
      'orders',
    );
    expect(renderer!.root.findByProps({ 'data-grid-ddl-layout': 'side' })).toBeTruthy();
    const content = textContent(renderer!.root);
    expect(content).toContain('DDL - orders');
    expect(content).toContain('CREATE TABLE orders');
    expect(content).not.toContain('CREATE TABLE users');
  });

  it('returns a query result to data preview when a fresh table view request arrives', async () => {

    backendApp.DBShowCreateTable
      .mockResolvedValueOnce({
        success: true,
        data: 'CREATE TABLE users (`id` bigint)',
      })
      .mockResolvedValueOnce({
        success: true,
        data: 'CREATE TABLE users (`id` bigint)',
      })
      .mockResolvedValueOnce({
        success: true,
        data: 'CREATE TABLE orders (`id` bigint)',
      });

    const renderGrid = (initialViewModeRequestId?: string, rowId = 1) => (
      <DataGrid
        data={[{ __gonavi_row_key__: `row-${rowId}`, id: rowId }]}
        columnNames={['id']}
        loading={false}
        tableName="users"
        dbName="main"
        connectionId="conn-1"
        initialViewMode={initialViewModeRequestId ? 'table' : undefined}
        initialViewModeRequestId={initialViewModeRequestId}
        initialViewModeScope={initialViewModeRequestId ? 'local' : undefined}
      />
    );

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderGrid());
    });
    await waitForEffects();

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();
    expect(renderer!.root.findAll((node) => node.props['data-grid-ddl-view'])).toHaveLength(1);

    await act(async () => {
      renderer!.update(renderGrid('query-run-1', 2));
    });
    await waitForEffects();

    expect(renderer!.root.findAll((node) => node.props['data-grid-ddl-view'])).toHaveLength(0);
    expect(testRenderState.latestTableProps.dataSource[0]).toMatchObject({ id: 2 });
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();
    expect(renderer!.root.findAll((node) => node.props['data-grid-ddl-view'])).toHaveLength(1);
    expect(backendApp.DBShowCreateTable).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'mysql' }),
      'main',
      'users',
    );

    await act(async () => {
      renderer!.update(renderGrid('query-run-2', 3));
    });
    await waitForEffects();
    expect(renderer!.root.findAll((node) => node.props['data-grid-ddl-view'])).toHaveLength(0);
    expect(testRenderState.latestTableProps.dataSource[0]).toMatchObject({ id: 3 });

    await act(async () => {
      renderer!.update(
        <DataGrid
          key="orders"
          data={[{ __gonavi_row_key__: 'row-4', id: 4 }]}
          columnNames={['id']}
          loading={false}
          tableName="orders"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    expect(renderer!.root.findAll((node) => node.props['data-grid-ddl-view'])).toHaveLength(1);
    expect(backendApp.DBShowCreateTable).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ type: 'mysql' }),
      'main',
      'orders',
    );
    expect(textContent(renderer!.root)).toContain('CREATE TABLE orders');
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(3);
  });

  it('keeps the v2 DDL sidebar open when switching to another table tab instance', async () => {

    let resolveOrdersRequest: (value: any) => void = () => {};
    backendApp.DBShowCreateTable
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users (`id` bigint)' })
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOrdersRequest = resolve;
      }));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          key="users"
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

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      renderer!.root.findByProps({ 'data-segmented-option': 'side' }).props.onClick();
    });
    expect(renderer!.root.findAll((node) => node.props['data-grid-ddl-view'] === 'side')).toHaveLength(1);

    await act(async () => {
      renderer!.update(
        <DataGrid
          key="orders"
          data={[{ __gonavi_row_key__: 'row-2', id: 2 }]}
          columnNames={['id']}
          loading={false}
          tableName="orders"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });

    expect(renderer!.root.findAll((node) => node.props['data-grid-ddl-view'] === 'side')).toHaveLength(1);
    const pendingContent = textContent(renderer!.root);
    expect(pendingContent).toContain('DDL - orders');
    expect(pendingContent).toContain(t('data_grid.ddl.loading'));
    expect(pendingContent).not.toContain('CREATE TABLE users');

    expect(backendApp.DBShowCreateTable).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'mysql' }),
      'main',
      'orders',
    );

    await act(async () => {
      resolveOrdersRequest({ success: true, data: 'CREATE TABLE orders (`id` bigint)' });
    });
    await waitForEffects();

    expect(backendApp.DBShowCreateTable).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'mysql' }),
      'main',
      'users',
    );
    expect(renderer!.root.findAll((node) => node.props['data-grid-ddl-view'] === 'side')).toHaveLength(1);
    const content = textContent(renderer!.root);
    expect(content).toContain('DDL - orders');
    expect(content).toContain('CREATE TABLE orders');
    expect(content).not.toContain('CREATE TABLE users');
  });

  it('keeps the v2 DDL sidebar open when activating an already mounted table tab', async () => {

    let resolveOrdersRequest: (value: any) => void = () => {};
    backendApp.DBShowCreateTable
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users (`id` bigint)' })
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOrdersRequest = resolve;
      }));

    const renderTabs = (activeTable: 'users' | 'orders') => (
      <>
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
          columnNames={['id']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          isActive={activeTable === 'users'}
        />
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-2', id: 2 }]}
          columnNames={['id']}
          loading={false}
          tableName="orders"
          dbName="main"
          connectionId="conn-1"
          isActive={activeTable === 'orders'}
        />
      </>
    );

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderTabs('users'));
    });
    await waitForEffects();

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      renderer!.root.findByProps({ 'data-segmented-option': 'side' }).props.onClick();
    });
    expect(textContent(renderer!.root)).toContain('DDL - users');

    await act(async () => {
      renderer!.update(renderTabs('orders'));
    });
    await waitForEffects();

    const pendingContent = textContent(renderer!.root);
    expect(pendingContent).toContain('DDL - orders');
    expect(pendingContent).toContain(t('data_grid.ddl.loading'));
    expect(renderer!.root.findAll((node) => (
      node.props?.['data-grid-ddl-view'] === 'side'
        && textContent(node).includes('DDL - orders')
    ))).toHaveLength(1);
    expect(backendApp.DBShowCreateTable).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'mysql' }),
      'main',
      'orders',
    );

    await act(async () => {
      resolveOrdersRequest({ success: true, data: 'CREATE TABLE orders (`id` bigint)' });
    });
    await waitForEffects();

    const content = textContent(renderer!.root);
    expect(content).toContain('DDL - orders');
    expect(content).toContain('CREATE TABLE orders');
    expect(renderer!.root.findAll((node) => (
      node.props?.['data-grid-ddl-view'] === 'side'
        && textContent(node).includes('CREATE TABLE orders')
    ))).toHaveLength(1);
  });

  it('hides the v2 DDL view when clicking the active footer action and reopens with the last layout', async () => {

    backendApp.DBShowCreateTable
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users (`id` bigint)' })
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users (`id` bigint)' });

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

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      renderer!.root.findByProps({ 'data-segmented-option': 'side' }).props.onClick();
    });
    expect(renderer!.root.findAll((node) => node.props['data-grid-ddl-view'] === 'side')).toHaveLength(1);

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();

    expect(renderer!.root.findAll((node) => node.props['data-grid-ddl-view'])).toHaveLength(0);
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();

    expect(renderer!.root.findAll((node) => node.props['data-grid-ddl-view'] === 'side')).toHaveLength(1);
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(2);
  });

  it('previews and commits the v2 DDL sidebar width after dragging the separator', async () => {

    backendApp.DBShowCreateTable.mockResolvedValueOnce({
      success: true,
      data: 'CREATE TABLE users (`id` bigint)',
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
        />,
      );
    });
    await waitForEffects();

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      renderer!.root.findByProps({ 'data-segmented-option': 'side' }).props.onClick();
    });

    const container = renderer!.root.findByProps({ 'data-grid-ddl-layout': 'side' });
    expect(container.props.style.gridTemplateColumns).toBe('minmax(0, 1fr) 8px 420px');
    expect(renderer!.root.findByProps({ 'data-grid-ddl-resize-preview': 'true' }).props.className).toBe('gn-v2-data-grid-ddl-resize-preview');

    const addEventListenerMock = vi.mocked(document.addEventListener);
    const removeEventListenerMock = vi.mocked(document.removeEventListener);
    const resizer = renderer!.root.findByProps({ 'data-grid-ddl-resizer': 'true' });
    const mockPreviewElement = {
      style: {} as Record<string, string>,
    };
    const mockResizerElement = {
      parentElement: {
        getBoundingClientRect: vi.fn(() => ({ width: 1000 })),
        querySelector: vi.fn(() => mockPreviewElement),
      },
      getBoundingClientRect: vi.fn(() => ({ width: 8 })),
    };
    await act(async () => {
      resizer.props.onMouseDown({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 900,
        currentTarget: mockResizerElement,
      });
    });

    const mouseMoveHandler = addEventListenerMock.mock.calls.find(([eventName]) => eventName === 'mousemove')?.[1] as ((event: MouseEvent) => void) | undefined;
    const mouseUpHandler = addEventListenerMock.mock.calls.find(([eventName]) => eventName === 'mouseup')?.[1] as (() => void) | undefined;
    expect(mouseMoveHandler).toBeTypeOf('function');
    expect(mouseUpHandler).toBeTypeOf('function');

    await act(async () => {
      mouseMoveHandler?.({ clientX: 780 } as MouseEvent);
    });

    const movingContainer = renderer!.root.findByProps({ 'data-grid-ddl-layout': 'side' });
    expect(movingContainer.props.style.gridTemplateColumns).toBe('minmax(0, 1fr) 8px 420px');
    expect(movingContainer.props.style['--gn-v2-ddl-sidebar-width']).toBe('420px');
    expect(mockPreviewElement.style.opacity).toBe('1');
    expect(mockPreviewElement.style.transform).toBe('translateX(456px)');
    expect(renderer!.root.findByProps({ 'data-grid-ddl-resizer': 'true' }).props['aria-valuenow']).toBe(420);

    await act(async () => {
      mouseUpHandler?.();
    });

    const resizedContainer = renderer!.root.findByProps({ 'data-grid-ddl-layout': 'side' });
    expect(resizedContainer.props.style.gridTemplateColumns).toBe('minmax(0, 1fr) 8px 540px');
    expect(resizedContainer.props.style['--gn-v2-ddl-sidebar-width']).toBe('540px');
    expect(mockPreviewElement.style.opacity).toBe('0');
    expect(renderer!.root.findByProps({ 'data-grid-ddl-resizer': 'true' }).props['aria-valuenow']).toBe(540);
    expect(removeEventListenerMock).toHaveBeenCalledWith('mousemove', mouseMoveHandler);
    expect(removeEventListenerMock).toHaveBeenCalledWith('mouseup', mouseUpHandler);
  });
});
