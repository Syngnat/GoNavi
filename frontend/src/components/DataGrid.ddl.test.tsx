import { readFileSync } from 'node:fs';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DataGrid, {
  attachDataGridVirtualEditRenderVersion,
  buildColumnMetaMap,
  buildDataGridCommitChangeSet,
  collectDataGridCellSelectionRowKeys,
  formatCellDisplayText,
  GONAVI_ROW_KEY,
  hasDataGridVirtualEditRenderVersionChanged,
  shouldOmitBlankDataGridInsertValue,
} from './DataGrid';
import { resetDataGridDdlViewSharedStateForTests } from './useDataGridDdlView';
import DataGridPageFind from './DataGridPageFind';
import DataGridToolbarFrame from './DataGridToolbarFrame';
import { V2CellContextMenuView, V2ColumnHeaderContextMenuView, V2TableGroupContextMenuView } from './V2TableContextMenu';
import { setCurrentLanguage, t } from '../i18n';
import { parseMongoEditedValue } from '../utils/mongodb';
import { DUCKDB_ROWID_LOCATOR_COLUMN, ORACLE_ROWID_LOCATOR_COLUMN } from '../utils/rowLocator';
import { resetTableMetadataRequestCacheForTests } from '../utils/tableMetadataRequestCache';

const storeState = vi.hoisted(() => ({
  connections: [
    {
      id: 'conn-1',
      name: 'local',
      config: {
        type: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: '',
        database: 'main',
      },
    },
  ],
  addSqlLog: vi.fn(),
  theme: 'light',
  appearance: {
    enabled: true,
    opacity: 1,
    blur: 0,
    uiVersion: 'v2',
    showDataTableVerticalBorders: false,
    dataTableDensity: 'comfortable',
  },
  queryOptions: {
    showColumnComment: false,
    showColumnType: false,
  },
  setQueryOptions: vi.fn(),
  dataEditTransactionOptions: {
    commitMode: 'manual' as 'manual' | 'auto',
    autoCommitDelayMs: 5000,
  },
  setDataEditTransactionOptions: vi.fn(),
  addTab: vi.fn(),
  setActiveContext: vi.fn(),
  tableColumnOrders: {},
  tablePinnedLeftColumns: {},
  setTablePinnedLeftColumns: vi.fn(),
  enableColumnOrderMemory: false,
  setTableColumnOrder: vi.fn(),
  setEnableColumnOrderMemory: vi.fn(),
  clearTableColumnOrder: vi.fn(),
  tableHiddenColumns: {},
  enableHiddenColumnMemory: false,
  setTableHiddenColumns: vi.fn(),
  setEnableHiddenColumnMemory: vi.fn(),
  clearTableHiddenColumns: vi.fn(),
  aiPanelVisible: false,
  setAIPanelVisible: vi.fn(),
}));

const backendApp = vi.hoisted(() => ({
  ImportData: vi.fn(),
  ExportTable: vi.fn(),
  ExportData: vi.fn(),
  ExportDataWithOptions: vi.fn(),
  ExportQuery: vi.fn(),
  ExportQueryWithOptions: vi.fn(),
  ApplyChanges: vi.fn(),
  PreviewChanges: vi.fn(),
  DBGetColumns: vi.fn(),
  DBGetIndexes: vi.fn(),
  DBGetForeignKeys: vi.fn(),
  DBGetTriggers: vi.fn(),
  DBQuery: vi.fn(),
  DBShowCreateTable: vi.fn(),
}));

const testRenderState = vi.hoisted(() => ({
  latestColumns: [] as any[],
  latestTableProps: null as any,
  latestMonacoMouseDownListeners: [] as Array<(event: any) => void>,
  latestMonacoMouseUpListeners: [] as Array<(event: any) => void>,
  latestMonacoScrollChangeListeners: [] as Array<(event: any) => void>,
  latestMonacoMouseTargetType: null as null | Record<string, number>,
  latestMonacoScrollLeft: 0,
  latestMonacoEditor: null as any,
  latestDatePickerProps: null as any,
  latestTimePickerProps: null as any,
  formValidateFields: vi.fn((_fields?: unknown) => Promise.resolve({})),
  formGetFieldValue: vi.fn((_field?: unknown): any => undefined),
}));

const messageApi = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  loading: vi.fn(() => vi.fn()),
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => any) => selector(storeState),
}));

vi.mock('../../wailsjs/go/app/App', () => backendApp);
vi.mock('../../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => vi.fn()),
}));

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<any>('react-dom');
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

vi.mock('@monaco-editor/react', () => ({
  default: (props: { value?: string; language?: string; theme?: string; options?: Record<string, unknown>; onMount?: (...args: any[]) => void }) => {
    const mouseTargetType = {
      CONTENT_TEXT: 1,
      CONTENT_EMPTY: 2,
      SCROLLBAR: 3,
    };
    testRenderState.latestMonacoMouseDownListeners = [];
    testRenderState.latestMonacoMouseUpListeners = [];
    testRenderState.latestMonacoScrollChangeListeners = [];
    testRenderState.latestMonacoMouseTargetType = mouseTargetType;
    testRenderState.latestMonacoScrollLeft = 0;
    const editor = {
      onMouseDown: (listener: (event: any) => void) => {
        testRenderState.latestMonacoMouseDownListeners.push(listener);
        return { dispose: vi.fn() };
      },
      onMouseUp: (listener: (event: any) => void) => {
        testRenderState.latestMonacoMouseUpListeners.push(listener);
        return { dispose: vi.fn() };
      },
      onDidScrollChange: (listener: (event: any) => void) => {
        testRenderState.latestMonacoScrollChangeListeners.push(listener);
        return { dispose: vi.fn() };
      },
      getScrollLeft: vi.fn(() => testRenderState.latestMonacoScrollLeft),
      setScrollLeft: vi.fn((nextScrollLeft: number) => {
        testRenderState.latestMonacoScrollLeft = nextScrollLeft;
      }),
    };
    testRenderState.latestMonacoEditor = editor;
    props.onMount?.(editor, {
      editor: {
        MouseTargetType: mouseTargetType,
      },
    });

    return (
      <div
        data-monaco-editor="true"
        data-language={props.language}
        data-theme={props.theme}
        data-read-only={String(Boolean(props.options?.readOnly))}
        data-dom-read-only={String(Boolean(props.options?.domReadOnly))}
        data-mouse-style={String(props.options?.mouseStyle ?? '')}
        data-render-line-highlight={String(props.options?.renderLineHighlight ?? '')}
        data-glyph-margin={String(Boolean(props.options?.glyphMargin))}
        data-folding={String(Boolean(props.options?.folding))}
        data-line-decorations-width={String(props.options?.lineDecorationsWidth ?? '')}
        data-line-numbers-min-chars={String(props.options?.lineNumbersMinChars ?? '')}
      >
        {props.value}
      </div>
    );
  },
}));

vi.mock('./ImportPreviewModal', () => ({
  default: () => null,
}));

vi.mock('./TableDesigner', () => ({
  default: ({ tab, embedded }: { tab: { tableName?: string; initialTab?: string }; embedded?: boolean }) => (
    <div data-table-designer={embedded ? 'embedded' : 'standalone'}>
      <span>SCHEMA DESIGNER</span>
      <span>{tab.tableName || 'unknown-table'}</span>
      <span>{tab.initialTab || 'columns'}</span>
    </div>
  ),
}));

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span />;

  return {
    ReloadOutlined: Icon,
    ImportOutlined: Icon,
    ExportOutlined: Icon,
    DownOutlined: Icon,
    PlusOutlined: Icon,
    DeleteOutlined: Icon,
    SaveOutlined: Icon,
    UndoOutlined: Icon,
    FilterOutlined: Icon,
    CloseOutlined: Icon,
    BugOutlined: Icon,
    CodeOutlined: Icon,
    ConsoleSqlOutlined: Icon,
    ControlOutlined: Icon,
    FileTextOutlined: Icon,
    CopyOutlined: Icon,
    ClearOutlined: Icon,
    EditOutlined: Icon,
    VerticalAlignBottomOutlined: Icon,
    ColumnWidthOutlined: Icon,
    PushpinOutlined: Icon,
    EyeInvisibleOutlined: Icon,
    LeftOutlined: Icon,
    RightOutlined: Icon,
    RobotOutlined: Icon,
    SearchOutlined: Icon,
    LinkOutlined: Icon,
    AimOutlined: Icon,
    TableOutlined: Icon,
    CheckSquareOutlined: Icon,
    SortAscendingOutlined: Icon,
    SortDescendingOutlined: Icon,
    DatabaseOutlined: Icon,
    NodeIndexOutlined: Icon,
    ThunderboltOutlined: Icon,
    FormatPainterOutlined: Icon,
  };
});

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: any) => <>{children}</>,
  PointerSensor: vi.fn(),
  KeyboardSensor: vi.fn(),
  MouseSensor: vi.fn(),
  TouchSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
  closestCenter: vi.fn(),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: any) => <>{children}</>,
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })),
  horizontalListSortingStrategy: vi.fn(),
  sortableKeyboardCoordinates: vi.fn(),
  arrayMove: (items: any[], from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  },
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => '',
    },
  },
}));

vi.mock('antd', () => {
  const Button = ({ children, disabled, loading, onClick, type, ...rest }: any) => (
    <button type="button" disabled={disabled || loading} data-button-type={type} onClick={onClick} {...rest}>
      {children}
    </button>
  );
  const Input: any = React.forwardRef<HTMLInputElement, any>(({ value, onChange, placeholder, ...rest }, ref) => (
    <input ref={ref} value={value} onChange={onChange} placeholder={placeholder} {...rest} />
  ));
  Input.displayName = 'MockInput';
  Input.TextArea = ({ value, onChange, placeholder }: any) => (
    <textarea value={value} onChange={onChange} placeholder={placeholder} />
  );
  const DatePicker = React.forwardRef<any, any>((props, _ref) => {
    testRenderState.latestDatePickerProps = props;
    return <div data-date-picker="true" />;
  });
  DatePicker.displayName = 'MockDatePicker';
  const TimePicker = React.forwardRef<any, any>((props, _ref) => {
    testRenderState.latestTimePickerProps = props;
    return <div data-time-picker="true" />;
  });
  TimePicker.displayName = 'MockTimePicker';

  const createForm = () => ({
    resetFields: vi.fn(),
    setFieldsValue: vi.fn(),
    getFieldsValue: vi.fn(() => ({})),
    getFieldValue: (field?: unknown) => testRenderState.formGetFieldValue(field),
    validateFields: (fields?: unknown) => testRenderState.formValidateFields(fields),
  });

  const Form: any = ({ children }: any) => <form>{children}</form>;
  Form.Item = ({ children }: any) => <>{children}</>;
  Form.useForm = () => [createForm()];

  const Modal: any = ({ children, footer, open, title }: any) => (
    open ? (
      <section data-modal-title={title}>
        <h2>{title}</h2>
        {children}
        <div>{footer}</div>
      </section>
    ) : null
  );
  Modal.useModal = () => {
    const [infoConfig, setInfoConfig] = React.useState<any>(null);
    const [confirmConfig, setConfirmConfig] = React.useState<any>(null);
    return [{
      info: vi.fn((config: any) => {
        setInfoConfig(config);
        return {
          destroy: vi.fn(() => {
            setInfoConfig(null);
          }),
          update: vi.fn(),
        };
      }),
      confirm: vi.fn((config: any) => {
        setConfirmConfig(config);
        return {
          destroy: vi.fn(() => {
            setConfirmConfig(null);
          }),
          update: vi.fn(),
        };
      }),
    }, (
      <>
        {infoConfig ? <section data-modal-use-holder="true">{infoConfig.content}</section> : null}
        {confirmConfig ? (
          <section data-modal-confirm-holder="true">
            <h2>{confirmConfig.title}</h2>
            {confirmConfig.content}
            <div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await confirmConfig.onOk?.();
                    setConfirmConfig(null);
                  } catch {
                    // keep dialog open when validation fails
                  }
                }}
              >
                {confirmConfig.okText || 'OK'}
              </button>
              <button
                type="button"
                onClick={() => {
                  confirmConfig.onCancel?.();
                  setConfirmConfig(null);
                }}
              >
                {confirmConfig.cancelText || 'Cancel'}
              </button>
            </div>
          </section>
        ) : null}
      </>
    )];
  };

  const passthrough = ({ children }: any) => <>{children}</>;
  const Dropdown = ({ children, menu, disabled }: any) => (
    <>
      {children}
      {!disabled && menu?.items?.map((item: any) => (
        item?.type === 'divider'
          ? null
          : <button key={item.key} type="button" disabled={item.disabled} onClick={item.onClick}>{item.label}</button>
      ))}
    </>
  );
  const Space = ({ children }: any) => <div>{children}</div>;
  const Tabs = ({ items = [], activeKey, onChange }: any) => {
    const resolvedActiveKey = activeKey ?? items[0]?.key;
    const activeItem = items.find((item: any) => item.key === resolvedActiveKey) || items[0];
    return (
      <div data-tabs-active-key={resolvedActiveKey}>
        <div>
          {items.map((item: any) => (
            <button key={item.key} type="button" data-tab-key={item.key} onClick={() => onChange?.(item.key)}>
              {item.label}
            </button>
          ))}
        </div>
        <div>{activeItem?.children ?? null}</div>
      </div>
    );
  };
  const Empty: any = ({ description }: any) => <div>{description || 'empty'}</div>;
  Empty.PRESENTED_IMAGE_SIMPLE = 'presented-image-simple';
  const Tag = ({ children }: any) => <span>{children}</span>;
  const Radio: any = ({ children }: any) => <span>{children}</span>;
  Radio.Group = ({ children }: any) => <div>{children}</div>;
  Radio.Button = ({ children }: any) => <button type="button">{children}</button>;
  const Typography: any = ({ children }: any) => <>{children}</>;
  Typography.Text = ({ children }: any) => <span>{children}</span>;
  Typography.Paragraph = ({ children }: any) => <p>{children}</p>;
  const Segmented = ({ value, options, onChange }: any) => (
    <div data-segmented-value={value}>
      {(options || []).map((option: any) => (
        <button
          key={option.value}
          type="button"
          data-segmented-option={option.value}
          onClick={() => onChange?.(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  const MockTable = React.forwardRef((_props: any, _ref) => {
      const props = _props;
      const { columns } = props;
      testRenderState.latestColumns = Array.isArray(columns) ? columns : [];
      testRenderState.latestTableProps = props;
      return <table />;
    });
  MockTable.displayName = 'MockTable';

  return {
    Table: MockTable,
    message: messageApi,
    Input,
    Button,
    Dropdown,
    Form,
    Pagination: () => null,
    Select: ({ children, options, onChange, disabled, value }: any) => (
      <div data-select-value={String(value ?? '')}>
        {children}
        {(options || []).map((option: any) => (
          <button
            key={String(option.value)}
            type="button"
            data-select-option={String(option.value)}
            disabled={disabled || option.disabled}
            onClick={() => onChange?.(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    ),
    InputNumber: ({ value, onChange, min, max }: any) => (
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange?.(Number(event.target.value))}
      />
    ),
    Modal,
    Checkbox: ({ checked, onChange }: any) => <input type="checkbox" checked={checked} onChange={onChange} />,
    Segmented,
    Tooltip: passthrough,
    Popover: passthrough,
    DatePicker,
    TimePicker,
    AutoComplete: ({ children }: any) => <>{children}</>,
    Tabs,
    Empty,
    Space,
    Tag,
    Radio,
    Typography,
    Progress: ({ percent, status, format }: any) => (
      <div data-progress-percent={String(percent)} data-progress-status={String(status)}>
        {typeof format === 'function' ? format(percent) : null}
      </div>
    ),
  };
});

const textContent = (node: any): string =>
  (node.children || [])
    .map((item: any) => (typeof item === 'string' ? item : textContent(item)))
    .join('');

const findButton = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll((node) => (
    node.type === 'button'
    && (
      textContent(node).includes(text)
      || String(node.props['aria-label'] || '').includes(text)
    )
  ))[0];

const renderHeaderText = (columnKey: string): string => {
  const column = testRenderState.latestColumns.find((item) => item.key === columnKey);
  expect(column).toBeTruthy();
  const headerRenderer = create(<>{column.title}</>);
  const content = textContent(headerRenderer.root);
  headerRenderer.unmount();
  return content;
};

const waitForEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const createRenderedCellTarget = (rowKey: string, columnName: string) => ({
  closest: (selector: string) => selector === '[data-row-key][data-col-name]'
    ? {
        getAttribute: (name: string) => {
          if (name === 'data-row-key') return rowKey;
          if (name === 'data-col-name') return columnName;
          return null;
        },
      }
    : null,
}) as unknown as HTMLElement;

const normalizeValue = (_columnName: string, value: any) => value;
const rowKeyToString = (key: any) => String(key);

const commitColumnGuard = (columnName: string) => (
  columnName !== GONAVI_ROW_KEY && columnName !== ORACLE_ROWID_LOCATOR_COLUMN
);

describe('DataGrid cell selection row keys', () => {
  it('deduplicates every record covered by a rectangular cell selection', () => {
    const cellKeys = Array.from({ length: 6 }, (_, rowIndex) => (
      ['id', 'user_id', 'app_key'].map((columnName) => `row-${rowIndex + 1}\u0001${columnName}`)
    )).flat();

    expect(collectDataGridCellSelectionRowKeys([
      ...cellKeys,
      'row-3\u0001id',
      'malformed-cell-key',
      '\u0001empty-row-key',
    ])).toEqual(['row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6']);
  });
});

describe('DataGrid commit change set', () => {
  it('omits blank generated columns from inserts while preserving ordinary blank values', () => {
    const columnMetaMap = buildColumnMetaMap([
      {
        name: 'id',
        type: 'bigint',
        nullable: 'NO',
        key: 'PRI',
        default: "nextval('users_id_seq'::regclass)",
        extra: 'auto_increment',
        comment: '',
      },
      {
        name: 'display_name',
        type: 'text',
        nullable: 'NO',
        key: '',
        extra: '',
        comment: '',
      },
    ]);
    const normalizeInsertValue = (columnName: string, value: any, mode: 'insert' | 'update') => (
      shouldOmitBlankDataGridInsertValue(value, mode, columnMetaMap[columnName])
        ? undefined
        : value
    );

    const result = buildDataGridCommitChangeSet({
      addedRows: [{ [GONAVI_ROW_KEY]: 'new-1', id: '', display_name: '' }],
      modifiedRows: {},
      deletedRowKeys: new Set(),
      data: [],
      editLocator: {
        strategy: 'primary-key',
        columns: ['id'],
        valueColumns: ['id'],
        readOnly: false,
      },
      visibleColumnNames: ['id', 'display_name'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeInsertValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(columnMetaMap.id).toMatchObject({
      default: "nextval('users_id_seq'::regclass)",
      extra: 'auto_increment',
      nullable: 'NO',
    });
    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [{ display_name: '' }],
        updates: [],
        deletes: [],
      },
    });
  });

  it('does not omit generated-column nulls or blank values during updates', () => {
    const generatedMeta = {
      type: 'bigint',
      comment: '',
      default: "nextval('users_id_seq'::regclass)",
      extra: 'auto_increment',
      nullable: 'NO',
    };

    expect(shouldOmitBlankDataGridInsertValue('', 'insert', generatedMeta)).toBe(true);
    expect(shouldOmitBlankDataGridInsertValue(null, 'insert', generatedMeta)).toBe(false);
    expect(shouldOmitBlankDataGridInsertValue('', 'update', generatedMeta)).toBe(false);
    expect(shouldOmitBlankDataGridInsertValue('', 'insert', { ...generatedMeta, default: '', extra: '' })).toBe(false);
  });

  it('uses unique locator values instead of falling back to the whole row', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        'row-1': { [GONAVI_ROW_KEY]: 'row-1', EMAIL: 'a@example.com', NAME: 'new-name', AGE: 42 },
      },
      deletedRowKeys: new Set(),
      data: [{ [GONAVI_ROW_KEY]: 'row-1', EMAIL: 'a@example.com', NAME: 'old-name', AGE: 42 }],
      editLocator: {
        strategy: 'unique-key',
        columns: ['EMAIL'],
        valueColumns: ['EMAIL'],
        readOnly: false,
      },
      visibleColumnNames: ['EMAIL', 'NAME', 'AGE'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [],
        updates: [{ keys: { EMAIL: 'a@example.com' }, values: { NAME: 'new-name' } }],
        deletes: [],
      },
    });
  });

  it('uses hidden Oracle ROWID only as locator and excludes it from update values', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        'row-1': { [GONAVI_ROW_KEY]: 'row-1', NAME: 'new-name', [ORACLE_ROWID_LOCATOR_COLUMN]: 'BBBB' },
      },
      deletedRowKeys: new Set(),
      data: [{ [GONAVI_ROW_KEY]: 'row-1', NAME: 'old-name', [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAAA' }],
      editLocator: {
        strategy: 'oracle-rowid',
        columns: ['ROWID'],
        valueColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
        hiddenColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
        readOnly: false,
      },
      visibleColumnNames: ['NAME'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [],
        updates: [{ keys: { ROWID: 'AAAA' }, values: { NAME: 'new-name' } }],
        deletes: [],
      },
    });
  });

  it('uses hidden DuckDB rowid only as locator and excludes it from update values', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        'row-1': { [GONAVI_ROW_KEY]: 'row-1', NAME: 'new-name', [DUCKDB_ROWID_LOCATOR_COLUMN]: 18 },
      },
      deletedRowKeys: new Set(),
      data: [{ [GONAVI_ROW_KEY]: 'row-1', NAME: 'old-name', [DUCKDB_ROWID_LOCATOR_COLUMN]: 17 }],
      editLocator: {
        strategy: 'duckdb-rowid',
        columns: ['rowid'],
        valueColumns: [DUCKDB_ROWID_LOCATOR_COLUMN],
        hiddenColumns: [DUCKDB_ROWID_LOCATOR_COLUMN],
        readOnly: false,
      },
      visibleColumnNames: ['NAME'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [],
        updates: [{ keys: { rowid: 17 }, values: { NAME: 'new-name' } }],
        deletes: [],
      },
    });
  });

  it('commits only writable result columns and maps aliases back to table columns', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        'row-1': {
          [GONAVI_ROW_KEY]: 'row-1',
          DISPLAY_NAME: 'new-name',
          NAME_UPPER: 'NEW-NAME',
        },
      },
      deletedRowKeys: new Set(),
      data: [{
        [GONAVI_ROW_KEY]: 'row-1',
        ID: 7,
        DISPLAY_NAME: 'old-name',
        NAME_UPPER: 'OLD-NAME',
      }],
      editLocator: {
        strategy: 'primary-key',
        columns: ['ID'],
        valueColumns: ['ID'],
        writableColumns: {
          DISPLAY_NAME: 'NAME',
        },
        readOnly: false,
      },
      visibleColumnNames: ['DISPLAY_NAME', 'NAME_UPPER'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [],
        updates: [{ keys: { ID: 7 }, values: { NAME: 'new-name' } }],
        deletes: [],
      },
    });
  });

  it('uses MongoDB _id as the locator and keeps _id out of update values', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [{
        [GONAVI_ROW_KEY]: 'new-1',
        _id: '507f1f77bcf86cd799439013',
        __gonavi_mongodb_id_locator__: { $oid: '507f1f77bcf86cd799439013' },
        name: 'insert-name',
      }],
      modifiedRows: {
        'row-1': {
          [GONAVI_ROW_KEY]: 'row-1',
          _id: '507f1f77bcf86cd799439999',
          __gonavi_mongodb_id_locator__: '507f1f77bcf86cd799439999',
          name: 'new-name',
        },
      },
      deletedRowKeys: new Set(['row-2']),
      data: [
        {
          [GONAVI_ROW_KEY]: 'row-1',
          _id: '507f1f77bcf86cd799439011',
          __gonavi_mongodb_id_locator__: { $oid: '507f1f77bcf86cd799439011' },
          name: 'old-name',
        },
        {
          [GONAVI_ROW_KEY]: 'row-2',
          _id: '507f1f77bcf86cd799439012',
          __gonavi_mongodb_id_locator__: '507f1f77bcf86cd799439012',
          name: 'to-delete',
        },
      ],
      editLocator: {
        strategy: 'primary-key',
        columns: ['_id'],
        valueColumns: ['__gonavi_mongodb_id_locator__'],
        hiddenColumns: ['__gonavi_mongodb_id_locator__'],
        writableColumns: {
          name: 'name',
        },
        readOnly: false,
      },
      visibleColumnNames: ['_id', 'name'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [{ name: 'insert-name' }],
        updates: [{ keys: { _id: { $oid: '507f1f77bcf86cd799439011' } }, values: { name: 'new-name' } }],
        deletes: [{ _id: '507f1f77bcf86cd799439012' }],
      },
    });
  });

  it('keeps MongoDB explicit typed edit values in the final commit payload', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [{
        [GONAVI_ROW_KEY]: 'new-1',
        _id: '507f1f77bcf86cd799439013',
        age: '{"$numberLong":"12"}',
        ratio: '1.5',
      }],
      modifiedRows: {},
      deletedRowKeys: new Set(),
      data: [],
      editLocator: {
        strategy: 'primary-key',
        columns: ['_id'],
        valueColumns: ['_id'],
        readOnly: false,
      },
      visibleColumnNames: ['_id', 'age', 'ratio'],
      rowKeyToString,
      normalizeCommitCellValue: (columnName, value) => parseMongoEditedValue(
        columnName,
        value,
        columnName === 'ratio' ? { $numberDouble: '0.5' } : undefined,
      ),
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [{
          _id: { $oid: '507f1f77bcf86cd799439013' },
          age: { $numberLong: '12' },
          ratio: { $numberDouble: '1.5' },
        }],
        updates: [],
        deletes: [],
      },
    });
  });

  it('fails closed when no safe locator is available', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        'row-1': { [GONAVI_ROW_KEY]: 'row-1', NAME: 'new-name' },
      },
      deletedRowKeys: new Set(),
      data: [{ [GONAVI_ROW_KEY]: 'row-1', NAME: 'old-name' }],
      editLocator: undefined,
      visibleColumnNames: ['NAME'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
      rowLocatorMessages: {
        noSafeLocator: () => 'No safe row locator is available for this result set.',
      },
    } as any);

    expect(result).toEqual({ ok: false, error: 'No safe row locator is available for this result set.' });
  });

  it('rejects delete rows when unique locator value is null', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {},
      deletedRowKeys: new Set(['row-1']),
      data: [{ [GONAVI_ROW_KEY]: 'row-1', EMAIL: null, NAME: 'old-name' }],
      editLocator: {
        strategy: 'unique-key',
        columns: ['EMAIL'],
        valueColumns: ['EMAIL'],
        readOnly: false,
      },
      visibleColumnNames: ['EMAIL', 'NAME'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({ ok: false, error: 'Locator column EMAIL is empty, so changes cannot be submitted safely.' });
  });

  it('keeps DataGrid safe locator fallback messages out of source Chinese literals', () => {
    const dataGridSource = readFileSync(new URL('./DataGrid.tsx', import.meta.url), 'utf8');
    const rowLocatorSource = readFileSync(new URL('../utils/rowLocator.ts', import.meta.url), 'utf8');

    expect(`${dataGridSource}\n${rowLocatorSource}`).not.toMatch(/当前结果没有可用的安全行定位方式|定位列 .* 的值为空，无法安全提交修改/);
  });

  it('keeps DataGrid AI insight prompt wrapper localized', () => {
    const dataGridSource = readFileSync(new URL('./DataGrid.tsx', import.meta.url), 'utf8');
    const dataGridShellSource = readFileSync(new URL('./DataGridShell.tsx', import.meta.url), 'utf8');

    expect(`${dataGridSource}\n${dataGridShellSource}`).not.toMatch(/请帮我分析以下查询结果数据|请分析数据特征|业务上的洞察/);
  });

  it('marks the active virtual editing row so shouldCellUpdate can reopen inline editors', () => {
    const rows = [
      { [GONAVI_ROW_KEY]: 'row-1', id: 1, name: 'alpha' },
      { [GONAVI_ROW_KEY]: 'row-2', id: 2, name: 'beta' },
    ];

    const nextRows = attachDataGridVirtualEditRenderVersion(rows, { sessionId: 1, rowKey: 'row-1', dataIndex: 'name', title: 'name' });
    const reopenedRows = attachDataGridVirtualEditRenderVersion(rows, { sessionId: 2, rowKey: 'row-1', dataIndex: 'name', title: 'name' });

    expect(nextRows[0]).not.toBe(rows[0]);
    expect(nextRows[1]).toBe(rows[1]);
    expect(hasDataGridVirtualEditRenderVersionChanged(nextRows[0], rows[0])).toBe(true);
    expect(hasDataGridVirtualEditRenderVersionChanged(nextRows[1], rows[1])).toBe(false);
    expect(hasDataGridVirtualEditRenderVersionChanged(reopenedRows[0], nextRows[0])).toBe(true);
  });
});

describe('DataGrid DDL interactions', () => {
  beforeEach(() => {
    resetTableMetadataRequestCacheForTests();
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetIndexes.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetForeignKeys.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTriggers.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({ success: true, data: 'CREATE TABLE users' });
    setCurrentLanguage('zh-CN');
    storeState.queryOptions.showColumnComment = false;
    storeState.queryOptions.showColumnType = false;
    storeState.appearance.uiVersion = 'legacy';
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    storeState.dataEditTransactionOptions = {
      commitMode: 'manual',
      autoCommitDelayMs: 5000,
    };
    storeState.setDataEditTransactionOptions.mockReset();
    storeState.setDataEditTransactionOptions.mockImplementation((options: Partial<typeof storeState.dataEditTransactionOptions>) => {
      storeState.dataEditTransactionOptions = {
        ...storeState.dataEditTransactionOptions,
        ...options,
      };
    });
    storeState.addSqlLog.mockReset();
    storeState.addTab.mockReset();
    storeState.setActiveContext.mockReset();
    storeState.tablePinnedLeftColumns = {};
    storeState.setTablePinnedLeftColumns.mockReset();
    testRenderState.latestColumns = [];
    testRenderState.latestTableProps = null;
    testRenderState.latestMonacoMouseDownListeners = [];
    testRenderState.latestMonacoMouseUpListeners = [];
    testRenderState.latestMonacoScrollChangeListeners = [];
    testRenderState.latestMonacoMouseTargetType = null;
    testRenderState.latestMonacoScrollLeft = 0;
    testRenderState.latestMonacoEditor = null;
    testRenderState.latestDatePickerProps = null;
    testRenderState.latestTimePickerProps = null;
    testRenderState.formValidateFields.mockReset();
    testRenderState.formValidateFields.mockResolvedValue({});
    testRenderState.formGetFieldValue.mockReset();
    resetDataGridDdlViewSharedStateForTests();

    const localStorageState = new Map<string, string>();

    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      activeElement: null,
      elementFromPoint: vi.fn(() => null),
      createElement: vi.fn(() => ({
        style: {},
        getContext: vi.fn(() => ({ measureText: vi.fn(() => ({ width: 0 })) })),
      })),
      body: { style: {} },
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      innerHeight: 768,
      innerWidth: 1024,
      getComputedStyle: vi.fn(() => ({ font: '12px sans-serif' })),
      localStorage: {
        getItem: vi.fn((key: string) => localStorageState.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          localStorageState.set(key, String(value));
        }),
        removeItem: vi.fn((key: string) => {
          localStorageState.delete(key);
        }),
      },
    });
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: '',
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
    vi.stubGlobal('HTMLElement', class {});
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    backendApp.ImportData.mockReset();
    backendApp.ExportTable.mockReset();
    backendApp.ExportData.mockReset();
    backendApp.ExportDataWithOptions.mockReset();
    backendApp.ExportQuery.mockReset();
    backendApp.ExportQueryWithOptions.mockReset();
    backendApp.ApplyChanges.mockReset();
    backendApp.PreviewChanges.mockReset();
    backendApp.DBGetColumns.mockReset();
    backendApp.DBGetIndexes.mockReset();
    backendApp.DBGetForeignKeys.mockReset();
    backendApp.DBGetTriggers.mockReset();
    backendApp.DBQuery.mockReset();
    backendApp.DBShowCreateTable.mockReset();
    resetDataGridDdlViewSharedStateForTests();
    vi.unstubAllGlobals();
  });

  it.each(['legacy', 'v2'] as const)(
    'opens the referenced table DDL from a %s query result',
    async (uiVersion) => {
      storeState.appearance.uiVersion = uiVersion;
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
            ddlDbName="main"
            ddlTableName="users"
            connectionId="conn-1"
            exportScope="queryResult"
          />,
        );
      });
      await waitForEffects();

      await act(async () => {
        findButton(renderer!, '查看 DDL').props.onClick();
      });
      await waitForEffects();

      expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'mysql' }),
        'main',
        'users',
      );
      expect(textContent(renderer!.root)).toContain('CREATE TABLE users');
      expect(textContent(renderer!.root)).not.toContain('对象设计');
    },
  );

  it('ignores stale DDL responses after the table context changes', async () => {
    let resolveFirstRequest: (value: any) => void = () => {};
    backendApp.DBShowCreateTable.mockReturnValueOnce(new Promise((resolve) => {
      resolveFirstRequest = resolve;
    }));

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
          onReload={() => {}}
        />,
      );
    });
    await waitForEffects();

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
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
      resolveFirstRequest({ success: true, data: 'CREATE TABLE users' });
    });
    await waitForEffects();

    expect(textContent(renderer!.root)).not.toContain('CREATE TABLE users');
    expect(renderer!.root.findAll((node) => node.props['data-modal-title'] === 'DDL - orders')).toHaveLength(0);
  });

  it.each(['legacy', 'v2'] as const)(
    'opens the referenced table when clicking a foreign-key column header in %s UI',
    async (uiVersion) => {
      storeState.appearance.uiVersion = uiVersion;
      backendApp.DBGetForeignKeys.mockResolvedValueOnce({
        success: true,
        data: [{
          columnName: 'customer_id',
          refTableName: 'customers',
          refColumnName: 'id',
          constraintName: 'fk_orders_customer',
        }],
      });

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <DataGrid
            data={[{ __gonavi_row_key__: 'row-1', id: 1, customer_id: 10 }]}
            columnNames={['id', 'customer_id']}
            loading={false}
            tableName="orders"
            dbName="main"
            connectionId="conn-1"
          />,
        );
      });
      await waitForEffects();

      const fkColumn = testRenderState.latestColumns.find((column) => column.key === 'customer_id');
      expect(fkColumn).toBeTruthy();
      const headerRenderer = create(<>{fkColumn.title}</>);
      const fkJump = headerRenderer.root.findByProps({ 'data-grid-fk-jump': 'true' });
      await act(async () => {
        fkJump.props.onClick({
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });

      expect(storeState.setActiveContext).toHaveBeenCalledWith({ connectionId: 'conn-1', dbName: 'main' });
      expect(storeState.addTab).toHaveBeenCalledWith({
        id: 'conn-1-main-table-customers',
        title: 'customers',
        type: 'table',
        connectionId: 'conn-1',
        dbName: 'main',
        tableName: 'customers',
        objectType: 'table',
      });
    },
  );

  it('selects every editable cell in a column when its header is clicked in cell edit mode', async () => {
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
    await waitForEffects();

    const nameColumn = testRenderState.latestColumns.find((column) => column.key === 'name');
    expect(nameColumn?.editable).toBe(true);
    const headerProps = nameColumn.onHeaderCell(nameColumn);
    const event = {
      target: { closest: vi.fn(() => null) },
      currentTarget: { querySelector: vi.fn(() => null) },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      headerProps.onClickCapture(event);
    });

    const toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(toolbar.props.cellEditMode).toBe(true);
    expect(toolbar.props.selectedCellsSize).toBe(2);
    renderer!.unmount();
  });

  it('deletes every record represented by a cell-only column selection', async () => {
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
    expect(toolbar.props.selectedCellsSize).toBe(2);
    expect(toolbar.props.deleteTargetRowCount).toBe(2);
    expect(findButton(renderer!, t('data_grid.toolbar.delete_selected')).props.disabled).toBeFalsy();

    await act(async () => {
      toolbar.props.onRefresh();
    });
    await waitForEffects();

    toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(toolbar.props.selectedCellsSize).toBe(0);
    expect(toolbar.props.deleteTargetRowCount).toBe(0);
    expect(findButton(renderer!, t('data_grid.toolbar.delete_selected')).props.disabled).toBe(true);

    await act(async () => {
      headerProps.onClickCapture({
        target: { closest: vi.fn(() => null) },
        currentTarget: { querySelector: vi.fn(() => null) },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    await act(async () => {
      findButton(renderer!, t('data_grid.toolbar.delete_selected')).props.onClick();
    });
    await waitForEffects();

    toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(toolbar.props.pendingChangeCount).toBe(2);
    expect(toolbar.props.selectedCellsSize).toBe(0);
    expect(toolbar.props.deleteTargetRowCount).toBe(0);
    expect(findButton(renderer!, t('data_grid.toolbar.delete_selected')).props.disabled).toBe(true);
    expect(
      testRenderState.latestTableProps.dataSource.map((row: Record<string, unknown>) => (
        testRenderState.latestTableProps.rowClassName(row)
      )),
    ).toEqual(['row-deleted', 'row-deleted']);
    renderer!.unmount();
  });

  it('navigates and closes the current-page finder from its keyboard controls', async () => {
    const onCancel = vi.fn();
    const onNavigatePrevious = vi.fn();
    const onNavigateNext = vi.fn();
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGridPageFind
          isV2Ui
          darkMode={false}
          pageFindText="Ada"
          normalizedPageFindText="ada"
          hasMatches
          activePageFindPosition={1}
          matchCount={2}
          occurrenceCount={2}
          matchedCellCount={2}
          onPageFindTextChange={() => {}}
          onCancel={onCancel}
          onNavigatePrevious={onNavigatePrevious}
          onNavigateNext={onNavigateNext}
        />,
      );
    });
    const input = renderer!.root.findByType('input');
    const createKeyEvent = (key: string, shiftKey = false) => ({
      key,
      shiftKey,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    await act(async () => {
      input.props.onKeyDown(createKeyEvent('Enter'));
      input.props.onKeyDown(createKeyEvent('Enter', true));
      input.props.onKeyDown(createKeyEvent('Escape'));
    });

    expect(onNavigateNext).toHaveBeenCalledTimes(1);
    expect(onNavigatePrevious).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it('opens the V2 current-page finder with Ctrl+F and closes it without duplicating the widget', async () => {
    storeState.appearance.uiVersion = 'v2';
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
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
        />,
      );
    });
    await waitForEffects();

    expect(renderer!.root.findAllByType(DataGridPageFind)).toHaveLength(0);
    const keydownRegistrations = vi.mocked(window.addEventListener).mock.calls.filter(
      ([type, _listener, options]) => type === 'keydown' && options === true,
    );
    expect(keydownRegistrations).toHaveLength(1);
    const handlePageFindShortcut = keydownRegistrations[0][1] as EventListener;
    const createFindShortcutEvent = () => ({
      key: 'f',
      code: 'KeyF',
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      target: document.body,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    }) as unknown as KeyboardEvent;

    const firstShortcut = createFindShortcutEvent();
    await act(async () => {
      handlePageFindShortcut(firstShortcut);
    });
    expect(firstShortcut.preventDefault).toHaveBeenCalledTimes(1);
    expect(firstShortcut.stopPropagation).toHaveBeenCalledTimes(1);
    expect(firstShortcut.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findAllByType(DataGridPageFind)).toHaveLength(1);

    const secondShortcut = createFindShortcutEvent();
    await act(async () => {
      handlePageFindShortcut(secondShortcut);
    });
    expect(renderer!.root.findAllByType(DataGridPageFind)).toHaveLength(1);

    await act(async () => {
      renderer!.root.findByType(DataGridPageFind).props.onCancel();
    });
    expect(renderer!.root.findAllByType(DataGridPageFind)).toHaveLength(0);
    renderer!.unmount();
  });

  it('does not claim document-level Cmd+F for a query result without DataGrid focus', async () => {
    storeState.appearance.uiVersion = 'v2';
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
          exportScope="queryResult"
        />,
      );
    });
    await waitForEffects();

    const keydownRegistrations = vi.mocked(window.addEventListener).mock.calls.filter(
      ([type, _listener, options]) => type === 'keydown' && options === true,
    );
    expect(keydownRegistrations).toHaveLength(1);
    const event = {
      key: 'f',
      code: 'KeyF',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      target: document.body,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    await act(async () => {
      (keydownRegistrations[0][1] as EventListener)(event);
    });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByType(DataGridPageFind)).toHaveLength(0);
    renderer!.unmount();
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
        canModifyData
        copiedRowCount={2}
        canPasteCopiedColumns
      />,
    );

    const content = textContent(renderer.root);
    expect(content).toContain(t('data_grid.context_menu.column_unnamed_field'));
    expect(content).toContain(t('data_grid.context_menu.current_row'));
    expect(content).toContain(t('data_grid.context_menu.copy_field_name'));
    expect(content).toContain(t('data_grid.context_menu.edit_section'));
    expect(content).toContain(t('data_grid.batch_fill.set_null'));
    expect(content).toContain(t('data_grid.context_menu.edit_row'));
    expect(content).toContain(t('data_grid.context_menu.copy_row_as_new'));
    expect(content).toContain(t('data_grid.context_menu.paste_row_as_new_count', { count: 2 }));
    expect(content).toContain(t('data_grid.context_menu.fill_to_selected_rows', { count: '3' }));
    expect(content).toContain(t('data_grid.context_menu.paste_copied_columns'));
    ['未命名字段', '当前行', '当前单元格', '复制字段名称', '编辑', '设置为 NULL', '编辑本行', '复制本行为新增行', '粘贴为新增行', '填充到选中行', '粘贴已复制列'].forEach((rawSnippet) => {
      expect(content).not.toContain(rawSnippet);
    });
    renderer.unmount();
  });

  it('opens the v2 cell context menu for table cells instead of the legacy inline menu', async () => {
    storeState.appearance.uiVersion = 'v2';

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

  it('opens the complete cell value in a read-only viewer on double-click', async () => {
    storeState.appearance.uiVersion = 'v2';
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

  it('formats a writable JSON cell from the toolbar before saving the draft', async () => {
    storeState.appearance.uiVersion = 'v2';
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
    expect(formatButton.props.disabled).not.toBe(true);
    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(compactJson);

    await act(async () => {
      formatButton.props.onClick();
    });

    expect(textContent(editor.findByProps({ 'data-monaco-editor': 'true' }))).toBe(formattedJson);
    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(compactJson);

    await act(async () => {
      findButton(renderer!, t('common.save')).props.onClick();
    });

    expect(testRenderState.latestTableProps.dataSource[0].payload).toBe(formattedJson);
    renderer!.unmount();
  });

  it('preserves spaced and empty quoted column aliases when resolving a read-only cell', async () => {
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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

  it('keeps a pending MongoDB value in the viewer after the field becomes read-only', async () => {
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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

  it('hides the cell viewer immediately when the data-source context changes', async () => {
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
      storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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

  it('opens a refreshed row value without waiting for passive effects', async () => {
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';

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
    storeState.appearance.uiVersion = 'v2';

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
    storeState.appearance.uiVersion = 'v2';

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

  it('auto commits pending table edits after the configured delay', async () => {
    vi.useFakeTimers();
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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

  it('returns to the legacy table view when v2-only footer views are active during UI switch', async () => {
    storeState.appearance.uiVersion = 'v2';

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
    expect(textContent(renderer!.root)).toContain('SCHEMA DESIGNER');

    storeState.appearance.uiVersion = 'legacy';
    await act(async () => {
      renderer!.update(
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

    const content = textContent(renderer!.root);
    expect(content).not.toContain('SCHEMA DESIGNER');
    expect(content).not.toContain('gn-v2-data-grid-fields-view');
    expect(content).toContain('数据预览');
    expect(content).toContain('结果视图');
    expect(findButton(renderer!, '字段信息')).toBeTruthy();
  });

  it('keeps the v2 fields tab as read-only field info for views', async () => {
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
    storeState.appearance.uiVersion = 'v2';
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
