import React from 'react';
import { readFileSync } from 'node:fs';
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readV2ThemeCss } from '../test/readV2ThemeCss';

import { setCurrentLanguage } from '../i18n';
import type { SavedQuery, TabData } from '../types';
import { clearQueryEditorResultSession } from '../utils/queryEditorResultSessionCache';
import { formatSqlExecutionError } from '../utils/sqlErrorSemantics';
import { clearQueryTabDraft, clearSQLFileTabDraft } from '../utils/sqlFileTabDrafts';
import {
  CLOSE_ACTIVE_RESULT_TAB_EVENT,
  type CloseActiveResultShortcutRequest,
} from '../utils/closeTabShortcut';
import { normalizeQueryResultMessages } from './queryEditor/QueryEditorHelpers';
import QueryEditor, {
  collectQueryEditorObjectDecorationCandidates,
  filterQueryEditorResultSetsForBulkClose,
  resolveQueryEditorNavigationDecorations,
  resolveQueryEditorNavigationTarget,
  shouldRefreshQueryEditorCompletionColumns,
} from './QueryEditor';
import QueryEditorResultsPanel, {
  QUERY_EDITOR_SQL_LOG_TAB_KEY,
  resolveEffectiveActiveResultKey,
  shouldActivateResultTabDetachPointer,
} from './QueryEditorResultsPanel';
import QueryEditorToolbar from './QueryEditorToolbar';

const mountedRenderers = new Set<ReactTestRenderer>();
const create = (...args: Parameters<typeof createRenderer>): ReactTestRenderer => {
  const renderer = createRenderer(...args);
  mountedRenderers.add(renderer);
  const unmount = renderer.unmount.bind(renderer);
  renderer.unmount = () => {
    mountedRenderers.delete(renderer);
    unmount();
  };
  return renderer;
};

describe('query editor incomplete column metadata', () => {
  it('retries column metadata when the cached fields came from a partial summary', () => {
    expect(shouldRefreshQueryEditorCompletionColumns('column_name', true, true)).toBe(true);
    expect(shouldRefreshQueryEditorCompletionColumns('column_name', true, false)).toBe(false);
    expect(shouldRefreshQueryEditorCompletionColumns('table_name', false, true)).toBe(false);
  });
});

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
    uiVersion: 'legacy' as 'legacy' | 'v2',
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
}));

const storeSubscribers = vi.hoisted(() => new Set<() => void>());

const notifyStoreSubscribers = () => {
  storeSubscribers.forEach((subscriber) => subscriber());
};

const backendApp = vi.hoisted(() => ({
  DBQuery: vi.fn(),
  DBQueryWithCancel: vi.fn(),
  DBQueryMulti: vi.fn(),
  DBQueryMultiTransactional: vi.fn(),
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
}));

const nativeDetachedWindowState = vi.hoisted(() => ({
  openNativeQueryResultWindow: vi.fn(),
}));

const messageApi = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

const dataGridState = vi.hoisted(() => ({
  latestProps: null as any,
}));

const tabsState = vi.hoisted(() => ({
  activeKey: undefined as string | undefined,
}));

const autoFetchState = vi.hoisted(() => ({
  visible: false,
}));

const editorState = vi.hoisted(() => {
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
});

vi.mock('../store', async (importOriginal) => {
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
    { getState: () => storeState },
  );
  return { ...actual, useStore };
});

vi.mock('../../wailsjs/go/app/App', () => backendApp);

vi.mock('../utils/nativeDetachedWindowHost', () => nativeDetachedWindowState);

vi.mock('../utils/autoFetchVisibility', () => ({
  useAutoFetchVisibility: () => autoFetchState.visible,
}));

vi.mock('@monaco-editor/react', () => ({
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
}));

vi.mock('./DataGrid', () => ({
  default: (props: any) => {
    dataGridState.latestProps = props;
    return (
      <div data-grid="true">
        {props.toolbarExtraActions ?? null}
      </div>
    );
  },
  GONAVI_ROW_KEY: '__gonavi_row_key__',
}));

vi.mock('./resultDiff/ResultDiffWizard', () => ({
  default: () => null,
}));

vi.mock('./resultDiff/ViewDataVerifyWizard', () => ({
  default: () => null,
}));

vi.mock('./LogPanel', () => ({
  default: ({ executionError }: any) => (
    <div data-log-panel="true">
      {executionError || 'log-panel'}
    </div>
  ),
}));

vi.mock('./DetachDragPreview', async () => {
  const actual = await vi.importActual<typeof import('./DetachDragPreview')>('./DetachDragPreview');
  return {
    ...actual,
    default: () => null,
  };
});

vi.mock('@ant-design/icons', () => {
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
    ArrowLeftOutlined: Icon,
    ArrowRightOutlined: Icon,
    PlayCircleOutlined: Icon,
    SaveOutlined: Icon,
    UndoOutlined: Icon,
    FormatPainterOutlined: Icon,
    SettingOutlined: Icon,
    CloseOutlined: Icon,
    StopOutlined: Icon,
    ThunderboltOutlined: Icon,
    DownOutlined: Icon,
    RobotOutlined: Icon,
    SearchOutlined: Icon,
    DatabaseOutlined: Icon,
    EyeOutlined: Icon,
    EyeInvisibleOutlined: Icon,
    PushpinOutlined: Icon,
    EnterOutlined: Icon,
    EllipsisOutlined: Icon,
  };
});

vi.mock('antd', () => {
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
      const resolvedActiveKey = tabsState.activeKey ?? activeKey ?? items?.[0]?.key;
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
});

const textContent = (node: any): string => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((item) => textContent(item)).join('');
  return (node.children || [])
    .map((item: any) => (typeof item === 'string' ? item : textContent(item)))
    .join('');
};

const findButtons = (renderer: ReactTestRenderer, text: string) => {
  const visibleTextMatches = renderer.root.findAll(
    (node) => node.type === 'button' && textContent(node).includes(text),
  );
  return visibleTextMatches.length > 0
    ? visibleTextMatches
    : renderer.root.findAll((node) => (
      node.type === 'button' && String(node.props?.['aria-label'] || '').includes(text)
    ));
};

const findButton = (renderer: ReactTestRenderer, text: string) => findButtons(renderer, text)[0];

const findResultMessageTextarea = (renderer: ReactTestRenderer, mode: 'compact' | 'full' = 'full') =>
  renderer.root.find((node) =>
    node.type === 'textarea' && node.props['data-query-result-message-textarea'] === mode,
  );

const findByClassName = (renderer: ReactTestRenderer, className: string) =>
  renderer.root.find((node) =>
    typeof node.props?.className === 'string' && node.props.className.includes(className),
  );

const findEditorAction = (id: string) =>
  editorState.editor.addAction.mock.calls
    .map((call: any[]) => call[0])
    .reverse()
    .find((action: any) => action?.id === id);

const createRunShortcutEvent = () => {
  const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
  return {
    ctrlKey: !isMacRuntime,
    metaKey: isMacRuntime,
    altKey: false,
    shiftKey: false,
    key: 'Enter',
    target: null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
};

const createTab = (overrides: Partial<TabData> = {}): TabData => ({
  id: 'tab-1',
  title: 'query.sql',
  type: 'query',
  connectionId: 'conn-1',
  dbName: 'main',
  query: 'select 1;',
  ...overrides,
});

const createDefaultConnections = () => ([
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
]);

describe('QueryEditor external SQL save', () => {
  it('does not start result-tab detaching from close icons or portal menu items', () => {
    const tabContent = {
      closest: vi.fn(() => null),
    } as unknown as EventTarget;
    const closeIconSvg = {
      closest: vi.fn((selector: string) =>
        selector.includes('.query-result-tab-close') ? { className: 'query-result-tab-close' } : null),
    } as unknown as EventTarget;
    const contextMenuItem = {
      closest: vi.fn((selector: string) =>
        selector.includes('[role="menuitem"]') ? { role: 'menuitem' } : null),
    } as unknown as EventTarget;

    expect(shouldActivateResultTabDetachPointer({ button: 0, target: tabContent })).toBe(true);
    expect(shouldActivateResultTabDetachPointer({ button: 0, target: closeIconSvg })).toBe(false);
    expect(shouldActivateResultTabDetachPointer({ button: 0, target: contextMenuItem })).toBe(false);
    expect(shouldActivateResultTabDetachPointer({ button: 2, target: tabContent })).toBe(false);
  });

  it('closes the active result tab without capturing a close-icon pointer', async () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const onCloseResult = vi.fn();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <QueryEditorResultsPanel
          resultSets={[{
            key: 'result-1',
            sql: 'select 1',
            rows: [{ value: 1 }],
            columns: ['value'],
            pkColumns: [],
            readOnly: true,
          }]}
          activeResultKey="result-1"
          isActive
          loading={false}
          executionError=""
          sqlLogCount={1}
          darkMode={false}
          isV2Ui
          currentDb="main"
          currentConnectionId="conn-1"
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={onCloseResult}
          onCloseOtherResultTabs={vi.fn()}
          onCloseResultTabsToLeft={vi.fn()}
          onCloseResultTabsToRight={vi.fn()}
          onCloseAllResultTabs={vi.fn()}
          onResultPinnedChange={vi.fn()}
          onOpenResultInWindow={vi.fn()}
          onReloadResult={vi.fn()}
          onResultPageChange={vi.fn()}
          onResultSort={vi.fn()}
          onDiagnoseExecutionError={vi.fn()}
        />,
      );
    });

    const resultTabLabel = renderer.root.findAll((node) =>
      typeof node.props?.onPointerDown === 'function'
      && String(node.props?.className || '').split(/\s+/).includes('query-result-tab-label'),
    )[0];
    const closeButton = findByClassName(renderer, 'query-result-tab-close');
    const closeIconSvg = {
      closest: vi.fn((selector: string) =>
        selector.includes('.query-result-tab-close') ? { className: 'query-result-tab-close' } : null),
    } as unknown as EventTarget;
    const setPointerCapture = vi.fn();

    resultTabLabel.props.onPointerDown({
      button: 0,
      isPrimary: true,
      target: closeIconSvg,
      currentTarget: { setPointerCapture },
    });
    expect(setPointerCapture).not.toHaveBeenCalled();

    const pointerStopPropagation = vi.fn();
    closeButton.props.onPointerDown({ stopPropagation: pointerStopPropagation });
    expect(pointerStopPropagation).toHaveBeenCalledOnce();

    closeButton.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onCloseResult).toHaveBeenCalledWith('result-1');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('closes non-log result tabs with the middle mouse button and leaves the log tab unchanged', async () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const onCloseResult = vi.fn();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <QueryEditorResultsPanel
          resultSets={[{
            key: 'result-1',
            sql: 'select 1',
            rows: [{ value: 1 }],
            columns: ['value'],
            pkColumns: [],
            readOnly: true,
          }]}
          activeResultKey="result-1"
          isActive
          loading={false}
          executionError=""
          sqlLogCount={1}
          darkMode={false}
          isV2Ui
          currentDb="main"
          currentConnectionId="conn-1"
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={onCloseResult}
          onCloseOtherResultTabs={vi.fn()}
          onCloseResultTabsToLeft={vi.fn()}
          onCloseResultTabsToRight={vi.fn()}
          onCloseAllResultTabs={vi.fn()}
          onResultPinnedChange={vi.fn()}
          onReloadResult={vi.fn()}
          onResultPageChange={vi.fn()}
          onResultSort={vi.fn()}
          onDiagnoseExecutionError={vi.fn()}
        />,
      );
    });

    const resultTabLabel = renderer.root.findAll((node) =>
      typeof node.props?.onPointerDown === 'function'
      && String(node.props?.className || '').split(/\s+/).includes('query-result-tab-label'),
    )[0];
    const logTabLabel = renderer.root.findAll((node) =>
      typeof node.props?.onPointerDown !== 'function'
      && String(node.props?.className || '').split(/\s+/).includes('query-result-tab-label'),
    )[0];
    expect(resultTabLabel.props.onMouseDown).toEqual(expect.any(Function));
    expect(resultTabLabel.props.onAuxClick).toEqual(expect.any(Function));
    expect(logTabLabel.props.onMouseDown).toBeUndefined();
    expect(logTabLabel.props.onAuxClick).toBeUndefined();

    const mouseDownEvent = { button: 1, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    resultTabLabel.props.onMouseDown(mouseDownEvent);
    expect(mouseDownEvent.preventDefault).toHaveBeenCalledOnce();
    expect(mouseDownEvent.stopPropagation).toHaveBeenCalledOnce();
    expect(onCloseResult).not.toHaveBeenCalled();

    const auxClickEvent = { button: 1, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    resultTabLabel.props.onAuxClick(auxClickEvent);
    expect(auxClickEvent.preventDefault).toHaveBeenCalledOnce();
    expect(auxClickEvent.stopPropagation).toHaveBeenCalledOnce();
    expect(onCloseResult).toHaveBeenCalledWith('result-1');

    const rightAuxClickEvent = { button: 2, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    resultTabLabel.props.onAuxClick(rightAuxClickEvent);
    expect(rightAuxClickEvent.preventDefault).not.toHaveBeenCalled();
    expect(rightAuxClickEvent.stopPropagation).not.toHaveBeenCalled();
    expect(onCloseResult).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('passes the current keyword case to the format menu selection', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    expect(renderer.root.findByType(QueryEditorToolbar).props.formatSettingsSelectedKeys).toEqual(['upper']);

    await act(async () => {
      storeState.sqlFormatOptions = { keywordCase: 'lower' };
      notifyStoreSubscribers();
    });
    expect(renderer.root.findByType(QueryEditorToolbar).props.formatSettingsSelectedKeys).toEqual(['lower']);
    renderer.unmount();
  });

  beforeEach(() => {
    const completionState = (globalThis as any).__gonaviSqlCompletionState;
    if (completionState) {
      completionState.registered = false;
      completionState.disposables = [];
    }
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      setTimeout,
      clearTimeout,
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
      innerHeight: 900,
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Vitest',
    });
    setCurrentLanguage('zh-CN');
    storeState.languagePreference = 'zh-CN';
    storeState.shortcutOptions.runQuery.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.runQuery.windows = { enabled: false, combo: '' };
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: false, combo: '' };
    storeState.shortcutOptions.saveQuery.mac = { enabled: true, combo: 'Meta+S' };
    storeState.shortcutOptions.saveQuery.windows = { enabled: true, combo: 'Ctrl+S' };
    storeState.addTab.mockReset();
    storeState.setActiveContext.mockReset();
    storeState.saveQuery.mockReset();
    storeState.saveQuery.mockImplementation(async (query: SavedQuery) => query);
    storeState.savedQueries = [];
    storeState.sqlFormatOptions = { keywordCase: 'upper' };
    storeState.activeTabId = 'tab-1';
    storeState.aiPanelVisible = false;
    storeState.setAIPanelVisible.mockReset();
    storeState.queryOptions = {
      maxRows: 5000,
      showColumnComment: true,
      showColumnType: true,
      showQueryResultsPanel: false,
    };
    storeState.sqlEditorTransactionOptions = {
      commitMode: 'manual',
      autoCommitDelayMs: 0,
    };
    storeState.shortcutOptions = {
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
    };
    storeState.setQueryOptions.mockReset();
    storeState.setQueryOptions.mockImplementation((options: Record<string, unknown>) => {
      storeState.queryOptions = { ...storeState.queryOptions, ...options };
    });
    storeState.setSqlEditorTransactionOptions.mockReset();
    storeState.setSqlEditorTransactionOptions.mockImplementation((options: Record<string, unknown>) => {
      storeState.sqlEditorTransactionOptions = { ...storeState.sqlEditorTransactionOptions, ...options };
    });
    storeState.sqlEditorPendingTransactions = {};
    storeState.setSqlEditorPendingTransaction.mockReset();
    storeState.setSqlEditorPendingTransaction.mockImplementation((tabId: string, transaction: unknown) => {
      if (!transaction) {
        delete storeState.sqlEditorPendingTransactions[tabId];
        return;
      }
      storeState.sqlEditorPendingTransactions[tabId] = transaction;
    });
    Object.values(backendApp).forEach((fn) => fn.mockReset());
    nativeDetachedWindowState.openNativeQueryResultWindow.mockReset();
    nativeDetachedWindowState.openNativeQueryResultWindow.mockResolvedValue(false);
    messageApi.success.mockReset();
    messageApi.error.mockReset();
    messageApi.info.mockReset();
    messageApi.warning.mockReset();
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });
    backendApp.WriteSQLFile.mockResolvedValue({ success: true });
    backendApp.ExportSQLFile.mockResolvedValue({ success: true });
    backendApp.DBQueryWithCancel.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryMulti.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryMultiTransactional.mockResolvedValue({ success: true, data: [] });
    backendApp.DBCommitTransaction.mockResolvedValue({ success: true, message: '事务已提交' });
    backendApp.DBCommitTransactionWithTrigger.mockResolvedValue({ success: true, message: '事务已提交' });
    backendApp.DBRollbackTransaction.mockResolvedValue({ success: true, message: '事务已回滚' });
    backendApp.DBRollbackTransactionWithTrigger.mockResolvedValue({ success: true, message: '事务已回滚' });
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetIndexes.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBTableExists.mockResolvedValue({ success: true, data: { exists: true } });
    backendApp.GenerateQueryID.mockResolvedValue('query-1');
    storeState.connections = createDefaultConnections();
    storeState.sqlLogs = [];
    storeState.clearSqlLogs.mockReset();
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    storeState.fontSize = 14;
    storeState.appearance.uiVersion = 'legacy';
    storeState.appearance.customMonoFontFamily = null;
    storeState.appearance.dataTableFontSize = null;
    storeState.appearance.dataTableFontSizeFollowGlobal = true;
    storeState.appearance.sqlEditorFontSize = null;
    storeState.appearance.sqlEditorFontSizeFollowGlobal = true;
    autoFetchState.visible = false;
    dataGridState.latestProps = null;
    tabsState.activeKey = undefined;
    editorState.value = '';
    editorState.position = { lineNumber: 1, column: 1 };
    editorState.selection = null;
    editorState.domNode.style.cursor = '';
    editorState.providers = [];
    editorState.hoverProviders = [];
    editorState.contentChangeListeners = [];
    editorState.cursorPositionListeners = [];
    editorState.modelContentListeners = [];
    editorState.keyDownListeners = [];
    editorState.mouseMoveListeners = [];
    editorState.mouseDownListeners = [];
    editorState.mouseLeaveListeners = [];
    editorState.hasTextFocus = true;
    editorState.decorationIds = [];
    editorState.contentHoverCalls = [];
    editorState.latestOnChange = null;
    editorState.latestOptions = null;
    editorState.editor.getValue.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();
    editorState.editor.setValue.mockClear();
    editorState.editor.executeEdits.mockClear();
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.updateOptions.mockClear();
    editorState.editor.pushUndoStop.mockClear();
    editorState.editor.addAction.mockClear();
    storeState.updateQueryTabDraft.mockReset();
    storeSubscribers.clear();
    editorState.editor.layout.mockClear();
    clearQueryTabDraft('tab-1');
    clearQueryTabDraft('tab-2');
    clearSQLFileTabDraft('tab-1');
    clearSQLFileTabDraft('tab-2');
  });

  afterEach(() => {
    act(() => {
      [...mountedRenderers].forEach((renderer) => renderer.unmount());
    });
    clearQueryEditorResultSession('tab-1');
    clearQueryEditorResultSession('tab-2');
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps Oracle anonymous PL/SQL blocks intact when running from the editor', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-oracle-block',
      transactionPending: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });
    const plsql = [
      'BEGIN',
      "    INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');",
      "    UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';",
      "    DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';",
      'END;',
    ].join('\n');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: plsql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(expect.anything(), 'ORCLPDB1', plsql, 'query-1');
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-oracle-block',
      dbType: 'oracle',
      statements: [plsql],
    });
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: plsql,
      status: 'success',
    }));
    renderer?.unmount();
  });

  it('runs a connection-scoped SQLite query without requiring a database name', async () => {
    storeState.connections[0].config.type = 'sqlite';
    storeState.connections[0].config.database = '';
    const sql = 'SELECT id FROM users';
    editorState.value = sql;
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['id'], rows: [{ id: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: '', query: sql })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sqlite' }),
      '',
      `${sql} LIMIT 5000`,
      'query-1',
    );
    renderer.unmount();
  });

  it('executes a long commented Oracle anonymous block without blocking the UI thread', async () => {
    storeState.appearance.uiVersion = 'v2';
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    const columns = Array.from(
      { length: 42 },
      (_, index) => `                column_${index + 1} VARCHAR2(100) DEFAULT 'value_${index + 1}'`,
    ).join(',\n');
    const sql = [
      '-- ------------------------------------------------------------',
      '-- Long Oracle anonymous setup block',
      '-- ------------------------------------------------------------',
      'DECLARE',
      '    v_cnt NUMBER;',
      'BEGIN',
      '    SELECT COUNT(1) INTO v_cnt',
      '      FROM user_tables',
      "     WHERE table_name = 'GONAVI_REPRO_TABLE';",
      '    IF v_cnt = 0 THEN',
      "        EXECUTE IMMEDIATE '\n            CREATE TABLE gonavi_repro_table (\n" + columns + "\n            )\n        ';",
      '    END IF;',
      'END;',
      '/',
    ].join('\n');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: Array.from({ length: 52 }, (_, index) => ({
        statementIndex: index + 1,
        columns: ['affectedRows'],
        rows: [{ affectedRows: 0 }],
      })),
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: sql })} />);
    });

    const runButton = findByClassName(renderer, 'gn-v2-query-toolbar-run-action');
    await act(async () => {
      await runButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const resultTabs = renderer.root.findAll((node) =>
      node.type === 'button' && String(node.props?.['data-tab-key'] || '').startsWith('result-'),
    );

    expect(backendApp.DBQueryMulti).toHaveBeenCalledOnce();
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBGetIndexes).not.toHaveBeenCalled();
    expect(resultTabs).toHaveLength(52);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('runs the whole Oracle procedure when the cursor is in the exception tail', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });
    const plsql = [
      '-- 修改函数/存储过程：H2.cproc_tzhssr_order2sale_A1',
      '-- 请确认语法兼容当前数据库后执行',
      'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(',
      '  p_sourceid IN VARCHAR2,',
      '  p_msg_out OUT NVARCHAR2',
      ') AS',
      '  v_ecnt NUMBER;',
      '  CURSOR cur_ware IS',
      '    SELECT d.goodsid',
      '    FROM t_order_d d',
      '    ORDER BY CASE',
      "      WHEN d.goodsqty > 0 THEN '1'",
      "      ELSE '2'",
      '    END, d.goodsid;',
      'BEGIN',
      '  FOR row_ware IN cur_ware LOOP',
      '    IF row_ware.goodsid IS NOT NULL THEN',
      '      BEGIN',
      '        SELECT COUNT(*) INTO v_ecnt FROM dual;',
      '      EXCEPTION',
      '        WHEN no_data_found THEN',
      '          v_ecnt := 0;',
      '      END;',
      '    END IF;',
      '  END LOOP;',
      "  p_msg_out := '';",
      'EXCEPTION',
      '  WHEN OTHERS THEN',
      "    p_msg_out := substr('订单核销失败，错误信息：' || SQLERRM || '，错误位置：' ||",
      '                        dbms_utility.format_error_backtrace, 1, 1000);',
      'END cproc_tzhssr_order2sale_A1;',
      '/;',
    ].join('\n');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: plsql, queryMode: 'object-edit' })} />);
    });

    const tailLine = plsql.split('\n').findIndex((line) => line.includes('p_msg_out := substr')) + 1;
    editorState.position = { lineNumber: tailLine, column: 5 };
    editorState.selection = {
      startLineNumber: tailLine,
      startColumn: 5,
      endLineNumber: tailLine,
      endColumn: 5,
      positionLineNumber: tailLine,
      positionColumn: 5,
    };

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1');
    expect(executedSql).toContain('p_msg_out OUT NVARCHAR2');
    expect(executedSql).toContain('p_msg_out := substr');
    expect(executedSql).not.toBe(plsql.split('\n').slice(tailLine - 1).join('\n'));
    expect(executedSql).not.toContain('/;');
    renderer?.unmount();
  });

  it('runs the preceding Oracle procedure when the cursor is on the SQLPlus slash delimiter', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });
    const plsql = [
      'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(',
      '  p_sourceid IN VARCHAR2,',
      '  p_msg_out OUT NVARCHAR2',
      ') AS',
      'BEGIN',
      "  p_msg_out := '';",
      'EXCEPTION',
      '  WHEN OTHERS THEN',
      '    p_msg_out := SQLERRM;',
      'END cproc_tzhssr_order2sale_A1;',
      '/;',
    ].join('\n');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: plsql, queryMode: 'object-edit' })} />);
    });

    const slashLine = plsql.split('\n').findIndex((line) => line.startsWith('/')) + 1;
    editorState.position = { lineNumber: slashLine, column: 1 };
    editorState.selection = {
      startLineNumber: slashLine,
      startColumn: 1,
      endLineNumber: slashLine,
      endColumn: 1,
      positionLineNumber: slashLine,
      positionColumn: 1,
    };

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1');
    expect(executedSql).toContain('p_msg_out OUT NVARCHAR2');
    expect(executedSql).toContain('END cproc_tzhssr_order2sale_A1;');
    expect(executedSql).not.toContain('/;');
    renderer?.unmount();
  });

  it('renders result grid for sqlserver exec statements that return rows', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['SPID', 'STATUS'], rows: [{ SPID: 52, STATUS: 'RUNNABLE' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'EXEC sp_who2' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).not.toContain('影响行数：');
    expect(dataGridState.latestProps?.columnNames).toEqual(['SPID', 'STATUS']);
    expect(Array.isArray(dataGridState.latestProps?.data)).toBe(true);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ SPID: 52, STATUS: 'RUNNABLE' });
  });

  it('renders SQLite select results even when the result panel starts hidden', async () => {
    storeState.connections[0].config.type = 'sqlite';
    storeState.connections[0].config.database = 'main';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['id', 'name'], rows: [{ id: 1, name: 'SQLite row' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: "SELECT 1 AS id, 'SQLite row' AS name" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(dataGridState.latestProps?.columnNames).toEqual(['id', 'name']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ id: 1, name: 'SQLite row' });
    renderer.unmount();
  });

  it('renders standalone message result for sqlserver statistics statements', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: [],
        rows: [],
        messages: ["Table 'users'. Scan count 1, logical reads 3."],
      }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'SET STATISTICS IO ON;' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('消息 1');
    expect(findResultMessageTextarea(renderer!).props.value).toBe("Table 'users'. Scan count 1, logical reads 3.");
    expect(renderer!.root.findAll((node) => node.props?.['data-grid'] === 'true')).toHaveLength(0);
  });

  it('preserves sqlserver message indentation and blank lines after stripping mssql prefixes', () => {
    expect(normalizeQueryResultMessages([
      "mssql:     select c.queryno,'' ,left(dbo.f_vendor_class(''' + b.groupid + ''',' + colname + '),",
      "mssql:         'char','',''),'自动生成',0,isdefault,defaultoperator,defaultvalue,defaultvalue2,ishaving",
      '',
      "        where funcno = @funcno and tabname = '$vendorclass'",
    ])).toEqual([
      "    select c.queryno,'' ,left(dbo.f_vendor_class(''' + b.groupid + ''',' + colname + '),",
      "        'char','',''),'自动生成',0,isdefault,defaultoperator,defaultvalue,defaultvalue2,ishaving",
      '',
      "        where funcno = @funcno and tabname = '$vendorclass'",
    ]);
  });

  it('keeps multiple result sets from a single sqlserver statement', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: ['name'], rows: [{ name: 'master' }] },
        { statementIndex: 1, columns: ['owner'], rows: [{ owner: 'sa' }] },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'EXEC sp_helpdb' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).toContain('结果 2');
    expect(dataGridState.latestProps?.columnNames).toEqual(['name']);
  });

  it('hides redundant sqlserver affected-row status result after a query result', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        {
          columns: ['dddwno', 'dddwlist'],
          rows: [{ dddwno: '001', dddwlist: 'demo' }],
        },
        { columns: ['affectedRows'], rows: [{ affectedRows: 846 }] },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: 'select * from c_dddw' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer!.toJSON());
    expect(rendered).toContain('结果 1');
    expect(rendered).not.toContain('结果 2');
    expect(rendered).not.toContain('影响行数：846');
    expect(dataGridState.latestProps?.columnNames).toEqual(['dddwno', 'dddwlist']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ dddwno: '001', dddwlist: 'demo' });
    expect(messageApi.success).toHaveBeenCalledWith('已执行完成，生成 1 个结果集。');
  });

  it('hides redundant sqlserver affected-row status results for every statement in a batch', async () => {
    storeState.appearance.uiVersion = 'v2';
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: ['value'], rows: [{ value: 1 }] },
        { statementIndex: 1, columns: ['affectedRows'], rows: [{ affectedRows: 1 }] },
        { statementIndex: 2, columns: ['value'], rows: [{ value: 2 }] },
        { statementIndex: 2, columns: ['affectedRows'], rows: [{ affectedRows: 1 }] },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'SELECT 1;\nSELECT 2;' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer!.toJSON());
    expect(rendered).toContain('结果 1');
    expect(rendered).toContain('结果 2');
    expect(rendered).not.toContain('结果 3');
    expect(rendered).not.toContain('结果 4');
    expect(rendered).not.toContain('影响行数：1');
    expect(messageApi.success).toHaveBeenCalledWith('已执行完成，生成 2 个结果集。');

    const resultTabButtons = renderer!.root.findAll((node) =>
      node.type === 'button' && String(node.props['data-tab-key'] || '').startsWith('result-'));
    expect(resultTabButtons).toHaveLength(2);

    await act(async () => {
      resultTabButtons[1].props.onClick();
    });

    expect(dataGridState.latestProps?.columnNames).toEqual(['value']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ value: 2 });
  });

  it('prefers the first displayable sqlserver procedure result when empty result sets are returned', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: [], rows: [] },
        {
          statementIndex: 1,
          columns: ['insert_sql'],
          rows: [
            { insert_sql: "insert into c_user(userid) values('168')" },
            { insert_sql: "insert into c_user(userid) values('169')" },
          ],
        },
        { statementIndex: 1, columns: [], rows: [] },
        { statementIndex: 1, columns: [], rows: [] },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: "p_get_select 'c_user','userid = ''168''',1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('结果 4');
    expect(dataGridState.latestProps?.columnNames).toEqual(['insert_sql']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({
      insert_sql: "insert into c_user(userid) values('168')",
    });
  });

  it('prefers concrete sqlserver procedure rows over affected-row status results', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: ['affectedRows'], rows: [{ affectedRows: 0 }] },
        { statementIndex: 1, columns: [], rows: [] },
        {
          statementIndex: 1,
          columns: ['insert_sql'],
          rows: [
            { insert_sql: "insert into c_user(userid) values('168')" },
          ],
        },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: "p_get_select 'c_user','userid = ''168''',1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.columnNames).toEqual(['insert_sql']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({
      insert_sql: "insert into c_user(userid) values('168')",
    });
    expect(textContent(renderer!.toJSON())).not.toContain('影响行数：0');
  });

  it('shows the data result tab in V2 when the SQL log tab is already visible', async () => {
    storeState.appearance.uiVersion = 'v2';
    storeState.sqlLogs = [{
      id: 'log-existing',
      timestamp: Date.now(),
      sql: 'SELECT * FROM ldf_server.mes_work_order',
      status: 'success',
      duration: 120,
    }];
    storeState.connections[0].config.type = 'kingbase';
    storeState.connections[0].config.database = 'ldf_server_dbs_dev';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        statementIndex: 1,
        columns: ['work_order'],
        rows: [{ work_order: 'MO-20260629' }],
      }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'ldf_server_dbs_dev',
        query: 'SELECT * FROM ldf_server.mes_work_order;',
        resultPanelVisible: true,
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer!.toJSON());
    expect(rendered).toContain('日志');
    expect(rendered).toContain('结果 1');
    expect(dataGridState.latestProps?.columnNames).toEqual(['work_order']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ work_order: 'MO-20260629' });
  });

  it('prefers sqlserver print output messages over affected-row status results', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: ['affectedRows'], rows: [{ affectedRows: 0 }] },
        {
          statementIndex: 1,
          columns: [],
          rows: [],
          messages: [
            "insert into c_dyscript(projectid,name) values (1,'demo')",
            "insert into c_dyscript(projectid,name) values (2,'next')",
          ],
        },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: "p_get_select c_dyscript,'projectid = 1',1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('消息 1');
    expect(findResultMessageTextarea(renderer!).props.value).toBe([
      "insert into c_dyscript(projectid,name) values (1,'demo')",
      "insert into c_dyscript(projectid,name) values (2,'next')",
    ].join('\n'));
    expect(textContent(renderer!.toJSON())).not.toContain('影响行数：0');
    expect(dataGridState.latestProps).toBeNull();
  });

  it('preserves sqlserver message indentation in the rendered result message textarea', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        {
          statementIndex: 1,
          columns: [],
          rows: [],
          messages: [
            "mssql:     select c.queryno,'' ,left(dbo.f_vendor_class(''' + b.groupid + ''',' + colname + '),",
            "mssql:         'char','',''),'自动生成',0,isdefault,defaultoperator,defaultvalue,defaultvalue2,ishaving",
            '',
            "        where funcno = @funcno and tabname = '$vendorclass'",
          ],
        },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: "sp_sql p_get_query" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer!.toJSON());
    const messageTextarea = findResultMessageTextarea(renderer!);
    const messageBlock = findByClassName(renderer!, 'query-result-message-block');
    const messageScrollBody = findByClassName(renderer!, 'query-result-message-scroll-body');
    expect(rendered).toContain('消息 1');
    expect(messageTextarea.props.value).toBe([
      "    select c.queryno,'' ,left(dbo.f_vendor_class(''' + b.groupid + ''',' + colname + '),",
      "        'char','',''),'自动生成',0,isdefault,defaultoperator,defaultvalue,defaultvalue2,ishaving",
      '',
      "        where funcno = @funcno and tabname = '$vendorclass'",
    ].join('\n'));
    expect(messageTextarea.props.wrap).toBe('off');
    expect(messageTextarea.props.style).toMatchObject({
      display: 'block',
      whiteSpace: 'pre',
      overflow: 'auto',
      width: '100%',
      minWidth: 0,
      padding: '10px 12px',
    });
    expect(messageTextarea.props.style.padding).not.toBe(0);
    expect(messageTextarea.props.style.minWidth).not.toBe('max-content');
    expect(messageBlock.props.style).toMatchObject({
      alignItems: 'stretch',
      width: '100%',
    });
    expect(messageScrollBody.props.style).toMatchObject({
      display: 'flex',
      alignItems: 'stretch',
      width: '100%',
      overflow: 'hidden',
      minWidth: 0,
      borderRadius: 6,
    });
    expect(messageScrollBody.props.style.border).toContain('1px solid');
    expect(messageScrollBody.props.style.background).toBeTruthy();
    expect(messageTextarea.props.value).not.toContain('mssql:');
  });

  it('renders top-level sqlserver print messages when result sets contain only status rows', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'hydee';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { statementIndex: 1, columns: ['affectedRows'], rows: [{ affectedRows: 0 }] },
      ],
      messages: [
        "insert into c_dyscript(projectid,name) values (1,'demo')",
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'hydee', query: "p_get_select c_dyscript,'projectid = 1',1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('消息 1');
    expect(findResultMessageTextarea(renderer!).props.value).toBe("insert into c_dyscript(projectid,name) values (1,'demo')");
    expect(textContent(renderer!.toJSON())).not.toContain('影响行数：0');
    expect(dataGridState.latestProps).toBeNull();
  });

  it('keeps both tabs when rerunning the same single sqlserver statement with multiple result sets', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { statementIndex: 1, columns: ['name'], rows: [{ name: 'master' }] },
          { statementIndex: 1, columns: ['owner'], rows: [{ owner: 'sa' }] },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { statementIndex: 1, columns: ['name'], rows: [{ name: 'tempdb' }] },
          { statementIndex: 1, columns: ['owner'], rows: [{ owner: 'dbo' }] },
        ],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'EXEC sp_helpdb' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const tabLabels = renderer!.root.findAll((node) => {
      const className = String(node.props?.className || '');
      return className.includes('query-result-tab-label');
    });
    expect(tabLabels).toHaveLength(2);
    expect(dataGridState.latestProps?.columnNames).toEqual(['name']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ name: 'tempdb' });
  });

  it('reloads the active secondary result set for a single sqlserver statement', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    storeState.connections[0].config.database = 'master';
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { statementIndex: 1, columns: ['name'], rows: [{ name: 'master' }] },
          { statementIndex: 1, columns: ['owner'], rows: [{ owner: 'sa' }] },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { statementIndex: 1, columns: ['name'], rows: [{ name: 'master' }] },
          { statementIndex: 1, columns: ['owner'], rows: [{ owner: 'dbo' }] },
        ],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'master', query: 'EXEC sp_helpdb' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const resultTabButtons = renderer!.root.findAll((node) => node.type === 'button' && node.props['data-tab-key']);
    expect(resultTabButtons).toHaveLength(2);

    await act(async () => {
      resultTabButtons[1].props.onClick();
    });

    expect(dataGridState.latestProps?.columnNames).toEqual(['owner']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ owner: 'sa' });

    await act(async () => {
      await dataGridState.latestProps?.onReload?.();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(dataGridState.latestProps?.columnNames).toEqual(['owner']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ owner: 'dbo' });
    expect(dataGridState.latestProps?.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'master' })]));
  });

  it('localizes the non-Oracle all-columns locator warning in English while preserving the raw table name', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME'], rows: [{ NAME: 'old-name' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM users' })} />);
    });

    await act(async () => {
      await findButton(renderer!, 'Run').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('users');
    expect(dataGridState.latestProps?.pkColumns).toEqual([]);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      readOnly: false,
      reason: 'No primary key or unique index was detected, so rows will be located by matching all columns. Edit with care.',
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      'Query results remain read-only: main.users No primary key or usable unique index was detected, so changes cannot be committed safely.',
    );
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      '查询结果保持只读：main.users 未检测到主键或可用唯一索引，无法安全提交修改。',
    );
  });

  it('uses all-columns editing when non-Oracle unique-index metadata is unavailable', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME'], rows: [{ NAME: 'old-name' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'NAME', key: '' }],
    });
    backendApp.DBGetIndexes.mockResolvedValueOnce({
      success: false,
      data: [],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM users' })} />);
    });

    await act(async () => {
      await findButton(renderer!, 'Run').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('users');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      'Query results remain read-only: main.users Unable to load unique index metadata, so changes cannot be committed safely.',
    );
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      '查询结果保持只读：main.users 无法加载唯一索引元数据，无法安全提交修改。',
    );
  });

  it('uses all-columns editing when non-Oracle table locator metadata is unavailable', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME'], rows: [{ NAME: 'old-name' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: false,
      data: [],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM users' })} />);
    });

    await act(async () => {
      await findButton(renderer!, 'Run').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('users');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      columns: [],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      'Query results remain read-only: Unable to load primary key/unique index metadata for main.users, so changes cannot be committed safely.',
    );
    expect(messageApi.warning).not.toHaveBeenCalledWith(
      '查询结果保持只读：无法加载 main.users 的主键/唯一索引元数据，无法安全提交修改。',
    );
  });

  it('falls back to all-columns editing when query locator metadata stalls', async () => {
    vi.useFakeTimers();
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME'], rows: [{ NAME: 'alpha' }] }],
    });
    backendApp.DBGetColumns.mockReturnValueOnce(new Promise(() => {}));
    backendApp.DBGetIndexes.mockReturnValueOnce(new Promise(() => {}));

    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM users' })} />);
      });

      await act(async () => {
        findButton(renderer!, '运行').props.onClick();
        await Promise.resolve();
      });

      expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
        expect.anything(),
        'main',
        'SELECT NAME FROM users LIMIT 5000',
        'query-1',
      );
      expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ NAME: 'alpha' });
      expect(dataGridState.latestProps?.tableName).toBe('users');
      expect(dataGridState.latestProps?.editLocator).toMatchObject({
        strategy: 'all-columns',
        readOnly: false,
      });
      expect(dataGridState.latestProps?.readOnly).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps MySQL information_schema routine results read-only without a locator warning', async () => {
    const sql = [
      'SELECT ROUTINE_SCHEMA, ROUTINE_NAME, DEFINER, SECURITY_TYPE',
      'FROM information_schema.ROUTINES',
      "WHERE ROUTINE_SCHEMA = 'mkefu_location_dev_local'",
      "  AND ROUTINE_NAME = 'init_orgi'",
    ].join('\n');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['ROUTINE_SCHEMA', 'ROUTINE_NAME', 'DEFINER', 'SECURITY_TYPE'],
        rows: [{
          ROUTINE_SCHEMA: 'mkefu_location_dev_local',
          ROUTINE_NAME: 'init_orgi',
          DEFINER: 'root@%',
          SECURITY_TYPE: 'DEFINER',
        }],
      }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'mkefu_location_dev_local', query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('ROUTINES');
    expect(dataGridState.latestProps?.readOnly).toBe(true);
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBGetIndexes).not.toHaveBeenCalled();
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('runs the SQL statement at the cursor instead of the whole editor when nothing is selected', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['two'], rows: [{ two: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as two;\nselect 3;',
      })} />);
    });

    editorState.position = { lineNumber: 2, column: 8 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.();
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as two'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining('select 2 as two'),
    }));
  });

  it('executes only the statement body when the cursor is on a semicolon after leading comments', async () => {
    const sql = [
      '-- 1856887305879470081',
      '-- 3257969823961465780',
      '-- 3257963896428446491',
      "SELECT * FROM contract WHERE contract_code = 'YEC202608039';",
    ].join('\n');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['id', 'contract_code'],
        rows: [{ id: 1, contract_code: 'YEC202608039' }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'id', key: 'PRI' }, { name: 'contract_code', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: sql })} />);
    });
    editorState.position = { lineNumber: 4, column: sql.split('\n')[3].length + 1 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.();
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti.mock.calls[0]?.[2]).toBe(
      "SELECT * FROM contract WHERE contract_code = 'YEC202608039' LIMIT 5000",
    );
    renderer!.unmount();
  });

  it('keeps cursor statement execution available in v2 UI', async () => {
    storeState.appearance.uiVersion = 'v2';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['two'], rows: [{ two: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as two;\nselect 3;',
      })} />);
    });

    editorState.position = { lineNumber: 2, column: 8 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.();
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as two'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
  });

  it('registers Windows Ctrl+R with Monaco CtrlCmd and runs the selected SQL', async () => {
    vi.stubGlobal('navigator', {
      platform: 'Win32',
      userAgent: 'Vitest',
    });
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+R' };
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn((event: Event) => {
        windowListeners[event.type]?.forEach((listener) => listener(event));
        return true;
      }),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
      innerHeight: 900,
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['total'], rows: [{ total: 1 }] }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect count(*) as total from messages;\nselect 3;',
      })} />);
    });

    editorState.selection = {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'select count(*) as total from messages'.length + 1,
    };
    const runAction = findEditorAction('gonavi.runQuery');

    await act(async () => {
      await runAction.run();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('select count(*) as total from messages'),
      'query-1',
    );
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
  });

  it('runs the cursor SQL from the run shortcut when nothing is selected', async () => {
    storeState.shortcutOptions.runQuery.mac = { enabled: true, combo: 'Meta+Enter' };
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+Enter' };
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
      innerHeight: 900,
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as two;\nselect 3;',
      })} />);
    });
    editorState.position = { lineNumber: 2, column: 8 };
    editorState.selection = null;
    editorState.cursorPositionListeners.forEach((listener) => {
      listener({ position: editorState.position });
    });
    backendApp.DBQueryMulti.mockClear();

    const event = createRunShortcutEvent();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('select 2 as two'),
      'query-1',
    );
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
  });

  it('runs selected SQL from the run shortcut', async () => {
    storeState.shortcutOptions.runQuery.mac = { enabled: true, combo: 'Meta+Enter' };
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+Enter' };
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
      innerHeight: 900,
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['two'], rows: [{ two: 2 }] }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as two;\nselect 3;',
      })} />);
    });
    editorState.position = { lineNumber: 1, column: 4 };
    editorState.selection = {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'select 2 as two'.length + 1,
    };

    const event = createRunShortcutEvent();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as two'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
  });

  it('renders the zero-count V2 SQL log tab for the active non-Chinese language', async () => {
    storeState.appearance.uiVersion = 'v2';
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ resultPanelVisible: true })} />);
    });

    const rendered = textContent(renderer!.toJSON());
    expect(rendered).toContain('Logs0');
    expect(renderer!.root.findAll((node) => node.props?.['data-log-panel'] === 'true')).toHaveLength(1);
    expect(renderer!.root.findAll((node) =>
      node.props?.['data-tab-key'] === QUERY_EDITOR_SQL_LOG_TAB_KEY,
    )).toHaveLength(1);
    expect(rendered).not.toContain('日志0');
    await act(async () => {
      renderer!.unmount();
    });
  });

  it('uses the last editor cursor position when the run button takes focus', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['two'], rows: [{ two: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\nselect 3 as c;',
      })} />);
    });

    editorState.cursorPositionListeners.forEach((listener) => {
      listener({ position: { lineNumber: 2, column: 'select 2 as b;'.length + 1 } });
    });
    editorState.hasTextFocus = false;
    editorState.position = { lineNumber: 3, column: 'select 3 as c;'.length + 1 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as b'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3 as c');
  });

  it('prefers the last editor cursor event even if Monaco still reports text focus', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['two'], rows: [{ two: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\nselect 3 as c;',
      })} />);
    });

    editorState.cursorPositionListeners.forEach((listener) => {
      listener({ position: { lineNumber: 2, column: 'select 2 as b;'.length + 1 } });
    });
    editorState.hasTextFocus = true;
    editorState.position = { lineNumber: 3, column: 'select 3 as c;'.length + 1 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as b'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3 as c');
  });

  it('uses Monaco active selection position when run button focus drifts onto a blank line', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['b'], rows: [{ b: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\n\nselect 3 as c;',
      })} />);
    });

    editorState.selection = {
      startLineNumber: 2,
      startColumn: 'select 2 as b;'.length + 1,
      endLineNumber: 2,
      endColumn: 'select 2 as b;'.length + 1,
      positionLineNumber: 2,
      positionColumn: 'select 2 as b;'.length + 1,
    };
    editorState.position = { lineNumber: 3, column: 1 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as b'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1 as a');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3 as c');
    expect(messageApi.info).not.toHaveBeenCalledWith('没有可执行的 SQL。');
  });

  it('keeps cursor statement execution when CRLF line endings put the cursor after a semicolon', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['b'], rows: [{ b: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\r\nselect 2 as b;\r\n\r\nselect 3 as c;',
      })} />);
    });

    editorState.position = { lineNumber: 2, column: 'select 2 as b;'.length + 1 };
    editorState.selection = {
      startLineNumber: 2,
      startColumn: 'select 2 as b;'.length + 1,
      endLineNumber: 2,
      endColumn: 'select 2 as b;'.length + 1,
      positionLineNumber: 2,
      positionColumn: 'select 2 as b;'.length + 1,
    };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as b'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1 as a');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3 as c');
    expect(messageApi.info).not.toHaveBeenCalledWith('没有可执行的 SQL。');
  });

  it('executes all SQL when the cursor is on a blank line', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['a'], rows: [{ a: 1 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\n\nselect 3 as c;',
      })} />);
    });

    editorState.position = { lineNumber: 1, column: 'select 1 as a;'.length + 1 };
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 'select 1 as a;'.length + 1,
      endLineNumber: 1,
      endColumn: 'select 1 as a;'.length + 1,
      positionLineNumber: 1,
      positionColumn: 'select 1 as a;'.length + 1,
    };

    await act(async () => {
      const runButton = findButton(renderer!, 'Run');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('Result 1');
    backendApp.DBQueryMulti.mockClear();
    messageApi.info.mockClear();
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['a'], rows: [{ a: 1 }] }],
    });

    editorState.position = { lineNumber: 3, column: 1 };
    editorState.selection = {
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 1,
      positionLineNumber: 3,
      positionColumn: 1,
    };
    editorState.cursorPositionListeners.forEach((listener) => {
      listener({ position: { lineNumber: 3, column: 1 } });
    });

    await act(async () => {
      const runButton = findButton(renderer!, 'Run');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('select 1 as a');
    expect(executedSql).toContain('select 2 as b');
    expect(executedSql).toContain('select 3 as c');
    expect(messageApi.info).not.toHaveBeenCalledWith('No executable SQL.');
    expect(messageApi.info).not.toHaveBeenCalledWith('没有可执行的 SQL。');
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ a: 1 })]));
  });

  it('shows "Select a database first." in English before running without a database', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: '', query: 'select 1;' })} />);
    });

    await act(async () => {
      await findButton(renderer, 'Run').props.onClick();
    });

    expect(messageApi.error).toHaveBeenCalledWith('Select a database first.');
    expect(messageApi.error).not.toHaveBeenCalledWith('请先选择数据库');
  });

  it('shows "Connection not found." in English before running without a matching connection', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    storeState.connections = [];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ connectionId: 'missing', dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      await findButton(renderer, 'Run').props.onClick();
    });

    expect(messageApi.error).toHaveBeenCalledWith('Connection not found.');
    expect(messageApi.error).not.toHaveBeenCalledWith('Connection not found');
  });

  it('shows the unsupported source guard in English before running', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    storeState.connections[0].config.type = 'redis';

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      await findButton(renderer, 'Run').props.onClick();
    });

    expect(messageApi.error).toHaveBeenCalledWith(
      'This data source does not support the SQL query editor. Use its dedicated page instead.',
    );
    expect(messageApi.error).not.toHaveBeenCalledWith('当前数据源不支持 SQL 查询编辑器，请使用对应专用页面。');
  });

  describe('execution toast localization', () => {
    it('shows the Mongo multi-statement success toast in English', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      storeState.connections[0].config.type = 'mongodb';
      const query = 'db.users.find({});\ndb.logs.find({});';
      backendApp.DBQueryWithCancel
        .mockResolvedValueOnce({ success: true, data: [{ _id: 1 }], fields: ['_id'] })
        .mockResolvedValueOnce({ success: true, data: [{ _id: 2 }], fields: ['_id'] });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 'db.logs.find({});'.length + 1,
        positionLineNumber: 2,
        positionColumn: 'db.logs.find({});'.length + 1,
      };

      await act(async () => {
        await findButton(renderer, 'Run').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(messageApi.success).toHaveBeenCalledWith('Executed 2 statements and produced 2 result sets.');
      expect(messageApi.success).not.toHaveBeenCalledWith('已执行 2 条语句，生成 2 个结果集。');
    });

    it('shows the Mongo multi-statement failure prefix localization in English', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      storeState.connections[0].config.type = 'mongodb';
      const query = 'db.users.find({});\ndb.logs.find({});';
      backendApp.DBQueryWithCancel
        .mockResolvedValueOnce({ success: true, data: [{ _id: 1 }], fields: ['_id'] })
        .mockResolvedValueOnce({ success: false, message: 'driver exploded' });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 'db.logs.find({});'.length + 1,
        positionLineNumber: 2,
        positionColumn: 'db.logs.find({});'.length + 1,
      };

      await act(async () => {
        await findButton(renderer, 'Run').props.onClick();
      });
      await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer.toJSON());
    expect(rendered).toContain(formatSqlExecutionError('driver exploded', {
      prefix: 'Statement 2 failed:',
    }));
    expect(rendered).not.toContain('第 2 条语句执行失败：driver exploded');
    });

    it('shows the Mongo zero-result success toast in English', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      storeState.connections[0].config.type = 'mongodb';
      const query = '{"ping":1}';
      backendApp.DBQueryWithCancel.mockResolvedValueOnce({ success: true, data: { ok: 1 } });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.position = { lineNumber: 1, column: query.length + 1 };

      await act(async () => {
        await findButton(renderer, 'Run').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(messageApi.success).toHaveBeenCalledWith('Execution succeeded.');
      expect(messageApi.success).not.toHaveBeenCalledWith('执行成功。');
    });

    it('shows the non-Mongo multi-result success toast in English', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      const query = 'select 1 as a; select 2 as b;';
      backendApp.DBQueryMulti.mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['a'], rows: [{ a: 1 }] },
          { columns: ['b'], rows: [{ b: 2 }] },
        ],
      });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: query.length + 1,
        positionLineNumber: 1,
        positionColumn: query.length + 1,
      };

      await act(async () => {
        const runButton = findButton(renderer, 'Run');
        runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
        await runButton.props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBQueryWithCancel).not.toHaveBeenCalled();
      expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
      expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('select 1 as a');
      expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('select 2 as b');
      expect(messageApi.success).toHaveBeenCalledWith('Execution finished and produced 2 result sets.');
      expect(messageApi.success).not.toHaveBeenCalledWith('已执行完成，生成 2 个结果集。');
    });

  it('shows the non-Mongo zero-result success toast in English', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    const query = 'update users set active = 1 where 1 = 0;';
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({ success: true, data: [] });

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: query.length + 1,
        positionLineNumber: 1,
        positionColumn: query.length + 1,
      };

      await act(async () => {
        const runButton = findButton(renderer, 'Run');
        runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
        await runButton.props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

    expect(backendApp.DBQueryWithCancel).not.toHaveBeenCalled();
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledTimes(1);
    expect(String(backendApp.DBQueryMultiTransactional.mock.calls[0][2])).toContain('update users set active = 1 where 1 = 0');
    expect(messageApi.success).toHaveBeenCalledWith('Execution succeeded.');
    expect(messageApi.success).not.toHaveBeenCalledWith('执行成功。');
  });

    it('shows the wrapped execution failure toast in English while preserving raw error detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      const query = 'select 1;';
      backendApp.DBQueryMulti.mockRejectedValueOnce(new Error('driver exploded'));

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: query.length + 1,
        positionLineNumber: 1,
        positionColumn: query.length + 1,
      };

      await act(async () => {
        const runButton = findButton(renderer, 'Run');
        runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
        await runButton.props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBQueryWithCancel).not.toHaveBeenCalled();
      expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
      expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('select 1');
      expect(messageApi.error).toHaveBeenCalledWith(`Query execution failed: ${formatSqlExecutionError('driver exploded')}`);
      expect(messageApi.error).not.toHaveBeenCalledWith('Error executing query: driver exploded');
    });
  });

  describe('result refresh toast localization', () => {
    const renderAndRunQuery = async (query: string) => {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
      });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: query.length + 1,
        positionLineNumber: 1,
        positionColumn: query.length + 1,
      };

      await act(async () => {
        const runButton = findButton(renderer, 'Run');
        runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
        await runButton.props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(dataGridState.latestProps?.onReload).toEqual(expect.any(Function));
    };

    it('shows the response refresh failure toast in English while preserving raw error detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      const query = 'select 1 as a;';
      backendApp.DBQueryMulti
        .mockResolvedValueOnce({
          success: true,
          data: [{ columns: ['a'], rows: [{ a: 1 }] }],
        })
        .mockResolvedValueOnce({ success: false, message: 'network down' });

      await renderAndRunQuery(query);
      messageApi.error.mockClear();

      await act(async () => {
        await dataGridState.latestProps.onReload();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(messageApi.error).toHaveBeenCalledWith(`Refresh failed: ${formatSqlExecutionError('network down')}`);
      expect(messageApi.error).not.toHaveBeenCalledWith('刷新失败: network down');
    });

    it('shows the rejected refresh failure toast in English while preserving raw error detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      const query = 'select 1 as a;';
      backendApp.DBQueryMulti
        .mockResolvedValueOnce({
          success: true,
          data: [{ columns: ['a'], rows: [{ a: 1 }] }],
        })
        .mockRejectedValueOnce(new Error('socket closed'));

      await renderAndRunQuery(query);
      messageApi.error.mockClear();

      await act(async () => {
        await dataGridState.latestProps.onReload();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(messageApi.error).toHaveBeenCalledWith(`Refresh failed: ${formatSqlExecutionError('socket closed')}`);
      expect(messageApi.error).not.toHaveBeenCalledWith('刷新失败: socket closed');
    });
  });

  it('cancels the pending run before a query id exists', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    let resolveQueryId!: (queryId: string) => void;
    backendApp.GenerateQueryID.mockReturnValueOnce(new Promise((resolve) => {
      resolveQueryId = resolve;
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      findButton(renderer, 'Run').props.onClick();
      await Promise.resolve();
    });

    await act(async () => {
      await findButton(renderer, 'Stop').props.onClick();
    });

    expect(messageApi.success).toHaveBeenCalledWith('Query canceled.');
    expect(messageApi.warning).not.toHaveBeenCalledWith('No running query to cancel.');
    expect(findButtons(renderer, 'Stop')).toHaveLength(0);

    await act(async () => {
      resolveQueryId('query-too-late');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
  });

  it('shows "Query canceled." in English when stop cancels a running query', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    backendApp.GenerateQueryID.mockResolvedValueOnce('query-1');
    backendApp.DBQueryMulti.mockReturnValueOnce(new Promise(() => {}));
    backendApp.CancelQuery.mockResolvedValueOnce({ success: true });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      findButton(renderer, 'Run').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await findButton(renderer, 'Stop').props.onClick();
    });

    expect(messageApi.success).toHaveBeenCalledWith('Query canceled.');
    expect(messageApi.success).not.toHaveBeenCalledWith('查询已取消');
    expect(findButtons(renderer, 'Stop')).toHaveLength(0);
  });

  it('keeps the newer query cancellable when the previous run finishes late', async () => {
    let resolvePreviousQuery!: (value: unknown) => void;
    const previousQuery = new Promise((resolve) => {
      resolvePreviousQuery = resolve;
    });
    const currentQuery = new Promise(() => {});

    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-previous')
      .mockResolvedValueOnce('query-current');
    backendApp.DBQueryMulti
      .mockReturnValueOnce(previousQuery)
      .mockReturnValueOnce(currentQuery);
    backendApp.CancelQuery.mockResolvedValue({ success: true });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      void findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);

    await act(async () => {
      void findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(backendApp.CancelQuery).toHaveBeenCalledWith('query-previous');

    await act(async () => {
      resolvePreviousQuery({ success: false, message: 'context canceled' });
      await Promise.resolve();
      await Promise.resolve();
    });

    backendApp.CancelQuery.mockClear();
    messageApi.warning.mockClear();
    await act(async () => {
      await findButton(renderer, '停止').props.onClick();
    });

    expect(backendApp.CancelQuery).toHaveBeenCalledWith('query-current');
    expect(messageApi.warning).not.toHaveBeenCalledWith('没有正在运行的查询可取消。');
  });

  it('does not start a replacement run after stop cancels it while the previous query cancellation is pending', async () => {
    let resolveReplacementCancel!: (value: { success: boolean }) => void;
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-previous')
      .mockResolvedValueOnce('query-replacement');
    backendApp.DBQueryMulti
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({ success: true, data: [] });
    backendApp.CancelQuery
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveReplacementCancel = resolve;
      }))
      .mockResolvedValueOnce({ success: true });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      void findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);

    await act(async () => {
      void findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.CancelQuery).toHaveBeenCalledTimes(1);

    await act(async () => {
      await findButton(renderer, '停止').props.onClick();
    });
    expect(findButtons(renderer, '停止')).toHaveLength(0);

    await act(async () => {
      resolveReplacementCancel({ success: true });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.GenerateQueryID).toHaveBeenCalledTimes(1);
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending result refresh before its query id exists', async () => {
    let resolveRefreshQueryId!: (queryId: string) => void;
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-initial')
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveRefreshQueryId = resolve;
      }));
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['value'], rows: [{ value: 1 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['value'], rows: [{ value: 2 }] }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1 as value;' })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.onReload).toEqual(expect.any(Function));

    await act(async () => {
      void dataGridState.latestProps.onReload();
      await Promise.resolve();
    });
    await act(async () => {
      await findButton(renderer, '停止').props.onClick();
    });

    await act(async () => {
      resolveRefreshQueryId('query-refresh-too-late');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageApi.success).toHaveBeenCalledWith('查询已中止。');
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending page query before its query id exists', async () => {
    storeState.queryOptions.maxRows = 2;
    let resolvePageQueryId!: (queryId: string) => void;
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-initial')
      .mockReturnValueOnce(new Promise((resolve) => {
        resolvePageQueryId = resolve;
      }));
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['value'], rows: [{ value: 1 }, { value: 2 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['value'], rows: [{ value: 3 }] }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select value from items;' })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.onPageChange).toEqual(expect.any(Function));

    await act(async () => {
      void dataGridState.latestProps.onPageChange(2, 2);
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.loading).toBe(true);
    await act(async () => {
      await findButton(renderer, '停止').props.onClick();
    });
    expect(dataGridState.latestProps?.loading).toBe(false);

    await act(async () => {
      resolvePageQueryId('query-page-too-late');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageApi.success).toHaveBeenCalledWith('查询已中止。');
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);
  });

  it('cancels a Mongo multi-statement run between statement query ids', async () => {
    storeState.connections[0].config.type = 'mongodb';
    const query = 'db.users.find({});\ndb.logs.find({});';
    let resolveSecondQueryId!: (queryId: string) => void;
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-mongo-first')
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveSecondQueryId = resolve;
      }));
    backendApp.DBQueryWithCancel
      .mockResolvedValueOnce({ success: true, data: [{ _id: 1 }], fields: ['_id'] })
      .mockResolvedValueOnce({ success: true, data: [{ _id: 2 }], fields: ['_id'] });
    backendApp.CancelQuery.mockResolvedValue({ success: false, message: 'query already completed' });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
    });
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'db.logs.find({});'.length + 1,
      positionLineNumber: 2,
      positionColumn: 'db.logs.find({});'.length + 1,
    };

    await act(async () => {
      void findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.GenerateQueryID).toHaveBeenCalledTimes(2);
    expect(backendApp.DBQueryWithCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      await findButton(renderer, '停止').props.onClick();
    });
    await act(async () => {
      resolveSecondQueryId('query-mongo-too-late');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageApi.success).toHaveBeenCalledWith('查询已中止。');
    expect(backendApp.CancelQuery).not.toHaveBeenCalled();
    expect(backendApp.DBQueryWithCancel).toHaveBeenCalledTimes(1);
  });

  it('shows "Failed to cancel query" in English while preserving the raw error detail', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    backendApp.GenerateQueryID.mockResolvedValueOnce('query-1');
    backendApp.DBQueryMulti.mockReturnValueOnce(new Promise(() => {}));
    backendApp.CancelQuery.mockRejectedValueOnce(new Error('network down'));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
    });

    await act(async () => {
      findButton(renderer, 'Run').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await findButton(renderer, 'Stop').props.onClick();
    });

    expect(messageApi.error).toHaveBeenCalledWith('Failed to cancel query: network down');
    expect(messageApi.error).not.toHaveBeenCalledWith('取消查询失败: network down');
  });

  it('runs only appended SQL and keeps existing results after a full editor execution', async () => {
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 1 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['b'], rows: [{ b: 2 }] }],
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;',
      })} />);
    });

    editorState.position = { lineNumber: 1, column: 'select 1 as a;'.length + 1 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.value = 'select 1 as a;\nselect 2 as b;';
    editorState.position = { lineNumber: 2, column: 'select 2 as b;'.length + 1 };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('select 1 as a');
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).toContain('select 2 as b');
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).not.toContain('select 1 as a');
    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).toContain('结果 2');
    expect(renderer!.root.findAll((node) => {
      const className = String(node.props?.className || '');
      return className.includes('query-result-tab-count') && textContent(node) === '1';
    })).toHaveLength(2);
  });

  it('replaces existing result tabs when rerunning the same formatted SQL', async () => {
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: [{ id: 1 }, { id: 2 }, { id: 3 }] },
          { columns: ['id'], rows: Array.from({ length: 10 }, (_, index) => ({ id: index + 1 })) },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: [{ id: 11 }, { id: 12 }, { id: 13 }] },
          { columns: ['id'], rows: Array.from({ length: 10 }, (_, index) => ({ id: index + 11 })) },
        ],
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'SELECT * FROM fs_org_auth_application;\nSELECT * FROM fs_bcp_auth_info;',
      })} />);
    });

    editorState.position = { lineNumber: 1, column: 'SELECT * FROM fs_org_auth_application;'.length + 1 };
    editorState.selection = null;

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).toContain('结果 2');

    editorState.value = [
      'SELECT',
      '    *',
      'FROM',
      '    fs_org_auth_application;',
      '',
      'SELECT',
      '    *',
      'FROM',
      '    fs_bcp_auth_info;',
    ].join('\n');
    editorState.position = { lineNumber: 4, column: '    fs_org_auth_application;'.length + 1 };
    editorState.selection = null;

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).toContain('结果 2');
    expect(textContent(renderer!.toJSON())).not.toContain('结果 3');
    expect(textContent(renderer!.toJSON())).not.toContain('结果 4');
    expect(renderer!.root.findAll((node) => {
      const className = String(node.props?.className || '');
      return className.includes('query-result-tab-label');
    })).toHaveLength(2);
  });

  it('keeps pinned result tabs across bulk close modes', () => {
    const resultSets = [
      { key: 'result-1', pinned: true },
      { key: 'result-2' },
      { key: 'result-3', pinned: true },
      { key: 'result-4' },
    ] as any[];

    expect(filterQueryEditorResultSetsForBulkClose(resultSets, 'result-2', 'other').map((result) => result.key))
      .toEqual(['result-1', 'result-2', 'result-3']);
    expect(filterQueryEditorResultSetsForBulkClose(resultSets, 'result-2', 'left').map((result) => result.key))
      .toEqual(['result-1', 'result-2', 'result-3', 'result-4']);
    expect(filterQueryEditorResultSetsForBulkClose(resultSets, 'result-2', 'right').map((result) => result.key))
      .toEqual(['result-1', 'result-2', 'result-3']);
    expect(filterQueryEditorResultSetsForBulkClose(resultSets, '', 'all').map((result) => result.key))
      .toEqual(['result-1', 'result-3']);
  });

  it('pins a result from the context menu and keeps its snapshot when rerunning the same SQL', async () => {
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({ success: true, data: [{ columns: ['value'], rows: [{ value: 'first' }] }] })
      .mockResolvedValueOnce({ success: true, data: [{ columns: ['value'], rows: [{ value: 'second' }] }] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1 as value;' })} />);
      await Promise.resolve();
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const pinButton = renderer.root.findAll((node) =>
      node.type === 'button' && textContent(node) === '固定结果',
    )[0];
    expect(pinButton).toBeTruthy();
    await act(async () => {
      pinButton.props.onClick();
    });
    expect(renderer.root.findAll((node) =>
      String(node.props?.className || '').includes('query-result-tab-pin'),
    )).toHaveLength(1);

    const openInWindowButton = renderer.root.findAll((node) =>
      node.type === 'button' && textContent(node) === '在独立窗口打开',
    )[0];
    await act(async () => {
      await openInWindowButton.props.onClick();
      await Promise.resolve();
    });
    expect(nativeDetachedWindowState.openNativeQueryResultWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ pinned: true }),
      }),
    );

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const resultTabs = renderer.root.findAll((node) =>
      node.type === 'button' && String(node.props?.['data-tab-key'] || '').startsWith('result-'),
    );
    expect(resultTabs).toHaveLength(2);
    expect(dataGridState.latestProps?.data).toEqual([
      expect.objectContaining({ value: 'second' }),
    ]);
    const unpinButton = renderer.root.findAll((node) =>
      node.type === 'button' && textContent(node) === '取消固定结果',
    )[0];
    expect(unpinButton).toBeTruthy();
  });

  it('provides context menu actions for query result tabs', async () => {
    backendApp.DBQueryMulti.mockResolvedValue({
      success: true,
      data: [
        { columns: ['a'], rows: [{ a: 1 }] },
        { columns: ['b'], rows: [{ b: 2 }] },
        { columns: ['c'], rows: [{ c: 3 }] },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\nselect 3 as c;',
      })} />);
    });

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer!.root.findAll((node) => {
      const className = String(node.props?.className || '');
      return className.includes('query-result-tab-label');
    })).toHaveLength(3);

    await act(async () => {
      renderer!.root.findAll((node) => node.type === 'button' && textContent(node) === '关闭右侧')[1].props.onClick();
    });
    expect(renderer!.root.findAll((node) => {
      const className = String(node.props?.className || '');
      return className.includes('query-result-tab-label');
    })).toHaveLength(2);
    expect(textContent(renderer!.toJSON())).not.toContain('结果 3');

    await act(async () => {
      renderer!.root.findAll((node) => node.type === 'button' && textContent(node) === '关闭左侧')[1].props.onClick();
    });
    expect(renderer!.root.findAll((node) => {
      const className = String(node.props?.className || '');
      return className.includes('query-result-tab-label');
    })).toHaveLength(1);
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ b: 2 })]));
    expect(dataGridState.latestProps?.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ a: 1 })]));
    expect(dataGridState.latestProps?.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ c: 3 })]));

    await act(async () => {
      renderer!.root.findAll((node) => node.type === 'button' && textContent(node) === '关闭所有')[0].props.onClick();
    });
    expect(renderer!.root.findAll((node) => {
      const className = String(node.props?.className || '');
      return className.includes('query-result-tab-label');
    })).toHaveLength(0);
  });

  it('uses the query-tab popup structure for result tab context menus', () => {
    const source = readFileSync(new URL('./QueryEditorResultsPanel.tsx', import.meta.url), 'utf8');
    const menuSource = source.slice(
      source.indexOf('function buildResultTabMenuItems'),
      source.indexOf('const resultTabItems'),
    );
    const popupSource = source.slice(
      source.indexOf('const resultTabItems'),
      source.indexOf('children: (() => {', source.indexOf('const resultTabItems')),
    );

    expect(menuSource).not.toContain("type: 'group'");
    expect(menuSource).toContain("type: 'divider'");
    expect(popupSource).toContain('showHeader: false');
  });

  it('closes the active result tab directly without switching to the log tab', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { columns: ['a'], rows: [{ a: 1 }] },
        { columns: ['b'], rows: [{ b: 2 }] },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;',
      })} />);
    });

    await act(async () => {
      const runButton = findButton(renderer, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const resultTabs = renderer.root.findAll((node) =>
      node.type === 'button' && String(node.props?.['data-tab-key'] || '').startsWith('result-'),
    );
    expect(resultTabs).toHaveLength(2);

    await act(async () => {
      resultTabs[1].props.onClick();
    });
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ b: 2 })]));

    const closeButtons = renderer.root.findAll((node) =>
      String(node.props?.className || '').split(/\s+/).includes('query-result-tab-close'),
    );
    await act(async () => {
      closeButtons[1].props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });

    expect(renderer.root.findAll((node) =>
      String(node.props?.className || '').split(/\s+/).includes('query-result-tab-label'),
    )).toHaveLength(1);
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ a: 1 })]));
  });

  it('preserves a restored result execution snapshot when reopening it in a native window', async () => {
    const executionConnectionParams = 'application_name=gonavi&options=-c%20search_path%3D%22sales%22%2C%22public%22';
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ connectionId: 'conn-current', dbName: 'current_db' })} />);
    });

    const restoreRegistration = (window.addEventListener as any).mock.calls
      .find(([eventName]: [string]) => eventName === 'gonavi:restore-query-result');
    expect(restoreRegistration).toBeTruthy();

    await act(async () => {
      restoreRegistration[1](new CustomEvent('gonavi:restore-query-result', {
        detail: {
          sourceQueryTabId: 'tab-1',
          result: {
            key: 'result-snapshot',
            sql: 'select * from orders',
            columns: ['id'],
            rows: [{ id: 1 }],
            tableName: 'orders',
            pkColumns: ['id'],
            readOnly: false,
            executionConnectionId: 'conn-snapshot',
            executionDbName: 'snapshot_db',
            executionConnectionParams,
          },
        },
      }));
    });

    expect(dataGridState.latestProps).toMatchObject({
      connectionId: 'conn-snapshot',
      dbName: 'snapshot_db',
      connectionParamsOverride: executionConnectionParams,
    });

    const openInWindowButton = renderer.root.findAll((node) =>
      node.type === 'button' && textContent(node) === '在独立窗口打开',
    )[0];
    await act(async () => {
      openInWindowButton.props.onClick();
      await Promise.resolve();
    });

    expect(nativeDetachedWindowState.openNativeQueryResultWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-snapshot',
        dbName: 'snapshot_db',
        result: expect.objectContaining({
          executionConnectionId: 'conn-snapshot',
          executionDbName: 'snapshot_db',
          executionConnectionParams,
        }),
      }),
    );
  });

  it('removes only the inline result inserted by a rolled-back native attach', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    const restoreRegistrations = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === 'gonavi:restore-query-result');
    const redetachRegistrations = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === 'gonavi:redetach-query-result');
    expect(restoreRegistrations).toHaveLength(1);
    expect(redetachRegistrations).toHaveLength(1);

    await act(async () => {
      restoreRegistrations[0][1](new CustomEvent('gonavi:restore-query-result', {
        detail: {
          windowId: 'query-result:tab-1:result-restored',
          sourceQueryTabId: 'tab-1',
          result: {
            key: 'result-restored',
            sql: 'select 1 as a',
            columns: ['a'],
            rows: [{ a: 1 }],
            pkColumns: [],
            readOnly: true,
          },
        },
      }));
      redetachRegistrations[0][1](new CustomEvent('gonavi:redetach-query-result', {
        detail: {
          windowId: 'query-result:tab-1:result-restored',
          sourceQueryTabId: 'tab-1',
          resultKey: 'result-restored',
        },
      }));
    });

    expect(renderer.root.findAll((node) =>
      String(node.props?.className || '').split(/\s+/).includes('query-result-tab-label'),
    )).toHaveLength(0);

    await act(async () => {
      restoreRegistrations[0][1](new CustomEvent('gonavi:restore-query-result', {
        detail: {
          sourceQueryTabId: 'tab-1',
          result: {
            key: 'result-existing',
            sql: 'select existing',
            columns: ['value'],
            rows: [{ value: 'existing' }],
            pkColumns: [],
            readOnly: true,
            pinned: true,
          },
        },
      }));
      restoreRegistrations[0][1](new CustomEvent('gonavi:restore-query-result', {
        detail: {
          windowId: 'query-result:tab-1:result-existing',
          sourceQueryTabId: 'tab-1',
          result: {
            key: 'result-existing',
            sql: 'select detached',
            columns: ['value'],
            rows: [{ value: 'detached' }],
            pkColumns: [],
            readOnly: true,
          },
        },
      }));
      redetachRegistrations[0][1](new CustomEvent('gonavi:redetach-query-result', {
        detail: {
          windowId: 'query-result:tab-1:result-existing',
          sourceQueryTabId: 'tab-1',
          resultKey: 'result-existing',
        },
      }));
    });

    expect(renderer.root.findAll((node) =>
      String(node.props?.className || '').includes('query-result-tab-pin'),
    )).toHaveLength(1);
    expect(dataGridState.latestProps?.data).toEqual([
      expect.objectContaining({ value: 'existing' }),
    ]);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('closes the final result and synchronously hides the log tab on the next command', async () => {
    storeState.appearance.uiVersion = 'v2';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['a'], rows: [{ a: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1 as a;' })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const closeRegistrations = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === CLOSE_ACTIVE_RESULT_TAB_EVENT);
    expect(closeRegistrations).toHaveLength(1);
    const closeListener = closeRegistrations[0][1] as EventListener;
    (window.dispatchEvent as any).mockImplementation((event: Event) => {
      closeListener(event);
      return true;
    });

    let firstOutcome!: CloseActiveResultShortcutRequest;
    let secondOutcome!: CloseActiveResultShortcutRequest;
    act(() => {
      const firstRequest: CloseActiveResultShortcutRequest = { targetTabId: 'tab-1', handled: false, outcome: 'ignored' };
      window.dispatchEvent(new CustomEvent(CLOSE_ACTIVE_RESULT_TAB_EVENT, { detail: firstRequest }));
      firstOutcome = { ...firstRequest };

      const secondRequest: CloseActiveResultShortcutRequest = { targetTabId: 'tab-1', handled: false, outcome: 'ignored' };
      window.dispatchEvent(new CustomEvent(CLOSE_ACTIVE_RESULT_TAB_EVENT, { detail: secondRequest }));
      secondOutcome = { ...secondRequest };
    });

    expect(firstOutcome).toEqual({ targetTabId: 'tab-1', handled: true, outcome: 'closed' });
    expect(secondOutcome).toEqual({ targetTabId: 'tab-1', handled: true, outcome: 'hidden' });
    expect(renderer.root.findAll((node) =>
      node.props?.['data-gonavi-close-shortcut-scope'] === 'result',
    )).toHaveLength(0);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('ignores result close commands for hidden, invalid, or inactive result targets', async () => {
    storeState.appearance.uiVersion = 'v2';
    let hiddenRenderer!: ReactTestRenderer;
    await act(async () => {
      hiddenRenderer = create(<QueryEditor tab={createTab()} />);
    });

    const closeRegistrations = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === CLOSE_ACTIVE_RESULT_TAB_EVENT);
    expect(closeRegistrations).toHaveLength(1);
    const hiddenRequest: CloseActiveResultShortcutRequest = { targetTabId: 'tab-1', handled: false, outcome: 'ignored' };
    closeRegistrations[0][1](new CustomEvent(CLOSE_ACTIVE_RESULT_TAB_EVENT, { detail: hiddenRequest }));
    expect(hiddenRequest).toEqual({ targetTabId: 'tab-1', handled: true, outcome: 'ignored' });
    const detachedRequest: CloseActiveResultShortcutRequest = { targetTabId: 'detached-tab', handled: false, outcome: 'ignored' };
    closeRegistrations[0][1](new CustomEvent(CLOSE_ACTIVE_RESULT_TAB_EVENT, { detail: detachedRequest }));
    expect(detachedRequest).toEqual({ targetTabId: 'detached-tab', handled: false, outcome: 'ignored' });
    await act(async () => {
      hiddenRenderer.unmount();
    });

    vi.mocked(window.addEventListener).mockClear();
    storeState.appearance.uiVersion = 'legacy';
    let invalidRenderer!: ReactTestRenderer;
    await act(async () => {
      invalidRenderer = create(<QueryEditor tab={createTab({ id: 'tab-invalid', resultPanelVisible: true })} />);
    });
    const invalidRegistrations = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === CLOSE_ACTIVE_RESULT_TAB_EVENT);
    expect(invalidRegistrations).toHaveLength(1);
    const invalidRequest: CloseActiveResultShortcutRequest = { targetTabId: 'tab-invalid', handled: false, outcome: 'ignored' };
    invalidRegistrations[0][1](new CustomEvent(CLOSE_ACTIVE_RESULT_TAB_EVENT, { detail: invalidRequest }));
    expect(invalidRequest).toEqual({ targetTabId: 'tab-invalid', handled: true, outcome: 'ignored' });
    await act(async () => {
      invalidRenderer.unmount();
    });

    vi.mocked(window.addEventListener).mockClear();
    let inactiveRenderer!: ReactTestRenderer;
    await act(async () => {
      inactiveRenderer = create(<QueryEditor tab={createTab({ id: 'tab-2' })} isActive={false} />);
    });
    expect((window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === CLOSE_ACTIVE_RESULT_TAB_EVENT)).toHaveLength(0);
    await act(async () => {
      inactiveRenderer.unmount();
    });
  });

  it('replaces the current result when rerunning the same cursor SQL', async () => {
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 1 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 10 }] }],
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\nselect 3 as c;',
      })} />);
    });

    editorState.position = { lineNumber: 1, column: 'select 1 as a;'.length + 1 };
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 'select 1 as a;'.length + 1,
      endLineNumber: 1,
      endColumn: 'select 1 as a;'.length + 1,
      positionLineNumber: 1,
      positionColumn: 'select 1 as a;'.length + 1,
    };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const tabLabels = renderer!.root.findAll((node) => textContent(node).includes('结果 '));
    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).not.toContain('结果 2');
    expect(tabLabels.length).toBeGreaterThan(0);
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ a: 10 })]));
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).toContain('select 1 as a');
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).not.toContain('select 2 as b');
  });

  it('appends a result when running a different cursor SQL after an existing result', async () => {
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 1 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['b'], rows: [{ b: 2 }] }],
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;\nselect 3 as c;',
      })} />);
    });

    editorState.position = { lineNumber: 1, column: 'select 1 as a;'.length + 1 };
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 'select 1 as a;'.length + 1,
      endLineNumber: 1,
      endColumn: 'select 1 as a;'.length + 1,
      positionLineNumber: 1,
      positionColumn: 'select 1 as a;'.length + 1,
    };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.position = { lineNumber: 2, column: 'select 2 as b;'.length + 1 };
    editorState.selection = {
      startLineNumber: 2,
      startColumn: 'select 2 as b;'.length + 1,
      endLineNumber: 2,
      endColumn: 'select 2 as b;'.length + 1,
      positionLineNumber: 2,
      positionColumn: 'select 2 as b;'.length + 1,
    };

    await act(async () => {
      const runButton = findButton(renderer!, '运行');
      runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
      await runButton.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).toContain('select 2 as b');
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).not.toContain('select 1 as a');
    expect(String(backendApp.DBQueryMulti.mock.calls[1][2])).not.toContain('select 3 as c');
    expect(textContent(renderer!.toJSON())).toContain('结果 1');
    expect(textContent(renderer!.toJSON())).toContain('结果 2');
    expect(dataGridState.latestProps?.data).toEqual(expect.arrayContaining([expect.objectContaining({ b: 2 })]));
    expect(dataGridState.latestProps?.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ a: 1 })]));
  });

  it('renders compact result tab labels with row counts outside the title text', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { columns: ['a'], rows: [{ a: 1 }, { a: 2 }] },
        { columns: ['b'], rows: [{ b: 3 }] },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1 as a;\nselect 2 as b;',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const tabLabels = renderer!.root.findAll((node) => {
      const className = String(node.props?.className || '');
      return className.includes('query-result-tab-label');
    });
    const counts = renderer!.root.findAll((node) => {
      const className = String(node.props?.className || '');
      return className.includes('query-result-tab-count');
    });
    const titles = renderer!.root.findAll((node) => {
      const className = String(node.props?.className || '');
      return className.includes('query-result-tab-text');
    });

    expect(tabLabels).toHaveLength(2);
    expect(titles.map((node) => textContent(node))).toEqual(['结果 1', '结果 2']);
    expect(counts.map((node) => textContent(node))).toEqual(['2', '1']);
    expect(textContent(renderer!.toJSON())).not.toContain('结果 1 (2)');
  });

  it('keeps query result tabs and count badges compact in v2 UI', () => {
    const source = readFileSync(new URL('./QueryEditorResultsPanel.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    const resultNavCss = source.slice(
      source.indexOf('.query-result-tabs .ant-tabs-nav {'),
      source.indexOf('.query-result-tabs .ant-tabs-nav-wrap {'),
    );
    const resultTabCss = source.slice(
      source.indexOf('.query-result-tabs .ant-tabs-tab {'),
      source.indexOf('.query-result-tabs .ant-tabs-tab-btn {'),
    );
    const resultCountCss = source.slice(
      source.indexOf('.query-result-tab-count {'),
      source.indexOf('.query-result-tab-close {'),
    );

    expect(resultNavCss).toContain('min-height: 36px;');
    expect(resultTabCss).toContain('height: 30px !important;');
    expect(resultTabCss).toContain('min-height: 30px;');
    expect(resultCountCss).toContain('height: 17px;');
    expect(resultCountCss).toContain('padding: 0 5px;');
    expect(resultCountCss).toContain('border-radius: 3px;');
    expect(resultCountCss).toContain('font-family: var(--gn-font-mono);');
    expect(resultCountCss).toContain('font-size: 9.5px;');
    expect(resultCountCss).not.toContain('border-radius: 999px;');

    const workbenchResultCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-results .query-result-tabs > .ant-tabs-nav {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-results .query-result-tabs > .ant-tabs-nav .ant-tabs-extra-content {'),
    );
    const workbenchResultTabCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-results .query-result-tabs > .ant-tabs-nav .ant-tabs-tab {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-results .query-result-tabs > .ant-tabs-nav .ant-tabs-nav-wrap,'),
    );
    expect(workbenchResultCss).toContain('min-height: 36px;');
    expect(workbenchResultTabCss).toContain('height: 30px !important;');
    expect(workbenchResultTabCss).toContain('min-height: 30px;');
    expect(workbenchResultTabCss).toContain('margin: 0 !important;');
  });

  it('connects each query result sort state and callback to DataGrid', async () => {
    const onResultSort = vi.fn();
    const sortInfo = [{ columnKey: 'name', order: 'ascend', enabled: true }];
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <QueryEditorResultsPanel
          resultSets={[{
            key: 'result-1',
            sql: 'select id, name from users',
            rows: [{ id: 1, name: 'Ada' }],
            columns: ['id', 'name'],
            pkColumns: [],
            readOnly: true,
            sortInfo,
          }]}
          activeResultKey="result-1"
          isActive
          loading={false}
          executionError=""
          sqlLogCount={0}
          darkMode={false}
          isV2Ui
          currentDb="main"
          currentConnectionId="conn-1"
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={vi.fn()}
          onCloseOtherResultTabs={vi.fn()}
          onCloseResultTabsToLeft={vi.fn()}
          onCloseResultTabsToRight={vi.fn()}
          onCloseAllResultTabs={vi.fn()}
          onResultPinnedChange={vi.fn()}
          onReloadResult={vi.fn()}
          onResultPageChange={vi.fn()}
          onResultSort={onResultSort}
          onDiagnoseExecutionError={vi.fn()}
        />,
      );
    });

    expect(dataGridState.latestProps?.sortInfoExternal).toEqual(sortInfo);
    expect(dataGridState.latestProps?.onSort).toEqual(expect.any(Function));

    const serialized = JSON.stringify([{ columnKey: 'id', order: 'descend', enabled: true }]);
    dataGridState.latestProps.onSort(serialized, '');
    expect(onResultSort).toHaveBeenCalledWith('result-1', serialized, '');
    renderer.unmount();
  });

  it('activates shortcuts only for the visible result grid in the active query editor', async () => {
    const resultSets = [
      {
        key: 'result-1',
        sql: 'select 1 as value',
        rows: [{ value: 1 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
      {
        key: 'result-2',
        sql: 'select 2 as value',
        rows: [{ value: 2 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
    ];
    const renderPanel = (activeResultKey: string, isActive: boolean) => (
      <QueryEditorResultsPanel
        resultSets={resultSets}
        activeResultKey={activeResultKey}
        isActive={isActive}
        loading={false}
        executionError=""
        sqlLogCount={0}
        darkMode={false}
        isV2Ui
        currentDb="main"
        currentConnectionId="conn-1"
        toggleShortcutLabel=""
        onActiveResultKeyChange={vi.fn()}
        onHide={vi.fn()}
        onCloseResult={vi.fn()}
        onCloseOtherResultTabs={vi.fn()}
        onCloseResultTabsToLeft={vi.fn()}
        onCloseResultTabsToRight={vi.fn()}
        onCloseAllResultTabs={vi.fn()}
        onResultPinnedChange={vi.fn()}
        onReloadResult={vi.fn()}
        onResultPageChange={vi.fn()}
        onResultSort={vi.fn()}
        onDiagnoseExecutionError={vi.fn()}
      />
    );
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(renderPanel('result-1', true));
    });
    expect(dataGridState.latestProps?.data).toEqual([{ value: 1 }]);
    expect(dataGridState.latestProps?.isActive).toBe(true);

    await act(async () => {
      renderer.update(renderPanel('result-1', false));
    });
    expect(dataGridState.latestProps?.isActive).toBe(false);

    await act(async () => {
      renderer.update(renderPanel('result-2', true));
    });
    expect(dataGridState.latestProps?.data).toEqual([{ value: 2 }]);
    expect(dataGridState.latestProps?.isActive).toBe(true);
    expect(readFileSync(new URL('./QueryEditorResultsPanel.tsx', import.meta.url), 'utf8'))
      .toContain('isActive={isActive && resolvedActiveResultKey === rs.key}');

    renderer.unmount();
  });

  it('sorts complete query results locally and restores execution order when cleared', async () => {
    const query = "select 3 as id, 'Zulu' as name union all select 1, 'Alpha' union all select 2, 'Alpha';";
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['id', 'name'],
        rows: [
          { id: 3, name: 'Zulu' },
          { id: 1, name: 'Alpha' },
          { id: 2, name: 'Alpha' },
        ],
      }],
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.data.map((row: any) => row.name)).toEqual(['Zulu', 'Alpha', 'Alpha']);
    expect(dataGridState.latestProps?.sortInfoExternal).toEqual([]);

    await act(async () => {
      await dataGridState.latestProps.onSort(JSON.stringify([
        { columnKey: 'name', order: 'ascend', enabled: true },
        { columnKey: 'id', order: 'descend', enabled: true },
      ]), '');
    });

    expect(dataGridState.latestProps?.data.map((row: any) => row.name)).toEqual(['Alpha', 'Alpha', 'Zulu']);
    expect(dataGridState.latestProps?.data.map((row: any) => row.__gonavi_row_key__)).toEqual([2, 1, 0]);
    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(1);

    await act(async () => {
      await dataGridState.latestProps.onSort('[]', '');
    });

    expect(dataGridState.latestProps?.data.map((row: any) => row.name)).toEqual(['Zulu', 'Alpha', 'Alpha']);
    expect(dataGridState.latestProps?.data.map((row: any) => row.__gonavi_row_key__)).toEqual([0, 1, 2]);
    expect(dataGridState.latestProps?.sortInfoExternal).toEqual([]);
    renderer.unmount();
  });

  it('requeries the first page with outer ordering when a pageable result is sorted', async () => {
    storeState.queryOptions.maxRows = 2;
    const query = 'select id, name from (select id, name from users) q;';
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{
          columns: ['id', 'name'],
          rows: [{ id: 2, name: 'Beta' }, { id: 1, name: 'Alpha' }],
        }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{
          columns: ['id', 'name'],
          rows: [{ id: 4, name: 'Delta' }, { id: 3, name: 'Charlie' }],
        }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{
          columns: ['id', 'name'],
          rows: [
            { id: 1, name: 'Alpha' },
            { id: 2, name: 'Beta' },
            { id: 3, name: 'Charlie' },
          ],
        }],
      });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.pagination).toMatchObject({ current: 1, pageSize: 2 });

    await act(async () => {
      await dataGridState.latestProps.onPageChange(2, 2);
    });
    expect(dataGridState.latestProps?.pagination).toMatchObject({ current: 2, pageSize: 2 });

    await act(async () => {
      await dataGridState.latestProps.onSort(JSON.stringify([
        { columnKey: 'name', order: 'ascend', enabled: true },
      ]), '');
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(3);
    const sortedPageSql = String(backendApp.DBQueryMulti.mock.calls[2][2]);
    expect(sortedPageSql).toContain('AS __gonavi_query_page__ ORDER BY `name` ASC LIMIT 3 OFFSET 0');
    expect(dataGridState.latestProps?.pagination).toMatchObject({ current: 1, pageSize: 2 });
    expect(dataGridState.latestProps?.sortInfoExternal).toEqual([
      { columnKey: 'name', order: 'ascend', enabled: true },
    ]);
    expect(dataGridState.latestProps?.data.map((row: any) => row.name)).toEqual(['Alpha', 'Beta']);
    renderer.unmount();
  });

  it('does not render the embedded sql execution log tab in legacy UI', () => {
    const renderResultsPanel = (isV2Ui: boolean, sqlLogCount = 1) => create(
      <QueryEditorResultsPanel
        resultSets={[]}
        activeResultKey=""
        isActive
        loading={false}
        executionError=""
        sqlLogCount={sqlLogCount}
        darkMode={false}
        isV2Ui={isV2Ui}
        currentDb="main"
        currentConnectionId="conn-1"
        toggleShortcutLabel=""
        onActiveResultKeyChange={vi.fn()}
        onHide={vi.fn()}
        onCloseResult={vi.fn()}
        onCloseOtherResultTabs={vi.fn()}
        onCloseResultTabsToLeft={vi.fn()}
        onCloseResultTabsToRight={vi.fn()}
        onCloseAllResultTabs={vi.fn()}
        onResultPinnedChange={vi.fn()}
        onReloadResult={vi.fn()}
        onResultPageChange={vi.fn()}
        onResultSort={vi.fn()}
        onDiagnoseExecutionError={vi.fn()}
      />,
    );

    const legacyRenderer = renderResultsPanel(false);
    expect(legacyRenderer.root.findAll((node) => node.props?.['data-log-panel'] === 'true')).toHaveLength(0);
    expect(legacyRenderer.root.findAll((node) => node.props?.['data-tab-key'] === '__gonavi_sql_execution_log__')).toHaveLength(0);
    legacyRenderer.unmount();

    const v2Renderer = renderResultsPanel(true);
    expect(v2Renderer.root.findAll((node) => node.props?.['data-log-panel'] === 'true')).toHaveLength(1);
    expect(v2Renderer.root.findAll((node) => node.props?.['data-tab-key'] === '__gonavi_sql_execution_log__')).toHaveLength(1);
    const tabActions = v2Renderer.root.findByProps({ className: 'query-result-panel-tab-actions' });
    const actionButtons = tabActions.findAll((node) => node.type === 'button');
    const resultPanelStyles = v2Renderer.root.findAll((node) => node.type === 'style')
      .map((node) => textContent(node))
      .join('\n');
    expect(actionButtons.map((node) => node.props.className)).toEqual([
      'query-result-panel-clear query-result-panel-tab-action',
      'query-result-panel-hide query-result-panel-tab-action',
    ]);
    expect(resultPanelStyles).toContain(
      '.query-result-panel-tab-actions { display: inline-flex; flex-direction: row;',
    );
    expect(resultPanelStyles).toContain(
      '.query-result-tabs .ant-tabs-extra-content .query-result-panel-tab-action { width: 28px; min-width: 28px; height: 28px !important; min-height: 28px !important; padding: 0 !important;',
    );
    act(() => {
      actionButtons[0].props.onClick();
    });
    expect(storeState.clearSqlLogs).toHaveBeenCalledTimes(1);
    v2Renderer.unmount();

    const emptyV2Renderer = renderResultsPanel(true, 0);
    expect(emptyV2Renderer.root.findAll((node) => node.props?.['data-log-panel'] === 'true')).toHaveLength(1);
    expect(emptyV2Renderer.root.findAll((node) => node.props?.['data-tab-key'] === QUERY_EDITOR_SQL_LOG_TAB_KEY)).toHaveLength(1);
    expect(emptyV2Renderer.root.findAll((node) =>
      node.props?.['data-gonavi-close-shortcut-scope'] === 'result',
    )).toHaveLength(1);
    emptyV2Renderer.unmount();
  });

  it('uses the shared effective result key for stale-key rendering fallbacks', () => {
    const resultSets = [{
      key: 'result-1',
      sql: 'select 1 as value',
      rows: [{ value: 1 }],
      columns: ['value'],
      pkColumns: [],
      readOnly: true,
    }];
    expect(resolveEffectiveActiveResultKey(resultSets, 'stale-result', true)).toBe('result-1');
    expect(resolveEffectiveActiveResultKey([], 'stale-result', true)).toBe(QUERY_EDITOR_SQL_LOG_TAB_KEY);
    expect(resolveEffectiveActiveResultKey([], 'stale-result', false)).toBe('');

    const renderer = create(
      <QueryEditorResultsPanel
        resultSets={resultSets}
        activeResultKey="stale-result"
        isActive
        loading={false}
        executionError=""
        sqlLogCount={0}
        darkMode={false}
        isV2Ui
        currentDb="main"
        currentConnectionId="conn-1"
        toggleShortcutLabel=""
        onActiveResultKeyChange={vi.fn()}
        onHide={vi.fn()}
        onCloseResult={vi.fn()}
        onCloseOtherResultTabs={vi.fn()}
        onCloseResultTabsToLeft={vi.fn()}
        onCloseResultTabsToRight={vi.fn()}
        onCloseAllResultTabs={vi.fn()}
        onResultPinnedChange={vi.fn()}
        onReloadResult={vi.fn()}
        onResultPageChange={vi.fn()}
        onResultSort={vi.fn()}
        onDiagnoseExecutionError={vi.fn()}
      />,
    );
    expect(dataGridState.latestProps?.data).toEqual([{ value: 1 }]);
    renderer.unmount();
  });

  it('keeps the v2 query editor toolbar grouped and compact', () => {
    const source = readFileSync(new URL('./QueryEditor.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();

    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-selects');
    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-actions');
    expect(css).toContain('width: 48px !important;');
    expect(css).toContain('flex: 0 0 48px !important;');
    expect(css).toContain('flex: 0 0 auto !important;');
    expect(css).toContain('justify-content: flex-start;');
    expect(css).toContain('height: 32px !important;');
    expect(css).toContain('line-height: 30px !important;');
    expect(css).toContain('display: inline-flex !important;');
    expect(css).toContain('gap: 6px;');
    expect(css).toContain('overflow-x: auto;');
    expect(css).toContain('overflow-y: hidden;');
    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-action-pair');
    expect(css).toContain('gap: 8px;');
    expect(css).toContain('margin-left: 0 !important;');
    expect(css).toContain('max-width: 760px;');
    expect(css).toContain('width: 140px !important;');
    expect(css).toContain('width: 166px !important;');
    expect(css).toContain('width: 132px !important;');
    expect(css).toContain('width: 34px !important;');
    expect(css).toContain('@media (max-width: 900px)');
    expect(css).not.toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-transaction-row {');

    const queryToolbarMainCss = css.slice(css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-main {'), css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-selects {'));
    expect(queryToolbarMainCss).toContain('flex-wrap: nowrap;');
    expect(queryToolbarMainCss).toContain('width: max-content;');
    expect(queryToolbarMainCss).not.toContain('flex-wrap: wrap;');
    expect(queryToolbarMainCss).not.toContain('margin-left: auto;');
    expect(queryToolbarMainCss).not.toContain('justify-content: flex-end;');
  });

  it('coalesces editor result splitter dragging through requestAnimationFrame', async () => {
    const moveListeners: Array<(event: MouseEvent) => void> = [];
    const upListeners: Array<() => void> = [];
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.mocked(document.addEventListener).mockImplementation((type: string, listener: any) => {
      if (type === 'mousemove') moveListeners.push(listener);
      if (type === 'mouseup') upListeners.push(listener);
    });
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ resultPanelVisible: true })} />);
    });
    vi.mocked(window.requestAnimationFrame).mockClear();
    frameCallbacks.length = 0;

    const resizer = renderer.root.find((node) => node.props?.title === '拖动调整高度');
    await act(async () => {
      resizer.props.onMouseDown({ clientY: 300, preventDefault: vi.fn() });
      moveListeners.forEach((listener) => listener({ clientY: 340 } as MouseEvent));
      moveListeners.forEach((listener) => listener({ clientY: 380 } as MouseEvent));
    });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    await act(async () => {
      frameCallbacks.splice(0).forEach((callback) => callback(16));
    });

    await act(async () => {
      upListeners.forEach((listener) => listener());
    });
    expect(document.removeEventListener).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(document.removeEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function));
  });

  it('prevents Monaco native drag marker and keeps metadata hover after sidebar object drops', async () => {
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode = {
      style: { cursor: '' },
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        domListeners[type] ||= [];
        domListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
    } as any;
    editorState.editor.getTargetAtClientPoint = vi.fn(() => ({
      position: { lineNumber: 1, column: 'SELECT * FROM '.length + 1 },
    }));
    editorState.value = 'SELECT * FROM ';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'front_end_sys' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_front_end_sys: 'fs_mkefu_regist_record' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'front_end_sys' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const dragOverEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: {
        types: ['application/x-gonavi-sql-object', 'text/plain'],
        dropEffect: 'none',
        getData: vi.fn(() => ''),
      },
    };
    await act(async () => {
      domListeners.dragover?.forEach((listener) => listener(dragOverEvent));
    });

    expect(dragOverEvent.preventDefault).toHaveBeenCalled();
    expect(dragOverEvent.stopPropagation).toHaveBeenCalled();
    expect(dragOverEvent.dataTransfer.dropEffect).toBe('copy');
    expect(dragOverEvent.dataTransfer.getData).not.toHaveBeenCalled();

    await act(async () => {
      domListeners.drop?.forEach((listener) => listener({
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: {
          types: ['application/x-gonavi-sql-object', 'text/plain'],
          getData: (type: string) => {
            if (type === 'application/x-gonavi-sql-object') {
              return JSON.stringify({ text: 'fs_mkefu_regist_record' });
            }
            if (type === 'text/plain') {
              return 'fs_mkefu_regist_record';
            }
            return '';
          },
        },
      }));
    });

    const hover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT * FROM fs_mkefu_regist_record'.length },
    );

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'SELECT * FROM fs_mkefu_regist_record'.length } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'front_end_sys',
      tableName: 'fs_mkefu_regist_record',
      objectType: 'table',
    }));
  });

  it('projects field drops from editor whitespace by x coordinate and previews the same anchor', async () => {
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    const sql = 'SELECT org_id, title FROM a_cninfo_announcement\n\n';
    editorState.domNode = {
      style: { cursor: '' },
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        domListeners[type] ||= [];
        domListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      contains: vi.fn(() => false),
      getBoundingClientRect: vi.fn(() => ({ left: 0, top: 0, width: 800, height: 300 })),
    } as any;
    editorState.editor.getTargetAtClientPoint = vi.fn(() => ({
      type: 7,
      position: { lineNumber: 3, column: 1 },
    }));
    editorState.editor.getVisibleRanges = vi.fn(() => [{ startLineNumber: 1, endLineNumber: 3 }]);
    editorState.editor.getScrolledVisiblePosition = vi.fn(({ lineNumber, column }: any) => ({
      left: (column - 1) * 10,
      top: (lineNumber - 1) * 20,
      height: 20,
    }));
    editorState.editor.render = vi.fn();
    editorState.value = sql;

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: sql })} />);
    });

    const titleOffset = sql.indexOf('title');
    const createDataTransfer = () => ({
      types: [
        'application/x-gonavi-sql-object',
        'application/x-gonavi-sql-field',
        'text/plain',
      ],
      dropEffect: 'none',
      getData: (type: string) => {
        if (type === 'application/x-gonavi-sql-object') {
          return JSON.stringify({ text: 'announcement_id', nodeType: 'column' });
        }
        return 'announcement_id';
      },
    });
    const dragCoordinates = {
      clientX: (titleOffset + 2) * 10,
      clientY: 100,
    };

    await act(async () => {
      domListeners.dragover?.forEach((listener) => listener({
        ...dragCoordinates,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: createDataTransfer(),
      }));
    });

    const previewDecoration = editorState.editor.deltaDecorations.mock.calls
      .flatMap((call: any[]) => call[1] || [])
      .find((decoration: any) => decoration?.options?.inlineClassName === 'gonavi-query-editor-field-drop-anchor');
    expect(previewDecoration?.range).toMatchObject({
      startLineNumber: 1,
      startColumn: titleOffset + 1,
      endLineNumber: 1,
      endColumn: titleOffset + 'title'.length + 1,
    });

    await act(async () => {
      domListeners.drop?.forEach((listener) => listener({
        ...dragCoordinates,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: createDataTransfer(),
      }));
    });

    expect(editorState.value).toBe(
      'SELECT org_id, title, announcement_id FROM a_cninfo_announcement\n\n',
    );
  });

  it('fetches database and completion metadata only for the active query tab', async () => {
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }],
    });
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ Tables_in_main: 'users' }],
    });

    const firstTab = createTab({ id: 'tab-1', query: 'SELECT * FROM users' });
    const secondTab = createTab({ id: 'tab-2', query: 'SELECT * FROM orders' });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <>
          <QueryEditor key={firstTab.id} tab={firstTab} isActive />
          <QueryEditor key={secondTab.id} tab={secondTab} isActive={false} />
        </>,
      );
    });

    await vi.waitFor(() => {
      expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
      expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
      expect(backendApp.DBGetAllColumns).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      renderer.update(
        <>
          <QueryEditor key={firstTab.id} tab={firstTab} isActive={false} />
          <QueryEditor key={secondTab.id} tab={secondTab} isActive />
        </>,
      );
    });

    await vi.waitFor(() => {
      expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(2);
      expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
      expect(backendApp.DBGetAllColumns).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not rerender inactive query editors when SQL logs change', async () => {
    const renderCounts = { active: 0, inactive: 0 };
    const firstTab = createTab({ id: 'tab-1', query: 'SELECT * FROM users' });
    const secondTab = createTab({ id: 'tab-2', query: 'SELECT * FROM orders' });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <>
          <React.Profiler id="active" onRender={() => { renderCounts.active += 1; }}>
            <QueryEditor key={firstTab.id} tab={firstTab} isActive />
          </React.Profiler>
          <React.Profiler id="inactive" onRender={() => { renderCounts.inactive += 1; }}>
            <QueryEditor key={secondTab.id} tab={secondTab} isActive={false} />
          </React.Profiler>
        </>,
      );
    });

    const baseline = { ...renderCounts };
    await act(async () => {
      storeState.sqlLogs = [{
        id: 'log-1',
        timestamp: Date.now(),
        sql: 'SELECT 1',
        status: 'success',
        duration: 1,
      }];
      notifyStoreSubscribers();
    });

    expect(renderCounts.active).toBeGreaterThan(baseline.active);
    expect(renderCounts.inactive).toBe(baseline.inactive);

    await act(async () => {
      renderer.update(
        <>
          <React.Profiler id="active" onRender={() => { renderCounts.active += 1; }}>
            <QueryEditor key={firstTab.id} tab={firstTab} isActive={false} />
          </React.Profiler>
          <React.Profiler id="inactive" onRender={() => { renderCounts.inactive += 1; }}>
            <QueryEditor key={secondTab.id} tab={secondTab} isActive />
          </React.Profiler>
        </>,
      );
    });

    const switchedBaseline = { ...renderCounts };
    await act(async () => {
      storeState.sqlLogs = [{
        id: 'log-2',
        timestamp: Date.now() + 1,
        sql: 'SELECT 2',
        status: 'success',
        duration: 1,
      }, ...storeState.sqlLogs];
      notifyStoreSubscribers();
    });

    expect(renderCounts.active).toBe(switchedBaseline.active);
    expect(renderCounts.inactive).toBeGreaterThan(switchedBaseline.inactive);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not rerender background Kingbase query editors when the active tab changes', async () => {
    const renderCounts = { first: 0, second: 0 };
    storeState.connections[0].config.type = 'kingbase';
    storeState.connections[0].config.database = 'appdb';
    const longQuery = Array.from({ length: 120 }, (_, index) => (
      `SELECT * FROM public.order_${index + 1};`
    )).join('\n');
    const firstTab = createTab({ id: 'tab-1', dbName: 'appdb', query: longQuery });
    const secondTab = createTab({ id: 'tab-2', dbName: 'appdb', query: longQuery });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <>
          <React.Profiler id="first-kingbase-query" onRender={() => { renderCounts.first += 1; }}>
            <QueryEditor key={firstTab.id} tab={firstTab} isActive />
          </React.Profiler>
          <React.Profiler id="second-kingbase-query" onRender={() => { renderCounts.second += 1; }}>
            <QueryEditor key={secondTab.id} tab={secondTab} isActive={false} />
          </React.Profiler>
        </>,
      );
    });

    const baseline = { ...renderCounts };
    await act(async () => {
      storeState.activeTabId = 'tab-2';
      notifyStoreSubscribers();
    });

    expect(renderCounts).toEqual(baseline);
    renderer.unmount();
  });

  it('does not rescan unchanged Kingbase SQL when a cached query tab is reactivated', async () => {
    storeState.connections[0].config.type = 'kingbase';
    storeState.connections[0].config.database = 'appdb';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'appdb' }],
    });
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'public.users' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    const tab = createTab({
      id: 'tab-1',
      dbName: 'appdb',
      query: Array.from({ length: 120 }, () => 'SELECT * FROM public.users;').join('\n'),
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={tab} isActive />);
    });
    await act(async () => {
      for (let index = 0; index < 20; index += 1) {
        await Promise.resolve();
      }
    });
    expect(backendApp.DBGetTables).toHaveBeenCalled();
    expect(editorState.editor.deltaDecorations).toHaveBeenCalled();

    await act(async () => {
      renderer.update(<QueryEditor tab={tab} isActive={false} />);
    });
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();

    await act(async () => {
      renderer.update(<QueryEditor tab={tab} isActive />);
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValue).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValueLength).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('keeps object hyperlink tab opening tied to the dragged database after drop', async () => {
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode = {
      style: { cursor: '' },
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        domListeners[type] ||= [];
        domListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
    } as any;
    editorState.editor.getTargetAtClientPoint = vi.fn(() => ({
      position: { lineNumber: 1, column: 'SELECT * FROM '.length + 1 },
    }));
    editorState.value = 'SELECT * FROM ';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'front_end_sys' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_front_end_sys: 'fs_mkefu_regist_record' }] });
    backendApp.DBGetAllColumns
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      domListeners.drop?.forEach((listener) => listener({
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: {
          types: ['application/x-gonavi-sql-object', 'text/plain'],
          getData: (type: string) => {
            if (type === 'application/x-gonavi-sql-object') {
              return JSON.stringify({
                text: 'fs_mkefu_regist_record',
                nodeType: 'table',
                connectionId: 'conn-1',
                dbName: 'front_end_sys',
              });
            }
            if (type === 'text/plain') {
              return 'fs_mkefu_regist_record';
            }
            return '';
          },
        },
      }));
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'SELECT * FROM front_end_sys.fs_mkefu_regist_record'.length } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'front_end_sys',
      tableName: 'fs_mkefu_regist_record',
      objectType: 'table',
    }));
  });

  it('runs selected SQL before cursor SQL', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['selected'], rows: [{ selected: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as selected;\nselect 3;',
      })} />);
    });

    editorState.position = { lineNumber: 1, column: 4 };
    editorState.selection = {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'select 2 as selected'.length + 1,
    };

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as selected'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
  });

  it('allows editable table columns while leaving expression columns out of commits', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['DISPLAY_NAME', 'NAME_UPPER', '__gonavi_locator_1_ID'],
        rows: [{ DISPLAY_NAME: 'old-name', NAME_UPPER: 'OLD-NAME', __gonavi_locator_1_ID: 7 }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'ID', key: 'PRI' }, { name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'SELECT NAME AS DISPLAY_NAME, UPPER(NAME) AS NAME_UPPER FROM users',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('users');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['ID'],
      valueColumns: ['__gonavi_locator_1_ID'],
      hiddenColumns: ['__gonavi_locator_1_ID'],
      writableColumns: {
        DISPLAY_NAME: 'NAME',
      },
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('`ID` AS `__gonavi_locator_1_ID`');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('keeps DuckDB qualified table query results writable when primary key metadata arrives', async () => {
    storeState.connections[0].config.type = 'duckdb';
    storeState.connections[0].config.database = 'main';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_locator_1_id'], rows: [{ NAME: 'launch', __gonavi_locator_1_id: 7 }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'id', key: 'PRI' }, { name: 'name', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM main.events' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'main', 'main.events');
    expect(dataGridState.latestProps?.tableName).toBe('main.events');
    expect(dataGridState.latestProps?.pkColumns).toEqual(['id']);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['id'],
      valueColumns: ['__gonavi_locator_1_id'],
      hiddenColumns: ['__gonavi_locator_1_id'],
      writableColumns: {
        NAME: 'name',
      },
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('"id" AS "__gonavi_locator_1_id"');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('uses hidden DuckDB rowid when query results have no primary or unique key', async () => {
    storeState.connections[0].config.type = 'duckdb';
    storeState.connections[0].config.database = 'main';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_duckdb_rowid__'], rows: [{ NAME: 'launch', __gonavi_duckdb_rowid__: 17 }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'name', key: '' }],
    });
    backendApp.DBGetIndexes.mockResolvedValueOnce({
      success: true,
      data: [],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM main.events' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('main.events');
    expect(dataGridState.latestProps?.pkColumns).toEqual([]);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'duckdb-rowid',
      columns: ['rowid'],
      valueColumns: ['__gonavi_duckdb_rowid__'],
      hiddenColumns: ['__gonavi_duckdb_rowid__'],
      writableColumns: {
        NAME: 'name',
      },
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('rowid AS "__gonavi_duckdb_rowid__"');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('auto aliases Oracle duplicate explicit columns before alias star expansion', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'APP';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['EHR_USERID_1', 'USERID', 'EHR_USERID', 'USERNAME'],
        rows: [{
          EHR_USERID_1: 'emp-1',
          USERID: 7,
          EHR_USERID: 'emp-1',
          USERNAME: 'alice',
        }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'USERID', key: 'PRI' },
        { name: 'EHR_USERID', key: '' },
        { name: 'USERNAME', key: '' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'APP',
        query: 'SELECT EHR_USERID, a.* FROM S_USER_BASE a',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['USERID'],
      valueColumns: ['USERID'],
      writableColumns: {
        USERID: 'USERID',
        EHR_USERID: 'EHR_USERID',
        USERNAME: 'USERNAME',
      },
      readOnly: false,
    });
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('EHR_USERID AS EHR_USERID_1, a.*');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('keeps a multiline single-table result tied to its editable all-columns locator', async () => {
    const sql = [
      'SELECT a.COMPID, a.MEMCARDNO,',
      '  a.MODIFYUSER, a.MODIFYTIME',
      'FROM D_MEMBER_CARDTYPE_MODFIY_LOG a',
    ].join('\n');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['COMPID', 'MEMCARDNO', 'MODIFYUSER', 'MODIFYTIME'],
        rows: [{ COMPID: 1, MEMCARDNO: 'M-1', MODIFYUSER: 'admin', MODIFYTIME: '2026-07-10' }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'COMPID', key: '' },
        { name: 'MEMCARDNO', key: '' },
        { name: 'MODIFYUSER', key: '' },
        { name: 'MODIFYTIME', key: '' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('D_MEMBER_CARDTYPE_MODFIY_LOG');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(dataGridState.latestProps?.columnPinScope).toBeUndefined();
    renderer!.unmount();
  });

  it.each([
    ['leading line comments', '-- 1856887305879470081\n-- 3257969823961465780\nSELECT * FROM contract WHERE contract_code = \'YEC202608039\';'],
    ['leading block comments', '/* export batch: 3257963896428446491 */\nSELECT * FROM contract WHERE contract_code = \'YEC202608039\';'],
    ['leading hash comments', '# exported query\nSELECT * FROM contract WHERE contract_code = \'YEC202608039\';'],
    ['comments containing SQL join keywords', '/* JOIN notes from the previous export */\nSELECT * FROM contract WHERE contract_code = \'YEC202608039\';'],
    ['a comment between FROM and the table', 'SELECT * FROM /* primary contract source */ contract WHERE contract_code = \'YEC202608039\';'],
  ])('keeps a single-table result editable with %s', async (_label, sql) => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['id', 'contract_code'],
        rows: [{ id: 1, contract_code: 'YEC202608039' }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'id', key: 'PRI' },
        { name: 'contract_code', key: '' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: sql })} />);
    });
    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('contract');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['id'],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    renderer!.unmount();
  });

  it.each([
    'mysql',
    'mariadb',
    'oceanbase',
    'diros',
    'sphinx',
    'postgres',
    'kingbase',
    'highgo',
    'vastbase',
    'opengauss',
    'gaussdb',
    'sqlserver',
    'sqlite',
    'duckdb',
    'oracle',
    'dameng',
    'tdengine',
    'clickhouse',
  ])(
    'keeps aggregate query results silently read-only for %s',
    async (dbType) => {
      storeState.connections[0].config.type = dbType;
      storeState.connections[0].config.database = dbType === 'oracle' || dbType === 'dameng' ? 'APP' : 'main';
      backendApp.DBQueryMulti.mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['COUNT'], rows: [{ COUNT: 1 }] }],
      });

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({
          dbName: storeState.connections[0].config.database,
          query: 'SELECT count(1) FROM users',
        })} />);
      });

      await act(async () => {
        await findButton(renderer!, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const expectedTableName = dbType === 'oracle' || dbType === 'dameng' ? 'USERS' : 'users';
      expect(dataGridState.latestProps?.tableName).toBe(expectedTableName);
      expect(dataGridState.latestProps?.editLocator).toBeUndefined();
      expect(dataGridState.latestProps?.readOnly).toBe(true);
      expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
      expect(backendApp.DBGetIndexes).not.toHaveBeenCalled();
      expect(messageApi.warning).not.toHaveBeenCalled();
    },
  );
});

type ResultTabTestListener = (event: Record<string, unknown>) => void;

const createResultTabTestEventTarget = () => {
  const listeners = new Map<string, Set<ResultTabTestListener>>();
  return {
    addEventListener: vi.fn((type: string, listener: ResultTabTestListener) => {
      const registered = listeners.get(type) ?? new Set<ResultTabTestListener>();
      registered.add(listener);
      listeners.set(type, registered);
    }),
    removeEventListener: vi.fn((type: string, listener: ResultTabTestListener) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch(type: string, event: Record<string, unknown> = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener({ type, ...event });
      }
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
};

const createResultTabPointerCaptureTarget = (throwOnRelease = false) => {
  const eventTarget = createResultTabTestEventTarget();
  const capturedPointers = new Set<number>();
  return Object.assign(eventTarget, {
    setPointerCapture: vi.fn((pointerId: number) => {
      capturedPointers.add(pointerId);
    }),
    hasPointerCapture: vi.fn((pointerId: number) => capturedPointers.has(pointerId)),
    releasePointerCapture: vi.fn((pointerId: number) => {
      if (throwOnRelease) throw new Error('capture already released');
      capturedPointers.delete(pointerId);
    }),
  });
};

describe('QueryEditorResultsPanel result-tab detach lifecycle', () => {
  let renderer: ReactTestRenderer | null = null;
  let windowTarget: ReturnType<typeof createResultTabTestEventTarget> & Record<string, any>;
  let documentTarget: Record<string, any>;
  let classNames: Set<string>;
  let removeAllRanges: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    classNames = new Set<string>();
    removeAllRanges = vi.fn();
    windowTarget = Object.assign(createResultTabTestEventTarget(), {
      screenX: 0,
      screenY: 0,
      outerWidth: 1200,
      outerHeight: 800,
      innerWidth: 1200,
      innerHeight: 800,
      getSelection: vi.fn(() => ({ rangeCount: 1, removeAllRanges })),
    });
    documentTarget = {
      body: {
        style: {
          userSelect: 'text',
          webkitUserSelect: 'auto',
        },
      },
      documentElement: {
        classList: {
          add: vi.fn((className: string) => classNames.add(className)),
          remove: vi.fn((className: string) => classNames.delete(className)),
          contains: (className: string) => classNames.has(className),
        },
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('window', windowTarget);
    vi.stubGlobal('document', documentTarget);
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const renderDetachableResultPanel = async (onOpenResultInWindow = vi.fn()) => {
    await act(async () => {
      renderer = create(
        <QueryEditorResultsPanel
          resultSets={[{
            key: 'result-1',
            sql: 'select 1',
            rows: [{ value: 1 }],
            columns: ['value'],
            pkColumns: [],
            readOnly: true,
          }]}
          activeResultKey="result-1"
          isActive
          loading={false}
          executionError=""
          sqlLogCount={0}
          darkMode={false}
          isV2Ui
          currentDb="main"
          currentConnectionId="conn-1"
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={vi.fn()}
          onCloseOtherResultTabs={vi.fn()}
          onCloseResultTabsToLeft={vi.fn()}
          onCloseResultTabsToRight={vi.fn()}
          onCloseAllResultTabs={vi.fn()}
          onResultPinnedChange={vi.fn()}
          onOpenResultInWindow={onOpenResultInWindow}
          onReloadResult={vi.fn()}
          onResultPageChange={vi.fn()}
          onResultSort={vi.fn()}
          onDiagnoseExecutionError={vi.fn()}
        />,
      );
    });
  };

  const beginResultTabDrag = (captureTarget = createResultTabPointerCaptureTarget()) => {
    const resultTabLabel = renderer!.root.findAll((node) =>
      typeof node.props?.onPointerDown === 'function'
      && String(node.props?.className || '').split(/\s+/).includes('query-result-tab-label'),
    )[0];
    act(() => {
      resultTabLabel.props.onPointerDown({
        button: 0,
        buttons: 1,
        isPrimary: true,
        target: { closest: () => null },
        currentTarget: captureTarget,
        pointerId: 7,
        clientX: 100,
        clientY: 100,
        screenX: 300,
        screenY: 300,
      });
    });
    return captureTarget;
  };

  it('keeps the actual result table identity separate from metadata lookup names', async () => {
    await act(async () => {
      renderer = create(
        <QueryEditorResultsPanel
          resultSets={[{
            key: 'result-1',
            sql: 'select * from APP.USERS',
            rows: [{ id: 1 }],
            columns: ['id'],
            tableName: 'APP.USERS',
            metadataTableName: 'USERS',
            pkColumns: ['id'],
            readOnly: false,
          }]}
          activeResultKey="result-1"
          isActive
          loading={false}
          executionError=""
          sqlLogCount={0}
          darkMode={false}
          isV2Ui
          currentDb="APP"
          currentConnectionId="conn-1"
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={vi.fn()}
          onCloseOtherResultTabs={vi.fn()}
          onCloseResultTabsToLeft={vi.fn()}
          onCloseResultTabsToRight={vi.fn()}
          onCloseAllResultTabs={vi.fn()}
          onResultPinnedChange={vi.fn()}
          onOpenResultInWindow={vi.fn()}
          onReloadResult={vi.fn()}
          onResultPageChange={vi.fn()}
          onResultSort={vi.fn()}
          onDiagnoseExecutionError={vi.fn()}
        />,
      );
    });

    expect(dataGridState.latestProps?.tableName).toBe('APP.USERS');
    expect(dataGridState.latestProps?.dbName).toBe('APP');
  });

  it('restores selection state and removes global listeners when the window blurs', async () => {
    const onOpenResultInWindow = vi.fn();
    await renderDetachableResultPanel(onOpenResultInWindow);
    const captureTarget = beginResultTabDrag();

    act(() => {
      windowTarget.dispatch('pointermove', {
        pointerId: 7,
        buttons: 1,
        clientX: 120,
        clientY: 130,
        preventDefault: vi.fn(),
      });
    });

    expect(documentTarget.body.style.userSelect).toBe('none');
    expect(documentTarget.body.style.webkitUserSelect).toBe('none');
    expect(classNames.has('gn-result-tab-detaching')).toBe(true);
    expect(windowTarget.listenerCount('selectstart')).toBe(1);
    expect(windowTarget.listenerCount('dragstart')).toBe(1);
    expect(removeAllRanges).toHaveBeenCalled();

    act(() => {
      windowTarget.dispatch('blur');
      windowTarget.dispatch('blur');
      captureTarget.dispatch('lostpointercapture', { pointerId: 7 });
    });

    expect(documentTarget.body.style.userSelect).toBe('text');
    expect(documentTarget.body.style.webkitUserSelect).toBe('auto');
    expect(classNames.has('gn-result-tab-detaching')).toBe(false);
    expect(windowTarget.listenerCount('pointermove')).toBe(0);
    expect(windowTarget.listenerCount('pointerup')).toBe(0);
    expect(windowTarget.listenerCount('pointercancel')).toBe(0);
    expect(windowTarget.listenerCount('blur')).toBe(0);
    expect(windowTarget.listenerCount('selectstart')).toBe(0);
    expect(windowTarget.listenerCount('dragstart')).toBe(0);
    expect(captureTarget.listenerCount('lostpointercapture')).toBe(0);
    expect(captureTarget.releasePointerCapture).toHaveBeenCalledTimes(1);
    expect(onOpenResultInWindow).not.toHaveBeenCalled();
  });

  it('ignores other pointers and cleans up when the active pointer loses capture', async () => {
    await renderDetachableResultPanel();
    const captureTarget = beginResultTabDrag();

    act(() => {
      windowTarget.dispatch('pointermove', {
        pointerId: 9,
        buttons: 0,
        clientX: 180,
        clientY: 180,
        preventDefault: vi.fn(),
      });
      windowTarget.dispatch('pointerup', { pointerId: 9 });
      captureTarget.dispatch('lostpointercapture', { pointerId: 9 });
    });

    expect(windowTarget.listenerCount('pointermove')).toBe(1);
    expect(captureTarget.listenerCount('lostpointercapture')).toBe(1);
    expect(captureTarget.releasePointerCapture).not.toHaveBeenCalled();

    act(() => {
      captureTarget.dispatch('lostpointercapture', { pointerId: 7 });
    });

    expect(windowTarget.listenerCount('pointermove')).toBe(0);
    expect(windowTarget.listenerCount('pointerup')).toBe(0);
    expect(windowTarget.listenerCount('pointercancel')).toBe(0);
    expect(windowTarget.listenerCount('blur')).toBe(0);
    expect(captureTarget.listenerCount('lostpointercapture')).toBe(0);
  });

  it('self-heals on buttons=0 even when releasing pointer capture throws', async () => {
    const onOpenResultInWindow = vi.fn();
    await renderDetachableResultPanel(onOpenResultInWindow);
    const captureTarget = beginResultTabDrag(createResultTabPointerCaptureTarget(true));

    expect(() => {
      act(() => {
        windowTarget.dispatch('pointermove', {
          pointerId: 7,
          buttons: 0,
          clientX: 160,
          clientY: 160,
          preventDefault: vi.fn(),
        });
      });
    }).not.toThrow();

    expect(captureTarget.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(windowTarget.listenerCount('pointermove')).toBe(0);
    expect(windowTarget.listenerCount('pointerup')).toBe(0);
    expect(windowTarget.listenerCount('pointercancel')).toBe(0);
    expect(windowTarget.listenerCount('blur')).toBe(0);
    expect(captureTarget.listenerCount('lostpointercapture')).toBe(0);
    expect(onOpenResultInWindow).not.toHaveBeenCalled();
  });

  it('restores active drag state when the result panel unmounts', async () => {
    await renderDetachableResultPanel();
    const captureTarget = beginResultTabDrag();

    act(() => {
      windowTarget.dispatch('pointermove', {
        pointerId: 7,
        buttons: 1,
        clientX: 120,
        clientY: 130,
        preventDefault: vi.fn(),
      });
    });
    expect(classNames.has('gn-result-tab-detaching')).toBe(true);

    act(() => {
      renderer?.unmount();
    });
    renderer = null;

    expect(documentTarget.body.style.userSelect).toBe('text');
    expect(documentTarget.body.style.webkitUserSelect).toBe('auto');
    expect(classNames.has('gn-result-tab-detaching')).toBe(false);
    expect(windowTarget.listenerCount('pointermove')).toBe(0);
    expect(windowTarget.listenerCount('pointerup')).toBe(0);
    expect(windowTarget.listenerCount('pointercancel')).toBe(0);
    expect(windowTarget.listenerCount('blur')).toBe(0);
    expect(windowTarget.listenerCount('selectstart')).toBe(0);
    expect(windowTarget.listenerCount('dragstart')).toBe(0);
    expect(captureTarget.listenerCount('lostpointercapture')).toBe(0);
    expect(captureTarget.releasePointerCapture).toHaveBeenCalledWith(7);
  });
});
