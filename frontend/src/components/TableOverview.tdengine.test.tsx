import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TableOverview from './TableOverview';

const storeSubscribers = vi.hoisted(() => new Set<() => void>());
const renderedDropdownMenus = vi.hoisted(() => [] as Array<{ items?: any[] }>);
const countdownConfirm = vi.hoisted(() => vi.fn());

const storeState = vi.hoisted(() => ({
  theme: 'light',
  appearance: {
    uiVersion: 'legacy',
    tableDoubleClickAction: 'open-data',
  } as {
    uiVersion: 'legacy' | 'v2';
    tableDoubleClickAction: 'open-data' | 'open-design';
  },
  connections: [
    {
      id: 'conn-1',
      config: {
        type: 'tdengine',
        host: '127.0.0.1',
        port: 6041,
        user: 'root',
        password: 'taosdata',
        database: 'metrics',
        useSSH: false,
        ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
      },
    },
  ],
  addTab: vi.fn(),
  setActiveContext: vi.fn(),
  setAIPanelVisible: vi.fn(),
  addAIContext: vi.fn(),
  pinnedSidebarTables: [] as string[],
  setSidebarTablePinned: vi.fn(),
  queryOptions: {
    tableOverviewViewMode: undefined,
  } as { tableOverviewViewMode?: 'card' | 'list' | 'table' },
  setQueryOptions: vi.fn(),
}));

const backendApp = vi.hoisted(() => ({
  DBGetTables: vi.fn(),
  DBRefreshTableStats: vi.fn(),
  DBQuery: vi.fn(),
  DBShowCreateTable: vi.fn(),
  ExportTable: vi.fn(),
  DropTable: vi.fn(),
  RenameTable: vi.fn(),
}));

const messageApi = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../store', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return {
    useStore: <T,>(selector: (state: typeof storeState) => T) => react.useSyncExternalStore(
      (listener) => {
        storeSubscribers.add(listener);
        return () => storeSubscribers.delete(listener);
      },
      () => selector(storeState),
      () => selector(storeState),
    ),
    buildSidebarTablePinKey: (connectionId: string, dbName: string, tableName: string, schemaName: string) =>
      `${connectionId}:${dbName}:${schemaName}:${tableName}`,
  };
});

vi.mock('../../wailsjs/go/app/App', () => backendApp);
vi.mock('../utils/autoFetchVisibility', () => ({
  useAutoFetchVisibility: () => true,
}));
vi.mock('../utils/connectionRpcConfig', () => ({
  buildRpcConnectionConfig: (config: unknown) => config,
}));
vi.mock('./ExportProgressModal', () => ({
  useExportProgressDialog: () => ({
    exportProgressModal: null,
    runExportWithProgress: vi.fn(),
  }),
}));
vi.mock('./V2TableContextMenu', () => ({
  V2TableContextMenuView: () => null,
}));
vi.mock('./common/countdownDangerConfirm', () => ({
  showCountdownDangerConfirm: countdownConfirm,
}));

vi.mock('@ant-design/icons', () => {
  const Icon = (props: any) => <span {...props} />;
  return {
    TableOutlined: Icon,
    SearchOutlined: Icon,
    ReloadOutlined: Icon,
    SortAscendingOutlined: Icon,
    DatabaseOutlined: Icon,
    ConsoleSqlOutlined: Icon,
    EditOutlined: Icon,
    CopyOutlined: Icon,
    SaveOutlined: Icon,
    DeleteOutlined: Icon,
    ExportOutlined: Icon,
    AppstoreOutlined: Icon,
    UnorderedListOutlined: Icon,
    WarningOutlined: Icon,
    CaretUpFilled: Icon,
    CaretDownFilled: Icon,
  };
});

vi.mock('antd', () => {
  const Button = ({ children, onClick, ...rest }: any) => <button type="button" onClick={onClick} {...rest}>{children}</button>;
  const Input: any = ({ value, onChange, ...rest }: any) => <input value={value} onChange={onChange} {...rest} />;
  Input.Search = ({ value, onChange, ...rest }: any) => <input value={value} onChange={onChange} {...rest} />;
  const Spin = ({ children }: any) => <div>{children}</div>;
  const Empty = ({ description }: any) => <div>{description}</div>;
  const Dropdown = ({ children, menu }: any) => {
    renderedDropdownMenus.push(menu);
    return <div>{children}</div>;
  };
  const Tooltip = ({ children }: any) => <div>{children}</div>;
  const Modal: any = ({ children }: any) => <div>{children}</div>;
  Modal.confirm = vi.fn();
  const Text = ({ children }: any) => <span>{children}</span>;
  const Paragraph = ({ children }: any) => <p>{children}</p>;
  return {
    Button,
    Dropdown,
    Empty,
    Input,
    Modal,
    Spin,
    Tooltip,
    Typography: { Text, Paragraph },
    message: messageApi,
  };
});

const flushPromises = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const collectText = (node: any): string => {
  if (!node) {
    return '';
  }
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => collectText(item)).join('');
  }
  return collectText(node.children || []);
};

const findMenuItem = (items: any[] | undefined, key: string): any | null => {
  for (const item of items || []) {
    if (item?.key === key) return item;
    const nested = findMenuItem(item?.children, key);
    if (nested) return nested;
  }
  return null;
};

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('TableOverview metadata compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeSubscribers.clear();
    renderedDropdownMenus.length = 0;
    storeState.appearance = { uiVersion: 'legacy', tableDoubleClickAction: 'open-data' };
    storeState.queryOptions = { tableOverviewViewMode: undefined };
    storeState.setQueryOptions.mockImplementation((options: { tableOverviewViewMode?: 'card' | 'list' | 'table' }) => {
      storeState.queryOptions = { ...storeState.queryOptions, ...options };
      storeSubscribers.forEach((listener) => listener());
    });
    storeState.connections = [
      {
        id: 'conn-1',
        config: {
          type: 'tdengine',
          host: '127.0.0.1',
          port: 6041,
          user: 'root',
          password: 'taosdata',
          database: 'metrics',
          useSSH: false,
          ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
        },
      },
    ];
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [
        { Table: 'd001' },
        { Table: 'meters' },
      ],
    });
    backendApp.DBRefreshTableStats.mockResolvedValue({ success: false });
    backendApp.DBQuery.mockResolvedValue({
      success: false,
      message: '[0x2600] syntax error near',
    });
  });

  it('reports a production table deletion only after the table list has refreshed', async () => {
    const dropResult = createDeferred<{ success: boolean; data?: unknown[] }>();
    const staleTables = createDeferred<{ success: boolean; data: Array<{ Table: string }> }>();
    const refreshedTables = createDeferred<{ success: boolean; data: Array<{ Table: string }> }>();
    storeState.connections = [{
      id: 'conn-1',
      name: 'Production',
      environmentType: 'production',
      config: {
        type: 'tdengine',
        host: '127.0.0.1',
        port: 6041,
        user: 'root',
        password: 'taosdata',
        database: 'metrics',
        useSSH: false,
        ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
      },
    }] as any;
    backendApp.DBGetTables
      .mockReset()
      .mockResolvedValueOnce({ success: true, data: [{ Table: 'meters' }] })
      .mockImplementationOnce(() => staleTables.promise)
      .mockImplementationOnce(() => refreshedTables.promise);
    backendApp.DropTable.mockImplementationOnce(() => dropResult.promise);

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: '表概览 - metrics',
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName: 'metrics',
      } as any} />);
    });
    await flushPromises();

    const dropMenuItem = renderedDropdownMenus
      .map((menu) => findMenuItem(menu?.items, 'drop-table'))
      .find(Boolean);
    const refreshTrigger = renderer!.root.findAllByType('span').find(
      (candidate) => typeof candidate.props.onClick === 'function'
        && candidate.props.style?.cursor === 'pointer',
    );
    expect(dropMenuItem).toBeTruthy();
    expect(refreshTrigger).toBeTruthy();

    act(() => {
      refreshTrigger!.props.onClick();
    });
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);

    act(() => {
      dropMenuItem.onClick();
    });
    const initialConfirm = countdownConfirm.mock.calls[0]?.[0];
    expect(initialConfirm).toBeTruthy();

    let deleteOperation!: Promise<void>;
    act(() => {
      deleteOperation = initialConfirm.onOk();
    });
    await flushPromises();

    const productionConfirm = countdownConfirm.mock.calls[1]?.[0];
    expect(productionConfirm).toBeTruthy();
    act(() => {
      productionConfirm.onOk();
    });
    await flushPromises();

    expect(backendApp.DropTable).toHaveBeenCalledWith(expect.any(Object), 'metrics', 'meters');
    expect(messageApi.success).not.toHaveBeenCalled();

    await act(async () => {
      dropResult.resolve({ success: true });
      await Promise.resolve();
    });
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(3);
    expect(messageApi.success).not.toHaveBeenCalled();

    await act(async () => {
      refreshedTables.resolve({ success: true, data: [] });
      await deleteOperation;
    });
    expect(messageApi.success).toHaveBeenCalledTimes(1);
    expect(collectText(renderer!.toJSON())).not.toContain('meters');

    await act(async () => {
      staleTables.resolve({ success: true, data: [{ Table: 'meters' }] });
      await Promise.resolve();
    });
    const renderedAfterStaleResponse = collectText(renderer!.toJSON());
    renderer!.unmount();
    expect(renderedAfterStaleResponse).not.toContain('meters');
  });

  it('loads tdengine overview rows through DBGetTables instead of direct metadata SQL', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: '表概览 - metrics',
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName: 'metrics',
      } as any} />);
    });
    await flushPromises();

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.any(Object), 'metrics');
    expect(backendApp.DBQuery).not.toHaveBeenCalled();
    expect(messageApi.error).not.toHaveBeenCalled();
    const renderedText = collectText(renderer!.toJSON());
    expect(renderedText).toContain('meters');
    expect(renderedText).toContain('d001');
  });

  it('loads sqlite overview rows through DBGetTables instead of information_schema SQL', async () => {
    storeState.connections = [
      {
        id: 'conn-1',
        config: {
          type: 'sqlite',
          host: '',
          port: 0,
          user: '',
          password: '',
          database: 'E:\\data\\app.db',
          useSSH: false,
          ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
        },
      },
    ];
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [
        { Table: 'users', Rows: '12', Data_length: '4096', Index_length: '8192' },
        { Table: 'orders', Rows: '34', Data_length: '2048', Index_length: '0' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: '表概览 - main',
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName: 'main',
      } as any} />);
    });
    await flushPromises();

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.any(Object), 'main');
    expect(backendApp.DBRefreshTableStats).toHaveBeenCalledWith(expect.any(Object), 'main', ['users', 'orders']);
    expect(backendApp.DBQuery).not.toHaveBeenCalled();
    expect(messageApi.error).not.toHaveBeenCalled();
    const renderedText = collectText(renderer!.toJSON());
    expect(renderedText).toContain('users');
    expect(renderedText).toContain('12');
    expect(renderedText).toContain('orders');
    expect(renderedText).toContain('34');
    expect(renderedText).toContain('4.0 KB');
    expect(renderedText).toContain('8.0 KB');
    expect(renderedText).toContain('2.0 KB');
    expect(renderedText).toContain('0 B');
    expect(renderedText).toContain('100%');
  });

  it('shows cached sqlite rows before an asynchronous stats refresh completes', async () => {
    storeState.connections = [
      {
        id: 'conn-1',
        config: {
          type: 'sqlite',
          host: '',
          port: 0,
          user: '',
          password: '',
          database: 'E:\\data\\app.db',
          useSSH: false,
          ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
        },
      },
    ];
    const refresh = createDeferred<{ success: boolean; data: Array<Record<string, string>> }>();
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'users', Rows: '12' }],
    });
    backendApp.DBRefreshTableStats.mockReturnValue(refresh.promise);

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: '表概览 - main',
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName: 'main',
      } as any} />);
    });
    await flushPromises();

    expect(collectText(renderer!.toJSON())).toContain('12');

    refresh.resolve({ success: true, data: [{ Table: 'users', Rows: '25' }] });
    await flushPromises();

    const refreshedText = collectText(renderer!.toJSON());
    expect(refreshedText).toContain('25');
    expect(refreshedText).not.toContain('12');
  });

  it('loads milvus collections through DBGetTables instead of information_schema SQL', async () => {
    storeState.connections = [
      {
        id: 'conn-1',
        config: {
          type: 'milvus',
          host: '192.168.3.230',
          port: 19530,
          user: '',
          password: '',
          database: 'default',
          useSSH: false,
          ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
        },
      },
    ];
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [
        { Table: 'documents' },
        { Table: 'embeddings' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: '表概览 - default',
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName: 'default',
      } as any} />);
    });
    await flushPromises();

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.any(Object), 'default');
    expect(backendApp.DBQuery).not.toHaveBeenCalled();
    expect(messageApi.error).not.toHaveBeenCalled();
    const renderedText = collectText(renderer!.toJSON());
    expect(renderedText).toContain('documents');
    expect(renderedText).toContain('embeddings');
  });

  it.each(['postgres', 'kingbase'])('shows bare table names for %s while preserving qualified operation targets', async (type) => {
    storeState.appearance = { uiVersion: 'v2', tableDoubleClickAction: 'open-data' };
    storeState.connections = [
      {
        id: 'conn-1',
        config: {
          type,
          host: '127.0.0.1',
          port: 20035,
          user: 'postgres',
          password: 'secret',
          database: 'dbx_test',
          useSSH: false,
          ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
        },
      },
    ];
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [
        {
          table_name: 'reporting.reporting_summary',
          table_comment: 'Reporting summary',
          table_rows: 8,
          data_length: 2048,
          index_length: 512,
        },
        {
          table_name: 'reporting.orders',
          table_comment: 'Orders',
          table_rows: 12,
          data_length: 4096,
          index_length: 1024,
        },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: '表概览 - dbx_test',
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName: 'dbx_test',
        schemaName: 'reporting',
      } as any} />);
    });
    await flushPromises();

    expect(backendApp.DBQuery).toHaveBeenCalledOnce();
    expect(String(backendApp.DBQuery.mock.calls[0]?.[2] || '')).toContain("n.nspname = 'reporting'");

    const assertBareTableName = () => {
      const renderedText = collectText(renderer!.toJSON());
      expect(renderedText).toContain('dbx_test · reporting');
      expect(renderedText).toContain('orders');
      expect(renderedText).not.toContain('reporting.orders');
    };

    assertBareTableName();
    await act(async () => {
      renderer!.root.findByType('input').props.onChange({ target: { value: 'reporting' } });
      await Promise.resolve();
    });
    const filteredText = collectText(renderer!.toJSON());
    expect(filteredText).toContain('reporting_summary');
    expect(filteredText).not.toContain('orders');

    await act(async () => {
      renderer!.root.findByType('input').props.onChange({ target: { value: '' } });
      await Promise.resolve();
    });
    assertBareTableName();
    await act(async () => {
      renderer!.root.findByProps({ 'data-table-overview-view-mode': 'list' }).props.onClick();
    });
    assertBareTableName();
    await act(async () => {
      renderer!.root.findByProps({ 'data-table-overview-view-mode': 'table' }).props.onClick();
    });
    assertBareTableName();

    storeState.addTab.mockClear();
    await act(async () => {
      renderer!.root.findByProps({ 'data-table-overview-row': 'reporting.orders' }).props.onDoubleClick();
    });
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      tableName: 'reporting.orders',
    }));
  });

  it.each([
    { type: 'oracle', dbName: 'APP' },
    { type: 'trino', dbName: 'catalog' },
  ])('keeps unsupported $type storage metrics unknown', async ({ type, dbName }) => {
    storeState.connections = [
      {
        id: 'conn-1',
        config: {
          type,
          host: '127.0.0.1',
          port: 0,
          user: 'tester',
          password: 'secret',
          database: dbName,
          useSSH: false,
          ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
        },
      },
    ];
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [
        {
          table_name: 'orders',
          table_rows: '8',
          data_length: null,
          index_length: null,
        },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: `表概览 - ${dbName}`,
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName,
      } as any} />);
    });
    await flushPromises();

    expect(backendApp.DBGetTables).not.toHaveBeenCalled();
    expect(backendApp.DBQuery).toHaveBeenCalledOnce();
    const metadataSQL = String(backendApp.DBQuery.mock.calls[0]?.[2] || '');
    expect(metadataSQL).toMatch(/NULL AS data_length/i);
    expect(metadataSQL).toMatch(/NULL AS index_length/i);

    const renderedText = collectText(renderer!.toJSON());
    expect(renderedText).toContain('orders');
    expect(renderedText).toContain('—');
    expect(renderedText).not.toContain('0 B');
  });

  it('uses the table default open behavior for v2 card double-clicks', async () => {
    storeState.appearance = { uiVersion: 'v2', tableDoubleClickAction: 'open-design' };
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: '表概览 - metrics',
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName: 'metrics',
      } as any} />);
    });
    await flushPromises();

    const card = renderer!.root.findAll((node) => node.props.className === 'gn-v2-table-card')[0];
    expect(card).toBeTruthy();

    await act(async () => {
      card.props.onDoubleClick();
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      tableName: 'd001',
      initialViewMode: 'fields',
      initialViewModeRequestId: expect.any(String),
    }));
    expect(storeState.addTab).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'design',
      tableName: 'd001',
    }));
  });

  it('keeps v2 cards fixed-height and reserves metadata slots when values are missing', async () => {
    storeState.appearance = { uiVersion: 'v2', tableDoubleClickAction: 'open-data' };
    storeState.connections = [{
      id: 'conn-1',
      config: {
        type: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: 'secret',
        database: 'app_db',
        useSSH: false,
        ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
      },
    }];
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [
        {
          TABLE_NAME: 'complete_table',
          TABLE_COMMENT: '完整备注',
          TABLE_ROWS: 12,
          DATA_LENGTH: 4096,
          INDEX_LENGTH: 1024,
          ENGINE: 'InnoDB',
          CREATE_TIME: '2026-05-01 09:00:00',
          UPDATE_TIME: '2026-06-02 10:30:00',
        },
        {
          TABLE_NAME: 'sparse_table',
          TABLE_COMMENT: '',
          TABLE_ROWS: 3,
          DATA_LENGTH: 2048,
          INDEX_LENGTH: 0,
          ENGINE: '',
          CREATE_TIME: '',
          UPDATE_TIME: '',
        },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: '表概览 - app_db',
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName: 'app_db',
      } as any} />);
    });
    await flushPromises();

    const completeCard = renderer!.root.findByProps({ 'data-table-overview-card': 'complete_table' });
    const sparseCard = renderer!.root.findByProps({ 'data-table-overview-card': 'sparse_table' });
    const cardGrid = renderer!.root.findByProps({ className: 'gn-v2-table-card-grid' });
    const readCardField = (card: any, field: string) => collectText(
      card.findByProps({ 'data-table-overview-card-field': field }),
    );

    expect(cardGrid.props.style.gridAutoRows).toBe(180);
    expect([completeCard, sparseCard].map((card) => card.props.style.height)).toEqual(['100%', '100%']);
    expect(readCardField(completeCard, 'comment')).toContain('完整备注');
    expect(readCardField(completeCard, 'updated')).toContain('2026-06-02 10:30:00');
    expect(readCardField(completeCard, 'created')).toContain('2026-05-01 09:00:00');
    expect(readCardField(completeCard, 'engine')).toBe('InnoDB');
    expect(readCardField(sparseCard, 'comment')).toBe('—');
    expect(readCardField(sparseCard, 'updated')).toContain('—');
    expect(readCardField(sparseCard, 'created')).toContain('—');
    expect(readCardField(sparseCard, 'engine')).toBe('—');

    await act(async () => {
      renderer!.root.findByProps({ 'data-table-overview-view-mode': 'list' }).props.onClick();
    });
    expect(renderer!.root.findAllByProps({ 'data-table-overview-card-field': 'updated' })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ 'data-table-overview-card-field': 'created' })).toHaveLength(1);
  });

  it('uses the table default open behavior for list double-clicks', async () => {
    storeState.appearance = { uiVersion: 'v2', tableDoubleClickAction: 'open-design' };
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: '表概览 - metrics',
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName: 'metrics',
      } as any} />);
    });
    await flushPromises();

    await act(async () => {
      renderer!.root.findByProps({ 'data-table-overview-view-mode': 'list' }).props.onClick();
    });

    const listRow = renderer!.root.findAll((node) => node.props.className === 'gn-v2-table-row')[0];
    expect(listRow).toBeTruthy();

    await act(async () => {
      listRow.props.onDoubleClick();
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      tableName: 'd001',
      initialViewMode: 'fields',
      initialViewModeRequestId: expect.any(String),
    }));
    expect(storeState.addTab).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'design',
      tableName: 'd001',
    }));
  });

  it('persists compact view across hosts and sorts numeric headers with unknown values last', async () => {
    storeState.appearance = { uiVersion: 'v2', tableDoubleClickAction: 'open-data' };
    storeState.connections = [
      {
        id: 'conn-1',
        config: {
          type: 'mysql',
          host: '127.0.0.1',
          port: 3306,
          user: 'root',
          password: 'secret',
          database: 'app_db',
          useSSH: false,
          ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
        },
      },
      {
        id: 'conn-2',
        config: {
          type: 'mysql',
          host: '192.0.2.20',
          port: 3306,
          user: 'root',
          password: 'secret',
          database: 'other_db',
          useSSH: false,
          ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
        },
      },
    ];
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [
        { TABLE_NAME: 'unknown_stats', TABLE_COMMENT: '', TABLE_ROWS: null, DATA_LENGTH: null, INDEX_LENGTH: null },
        { TABLE_NAME: 'large_table', TABLE_COMMENT: 'large', TABLE_ROWS: 50, DATA_LENGTH: 500, INDEX_LENGTH: 20, ENGINE: 'InnoDB' },
        { TABLE_NAME: 'small_table', TABLE_COMMENT: 'small', TABLE_ROWS: 5, DATA_LENGTH: 50, INDEX_LENGTH: 2, ENGINE: 'InnoDB' },
      ],
    });

    let renderer: ReactTestRenderer;
    let otherHostRenderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: '表概览 - app_db',
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName: 'app_db',
      } as any} />);
      otherHostRenderer = create(<TableOverview tab={{
        id: 'tab-2',
        title: '表概览 - other_db',
        type: 'table-overview',
        connectionId: 'conn-2',
        dbName: 'other_db',
      } as any} />);
    });
    await flushPromises();

    await act(async () => {
      renderer!.root.findByProps({ 'data-table-overview-view-mode': 'table' }).props.onClick();
    });

    expect(storeState.setQueryOptions).toHaveBeenCalledWith({ tableOverviewViewMode: 'table' });

    expect(renderer!.root.findByProps({ 'data-table-overview-view-mode': 'card' }).props).toMatchObject({
      type: 'button',
      'aria-pressed': false,
    });
    expect(renderer!.root.findByProps({ 'data-table-overview-view-mode': 'table' }).props).toMatchObject({
      type: 'button',
      'aria-pressed': true,
    });
    expect(otherHostRenderer!.root.findByProps({ 'data-table-overview-view-mode': 'table' }).props['aria-pressed']).toBe(true);
    expect(otherHostRenderer!.root.findByProps({ role: 'table' })).toBeTruthy();

    const rowNames = () => renderer!.root
      .findAll((node) => typeof node.props?.['data-table-overview-row'] === 'string')
      .map((node) => node.props['data-table-overview-row']);

    expect(rowNames()).toEqual(['large_table', 'small_table', 'unknown_stats']);
    expect(renderer!.root.findByProps({ role: 'table' })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ role: 'columnheader' })).toHaveLength(8);

    await act(async () => {
      renderer!.root.findByProps({ 'data-table-overview-sort': 'rows' }).props.onClick();
    });
    expect(rowNames()).toEqual(['large_table', 'small_table', 'unknown_stats']);

    await act(async () => {
      renderer!.root.findByProps({ 'data-table-overview-sort': 'rows' }).props.onClick();
    });
    expect(rowNames()).toEqual(['small_table', 'large_table', 'unknown_stats']);

    storeState.addTab.mockClear();
    await act(async () => {
      renderer!.root.findByProps({ 'data-table-overview-row': 'small_table' }).props.onDoubleClick();
    });
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      tableName: 'small_table',
    }));

  });

  it('renders comment and temporal metadata in the legacy table list when available', async () => {
    storeState.connections = [
      {
        id: 'conn-1',
        config: {
          type: 'mysql',
          host: '127.0.0.1',
          port: 3306,
          user: 'root',
          password: 'secret',
          database: 'app_db',
          useSSH: false,
          ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
        },
      },
    ];
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [
        {
          TABLE_NAME: 'orders',
          TABLE_COMMENT: '订单表',
          TABLE_ROWS: 128,
          DATA_LENGTH: 2048,
          INDEX_LENGTH: 1024,
          ENGINE: 'InnoDB',
          CREATE_TIME: '2026-05-01 09:00:00',
          UPDATE_TIME: '2026-06-02 10:30:00',
        },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableOverview tab={{
        id: 'tab-1',
        title: '表概览 - app_db',
        type: 'table-overview',
        connectionId: 'conn-1',
        dbName: 'app_db',
      } as any} />);
    });
    await flushPromises();

    expect(backendApp.DBQuery).toHaveBeenCalled();
    const renderedText = collectText(renderer!.toJSON());
    expect(renderedText).toContain('orders');
    expect(renderedText).toContain('订单表');
    // 展示统一为 YYYY-MM-DD HH:mm:ss（有小数秒时保留，与侧栏 formatSidebarTableTimestamp 一致）
    expect(renderedText).toContain('2026-06-02 10:30:00');
    expect(renderedText).toContain('2026-05-01 09:00:00');
  });
});
