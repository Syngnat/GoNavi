// QueryEditor.results-and-drop.test.tsx 拆分前的共享 mock 状态与 mock 工厂；mock 工厂经动态 import 委托到这里，本模块不得导入被 mock 的模块。
import React from 'react';
import { vi } from 'vitest';
import type { SavedQuery } from '../types';

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
  sqlLogs: [] as Array<{
    id: string;
    timestamp: number;
    sql: string;
    status: 'success' | 'error';
    duration: number;
  }>,
  clearSqlLogs: vi.fn(),
  addSqlLog: vi.fn(),
  addTab: vi.fn(),
  setActiveContext: vi.fn(),
  updateQueryTabDraft: vi.fn(),
  savedQueries: [] as SavedQuery[],
  saveQuery: vi.fn(),
  theme: 'light',
  fontSize: 14,
  languagePreference: 'zh-CN' as 'zh-CN' | 'en-US',
  appearance: {
    customMonoFontFamily: null as string | null,
    dataTableFontSize: null as number | null,
    dataTableFontSizeFollowGlobal: true,
    sqlEditorFontSize: null as number | null,
    sqlEditorFontSizeFollowGlobal: true,
  },
  sqlFormatOptions: { keywordCase: 'upper' as 'upper' | 'lower' },
  setSqlFormatOptions: vi.fn(),
  queryOptions: {
    maxRows: 5000,
    showColumnComment: true,
    showColumnType: true,
    showQueryResultsPanel: false,
  },
  setQueryOptions: vi.fn(),
  sqlEditorTransactionOptions: {
    commitMode: 'manual' as 'manual' | 'auto',
    autoCommitDelayMs: 0,
  },
  setSqlEditorTransactionOptions: vi.fn(),
  sqlEditorPendingTransactions: {} as Record<string, unknown>,
  setSqlEditorPendingTransaction: vi.fn(),
  shortcutOptions: {
    runQuery: {
      mac: { enabled: false, combo: '' },
      windows: { enabled: false, combo: '' },
    },
    selectCurrentStatement: {
      mac: { enabled: false, combo: '' },
      windows: { enabled: false, combo: '' },
    },
    saveQuery: {
      mac: { enabled: true, combo: 'Meta+S' },
      windows: { enabled: true, combo: 'Ctrl+S' },
    },
    toggleQueryResultsPanel: {
      mac: { enabled: true, combo: 'Meta+Shift+M' },
      windows: { enabled: true, combo: 'Ctrl+Shift+M' },
    },
  },
  activeTabId: 'tab-1',
  aiPanelVisible: false,
  setAIPanelVisible: vi.fn(),
  sqlSnippets: [] as any[],
}))();

export const storeSubscribers = (() => new Set<() => void>())();

export const backendApp = (() => {
  // Budgeted variants delegate to the base spies so existing assertions hold.
  const queryMulti = vi.fn();
  const queryMultiTransactional = vi.fn();
  return {
  DBQuery: vi.fn(),
  DBQueryWithCancel: vi.fn(),
  DBQueryMulti: queryMulti,
  DBQueryMultiWithOptions: vi.fn((...args: any[]) => queryMulti(...args.slice(0, 4))),
  DBQueryMultiTransactional: queryMultiTransactional,
  DBQueryMultiTransactionalWithOptions: vi.fn((...args: any[]) => queryMultiTransactional(...args.slice(0, 4))),
  DBCommitTransaction: vi.fn(),
  DBCommitTransactionWithTrigger: vi.fn(),
  DBRollbackTransaction: vi.fn(),
  DBRollbackTransactionWithTrigger: vi.fn(),
  DBGetTables: vi.fn(),
  DBTableExists: vi.fn(),
  DBGetAllColumns: vi.fn(),
  DBGetDatabases: vi.fn(),
  DBGetColumns: vi.fn(),
  DBGetIndexes: vi.fn(),
  CancelQuery: vi.fn(),
  GenerateQueryID: vi.fn(),
  WriteSQLFile: vi.fn(),
  ExportSQLFile: vi.fn(),
  };
})();

export const nativeDetachedWindowState = (() => ({
  openNativeQueryResultWindow: vi.fn(),
}))();

export const messageApi = (() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}))();

export const dataGridState = (() => ({
  latestProps: null as any,
}))();

export const tabsState = (() => ({
  activeKey: undefined as string | undefined,
}))();

export const autoFetchState = (() => ({
  visible: false,
}))();

export const editorState = (() => {
  const state = {
    value: '',
    editor: null as any,
    domNode: { style: { cursor: '' }, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    position: { lineNumber: 1, column: 1 },
    selection: null as any,
    providers: [] as any[],
    hoverProviders: [] as any[],
    contentChangeListeners: [] as Array<() => void>,
    cursorPositionListeners: [] as Array<(event: any) => void>,
    modelContentListeners: [] as Array<(event: any) => void>,
    keyDownListeners: [] as Array<(event: any) => void>,
    mouseMoveListeners: [] as Array<(event: any) => void>,
    mouseDownListeners: [] as Array<(event: any) => void>,
    mouseLeaveListeners: [] as Array<() => void>,
    hasTextFocus: true,
    decorationIds: [] as string[],
    contentHoverCalls: [] as any[],
    latestOnChange: null as null | ((value?: string) => void),
    latestOptions: null as any,
  };
  const offsetAt = (position: { lineNumber: number; column: number }) => {
    const text = state.value;
    let offset = 0;
    for (let lineNumber = 1; lineNumber < Math.max(1, position.lineNumber); lineNumber++) {
      const nextLineBreak = text.indexOf('\n', offset);
      if (nextLineBreak === -1) {
        return text.length;
      }
      offset = nextLineBreak + 1;
    }
    return Math.min(text.length, offset + Math.max(0, position.column - 1));
  };
  const positionAt = (offset: number) => {
    const text = state.value.replace(/\r\n/g, '\n');
    const safeOffset = Math.max(0, Math.min(text.length, Number(offset) || 0));
    const prefix = text.slice(0, safeOffset);
    const lines = prefix.split('\n');
    return { lineNumber: lines.length, column: (lines[lines.length - 1]?.length || 0) + 1 };
  };
  const valueInRange = (range: any) => {
    if (!range) return '';
    const start = offsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
    const end = offsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
    return state.value.slice(Math.min(start, end), Math.max(start, end));
  };
  const model = {
    getValue: vi.fn(() => state.value),
    getValueLength: vi.fn(() => state.value.length),
    setValue: (value: string) => {
      state.value = value;
    },
    getValueInRange: valueInRange,
    getLineContent: (lineNumber: number) => state.value.replace(/\r\n/g, '\n').split('\n')[lineNumber - 1] || '',
    getLineCount: () => state.value.replace(/\r\n/g, '\n').split('\n').length,
    getLineMaxColumn: (lineNumber: number) => (state.value.replace(/\r\n/g, '\n').split('\n')[lineNumber - 1] || '').length + 1,
    getWordUntilPosition: (position: { lineNumber: number; column: number }) => {
      const lineContent = model.getLineContent(position.lineNumber);
      const beforeCursor = lineContent.slice(0, Math.max(0, position.column - 1));
      const word = beforeCursor.match(/[A-Za-z0-9_$]*$/)?.[0] || '';
      return {
        startColumn: position.column - word.length,
        endColumn: position.column,
        word,
      };
    },
    getOffsetAt: offsetAt,
    getPositionAt: positionAt,
  };
  state.editor = {
    getValue: vi.fn(() => state.value),
    setValue: vi.fn((value: string) => {
      state.value = value;
    }),
    getModel: vi.fn(() => model),
    getPosition: vi.fn(() => state.position),
    setPosition: vi.fn((position: any) => {
      state.position = position;
    }),
    getSelection: vi.fn(() => state.selection),
    getDomNode: vi.fn(() => state.domNode),
    getContribution: vi.fn((id: string) => {
      if (id === 'editor.contrib.contentHover') {
        return {
          showContentHover: vi.fn((range: any, mode: any, source: any, focus: any) => {
            state.contentHoverCalls.push({ range, mode, source, focus });
          }),
        };
      }
      return null;
    }),
    setSelection: vi.fn((selection: any) => {
      state.selection = selection;
    }),
    executeEdits: vi.fn((_source: string, edits: any[]) => {
      edits.forEach((edit) => {
        const start = offsetAt({ lineNumber: edit.range.startLineNumber, column: edit.range.startColumn });
        const end = offsetAt({ lineNumber: edit.range.endLineNumber, column: edit.range.endColumn });
        state.value = state.value.slice(0, start) + edit.text + state.value.slice(end);
      });
    }),
    addAction: vi.fn(),
    onDidChangeModelContent: vi.fn((listener: (event?: any) => void) => {
      state.contentChangeListeners.push(listener);
      state.modelContentListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onDidChangeCursorPosition: vi.fn((listener: (event: any) => void) => {
      state.cursorPositionListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onKeyDown: vi.fn((listener: (event: any) => void) => {
      state.keyDownListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onMouseMove: vi.fn((listener: (event: any) => void) => {
      state.mouseMoveListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onMouseDown: vi.fn((listener: (event: any) => void) => {
      state.mouseDownListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onMouseLeave: vi.fn((listener: () => void) => {
      state.mouseLeaveListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    deltaDecorations: vi.fn((oldDecorations: string[], newDecorations: any[]) => {
      state.decorationIds = newDecorations.map((_: any, index: number) => `decoration-${index + 1}`);
      return state.decorationIds;
    }),
    updateOptions: vi.fn(),
    pushUndoStop: vi.fn(),
    onDidDispose: vi.fn(),
    hasTextFocus: vi.fn(() => state.hasTextFocus),
    revealLineInCenterIfOutsideViewport: vi.fn(),
    revealRangeInCenterIfOutsideViewport: vi.fn(),
    layout: vi.fn(),
    focus: vi.fn(),
    trigger: vi.fn(),
  };
  return state;
})();

// vi.mock('../store')
export const mockModule1 = async (importOriginal: <T = unknown>() => Promise<T>) => {
  const actual = await importOriginal<typeof import('../store')>();
  const useStore = Object.assign(
    (selector: (state: typeof storeState) => any) => React.useSyncExternalStore(
      (subscriber) => {
        storeSubscribers.add(subscriber);
        return () => {
          storeSubscribers.delete(subscriber);
        };
      },
      () => selector(storeState),
      () => selector(storeState),
    ),
    {
      getState: () => storeState,
      // queryEditorResultSessionLifecycle 用 useStore.subscribe 监听 activeTabId；这里的用例不切换标签。
      subscribe: () => () => undefined,
    },
  );
  return { ...actual, useStore };
};

// vi.mock('../../wailsjs/go/app/App')
export const mockModule2 = () => backendApp;

// vi.mock('../utils/nativeDetachedWindowHost')
export const mockModule3 = () => nativeDetachedWindowState;

// vi.mock('../utils/autoFetchVisibility')
export const mockModule4 = () => ({
  useAutoFetchVisibility: () => autoFetchState.visible,
});

// vi.mock('@monaco-editor/react')
export const mockModule5 = () => ({
  default: ({ defaultValue, onChange, onMount, options }: any) => {
    React.useEffect(() => {
      editorState.value = String(defaultValue || '');
      editorState.latestOnChange = onChange;
      editorState.latestOptions = options ?? null;
      onMount?.(editorState.editor, {
        editor: { setTheme: vi.fn() },
        KeyMod: { CtrlCmd: 2048, WinCtrl: 256, Alt: 512, Shift: 1024 },
        KeyCode: { KeyF: 70, KeyM: 77, KeyQ: 81, KeyR: 82, KeyS: 83 },
        languages: {
          CompletionItemKind: { Keyword: 1, Function: 2, Field: 3 },
          CompletionItemInsertTextRule: { InsertAsSnippet: 1 },
          registerCompletionItemProvider: vi.fn((_language: string, provider: any) => {
            editorState.providers.push(provider);
            return { dispose: vi.fn() };
          }),
          registerHoverProvider: vi.fn((_language: string, provider: any) => {
            editorState.hoverProviders.push(provider);
            editorState.hoverProviders.sort((left, right) => {
              const leftRank = left?.__gonaviHoverProviderKind === 'metadata' ? 0 : 1;
              const rightRank = right?.__gonaviHoverProviderKind === 'metadata' ? 0 : 1;
              return leftRank - rightRank;
            });
            return { dispose: vi.fn() };
          }),
        },
        Range: class {
          startLineNumber: number;
          startColumn: number;
          endLineNumber: number;
          endColumn: number;
          constructor(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) {
            this.startLineNumber = startLineNumber;
            this.startColumn = startColumn;
            this.endLineNumber = endLineNumber;
            this.endColumn = endColumn;
          }
        },
        MarkdownString: class {
          value: string;
          constructor(value: string) {
            this.value = value;
          }
        },
        Position: class {
          lineNumber: number;
          column: number;
          constructor(lineNumber: number, column: number) {
            this.lineNumber = lineNumber;
            this.column = column;
          }
        },
      });
    }, []);
    return <textarea data-editor value={editorState.value} readOnly />;
  },
});

// vi.mock('./DataGrid')
export const mockModule6 = () => ({
  default: (props: any) => {
    dataGridState.latestProps = props;
    return (
      <div data-grid="true">
        {props.toolbarExtraActions ?? null}
      </div>
    );
  },
  GONAVI_ROW_KEY: '__gonavi_row_key__',
});

// vi.mock('./resultDiff/ResultDiffWizard')
export const mockModule7 = () => ({
  default: () => null,
});

// vi.mock('./resultDiff/ViewDataVerifyWizard')
export const mockModule8 = () => ({
  default: () => null,
});

// vi.mock('./LogPanel')
export const mockModule9 = () => ({
  default: ({ executionError }: any) => (
    <div data-log-panel="true">
      {executionError || 'log-panel'}
    </div>
  ),
});

// vi.mock('./DetachDragPreview')
export const mockModule10 = async () => {
  const actual = await vi.importActual<typeof import('./DetachDragPreview')>('./DetachDragPreview');
  return {
    ...actual,
    default: () => null,
  };
};

// vi.mock('@ant-design/icons')
export const mockModule11 = () => {
  const Icon = () => <span />;
  return {
    BugOutlined: Icon,
    ArrowDownOutlined: Icon,
    ArrowUpOutlined: Icon,
    BulbOutlined: Icon,
    CheckOutlined: Icon,
    ClearOutlined: Icon,
    ClockCircleOutlined: Icon,
    CodeOutlined: Icon,
    CopyOutlined: Icon,
    DiffOutlined: Icon,
    EditOutlined: Icon,
    ExportOutlined: Icon,
    FileTextOutlined: Icon,
    HistoryOutlined: Icon,
    KeyOutlined: Icon,
    TableOutlined: Icon,
    ApiOutlined: Icon,
    ArrowLeftOutlined: Icon,
    ArrowRightOutlined: Icon,
    LoadingOutlined: Icon,
    PlayCircleOutlined: Icon,
    SaveOutlined: Icon,
    UndoOutlined: Icon,
    FormatPainterOutlined: Icon,
    FullscreenExitOutlined: Icon,
    FullscreenOutlined: Icon,
    SettingOutlined: Icon,
    CloseOutlined: Icon,
    StopOutlined: Icon,
    ThunderboltOutlined: Icon,
    DownOutlined: Icon,
    RobotOutlined: Icon,
    AimOutlined: Icon,
    SearchOutlined: Icon,
    DatabaseOutlined: Icon,
    EyeOutlined: Icon,
    EyeInvisibleOutlined: Icon,
    PushpinOutlined: Icon,
    EnterOutlined: Icon,
    EllipsisOutlined: Icon,
  };
};

// vi.mock('antd')
export const mockModule12 = () => {
  const Button: any = ({ children, disabled, loading, onClick, onMouseDown, ...rest }: any) => (
    <button type="button" disabled={disabled || loading} onClick={onClick} onMouseDown={onMouseDown} {...rest}>
      {children}
    </button>
  );
  Button.Group = ({ children }: any) => <div>{children}</div>;
  const Space: any = ({ children }: any) => <div>{children}</div>;
  Space.Compact = ({ children, className }: any) => <div className={className}>{children}</div>;

  const Form: any = ({ children }: any) => <form>{children}</form>;
  Form.Item = ({ children }: any) => <>{children}</>;
  Form.useForm = () => [{ setFieldsValue: vi.fn(), validateFields: vi.fn(() => Promise.resolve({ name: '查询' })) }];
  const Table = ({ dataSource, columns }: { dataSource: any[]; columns: any[] }) => (
    <div>
      {dataSource.map((record) => (
        <div key={record.id}>
          {columns.map((column) => (
            <div key={column.dataIndex || column.title}>
              {column.render
                ? column.render(record[column.dataIndex], record)
                : record[column.dataIndex]}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
  const Empty = ({ description }: { description?: React.ReactNode }) => <div>{description}</div>;
  (Empty as any).PRESENTED_IMAGE_SIMPLE = 'simple';
  const Input: any = ({ value, onChange, placeholder }: any) => <input value={value} onChange={onChange} placeholder={placeholder} />;
  Input.TextArea = ({ value, onChange, placeholder, disabled }: any) => (
    <textarea value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} />
  );

  return {
    Button,
    Space,
    Table,
    Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
    Spin: () => <div className="mock-spin" />,
    Checkbox: ({ children, checked, onChange }: any) => (
      <label>
        <input type="checkbox" checked={!!checked} onChange={(event) => onChange?.({ target: { checked: event.target.checked } })} />
        {children}
      </label>
    ),
    DatePicker: ({ value }: any) => <input data-mock="datepicker" value={value || ''} />,
    InputNumber: ({ value }: any) => <input data-mock="inputnumber" value={value ?? ''} />,
    Empty,
    message: messageApi,
    Modal: ({ children, open, onOk, okText = '确认' }: any) => (open ? (
      <section>
        {children}
        <button type="button" onClick={onOk}>{okText}</button>
      </section>
    ) : null),
    Input,
    Segmented: () => null,
    Form,
    Dropdown: ({ children, menu }: any) => {
      const renderMenuItems = (items: any[] = []): React.ReactNode => items.map((item: any) => {
        if (item?.type === 'divider') return null;
        if (item?.type === 'group') {
          return (
            <React.Fragment key={item.key}>
              <span>{item.label}</span>
              {renderMenuItems(item.children)}
            </React.Fragment>
          );
        }
        return <button key={item.key} type="button" disabled={item.disabled} onClick={item.onClick}>{item.label}</button>;
      });
      return (
        <>
          {children}
          {renderMenuItems(menu?.items)}
        </>
      );
    },
    Tooltip: ({ children }: any) => <>{children}</>,
    Select: () => null,
    Tabs: ({ activeKey, items, onChange, tabBarExtraContent }: any) => {
      const hasRememberedActiveItem = items?.some((item: any) => item.key === tabsState.activeKey);
      const resolvedActiveKey = (hasRememberedActiveItem ? tabsState.activeKey : undefined) ?? activeKey ?? items?.[0]?.key;
      const activeItem = items?.find((item: any) => item.key === resolvedActiveKey) || items?.[0];
      return (
        <div>
          <div>
            {items?.map((item: any) => (
              <button
                key={item.key}
                type="button"
                data-tab-key={item.key}
                onClick={() => {
                  tabsState.activeKey = item.key;
                  onChange?.(item.key);
                }}
              >
                {item.label}
              </button>
            ))}
            {tabBarExtraContent?.right ?? null}
          </div>
          <div>{activeItem?.children}</div>
        </div>
      );
    },
  };
};
