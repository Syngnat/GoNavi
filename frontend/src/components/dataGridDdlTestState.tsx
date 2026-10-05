// DataGrid.ddl.test.tsx 拆分前的共享 mock 状态与 mock 工厂；mock 工厂经动态 import 委托到这里，本模块不得导入被 mock 的模块。
import React from 'react';
import { vi } from 'vitest';

export const storeState = (() => ({
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
}))();

export const backendApp = (() => ({
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
}))();

export const testRenderState = (() => ({
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
}))();

export const messageApi = (() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  loading: vi.fn(() => vi.fn()),
}))();

// vi.mock('../store')
export const mockModule1 = () => ({
  useStore: (selector: (state: typeof storeState) => any) => selector(storeState),
});

// vi.mock('../../wailsjs/go/app/App')
export const mockModule2 = () => backendApp;

// vi.mock('../../wailsjs/runtime/runtime')
export const mockModule3 = () => ({
  EventsOn: vi.fn(() => vi.fn()),
});

// vi.mock('react-dom')
export const mockModule4 = async () => {
  const actual = await vi.importActual<any>('react-dom');
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
};

// vi.mock('@monaco-editor/react')
export const mockModule5 = () => ({
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
});

// vi.mock('./ImportPreviewModal')
export const mockModule6 = () => ({
  default: () => null,
});

// vi.mock('./TableDesigner')
export const mockModule7 = () => ({
  default: ({ tab, embedded }: { tab: { tableName?: string; initialTab?: string }; embedded?: boolean }) => (
    <div data-table-designer={embedded ? 'embedded' : 'standalone'}>
      <span>SCHEMA DESIGNER</span>
      <span>{tab.tableName || 'unknown-table'}</span>
      <span>{tab.initialTab || 'columns'}</span>
    </div>
  ),
});

// vi.mock('@ant-design/icons')
export const mockModule8 = () => {
  const Icon = () => <span />;

  return {
    ReloadOutlined: Icon,
    ImportOutlined: Icon,
    ExportOutlined: Icon,
    CompressOutlined: Icon,
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
    SelectOutlined: Icon,
    SnippetsOutlined: Icon,
  };
};

// vi.mock('@dnd-kit/core')
export const mockModule9 = () => ({
  DndContext: ({ children }: any) => <>{children}</>,
  PointerSensor: vi.fn(),
  KeyboardSensor: vi.fn(),
  MouseSensor: vi.fn(),
  TouchSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
  closestCenter: vi.fn(),
});

// vi.mock('@dnd-kit/sortable')
export const mockModule10 = () => ({
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
});

// vi.mock('@dnd-kit/utilities')
export const mockModule11 = () => ({
  CSS: {
    Transform: {
      toString: () => '',
    },
  },
});

// vi.mock('antd')
export const mockModule12 = () => {
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
};
