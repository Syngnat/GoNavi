import React from 'react';
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage } from '../i18n';
import { catalogs } from '../i18n/catalog';
import { formatSqlExecutionError } from '../utils/sqlErrorSemantics';
import { I18nProvider } from '../i18n/provider';
import type { SavedQuery, TabData } from '../types';
import { ORACLE_ROWID_LOCATOR_COLUMN } from '../utils/rowLocator';
import { setGlobalImeCompositionActive } from '../utils/shortcuts';
import { clearQueryEditorResultSession } from '../utils/queryEditorResultSessionCache';
import { resolveNewQueryContext } from '../utils/newQueryContext';
import { QUERY_TAB_RENAME_REQUEST_EVENT } from '../utils/queryTabTitle';
import { clearQueryTabDraft, clearSQLFileTabDraft, getQueryTabDraft, getSQLFileTabDraft } from '../utils/sqlFileTabDrafts';
import { clearQueryEditorInlineRuntimeReadinessCache } from './queryEditor/QueryEditorAiAssist';
import QueryEditor, {
  collectQueryEditorObjectDecorationCandidates,
  resolveQueryEditorNavigationDecorations,
  resolveQueryEditorNavigationTarget,
} from './QueryEditor';
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

const createInlineAiHarnessService = (content = 'videos') => {
  const runId = 'query-editor-inline-run';
  const events = [
    {
      schemaVersion: 1,
      runId,
      sessionId: 'query-editor-inline-session',
      sessionGeneration: 1,
      sequence: 1,
      runRevision: 1,
      attempt: 1,
      timestamp: 1,
      kind: 'model_completed',
      resultingState: 'running_model',
      payload: { text: content },
    },
    {
      schemaVersion: 1,
      runId,
      sessionId: 'query-editor-inline-session',
      sessionGeneration: 1,
      sequence: 2,
      runRevision: 2,
      attempt: 1,
      timestamp: 2,
      kind: 'terminal',
      resultingState: 'completed',
      payload: { reason: 'completed' },
    },
  ];

  return {
    AIGetProviders: vi.fn(async () => [{
      id: 'openai-main',
      type: 'openai',
      name: 'OpenAI',
      apiKey: '',
      hasSecret: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5-mini',
      maxTokens: 2048,
      temperature: 0.2,
    }]),
    AIGetActiveProvider: vi.fn(async () => 'openai-main'),
    AIGetUserPromptSettings: vi.fn(async () => ({
      global: '',
      database: '',
      jvm: '',
      jvmDiagnostic: '',
    })),
    AISubmitAgentInput: vi.fn(async (request: { requestId: string }) => ({
      requestId: request.requestId,
      sessionId: 'query-editor-inline-session',
      runId,
      disposition: 'started',
      revision: 1,
      state: 'running_model',
    })),
    AIReadAgentRun: vi.fn(async (request: { afterSequence?: number }) => ({
      run: { id: runId, state: 'completed' },
      events: events.filter((event) => event.sequence > Number(request.afterSequence || 0)),
      hasMore: false,
    })),
  };
};

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
  activeContext: null as { connectionId: string; dbName: string } | null,
  setActiveContext: vi.fn(),
  updateQueryTabDraft: vi.fn(),
  savedQueries: [] as SavedQuery[],
  saveQuery: vi.fn(),
  theme: 'light',
  languagePreference: 'zh-CN' as 'zh-CN' | 'en-US',
  appearance: {
    uiVersion: 'legacy' as 'legacy' | 'v2',
    newQuerySqlTemplate: null as string | null,
    autoAddTableAlias: true,
    queryTableCtrlClickAction: 'open-design' as 'open-design' | 'locate',
  },
  sqlFormatOptions: { keywordCase: 'upper' as const },
  setSqlFormatOptions: vi.fn(),
  queryOptions: {
    maxRows: 5000,
    wordWrap: false,
    showColumnComment: true,
    showColumnType: true,
    showQueryResultsPanel: false,
    queryEditorEditorHeightRatio: 0.5,
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
    duplicateCurrentLine: {
      mac: { enabled: false, combo: '' },
      windows: { enabled: false, combo: '' },
    },
    saveQuery: {
      mac: { enabled: true, combo: 'Meta+S' },
      windows: { enabled: true, combo: 'Ctrl+S' },
    },
    saveQueryAs: {
      mac: { enabled: true, combo: 'Meta+Shift+S' },
      windows: { enabled: true, combo: 'Ctrl+Shift+S' },
    },
    toggleQueryResultsPanel: {
      mac: { enabled: true, combo: 'Meta+Shift+M' },
      windows: { enabled: true, combo: 'Ctrl+Shift+M' },
    },
    acceptSqlAiCompletion: {
      mac: { enabled: true, combo: 'Tab' },
      windows: { enabled: true, combo: 'Tab' },
    },
  },
  activeTabId: 'tab-1',
  tabs: [] as TabData[],
  aiPanelVisible: false,
  setAIPanelVisible: vi.fn(),
  sqlSnippets: [] as any[],
}));

const storeSubscribers = vi.hoisted(() => new Set<() => void>());
const runtimeEventListeners = vi.hoisted(() => new Map<string, Set<(...args: any[]) => void>>());

const runtimeApi = vi.hoisted(() => ({
  EventsOn: vi.fn((eventName: string, handler: (...args: any[]) => void) => {
    const listeners = runtimeEventListeners.get(eventName) ?? new Set<(...args: any[]) => void>();
    listeners.add(handler);
    runtimeEventListeners.set(eventName, listeners);
    return () => {
      const current = runtimeEventListeners.get(eventName);
      if (!current) {
        return;
      }
      current.delete(handler);
      if (current.size === 0) {
        runtimeEventListeners.delete(eventName);
      }
    };
  }),
  ClipboardSetText: vi.fn(async () => true),
  LogError: vi.fn(),
  LogInfo: vi.fn(),
}));

const notifyStoreSubscribers = () => {
  storeSubscribers.forEach((subscriber) => subscriber());
};

const backendApp = vi.hoisted(() => ({
  DBQuery: vi.fn(),
  DBQueryWithCancel: vi.fn(),
  DBQueryMulti: vi.fn(),
  DBQueryMultiInTransaction: vi.fn(),
  DBQueryMultiTransactional: vi.fn(),
  DBQueryAudited: vi.fn(),
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
  DBGetTriggers: vi.fn(),
  DBShowCreateTable: vi.fn(),
  CancelQuery: vi.fn(),
  GenerateQueryID: vi.fn(),
  WriteSQLFile: vi.fn(),
  ExportSQLFile: vi.fn(),
  InspectElasticsearchConsole: vi.fn(),
  ExecuteElasticsearchConsole: vi.fn(),
}));

const messageApi = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

const saveQueryNameInputFocus = vi.hoisted(() => vi.fn());

const dataGridState = vi.hoisted(() => ({
  latestProps: null as any,
}));

const tabsState = vi.hoisted(() => ({
  activeKey: undefined as string | undefined,
}));

const autoFetchState = vi.hoisted(() => ({
  visible: false,
}));

const antdSelectState = vi.hoisted(() => ({
  props: [] as any[],
}));

const monacoEditorMockState = vi.hoisted(() => ({
  deferOnMount: false,
  latestProps: null as any,
}));

const defaultEditorContributionResolver = (state: {
  contentHoverCalls: any[];
}) => (id: string) => {
  if (id === 'editor.contrib.contentHover') {
    return {
      showContentHover: vi.fn((range: any, mode: any, source: any, focus: any) => {
        state.contentHoverCalls.push({ range, mode, source, focus });
      }),
    };
  }
  return null;
};

const editorState = vi.hoisted(() => {
  const state = {
    value: '',
    editor: null as any,
    domNode: {
      style: { cursor: '' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      appendChild: vi.fn(),
      removeChild: vi.fn(),
    },
    position: { lineNumber: 1, column: 1 },
    selection: null as any,
    scrollLeft: 0,
    providers: [] as any[],
    providerLanguages: [] as string[],
    hoverProviders: [] as any[],
    hoverProviderLanguages: [] as string[],
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
    transformToUppercaseRun: vi.fn(),
    transformToLowercaseRun: vi.fn(),
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
    getContribution: vi.fn(),
    setSelection: vi.fn((selection: any) => {
      state.selection = selection;
    }),
    setSelections: vi.fn((selections: any[]) => {
      state.selection = Array.isArray(selections) ? selections[0] ?? null : null;
    }),
    getScrollLeft: vi.fn(() => state.scrollLeft),
    setScrollLeft: vi.fn((scrollLeft: number) => {
      state.scrollLeft = scrollLeft;
    }),
    executeEdits: vi.fn((_source: string, edits: any[]) => {
      edits.forEach((edit) => {
        const start = offsetAt({ lineNumber: edit.range.startLineNumber, column: edit.range.startColumn });
        const end = offsetAt({ lineNumber: edit.range.endLineNumber, column: edit.range.endColumn });
        state.value = state.value.slice(0, start) + edit.text + state.value.slice(end);
      });
    }),
    getAction: vi.fn((id: string) => {
      if (id === 'editor.action.transformToUppercase') {
        return { run: state.transformToUppercaseRun };
      }
      if (id === 'editor.action.transformToLowercase') {
        return { run: state.transformToLowercaseRun };
      }
      return null;
    }),
    addAction: vi.fn(),
    addCommand: vi.fn(),
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
    onDidScrollChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidLayoutChange: vi.fn(() => ({ dispose: vi.fn() })),
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
    createContextKey: vi.fn((_key: string, initialValue: boolean) => ({
      set: vi.fn(),
      get: vi.fn(() => initialValue),
      reset: vi.fn(),
    })),
    getScrolledVisiblePosition: vi.fn(() => ({ left: 0, top: 0, height: 20 })),
    getOption: vi.fn(() => null),
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

vi.mock('../../wailsjs/runtime', () => runtimeApi);

vi.mock('../../wailsjs/go/app/App', () => backendApp);

vi.mock('../utils/autoFetchVisibility', () => ({
  useAutoFetchVisibility: () => autoFetchState.visible,
}));

vi.mock('@monaco-editor/react', () => ({
  default: (props: any) => {
    const { defaultValue, onChange, onMount } = props;
    monacoEditorMockState.latestProps = props;
    React.useEffect(() => {
      editorState.value = String(defaultValue || '');
      editorState.latestOnChange = onChange;
      const mountEditor = () => onMount?.(editorState.editor, {
        editor: { setTheme: vi.fn() },
        KeyMod: { CtrlCmd: 2048, WinCtrl: 256, Alt: 512, Shift: 1024 },
        KeyCode: { Enter: 13, KeyD: 68, KeyE: 69, KeyF: 70, KeyM: 77, KeyQ: 81, KeyS: 83, RightArrow: 39 },
        languages: {
          CompletionItemKind: { Keyword: 1, Function: 2, Field: 3 },
          CompletionItemInsertTextRule: { InsertAsSnippet: 1 },
          registerCompletionItemProvider: vi.fn((language: string, provider: any) => {
            editorState.providerLanguages.push(language);
            editorState.providers.push(provider);
            return { dispose: vi.fn() };
          }),
          registerHoverProvider: vi.fn((language: string, provider: any) => {
            editorState.hoverProviderLanguages.push(language);
            editorState.hoverProviders.push(provider);
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
      if (monacoEditorMockState.deferOnMount) {
        const timer = setTimeout(mountEditor, 0);
        return () => clearTimeout(timer);
      }
      mountEditor();
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
  default: ({
    variant,
    executionError,
    onDiagnoseExecutionError,
  }: {
    variant?: string;
    executionError?: string;
    onDiagnoseExecutionError?: () => void;
  }) => (
    <div data-log-panel={variant}>
      SQL 执行日志
      {executionError ? ` 执行失败 ${executionError}` : ''}
      {onDiagnoseExecutionError ? <button onClick={onDiagnoseExecutionError}>AI diagnose</button> : null}
    </div>
  ),
}));

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span />;
  return {
    ArrowLeftOutlined: Icon,
    ArrowRightOutlined: Icon,
    BugOutlined: Icon,
    BulbOutlined: Icon,
    CheckOutlined: Icon,
    ClearOutlined: Icon,
    ClockCircleOutlined: Icon,
    CloseOutlined: Icon,
    CodeOutlined: Icon,
    ControlOutlined: Icon,
    CopyOutlined: Icon,
    DatabaseOutlined: Icon,
    DiffOutlined: Icon,
    DownOutlined: Icon,
    EditOutlined: Icon,
    EllipsisOutlined: Icon,
    ExportOutlined: Icon,
    EyeInvisibleOutlined: Icon,
    EyeOutlined: Icon,
    FileTextOutlined: Icon,
    FormatPainterOutlined: Icon,
    HistoryOutlined: Icon,
    KeyOutlined: Icon,
    PlayCircleOutlined: Icon,
    PushpinOutlined: Icon,
    RobotOutlined: Icon,
    SaveOutlined: Icon,
    SearchOutlined: Icon,
    SettingOutlined: Icon,
    StopOutlined: Icon,
    SyncOutlined: Icon,
    TableOutlined: Icon,
    ThunderboltOutlined: Icon,
    UndoOutlined: Icon,
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
  const Input: any = React.forwardRef(({ value, onChange, placeholder }: any, ref) => {
    React.useImperativeHandle(ref, () => ({
      focus: saveQueryNameInputFocus,
    }), []);
    return <input value={value} onChange={onChange} placeholder={placeholder} />;
  });
  Input.displayName = 'Input';
  Input.TextArea = ({ value, onChange, placeholder, disabled }: any) => (
    <textarea value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} />
  );

  const Modal = ({ children, open, onOk, okText = '确认', afterOpenChange }: any) => {
    React.useEffect(() => {
      if (open) {
        afterOpenChange?.(true);
      }
    }, [afterOpenChange, open]);

    return open ? (
      <section>
        {children}
        <button type="button" onClick={onOk}>{okText}</button>
      </section>
    ) : null;
  };
  const renderMenuItems = (items: any[] = []): React.ReactNode => items.map((item: any) => {
    if (!item || item.type === 'divider') return null;
    if (Array.isArray(item.children)) {
      return <React.Fragment key={item.key}>{renderMenuItems(item.children)}</React.Fragment>;
    }
    return (
      <button key={item.key} type="button" disabled={item.disabled} onClick={item.onClick}>
        {item.label}
      </button>
    );
  });

  return {
    Button,
    Space,
    Table,
    Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
    Empty,
    message: messageApi,
    Modal,
    Input,
    Form,
    Dropdown: ({ children, menu }: any) => (
      <>
        {children}
        {renderMenuItems(menu?.items)}
      </>
    ),
    Tooltip: ({ children }: any) => <>{children}</>,
    Select: (props: any) => {
      antdSelectState.props.push(props);
      return null;
    },
    Segmented: ({ value, onChange, options }: any) => (
      <div>
        {(options || []).map((option: any) => {
          const optionValue = typeof option === 'object' ? option.value : option;
          const label = typeof option === 'object' ? option.label : option;
          return (
            <button
              key={String(optionValue)}
              type="button"
              aria-pressed={value === optionValue}
              onClick={() => onChange?.(optionValue)}
            >
              {label}
            </button>
          );
        })}
      </div>
    ),
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

const textContent = (node: any): string =>
  (node.children || [])
    .map((item: any) => (typeof item === 'string' ? item : textContent(item)))
    .join('');

const findSqlLogTab = (renderer: ReactTestRenderer) => renderer.root.findAll(
  (node) => node.props?.['data-tab-key'] === '__gonavi_sql_execution_log__',
);

const queryResultMessageText = (renderer: ReactTestRenderer): string => {
  const values: string[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;
    if (typeof node.props?.['data-query-result-message-textarea'] === 'string') {
      values.push(String(node.props.value || ''));
    }
    walk(node.children || []);
  };
  walk(renderer.toJSON());
  return values.join('\n');
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

const findExactButton = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll((node) => node.type === 'button' && textContent(node) === text)[0];

const findEditorAction = (id: string) =>
  editorState.editor.addAction.mock.calls
    .map((call: any[]) => call[0])
    .reverse()
    .find((action: any) => action?.id === id);

const findEditorActionLabels = (id: string) =>
  editorState.editor.addAction.mock.calls
    .map((call: any[]) => call[0])
    .filter((action: any) => action?.id === id)
    .map((action: any) => action.label);

const findSqlCompletionProvider = () =>
  [...editorState.providers]
    .reverse()
    .find((provider: any) =>
      Array.isArray(provider?.triggerCharacters) && provider.triggerCharacters.includes('.'),
    );

const createSqlCompletionModel = (line: string, word: string) => ({
  getWordUntilPosition: () => ({
    word,
    startColumn: 1,
    endColumn: word.length + 1,
  }),
  getValue: () => line,
  getLineContent: () => line,
});

const getLastInjectedPrompt = (): string => {
  const dispatchCalls = (window.dispatchEvent as any).mock.calls;
  expect(dispatchCalls.length).toBeGreaterThan(0);
  const event = dispatchCalls[dispatchCalls.length - 1]?.[0];
  expect(event?.type).toBe('gonavi:ai:inject-prompt');
  return event?.detail?.prompt;
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

const createQueryEditorSplitNodeMock = (element: any) => {
  const className = String(element?.props?.className || '');
  if (className.includes('gn-v2-query-monaco-stage')) {
    return {
      style: {},
      getBoundingClientRect: () => ({ height: 300 }),
    };
  }
  if (className.includes('gn-v2-query-monaco-shell')) {
    return {
      style: {},
      getBoundingClientRect: () => ({ height: 300 }),
    };
  }
  if (className.includes('gn-v2-query-editor-pane')) {
    return {
      style: {},
      getBoundingClientRect: () => ({ height: 405 }),
    };
  }
  if (className.includes('gn-v2-query-editor')) {
    return {
      style: {},
      getBoundingClientRect: () => ({ height: 805 }),
    };
  }
  return null;
};

describe('QueryEditor external SQL save', () => {
  beforeEach(() => {
    clearQueryEditorInlineRuntimeReadinessCache();
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
      body: { nodeName: 'BODY', appendChild: vi.fn() },
      documentElement: { nodeName: 'HTML' },
      execCommand: vi.fn(() => true),
      createElement: vi.fn((tagName: string) => ({
        tagName: String(tagName || '').toUpperCase(),
        className: '',
        style: {},
        setAttribute: vi.fn(),
        focus: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
        remove: vi.fn(),
      })),
    });
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      platform: 'MacIntel',
      userAgent: 'Vitest',
    });
    setCurrentLanguage('zh-CN');
    storeState.languagePreference = 'zh-CN';
    storeState.shortcutOptions.runQuery.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.runQuery.windows = { enabled: false, combo: '' };
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: false, combo: '' };
    storeState.shortcutOptions.duplicateCurrentLine.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.duplicateCurrentLine.windows = { enabled: false, combo: '' };
    storeState.shortcutOptions.saveQuery.mac = { enabled: true, combo: 'Meta+S' };
    storeState.shortcutOptions.saveQuery.windows = { enabled: true, combo: 'Ctrl+S' };
    storeState.shortcutOptions.saveQueryAs.mac = { enabled: true, combo: 'Meta+Shift+S' };
    storeState.shortcutOptions.saveQueryAs.windows = { enabled: true, combo: 'Ctrl+Shift+S' };
    runtimeApi.EventsOn.mockClear();
    runtimeApi.LogError.mockReset();
    runtimeApi.LogInfo.mockReset();
    runtimeEventListeners.clear();
    storeState.addTab.mockReset();
    storeState.setActiveContext.mockReset();
    storeState.activeContext = null;
    storeState.setActiveContext.mockImplementation((context: { connectionId: string; dbName: string } | null) => {
      storeState.activeContext = context;
    });
    storeState.saveQuery.mockReset();
    storeState.saveQuery.mockImplementation(async (query: SavedQuery) => query);
    storeState.savedQueries = [];
    storeState.activeTabId = 'tab-1';
    storeState.tabs = [];
    storeState.aiPanelVisible = false;
    storeState.setAIPanelVisible.mockReset();
    storeState.appearance.uiVersion = 'legacy';
    storeState.appearance.newQuerySqlTemplate = null;
    storeState.appearance.autoAddTableAlias = true;
    storeState.appearance.queryTableCtrlClickAction = 'open-design';
    storeState.queryOptions = {
      maxRows: 5000,
      wordWrap: false,
      showColumnComment: true,
      showColumnType: true,
      showQueryResultsPanel: false,
      queryEditorEditorHeightRatio: 0.5,
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
      duplicateCurrentLine: {
        mac: { enabled: false, combo: '' },
        windows: { enabled: false, combo: '' },
      },
      saveQuery: {
        mac: { enabled: true, combo: 'Meta+S' },
        windows: { enabled: true, combo: 'Ctrl+S' },
      },
      saveQueryAs: {
        mac: { enabled: true, combo: 'Meta+Shift+S' },
        windows: { enabled: true, combo: 'Ctrl+Shift+S' },
      },
      toggleQueryResultsPanel: {
        mac: { enabled: true, combo: 'Meta+Shift+M' },
        windows: { enabled: true, combo: 'Ctrl+Shift+M' },
      },
      acceptSqlAiCompletion: {
        mac: { enabled: true, combo: 'Tab' },
        windows: { enabled: true, combo: 'Tab' },
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
    messageApi.success.mockReset();
    messageApi.error.mockReset();
    messageApi.info.mockReset();
    messageApi.warning.mockReset();
    saveQueryNameInputFocus.mockReset();
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });
    backendApp.WriteSQLFile.mockResolvedValue({ success: true });
    backendApp.ExportSQLFile.mockResolvedValue({ success: true });
    backendApp.DBQueryWithCancel.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryMulti.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryMultiInTransaction.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryMultiTransactional.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQueryAudited.mockResolvedValue({ success: true, data: [] });
    backendApp.DBCommitTransaction.mockResolvedValue({ success: true, message: '事务已提交' });
    backendApp.DBCommitTransactionWithTrigger.mockResolvedValue({ success: true, message: '事务已提交' });
    backendApp.DBRollbackTransaction.mockResolvedValue({ success: true, message: '事务已回滚' });
    backendApp.DBRollbackTransactionWithTrigger.mockResolvedValue({ success: true, message: '事务已回滚' });
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetIndexes.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTriggers.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBTableExists.mockResolvedValue({ success: true, data: { exists: true } });
    backendApp.DBShowCreateTable.mockResolvedValue({ success: false, data: '' });
    backendApp.GenerateQueryID.mockResolvedValue('query-1');
    backendApp.InspectElasticsearchConsole.mockResolvedValue({
      success: true,
      requests: [],
      containsWrite: false,
      requiresConfirmation: false,
      fingerprint: 'inspection-default',
    });
    backendApp.ExecuteElasticsearchConsole.mockResolvedValue({ success: true, results: [] });
    storeState.connections = createDefaultConnections();
    storeState.sqlLogs = [];
    storeState.addSqlLog.mockReset();
    storeState.sqlSnippets = [];
    storeState.clearSqlLogs.mockReset();
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    storeState.appearance.uiVersion = 'legacy';
    autoFetchState.visible = false;
    antdSelectState.props = [];
    dataGridState.latestProps = null;
    tabsState.activeKey = undefined;
    editorState.value = '';
    editorState.position = { lineNumber: 1, column: 1 };
    editorState.selection = null;
    editorState.scrollLeft = 0;
    monacoEditorMockState.latestProps = null;
    editorState.domNode.style.cursor = '';
    editorState.providers = [];
    editorState.providerLanguages = [];
    editorState.hoverProviders = [];
    editorState.hoverProviderLanguages = [];
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
    editorState.editor.getValue.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();
    editorState.editor.setValue.mockClear();
    editorState.editor.executeEdits.mockClear();
    editorState.editor.getAction.mockClear();
    editorState.transformToUppercaseRun.mockReset();
    editorState.transformToLowercaseRun.mockReset();
    editorState.editor.getScrollLeft.mockClear();
    editorState.editor.setScrollLeft.mockClear();
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.updateOptions.mockClear();
    editorState.editor.pushUndoStop.mockClear();
    editorState.editor.addAction.mockClear();
    editorState.editor.onKeyDown.mockClear();
    editorState.editor.getContribution.mockReset();
    editorState.editor.getContribution.mockImplementation(defaultEditorContributionResolver(editorState));
    storeState.updateQueryTabDraft.mockReset();
    storeSubscribers.clear();
    editorState.editor.layout.mockClear();
    editorState.editor.trigger.mockClear();
    clearQueryTabDraft('tab-1');
    clearQueryTabDraft('tab-2');
    clearSQLFileTabDraft('tab-1');
    clearSQLFileTabDraft('tab-2');
    setGlobalImeCompositionActive(false);
    monacoEditorMockState.deferOnMount = false;
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

  it('shows the default SQL template for a fresh blank query tab', async () => {
    await act(async () => {
      create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    expect(editorState.value).toBe('SELECT * FROM ');
  });

  it('uses the customized new query template for a fresh blank query tab', async () => {
    storeState.appearance.newQuerySqlTemplate = 'SELECT id,\n       name\nFROM users;';

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    expect(editorState.value).toBe('SELECT id,\n       name\nFROM users;');
  });

  it('allows a blank new query template when the default content is cleared', async () => {
    storeState.appearance.newQuerySqlTemplate = '';

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    expect(editorState.value).toBe('');
  });

  it('keeps the query results panel hidden by default on first entry', async () => {
    storeState.appearance.uiVersion = 'v2';

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <I18nProvider preference="zh-CN" onPreferenceChange={() => undefined}>
          <QueryEditor tab={createTab()} />
        </I18nProvider>,
      );
    });

    expect(textContent(renderer.toJSON())).not.toContain('等待执行 SQL');
  });

  it('renders the v2 SQL toolbar actions as icon-only buttons', async () => {
    storeState.appearance.uiVersion = 'v2';

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    const exactLabels = [
      '运行',
      '保存',
      'AI · 更多',
      '更多',
      '搜索',
      '开启自动换行',
      '美化 SQL',
      '美化 SQL · 设置',
    ];
    const iconOnlyButtons = exactLabels.map((label) => renderer.root.find(
      (node) => node.type === 'button' && node.props?.['aria-label'] === label,
    ));
    iconOnlyButtons.push(renderer.root.find(
      (node) => node.type === 'button'
        && String(node.props?.['aria-label'] || '').startsWith('触发 SQL AI 自动补全'),
    ));

    for (const button of iconOnlyButtons) {
      expect(textContent(button)).toBe('');
      expect(button.props.className).toContain('gn-v2-query-toolbar-icon-action');
    }

    await act(async () => {
      renderer.unmount();
    });
  });

  it('refreshes Elasticsearch index choices and the sidebar after a successful index write', async () => {
    storeState.connections[0].config.type = 'elasticsearch';
    storeState.connections[0].config.port = 9200;
    backendApp.InspectElasticsearchConsole.mockImplementation(
      (_config: unknown, _defaultIndex: string, source: string) => Promise.resolve(
        source === 'GET /'
          ? {
              success: true,
              requests: [{ method: 'GET', path: '/', route: '/', risk: 'read' }],
              containsWrite: false,
              requiresConfirmation: false,
              fingerprint: 'inspect-root',
              serverMajor: 8,
            }
          : {
              success: true,
              requests: [{ method: 'PUT', path: '/events-2026', route: '/{target}', target: 'events-2026', risk: 'dangerous' }],
              containsWrite: true,
              requiresConfirmation: false,
              fingerprint: 'create-events-2026',
              serverMajor: 8,
            },
      ),
    );
    backendApp.ExecuteElasticsearchConsole.mockResolvedValue({
      success: true,
      results: [{
        index: 0,
        method: 'PUT',
        path: '/events-2026',
        requestLabel: 'PUT /events-2026',
        httpStatus: 200,
        rawResponse: '{"acknowledged":true}',
        outcome: 'success',
        readOnly: false,
      }],
    });
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'events-2026' }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: '',
        query: 'PUT /events-2026\n{}',
      })} />);
      await Promise.resolve();
    });

    await act(async () => {
      await findButton(renderer, '运行当前请求').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
    expect(antdSelectState.props.some((props) => (
      Array.isArray(props.options)
      && props.options.some((option: any) => option?.value === 'events-2026')
    ))).toBe(true);
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:sidebar-database-list-refresh',
      detail: expect.objectContaining({
        connectionId: 'conn-1',
        reason: 'elasticsearch-write',
      }),
    }));
  });

  it('loads PostgreSQL schemas and executes SQL with the selected search_path', async () => {
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.port = 5432;
    (storeState.connections[0].config as any).connectionParams = 'application_name=gonavi';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }],
    });
    backendApp.DBQuery.mockImplementation((_config: unknown, _dbName: string, sql: string) => {
      const normalizedSql = String(sql || '').toLowerCase();
      if (normalizedSql.includes('current_schema()')) {
        return Promise.resolve({ success: true, data: [{ schema_name: 'public' }] });
      }
      if (normalizedSql.includes('pg_namespace')) {
        return Promise.resolve({
          success: true,
          data: [{ schema_name: 'public' }, { schema_name: 'sales' }],
        });
      }
      return Promise.resolve({ success: true, data: [] });
    });
    backendApp.DBGetColumns.mockResolvedValue({
      success: true,
      data: [{ name: 'sales_id', key: 'PRI' }, { name: 'name', key: '' }],
    });
    backendApp.DBGetIndexes.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'public.users' }, { Table: 'sales.users' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE sales.users(id bigint primary key)',
    });
    backendApp.DBQueryMulti.mockResolvedValue({
      success: true,
      data: [{ columns: ['sales_id', 'name'], rows: [{ sales_id: 1, name: 'Alice' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: 'SELECT * FROM users',
        schemaName: 'removed_schema',
      })} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const latestSchemaSelect = () => [...antdSelectState.props].reverse().find((props) => (
      String(props.className || '').includes('gn-v2-query-toolbar-schema-select')
      || props['aria-label'] === catalogs['zh-CN']['query_editor.object_info.label.schema']
    ));
    expect(latestSchemaSelect()).toMatchObject({
      value: 'removed_schema',
      options: [
        { label: 'removed_schema', value: 'removed_schema', title: '', fullName: 'removed_schema' },
        { label: 'public', value: 'public', title: '', fullName: 'public' },
        { label: 'sales', value: 'sales', title: '', fullName: 'sales' },
      ],
    });

    await act(async () => {
      latestSchemaSelect()?.onChange('sales');
      await Promise.resolve();
      await Promise.resolve();
    });
    const ddlHover = await editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT * FROM users'.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'postgres' }),
      'main',
      'sales.users',
    );
    expect(ddlHover?.contents?.[0]?.value).toContain('CREATE TABLE sales.users');

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });

    const executionConfig = backendApp.DBQueryMulti.mock.calls[0]?.[0];
    const connectionParams = new URLSearchParams(String(executionConfig?.connectionParams || ''));
    expect(connectionParams.get('application_name')).toBe('gonavi');
    expect(connectionParams.get('search_path')).toBe('"sales","public"');
    const locatorColumnsCall = backendApp.DBGetColumns.mock.calls.find((call) => call[2] === 'users');
    const locatorIndexesCall = backendApp.DBGetIndexes.mock.calls.find((call) => call[2] === 'users');
    expect(new URLSearchParams(String(locatorColumnsCall?.[0]?.connectionParams || '')).get('search_path'))
      .toBe('"sales","public"');
    expect(new URLSearchParams(String(locatorIndexesCall?.[0]?.connectionParams || '')).get('search_path'))
      .toBe('"sales","public"');
    expect(dataGridState.latestProps?.pkColumns).toEqual(['sales_id']);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['sales_id'],
    });
    const resultConnectionParams = new URLSearchParams(String(
      dataGridState.latestProps?.connectionParamsOverride || '',
    ));
    expect(resultConnectionParams.get('application_name')).toBe('gonavi');
    expect(resultConnectionParams.get('search_path')).toBe('"sales","public"');
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      schemaName: 'sales',
    });

    await act(async () => {
      latestSchemaSelect()?.onChange('public');
    });
    backendApp.DBQueryMulti.mockClear();
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['sales_id', 'name'], rows: [{ sales_id: 2, name: 'Bob' }] }],
    });
    await act(async () => {
      await dataGridState.latestProps?.onReload?.();
    });
    const reloadConfig = backendApp.DBQueryMulti.mock.calls[0]?.[0];
    expect(new URLSearchParams(String(reloadConfig?.connectionParams || '')).get('search_path'))
      .toBe('"sales","public"');
  });

  it('does not reload an old database result through the current managed transaction', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['id'], rows: [{ id: 1 }] }],
    });
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-archive',
      transactionPending: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT id FROM users' })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    const oldResultProps = dataGridState.latestProps;
    expect(oldResultProps?.onReload).toEqual(expect.any(Function));

    const databaseSelect = [...antdSelectState.props].reverse().find((props) => (
      props.placeholder === catalogs['zh-CN']['query_editor.placeholder.database']
    ));
    await act(async () => {
      databaseSelect?.onChange('archive');
      await Promise.resolve();
    });

    editorState.value = "UPDATE users SET name = 'archived' WHERE id = 1";
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-archive',
      dbName: 'archive',
    });

    backendApp.DBQueryMulti.mockClear();
    backendApp.DBQueryMultiInTransaction.mockClear();
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['id'], rows: [{ id: 2 }] }],
    });
    await act(async () => {
      await oldResultProps.onReload();
    });

    expect(backendApp.DBQueryMultiInTransaction).not.toHaveBeenCalled();
    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('SELECT id FROM users'),
      expect.any(String),
    );
  });

  it('shows the empty query results panel after toggling the results button', async () => {
    storeState.appearance.uiVersion = 'v2';

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <I18nProvider preference="zh-CN" onPreferenceChange={() => undefined}>
          <QueryEditor tab={createTab()} />
        </I18nProvider>,
      );
    });

    await act(async () => {
      findButton(renderer, '结果').props.onClick();
    });

    expect(findSqlLogTab(renderer)).toHaveLength(1);
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      resultPanelVisible: true,
    });
  });

  it('hides the expanded empty query results panel from the inline hide action', async () => {
    storeState.appearance.uiVersion = 'v2';

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    await act(async () => {
      findButton(renderer, '结果').props.onClick();
    });
    expect(findSqlLogTab(renderer)).toHaveLength(1);

    await act(async () => {
      findButton(renderer, '隐藏').props.onClick();
    });

    expect(textContent(renderer.toJSON())).not.toContain('等待执行 SQL');
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', {
      resultPanelVisible: false,
    });
  });

  it('auto expands the query results panel after a successful execution returns rows', async () => {
    storeState.appearance.uiVersion = 'v2';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['value'], rows: [{ value: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT 1 AS value' })} />);
    });

    expect(textContent(renderer.toJSON())).not.toContain('结果 1');

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer.toJSON())).toContain('结果 1');
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      resultPanelVisible: true,
    });
  });

  it('keeps the inline hide action available after query results render rows', async () => {
    storeState.appearance.uiVersion = 'v2';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['value'], rows: [{ value: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT 1 AS value' })} />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textContent(renderer.toJSON())).toContain('结果 1');

    const hideButton = renderer.root.find(
      (node) => node.type === 'button' && node.props['aria-label'] === '隐藏结果区',
    );
    expect(textContent(hideButton)).toBe('');
    expect(hideButton.props.className).toContain('gn-v2-data-grid-toolbar-action');

    await act(async () => {
      hideButton.props.onClick();
    });

    expect(textContent(renderer.toJSON())).not.toContain('结果 1');
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', {
      resultPanelVisible: false,
    });
  });

  it('toggles the query results panel with Ctrl/Cmd+Shift+M', async () => {
    storeState.appearance.uiVersion = 'v2';

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    const toggleAction = editorState.editor.addAction.mock.calls
      .map((call: any[]) => call[0])
      .find((action: any) => action?.id === 'gonavi.toggleQueryResultsPanel');
    expect(toggleAction).toMatchObject({
      label: 'GoNavi: 切换结果区',
    });
    expect(toggleAction?.keybindings?.[0]).toBeGreaterThan(0);

    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const createToggleEvent = () => ({
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: true,
      key: 'm',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    const firstEvent = createToggleEvent();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(firstEvent));
    });

    expect(firstEvent.preventDefault).toHaveBeenCalled();
    expect(firstEvent.stopPropagation).toHaveBeenCalled();
    expect(findSqlLogTab(renderer)).toHaveLength(1);

    const secondEvent = createToggleEvent();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(secondEvent));
    });

    expect(secondEvent.preventDefault).toHaveBeenCalled();
    expect(secondEvent.stopPropagation).toHaveBeenCalled();
    expect(textContent(renderer.toJSON())).not.toContain('等待执行 SQL');
  });

  it('captures the manual SQL AI completion shortcut before Monaco inserts a backslash', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    editorState.editor.focus.mockClear();
    const shortcutEvent = {
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Process',
      code: 'Backslash',
      keyCode: 220,
      which: 220,
      isComposing: false,
      nativeEvent: {
        code: 'Backslash',
        keyCode: 220,
        which: 220,
        isComposing: false,
      },
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const monacoShortcutEvent = {
      browserEvent: shortcutEvent,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
    });

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(shortcutEvent));
    });

    expect(monacoShortcutEvent.preventDefault).toHaveBeenCalled();
    expect(monacoShortcutEvent.stopPropagation).toHaveBeenCalled();
    expect(shortcutEvent.preventDefault).toHaveBeenCalled();
    expect(shortcutEvent.stopPropagation).toHaveBeenCalled();
    expect(editorState.editor.focus).toHaveBeenCalled();
    expect(editorState.value).toBe('SELECT * FROM ');
  });

  it('treats a sticky Alt modifier plus Backslash as the manual SQL AI completion shortcut', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    const altDownEvent = {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Alt',
      code: 'AltLeft',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const backslashEvent = {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      key: '\\',
      code: 'Backslash',
      keyCode: 220,
      which: 220,
      nativeEvent: {
        code: 'Backslash',
        keyCode: 220,
        which: 220,
      },
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(altDownEvent));
      windowListeners.keydown?.forEach((listener) => listener(backslashEvent));
    });

    expect(backslashEvent.preventDefault).toHaveBeenCalled();
    expect(backslashEvent.stopPropagation).toHaveBeenCalled();
    expect(editorState.value).toBe('SELECT * FROM ');
  });

  it('treats a sticky Alt modifier plus IntlBackslash layout event as the manual SQL AI completion shortcut', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    const altDownEvent = {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Alt',
      code: 'AltLeft',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const backslashEvent = {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      key: 'Process',
      code: 'IntlBackslash',
      keyCode: 226,
      which: 226,
      nativeEvent: {
        code: 'IntlBackslash',
        keyCode: 226,
        which: 226,
      },
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(altDownEvent));
      windowListeners.keydown?.forEach((listener) => listener(backslashEvent));
    });

    expect(backslashEvent.preventDefault).toHaveBeenCalled();
    expect(backslashEvent.stopPropagation).toHaveBeenCalled();
    expect(editorState.value).toBe('SELECT * FROM ');
  });

  it('recovers a missed manual SQL AI completion keystroke by removing the inserted backslash', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    editorState.editor.focus.mockClear();
    editorState.editor.executeEdits.mockClear();

    const altDownEvent = {
      type: 'keydown',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Alt',
      code: 'AltLeft',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const unmatchedMonacoShortcutEvent = {
      browserEvent: {
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: 'Process',
        code: '',
        keyCode: 0,
        which: 0,
        isComposing: false,
        nativeEvent: {
          code: '',
          keyCode: 0,
          which: 0,
          isComposing: false,
        },
        target: null,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(altDownEvent));
      editorState.keyDownListeners.forEach((listener) => listener(unmatchedMonacoShortcutEvent));
    });

    editorState.value = 'SELECT * FROM \\';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM \\'.length + 1 };

    await act(async () => {
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{
          text: '\\',
        }],
      }));
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-trigger-sql-ai-completion-fallback',
      [expect.objectContaining({
        text: '',
      })],
    );
    expect(editorState.value).toBe('SELECT * FROM ');
    expect(editorState.editor.focus).toHaveBeenCalled();
  });

  it('recovers a stray backslash in table completion context even when the desktop keydown is not observable', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    editorState.editor.executeEdits.mockClear();
    editorState.editor.focus.mockClear();

    editorState.value = 'SELECT * FROM \\';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM \\'.length + 1 };

    await act(async () => {
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{
          text: '\\',
          rangeOffset: 'SELECT * FROM '.length,
          rangeLength: 0,
        }],
      }));
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-trigger-sql-ai-completion-fallback',
      [expect.objectContaining({
        text: '',
      })],
    );
    expect(editorState.value).toBe('SELECT * FROM ');
    expect(editorState.editor.focus).toHaveBeenCalled();
  });

  it('recovers a stray backslash from content-change range data even when the cursor is still stale', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    editorState.editor.executeEdits.mockClear();
    editorState.editor.focus.mockClear();

    editorState.value = 'SELECT * FROM \\';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM '.length + 1 };

    await act(async () => {
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{
          text: '\\',
          range: {
            startLineNumber: 1,
            startColumn: 'SELECT * FROM '.length + 1,
            endLineNumber: 1,
            endColumn: 'SELECT * FROM '.length + 1,
          },
        }],
      }));
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-trigger-sql-ai-completion-fallback',
      [expect.objectContaining({
        text: '',
      })],
    );
    expect(editorState.value).toBe('SELECT * FROM ');
  });

  it('does not fall back to structured SQL suggestions when manual AI completion is triggered in table-name context', async () => {
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { TABLE_NAME: 'videos' },
        { TABLE_NAME: 'visits' },
      ],
    });

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ', dbName: 'main' })} />);
    });

    editorState.value = 'SELECT * FROM ';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM '.length + 1 };
    editorState.editor.trigger.mockClear();

    const shortcutEvent = {
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Process',
      code: 'Backslash',
      keyCode: 220,
      which: 220,
      isComposing: false,
      nativeEvent: {
        code: 'Backslash',
        keyCode: 220,
        which: 220,
        isComposing: false,
      },
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const monacoShortcutEvent = {
      browserEvent: shortcutEvent,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
      'gonavi-ai-inline-manual',
      'editor.action.triggerSuggest',
      undefined,
    );
  });

  it('uses grounded AI inline ghost when manual completion is triggered in table-name context and inline AI is available', async () => {
    const inlineAiService = createInlineAiHarnessService();
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { TABLE_NAME: 'videos' },
        { TABLE_NAME: 'visits' },
      ],
    });

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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
      go: {
        aiservice: {
          Service: inlineAiService,
        },
      },
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ', dbName: 'main' })} />);
    });

    editorState.value = 'SELECT * FROM ';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM '.length + 1 };
    editorState.editor.trigger.mockClear();
    editorState.domNode.appendChild.mockClear();

    const shortcutEvent = {
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Process',
      code: 'Backslash',
      keyCode: 220,
      which: 220,
      isComposing: false,
      nativeEvent: {
        code: 'Backslash',
        keyCode: 220,
        which: 220,
        isComposing: false,
      },
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const monacoShortcutEvent = {
      browserEvent: shortcutEvent,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(inlineAiService.AISubmitAgentInput).toHaveBeenCalledTimes(1);
    expect(editorState.domNode.appendChild).toHaveBeenCalled();
    const ghostOverlay = editorState.domNode.appendChild.mock.calls[
      editorState.domNode.appendChild.mock.calls.length - 1
    ]?.[0];
    expect(ghostOverlay?.className).toBe('gonavi-query-editor-ai-inline-ghost-overlay');
    expect(ghostOverlay?.textContent).toBe('videos');
    expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
      'gonavi-ai-inline-manual',
      'editor.action.triggerSuggest',
      undefined,
    );
  });

  it('uses local SQL memory for manual inline completion in an empty editor', async () => {
    storeState.sqlLogs = [{
      id: 'sql-log-1',
      timestamp: Date.now(),
      sql: 'SELECT * FROM videos WHERE code = ?;',
      status: 'success',
      duration: 12,
      dbName: 'main',
    } as any];

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });

    editorState.value = '';
    editorState.position = { lineNumber: 1, column: 1 };
    editorState.editor.trigger.mockClear();
    editorState.domNode.appendChild.mockClear();

    const shortcutEvent = {
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      key: 'Process',
      code: 'Backslash',
      keyCode: 220,
      which: 220,
      isComposing: false,
      nativeEvent: {
        code: 'Backslash',
        keyCode: 220,
        which: 220,
        isComposing: false,
      },
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const monacoShortcutEvent = {
      browserEvent: shortcutEvent,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.value).toBe('');
    expect(editorState.domNode.appendChild).toHaveBeenCalled();
    const ghostOverlay = editorState.domNode.appendChild.mock.calls[
      editorState.domNode.appendChild.mock.calls.length - 1
    ]?.[0];
    expect(ghostOverlay?.className).toBe('gonavi-query-editor-ai-inline-ghost-overlay');
    expect(ghostOverlay?.textContent).toBe('SELECT * FROM videos WHERE code = ?;');
    expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
      'gonavi-ai-inline-manual',
      'editor.action.triggerSuggest',
      undefined,
    );
  });

  it('uses local SQL memory for automatic inline completion in update table context', async () => {
    vi.useFakeTimers();
    try {
      storeState.sqlLogs = [{
        id: 'sql-log-2',
        timestamp: Date.now(),
        sql: 'UPDATE videos SET status = 1 WHERE id = ?;',
        status: 'success',
        duration: 9,
        dbName: 'main',
      } as any];

      const windowListeners: Record<string, ((event?: any) => void)[]> = {};
      vi.stubGlobal('window', {
        addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
          windowListeners[type] ||= [];
          windowListeners[type].push(listener);
        }),
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

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'UPDAT', dbName: 'main' })} />);
      });

      editorState.value = 'UPDATE';
      editorState.position = { lineNumber: 1, column: 'UPDATE'.length + 1 };
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('UPDATE');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'E' }],
        }));
        vi.advanceTimersByTime(120);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(editorState.domNode.appendChild).toHaveBeenCalled();
      const ghostOverlay = editorState.domNode.appendChild.mock.calls[
        editorState.domNode.appendChild.mock.calls.length - 1
      ]?.[0];
      expect(ghostOverlay?.className).toBe('gonavi-query-editor-ai-inline-ghost-overlay');
      expect(ghostOverlay?.textContent).toBe(' videos SET status = 1 WHERE id = ?;');
      expect(editorState.editor.trigger).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restore a table alias from SQL memory when automatic table aliases are disabled', async () => {
    vi.useFakeTimers();
    try {
      storeState.appearance.autoAddTableAlias = false;
      storeState.sqlLogs = [{
        id: 'sql-log-table-alias-memory',
        timestamp: Date.now(),
        sql: 'SELECT * FROM system_user AS su WHERE su.id = ?;',
        status: 'success',
        duration: 9,
        dbName: 'main',
      } as any];

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT * FROM system_user ';
      editorState.position = { lineNumber: 1, column: editorState.value.length + 1 };
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.(editorState.value);
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: ' ' }],
        }));
        vi.advanceTimersByTime(120);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(editorState.domNode.appendChild).not.toHaveBeenCalled();
      expect(editorState.editor.trigger).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a metadata-normalized inline ghost with the default Tab shortcut and preserves trailing SQL', async () => {
    vi.useFakeTimers();
    try {
      storeState.sqlLogs = [{
        id: 'sql-log-inline-case',
        timestamp: Date.now(),
        sql: 'SELECT * FROM a_cninfo_announcement WHERE id = 1;',
        status: 'success',
        duration: 12,
        dbName: 'main',
      } as any];

      const inlineAiService = createInlineAiHarnessService();
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [
          { TABLE_NAME: 'a_cninfo_announcement' },
        ],
      });

      const windowListeners: Record<string, ((event?: any) => void)[]> = {};
      vi.stubGlobal('window', {
        addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
          windowListeners[type] ||= [];
          windowListeners[type].push(listener);
        }),
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
        go: {
          aiservice: {
            Service: inlineAiService,
          },
        },
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELECT * FROM A_C', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT * FROM A_C';
      editorState.position = { lineNumber: 1, column: 'SELECT * FROM A_C'.length + 1 };
      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('SELECT * FROM A_C');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'C' }],
        }));
        vi.advanceTimersByTime(220);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      const ghostOverlay = editorState.domNode.appendChild.mock.calls[
        editorState.domNode.appendChild.mock.calls.length - 1
      ]?.[0];
      expect(ghostOverlay?.textContent).toBe('ninfo_announcement WHERE id = 1;');

      const shortcutEvent = {
        type: 'keydown',
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        which: 9,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      const monacoShortcutEvent = {
        browserEvent: shortcutEvent,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };

      await act(async () => {
        editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ai-inline-sql-completion',
        [expect.objectContaining({
          text: 'a_cninfo_announcement WHERE id = 1;',
          range: expect.objectContaining({
            startColumn: 15,
            endColumn: 18,
          }),
        })],
      );
      expect(editorState.value).toBe('SELECT * FROM a_cninfo_announcement WHERE id = 1;');
      expect(inlineAiService.AISubmitAgentInput).not.toHaveBeenCalled();
      expect(monacoShortcutEvent.preventDefault).toHaveBeenCalled();
      expect(monacoShortcutEvent.stopPropagation).toHaveBeenCalled();
      expect(shortcutEvent.preventDefault).toHaveBeenCalled();
      expect(shortcutEvent.stopPropagation).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not consume Tab when no AI inline ghost is visible', async () => {
    vi.useFakeTimers();
    try {
      const windowListeners: Record<string, ((event?: any) => void)[]> = {};
      vi.stubGlobal('window', {
        addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
          windowListeners[type] ||= [];
          windowListeners[type].push(listener);
        }),
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

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELECT', dbName: 'main' })} />);
      });

      editorState.editor.executeEdits.mockClear();

      const shortcutEvent = {
        type: 'keydown',
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        which: 9,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      const monacoShortcutEvent = {
        browserEvent: shortcutEvent,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };

      await act(async () => {
        editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
      });

      expect(monacoShortcutEvent.preventDefault).not.toHaveBeenCalled();
      expect(monacoShortcutEvent.stopPropagation).not.toHaveBeenCalled();
      expect(shortcutEvent.preventDefault).not.toHaveBeenCalled();
      expect(shortcutEvent.stopPropagation).not.toHaveBeenCalled();
      expect(editorState.editor.executeEdits).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not consume Tab when the AI inline ghost is stale (cursor moved)', async () => {
    vi.useFakeTimers();
    try {
      const inlineAiService = createInlineAiHarnessService();
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [
          { TABLE_NAME: 'videos' },
          { TABLE_NAME: 'visits' },
        ],
      });

      const windowListeners: Record<string, ((event?: any) => void)[]> = {};
      vi.stubGlobal('window', {
        addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
          windowListeners[type] ||= [];
          windowListeners[type].push(listener);
        }),
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
        go: {
          aiservice: {
            Service: inlineAiService,
          },
        },
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELECT', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT';
      editorState.position = { lineNumber: 1, column: 'SELECT'.length + 1 };
      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('SELECT');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'T' }],
        }));
        vi.advanceTimersByTime(220);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      // 光标已移走,幽灵与当前位置不匹配
      editorState.position = { lineNumber: 1, column: 1 };

      const shortcutEvent = {
        type: 'keydown',
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        which: 9,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      const monacoShortcutEvent = {
        browserEvent: shortcutEvent,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };

      await act(async () => {
        editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
      });

      expect(monacoShortcutEvent.preventDefault).not.toHaveBeenCalled();
      expect(monacoShortcutEvent.stopPropagation).not.toHaveBeenCalled();
      expect(shortcutEvent.preventDefault).not.toHaveBeenCalled();
      expect(shortcutEvent.stopPropagation).not.toHaveBeenCalled();
      expect(editorState.editor.executeEdits).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts the AI inline ghost with a rebound Right shortcut', async () => {
    vi.useFakeTimers();
    try {
      storeState.shortcutOptions.acceptSqlAiCompletion = {
        mac: { enabled: true, combo: 'Right' },
        windows: { enabled: true, combo: 'Right' },
      };

      const inlineAiService = createInlineAiHarnessService();
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [
          { TABLE_NAME: 'videos' },
          { TABLE_NAME: 'visits' },
        ],
      });

      const windowListeners: Record<string, ((event?: any) => void)[]> = {};
      vi.stubGlobal('window', {
        addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
          windowListeners[type] ||= [];
          windowListeners[type].push(listener);
        }),
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
        go: {
          aiservice: {
            Service: inlineAiService,
          },
        },
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELECT', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT';
      editorState.position = { lineNumber: 1, column: 'SELECT'.length + 1 };
      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('SELECT');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'T' }],
        }));
        vi.advanceTimersByTime(220);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      const shortcutEvent = {
        type: 'keydown',
        key: 'ArrowRight',
        code: 'ArrowRight',
        keyCode: 39,
        which: 39,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      const monacoShortcutEvent = {
        browserEvent: shortcutEvent,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };

      await act(async () => {
        editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ai-inline-sql-completion',
        [expect.objectContaining({ text: expect.any(String) })],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts the AI inline ghost with a rebound Shift+Tab shortcut', async () => {
    vi.useFakeTimers();
    try {
      storeState.shortcutOptions.acceptSqlAiCompletion = {
        mac: { enabled: true, combo: 'Shift+Tab' },
        windows: { enabled: true, combo: 'Shift+Tab' },
      };

      const inlineAiService = createInlineAiHarnessService();
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [
          { TABLE_NAME: 'videos' },
          { TABLE_NAME: 'visits' },
        ],
      });

      const windowListeners: Record<string, ((event?: any) => void)[]> = {};
      vi.stubGlobal('window', {
        addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
          windowListeners[type] ||= [];
          windowListeners[type].push(listener);
        }),
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
        go: {
          aiservice: {
            Service: inlineAiService,
          },
        },
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELECT', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT';
      editorState.position = { lineNumber: 1, column: 'SELECT'.length + 1 };
      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('SELECT');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'T' }],
        }));
        vi.advanceTimersByTime(220);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      const shortcutEvent = {
        type: 'keydown',
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        which: 9,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: true,
        isComposing: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      const monacoShortcutEvent = {
        browserEvent: shortcutEvent,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };

      await act(async () => {
        editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ai-inline-sql-completion',
        [expect.objectContaining({ text: expect.any(String) })],
      );
      expect(monacoShortcutEvent.preventDefault).toHaveBeenCalled();
      expect(monacoShortcutEvent.stopPropagation).toHaveBeenCalled();
      expect(shortcutEvent.preventDefault).toHaveBeenCalled();
      expect(shortcutEvent.stopPropagation).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues accepted inline SQL ghost with grounded table AI completion', async () => {
    vi.useFakeTimers();
    try {
      const inlineAiService = createInlineAiHarnessService();
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [
          { TABLE_NAME: 'videos' },
          { TABLE_NAME: 'visits' },
        ],
      });

      const windowListeners: Record<string, ((event?: any) => void)[]> = {};
      vi.stubGlobal('window', {
        addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
          windowListeners[type] ||= [];
          windowListeners[type].push(listener);
        }),
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
        go: {
          aiservice: {
            Service: inlineAiService,
          },
        },
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELECT', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT';
      editorState.position = { lineNumber: 1, column: 'SELECT'.length + 1 };
      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();
      editorState.domNode.appendChild.mockClear();

      await act(async () => {
        editorState.latestOnChange?.('SELECT');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'T' }],
        }));
        vi.advanceTimersByTime(220);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      const dispatchAcceptTab = () => {
        const shortcutEvent = {
          type: 'keydown',
          key: 'Tab',
          code: 'Tab',
          keyCode: 9,
          which: 9,
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          isComposing: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        };
        const monacoShortcutEvent = {
          browserEvent: shortcutEvent,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        };
        editorState.keyDownListeners.forEach((listener) => listener(monacoShortcutEvent));
        return { monacoShortcutEvent, shortcutEvent };
      };

      await act(async () => {
        const { monacoShortcutEvent } = dispatchAcceptTab();
        expect(monacoShortcutEvent.preventDefault).toHaveBeenCalled();
        expect(monacoShortcutEvent.stopPropagation).toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ai-inline-sql-completion',
        [expect.objectContaining({
          text: ' * FROM ',
        })],
      );
      expect(editorState.value).toBe('SELECT * FROM ');
      expect(inlineAiService.AISubmitAgentInput).toHaveBeenCalledTimes(1);
      expect(editorState.domNode.appendChild).toHaveBeenCalled();
      const ghostOverlay = editorState.domNode.appendChild.mock.calls[
        editorState.domNode.appendChild.mock.calls.length - 1
      ]?.[0];
      expect(ghostOverlay?.className).toBe('gonavi-query-editor-ai-inline-ghost-overlay');
      expect(ghostOverlay?.textContent).toBe('videos');
      expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
        'gonavi-ai-inline-auto',
        'editor.action.triggerSuggest',
        undefined,
      );

      editorState.editor.executeEdits.mockClear();
      editorState.editor.trigger.mockClear();

      await act(async () => {
        dispatchAcceptTab();
        vi.advanceTimersByTime(1);
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ai-inline-sql-completion',
        [expect.objectContaining({
          text: 'videos',
        })],
      );
      expect(editorState.value).toBe('SELECT * FROM videos');
      expect(inlineAiService.AISubmitAgentInput).toHaveBeenCalledTimes(1);
      expect(editorState.editor.trigger).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('strips a stray backslash before keeping manual toolbar AI completion on the AI path', async () => {
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { TABLE_NAME: 'videos' },
        { TABLE_NAME: 'visits' },
      ],
    });

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM \\', dbName: 'main' })} />);
    });

    editorState.value = 'SELECT * FROM \\';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM \\'.length + 1 };
    editorState.editor.executeEdits.mockClear();
    editorState.editor.trigger.mockClear();

    await act(async () => {
      findButton(renderer!, 'AI').props.onClick();
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-manual-sql-ai-strip-marker',
      [expect.objectContaining({
        text: '',
      })],
    );
    expect(editorState.value).toBe('SELECT * FROM ');
    expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
      'gonavi-ai-inline-manual',
      'editor.action.triggerSuggest',
      undefined,
    );
  });

  it('keeps the AI dropdown completion action on the AI path instead of opening plain suggestions', async () => {
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { TABLE_NAME: 'videos' },
        { TABLE_NAME: 'visits' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ', dbName: 'main' })} />);
    });

    editorState.value = 'SELECT * FROM ';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM '.length + 1 };
    editorState.editor.trigger.mockClear();

    await act(async () => {
      findButton(renderer!, '触发 SQL AI 自动补全').props.onClick();
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
      'gonavi-ai-inline-manual',
      'editor.action.triggerSuggest',
      undefined,
    );
  });

  it('shows the query results panel with the shortcut after manually hiding it', async () => {
    storeState.appearance.uiVersion = 'v2';

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    await act(async () => {
      findButton(renderer, '结果').props.onClick();
    });
    await act(async () => {
      findButton(renderer, '隐藏').props.onClick();
    });
    expect(textContent(renderer.toJSON())).not.toContain('等待执行 SQL');

    const FakeNode = class {};
    const bodyNode = new FakeNode();
    const documentElement = new FakeNode();
    vi.stubGlobal('Node', FakeNode);
    vi.stubGlobal('document', {
      body: bodyNode,
      documentElement,
    });
    editorState.hasTextFocus = false;
    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const toggleEvent = {
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: true,
      key: 'm',
      target: bodyNode,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(toggleEvent));
    });

    expect(toggleEvent.preventDefault).toHaveBeenCalled();
    expect(findSqlLogTab(renderer)).toHaveLength(1);
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', {
      resultPanelVisible: true,
    });

    renderer.unmount();
  });

  it('opens the embedded sql execution log tab from the shared log event in v2', async () => {
    storeState.appearance.uiVersion = 'v2';
    storeState.sqlLogs = [{
      id: 'log-1',
      timestamp: Date.now(),
      sql: 'select 1',
      status: 'success',
      duration: 12,
    }];

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    expect(findSqlLogTab(renderer)).toHaveLength(1);

    await act(async () => {
      windowListeners['gonavi:show-sql-execution-log']?.forEach((listener) => listener());
    });

    expect(textContent(renderer.toJSON())).toContain('SQL 执行日志');
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      resultPanelVisible: true,
    });

    await act(async () => {
      windowListeners['gonavi:show-sql-execution-log']?.forEach((listener) => listener());
    });

    expect(findSqlLogTab(renderer)).toHaveLength(0);
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', {
      resultPanelVisible: false,
    });

    renderer.unmount();
  });

  it('keeps the embedded sql execution log tab open for explicit open events in v2', async () => {
    storeState.appearance.uiVersion = 'v2';
    storeState.sqlLogs = [{
      id: 'log-1',
      timestamp: Date.now(),
      sql: 'select 1',
      status: 'success',
      duration: 12,
    }];

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    const openEvent = new CustomEvent('gonavi:show-sql-execution-log', { detail: { mode: 'open' } });
    await act(async () => {
      windowListeners['gonavi:show-sql-execution-log']?.forEach((listener) => listener(openEvent));
    });
    expect(textContent(renderer.toJSON())).toContain('SQL 执行日志');

    await act(async () => {
      windowListeners['gonavi:show-sql-execution-log']?.forEach((listener) => listener(openEvent));
    });
    expect(textContent(renderer.toJSON())).toContain('SQL 执行日志');
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', {
      resultPanelVisible: true,
    });

    renderer.unmount();
  });

  it('shows execution failures inside the embedded sql log tab in v2', async () => {
    storeState.appearance.uiVersion = 'v2';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      message: 'driver exploded',
      data: [],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select 1;' })} />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer.toJSON());
    expect(rendered).toContain('SQL 执行日志');
    expect(rendered).toContain('driver exploded');
    expect(renderer.root.findAll((node) => node.props?.['data-log-panel'] === 'embedded')).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.props?.['data-tab-key'] === '__gonavi_sql_execution_log__')).toHaveLength(1);

    renderer.unmount();
  });

  it.each(['sqlite', 'clickhouse', 'mongodb'])(
    'activates the data result tab and requests data preview for %s after the sql log tab was open',
    async (dbType) => {
      storeState.appearance.uiVersion = 'v2';
      storeState.connections[0].config.type = dbType;
      storeState.sqlLogs = [{
        id: 'log-1',
        timestamp: Date.now(),
        sql: 'select old',
        status: 'success',
        duration: 12,
      }];
      backendApp.DBGetColumns.mockResolvedValue({
        success: true,
        data: [{ name: 'id', key: 'PRI' }],
      });
      backendApp.DBGetIndexes.mockResolvedValue({ success: true, data: [] });
      if (dbType === 'mongodb') {
        backendApp.DBQueryWithCancel.mockResolvedValue({
          success: true,
          data: [{ id: 1, name: 'alpha' }],
          fields: ['id', 'name'],
        });
      } else {
        backendApp.DBQueryMulti.mockResolvedValue({
          success: true,
          data: [{
            columns: ['id', 'name'],
            rows: [{ id: 1, name: 'alpha' }],
            statementIndex: 1,
          }],
        });
      }

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

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({
          query: 'SELECT * FROM users',
        })} />);
      });

      const openEvent = new CustomEvent('gonavi:show-sql-execution-log', { detail: { mode: 'open' } });
      await act(async () => {
        windowListeners['gonavi:show-sql-execution-log']?.forEach((listener) => listener(openEvent));
      });
      expect(textContent(renderer.toJSON())).toContain('SQL 执行日志');
      dataGridState.latestProps = null;

      await act(async () => {
        await findButton(renderer, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(textContent(renderer.toJSON())).toContain('结果 1');
      expect(dataGridState.latestProps?.columnNames).toEqual(['id', 'name']);
      expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ id: 1, name: 'alpha' });
      expect(dataGridState.latestProps?.initialViewMode).toBe('table');
      expect(dataGridState.latestProps?.initialViewModeScope).toBe('local');
      const firstDataPreviewRequestId = dataGridState.latestProps?.initialViewModeRequestId;
      expect(firstDataPreviewRequestId).toEqual(expect.any(String));

      await act(async () => {
        await findButton(renderer, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(dataGridState.latestProps?.initialViewMode).toBe('table');
      expect(dataGridState.latestProps?.initialViewModeScope).toBe('local');
      expect(dataGridState.latestProps?.initialViewModeRequestId).toEqual(expect.any(String));
      expect(dataGridState.latestProps?.initialViewModeRequestId).not.toBe(firstDataPreviewRequestId);

      const secondDataPreviewRequestId = dataGridState.latestProps?.initialViewModeRequestId;
      if (dbType === 'mongodb') {
        backendApp.DBQueryWithCancel.mockResolvedValueOnce({
          success: true,
          data: [],
          fields: [],
        });
      } else {
        backendApp.DBQueryMulti.mockResolvedValueOnce({
          success: true,
          data: [{ columns: [], rows: [], statementIndex: 1 }],
        });
      }

      await act(async () => {
        await findButton(renderer, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(dataGridState.latestProps?.columnNames).toEqual([]);
      expect(dataGridState.latestProps?.data).toEqual([]);
      expect(dataGridState.latestProps?.initialViewMode).toBe('table');
      expect(dataGridState.latestProps?.initialViewModeScope).toBe('local');
      expect(dataGridState.latestProps?.initialViewModeRequestId).toEqual(expect.any(String));
      expect(dataGridState.latestProps?.initialViewModeRequestId).not.toBe(secondDataPreviewRequestId);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it('keeps query result panel visibility isolated per tab', async () => {
    storeState.appearance.uiVersion = 'v2';
    storeState.queryOptions.showQueryResultsPanel = false;

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ id: 'tab-1', resultPanelVisible: false })} />);
    });
    expect(textContent(renderer.toJSON())).not.toContain('等待执行 SQL');

    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ id: 'tab-2', resultPanelVisible: true })} />);
    });

    expect(findSqlLogTab(renderer)).toHaveLength(1);

    renderer.unmount();
  });

  it('registers all SQL completion providers in the disposable singleton state', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    const completionState = (globalThis as any).__gonaviSqlCompletionState;

    expect(editorState.hoverProviderLanguages).toEqual(['sql', 'mysql', 'sql', 'mysql']);
    expect(editorState.providerLanguages).toEqual(['sql', 'mysql', 'sql', 'mysql', 'sql', 'mysql']);
    expect(editorState.hoverProviders).toHaveLength(4);
    expect(editorState.providers).toHaveLength(6);
    expect(completionState.disposables).toHaveLength(10);

    await act(async () => {
      renderer.unmount();
    });
  });

  it.each([
    ['mysql', 'mysql'],
    ['mariadb', 'mysql'],
    ['postgres', 'sql'],
  ])('uses the %s connection grammar before formatting SQL', async (dbType, expectedLanguage) => {
    storeState.connections[0].config.type = dbType;
    const initialSql = "update finan_ set openid = 'ol_' where pay_status = '0' limit 50";

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: initialSql })} />);
    });

    expect(monacoEditorMockState.latestProps).toMatchObject({
      defaultValue: initialSql,
      language: expectedLanguage,
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps plain typing out of SQL completion trigger characters', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));

    expect(sqlProvider).toBeTruthy();
    expect(sqlProvider.triggerCharacters).toEqual(['.']);
    expect(sqlProvider.triggerCharacters).not.toContain('s');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('drops cancelled SQL completion requests while the user keeps typing', async () => {
    let renderer!: ReactTestRenderer;
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'session_log' }],
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM ss';
    editorState.position = { lineNumber: 1, column: editorState.value.length + 1 };
    editorState.latestOnChange?.(editorState.value);

    const result = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      editorState.position,
      undefined,
      { isCancellationRequested: true },
    );

    expect(result.suggestions).toEqual([]);
    expect(backendApp.DBGetTables).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('syncs a cleared database to the active context when the toolbar switches connections', async () => {
    storeState.connections = [
      ...createDefaultConnections(),
      {
        id: 'conn-2',
        name: 'analytics',
        config: {
          type: 'mysql',
          host: '127.0.0.2',
          port: 3306,
          user: 'root',
          password: '',
          database: '',
        },
      },
    ];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ connectionId: 'conn-1', dbName: 'main' })} />);
    });

    const toolbar = renderer.root.findByType(QueryEditorToolbar);
    await act(async () => {
      toolbar.props.onConnectionChange('conn-2');
    });

    expect(storeState.setActiveContext).toHaveBeenLastCalledWith({
      connectionId: 'conn-2',
      dbName: '',
    });
    expect(storeState.activeContext).toEqual({ connectionId: 'conn-2', dbName: '' });
    expect(resolveNewQueryContext({
      sidebarContext: storeState.activeContext,
      activeTab: createTab({ connectionId: 'conn-1', dbName: 'main' }),
      validConnectionIds: new Set(storeState.connections.map((connection) => connection.id)),
    })).toEqual({ connectionId: 'conn-2', dbName: '' });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('loads table completions after selecting a database in a connection-scoped query tab', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.database = '';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'information_schema' }, { Database: 'main' }] });
    backendApp.DBGetTables.mockImplementation(async (_config: unknown, dbName: string) => ({
      success: true,
      data: dbName === 'main'
        ? [{ Tables_in_main: 'organization' }]
        : [{ Tables_in_database_a: 'legacy_table' }],
    }));
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(
        <>
          <QueryEditor tab={createTab({ id: 'old-tab', dbName: 'database_a' })} isActive={false} />
          <QueryEditor tab={createTab({ dbName: '', query: '' })} isActive />
        </>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();
    expect(backendApp.DBGetTables).not.toHaveBeenCalled();

    let immediateCompletion!: Promise<any>;
    await act(async () => {
      const activeToolbar = renderer.root.findAllByType(QueryEditorToolbar).find((toolbar) => toolbar.props.currentDb === '');
      expect(activeToolbar).toBeTruthy();
      activeToolbar!.props.onDatabaseChange('main');

      editorState.value = 'SELECT * FROM org';
      editorState.latestOnChange?.(editorState.value);
      immediateCompletion = sqlProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      await immediateCompletion;
    });
    await vi.waitFor(() => {
      expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.any(Object), 'main');
    });
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', expect.objectContaining({
      dbName: 'main',
    }));
    expect(storeState.setActiveContext).toHaveBeenCalledWith({ connectionId: 'conn-1', dbName: 'main' });

    const result = await immediateCompletion;

    expect(result.suggestions.map((item: any) => item.label)).toContain('organization');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps the database empty after loading options for a connection-scoped query tab', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'information_schema' }, { Database: 'main' }],
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: '', query: '' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', expect.objectContaining({
      dbName: '',
    }));
    expect(backendApp.DBGetTables).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('suggests Oracle views after their metadata has loaded', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'APP';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'APP' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (String(sql || '').includes('USER_VIEWS')) {
        return { success: true, data: [{ view_name: 'PERSON_VIEW' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'APP' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM person';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );

    expect(result.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'PERSON_VIEW',
        insertText: 'PERSON_VIEW',
        detail: '视图 (APP)',
      }),
    ]));
    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not repeat an Oracle view owner across users and de-duplicates its result columns', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.user = 'B';
    storeState.connections[0].config.database = 'B';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'B' }, { Database: 'A' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'A'
        ? [
          { tableName: 'V_PERSON', name: 'ID', type: 'NUMBER' },
          { tableName: 'V_PERSON', name: 'NAME', type: 'VARCHAR2' },
          { tableName: 'V_PERSON', name: 'NAME', type: 'VARCHAR2' },
        ]
        : [],
    }));
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (/ALL_VIEWS/i.test(sql) && /OWNER = 'A'/i.test(sql)) {
        return { success: true, data: [{ schema_name: 'A', view_name: 'V_PERSON' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM A.V_PERSON v', dbName: 'B' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 48; i += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM A.V';
    editorState.latestOnChange?.(editorState.value);
    const viewItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(viewItems.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'V_PERSON',
        insertText: 'V_PERSON',
        detail: '视图 (A)',
      }),
    ]));
    expect(viewItems.suggestions.some((item: any) => item.label === 'A.V_PERSON')).toBe(false);

    editorState.value = 'SELECT v. FROM A.V_PERSON v';
    editorState.latestOnChange?.(editorState.value);
    const columnItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT v.'.length + 1 },
    );
    expect(columnItems.suggestions.filter((item: any) => item.label === 'ID')).toHaveLength(1);
    expect(columnItems.suggestions.filter((item: any) => item.label === 'NAME')).toHaveLength(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps same-name Oracle synonyms scoped by owner and resolves qualified columns', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.user = 'B';
    storeState.connections[0].config.database = 'A';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'A' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetColumns.mockImplementation(async (_config: any, dbName: string, tableName: string) => {
      if (dbName === 'B' && tableName === 'PERSON') {
        return {
          success: true,
          data: [
            { name: 'ID', type: 'NUMBER' },
            { name: 'NAME', type: 'VARCHAR2' },
          ],
        };
      }
      if (dbName === 'IMP_BASICINFO' && tableName === 'PERSON') {
        return {
          success: true,
          data: [
            { name: 'AC01', type: 'VARCHAR2' },
            { name: 'AC02', type: 'VARCHAR2' },
          ],
        };
      }
      return { success: true, data: [] };
    });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (/ALL_SYNONYMS/i.test(sql)) {
        return {
          success: true,
          data: [
            { synonym_owner: 'IMP_BASICINFO', synonym_name: 'PERSON', target_schema_name: 'IMP_DATA', target_name: 'PERSON' },
            { synonym_owner: 'IMP_BASICINFO', synonym_name: 'AC02', target_schema_name: 'IMP_DATA', target_name: 'AC02' },
            { synonym_owner: 'PUBLIC', synonym_name: 'PERSON', target_schema_name: 'PUBLIC_DATA', target_name: 'PERSON' },
            { synonym_owner: 'B', synonym_name: 'PERSON', target_schema_name: 'A', target_name: 'PERSON' },
          ],
        };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'A' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 32; i += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM per';
    editorState.latestOnChange?.(editorState.value);
    const synonymItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(synonymItems.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'PERSON',
        insertText: 'PERSON',
        detail: '同义词 (A.PERSON)',
      }),
    ]));
    expect(synonymItems.suggestions.filter((item: any) => item.label === 'PERSON')).toHaveLength(1);
    expect(synonymItems.suggestions.some((item: any) => item.label === 'AC02')).toBe(false);
    expect(backendApp.DBQuery).toHaveBeenCalledWith(expect.anything(), 'A', expect.stringMatching(/ALL_SYNONYMS/i));

    editorState.value = 'SELECT p. FROM PERSON p';
    editorState.latestOnChange?.(editorState.value);
    const columnItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT p.'.length + 1 },
    );
    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'B', 'PERSON');
    expect(columnItems.suggestions.map((item: any) => item.label)).toEqual(expect.arrayContaining(['ID', 'NAME']));

    editorState.value = 'SELECT * FROM IMP_BASICINFO.';
    editorState.latestOnChange?.(editorState.value);
    const ownerItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(ownerItems.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'PERSON',
        detail: '同义词 (IMP_DATA.PERSON)',
      }),
      expect.objectContaining({
        label: 'AC02',
        detail: '同义词 (IMP_DATA.AC02)',
      }),
    ]));

    editorState.value = 'SELECT p. FROM IMP_BASICINFO.PERSON p';
    editorState.latestOnChange?.(editorState.value);
    const ownerColumnItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT p.'.length + 1 },
    );
    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'IMP_BASICINFO', 'PERSON');
    expect(ownerColumnItems.suggestions.map((item: any) => item.label)).toEqual(expect.arrayContaining(['AC01', 'AC02']));

    await act(async () => {
      renderer.unmount();
    });
  });

  it('matches table names by prefix and substring in FROM completion', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.database = '';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'information_schema' }, { Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Tables_in_main: 'users' },
        { Tables_in_main: 'a_cninfo_announcement' },
        { Tables_in_main: 'hrmresource' },
        { Tables_in_main: 'hrm_resource_export_template' },
        { Tables_in_main: 'archive_hrmresource' },
        { Tables_in_main: 'table_new_1' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { tableName: 'hrmresource', name: 'hrmresult', type: 'varchar(32)' },
        { tableName: 'users', name: 'hrmresult_from_users', type: 'varchar(32)' },
        { tableName: 'users', name: 'SHORT_TITLE', type: 'varchar(255)' },
        { tableName: 'users', name: 'emp_code', type: 'varchar(32)' },
      ],
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM hrmres';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: editorState.value.length + 1 });
    const labels = result.suggestions.map((item: any) => item.label);

    expect(labels).toContain('hrmresource');
    // 子串匹配（#822/#939）：包含 hrmres 的表名候选保留，且排在精确/前缀命中之后
    expect(labels).toContain('archive_hrmresource');
    expect(labels.indexOf('archive_hrmresource')).toBeGreaterThan(labels.indexOf('hrmresource'));
    expect(labels).not.toContain('hrm_resource_export_template');
    expect(labels).not.toContain('hrmresult');

    editorState.value = 'SELECT * FROM users u, hrmres';
    editorState.latestOnChange?.(editorState.value);
    const commaResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const commaLabels = commaResult.suggestions.map((item: any) => item.label);
    expect(commaLabels).toContain('hrmresource');
    expect(commaLabels).toContain('archive_hrmresource');
    expect(commaLabels.indexOf('archive_hrmresource')).toBeGreaterThan(commaLabels.indexOf('hrmresource'));
    expect(commaLabels).not.toContain('hrmresult_from_users');

    // #939：输入表名中段片段（new）也能提示 table_new_1
    editorState.value = 'SELECT * FROM new';
    editorState.latestOnChange?.(editorState.value);
    const substringResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const substringLabels = substringResult.suggestions.map((item: any) => item.label);
    expect(substringLabels).toContain('table_new_1');
    expect(backendApp.DBGetColumns.mock.calls.map((call: any[]) => call[2])).not.toContain('hrmres');

    editorState.value = 'SELECT * FROM A_C';
    editorState.latestOnChange?.(editorState.value);
    const uppercaseTableResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const uppercaseTable = uppercaseTableResult.suggestions.find((item: any) => item.label === 'a_cninfo_announcement');
    expect(uppercaseTable?.insertText).toBe('a_cninfo_announcement AS aca');

    editorState.value = 'SELECT * FROM users WHERE sh';
    editorState.latestOnChange?.(editorState.value);
    const lowercaseColumnResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const lowercaseColumn = lowercaseColumnResult.suggestions.find((item: any) => item.label === 'SHORT_TITLE');
    expect(lowercaseColumn?.insertText).toBe('short_title');

    // #939：字段中段片段提示（输入 code 应提示 emp_code）
    editorState.value = 'SELECT * FROM users WHERE code';
    editorState.latestOnChange?.(editorState.value);
    const columnSubstringResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const columnSubstringLabels = columnSubstringResult.suggestions.map((item: any) => item.label);
    expect(columnSubstringLabels).toContain('emp_code');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('adds deterministic aliases to table source completions and resolves conflicts', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Tables_in_main: 'system_user' },
        { Tables_in_main: 'code_query_record_zykj' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM system_user su JOIN sys';
    editorState.latestOnChange?.(editorState.value);
    const conflictResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(conflictResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user AS su2');

    storeState.connections[0].config.type = 'tidb';
    editorState.value = 'SELECT * FROM sys';
    editorState.latestOnChange?.(editorState.value);
    const tidbResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(tidbResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user AS su');

    editorState.value = '\uFEFF-- legacy completion test\r\nSELECT *\r\nFROM sys';
    editorState.latestOnChange?.(editorState.value);
    const crlfResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 3, column: 9 },
    );
    expect(crlfResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user AS su');
    expect(editorState.value).toBe('\uFEFF-- legacy completion test\r\nSELECT *\r\nFROM sys');

    storeState.connections[0].config.type = 'oracle';
    editorState.value = 'SELECT * FROM sys';
    editorState.latestOnChange?.(editorState.value);
    const oracleResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(oracleResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user su');

    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as Record<string, unknown>).oceanBaseProtocol = 'oracle';
    const oceanBaseOracleResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(oceanBaseOracleResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user su');

    storeState.connections[0].config.type = 'iotdb';
    const unsupportedDialectResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(unsupportedDialectResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user');

    storeState.connections[0].config.type = 'mysql';
    (storeState.connections[0].config as Record<string, unknown>).oceanBaseProtocol = undefined;
    editorState.value = 'SELECT * FROM code';
    editorState.latestOnChange?.(editorState.value);
    const initialsResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(initialsResult.suggestions.find((item: any) => item.label === 'code_query_record_zykj')?.insertText)
      .toBe('code_query_record_zykj AS cqrz');

    editorState.value = 'INSERT INTO system';
    editorState.latestOnChange?.(editorState.value);
    const insertResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(insertResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user');

    for (const sql of [
      'UPDATE system',
      'DELETE FROM system',
      'INSERT INTO system',
      'REPLACE INTO system',
      'MERGE INTO system',
    ]) {
      editorState.value = sql;
      editorState.latestOnChange?.(editorState.value);
      const dmlResult = await sqlProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      expect(dmlResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
        .toBe('system_user');
    }

    editorState.value = 'INSERT INTO audit_log SELECT * FROM system';
    editorState.latestOnChange?.(editorState.value);
    const insertSelectResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(insertSelectResult.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user AS su');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not add table aliases to table source completions when disabled', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.appearance.autoAddTableAlias = false;
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'system_user' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.value = 'SELECT * FROM system';
    editorState.latestOnChange?.(editorState.value);
    const result = await findSqlCompletionProvider().provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(result.suggestions.find((item: any) => item.label === 'system_user')?.insertText)
      .toBe('system_user');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('marks bounded FROM completion as incomplete so Monaco retriggers with the final prefix', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        ...Array.from({ length: 201 }, (_, index) => ({
          Tables_in_main: `hrm_resource_${String(index).padStart(3, '0')}`,
        })),
        { Tables_in_main: 'hrmresource' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM h';
    editorState.latestOnChange?.(editorState.value);
    const initialResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(initialResult.suggestions).toHaveLength(200);
    expect(initialResult.suggestions.map((item: any) => item.label)).not.toContain('hrmresource');
    expect(initialResult.incomplete).toBe(true);

    editorState.value = 'SELECT * FROM hrmres';
    editorState.latestOnChange?.(editorState.value);
    const retriggeredResult = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
      { triggerKind: 2 },
    );
    expect(retriggeredResult.suggestions.map((item: any) => item.label)).toEqual(['hrmresource']);
    expect(retriggeredResult.incomplete).toBe(true);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('resolves columns from comma-separated Dameng table references and aliases', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'dameng';
    storeState.connections[0].config.database = 'DEV';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'DEV' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Table: 'VULNERABILITY_INFO_T' },
        { Table: 'VULNERABILITY_DETAIL_T' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetColumns.mockImplementation(async (_config: any, _dbName: string, tableName: string) => ({
      success: true,
      data: tableName === 'VULNERABILITY_DETAIL_T'
        ? [
            { name: 'DETAIL_ID', type: 'VARCHAR' },
            { name: 'VULNERABILITY_ID', type: 'VARCHAR' },
          ]
        : [
            { name: 'CODE', type: 'VARCHAR' },
            { name: 'CONTENT', type: 'VARCHAR' },
            { name: 'ID', type: 'VARCHAR' },
          ],
    }));

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'DEV' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 16; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();
    const sqlPrefix = 'SELECT * FROM VULNERABILITY_INFO_T a, VULNERABILITY_DETAIL_T b '
      + 'WHERE VULNERABILITY_INFO_T.CODE = ';

    for (const qualifier of ['VULNERABILITY_DETAIL_T', 'b']) {
      editorState.value = `${sqlPrefix}${qualifier}.`;
      editorState.latestOnChange?.(editorState.value);
      const result = await sqlProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      const labels = result.suggestions.map((item: any) => item.label);

      expect(result.suggestions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: 'DETAIL_ID',
          detail: expect.stringContaining('VULNERABILITY_DETAIL_T'),
        }),
      ]));
      expect(labels).toEqual(expect.arrayContaining(['DETAIL_ID', 'VULNERABILITY_ID']));
      expect(labels).not.toEqual(expect.arrayContaining(['CODE', 'CONTENT', 'ID']));
    }
    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'DEV', 'VULNERABILITY_DETAIL_T');
    expect(backendApp.DBGetColumns).not.toHaveBeenCalledWith(expect.anything(), 'DEV', 'VULNERABILITY_INFO_T');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps FROM inside an unfinished EXTRACT expression in column completion context', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Table: 'users' },
        { Table: 'archive_created_at' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [{ tableName: 'users', name: 'created_at', type: 'timestamp' }],
    });

    const sql = 'SELECT EXTRACT(YEAR FROM creat) FROM users';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: sql, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();
    const cursorPrefix = 'SELECT EXTRACT(YEAR FROM creat';
    const result = await sqlProvider.provideCompletionItems(
      createSqlCompletionModel(sql, 'creat'),
      { lineNumber: 1, column: cursorPrefix.length + 1 },
    );

    expect(result.suggestions.map((item: any) => item.label)).toContain('created_at');
    expect(backendApp.DBGetColumns.mock.calls.map((call: any[]) => call[2])).not.toContain('created_at');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not suggest tables from other databases for unqualified FROM completion', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.database = 'mkefu_ai_dev';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'mkefu_ai_dev' }, { Database: 'mkefu_dev' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'mkefu_ai_dev') {
        return { success: true, data: [{ Tables_in_mkefu_ai_dev: 'ai_conversation' }] };
      }
      if (dbName === 'mkefu_dev') {
        return { success: true, data: [{ Tables_in_mkefu_dev: 'wechat_visitor_id_bak' }] };
      }
      return { success: true, data: [] };
    });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'mkefu_ai_dev' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM wechat';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: editorState.value.length + 1 });
    const labels = result.suggestions.map((item: any) => item.label);

    expect(labels).not.toContain('wechat_visitor_id_bak');
    expect(labels).not.toContain('mkefu_dev.wechat_visitor_id_bak');
    expect(backendApp.DBGetTables.mock.calls.map((call: any[]) => call[1])).toEqual(
      expect.arrayContaining(['mkefu_ai_dev']),
    );
    expect(backendApp.DBGetTables.mock.calls.map((call: any[]) => call[1])).not.toContain('mkefu_dev');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('lazy loads current database tables for FROM completion when metadata is not preloaded', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = false;
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'fs_org_auth_application' }],
    });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (/table_comment|information_schema\.tables/i.test(sql)) {
        return { success: true, data: [{ table_name: 'fs_org_auth_application', table_comment: '认证申请表' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'front_end_sys' })} />);
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM fs_org';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: editorState.value.length + 1 });
    const labels = result.suggestions.map((item: any) => item.label);
    const tableSuggestion = result.suggestions.find((item: any) => item.label === 'fs_org_auth_application');

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.any(Object), 'front_end_sys');
    expect(labels).toContain('fs_org_auth_application');
    expect(tableSuggestion?.detail).toBe('表 - 认证申请表');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('suggests MySQL CALL keyword and stored routine names in SQL completion', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      const text = String(sql || '');
      if (text.includes('information_schema.routines')) {
        return {
          success: true,
          data: [
            { routine_name: 'codex_tmp_proc_link_test', routine_type: 'PROCEDURE', schema_name: 'main' },
            { routine_name: 'codex_tmp_score_user', routine_type: 'FUNCTION', schema_name: 'main' },
          ],
        };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'CA';
    editorState.latestOnChange?.(editorState.value);
    const keywordItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    expect(keywordItems.suggestions.some((item: any) => item.label === 'CALL')).toBe(true);

    editorState.value = 'CALL codex_tmp';
    editorState.latestOnChange?.(editorState.value);
    const routineItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const procedureSuggestion = routineItems.suggestions.find((item: any) => item.label === 'codex_tmp_proc_link_test');
    const functionSuggestion = routineItems.suggestions.find((item: any) => item.label === 'codex_tmp_score_user');

    expect(procedureSuggestion).toMatchObject({
      kind: 2,
      insertText: 'codex_tmp_proc_link_test($0)',
      detail: '存储过程 (main)',
    });
    expect(String(procedureSuggestion?.sortText || '')).toMatch(/^00/);
    expect(functionSuggestion).toBeUndefined();

    editorState.value = 'SELECT codex_tmp';
    editorState.latestOnChange?.(editorState.value);
    const expressionRoutineItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const expressionFunctionSuggestion = expressionRoutineItems.suggestions.find((item: any) => item.label === 'codex_tmp_score_user');
    expect(expressionFunctionSuggestion).toMatchObject({
      kind: 2,
      insertText: 'codex_tmp_score_user($0)',
      detail: '函数 (main)',
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('quotes uppercase postgres table names in FROM completion insert text', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Table: 'public.MyTable' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM My';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: editorState.value.length + 1 });
    const match = result.suggestions.find((item: any) => item.label === 'MyTable');

    expect(match?.insertText).toBe('"MyTable" AS mt');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('quotes uppercase postgres table names after schema qualifiers in completion insert text', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Table: 'public.MyTable' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT * FROM public.';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: editorState.value.length + 1 });
    const match = result.suggestions.find((item: any) => item.label === 'MyTable');

    expect(match?.insertText).toBe('"MyTable" AS mt');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('quotes uppercase postgres column names in completion insert text', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Table: 'public.MyTable' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [{ tableName: 'public.MyTable', name: 'DisplayName', type: 'text' }],
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.value = 'SELECT Dis FROM public."MyTable"';
    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(editorState.editor.getModel(), { lineNumber: 1, column: 'SELECT Dis'.length + 1 });
    const match = result.suggestions.find((item: any) => item.label === 'DisplayName');

    expect(match?.insertText).toBe('"DisplayName"');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('preloads metadata only for the current database when many databases are visible', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = '';
    const databaseRows = [
      { Database: 'main' },
      ...Array.from({ length: 40 }, (_, index) => ({ Database: `tenant_${String(index + 1).padStart(3, '0')}` })),
    ];
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: databaseRows });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'main' ? [{ Tables_in_main: 'users' }] : [{ [`Tables_in_${dbName}`]: 'unexpected_table' }],
    }));
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'main' ? [{ tableName: 'users', name: 'id', type: 'bigint' }] : [],
    }));
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM users', dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetTables.mock.calls.map((call: any[]) => call[1])).toEqual(['main']);
    expect(backendApp.DBGetAllColumns.mock.calls.map((call: any[]) => call[1])).toEqual(['main']);
    const metadataQueryDbs = new Set(backendApp.DBQuery.mock.calls.map((call: any[]) => call[1]));
    expect([...metadataQueryDbs]).toEqual(['main']);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps an existing query tab on its database when a new pattern hides it from the picker', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }, { Database: 'hidden' }],
    });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select 1;', dbName: 'hidden' })} />);
    });
    await vi.waitFor(() => {
      expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      (storeState.connections[0] as any).excludeDatabasePatterns = ['hidden'];
      storeState.connections = [...storeState.connections];
      notifyStoreSubscribers();
    });
    await vi.waitFor(() => {
      expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'hidden',
      expect.stringContaining('select 1'),
      'query-1',
    );

    await act(async () => {
      renderer.unmount();
    });
  });

  it('suggests columns in WHERE for cross-database MySQL tables with quoted hyphenated database names', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = '';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'sanpin' }, { Database: 'ccbim-document-07' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'sanpin') {
        return { success: true, data: [{ Table: 'orders' }] };
      }
      if (dbName === 'ccbim-document-07') {
        return { success: true, data: [{ Table: 'doc' }] };
      }
      return { success: true, data: [] };
    });
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'sanpin') {
        return {
          success: true,
          data: [{ tableName: 'orders', name: 'id', type: 'bigint' }],
        };
      }
      if (dbName === 'ccbim-document-07') {
        return {
          success: true,
          data: [
            { tableName: 'doc', name: 'node_id', type: 'varchar(64)' },
            { tableName: 'doc', name: 'node_name', type: 'varchar(255)' },
          ],
        };
      }
      return { success: true, data: [] };
    });

    editorState.value = 'SELECT *\nFROM `ccbim-document-07`.doc\nWHERE no';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'sanpin' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = editorState.providers.find((provider) => Array.isArray(provider.triggerCharacters) && provider.triggerCharacters.includes('.'));
    expect(sqlProvider).toBeTruthy();

    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 3, column: 'WHERE no'.length + 1 },
    );
    const labels = result.suggestions.map((item: any) => item.label);

    expect(labels).toContain('node_id');
    expect(labels).toContain('node_name');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('prioritizes SQL keywords for a new statement instead of leaking previous statement columns', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'main' }, { Database: 'analytics' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'main') {
        return { success: true, data: [{ Tables_in_main: 'users' }] };
      }
      if (dbName === 'analytics') {
        return { success: true, data: [{ Tables_in_analytics: 'events' }] };
      }
      return { success: true, data: [] };
    });
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'main') {
        return {
          success: true,
          data: [{ tableName: 'users', name: 'updated_by', type: 'varchar(32)' }],
        };
      }
      if (dbName === 'analytics') {
        return {
          success: true,
          data: [{ tableName: 'events', name: 'update_time', type: 'timestamp' }],
        };
      }
      return { success: true, data: [] };
    });

    editorState.value = 'SELECT *\nFROM analytics.events;\nupdate';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 3, column: 'update'.length + 1 },
    );
    const labels = result.suggestions.map((item: any) => item.label);

    expect(labels[0]).toBe('UPDATE');
    expect(labels).not.toContain('update_time');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('limits column completion to tables referenced before the cursor in the current statement', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'main' }, { Database: 'analytics' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'main') {
        return { success: true, data: [{ Tables_in_main: 'users' }] };
      }
      if (dbName === 'analytics') {
        return { success: true, data: [{ Tables_in_analytics: 'events' }] };
      }
      return { success: true, data: [] };
    });
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => {
      if (dbName === 'main') {
        return {
          success: true,
          data: [{ tableName: 'users', name: 'updated_by', type: 'varchar(32)' }],
        };
      }
      if (dbName === 'analytics') {
        return {
          success: true,
          data: [{ tableName: 'events', name: 'update_time', type: 'timestamp' }],
        };
      }
      return { success: true, data: [] };
    });

    editorState.value = 'SELECT * FROM analytics.events;\nSELECT * FROM main.users WHERE upd';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    editorState.latestOnChange?.(editorState.value);
    const result = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 2, column: 'SELECT * FROM main.users WHERE upd'.length + 1 },
    );
    const labels = result.suggestions.map((item: any) => item.label);

    expect(labels).toContain('updated_by');
    expect(labels).not.toContain('update_time');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps large table and referenced-column completion within a bounded candidate budget', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    const noisyTableRows = Array.from({ length: 2_000 }, (_, index) => ({
      Tables_in_main: `entity_z_archive_${String(index).padStart(4, '0')}`,
    }));
    const noisyColumnRows = Array.from({ length: 2_000 }, (_, index) => ({
      tableName: 'users',
      name: `column_${String(index).padStart(4, '0')}`,
      type: 'varchar(64)',
    }));
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Tables_in_main: 'users' },
        ...noisyTableRows,
        { Tables_in_main: 'entity_primary' },
        { Tables_in_main: 'entity' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [
        ...noisyColumnRows,
        { tableName: 'users', name: 'column_primary', type: 'varchar(64)' },
        { tableName: 'users', name: 'column', type: 'varchar(64)' },
      ],
    });

    editorState.value = 'SELECT * FROM entity';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    const tableItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const tableLabels = tableItems.suggestions.map((item: any) => item.label);
    expect(tableLabels).toHaveLength(200);
    expect(tableLabels.slice(0, 2)).toEqual(['entity', 'entity_primary']);

    editorState.value = 'SELECT * FROM users WHERE column';
    const columnItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );
    const columnLabels = columnItems.suggestions.map((item: any) => item.label);
    expect(columnLabels).toHaveLength(200);
    expect(columnLabels).toContain('COLUMN');
    expect(columnLabels).toContain('column');
    expect(columnLabels.indexOf('column')).toBeLessThan(columnLabels.indexOf('column_0000'));

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps a late current-database column when other-database candidates fill the budget first', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'main' }, { Database: 'otherdb' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'main'
        ? [{ Tables_in_main: 'local_table' }]
        : [{ Tables_in_otherdb: 'remote_table' }],
    }));
    backendApp.DBGetAllColumns.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'otherdb'
        ? Array.from({ length: 200 }, (_, index) => ({
            tableName: 'remote_table',
            name: `col_other_${String(index).padStart(3, '0')}`,
            type: 'varchar(64)',
          }))
        : [],
    }));
    backendApp.DBGetColumns.mockImplementation(async (_config: any, dbName: string, tableName: string) => ({
      success: true,
      data: dbName === 'main' && tableName === 'local_table'
        ? [{ name: 'col_current_late', type: 'varchar(64)' }]
        : [],
    }));

    editorState.value = [
      'SELECT r.col_other_000',
      'FROM otherdb.remote_table r',
      'JOIN main.local_table l ON r.id = l.id',
      'WHERE col',
    ].join('\n');
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 16; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    const completionItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 4, column: 'WHERE col'.length + 1 },
    );
    const labels = completionItems.suggestions.map((item: any) => item.label);

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'main', 'local_table');
    expect(labels).toHaveLength(200);
    expect(labels).toContain('col_current_late');
    expect(labels.indexOf('col_current_late')).toBeLessThan(labels.indexOf('col_other_000'));

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keeps final sortText ordering when an other-database exact match follows 200 current-database prefixes', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'main' }, { Database: 'otherdb' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => ({
      success: true,
      data: dbName === 'main'
        ? Array.from({ length: 200 }, (_, index) => ({
            Tables_in_main: `tar_current_${String(index).padStart(3, '0')}`,
          }))
        : [{ Tables_in_otherdb: 'seed' }, { Tables_in_otherdb: 'tar' }],
    }));
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    editorState.value = 'SELECT * FROM otherdb.seed;\nSELECT tar';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 16; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    const completionItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 2, column: 'SELECT tar'.length + 1 },
    );
    const labels = completionItems.suggestions.map((item: any) => item.label);

    expect(labels).toHaveLength(200);
    expect(labels).not.toContain('otherdb.tar');
    expect(labels[0]).toBe('tar_current_000');
    expect(labels[199]).toBe('tar_current_199');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('returns no completion for an unmatched known schema qualifier instead of leaking global objects', async () => {
    let renderer!: ReactTestRenderer;
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [
        { Table: 'dbo.users' },
        { Table: 'sales.zzz_candidate' },
        { Table: 'zzz_global' },
      ],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    editorState.value = 'SELECT * FROM dbo.zzz';
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
    });

    const sqlProvider = findSqlCompletionProvider();
    expect(sqlProvider).toBeTruthy();

    const completionItems = await sqlProvider.provideCompletionItems(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length + 1 },
    );

    expect(completionItems.suggestions).toEqual([]);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('resolves database and table targets for ctrl/cmd navigation', () => {
    const tables = [
      { dbName: 'main', tableName: 'users' },
      { dbName: 'main', tableName: 'dbo.orders' },
      { dbName: 'analytics', tableName: 'events' },
    ];
    const views = [
      { dbName: 'main', viewName: 'reporting.active_users', schemaName: 'reporting' },
    ];
    const materializedViews = [
      { dbName: 'analytics', viewName: 'mv_daily_stats', schemaName: undefined },
    ];
    const triggers = [
      { dbName: 'main', triggerName: 'audit.users_bi', tableName: 'audit.users', schemaName: 'audit' },
    ];
    const routines = [
      { dbName: 'main', routineName: 'reporting.refresh_stats', routineType: 'PROCEDURE', schemaName: 'reporting' },
    ];
    const sequences = [
      { dbName: 'main', sequenceName: 'billing.order_seq', schemaName: 'billing' },
    ];
    const packages = [
      { dbName: 'main', packageName: 'billing.pkg_order', schemaName: 'billing' },
    ];

    expect(resolveQueryEditorNavigationTarget('select * from analytics.events', 31, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'table',
      dbName: 'analytics',
      tableName: 'events',
      schemaName: undefined,
    });
    expect(resolveQueryEditorNavigationTarget('select * from dbo.orders', 21, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'table',
      dbName: 'main',
      tableName: 'dbo.orders',
      schemaName: 'dbo',
    });
    // MySQL 跨库手写 db.table：库不在可见列表时，只要元数据已加载也应可跳转
    expect(resolveQueryEditorNavigationTarget(
      'select * from front_end_sys_new.fs_mkefu_regist_record',
      'select * from front_end_sys_new.fs_mkefu_regist_record'.length,
      'mkefu_test_new',
      ['mkefu_test_new'],
      [
        { dbName: 'mkefu_test_new', tableName: 'uk_back_corp' },
        { dbName: 'front_end_sys_new', tableName: 'fs_mkefu_regist_record' },
      ],
      [],
      [],
      [],
      [],
      [],
      [],
    )).toEqual({
      type: 'table',
      dbName: 'front_end_sys_new',
      tableName: 'fs_mkefu_regist_record',
      schemaName: undefined,
    });
    expect(resolveQueryEditorNavigationTarget('use analytics', 6, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'database',
      dbName: 'analytics',
    });
    expect(resolveQueryEditorNavigationTarget('select * from users', 18, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'table',
      dbName: 'main',
      tableName: 'users',
      schemaName: undefined,
    });
    expect(resolveQueryEditorNavigationTarget('select * from reporting.active_users', 31, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'view',
      dbName: 'main',
      viewName: 'reporting.active_users',
      schemaName: 'reporting',
    });
    expect(resolveQueryEditorNavigationTarget('select * from analytics.mv_daily_stats', 37, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'materialized-view',
      dbName: 'analytics',
      viewName: 'mv_daily_stats',
      schemaName: undefined,
    });
    expect(resolveQueryEditorNavigationTarget('call audit.users_bi()', 18, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'trigger',
      dbName: 'main',
      triggerName: 'audit.users_bi',
      tableName: 'audit.users',
      schemaName: 'audit',
    });
    expect(resolveQueryEditorNavigationTarget('call reporting.refresh_stats()', 21, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'routine',
      dbName: 'main',
      routineName: 'reporting.refresh_stats',
      routineType: 'PROCEDURE',
      schemaName: 'reporting',
    });
    expect(resolveQueryEditorNavigationTarget('select billing.order_seq.nextval from dual', 18, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'sequence',
      dbName: 'main',
      sequenceName: 'billing.order_seq',
      schemaName: 'billing',
    });
    expect(resolveQueryEditorNavigationTarget('begin billing.pkg_order.sync_order(1); end;', 16, 'main', ['main', 'analytics'], tables, views, materializedViews, triggers, routines, sequences, packages)).toEqual({
      type: 'package',
      dbName: 'main',
      packageName: 'billing.pkg_order',
      schemaName: 'billing',
    });
  });

  it('prefers the unique schema-qualified view target when metadata also contains a bare view name', () => {
    const views = [
      { dbName: 'SYSDBA', viewName: 'V_ACCOUNT', schemaName: undefined },
      { dbName: 'SYSDBA', viewName: 'SYSDBA.V_ACCOUNT', schemaName: 'SYSDBA' },
    ];

    expect(resolveQueryEditorNavigationTarget(
      'select * from V_ACCOUNT',
      'select * from V_ACCOUNT'.length + 1,
      'SYSDBA',
      ['SYSDBA'],
      [],
      views,
      [],
      [],
      [],
    )).toEqual({
      type: 'view',
      dbName: 'SYSDBA',
      viewName: 'SYSDBA.V_ACCOUNT',
      schemaName: 'SYSDBA',
    });
  });

  it('opens a table data tab with the embedded object designer on ctrl left click inside the editor', async () => {
    editorState.value = 'select * from analytics.events where id = 1';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
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

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 27 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'analytics', 'events');
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
    expect(storeState.addTab).toHaveBeenCalledWith({
      id: 'conn-1-analytics-table-events',
      title: 'events',
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'analytics',
      tableName: 'events',
      initialViewMode: 'fields',
      initialViewModeRequestId: expect.any(String),
      objectType: 'table',
      returnToTabId: 'tab-1',
    });
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('opens a table data tab with the embedded object designer on macOS cmd click when Monaco omits leftButton', async () => {
    editorState.value = 'select * from fs_mkefu_regist_record;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'fs_mkefu_regist_record' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_location_dev_local' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from fs_mkefu_regist_record'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBTableExists).toHaveBeenCalledWith(
      expect.anything(),
      'mkefu_location_dev_local',
      'fs_mkefu_regist_record',
    );
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'mkefu_location_dev_local',
      tableName: 'fs_mkefu_regist_record',
      initialViewMode: 'fields',
      initialViewModeRequestId: expect.any(String),
      objectType: 'table',
      returnToTabId: 'tab-1',
    }));
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('locates a table in the sidebar on ctrl/cmd click when configured', async () => {
    storeState.appearance.queryTableCtrlClickAction = 'locate';
    editorState.value = 'select * from analytics.events where id = 1';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
    backendApp.DBGetAllColumns
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 27 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      await Promise.resolve();
    });

    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(backendApp.DBTableExists).not.toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
      detail: expect.objectContaining({
        connectionId: 'conn-1',
        dbName: 'analytics',
        tableName: 'events',
        objectGroup: 'tables',
      }),
    }));
    const locateEvent = (window.dispatchEvent as any).mock.calls
      .map(([event]: [CustomEvent]) => event)
      .find((event: CustomEvent) => event?.type === 'gonavi:locate-sidebar-object');
    expect(locateEvent?.detail).not.toHaveProperty('tabId');
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('revalidates fresh table metadata and ignores a stale cmd-click table link', async () => {
    editorState.value = 'select * from customr;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_ai_dev' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_mkefu_ai_dev: 'customr' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_ai_dev' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    backendApp.DBTableExists.mockResolvedValueOnce({ success: true, data: { exists: false } });
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    await act(async () => {
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customr'.length } },
        event: { ctrlKey: false, metaKey: true },
      });
    });
    expect(editorState.domNode.style.cursor).toBe('pointer');

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customr'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'mkefu_ai_dev', 'customr');
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).toHaveBeenCalledWith('表 customr 已不存在，已刷新 SQL 编辑器元数据。');
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(editorState.domNode.style.cursor).toBe('');
    expect(editorState.editor.updateOptions).toHaveBeenLastCalledWith({ mouseStyle: 'text' });

    backendApp.DBGetColumns.mockClear();
    backendApp.DBGetTables.mockClear();
    backendApp.DBTableExists.mockClear();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customr'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBGetTables).not.toHaveBeenCalled();
    expect(backendApp.DBTableExists).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalled();
  });

  it('does not treat a same-name table in another schema as the deleted navigation target', async () => {
    editorState.value = 'select * from dbo.users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'dbo.users' }, { Table: 'audit.users' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBTableExists.mockResolvedValueOnce({ success: true, data: { exists: false } });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from dbo.users'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'dbo.users');
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).toHaveBeenCalledWith('表 dbo.users 已不存在，已刷新 SQL 编辑器元数据。');

    backendApp.DBTableExists.mockClear();
    storeState.addTab.mockClear();
    editorState.value = 'select * from audit.users;';
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from audit.users'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'audit.users');
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      dbName: 'main',
      tableName: 'audit.users',
    }));
  });

  it('does not restore a missing table from a metadata request that started before validation', async () => {
    editorState.value = 'select * from customr;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_ai_dev' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_mkefu_ai_dev: 'customr' }],
    });
    let resolveColumns: ((value: { success: boolean; data: Array<Record<string, string>> }) => void) | undefined;
    backendApp.DBGetAllColumns.mockImplementationOnce(() => new Promise((resolve) => {
      resolveColumns = resolve;
    }));
    backendApp.DBTableExists.mockResolvedValueOnce({ success: true, data: { exists: false } });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_ai_dev' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    const clickCustomr = () => editorState.mouseDownListeners[0]?.({
      target: { position: { lineNumber: 1, column: 'select * from customr'.length } },
      event: {
        browserEvent: { button: 0, buttons: 1 },
        ctrlKey: false,
        metaKey: true,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      },
    });
    await act(async () => {
      clickCustomr();
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });
    expect(messageApi.warning).toHaveBeenCalledWith('表 customr 已不存在，已刷新 SQL 编辑器元数据。');

    await act(async () => {
      resolveColumns?.({
        success: true,
        data: [{ tableName: 'customr', name: 'id', type: 'bigint' }],
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    backendApp.DBTableExists.mockClear();
    storeState.addTab.mockClear();
    await act(async () => {
      clickCustomr();
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBTableExists).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalled();
  });

  it('keeps table navigation available when existence validation fails', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      editorState.value = 'select * from customer;';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [{ Tables_in_main: 'customer' }],
      });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      backendApp.DBTableExists.mockRejectedValueOnce(new Error('metadata unavailable'));
      await act(async () => {
        editorState.mouseDownListeners[0]?.({
          target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
          event: {
            browserEvent: { button: 0, buttons: 1 },
            ctrlKey: false,
            metaKey: true,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
      expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'customer');
      expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        type: 'table',
        connectionId: 'conn-1',
        dbName: 'main',
        tableName: 'customer',
      }));
      expect(messageApi.warning).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('ignores a table navigation response after the query editor becomes inactive', async () => {
    editorState.value = 'select * from customer;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'customer' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    let resolveValidation: ((value: { success: boolean; data: { exists: boolean } }) => void) | undefined;
    backendApp.DBTableExists.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));

    let renderer: ReactTestRenderer;
    const tab = createTab({ query: editorState.value, dbName: 'main' });
    await act(async () => {
      renderer = create(<QueryEditor tab={tab} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      await Promise.resolve();
    });

    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
    expect(backendApp.DBTableExists).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer!.update(<QueryEditor tab={tab} isActive={false} />);
    });
    await act(async () => {
      resolveValidation?.({ success: true, data: { exists: true } });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('ignores a table navigation response after the Monaco editor is disposed', async () => {
    editorState.value = 'select * from customer;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'customer' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    let resolveValidation: ((value: { success: boolean; data: { exists: boolean } }) => void) | undefined;
    backendApp.DBTableExists.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      await Promise.resolve();
    });

    const mountedModel = editorState.editor.getModel();
    editorState.editor.getModel.mockReturnValue(null);
    try {
      await act(async () => {
        resolveValidation?.({ success: true, data: { exists: false } });
        for (let i = 0; i < 4; i += 1) {
          await Promise.resolve();
        }
      });

      expect(backendApp.DBTableExists).toHaveBeenCalledTimes(1);
      expect(storeState.addTab).not.toHaveBeenCalled();
      expect(messageApi.warning).not.toHaveBeenCalled();
    } finally {
      editorState.editor.getModel.mockReturnValue(mountedModel);
    }
  });

  it('ignores a table navigation response after switching databases on the same connection', async () => {
    editorState.value = 'select * from customer;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'main' }, { Database: 'archive' }],
    });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'customer' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    let resolveValidation: ((value: { success: boolean; data: { exists: boolean } }) => void) | undefined;
    backendApp.DBTableExists.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));

    let renderer: ReactTestRenderer;
    const tab = createTab({ query: editorState.value, dbName: 'main' });
    await act(async () => {
      renderer = create(<QueryEditor tab={tab} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.update(<QueryEditor tab={{ ...tab, dbName: 'archive' }} />);
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });
    await act(async () => {
      resolveValidation?.({ success: true, data: { exists: true } });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'customer');
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('ignores a table navigation response after replacing the config of the same connection', async () => {
    editorState.value = 'select * from customer;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'customer' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    let resolveValidation: ((value: { success: boolean; data: { exists: boolean } }) => void) | undefined;
    backendApp.DBTableExists.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      await Promise.resolve();
    });

    storeState.connections = storeState.connections.map((connection) => (
      connection.id === 'conn-1'
        ? { ...connection, config: { ...connection.config, host: '10.0.0.2' } }
        : connection
    ));
    await act(async () => {
      notifyStoreSubscribers();
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });
    await act(async () => {
      resolveValidation?.({ success: true, data: { exists: true } });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBTableExists).toHaveBeenCalledTimes(1);
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('fails open when table existence validation times out', async () => {
    vi.useFakeTimers();
    try {
      editorState.value = 'select * from customer;';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [{ Tables_in_main: 'customer' }],
      });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBTableExists.mockImplementationOnce(() => new Promise(() => undefined));

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });
      await act(async () => {
        editorState.mouseDownListeners[0]?.({
          target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
          event: {
            browserEvent: { button: 0, buttons: 1 },
            ctrlKey: false,
            metaKey: true,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        await Promise.resolve();
      });

      expect(storeState.addTab).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        for (let i = 0; i < 4; i += 1) {
          await Promise.resolve();
        }
      });

      expect(backendApp.DBTableExists).toHaveBeenCalledTimes(1);
      expect(storeState.addTab).toHaveBeenCalledTimes(1);
      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        type: 'table',
        dbName: 'main',
        tableName: 'customer',
      }));
      expect(messageApi.warning).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('performs one table navigation action for repeated clicks on the same pending target', async () => {
    editorState.value = 'select * from customer;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'customer' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    let resolveValidation: ((value: { success: boolean; data: { exists: boolean } }) => void) | undefined;
    backendApp.DBTableExists.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    const clickCustomer = () => editorState.mouseDownListeners[0]?.({
      target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
      event: {
        browserEvent: { button: 0, buttons: 1 },
        ctrlKey: false,
        metaKey: true,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      },
    });
    await act(async () => {
      clickCustomer();
      clickCustomer();
      await Promise.resolve();
    });
    expect(backendApp.DBTableExists).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveValidation?.({ success: true, data: { exists: true } });
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.addTab).toHaveBeenCalledTimes(1);
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('validates concurrent table links independently and clears each missing target', async () => {
    editorState.value = 'select * from alpha join beta on alpha.id = beta.id;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'alpha' }, { Tables_in_main: 'beta' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    backendApp.DBTableExists.mockResolvedValue({ success: true, data: { exists: false } });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    const clickTable = (tableName: string) => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: editorState.value.indexOf(tableName) + 2 } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
    };
    await act(async () => {
      clickTable('alpha');
      clickTable('beta');
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
    expect(backendApp.DBTableExists).toHaveBeenCalledTimes(2);
    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'alpha');
    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'beta');
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).toHaveBeenCalledWith('表 alpha 已不存在，已刷新 SQL 编辑器元数据。');
    expect(messageApi.warning).toHaveBeenCalledWith('表 beta 已不存在，已刷新 SQL 编辑器元数据。');
  });

  it('opens a routine object-edit tab on ctrl click without locating the sidebar tree', async () => {
    storeState.connections[0].config.type = 'postgres';
    editorState.value = 'call reporting.refresh_stats();';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      const text = String(sql || '');
      if (text.includes('pg_get_functiondef')) {
        return {
          success: true,
          data: [{
            routine_definition: 'CREATE OR REPLACE PROCEDURE reporting.refresh_stats() LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$;',
          }],
        };
      }
      if (text.includes('FROM pg_proc') || text.includes('information_schema.routines')) {
        return {
          success: true,
          data: [{ schema_name: 'reporting', routine_name: 'refresh_stats', routine_type: 'PROCEDURE' }],
        };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 21 } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('refresh_stats'),
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      queryMode: 'object-edit',
      routineName: 'reporting.refresh_stats',
      routineType: 'PROCEDURE',
      returnToTabId: 'tab-1',
      query: expect.stringContaining('CREATE OR REPLACE PROCEDURE reporting.refresh_stats()'),
    }));
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('opens a MySQL procedure object-edit tab from a CALL routine link', async () => {
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    editorState.value = 'CALL codex_tmp_proc_link_test();';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      const text = String(sql || '');
      if (text.includes('information_schema.routines') || text.includes('SHOW FUNCTION STATUS') || text.includes('SHOW PROCEDURE STATUS')) {
        return {
          success: true,
          data: [{ routine_name: 'codex_tmp_proc_link_test', routine_type: 'PROCEDURE', schema_name: 'main' }],
        };
      }
      if (text.includes('SHOW CREATE PROCEDURE')) {
        return {
          success: true,
          data: [{
            'Create Procedure': 'CREATE PROCEDURE codex_tmp_proc_link_test() BEGIN SELECT 1 AS codex_tmp_result; END',
          }],
        };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 12 } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBQuery).toHaveBeenCalledWith(expect.any(Object), 'main', 'SHOW CREATE PROCEDURE `codex_tmp_proc_link_test`');
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('codex_tmp_proc_link_test'),
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      queryMode: 'object-edit',
      query: expect.stringContaining('CREATE PROCEDURE codex_tmp_proc_link_test()'),
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('does not read the full editor model when ctrl/cmd clicking objects in large SQL', async () => {
    editorState.value = [
      ...Array.from({ length: 4000 }, (_, index) => `-- filler ${index + 1}`),
      'select * from analytics.events where id = 1',
    ].join('\n');
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
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

    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();
    const lineNumber = editorState.value.split('\n').length;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber, column: 27 } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: true,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.getModel().getValueLength).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValue).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'analytics',
      tableName: 'events',
      initialViewMode: 'fields',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('adds formatted DDL to the SQL table hover without opening the table', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    // ALTER 成功后会触发编辑器元数据重载，库/表元数据需持续返回以模拟真实场景（表仍然存在）
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY, name VARCHAR(64))' })
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY, name VARCHAR(64), email VARCHAR(128))' })
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY, name VARCHAR(64), email VARCHAR(128), status TINYINT)' });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editorState.hoverProviders).toHaveLength(4);
    const ddlHover = await editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'main',
      'users',
    );
    expect(ddlHover?.contents?.[0]?.value).toContain('```sql');
    expect(ddlHover?.contents?.[0]?.value).toContain('CREATE TABLE users');
    const metadataHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
    );
    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `users`');
    expect(storeState.addTab).not.toHaveBeenCalled();

    backendApp.DBQueryMulti.mockResolvedValueOnce({ success: true, data: [] });
    await act(async () => {
      editorState.value = 'ALTER TABLE users ADD COLUMN email VARCHAR(128)';
      editorState.latestOnChange?.(editorState.value);
      await findButton(renderer, '运行').props.onClick();
    });

    editorState.value = 'SELECT * FROM users';
    const refreshedDdlHover = await editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(2);
    expect(refreshedDdlHover?.contents?.[0]?.value).toContain('email VARCHAR(128)');

    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      partial: true,
      executedCount: 1,
      message: 'second statement failed',
      data: [],
    });
    await act(async () => {
      editorState.value = 'ALTER TABLE users ADD COLUMN status TINYINT; SELECT * FROM missing_table';
      editorState.latestOnChange?.(editorState.value);
      await findButton(renderer, '运行').props.onClick();
    });

    editorState.value = 'SELECT * FROM users';
    const partialBatchDdlHover = await editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(3);
    expect(partialBatchDdlHover?.contents?.[0]?.value).toContain('status TINYINT');
  });

  it('renders table metadata when a formatted query places FROM and the table on separate lines', async () => {
    editorState.value = 'SELECT *\nFROM\n  users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const lineContent = editorState.editor.getModel().getLineContent(3);
    const metadataHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 3, column: lineContent.length + 1 },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `users`');
  });

  it('renders metadata for the screenshot-shaped table reference with leading blank lines', async () => {
    editorState.value = '\n\nSELECT *\nFROM test_users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'test_users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const metadataHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 4, column: 10 },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `test_users`');
  });

  it('renders a table source when the loaded table list does not contain the hovered name', async () => {
    editorState.value = 'SELECT *\nFROM test_users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'other_table' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const metadataHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 2, column: 15 },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `test_users`');
  });

  it('renders fallback table metadata for a cross-line source missing from the current database', async () => {
    editorState.value = 'SELECT *\nFROM\n  test_users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'other_table' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const lineContent = editorState.editor.getModel().getLineContent(3);
    const metadataHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 3, column: lineContent.length + 1 },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `test_users`');
    expect(metadataHover?.contents?.[0]?.value).toContain('库：`main`');
  });

  it('renders fallback table metadata while current-database metadata is still loading', async () => {
    editorState.value = 'SELECT *\nFROM\n  test_users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    let resolveTables!: (value: any) => void;
    backendApp.DBGetTables.mockImplementation(() => new Promise((resolve) => {
      resolveTables = resolve;
    }));
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const lineContent = editorState.editor.getModel().getLineContent(3);
    const metadataHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 3, column: lineContent.length + 1 },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `test_users`');
    expect(metadataHover?.contents?.[0]?.value).toContain('库：`main`');

    resolveTables({ success: true, data: [] });
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    renderer.unmount();
  });

  it('loads DDL from an inferred table source while table metadata is unavailable', async () => {
    editorState.value = 'SELECT *\nFROM test_users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE test_users (id BIGINT PRIMARY KEY)',
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const ddlHover = await editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 2, column: 15 },
      { isCancellationRequested: false },
    );

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'main',
      'test_users',
    );
    expect(ddlHover?.contents?.[0]?.value).toContain('CREATE TABLE test_users');
  });

  it('preserves the selected PostgreSQL schema when inferred DDL loads without table metadata', async () => {
    storeState.connections[0].config.type = 'postgres';
    editorState.value = 'SELECT *\nFROM users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE sales.users (id BIGINT PRIMARY KEY)',
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: editorState.value,
        dbName: 'main',
        schemaName: 'sales',
      })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const ddlHover = await editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 2, column: 10 },
      { isCancellationRequested: false },
    );

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'postgres' }),
      'main',
      'sales.users',
    );
    expect(ddlHover?.contents?.[0]?.value).toContain('CREATE TABLE sales.users');
  });

  it('drops a delayed inferred DDL hover when the selected PostgreSQL schema changes', async () => {
    storeState.connections[0].config.type = 'postgres';
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation((_config: unknown, _dbName: string, sql: string) => {
      const normalizedSql = String(sql || '').toLowerCase();
      if (normalizedSql.includes('current_schema()')) {
        return Promise.resolve({ success: true, data: [{ schema_name: 'public' }] });
      }
      if (normalizedSql.includes('pg_namespace')) {
        return Promise.resolve({
          success: true,
          data: [{ schema_name: 'public' }, { schema_name: 'sales' }],
        });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    let resolveOldDdl!: (result: { success: boolean; data: string }) => void;
    backendApp.DBShowCreateTable
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOldDdl = resolve;
      }))
      .mockResolvedValueOnce({
        success: true,
        data: 'CREATE TABLE sales.users (id BIGINT PRIMARY KEY, email TEXT)',
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: editorState.value,
        dbName: 'main',
      })} />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    const schemaSelect = () => [...antdSelectState.props].reverse().find((props) => (
      String(props.className || '').includes('gn-v2-query-toolbar-schema-select')
      || props['aria-label'] === catalogs['zh-CN']['query_editor.object_info.label.schema']
    ));
    const pendingDdlHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'postgres' }),
      'main',
      'public.users',
    );

    await act(async () => {
      schemaSelect()?.onChange('sales');
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(schemaSelect()?.value).toBe('sales');
    resolveOldDdl({ success: true, data: 'CREATE TABLE public.users (id BIGINT PRIMARY KEY)' });
    await expect(pendingDdlHover).resolves.toBeNull();

    const refreshedDdlHover = await editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'postgres' }),
      'main',
      'sales.users',
    );
    expect(refreshedDdlHover?.contents?.[0]?.value).toContain('CREATE TABLE sales.users');
    renderer.unmount();
  });

  it('does not render a delayed DDL hover after a successful table alteration', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    // ALTER 成功后触发元数据重载，库/表元数据需持续返回
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    let resolveDdl!: (result: { success: boolean; data: string }) => void;
    backendApp.DBShowCreateTable.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDdl = resolve;
    }));
    backendApp.DBQueryMulti.mockResolvedValueOnce({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const pendingDdlHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(1);

    await act(async () => {
      editorState.value = 'ALTER TABLE users ADD COLUMN email VARCHAR(128)';
      editorState.latestOnChange?.(editorState.value);
      await findButton(renderer, '运行').props.onClick();
    });

    let staleDdlHover: any;
    await act(async () => {
      resolveDdl({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY)' });
      staleDdlHover = await pendingDdlHover;
    });

    expect(staleDdlHover).toBeNull();
  });

  it('does not accept an old DDL hover after the database context makes a round trip', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }, { Database: 'other' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: unknown, dbName: string) => ({
      success: true,
      data: dbName === 'main' ? [{ Tables_in_main: 'users' }] : [],
    }));
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    let resolveOldDdl!: (result: { success: boolean; data: string }) => void;
    backendApp.DBShowCreateTable
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOldDdl = resolve;
      }))
      .mockResolvedValue({
        success: true,
        data: 'CREATE TABLE users (id BIGINT PRIMARY KEY, fresh_flag BOOLEAN)',
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const pendingDdlHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'other' })} />);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    resolveOldDdl({ success: true, data: 'CREATE TABLE users (id BIGINT PRIMARY KEY, stale_flag BOOLEAN)' });
    await expect(pendingDdlHover).resolves.toBeNull();

    const freshDdlHover = await editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(2);
    expect(freshDdlHover?.contents?.[0]?.value).toContain('fresh_flag');
    expect(freshDdlHover?.contents?.[0]?.value).not.toContain('stale_flag');
    renderer.unmount();
  });

  it('refreshes the DDL hover after an unconfirmed failed schema statement', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    // ALTER 失败但结果不确定时仍会触发元数据重载，库/表元数据需持续返回
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY)' })
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY, email VARCHAR(128))' });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      partial: true,
      executedCount: 0,
      message: 'connection closed after execution',
      data: [],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(1);

    await act(async () => {
      editorState.value = 'ALTER TABLE users ADD COLUMN email VARCHAR(128)';
      editorState.latestOnChange?.(editorState.value);
      await findButton(renderer, '运行').props.onClick();
    });

    editorState.value = 'SELECT * FROM users';
    const refreshedDdlHover = await editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(2);
    expect(refreshedDdlHover?.contents?.[0]?.value).toContain('email VARCHAR(128)');
  });

  it('reloads query editor metadata after a schema refresh event', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    let resolveRefreshedTables!: (value: any) => void;
    const refreshedTables = new Promise((resolve) => {
      resolveRefreshedTables = resolve;
    });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockImplementationOnce(() => refreshedTables);
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    // beforeEach 的 window 桩不会真正传播事件；本测试需要 sidebar 刷新事件触达编辑器监听器
    const baseWindow: any = window;
    const refreshEventListeners: Array<(event: Event) => void> = [];
    vi.stubGlobal('window', {
      ...baseWindow,
      addEventListener: (type: string, handler: (event: Event) => void) => {
        if (type === 'gonavi:sidebar-database-refresh') refreshEventListeners.push(handler);
        baseWindow.addEventListener?.(type, handler);
      },
      removeEventListener: (type: string, handler: (event: Event) => void) => {
        const index = refreshEventListeners.indexOf(handler);
        if (index >= 0) refreshEventListeners.splice(index, 1);
        baseWindow.removeEventListener?.(type, handler);
      },
      dispatchEvent: (event: Event) => {
        if (event?.type === 'gonavi:sidebar-database-refresh') {
          refreshEventListeners.slice().forEach((handler) => handler(event));
        }
        return true;
      },
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const initialMetadataHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
    );
    expect(initialMetadataHover?.contents?.[0]?.value).toContain('**表** `users`');

    await act(async () => {
      window.dispatchEvent(new CustomEvent('gonavi:sidebar-database-refresh', {
        detail: { connectionId: 'conn-1', dbName: 'main' },
      }));
    });

    // 结构变更一旦被确认，旧 metadata 不能继续被 hover 使用；新请求尚在飞行中时只允许基础兜底信息。
    const pendingMetadataHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
    );
    expect(pendingMetadataHover?.contents?.[0]?.value).toContain('**表** `users`');
    expect(pendingMetadataHover?.contents?.[0]?.value).toContain('库：`main`');

    await act(async () => {
      resolveRefreshedTables({ success: true, data: [] });
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
    });

    const refreshedMetadataHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
    );
    expect(refreshedMetadataHover?.contents?.[0]?.value).toContain('**表** `users`');
    expect(refreshedMetadataHover?.contents?.[0]?.value).toContain('库：`main`');
  });

  it('reloads an inactive query editor when its connection schema changes', async () => {
    autoFetchState.visible = true;
    storeState.connections = [
      ...createDefaultConnections(),
      {
        id: 'conn-2',
        name: 'secondary',
        config: {
          type: 'mysql',
          host: '127.0.0.2',
          port: 3306,
          user: 'root',
          password: '',
          database: 'main',
        },
      },
    ];
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    const baseWindow: any = window;
    const refreshEventListeners: Array<(event: Event) => void> = [];
    vi.stubGlobal('window', {
      ...baseWindow,
      addEventListener: (type: string, handler: (event: Event) => void) => {
        if (type === 'gonavi:sidebar-database-refresh') refreshEventListeners.push(handler);
        baseWindow.addEventListener?.(type, handler);
      },
      removeEventListener: (type: string, handler: (event: Event) => void) => {
        const index = refreshEventListeners.indexOf(handler);
        if (index >= 0) refreshEventListeners.splice(index, 1);
        baseWindow.removeEventListener?.(type, handler);
      },
      dispatchEvent: (event: Event) => {
        if (event?.type === 'gonavi:sidebar-database-refresh') {
          refreshEventListeners.slice().forEach((handler) => handler(event));
        }
        return true;
      },
    });

    const renderEditors = (firstActive: boolean) => (
      <>
        <QueryEditor tab={createTab({ id: 'tab-1', connectionId: 'conn-1', query: 'SELECT * FROM users' })} isActive={firstActive} />
        <QueryEditor tab={createTab({ id: 'tab-2', connectionId: 'conn-2', query: 'SELECT * FROM users' })} isActive={!firstActive} />
      </>
    );
    const countConnectionCalls = (host: string) => backendApp.DBGetTables.mock.calls.filter(
      ([config]: any[]) => config?.host === host,
    ).length;

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderEditors(true));
    });
    await vi.waitFor(() => {
      expect(countConnectionCalls('127.0.0.1')).toBeGreaterThan(0);
    });

    await act(async () => {
      renderer.update(renderEditors(false));
    });
    await vi.waitFor(() => {
      expect(countConnectionCalls('127.0.0.2')).toBeGreaterThan(0);
    });
    const initialFirstConnectionCalls = countConnectionCalls('127.0.0.1');

    await act(async () => {
      window.dispatchEvent(new CustomEvent('gonavi:sidebar-database-refresh', {
        detail: { connectionId: 'conn-1', dbName: 'main' },
      }));
    });
    const activeConnectionHover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
    );
    expect(activeConnectionHover?.contents?.[0]?.value).toContain('**表** `users`');

    await act(async () => {
      renderer.update(renderEditors(true));
    });
    await vi.waitFor(() => {
      expect(countConnectionCalls('127.0.0.1')).toBeGreaterThan(initialFirstConnectionCalls);
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('restores an edited trigger when the replacement fails after DROP', async () => {
    const triggerRollbackSql = 'CREATE TRIGGER `users_bi` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.updated_at = NOW();';
    editorState.value = [
      '-- trigger replacement',
      'DROP TRIGGER IF EXISTS `users_bi`;',
      'CREATE TRIGGER `users_bi` BEFORE INSERT ON `users` FOR EACH ROW BEGIN',
      '  SET NEW.updated_at = CURRENT_TIMESTAMP;',
      'END;',
    ].join('\n');
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 5,
      endColumn: editorState.value.split('\n')[editorState.value.split('\n').length - 1]!.length + 1,
    };
    autoFetchState.visible = true;
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      message: 'replacement failed',
      executedCount: 1,
      failedIndex: 2,
      data: [],
    });
    backendApp.DBQueryAudited.mockResolvedValueOnce({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: editorState.value,
        queryMode: 'object-edit',
        triggerRollbackSql,
      })} isActive />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });

    expect(backendApp.DBQueryAudited).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'main',
      triggerRollbackSql,
      'table_designer',
    );
    const refreshEvents = (window.dispatchEvent as any).mock.calls.filter(
      ([event]: any[]) => event?.type === 'gonavi:sidebar-database-refresh',
    );
    expect(refreshEvents).toHaveLength(2);
  });

  it('keeps multiline table-source resolution after the hover document limit', async () => {
    const padding = '-- padding for a large SQL document\n'.repeat(6_000);
    editorState.value = `${padding}SELECT *\nFROM\n  test`;
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }, { Database: 'test' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: unknown, dbName: string) => ({
      success: true,
      data: dbName === 'main' ? [{ Tables_in_main: 'test' }] : [],
    }));
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await vi.waitFor(() => {
      expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.any(Object), 'main');
    });

    const hover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 6_003, column: 7 },
    );
    expect(hover?.contents?.[0]?.value).toContain('**表** `test`');
    expect(hover?.contents?.[0]?.value).not.toContain('**数据库** `test`');
  });

  it('shows link-style hover feedback when ctrl/cmd is pressed over a navigable identifier', async () => {
    editorState.value = 'select * from analytics.events where id = 1';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
    backendApp.DBGetAllColumns
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [{ tableName: 'events', name: 'id', type: 'bigint', comment: '事件ID' }] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 27 } },
        event: {
          ctrlKey: true,
          metaKey: false,
        },
      });
    });

    expect(editorState.editor.deltaDecorations).toHaveBeenCalled();
    expect(editorState.domNode.style.cursor).toBe('pointer');
    const lastDecorationCall = editorState.editor.deltaDecorations.mock.calls.at(-1);
    expect(lastDecorationCall?.[1]?.[0]?.options?.inlineClassName).toBe('gonavi-query-editor-link-hint');
    expect(lastDecorationCall?.[1]?.[0]?.options?.hoverMessage).toBeUndefined();

    const hover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 27 },
    );
    const hoverText = String(hover?.contents?.[0]?.value || '');
    expect(hoverText.match(/\*\*表\*\*/g)).toHaveLength(1);
    expect(hoverText).toContain('**表** `events`');

    await act(async () => {
      editorState.mouseLeaveListeners[0]?.();
    });
    expect(editorState.domNode.style.cursor).toBe('');
    expect(editorState.editor.updateOptions).toHaveBeenLastCalledWith({ mouseStyle: 'text' });
  });

  it('keeps link-style feedback when modifier state is tracked but mousemove omits ctrl/meta flags', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'SELECT * FROM uk_user';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'uk_user' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_location_dev_local' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.editor.deltaDecorations.mockClear();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener({
        type: 'keydown',
        ctrlKey: true,
        metaKey: false,
        key: 'Control',
        code: 'ControlLeft',
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      }));
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 18 } },
        event: {
          ctrlKey: false,
          metaKey: false,
        },
      });
    });

    expect(editorState.domNode.style.cursor).toBe('pointer');
    const lastDecorationCall = editorState.editor.deltaDecorations.mock.calls.at(-1);
    expect(lastDecorationCall?.[1]?.[0]?.options?.inlineClassName).toBe('gonavi-query-editor-link-hint');
  });

  it('opens an object tab when modifier state is tracked but mousedown omits ctrl/meta flags', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'SELECT * FROM uk_user';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'uk_user' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_location_dev_local' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener({
        type: 'keydown',
        ctrlKey: true,
        metaKey: false,
        key: 'Control',
        code: 'ControlLeft',
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      }));
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 18 } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'mkefu_location_dev_local',
      tableName: 'uk_user',
      initialViewMode: 'fields',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('opens an object tab when mousedown stores ctrl/meta flags on the native browser event', async () => {
    editorState.value = 'SELECT * FROM uk_user';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'uk_user' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_location_dev_local' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 18 } },
        event: {
          leftButton: true,
          ctrlKey: false,
          metaKey: false,
          browserEvent: {
            button: 0,
            buttons: 1,
            ctrlKey: false,
            metaKey: true,
            preventDefault,
            stopPropagation,
          },
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'mkefu_location_dev_local',
      tableName: 'uk_user',
      initialViewMode: 'fields',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('shows link-style feedback from the current cursor when ctrl/cmd is pressed without moving the mouse', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'SELECT * FROM uk_user';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM uk_user'.length + 1 };
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'uk_user' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_location_dev_local' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.editor.deltaDecorations.mockClear();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener({
        ctrlKey: true,
        metaKey: false,
        key: 'Control',
        code: 'ControlLeft',
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      }));
    });

    expect(editorState.editor.deltaDecorations).toHaveBeenCalled();
    expect(editorState.domNode.style.cursor).toBe('pointer');
    const lastDecorationCall = editorState.editor.deltaDecorations.mock.calls.at(-1);
    expect(lastDecorationCall?.[1]?.[0]?.options?.inlineClassName).toBe('gonavi-query-editor-link-hint');
  });

  it('treats modifier keydown itself as pressed when desktop WebView omits ctrl/meta flags', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'SELECT * FROM uk_user';
    editorState.position = { lineNumber: 1, column: 'SELECT * FROM uk_user'.length + 1 };
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_location_dev_local' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_mkefu_location_dev_local: 'uk_user' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_location_dev_local' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.editor.deltaDecorations.mockClear();
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener({
        type: 'keydown',
        ctrlKey: false,
        metaKey: false,
        key: 'Meta',
        code: 'MetaLeft',
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      }));
    });

    expect(editorState.domNode.style.cursor).toBe('pointer');
    const lastDecorationCall = editorState.editor.deltaDecorations.mock.calls.at(-1);
    expect(lastDecorationCall?.[1]?.[0]?.options?.inlineClassName).toBe('gonavi-query-editor-link-hint');
  });

  it('shows hover shortcut hints in English for every navigable object kind', () => {
    setCurrentLanguage('en-US');

    const tables = [
      { dbName: 'main', tableName: 'users' },
      { dbName: 'analytics', tableName: 'events' },
    ];
    const views = [
      { dbName: 'main', viewName: 'reporting.active_users', schemaName: 'reporting' },
    ];
    const materializedViews = [
      { dbName: 'analytics', viewName: 'mv_daily_stats', schemaName: undefined },
    ];
    const triggers = [
      { dbName: 'main', triggerName: 'audit.users_bi', tableName: 'audit.users', schemaName: 'audit' },
    ];
    const routines = [
      { dbName: 'main', routineName: 'reporting.refresh_stats', routineType: 'PROCEDURE', schemaName: 'reporting' },
      { dbName: 'main', routineName: 'reporting.score_user', routineType: 'FUNCTION', schemaName: 'reporting' },
    ];
    const sequences = [
      { dbName: 'main', sequenceName: 'billing.order_seq', schemaName: 'billing' },
    ];
    const packages = [
      { dbName: 'main', packageName: 'billing.pkg_order', schemaName: 'billing' },
    ];

    const cases = [
      { lineContent: 'use analytics', column: 6, expected: 'Ctrl + click to switch to this database' },
      { lineContent: 'select * from analytics.events', column: 27, expected: 'Ctrl + click to open this table object design' },
      { lineContent: 'select * from reporting.active_users', column: 31, expected: 'Ctrl + click to open this view' },
      { lineContent: 'select * from analytics.mv_daily_stats', column: 37, expected: 'Ctrl + click to open this materialized view' },
      { lineContent: 'call audit.users_bi()', column: 18, expected: 'Ctrl + click to open this trigger' },
      { lineContent: 'call reporting.refresh_stats()', column: 21, expected: 'Ctrl + click to open this stored procedure' },
      { lineContent: 'select reporting.score_user()', column: 21, expected: 'Ctrl + click to open this function' },
      { lineContent: 'select billing.order_seq.nextval from dual', column: 18, expected: 'Ctrl + click to open this sequence' },
      { lineContent: 'begin billing.pkg_order.sync_order(1); end;', column: 16, expected: 'Ctrl + click to open this package' },
    ];

    for (const testCase of cases) {
      const decorations = resolveQueryEditorNavigationDecorations(
        testCase.lineContent,
        testCase.column,
        'main',
        ['main', 'analytics'],
        tables,
        views,
        materializedViews,
        triggers,
        routines,
        sequences,
        packages,
        'Ctrl',
      );

      expect(decorations).toHaveLength(1);
      expect(decorations[0]?.hoverMessage).toBe(testCase.expected);
      expect(decorations[0]?.hoverMessage).not.toMatch(/[点點]击|打开|切换|数据库|表|视图|触发器|存储过程|函数/);
    }
  });

  it('formats SQL through Monaco edits so beautify can be undone', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select * from users where id=1' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(editorState.editor.pushUndoStop).toHaveBeenCalledTimes(2);
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('SELECT'),
        }),
      ]),
    );
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      formatRestoreSnapshot: {
        query: 'select * from users where id=1',
        createdAt: expect.any(Number),
      },
    });
  });

  it('resets stale horizontal scroll after formatting a long single-line SQL statement', async () => {
    let renderer!: ReactTestRenderer;
    const longSql = `select ${Array.from({ length: 80 }, (_, index) => `column_${index + 1}`).join(', ')} from users where id=1`;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: longSql })} />);
    });

    editorState.scrollLeft = 2400;

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalled();
    expect(editorState.editor.setScrollLeft).toHaveBeenCalledWith(0);
    expect(editorState.scrollLeft).toBe(0);
  });

  it('formats only the selected SQL when a non-empty selection exists', async () => {
    let renderer!: ReactTestRenderer;
    const originalSql = 'select 1; select * from users where id=1';

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: originalSql })} />);
    });

    editorState.selection = {
      startLineNumber: 1,
      startColumn: 11,
      endLineNumber: 1,
      endColumn: originalSql.length + 1,
    };

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          range: expect.objectContaining({
            startLineNumber: 1,
            startColumn: 11,
            endLineNumber: 1,
            endColumn: originalSql.length + 1,
          }),
          text: expect.stringContaining('SELECT'),
        }),
      ]),
    );
    expect(editorState.value.startsWith('select 1;')).toBe(true);
    expect(editorState.value).toContain('SELECT');
    expect(editorState.value).not.toBe(originalSql);
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      formatRestoreSnapshot: {
        query: originalSql,
        createdAt: expect.any(Number),
      },
    });
  });

  it('registers a configurable Monaco shortcut action for SQL formatting', async () => {
    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'select * from users where id=1' })} />);
    });

    const formatAction = findEditorAction('gonavi.formatSql');
    expect(formatAction).toMatchObject({
      id: 'gonavi.formatSql',
      label: 'GoNavi: 美化 SQL',
      keybindings: [512 | 1024 | 70],
    });

    formatAction.run();

    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gonavi:format-active-query' }),
    );
  });

  it('restores the last pre-beautify SQL snapshot after reopening a query tab', async () => {
    let renderer!: ReactTestRenderer;
    const originalSql = 'select * from users where id=1';

    await act(async () => {
      renderer = create(
        <QueryEditor
          tab={createTab({
            query: 'SELECT\n  *\nFROM\n  users\nWHERE\n  id = 1',
            formatRestoreSnapshot: {
              query: originalSql,
              createdAt: 123,
            },
          })}
        />,
      );
    });

    const restoreButton = findButton(renderer, '还原上次美化');
    await act(async () => {
      await restoreButton.props.onClick();
    });

    expect(editorState.value).toBe(originalSql);
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith('tab-1', {
      query: originalSql,
      formatRestoreSnapshot: undefined,
    });
    expect(messageApi.success).toHaveBeenCalledWith('已还原到美化前 SQL');
  });

  it('formats OceanBase Oracle SQL with parameter placeholders', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    const oracleSql = 'select * from users where id = #{id,jdbcType=NUMBER} and tenant = ${tenant} and status = :status and code = ?';

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: oracleSql, dbName: 'main' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringMatching(/#\{id,jdbcType=NUMBER\}[\s\S]*\$\{tenant\}[\s\S]*:status[\s\S]*\?/),
        }),
      ]),
    );
  });

  it('formats Dameng SQL with positional parameter placeholders', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections[0].config.type = 'dameng';
    const damengSql = 'SELECT COUNT(*) AS total FROM VULNERABILITY_RESOURCE_T WHERE (TASK_ID = ?)';

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: damengSql, dbName: 'SLGZT' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('TASK_ID = ?'),
        }),
      ]),
    );
    expect(runtimeApi.LogInfo).toHaveBeenCalledWith(expect.stringMatching(
      /^\[SQL美化\] 成功：language=plsql dbType=dameng driver=\(default\) scope=full sqlLength=\d+ positional=true durationMs=\d+(?:\.\d+)? changed=true$/,
    ));
    const successLog = runtimeApi.LogInfo.mock.calls[runtimeApi.LogInfo.mock.calls.length - 1]?.[0];
    expect(successLog).not.toContain('VULNERABILITY_RESOURCE_T');
  });

  it('logs SQL formatter failures without exposing the SQL text', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections[0].config.type = 'oracle';
    const sensitiveSql = "SELECT * FROM CUSTOMER_SECRET WHERE TOKEN = 'do-not-log' AND ID = ?";

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: sensitiveSql, dbName: 'APP' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).toHaveBeenCalledWith('格式化失败：SQL 语法可能有误。');
    expect(runtimeApi.LogError).toHaveBeenCalledWith(expect.stringMatching(
      /^\[SQL美化\] 失败：language=plsql dbType=oracle driver=\(default\) scope=full sqlLength=\d+ positional=false durationMs=\d+(?:\.\d+)? error=Parse error:/,
    ));
    const failureLog = String(runtimeApi.LogError.mock.calls[runtimeApi.LogError.mock.calls.length - 1]?.[0] || '');
    expect(failureLog).not.toContain('CUSTOMER_SECRET');
    expect(failureLog).not.toContain('do-not-log');
  });

  it('preserves postgres JSONB question-mark operators while formatting', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    const pgSql = "select * from items where data ?| array['a','b'] and data ?& array['c']";

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: pgSql, dbName: 'main' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("data ?| ARRAY['a', 'b']"),
        }),
      ]),
    );
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("data ?& ARRAY['c']"),
        }),
      ]),
    );
  });

  it('formats postgres window-function SQL with cast syntax through Monaco edits', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections[0].config.type = 'postgres';
    storeState.connections[0].config.database = 'main';
    const pgSql = [
      'SELECT',
      `FLOOR(DATE_PART('epoch', "CREATE_TIME" - LAG("END_TIME") OVER (ORDER BY "CREATE_TIME" asc, "ID" desc))*1000)::int as time_diff_seconds,`,
      '*',
      `FROM "FAM_RU_BLOCK" WHERE "RU_JOB_ID" = ''`,
    ].join('\n');

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: pgSql, dbName: 'main' })} />);
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining(')::int AS time_diff_seconds'),
        }),
      ]),
    );
  });

  it('formats postgres cast syntax after switching to another query tab connection', async () => {
    let renderer!: ReactTestRenderer;
    storeState.connections = [
      {
        id: 'conn-1',
        name: 'mysql-local',
        config: {
          type: 'mysql',
          host: '127.0.0.1',
          port: 3306,
          user: 'root',
          password: '',
          database: 'main',
        },
      },
      {
        id: 'conn-2',
        name: 'pg-local',
        config: {
          type: 'postgres',
          host: '127.0.0.1',
          port: 5432,
          user: 'postgres',
          password: '',
          database: 'main',
        },
      },
    ];
    const pgSql = [
      'SELECT',
      '    *,',
      '    is_del = 0',
      'FROM',
      '    wm_stock',
      'WHERE',
      '    1 = 1',
      '    AND is_del = 0',
      "    and create_date > '2025-06-25'::date;",
    ].join('\n');

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ id: 'tab-1', connectionId: 'conn-1', query: 'select 1;' })} />);
    });

    await act(async () => {
      renderer.update(
        <QueryEditor
          tab={createTab({
            id: 'tab-2',
            connectionId: 'conn-2',
            dbName: 'main',
            query: pgSql,
          })}
        />,
      );
    });

    const formatButton = findButton(renderer, '美化');
    await act(async () => {
      await formatButton.props.onClick();
    });

    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-format-sql',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("'2025-06-25'::date;"),
        }),
      ]),
    );
  });

  it('localizes format settings menu labels in English', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select * from users where id=1' })} />);
    });

    expect(findExactButton(renderer, 'Uppercase keywords')).toBeTruthy();
    expect(findExactButton(renderer, 'Lowercase keywords')).toBeTruthy();
    expect(findExactButton(renderer, 'Snippet settings...')).toBeTruthy();
    expect(findExactButton(renderer, 'Shortcut settings...')).toBeTruthy();
    expect(findExactButton(renderer, '关键字大写')).toBeUndefined();
    expect(findExactButton(renderer, '关键字小写')).toBeUndefined();
    expect(findExactButton(renderer, '代码片段管理...')).toBeUndefined();
    expect(findExactButton(renderer, '快捷键管理...')).toBeUndefined();
  });

  it('persists word wrap and applies it to newly opened SQL editors', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select a_very_long_column_name from a_very_long_table_name' })} />);
    });

    expect(monacoEditorMockState.latestProps.options.wordWrap).toBe('off');
    const enableButton = renderer.root.find((node) => (
      node.type === 'button' && node.props?.['aria-label'] === '开启自动换行'
    ));
    expect(enableButton.props['aria-pressed']).toBe(false);
    expect(enableButton.children).toContain('换行');

    await act(async () => {
      enableButton.props.onClick();
      notifyStoreSubscribers();
    });

    expect(storeState.setQueryOptions).toHaveBeenCalledWith({ wordWrap: true });
    expect(monacoEditorMockState.latestProps.options.wordWrap).toBe('on');
    const disableButton = renderer.root.find((node) => (
      node.type === 'button' && node.props?.['aria-label'] === '关闭自动换行'
    ));
    expect(disableButton.props['aria-pressed']).toBe(true);
    expect(disableButton.children).toContain('换行');

    await act(async () => {
      renderer.unmount();
      renderer = create(<QueryEditor tab={createTab({ id: 'tab-2', query: 'select 2' })} />);
    });

    expect(monacoEditorMockState.latestProps.options.wordWrap).toBe('on');
    const newEditorDisableButton = renderer.root.find((node) => (
      node.type === 'button' && node.props?.['aria-label'] === '关闭自动换行'
    ));
    expect(newEditorDisableButton.props['aria-pressed']).toBe(true);
  });

  it('shows object info via editor ctrl+q action', async () => {
    editorState.value = 'select users.id from users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [{ tableName: 'users', name: 'id', type: 'bigint', comment: '主键ID' }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const showObjectInfoAction = editorState.editor.addAction.mock.calls
      .map((call: any[]) => call[0])
      .find((action: any) => action?.id === 'gonavi.queryEditor.showObjectInfo');
    expect(showObjectInfoAction).toBeTruthy();

    editorState.position = { lineNumber: 1, column: 13 };
    await act(async () => {
      showObjectInfoAction.run();
    });

    expect(editorState.contentHoverCalls).toHaveLength(1);
    expect(editorState.contentHoverCalls[0]).toEqual(expect.objectContaining({
      mode: 1,
      source: 2,
      focus: false,
    }));
  });

  it('renders SQL metadata hover as a fixed overflow widget below first-line tokens', async () => {
    editorState.value = 'select users.id from users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [{ tableName: 'users', name: 'id', type: 'bigint', comment: '主键ID' }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });

    const initialOptions = editorState.editor.updateOptions.mock.calls[0]?.[0];
    expect(initialOptions).toMatchObject({
      fixedOverflowWidgets: true,
      find: {
        addExtraSpaceOnTop: false,
      },
      hover: {
        enabled: true,
        delay: 1000,
        above: false,
      },
    });
  });

  it('prefers the hovered identifier position for ctrl+q object info', async () => {
    editorState.value = 'select * from user_actions';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'user_actions' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const showObjectInfoAction = editorState.editor.addAction.mock.calls
      .map((call: any[]) => call[0])
      .find((action: any) => action?.id === 'gonavi.queryEditor.showObjectInfo');
    expect(showObjectInfoAction).toBeTruthy();

    editorState.position = { lineNumber: 1, column: 2 };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener({ ctrlKey: true, metaKey: false, key: 'Control' }));
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 17 } },
        event: {
          ctrlKey: true,
          metaKey: false,
        },
      });
      showObjectInfoAction.run();
    });

    expect(editorState.contentHoverCalls).toHaveLength(1);
    expect(messageApi.info).not.toHaveBeenCalledWith(expect.objectContaining({
      key: 'gonavi-query-editor-object-info-miss',
    }));
  });

  it('registers SQL case conversion context-menu actions and delegates to Monaco', async () => {
    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    const uppercaseAction = findEditorAction('gonavi.queryEditor.transformToUppercase');
    const lowercaseAction = findEditorAction('gonavi.queryEditor.transformToLowercase');

    expect(uppercaseAction).toMatchObject({
      label: '转大写',
      precondition: '!editorReadonly',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1,
    });
    expect(lowercaseAction).toMatchObject({
      label: '转小写',
      precondition: '!editorReadonly',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 2,
    });

    await uppercaseAction.run(editorState.editor);
    await lowercaseAction.run(editorState.editor);

    expect(editorState.editor.getAction).toHaveBeenNthCalledWith(1, 'editor.action.transformToUppercase');
    expect(editorState.editor.getAction).toHaveBeenNthCalledWith(2, 'editor.action.transformToLowercase');
    expect(editorState.transformToUppercaseRun).toHaveBeenCalledOnce();
    expect(editorState.transformToLowercaseRun).toHaveBeenCalledOnce();
  });

  it('registers SQL execution context-menu actions with selection and all scopes', async () => {
    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    expect(findEditorAction('gonavi.runSelectedSql')).toMatchObject({
      label: '执行当前选中 SQL',
      precondition: 'editorHasSelection',
      contextMenuGroupId: '0_execution',
      contextMenuOrder: 1,
    });
    expect(findEditorAction('gonavi.runAllSql')).toMatchObject({
      label: '执行所有 SQL',
      contextMenuGroupId: '0_execution',
      contextMenuOrder: 2,
    });
  });

  it('executes selected or full editor SQL from the context-menu actions', async () => {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const addEventListener = window.addEventListener as any;
    const removeEventListener = window.removeEventListener as any;
    const dispatchEvent = window.dispatchEvent as any;
    addEventListener.mockImplementation((type: string, listener: (event: Event) => void) => {
      const current = listeners.get(type) ?? new Set<(event: Event) => void>();
      current.add(listener);
      listeners.set(type, current);
    });
    removeEventListener.mockImplementation((type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    });
    dispatchEvent.mockImplementation((event: Event) => {
      listeners.get(event.type)?.forEach((listener) => listener(event));
      return true;
    });
    backendApp.DBQueryMulti.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'select 1;\nselect 2;',
      })} />);
    });

    const selectedAction = findEditorAction('gonavi.runSelectedSql');
    const allAction = findEditorAction('gonavi.runAllSql');
    editorState.selection = {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'select 2;'.length + 1,
    };

    await act(async () => {
      selectedAction.run(editorState.editor);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('select 2'),
      'query-1',
    );
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');

    backendApp.DBQueryMulti.mockClear();
    editorState.selection = null;
    await act(async () => {
      allAction.run(editorState.editor);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('select 1'),
      'query-1',
    );
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('select 2');
  });

  it('localizes Monaco action labels for the active language', async () => {
    setCurrentLanguage('en-US');
    storeState.shortcutOptions.runQuery.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+Q' };
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+Q' };
    storeState.shortcutOptions.duplicateCurrentLine.mac = { enabled: true, combo: 'Meta+D' };
    storeState.shortcutOptions.duplicateCurrentLine.windows = { enabled: true, combo: 'Ctrl+D' };

    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    expect(findEditorAction('gonavi.queryEditor.showObjectInfo')).toMatchObject({
      label: 'GoNavi: Show Object Info',
    });
    expect(findEditorAction('gonavi.runQuery')).toMatchObject({
      label: 'GoNavi: Run SQL',
    });
    expect(findEditorAction('gonavi.insertSqlSnippet')).toMatchObject({
      label: 'Insert SQL Snippet',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToUppercase')).toMatchObject({
      label: 'convert to uppercase',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToLowercase')).toMatchObject({
      label: 'convert to lowercase',
    });
    expect(findEditorAction('gonavi.selectCurrentStatement')).toMatchObject({
      label: 'GoNavi: Select Current Line and Copy',
    });
    expect(findEditorAction('gonavi.duplicateCurrentLine')).toMatchObject({
      label: 'GoNavi: Duplicate Current Line Below',
    });
    expect(findEditorAction('gonavi.saveQuery')).toMatchObject({
      label: 'GoNavi: Save Query',
    });
  });

  it('refreshes Monaco action labels when languagePreference changes after mount', async () => {
    storeState.shortcutOptions.runQuery.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+Q' };
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+Q' };
    storeState.shortcutOptions.duplicateCurrentLine.mac = { enabled: true, combo: 'Meta+D' };
    storeState.shortcutOptions.duplicateCurrentLine.windows = { enabled: true, combo: 'Ctrl+D' };

    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    expect(findEditorAction('gonavi.queryEditor.showObjectInfo')).toMatchObject({
      label: 'GoNavi: 查看对象信息',
    });
    expect(findEditorAction('gonavi.runQuery')).toMatchObject({
      label: 'GoNavi: 执行 SQL',
    });
    expect(findEditorAction('gonavi.insertSqlSnippet')).toMatchObject({
      label: '插入 SQL 片段',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToUppercase')).toMatchObject({
      label: '转大写',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToLowercase')).toMatchObject({
      label: '转小写',
    });
    expect(findEditorAction('gonavi.selectCurrentStatement')).toMatchObject({
      label: 'GoNavi: 选择当前行并复制',
    });
    expect(findEditorAction('gonavi.duplicateCurrentLine')).toMatchObject({
      label: 'GoNavi: 复制当前行到下一行',
    });
    expect(findEditorAction('gonavi.saveQuery')).toMatchObject({
      label: 'GoNavi: 保存查询',
    });

    await act(async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      notifyStoreSubscribers();
    });

    expect(findEditorActionLabels('gonavi.queryEditor.showObjectInfo')).toContain('GoNavi: Show Object Info');
    expect(findEditorActionLabels('gonavi.runQuery')).toContain('GoNavi: Run SQL');
    expect(findEditorActionLabels('gonavi.insertSqlSnippet')).toContain('Insert SQL Snippet');
    expect(findEditorActionLabels('gonavi.queryEditor.transformToUppercase')).toContain('convert to uppercase');
    expect(findEditorActionLabels('gonavi.queryEditor.transformToLowercase')).toContain('convert to lowercase');
    expect(findEditorActionLabels('gonavi.selectCurrentStatement')).toContain('GoNavi: Select Current Line and Copy');
    expect(findEditorActionLabels('gonavi.duplicateCurrentLine')).toContain('GoNavi: Duplicate Current Line Below');
    expect(findEditorActionLabels('gonavi.saveQuery')).toContain('GoNavi: Save Query');
    expect(findEditorAction('gonavi.queryEditor.showObjectInfo')).toMatchObject({
      label: 'GoNavi: Show Object Info',
    });
    expect(findEditorAction('gonavi.runQuery')).toMatchObject({
      label: 'GoNavi: Run SQL',
    });
    expect(findEditorAction('gonavi.insertSqlSnippet')).toMatchObject({
      label: 'Insert SQL Snippet',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToUppercase')).toMatchObject({
      label: 'convert to uppercase',
    });
    expect(findEditorAction('gonavi.queryEditor.transformToLowercase')).toMatchObject({
      label: 'convert to lowercase',
    });
    expect(findEditorAction('gonavi.selectCurrentStatement')).toMatchObject({
      label: 'GoNavi: Select Current Line and Copy',
    });
    expect(findEditorAction('gonavi.duplicateCurrentLine')).toMatchObject({
      label: 'GoNavi: Duplicate Current Line Below',
    });
    expect(findEditorAction('gonavi.saveQuery')).toMatchObject({
      label: 'GoNavi: Save Query',
    });
  });

  it('registers the SQL snippet context-menu action even when Monaco onMount is deferred', async () => {
    monacoEditorMockState.deferOnMount = true;

    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(findEditorAction('gonavi.insertSqlSnippet')).toMatchObject({
      label: '插入 SQL 片段',
    });
  });

  it('refreshes AI context-menu labels when languagePreference changes after mount', async () => {
    storeState.aiPanelVisible = true;

    await act(async () => {
      create(<QueryEditor tab={createTab({ dbName: 'analytics' })} />);
    });

    expect(findEditorAction('ai.generateSQL')).toMatchObject({
      label: 'AI 生成 SQL',
    });
    expect(findEditorAction('ai.explainSQL')).toMatchObject({
      label: 'AI 解释 SQL',
    });
    expect(findEditorAction('ai.optimizeSQL')).toMatchObject({
      label: 'AI 优化 SQL',
    });

    await act(async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      notifyStoreSubscribers();
    });

    expect(findEditorActionLabels('ai.generateSQL')).toContain('AI Generate SQL');
    expect(findEditorActionLabels('ai.explainSQL')).toContain('AI Explain SQL');
    expect(findEditorActionLabels('ai.optimizeSQL')).toContain('AI Optimize SQL');
    expect(findEditorAction('ai.generateSQL')).toMatchObject({
      label: 'AI Generate SQL',
    });
    expect(findEditorAction('ai.explainSQL')).toMatchObject({
      label: 'AI Explain SQL',
    });
    expect(findEditorAction('ai.optimizeSQL')).toMatchObject({
      label: 'AI Optimize SQL',
    });

    await act(async () => {
      await findEditorAction('ai.generateSQL').run({
        getModel: () => ({ getValueInRange: () => '' }),
        getSelection: () => null,
      });
    });

    expect(getLastInjectedPrompt()).toBe(
      'Context: mysql "local", selected database "analytics".\nGenerate a query based on the current database schema.',
    );
  });

  it('refreshes slash command labels descriptions and prompt seeds when languagePreference changes after mount', async () => {
    vi.useFakeTimers();
    try {
      storeState.aiPanelVisible = true;

      await act(async () => {
        create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
      });

      const slashProvider = editorState.providers.find((provider: any) =>
        Array.isArray(provider?.triggerCharacters) && provider.triggerCharacters.includes('/'),
      );
      expect(slashProvider).toBeTruthy();

      await act(async () => {
        storeState.languagePreference = 'en-US';
        setCurrentLanguage('en-US');
        notifyStoreSubscribers();
      });

      const completionItems = await slashProvider.provideCompletionItems(
        {
          getLineContent: () => '/',
        },
        { lineNumber: 1, column: 2 },
      );

      expect(completionItems.suggestions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: '/query  🔍 Natural language query',
            detail: 'Describe what you want to query',
          }),
          expect.objectContaining({
            label: '/schema  🏗️ Table design review',
            detail: 'Review table structure design quality',
          }),
        ]),
      );

      const slashCmdDefs = (window as any).__gonaviSlashCmdDefs;
      expect(slashCmdDefs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cmd: '/sql',
            label: '📝 Generate SQL',
            desc: 'Describe the requirement and generate a statement',
            prompt: 'Generate SQL for this requirement:',
          }),
          expect.objectContaining({
            cmd: '/explain',
            label: '💡 Explain SQL',
            desc: 'Explain the selected SQL logic',
            prompt: 'Explain the execution logic of this SQL statement:\n```sql\n{SQL}\n```',
          }),
        ]),
      );

      editorState.value = '__AI_SQL__\nselect 1;';
      await act(async () => {
        editorState.contentChangeListeners.forEach((listener) => (listener as any)({
          changes: [{ text: '__AI_SQL__' }],
        }));
        vi.runAllTimers();
      });

      expect(getLastInjectedPrompt()).toBe(
        'Context: mysql "local", selected database "main".\nGenerate SQL for this requirement:',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows "No copyable content on the current line." in English when selecting an empty current line', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+Q' };
    messageApi.info.mockReset();

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: '', readOnly: true })} />);
    });

    const selectCurrentStatementAction = findEditorAction('gonavi.selectCurrentStatement');
    expect(selectCurrentStatementAction).toBeTruthy();

    await act(async () => {
      await selectCurrentStatementAction.run();
    });

    expect(messageApi.info).toHaveBeenCalledWith('No copyable content on the current line.');
    expect(messageApi.info).not.toHaveBeenCalledWith('当前行没有可复制内容。');
  });

  it('selects and copies only the current line when the editor content uses CRLF line endings', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+Q' };
    const sql = [
      'SELECT * FROM first_table;',
      '',
      'SELECT * FROM second_table;',
      '',
      'SELECT a.id, a.name FROM third_table a ORDER BY a.id;',
    ].join('\r\n');
    editorState.position = { lineNumber: 5, column: 18 };
    editorState.selection = null;

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: sql, readOnly: true })} />);
    });

    const selectCurrentStatementAction = findEditorAction('gonavi.selectCurrentStatement');
    expect(selectCurrentStatementAction).toBeTruthy();

    await act(async () => {
      await selectCurrentStatementAction.run();
    });

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(messageApi.success).toHaveBeenCalledWith('已复制到剪贴板');
    expect(editorState.selection).toMatchObject({
      startLineNumber: 5,
      startColumn: 1,
      endLineNumber: 5,
      endColumn: 'SELECT a.id, a.name FROM third_table a ORDER BY a.id;'.length + 1,
    });
  });

  it('falls back to the browser clipboard when the Monaco copy command is unavailable', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+Q' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+Q' };
    (document.execCommand as any).mockReturnValueOnce(false);

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });
    editorState.position = { lineNumber: 2, column: 8 };
    editorState.selection = null;

    const selectCurrentStatementAction = findEditorAction('gonavi.selectCurrentStatement');
    expect(selectCurrentStatementAction).toBeTruthy();

    await act(async () => {
      await selectCurrentStatementAction.run();
    });

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('SELECT 2 AS two;');
    expect(messageApi.success).toHaveBeenCalledWith('已复制到剪贴板');
    expect(messageApi.error).not.toHaveBeenCalled();
    expect(editorState.selection).toMatchObject({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'SELECT 2 AS two;'.length + 1,
    });
  });

  it('duplicates the current line below and keeps the caret column', async () => {
    storeState.shortcutOptions.duplicateCurrentLine.mac = { enabled: true, combo: 'Meta+D' };
    storeState.shortcutOptions.duplicateCurrentLine.windows = { enabled: true, combo: 'Ctrl+D' };
    editorState.position = { lineNumber: 2, column: 6 };

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nFROM dual',
        readOnly: true,
      })} />);
    });

    const duplicateCurrentLineAction = findEditorAction('gonavi.duplicateCurrentLine');
    expect(duplicateCurrentLineAction).toBeTruthy();

    await act(async () => {
      duplicateCurrentLineAction.run();
    });

    expect(editorState.value).toBe('SELECT 1;\nFROM dual\nFROM dual');
    expect(editorState.position).toEqual({ lineNumber: 3, column: 6 });
    expect(editorState.selection).toMatchObject({
      startLineNumber: 3,
      startColumn: 6,
      endLineNumber: 3,
      endColumn: 6,
    });
    expect(editorState.editor.pushUndoStop).toHaveBeenCalled();
  });

  it('intercepts Ctrl/Cmd+E at window level and copies the current line instead of leaking to host search', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+E' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+E' };
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });
    editorState.position = { lineNumber: 2, column: 8 };
    editorState.selection = null;
    (window.dispatchEvent as any).mockClear();
    (navigator.clipboard.writeText as any).mockClear();

    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const event = {
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: false,
      key: 'e',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
      await Promise.resolve();
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(messageApi.success).toHaveBeenCalledWith('已复制到剪贴板');
    expect(editorState.editor.setSelections).not.toHaveBeenCalled();
    expect(editorState.selection).toMatchObject({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'SELECT 2 AS two;'.length + 1,
    });
    expect(
      (window.dispatchEvent as any).mock.calls.map((call: any[]) => call[0]?.type),
    ).not.toContain('gonavi:find-active-query');
  });

  it('keeps SQL editor search on Cmd+F only and suppresses Monaco Cmd+E find-with-selection', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: false, combo: '' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: false, combo: '' };

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });
    (window.dispatchEvent as any).mockClear();
    (document.execCommand as any).mockClear();

    expect(findEditorAction('gonavi.findInEditor')).toMatchObject({
      keybindings: [2048 | 70],
    });

    const suppressMacFindAction = findEditorAction('gonavi.suppressMacFindWithSelection');
    expect(suppressMacFindAction).toMatchObject({
      keybindings: [2048 | 69],
    });

    await act(async () => {
      suppressMacFindAction.run();
      await Promise.resolve();
    });

    expect(
      (window.dispatchEvent as any).mock.calls.map((call: any[]) => call[0]?.type),
    ).not.toContain('gonavi:find-active-query');
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('leaves Ctrl/Cmd+A inside Monaco find inputs while retaining the editor fallback', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'SELECT * FROM users' })} />);
    });

    const OriginalHTMLElement = globalThis.HTMLElement;
    class EditableInputTarget {
      tagName = 'INPUT';
      isContentEditable = false;
      closest = vi.fn(() => null);
    }
    vi.stubGlobal('HTMLElement', EditableInputTarget as any);

    editorState.editor.trigger.mockClear();
    editorState.editor.focus.mockClear();
    const findInputEvent = {
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      key: 'a',
      target: new EditableInputTarget(),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(findInputEvent));
    });

    expect(findInputEvent.preventDefault).not.toHaveBeenCalled();
    expect(findInputEvent.stopPropagation).not.toHaveBeenCalled();
    expect(editorState.editor.trigger).not.toHaveBeenCalledWith('keyboard', 'editor.action.selectAll', null);
    expect(editorState.editor.focus).not.toHaveBeenCalled();

    const documentLevelEvent = {
      ...findInputEvent,
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(documentLevelEvent));
    });

    expect(documentLevelEvent.preventDefault).toHaveBeenCalled();
    expect(documentLevelEvent.stopPropagation).toHaveBeenCalled();
    expect(editorState.editor.trigger).toHaveBeenCalledWith('keyboard', 'editor.action.selectAll', null);
    vi.stubGlobal('HTMLElement', OriginalHTMLElement);
  });

  it('intercepts Ctrl/Cmd+D at window level and duplicates the current line below', async () => {
    storeState.shortcutOptions.duplicateCurrentLine.mac = { enabled: true, combo: 'Meta+D' };
    storeState.shortcutOptions.duplicateCurrentLine.windows = { enabled: true, combo: 'Ctrl+D' };
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });
    editorState.position = { lineNumber: 2, column: 8 };
    editorState.selection = null;
    (window.dispatchEvent as any).mockClear();

    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const event = {
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: false,
      key: 'd',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
      await Promise.resolve();
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(editorState.value).toBe('SELECT 1;\nSELECT 2 AS two;\nSELECT 2 AS two;\nSELECT 3;');
    expect(editorState.position).toEqual({ lineNumber: 3, column: 8 });
    expect(
      (window.dispatchEvent as any).mock.calls.map((call: any[]) => call[0]?.type),
    ).not.toContain('gonavi:find-active-query');
  });

  it('responds to the macOS native Cmd+E fallback event and copies the current line', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+E' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+E' };

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });
    editorState.position = { lineNumber: 2, column: 8 };
    editorState.selection = null;
    (document.execCommand as any).mockClear();

    const nativeListeners = runtimeEventListeners.get('gonavi:native-select-current-line');
    expect(nativeListeners?.size ?? 0).toBeGreaterThan(0);

    await act(async () => {
      nativeListeners?.forEach((listener) => listener());
      await Promise.resolve();
    });

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(messageApi.success).toHaveBeenCalledWith('已复制到剪贴板');
    expect(editorState.editor.setSelections).not.toHaveBeenCalled();
    expect(editorState.selection).toMatchObject({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'SELECT 2 AS two;'.length + 1,
    });
  });

  it('uses the last tracked cursor position for the macOS native Cmd+E fallback when the live cursor is unavailable', async () => {
    storeState.shortcutOptions.selectCurrentStatement.mac = { enabled: true, combo: 'Meta+E' };
    storeState.shortcutOptions.selectCurrentStatement.windows = { enabled: true, combo: 'Ctrl+E' };

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'SELECT 1;\nSELECT 2 AS two;\nSELECT 3;',
        readOnly: true,
      })} />);
    });

    await act(async () => {
      editorState.cursorPositionListeners.forEach((listener) => listener({
        position: { lineNumber: 2, column: 8 },
      }));
    });
    editorState.position = null as any;
    editorState.selection = null;
    (document.execCommand as any).mockClear();

    const nativeListeners = runtimeEventListeners.get('gonavi:native-select-current-line');
    expect(nativeListeners?.size ?? 0).toBeGreaterThan(0);

    await act(async () => {
      nativeListeners?.forEach((listener) => listener());
      await Promise.resolve();
    });

    expect(editorState.editor.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 8 });
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(messageApi.success).toHaveBeenCalledWith('已复制到剪贴板');
  });

  it('shows the object info miss toast in English when the cursor is not on a recognized table or column', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');
    messageApi.info.mockReset();

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'select 1;', dbName: 'main' })} />);
    });

    const showObjectInfoAction = findEditorAction('gonavi.queryEditor.showObjectInfo');
    expect(showObjectInfoAction).toBeTruthy();

    editorState.position = { lineNumber: 1, column: 2 };
    await act(async () => {
      await showObjectInfoAction.run();
    });

    expect(messageApi.info).toHaveBeenCalledWith(expect.objectContaining({
      key: 'gonavi-query-editor-object-info-miss',
      content: 'The cursor is not on a recognized table or column.',
    }));
    expect(messageApi.info).not.toHaveBeenCalledWith(expect.objectContaining({
      content: '当前光标未定位到可识别的表或字段。',
    }));
  });

  it('localizes AI context menu labels in English', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    expect(findEditorAction('ai.generateSQL')).toMatchObject({
      label: 'AI Generate SQL',
    });
    expect(findEditorAction('ai.explainSQL')).toMatchObject({
      label: 'AI Explain SQL',
    });
    expect(findEditorAction('ai.optimizeSQL')).toMatchObject({
      label: 'AI Optimize SQL',
    });

    expect(findEditorActionLabels('ai.generateSQL')).not.toContain('🤖 AI 生成 SQL');
    expect(findEditorActionLabels('ai.explainSQL')).not.toContain('🤖 AI 解释 SQL');
    expect(findEditorActionLabels('ai.optimizeSQL')).not.toContain('🤖 AI 优化 SQL');
  });

  it('opens the SQL snippet picker from the context menu action and inserts the selected snippet', async () => {
    storeState.appearance.newQuerySqlTemplate = '';
    storeState.sqlSnippets = [
      {
        id: 'snippet-select-user',
        prefix: 'selu',
        name: 'Select User',
        description: 'Select rows from the user table',
        body: 'SELECT ${1:id} FROM ${2:user_table}$0;',
        isBuiltin: false,
        createdAt: 1,
      },
    ];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    await act(async () => {
      await findEditorAction('gonavi.insertSqlSnippet').run();
    });

    expect(renderer.root.findByProps({ 'data-query-editor-snippet-picker': 'true' })).toBeTruthy();

    await act(async () => {
      renderer.root.findByProps({
        'data-query-editor-snippet-item': 'snippet-select-user',
      }).props.onClick();
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-insert-sql-snippet',
      [expect.objectContaining({
        text: 'SELECT id FROM user_table;',
      })],
    );
    expect(editorState.value).toBe('SELECT id FROM user_table;');
    expect(renderer.root.findAllByProps({ 'data-query-editor-snippet-picker': 'true' })).toHaveLength(0);
  });

  it('prefers Monaco snippet controller insertion when the controller is available', async () => {
    storeState.appearance.newQuerySqlTemplate = '';
    storeState.sqlSnippets = [
      {
        id: 'snippet-alter-table',
        prefix: 'alt',
        name: 'ALTER TABLE',
        description: 'ALTER TABLE add column template',
        body: 'ALTER TABLE ${1:table_name}\\nADD COLUMN ${2:column_name} VARCHAR(255);$0',
        isBuiltin: true,
        createdAt: 1,
      },
    ];

    const snippetController = {
      insert: vi.fn((body: string) => {
        expect(body).toBe('ALTER TABLE ${1:table_name}\\nADD COLUMN ${2:column_name} VARCHAR(255);$0');
        editorState.value = 'ALTER TABLE demo_table\nADD COLUMN user_name VARCHAR(255);';
      }),
    };
    editorState.editor.getContribution.mockImplementation((id: string) => {
      if (id === 'snippetController2') {
        return snippetController;
      }
      return defaultEditorContributionResolver(editorState)(id);
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    await act(async () => {
      await findEditorAction('gonavi.insertSqlSnippet').run();
    });

    await act(async () => {
      renderer.root.findByProps({
        'data-query-editor-snippet-item': 'snippet-alter-table',
      }).props.onClick();
    });

    expect(snippetController.insert).toHaveBeenCalledTimes(1);
    expect(editorState.editor.trigger).not.toHaveBeenCalledWith(
      'gonavi.insertSqlSnippet',
      'editor.action.insertSnippet',
      expect.anything(),
    );
    expect(editorState.editor.executeEdits).not.toHaveBeenCalled();
    expect(editorState.value).toBe('ALTER TABLE demo_table\nADD COLUMN user_name VARCHAR(255);');
    expect(renderer.root.findAllByProps({ 'data-query-editor-snippet-picker': 'true' })).toHaveLength(0);
  });

  it('builds localized AI context prefix for QueryEditor prompt injection', async () => {
    storeState.languagePreference = 'en-US';
    storeState.aiPanelVisible = true;
    setCurrentLanguage('en-US');

    await act(async () => {
      create(<QueryEditor tab={createTab({ dbName: 'analytics' })} />);
    });

    const generateAction = findEditorAction('ai.generateSQL');

    await act(async () => {
      await generateAction.run({
        getModel: () => ({ getValueInRange: () => '' }),
        getSelection: () => null,
      });
    });

    expect(getLastInjectedPrompt()).toBe(
      'Context: mysql "local", selected database "analytics".\nGenerate a query based on the current database schema.',
    );
    expect(getLastInjectedPrompt()).not.toContain('上下文环境：');
    expect(getLastInjectedPrompt()).toContain('"local"');
    expect(getLastInjectedPrompt()).toContain('"analytics"');
  });

  it('injects localized context-menu AI prompts for generate explain and optimize actions', async () => {
    storeState.languagePreference = 'en-US';
    storeState.aiPanelVisible = true;
    setCurrentLanguage('en-US');

    await act(async () => {
      create(<QueryEditor tab={createTab({ dbName: 'main' })} />);
    });

    const selection = 'select * from users';
    const actionEditor = {
      getModel: () => ({ getValueInRange: () => selection }),
      getSelection: () => ({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: selection.length + 1,
      }),
    };

    await act(async () => {
      await findEditorAction('ai.generateSQL').run(actionEditor);
    });
    expect(getLastInjectedPrompt()).toBe(
      'Context: mysql "local", selected database "main".\nGenerate a query based on the current database schema.',
    );

    await act(async () => {
      await findEditorAction('ai.explainSQL').run(actionEditor);
    });
    expect(getLastInjectedPrompt()).toBe(
      'Context: mysql "local", selected database "main".\nExplain the execution logic of this SQL statement:\n```sql\nselect * from users\n```',
    );
    expect(getLastInjectedPrompt()).not.toContain('请解释以下 SQL');

    await act(async () => {
      await findEditorAction('ai.optimizeSQL').run(actionEditor);
    });
    expect(getLastInjectedPrompt()).toBe(
      'Context: mysql "local", selected database "main".\nAnalyze this SQL statement for performance issues and suggest optimizations:\n```sql\nselect * from users\n```',
    );
    expect(getLastInjectedPrompt()).not.toContain('请分析以下 SQL');
  });

  it('renders localized slash command completion labels descriptions and prompt seeds', async () => {
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    await act(async () => {
      create(<QueryEditor tab={createTab()} />);
    });

    const slashProvider = editorState.providers.find((provider: any) =>
      Array.isArray(provider?.triggerCharacters) && provider.triggerCharacters.includes('/'),
    );
    expect(slashProvider).toBeTruthy();

    const completionItems = await slashProvider.provideCompletionItems(
      {
        getLineContent: () => '/',
      },
      { lineNumber: 1, column: 2 },
    );

    expect(completionItems.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '/query  🔍 Natural language query',
          detail: 'Describe what you want to query',
        }),
        expect.objectContaining({
          label: '/schema  🏗️ Table design review',
          detail: 'Review table structure design quality',
        }),
      ]),
    );

    const slashCmdDefs = (window as any).__gonaviSlashCmdDefs;
    expect(slashCmdDefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cmd: '/sql',
          label: '📝 Generate SQL',
          desc: 'Describe the requirement and generate a statement',
          prompt: 'Generate SQL for this requirement:',
        }),
        expect.objectContaining({
          cmd: '/explain',
          label: '💡 Explain SQL',
          desc: 'Explain the selected SQL logic',
          prompt: 'Explain the execution logic of this SQL statement:\n```sql\n{SQL}\n```',
        }),
      ]),
    );
    expect(JSON.stringify(slashCmdDefs)).not.toContain('自然语言查询');
    expect(JSON.stringify(slashCmdDefs)).not.toContain('请根据以下需求生成 SQL：');
  });

  it('replaces slash markers and injects the localized prompt', async () => {
    vi.useFakeTimers();
    try {
      storeState.languagePreference = 'en-US';
      storeState.aiPanelVisible = true;
      setCurrentLanguage('en-US');

      await act(async () => {
        create(<QueryEditor tab={createTab({ dbName: 'analytics', query: 'select 1;' })} />);
      });
      editorState.value = '__AI_SQL__\nselect 1;';

      await act(async () => {
        editorState.contentChangeListeners.forEach((listener) => (listener as any)({
          changes: [{ text: '__AI_SQL__' }],
        }));
        vi.runAllTimers();
      });

      expect(editorState.value).toBe('select 1;');
      expect(getLastInjectedPrompt()).toBe(
        'Context: mysql "local", selected database "analytics".\nGenerate SQL for this requirement:',
      );
      expect(getLastInjectedPrompt()).not.toContain('请根据以下需求生成 SQL：');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses localized toolbar AI prompts and execution-error diagnose prompt', async () => {
    vi.useFakeTimers();
    try {
      storeState.aiPanelVisible = true;
      storeState.appearance.uiVersion = 'v2';

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'select 1;' })} />);
      });

      await act(async () => {
        storeState.languagePreference = 'en-US';
        setCurrentLanguage('en-US');
        notifyStoreSubscribers();
      });

      await act(async () => {
        findExactButton(renderer, 'Schema analysis').props.onClick();
      });
      expect(getLastInjectedPrompt()).toBe(
        'Context: mysql "local", selected database "main".\nAnalyze the current database schema and suggest performance and design improvements.',
      );
      expect(getLastInjectedPrompt()).not.toContain('请针对当前数据库的表结构进行系统分析');

      backendApp.DBQueryMulti.mockResolvedValueOnce({ success: false, message: 'driver exploded', data: [] });
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 'select 1;'.length + 1,
        positionLineNumber: 1,
        positionColumn: 'select 1;'.length + 1,
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

      expect(textContent(renderer.toJSON())).toContain('SQL 执行日志');

      await act(async () => {
        findButton(renderer, 'AI diagnose').props.onClick();
        vi.runAllTimers();
      });

      expect(getLastInjectedPrompt()).toBe(
        `I got an error while executing this SQL:\n\`\`\`sql\nselect 1;\n\`\`\`\n\nThe database returned this error:\n\`\`\`text\n${formatSqlExecutionError('driver exploded')}\n\`\`\`\n\nAnalyze the cause and suggest a fix.`,
      );
      expect(getLastInjectedPrompt()).not.toContain('我在执行以下 SQL 时遇到了错误');
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds separate object and column color decorations', async () => {
    editorState.value = 'select users.id from users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [{ tableName: 'users', name: 'id', type: 'bigint', comment: '主键ID' }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const allDecorationEntries = editorState.editor.deltaDecorations.mock.calls.flatMap((call: any[]) => call[1] || []);
    expect(allDecorationEntries.some((item: any) => item?.options?.inlineClassName === 'gonavi-query-editor-object-token')).toBe(true);
    expect(allDecorationEntries.some((item: any) => item?.options?.inlineClassName === 'gonavi-query-editor-column-token')).toBe(true);
  });

  describe('hover markdown localization', () => {
    it('localizes database hover markdown in English without leaking Chinese labels', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'use main';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const hoverProvider = editorState.hoverProviders[2];
      expect(hoverProvider).toBeTruthy();

      const hover = hoverProvider.provideHover(
        editorState.editor.getModel(),
        { lineNumber: 1, column: 7 },
      );
      const hoverMarkdown = hover?.contents?.[0]?.value;
      expect(hoverMarkdown).toContain('**Database**');
      expect(hoverMarkdown).toContain('`main`');
      expect(hoverMarkdown).not.toContain('**数据库**');
      expect(hoverMarkdown).not.toContain('数据库');
    });

    it('localizes table hover markdown in English without leaking Chinese labels', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'select * from reporting.events where id = 1';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'reporting.events' }] });
      backendApp.DBGetAllColumns
        .mockResolvedValueOnce({ success: true, data: [{ tableName: 'reporting.events', name: 'id', type: 'bigint', comment: '事件ID' }] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (/table_comment|information_schema\.tables/i.test(sql)) {
          return {
            success: true,
            data: [
              { table_name: 'events', table_comment: '裸表备注' },
              { table_name: 'reporting.events', table_comment: 'Schema表备注' },
            ],
          };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });
      expect(
        backendApp.DBQuery.mock.calls.some((call: any[]) => /table_comment|information_schema\.tables/i.test(String(call[2]))),
      ).toBe(true);

      const hoverProvider = editorState.hoverProviders[2];
      const hover = hoverProvider?.provideHover(
        editorState.editor.getModel(),
        { lineNumber: 1, column: 27 },
      );
      const hoverMarkdown = hover?.contents?.[0]?.value;
      expect(hoverMarkdown).toContain('**Table** `reporting.events`');
      expect(hoverMarkdown).toContain('Database: `main`');
      expect(hoverMarkdown).toContain('Schema: `reporting`');
      expect(hoverMarkdown).toContain('Schema表备注');
      expect(hoverMarkdown).not.toContain('裸表备注');
      expect(hoverMarkdown).not.toContain('**表**');
      expect(hoverMarkdown).not.toContain('库：');
    });

    it('localizes column hover markdown in English without leaking Chinese labels', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'select users.id from users';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({
        success: true,
        data: [{ tableName: 'users', name: 'id', type: 'bigint', comment: '主键ID' }],
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const hoverProvider = editorState.hoverProviders[2];
      expect(hoverProvider).toBeTruthy();

      const hover = hoverProvider.provideHover(
        editorState.editor.getModel(),
        { lineNumber: 1, column: 13 },
      );
      const hoverMarkdown = hover?.contents?.[0]?.value;
      expect(hoverMarkdown).toContain('**Column** `id`');
      expect(hoverMarkdown).toContain('Type: `bigint`');
      expect(hoverMarkdown).toContain('Table: `users`');
      expect(hoverMarkdown).toContain('Database: `main`');
      expect(hoverMarkdown).toContain('主键ID');
      expect(hoverMarkdown).not.toContain('**字段**');
      expect(hoverMarkdown).not.toContain('类型：');
      expect(hoverMarkdown).not.toContain('表：');
      expect(hoverMarkdown).not.toContain('库：');
    });

    it('keeps Chinese label separators for column hover markdown', async () => {
      storeState.languagePreference = 'zh-CN';
      setCurrentLanguage('zh-CN');
      editorState.value = 'select users.id from users';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({
        success: true,
        data: [{ tableName: 'users', name: 'id', type: 'bigint', comment: '主键ID' }],
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const hoverProvider = editorState.hoverProviders[2];
      expect(hoverProvider).toBeTruthy();

      const hover = hoverProvider.provideHover(
        editorState.editor.getModel(),
        { lineNumber: 1, column: 13 },
      );
      const hoverMarkdown = hover?.contents?.[0]?.value;
      expect(hoverMarkdown).toContain('**字段** `id`');
      expect(hoverMarkdown).toContain('类型：`bigint`');
      expect(hoverMarkdown).toContain('表：`users`');
      expect(hoverMarkdown).toContain('库：`main`');
      expect(hoverMarkdown).toContain('主键ID');
      expect(hoverMarkdown).not.toContain('类型: `bigint`');
      expect(hoverMarkdown).not.toContain('表: `users`');
      expect(hoverMarkdown).not.toContain('库: `main`');
    });

    it('localizes view hover markdown in English without leaking Chinese labels', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'select * from reporting.active_users';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (sql.includes('information_schema.views') || sql.includes('pg_catalog.pg_views') || sql.includes('USER_VIEWS') || sql.includes('ALL_VIEWS')) {
          return { success: true, data: [{ view_name: 'active_users', schema_name: 'reporting' }] };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      const hoverProvider = editorState.hoverProviders[2];
      expect(hoverProvider).toBeTruthy();

      const hover = hoverProvider.provideHover(
        editorState.editor.getModel(),
        { lineNumber: 1, column: 31 },
      );
      const hoverMarkdown = hover?.contents?.[0]?.value;
      expect(hoverMarkdown).toContain('**View** `active_users`');
      expect(hoverMarkdown).toContain('Database: `main`');
      expect(hoverMarkdown).toContain('Schema: `reporting`');
      expect(hoverMarkdown).not.toContain('**视图**');
      expect(hoverMarkdown).not.toContain('库：');
      expect(hoverMarkdown).not.toContain('Schema：');
    });

    it('localizes materialized view hover markdown in English without leaking Chinese labels', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      storeState.connections[0].config.type = 'starrocks';
      editorState.value = 'select * from analytics.mv_daily_stats';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'analytics' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (sql.includes("UPPER(TABLE_TYPE) LIKE '%MATERIALIZED%'") || sql.includes('SHOW MATERIALIZED VIEWS')) {
          return { success: true, data: [{ object_name: 'mv_daily_stats', schema_name: 'analytics' }] };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'analytics' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      const hoverProvider = editorState.hoverProviders[2];
      expect(hoverProvider).toBeTruthy();

      const hover = hoverProvider.provideHover(
        editorState.editor.getModel(),
        { lineNumber: 1, column: 37 },
      );
      const hoverMarkdown = hover?.contents?.[0]?.value;
      expect(hoverMarkdown).toContain('**Materialized view** `analytics.mv_daily_stats`');
      expect(hoverMarkdown).toContain('Database: `analytics`');
      expect(hoverMarkdown).toContain('Schema: `analytics`');
      expect(hoverMarkdown).not.toContain('**物化视图**');
      expect(hoverMarkdown).not.toContain('库：');
      expect(hoverMarkdown).not.toContain('Schema：');
    });

    it('localizes trigger hover markdown in English without leaking Chinese labels', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'call audit.users_bi();';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (sql.includes('information_schema.triggers') || sql.includes('SHOW TRIGGERS') || sql.includes('USER_TRIGGERS') || sql.includes('ALL_TRIGGERS')) {
          return { success: true, data: [{ trigger_name: 'users_bi', table_name: 'users', schema_name: 'audit' }] };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      const hoverProvider = editorState.hoverProviders[2];
      expect(hoverProvider).toBeTruthy();

      const hover = hoverProvider.provideHover(
        editorState.editor.getModel(),
        { lineNumber: 1, column: 12 },
      );
      const hoverMarkdown = hover?.contents?.[0]?.value;
      expect(hoverMarkdown).toContain('**Trigger** `audit.users_bi`');
      expect(hoverMarkdown).toContain('Database: `main`');
      expect(hoverMarkdown).toContain('Table: `audit.users`');
      expect(hoverMarkdown).toContain('Schema: `audit`');
      expect(hoverMarkdown).not.toContain('**触发器**');
      expect(hoverMarkdown).not.toContain('库：');
      expect(hoverMarkdown).not.toContain('表：');
      expect(hoverMarkdown).not.toContain('Schema：');
    });

    it('localizes procedure hover markdown in English without leaking Chinese labels', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'call reporting.refresh_stats();';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (sql.includes('information_schema.routines') || sql.includes('SHOW FUNCTION STATUS') || sql.includes('SHOW PROCEDURE STATUS') || sql.includes('USER_OBJECTS') || sql.includes('ALL_OBJECTS')) {
          return { success: true, data: [{ routine_name: 'refresh_stats', routine_type: 'PROCEDURE', schema_name: 'reporting' }] };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      const hoverProvider = editorState.hoverProviders[2];
      expect(hoverProvider).toBeTruthy();

      const hover = hoverProvider.provideHover(
        editorState.editor.getModel(),
        { lineNumber: 1, column: 21 },
      );
      const hoverMarkdown = hover?.contents?.[0]?.value;
      expect(hoverMarkdown).toContain('**Procedure** `reporting.refresh_stats`');
      expect(hoverMarkdown).toContain('Database: `main`');
      expect(hoverMarkdown).toContain('Schema: `reporting`');
      expect(hoverMarkdown).not.toContain('**存储过程**');
      expect(hoverMarkdown).not.toContain('**函数**');
      expect(hoverMarkdown).not.toContain('库：');
      expect(hoverMarkdown).not.toContain('Schema：');
    });

    it('localizes function hover markdown in English without leaking Chinese labels', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'call reporting.refresh_stats();';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (sql.includes('information_schema.routines') || sql.includes('SHOW FUNCTION STATUS') || sql.includes('SHOW PROCEDURE STATUS') || sql.includes('USER_OBJECTS') || sql.includes('ALL_OBJECTS')) {
          return { success: true, data: [{ routine_name: 'refresh_stats', routine_type: 'FUNCTION', schema_name: 'reporting' }] };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      const hoverProvider = editorState.hoverProviders[2];
      expect(hoverProvider).toBeTruthy();

      const hover = hoverProvider.provideHover(
        editorState.editor.getModel(),
        { lineNumber: 1, column: 21 },
      );
      const hoverMarkdown = hover?.contents?.[0]?.value;
      expect(hoverMarkdown).toContain('**Function** `reporting.refresh_stats`');
      expect(hoverMarkdown).toContain('Database: `main`');
      expect(hoverMarkdown).toContain('Schema: `reporting`');
      expect(hoverMarkdown).not.toContain('**存储过程**');
      expect(hoverMarkdown).not.toContain('**函数**');
      expect(hoverMarkdown).not.toContain('库：');
      expect(hoverMarkdown).not.toContain('Schema：');
    });
  });

  describe('completion documentation localization', () => {
    it('prefers the latest SQL completion provider after remounting with a different dialect', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      storeState.connections = createDefaultConnections();
      storeState.connections[0].config.type = 'mysql';

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'GRO', dbName: 'main' })} />);
      });

      const firstProvider = findSqlCompletionProvider();
      expect(firstProvider).toBeTruthy();

      const firstProviderItems = await firstProvider.provideCompletionItems(
        createSqlCompletionModel('GRO', 'GRO'),
        { lineNumber: 1, column: 4 },
      );
      expect(firstProviderItems?.suggestions?.some((item: any) => item?.label === 'GROUP_CONCAT')).toBe(true);
      expect(firstProviderItems?.suggestions?.some((item: any) => item?.label === 'STRING_AGG')).toBe(false);

      const previousCompletionState = (globalThis as any).__gonaviSqlCompletionState;
      const findLatestSqlCompletionProvider = () =>
        [...editorState.providers]
          .reverse()
          .find((provider: any) =>
            Array.isArray(provider?.triggerCharacters) && provider.triggerCharacters.includes('.'),
          );

      try {
        vi.resetModules();
        (globalThis as any).__gonaviSqlCompletionState = { registered: false, disposables: [] };

        const { default: RemountedQueryEditor } = await import('./QueryEditor');

        storeState.connections = createDefaultConnections();
        storeState.connections[0].config.type = 'postgres';

        await act(async () => {
          create(<RemountedQueryEditor tab={createTab({ query: 'STR', dbName: 'main' })} />);
        });

        const latestProvider = findLatestSqlCompletionProvider();
        expect(latestProvider).toBeTruthy();

        const latestProviderItems = await latestProvider.provideCompletionItems(
          createSqlCompletionModel('STR', 'STR'),
          { lineNumber: 1, column: 4 },
        );
        expect(latestProviderItems?.suggestions?.some((item: any) => item?.label === 'STRING_AGG')).toBe(true);
        expect(latestProviderItems?.suggestions?.some((item: any) => item?.label === 'GROUP_CONCAT')).toBe(false);

        const completionProvider = findSqlCompletionProvider();
        expect(completionProvider).toBeTruthy();

        const completionItems = await completionProvider.provideCompletionItems(
          createSqlCompletionModel('STR', 'STR'),
          { lineNumber: 1, column: 4 },
        );

        expect(completionItems?.suggestions?.some((item: any) => item?.label === 'STRING_AGG')).toBe(true);
        expect(completionItems?.suggestions?.some((item: any) => item?.label === 'GROUP_CONCAT')).toBe(false);
      } finally {
        (globalThis as any).__gonaviSqlCompletionState = previousCompletionState;
        editorState.providers = firstProvider ? [firstProvider] : [];
      }
    });

    it('localizes builtin function completion detail at request time', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'GRO', dbName: 'main' })} />);
      });

      const completionProvider = findSqlCompletionProvider();
      expect(completionProvider).toBeTruthy();

      const completionItems = await completionProvider.provideCompletionItems(
        createSqlCompletionModel('GRO', 'GRO'),
        { lineNumber: 1, column: 4 },
      );
      const functionSuggestion = completionItems?.suggestions?.find((item: any) => item?.label === 'GROUP_CONCAT');

      expect(functionSuggestion).toBeTruthy();
      expect(functionSuggestion.detail).toBe('MySQL - grouped concatenation');
      expect(functionSuggestion.detail).not.toContain('分组拼接');
    });

    it('refreshes builtin function completion detail after languagePreference changes post-mount', async () => {
      storeState.languagePreference = 'zh-CN';
      setCurrentLanguage('zh-CN');

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'COU', dbName: 'main' })} />);
      });

      const completionProvider = findSqlCompletionProvider();
      expect(completionProvider).toBeTruthy();

      const zhCompletionItems = await completionProvider.provideCompletionItems(
        createSqlCompletionModel('COU', 'COU'),
        { lineNumber: 1, column: 4 },
      );
      const zhCountSuggestion = zhCompletionItems?.suggestions?.find((item: any) => item?.label === 'COUNT');

      expect(zhCountSuggestion).toBeTruthy();
      expect(zhCountSuggestion.detail).toBe('聚合函数 - 计数');

      await act(async () => {
        storeState.languagePreference = 'en-US';
        setCurrentLanguage('en-US');
        notifyStoreSubscribers();
      });

      const enCompletionItems = await completionProvider.provideCompletionItems(
        createSqlCompletionModel('COU', 'COU'),
        { lineNumber: 1, column: 4 },
      );
      const enCountSuggestion = enCompletionItems?.suggestions?.find((item: any) => item?.label === 'COUNT');

      expect(enCountSuggestion).toBeTruthy();
      expect(enCountSuggestion.detail).toBe('Aggregate function - count');
      expect(enCountSuggestion.detail).not.toBe(zhCountSuggestion.detail);
    });

    it('localizes database-qualified table completion detail in zh-CN while preserving the raw database name', async () => {
      storeState.languagePreference = 'zh-CN';
      setCurrentLanguage('zh-CN');
      editorState.value = 'select * from analytics.';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
      backendApp.DBGetTables
        .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
        .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
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

      const completionProvider = editorState.providers[0];
      expect(completionProvider).toBeTruthy();

      const completionItems = await completionProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      const tableSuggestion = completionItems?.suggestions?.find((item: any) => item?.label === 'events');

      expect(tableSuggestion).toBeTruthy();
      expect(tableSuggestion.detail).toContain('表 (analytics)');
      expect(tableSuggestion.detail).not.toContain('Table (analytics)');
    });

    it('deduplicates Oracle-style database qualified table completion labels when schema matches the qualifier', async () => {
      storeState.languagePreference = 'zh-CN';
      setCurrentLanguage('zh-CN');
      storeState.connections[0].config.type = 'oracle';
      storeState.connections[0].config.database = 'ORCLPDB1';
      editorState.value = 'select * from sbdev.AA';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({
        success: true,
        data: [{ Database: 'ORCLPDB1' }, { Database: 'sbdev' }],
      });
      backendApp.DBGetTables.mockImplementation(async (_config: any, dbName: string) => {
        if (String(dbName || '').toLowerCase() === 'sbdev') {
          return { success: true, data: [{ Table: 'SBDEV.AAA3_NJ' }] };
        }
        return { success: true, data: [] };
      });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'ORCLPDB1' })} />);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const completionProvider = editorState.providers[0];
      expect(completionProvider).toBeTruthy();

      const completionItems = await completionProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      const tableSuggestion = completionItems?.suggestions?.find((item: any) => item?.label === 'AAA3_NJ');

      expect(tableSuggestion).toBeTruthy();
      expect(tableSuggestion.insertText).toBe('AAA3_NJ an');
      expect(tableSuggestion.detail).toContain('表 (sbdev)');
      expect(completionItems?.suggestions?.some((item: any) => item?.label === 'sbdev.SBDEV.AAA3_NJ')).toBe(false);
    });

    it('keeps a dotted Dameng owner intact in table completion detail', async () => {
      storeState.languagePreference = 'zh-CN';
      setCurrentLanguage('zh-CN');
      storeState.connections[0].config.type = 'dameng';
      storeState.connections[0].config.database = 'PEM2.4_V1_1';
      editorState.value = 'select * from COM';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({
        success: true,
        data: [{ Database: 'PEM2.4_V1_1' }],
      });
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [{ Table: 'PEM2.4_V1_1.COM_APPROVE_INFO' }],
      });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'PEM2.4_V1_1' })} />);
      });
      await act(async () => {
        for (let index = 0; index < 6; index += 1) {
          await Promise.resolve();
        }
      });

      const completionProvider = findSqlCompletionProvider();
      expect(completionProvider).toBeTruthy();
      const completionItems = await completionProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      const tableSuggestion = completionItems?.suggestions?.find((item: any) => item?.label === 'COM_APPROVE_INFO');

      expect(tableSuggestion).toBeTruthy();
      expect(tableSuggestion.detail).toContain('表 (PEM2.4_V1_1)');
      expect(tableSuggestion.detail).not.toBe('表 (4_V1_1)');
    });

    it('localizes schema-qualified table completion detail in zh-CN while preserving the raw database and schema names', async () => {
      storeState.languagePreference = 'zh-CN';
      setCurrentLanguage('zh-CN');
      editorState.value = 'select * from reporting.';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [{ Tables_in_main: 'users' }, { Tables_in_main: 'reporting.events' }],
      });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (/table_comment|information_schema\.tables/i.test(sql)) {
          return {
            success: true,
            data: [
              { table_name: 'users', table_comment: '用户表' },
              { table_name: 'reporting.events', table_comment: '事件表' },
            ],
          };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 6; i += 1) {
          await Promise.resolve();
        }
      });

      const completionProvider = editorState.providers[0];
      expect(completionProvider).toBeTruthy();

      const completionItems = await completionProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      const tableSuggestion = completionItems?.suggestions?.find((item: any) => item?.label === 'events');

      expect(tableSuggestion).toBeTruthy();
      expect(tableSuggestion.detail).toContain('表 (main.reporting)');
      expect(tableSuggestion.detail).not.toContain('Table (main.reporting)');
    });

    it('keeps database-qualified table completion from leaking into unqualified FROM suggestions', async () => {
      storeState.languagePreference = 'zh-CN';
      setCurrentLanguage('zh-CN');
      editorState.value = 'select * from ';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
      backendApp.DBGetTables
        .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
        .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
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

      const completionProvider = editorState.providers[0];
      expect(completionProvider).toBeTruthy();

      editorState.value = 'select * from analytics.';
      const qualifiedCompletionItems = await completionProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      const qualifiedTableSuggestion = qualifiedCompletionItems?.suggestions?.find((item: any) => item?.label === 'events');

      expect(qualifiedTableSuggestion).toBeTruthy();
      expect(qualifiedTableSuggestion.detail).toContain('表 (analytics)');
      expect(qualifiedTableSuggestion.detail).not.toContain('Table (analytics)');

      editorState.value = 'select * from ';
      const completionItems = await completionProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      const tableSuggestion = completionItems?.suggestions?.find((item: any) => item?.label === 'analytics.events');

      expect(tableSuggestion).toBeFalsy();
    });

    it('localizes current-db table completion detail in zh-CN for plain and schema-qualified tables', async () => {
      storeState.languagePreference = 'zh-CN';
      setCurrentLanguage('zh-CN');
      editorState.value = 'select * from ';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [{ Tables_in_main: 'users' }, { Tables_in_main: 'reporting.events' }],
      });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (/table_comment|information_schema\.tables/i.test(sql)) {
          return {
            success: true,
            data: [
              { table_name: 'users', table_comment: '用户表' },
              { table_name: 'reporting.events', table_comment: '事件表' },
            ],
          };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const completionProvider = editorState.providers[0];
      expect(completionProvider).toBeTruthy();

      const completionItems = await completionProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      const plainTableSuggestion = completionItems?.suggestions?.find((item: any) => item?.label === 'users');
      const schemaTableSuggestion = completionItems?.suggestions?.find((item: any) => item?.label === 'events');

      expect(plainTableSuggestion).toBeTruthy();
      expect(plainTableSuggestion.detail).toBe('表 - 用户表');
      expect(plainTableSuggestion.detail).not.toContain('Table');

      expect(schemaTableSuggestion).toBeTruthy();
      expect(schemaTableSuggestion.detail).toBe('表 (reporting) - 事件表');
      expect(schemaTableSuggestion.detail).not.toContain('Table (reporting)');
    });

    it('localizes database suggestion detail in zh-CN', async () => {
      storeState.languagePreference = 'zh-CN';
      setCurrentLanguage('zh-CN');
      editorState.value = 'ana';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
      backendApp.DBGetTables
        .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
        .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
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

      const completionProvider = editorState.providers[0];
      expect(completionProvider).toBeTruthy();

      const completionItems = await completionProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      const databaseSuggestion = completionItems?.suggestions?.find((item: any) => item?.label === 'analytics');

      expect(databaseSuggestion).toBeTruthy();
      expect(databaseSuggestion.detail).toBe('数据库');
      expect(databaseSuggestion.detail).not.toContain('Database');
    });

    it('localizes completion comment prefix in English while preserving the raw comment body', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'select * from users';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({
        success: true,
        data: [{ tableName: 'users', name: 'id', type: 'bigint', comment: '主键ID' }],
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const completionProvider = editorState.providers[0];
      expect(completionProvider).toBeTruthy();

      const completionItems = await completionProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: 8 },
      );
      const idSuggestion = completionItems?.suggestions?.find((item: any) => item?.label === 'id');

      expect(idSuggestion).toBeTruthy();
      expect(idSuggestion.documentation).toContain('Comment: 主键ID');
      expect(idSuggestion.documentation).not.toBe('备注：主键ID');
    });

    it('shows column type table and comment in SQL completion metadata', async () => {
      editorState.value = 'select * from users where u';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({
        success: true,
        data: [{ tableName: 'users', name: 'user_id', type: 'varchar(32)', comment: '用户ID' }],
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const completionProvider = editorState.providers[0];
      expect(completionProvider).toBeTruthy();

      const completionItems = await completionProvider.provideCompletionItems(
        editorState.editor.getModel(),
        { lineNumber: 1, column: editorState.value.length + 1 },
      );
      const columnSuggestion = completionItems?.suggestions?.find((item: any) => item?.label === 'user_id');

      expect(columnSuggestion).toBeTruthy();
      expect(columnSuggestion.detail).toBe('users [varchar(32)] - 用户ID');
      expect(columnSuggestion.documentation).toContain('类型: varchar(32)');
      expect(columnSuggestion.documentation).toContain('库: main');
      expect(columnSuggestion.documentation).toContain('表: users');
      expect(columnSuggestion.documentation).toContain('备注：用户ID');
    });
  });

  it('registers SQL metadata hover provider only once across query editor instances', async () => {
    editorState.value = 'select * from H2.S_BUSI';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'H2' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_H2: 'H2.S_BUSI' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    let firstRenderer: ReactTestRenderer;
    let secondRenderer: ReactTestRenderer;
    await act(async () => {
      firstRenderer = create(<QueryEditor tab={createTab({ id: 'tab-1', query: editorState.value, dbName: 'H2' })} isActive={false} />);
    });
    await act(async () => {
      secondRenderer = create(<QueryEditor tab={createTab({ id: 'tab-2', query: editorState.value, dbName: 'H2' })} isActive />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editorState.hoverProviders).toHaveLength(4);
    const hover = editorState.hoverProviders[2].provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 18 },
    );
    const hoverText = String(hover?.contents?.[0]?.value || '');
    expect(hoverText.match(/\*\*表\*\*/g)).toHaveLength(1);
    expect(hoverText).toContain('`H2.S_BUSI`');

    firstRenderer!.unmount();
    secondRenderer!.unmount();
  });

  it('keeps hover underline active when ctrl/cmd is pressed repeatedly without moving the mouse', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'select * from analytics.events where id = 1';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
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
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 27 } },
        event: {
          ctrlKey: true,
          metaKey: false,
        },
      });
    });

    const firstDecorationCallCount = editorState.editor.deltaDecorations.mock.calls.length;
    expect(firstDecorationCallCount).toBeGreaterThan(0);
    expect(editorState.domNode.style.cursor).toBe('pointer');

    await act(async () => {
      const repeatedCtrlEvent = {
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: 'Control',
        code: 'ControlLeft',
        repeat: true,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      };
      windowListeners.keydown?.forEach((listener) => listener(repeatedCtrlEvent));
      windowListeners.keydown?.forEach((listener) => listener(repeatedCtrlEvent));
    });

    expect(editorState.editor.deltaDecorations.mock.calls.length).toBeGreaterThan(firstDecorationCallCount);
    expect(editorState.domNode.style.cursor).toBe('pointer');
    const lastDecorationCall = editorState.editor.deltaDecorations.mock.calls.at(-1);
    expect(lastDecorationCall?.[1]?.[0]?.options?.inlineClassName).toBe('gonavi-query-editor-link-hint');
  });

  it('ignores IME candidate keydown events when syncing modifier hover state', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'select 1';

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value })} />);
    });

    editorState.editor.updateOptions.mockClear();
    editorState.editor.deltaDecorations.mockClear();

    await act(async () => {
      const imeEvent = {
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: 'Process',
        keyCode: 229,
        which: 229,
        isComposing: true,
        nativeEvent: {
          isComposing: true,
          keyCode: 229,
          which: 229,
        },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      };
      windowListeners.keydown?.forEach((listener) => listener(imeEvent));
    });

    expect(editorState.editor.updateOptions).not.toHaveBeenCalledWith({ mouseStyle: 'text' });
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
  });

  it('does not churn decorations while selecting text without a navigation modifier', async () => {
    editorState.value = 'select users.id from users';

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value })} />);
    });

    editorState.editor.updateOptions.mockClear();
    editorState.editor.deltaDecorations.mockClear();

    await act(async () => {
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 10 } },
        event: { ctrlKey: false, metaKey: false },
      });
    });

    expect(editorState.editor.updateOptions).not.toHaveBeenCalled();
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
  });

  it('ignores candidate number keys while a composition session is active', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'select 1';

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value })} />);
    });

    setGlobalImeCompositionActive(true);
    editorState.editor.updateOptions.mockClear();
    editorState.editor.deltaDecorations.mockClear();

    await act(async () => {
      const candidateSelectEvent = {
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: '1',
        keyCode: 49,
        which: 49,
        isComposing: false,
        nativeEvent: {
          isComposing: false,
        },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      };
      windowListeners.keydown?.forEach((listener) => listener(candidateSelectEvent));
    });

    expect(editorState.editor.updateOptions).not.toHaveBeenCalled();
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
  });

  it('opens a view object-edit tab on ctrl left click inside the editor', async () => {
    editorState.value = 'select * from reporting.active_users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (sql.includes('information_schema.views') || sql.includes('pg_catalog.pg_views') || sql.includes('USER_VIEWS') || sql.includes('ALL_VIEWS')) {
        return { success: true, data: [{ view_name: 'active_users', schema_name: 'reporting', view_definition: 'select id from users' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 31 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^query-edit-object-conn-1-main-reporting-reporting\.active_users-\d+$/),
      title: '修改视图: reporting.active_users',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'reporting',
      queryMode: 'object-edit',
      viewName: 'active_users',
      viewKind: 'view',
      objectType: 'view',
      returnToTabId: 'tab-1',
      query: expect.stringContaining('CREATE OR REPLACE VIEW reporting.active_users AS'),
    }));
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
  });

  it('uses the complete Oracle view DDL when opening object edit from the editor', async () => {
    const viewName = 'H2.CV_GD_YNCRM_SALESDTLLIST';
    const preview = '[CLOB preview: 4096/9362 bytes] SELECT compid, saleno FROM sales_detail';
    const fullDDL = `CREATE OR REPLACE VIEW ${viewName} AS SELECT compid, saleno FROM sales_detail WHERE deleted_flag = 0`;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'hydeekf';
    editorState.value = `select * from ${viewName}`;
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'H2' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValueOnce({ success: true, data: fullDDL });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (sql.includes('USER_VIEWS') || sql.includes('ALL_VIEWS')) {
        if (sql.includes('TEXT AS view_definition')) {
          return { success: true, data: [{ view_definition: preview }] };
        }
        return { success: true, data: [{ schema_name: 'H2', view_name: 'CV_GD_YNCRM_SALESDTLLIST' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'H2' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: editorState.value.indexOf(viewName) + Math.floor(viewName.length / 2) + 1 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(expect.anything(), 'H2', viewName);
    const addTabCall = storeState.addTab.mock.calls[storeState.addTab.mock.calls.length - 1]?.[0];
    const editQuery = String(addTabCall?.query || '');
    expect(editQuery).toMatch(/CREATE OR REPLACE VIEW H2\.CV_GD_YNCRM_SALESDTLLIST AS/i);
    expect(editQuery).toContain('deleted_flag = 0');
    expect(editQuery).not.toContain('[CLOB preview:');
  });

  it('uses the complete Oracle trigger DDL when opening object edit from the editor', async () => {
    const triggerName = 'H2.TR_T_MEMCARD_REG';
    const fullDDL = `CREATE OR REPLACE TRIGGER "H2"."TR_T_MEMCARD_REG"
BEFORE INSERT OR UPDATE ON "H2"."T_MEMCARD_REG"
FOR EACH ROW
BEGIN
${'  NULL;\n'.repeat(700)}  -- FULL_TRIGGER_DDL_TAIL
END;`;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'hydeekf';
    editorState.value = `call ${triggerName}();`;
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'H2' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetTriggers.mockResolvedValue({
      success: true,
      data: [{ name: 'TR_T_MEMCARD_REG', timing: 'BEFORE EACH ROW', event: 'INSERT OR UPDATE', statement: fullDDL }],
    });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (sql.includes('ALL_TRIGGERS') && sql.includes('ORDER BY TABLE_NAME')) {
        return {
          success: true,
          data: [{ schema_name: 'H2', table_name: 'T_MEMCARD_REG', trigger_name: 'TR_T_MEMCARD_REG' }],
        };
      }
      if (sql.includes('DBMS_METADATA.GET_DDL')) {
        return {
          success: true,
          data: [{ trigger_definition: `[CLOB preview: 4096/${fullDDL.length} bytes] ${fullDDL.slice(0, 4096)}` }],
        };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'H2' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: editorState.value.indexOf(triggerName) + Math.floor(triggerName.length / 2) + 1 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBGetTriggers).toHaveBeenCalledWith(expect.anything(), 'H2', 'H2.T_MEMCARD_REG');
    const addTabCall = storeState.addTab.mock.calls[storeState.addTab.mock.calls.length - 1]?.[0];
    const editQuery = String(addTabCall?.query || '');
    expect(editQuery).toContain('FULL_TRIGGER_DDL_TAIL');
    expect(editQuery).not.toContain('[CLOB preview:');
    expect(editQuery).not.toContain('请补全 CREATE TRIGGER 语句');
    expect(editQuery).not.toMatch(/\bDROP\s+TRIGGER\b/i);
  });

  it('opens trigger and routine object-edit tabs on ctrl left click inside the editor', async () => {
    editorState.value = 'call audit.users_bi(); call reporting.refresh_stats();';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (sql.includes('SHOW CREATE TRIGGER')) {
        return { success: true, data: [{ 'SQL Original Statement': 'CREATE TRIGGER audit.users_bi BEFORE INSERT ON audit.users FOR EACH ROW SET @a = 1' }] };
      }
      if (sql.includes('information_schema.triggers') || sql.includes('SHOW TRIGGERS') || sql.includes('USER_TRIGGERS') || sql.includes('ALL_TRIGGERS')) {
        return { success: true, data: [{ trigger_name: 'users_bi', table_name: 'users', schema_name: 'audit' }] };
      }
      if (sql.includes('information_schema.routines') || sql.includes('SHOW FUNCTION STATUS') || sql.includes('SHOW PROCEDURE STATUS') || sql.includes('USER_OBJECTS') || sql.includes('ALL_OBJECTS')) {
        return { success: true, data: [{ routine_name: 'refresh_stats', routine_type: 'PROCEDURE', schema_name: 'reporting' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 12 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 39 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^query-edit-trigger-conn-1-main-audit-audit\.users_bi-\d+$/),
      title: '修改触发器: audit.users_bi',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'audit',
      queryMode: 'object-edit',
      returnToTabId: 'tab-1',
      query: expect.stringContaining('CREATE TRIGGER audit.users_bi'),
    }));
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^query-edit-routine-conn-1-main-reporting-reporting\.refresh_stats-\d+$/),
      title: '编辑 存储过程：reporting.refresh_stats',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'reporting',
      queryMode: 'object-edit',
      routineName: 'reporting.refresh_stats',
      routineType: 'PROCEDURE',
      returnToTabId: 'tab-1',
      query: expect.stringContaining('CREATE OR REPLACE PROCEDURE reporting.refresh_stats()'),
    }));
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
  });

  it('opens sequence and package object-edit tabs on ctrl left click inside the editor', async () => {
    editorState.value = 'select billing.order_seq.nextval from dual; begin billing.pkg_order.sync_order(1); end;';
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (sql.includes('ALL_SEQUENCES') || sql.includes('USER_SEQUENCES')) {
        return {
          success: true,
          data: [{
            sequence_owner: 'BILLING',
            sequence_name: 'ORDER_SEQ',
            min_value: 1,
            max_value: 999999,
            increment_by: 1,
            cache_size: 20,
            cycle_flag: 'N',
            order_flag: 'N',
          }],
        };
      }
      if (sql.includes('ALL_SOURCE') || sql.includes('USER_SOURCE')) {
        if (sql.includes("TYPE = 'PACKAGE BODY'")) {
          return { success: true, data: [{ TEXT: 'PACKAGE BODY pkg_order AS\nPROCEDURE sync_order(p_id NUMBER) IS BEGIN NULL; END;\nEND pkg_order;\n' }] };
        }
        return { success: true, data: [{ TEXT: 'PACKAGE pkg_order AS\nPROCEDURE sync_order(p_id NUMBER);\nEND pkg_order;\n' }] };
      }
      if (sql.includes('ALL_OBJECTS') && sql.includes("OBJECT_TYPE = 'PACKAGE'")) {
        return { success: true, data: [{ package_name: 'pkg_order', schema_name: 'billing' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 18 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 59 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^query-edit-object-conn-1-main-BILLING-BILLING\.ORDER_SEQ-\d+$/),
      title: '修改序列: BILLING.ORDER_SEQ',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'BILLING',
      queryMode: 'object-edit',
      sequenceName: 'BILLING.ORDER_SEQ',
      query: expect.stringContaining('CREATE SEQUENCE BILLING.ORDER_SEQ'),
    }));
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^query-edit-object-conn-1-main-billing-billing\.pkg_order-\d+$/),
      title: '修改存储包: billing.pkg_order',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'billing',
      queryMode: 'object-edit',
      packageName: 'billing.pkg_order',
      query: expect.stringContaining('CREATE OR REPLACE PACKAGE pkg_order'),
    }));
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
  });

  describe('object navigation tab title localization', () => {
    it('uses the English catalog title for view object-edit tabs', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'select * from reporting.active_users';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (sql.includes('information_schema.views') || sql.includes('pg_catalog.pg_views') || sql.includes('USER_VIEWS') || sql.includes('ALL_VIEWS')) {
          return { success: true, data: [{ view_name: 'active_users', schema_name: 'reporting', view_definition: 'select id from users' }] };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      await act(async () => {
        editorState.mouseDownListeners[0]?.({
          target: { position: { lineNumber: 1, column: 31 } },
          event: {
            leftButton: true,
            ctrlKey: true,
            metaKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.stringMatching(/^query-edit-object-conn-1-main-reporting-reporting\.active_users-\d+$/),
        title: 'Edit View: reporting.active_users',
        type: 'query',
        schemaName: 'reporting',
        queryMode: 'object-edit',
      }));
    });

    it('uses the English catalog titles for trigger and procedure object-edit tabs', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'call audit.users_bi(); call reporting.refresh_stats();';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (sql.includes('SHOW CREATE TRIGGER')) {
          return { success: true, data: [{ 'SQL Original Statement': 'CREATE TRIGGER audit.users_bi BEFORE INSERT ON audit.users FOR EACH ROW SET @a = 1' }] };
        }
        if (sql.includes('information_schema.triggers') || sql.includes('SHOW TRIGGERS') || sql.includes('USER_TRIGGERS') || sql.includes('ALL_TRIGGERS')) {
          return { success: true, data: [{ trigger_name: 'users_bi', table_name: 'users', schema_name: 'audit' }] };
        }
        if (sql.includes('information_schema.routines') || sql.includes('SHOW FUNCTION STATUS') || sql.includes('SHOW PROCEDURE STATUS') || sql.includes('USER_OBJECTS') || sql.includes('ALL_OBJECTS')) {
          return { success: true, data: [{ routine_name: 'refresh_stats', routine_type: 'PROCEDURE', schema_name: 'reporting' }] };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      await act(async () => {
        editorState.mouseDownListeners[0]?.({
          target: { position: { lineNumber: 1, column: 12 } },
          event: {
            leftButton: true,
            ctrlKey: true,
            metaKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      await act(async () => {
        editorState.mouseDownListeners[0]?.({
          target: { position: { lineNumber: 1, column: 39 } },
          event: {
            leftButton: true,
            ctrlKey: true,
            metaKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.stringMatching(/^query-edit-trigger-conn-1-main-audit-audit\.users_bi-\d+$/),
        title: 'Edit trigger: audit.users_bi',
        type: 'query',
        schemaName: 'audit',
        queryMode: 'object-edit',
      }));
      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.stringMatching(/^query-edit-routine-conn-1-main-reporting-reporting\.refresh_stats-\d+$/),
        title: 'Edit Procedure: reporting.refresh_stats',
        type: 'query',
        schemaName: 'reporting',
        queryMode: 'object-edit',
      }));
    });

    it('uses the English catalog title for materialized view object-edit tabs', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      storeState.connections[0].config.type = 'starrocks';
      editorState.value = 'select * from analytics.mv_daily_stats';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'analytics' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (sql.includes("UPPER(TABLE_TYPE) LIKE '%MATERIALIZED%'") || sql.includes('SHOW MATERIALIZED VIEWS')) {
          return { success: true, data: [{ object_name: 'mv_daily_stats', schema_name: 'analytics' }] };
        }
        if (sql.includes('SHOW CREATE MATERIALIZED VIEW') || sql.includes('SHOW CREATE TABLE')) {
          return { success: true, data: [{ 'Create Table': 'CREATE MATERIALIZED VIEW analytics.mv_daily_stats AS SELECT 1 AS id' }] };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'analytics' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      await act(async () => {
        editorState.mouseDownListeners[0]?.({
          target: { position: { lineNumber: 1, column: 37 } },
          event: {
            leftButton: true,
            ctrlKey: true,
            metaKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.stringMatching(/^query-edit-object-conn-1-analytics-analytics-analytics\.mv_daily_stats-\d+$/),
        title: 'Edit Materialized view: analytics.mv_daily_stats',
        type: 'query',
        schemaName: 'analytics',
        queryMode: 'object-edit',
      }));
    });
  });

  it('switches current database on cmd left click for database identifiers', async () => {
    editorState.value = 'use analytics';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
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
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 6 } },
        event: {
          leftButton: true,
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
    });

    expect(storeState.setActiveContext).toHaveBeenCalledWith({ connectionId: 'conn-1', dbName: 'analytics' });
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', expect.objectContaining({
      dbName: 'analytics',
    }));
  });

  it('skips heavy autocomplete metadata fetch for object edit query tabs', async () => {
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'CREATE OR REPLACE VIEW reporting.active_users AS SELECT * FROM users;',
        dbName: 'main',
        queryMode: 'object-edit',
      })} />);
    });
    await act(async () => {
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetTables).not.toHaveBeenCalled();
    expect(backendApp.DBGetAllColumns).not.toHaveBeenCalled();
    expect(backendApp.DBQuery).not.toHaveBeenCalled();
    expect(editorState.editor.deltaDecorations).toHaveBeenCalledWith([], []);
  });

  it('keeps the editor empty when a tab draft is externally synced to an empty query', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: '' })} />);
    });

    expect(editorState.value).toBe('');
    expect(editorState.editor.setValue).toHaveBeenCalledWith('');
  });

  it('does not restore a closed external SQL file after unmount cleanup', async () => {
    const filePath = '/Users/me/Documents/gonavi-queries/closed.sql';
    const tab = createTab({ filePath, query: 'select 1;' });
    storeState.tabs = [tab];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={tab} />);
    });
    await act(async () => {
      editorState.value = 'select 2;';
      editorState.latestOnChange?.(editorState.value);
    });
    expect(getSQLFileTabDraft('tab-1')).toBe('select 2;');

    storeState.tabs = [];
    await act(async () => {
      renderer.unmount();
    });

    expect(getSQLFileTabDraft('tab-1')).toBe('');
  });

  it('writes the latest external SQL draft when the tab still exists on unmount', async () => {
    const filePath = '/Users/me/Documents/gonavi-queries/open.sql';
    const tab = createTab({ filePath, query: 'select 1;' });
    storeState.tabs = [tab];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={tab} />);
    });
    editorState.value = 'select 2;';

    await act(async () => {
      renderer.unmount();
    });

    expect(getSQLFileTabDraft('tab-1')).toBe('select 2;');
  });
  it('writes external SQL file tabs back to disk without creating saved queries', async () => {
    let renderer!: ReactTestRenderer;
    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ filePath })} />);
    });

    editorState.value = 'select 2;';

    await act(async () => {
      await findButton(renderer!, '保存').props.onClick();
    });

    expect(backendApp.WriteSQLFile).toHaveBeenCalledWith(filePath, 'select 2;');
    expect(storeState.saveQuery).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      filePath,
      query: 'select 2;',
      savedQueryId: undefined,
    }));
    expect(messageApi.success).toHaveBeenCalledWith('SQL 文件已保存。');
  });

  it('keeps external SQL file typing out of persisted tab drafts to avoid input freezes', async () => {
    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';

    await act(async () => {
      create(<QueryEditor tab={createTab({ filePath })} />);
    });

    storeState.updateQueryTabDraft.mockClear();
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();

    await act(async () => {
      editorState.value = 'select 1;\n1';
      editorState.latestOnChange?.(editorState.value);
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{ text: '1' }],
      }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeState.updateQueryTabDraft).not.toHaveBeenCalledWith('tab-1', expect.objectContaining({
      query: 'select 1;\n1',
    }));
    expect(getSQLFileTabDraft('tab-1')).toBe('select 1;\n1');
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValue).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValueLength).not.toHaveBeenCalled();
  });

  it('keeps large regular query typing out of persisted tab drafts to avoid input freezes', async () => {
    const largeSql = `select * from users;\n${'x'.repeat(60_000)}`;

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'select 1;' })} />);
    });

    storeState.updateQueryTabDraft.mockClear();
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();

    await act(async () => {
      editorState.value = largeSql;
      editorState.latestOnChange?.(largeSql);
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{ text: largeSql }],
      }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeState.updateQueryTabDraft).not.toHaveBeenCalledWith('tab-1', expect.objectContaining({
      query: largeSql,
    }));
    expect(getQueryTabDraft('tab-1')).toBe(largeSql);
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValueLength).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValue).not.toHaveBeenCalled();
  });

  it('debounces object decoration rescans and colors newly typed tables in the same database context', async () => {
    vi.useFakeTimers();
    Object.assign(window, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    try {
      editorState.value = 'select * from users;';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [{ Tables_in_main: 'users' }, { Tables_in_main: 'orders' }],
      });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      const readObjectTokenTexts = () => editorState.editor.deltaDecorations.mock.calls
        .flatMap((call: any[]) => call[1] || [])
        .filter((item: any) => item?.options?.inlineClassName === 'gonavi-query-editor-object-token')
        .map((item: any) => editorState.editor.getModel().getValueInRange(item.range));

      expect(readObjectTokenTexts()).toContain('users');

      editorState.editor.deltaDecorations.mockClear();
      const emitChange = (value: string, insertedText: string) => {
        editorState.value = value;
        editorState.latestOnChange?.(value);
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: insertedText }],
        }));
      };

      await act(async () => {
        emitChange('select * from users;\nselect * from orde', '\nselect * from orde');
        vi.advanceTimersByTime(225);
        await Promise.resolve();
      });
      await act(async () => {
        emitChange('select * from users;\nselect * from orders;', 'rs;');
      });

      await act(async () => {
        vi.advanceTimersByTime(449);
        await Promise.resolve();
      });
      expect(readObjectTokenTexts()).not.toContain('orders');

      await act(async () => {
        vi.advanceTimersByTime(1);
        vi.runOnlyPendingTimers();
        await Promise.resolve();
      });

      expect(readObjectTokenTexts()).toContain('orders');
      expect(editorState.editor.deltaDecorations.mock.calls.filter(
        (call: any[]) => (call[1] || []).some(
          (item: any) => item?.options?.inlineClassName === 'gonavi-query-editor-object-token',
        ),
      )).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      Object.assign(window, {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      });
    }
  });

  it('cancels a pending idle object decoration refresh when the editor becomes inactive', async () => {
    vi.useFakeTimers();
    Object.assign(window, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    let objectDecorationIdleCallback: IdleRequestCallback | undefined;
    const cancelIdleCallback = vi.fn();
    const requestIdleCallback = vi.fn((
      callback: IdleRequestCallback,
      options?: IdleRequestOptions,
    ) => {
      if (options?.timeout === 1_200) {
        objectDecorationIdleCallback = callback;
        return 41;
      }
      return 42;
    });
    Object.assign(window, { requestIdleCallback, cancelIdleCallback });

    try {
      editorState.value = 'select * from users;';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [{ Tables_in_main: 'users' }, { Tables_in_main: 'orders' }],
      });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

      const tab = createTab({ query: editorState.value, dbName: 'main' });
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={tab} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      const initialObjectTokenTexts = editorState.editor.deltaDecorations.mock.calls
        .flatMap((call: any[]) => call[1] || [])
        .filter((item: any) => item?.options?.inlineClassName === 'gonavi-query-editor-object-token')
        .map((item: any) => editorState.editor.getModel().getValueInRange(item.range));
      expect(initialObjectTokenTexts).toContain('users');
      requestIdleCallback.mockClear();
      cancelIdleCallback.mockClear();
      objectDecorationIdleCallback = undefined;

      await act(async () => {
        editorState.value = 'select * from users;\nselect * from orders;';
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: '\nselect * from orders;' }],
        }));
        vi.advanceTimersByTime(450);
        await Promise.resolve();
      });

      expect(requestIdleCallback.mock.calls.filter(([, options]) => options?.timeout === 1_200)).toHaveLength(1);
      expect(objectDecorationIdleCallback).toBeTypeOf('function');

      await act(async () => {
        renderer.update(<QueryEditor tab={tab} isActive={false} />);
      });
      expect(cancelIdleCallback).toHaveBeenCalledWith(41);

      const model = editorState.editor.getModel();
      model.getValue.mockClear();
      model.getValueLength.mockClear();
      editorState.editor.getModel.mockClear();
      editorState.editor.deltaDecorations.mockClear();

      await act(async () => {
        objectDecorationIdleCallback?.({ didTimeout: false, timeRemaining: () => 50 });
      });

      expect(editorState.editor.getModel).not.toHaveBeenCalled();
      expect(model.getValue).not.toHaveBeenCalled();
      expect(model.getValueLength).not.toHaveBeenCalled();
      expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      Object.assign(window, {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      });
    }
  });

  it('cancels the debounced object decoration refresh when the editor unmounts', async () => {
    vi.useFakeTimers();
    Object.assign(window, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });

    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ query: 'select 1;' })} />);
      });
      vi.clearAllTimers();

      await act(async () => {
        editorState.value = 'select * from orders;';
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'select * from orders;' }],
        }));
      });
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await act(async () => {
        renderer.unmount();
      });

      const model = editorState.editor.getModel();
      model.getValue.mockClear();
      model.getValueLength.mockClear();
      editorState.editor.getModel.mockClear();
      editorState.editor.deltaDecorations.mockClear();

      await act(async () => {
        vi.runOnlyPendingTimers();
        await Promise.resolve();
      });

      expect(editorState.editor.getModel).not.toHaveBeenCalled();
      expect(model.getValue).not.toHaveBeenCalled();
      expect(model.getValueLength).not.toHaveBeenCalled();
      expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      Object.assign(window, {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      });
    }
  });

  it('ignores focused local tab query echoes so IME candidate commits are not overwritten', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    editorState.value = '';
    editorState.hasTextFocus = true;
    editorState.editor.setValue.mockClear();

    await act(async () => {
      editorState.latestOnChange?.('我');
    });

    editorState.editor.getValue.mockImplementationOnce(() => '');
    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: '我' })} />);
    });

    expect(getQueryTabDraft('tab-1')).toBe('我');
    expect(editorState.editor.setValue).not.toHaveBeenCalled();
  });

  it('still applies true external tab query changes while the editor is focused', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: '' })} />);
    });

    editorState.value = '';
    editorState.hasTextFocus = true;
    editorState.editor.setValue.mockClear();

    await act(async () => {
      editorState.latestOnChange?.('我');
    });

    editorState.editor.getValue.mockImplementationOnce(() => '');
    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: 'SELECT 2;' })} />);
    });

    expect(editorState.editor.setValue).toHaveBeenCalledWith('SELECT 2;');
  });

  it('waits for the native IME commit before applying the composition fallback', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    const editorInput = {
      className: 'inputarea',
      closest: vi.fn((selector: string) => (
        selector === '.monaco-editor' ? editorState.domNode : null
      )),
    };
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: "select '';" })} />);
      });

      editorState.position = { lineNumber: 1, column: 9 };
      editorState.selection = null;
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({ target: editorInput, data: '' }));
        domListeners.compositionend?.forEach((listener) => listener({ target: editorInput, data: '我' }));
      });
      await act(async () => {
        vi.advanceTimersByTime(79);
      });

      expect(editorState.editor.executeEdits).not.toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        expect.anything(),
      );

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not apply the SQL IME fallback to a composition committed in the find replace input', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    const findReplaceInput = {
      className: 'input',
      closest: vi.fn((selector: string) => (
        selector.includes('.find-widget') || selector.includes('.monaco-inputbox')
          ? { className: 'monaco-inputbox' }
          : null
      )),
    };
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'select abc from table1;' })} />);
      });

      editorState.position = { lineNumber: 1, column: 11 };
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 8,
        endLineNumber: 1,
        endColumn: 11,
      };
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({
          target: findReplaceInput,
          data: '',
        }));
        domListeners.compositionend?.forEach((listener) => listener({
          target: findReplaceInput,
          data: 'replacement',
        }));
      });
      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(editorState.editor.executeEdits).not.toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        expect.anything(),
      );
      expect(editorState.value).toBe('select abc from table1;');
      expect(editorState.selection).toEqual({
        startLineNumber: 1,
        startColumn: 8,
        endLineNumber: 1,
        endColumn: 11,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not apply the SQL IME fallback when the find widget owns the active element', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    const findReplaceInput = {
      className: 'input',
      tagName: 'INPUT',
      closest: vi.fn((selector: string) => (
        selector.includes('.find-widget') || selector.includes('.monaco-inputbox')
          ? { className: 'monaco-inputbox' }
          : null
      )),
    };
    const editorInput = {
      className: 'inputarea',
      closest: vi.fn((selector: string) => (
        selector === '.monaco-editor' ? editorState.domNode : null
      )),
    };
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'select abc from table1;' })} />);
      });

      editorState.hasTextFocus = true;
      (document as any).activeElement = findReplaceInput;
      editorState.position = { lineNumber: 1, column: 11 };
      editorState.selection = {
        startLineNumber: 1,
        startColumn: 8,
        endLineNumber: 1,
        endColumn: 11,
      };
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({
          target: editorInput,
          data: '',
        }));
        domListeners.compositionend?.forEach((listener) => listener({
          target: editorInput,
          data: 'test',
        }));
      });
      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(editorState.editor.executeEdits).not.toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        expect.anything(),
      );
      expect(editorState.value).toBe('select abc from table1;');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips inline AI metadata warmup when no inline model is configured', async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'select * from users' })} />);
      });

      backendApp.DBGetTables.mockClear();
      editorState.position = { lineNumber: 1, column: 'select * from users'.length + 1 };
      await act(async () => {
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 's' }],
        }));
        vi.advanceTimersByTime(220);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBGetTables).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps deterministic inline SQL ghosts available before AI readiness succeeds', async () => {
    vi.useFakeTimers();
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: 'SELEC', dbName: 'main' })} />);
      });

      editorState.value = 'SELECT';
      editorState.position = { lineNumber: 1, column: 'SELECT'.length + 1 };
      editorState.domNode.appendChild.mockClear();
      backendApp.DBGetTables.mockClear();
      await act(async () => {
        editorState.latestOnChange?.('SELECT');
        editorState.modelContentListeners.forEach((listener) => listener({
          changes: [{ text: 'T' }],
        }));
        vi.advanceTimersByTime(220);
        await Promise.resolve();
      });

      const ghostOverlay = editorState.domNode.appendChild.mock.calls[
        editorState.domNode.appendChild.mock.calls.length - 1
      ]?.[0];
      expect(ghostOverlay?.textContent).toBe(' * FROM');
      expect(backendApp.DBGetTables).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers committed IME text when Monaco composition end leaves the model unchanged', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: "select '';" })} />);
      });

      editorState.position = { lineNumber: 1, column: 9 };
      editorState.selection = null;
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({ data: '' }));
        domListeners.compositionend?.forEach((listener) => listener({ data: '我' }));
      });

      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        [{
          range: expect.objectContaining({
            startLineNumber: 1,
            startColumn: 9,
            endLineNumber: 1,
            endColumn: 9,
          }),
          text: '我',
          forceMoveMarkers: true,
        }],
      );
      expect(editorState.value).toBe("select '我';");
      expect(getQueryTabDraft('tab-1')).toBe("select '我';");
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not duplicate IME text when Monaco already applied the composition commit', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: "select '';" })} />);
      });

      editorState.position = { lineNumber: 1, column: 9 };
      editorState.selection = null;
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({ data: '' }));
        editorState.value = "select '我';";
        domListeners.compositionend?.forEach((listener) => listener({ data: '我' }));
      });

      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(editorState.editor.executeEdits).not.toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        expect.anything(),
      );
      expect(editorState.value).toBe("select '我';");
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses beforeinput data as the IME fallback text when composition end data is empty', async () => {
    vi.useFakeTimers();
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode.addEventListener.mockImplementation((type: string, listener: (event?: any) => void) => {
      domListeners[type] ||= [];
      domListeners[type].push(listener);
    });
    editorState.editor.getValue.mockReset();
    editorState.editor.getValue.mockImplementation(() => editorState.value);

    try {
      await act(async () => {
        create(<QueryEditor tab={createTab({ query: "select '';" })} />);
      });

      editorState.position = { lineNumber: 1, column: 9 };
      editorState.selection = null;
      editorState.editor.executeEdits.mockClear();

      await act(async () => {
        domListeners.compositionstart?.forEach((listener) => listener({ data: '' }));
        domListeners.beforeinput?.forEach((listener) => listener({
          data: '我',
          inputType: 'insertCompositionText',
          isComposing: true,
        }));
        domListeners.compositionend?.forEach((listener) => listener({ data: '' }));
      });

      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
        'gonavi-ime-composition-fallback',
        [expect.objectContaining({ text: '我' })],
      );
      expect(editorState.value).toBe("select '我';");
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps short regular query typing on the Monaco fast path without rerender side effects', async () => {
    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'select 1;' })} />);
    });

    storeState.updateQueryTabDraft.mockClear();
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();

    await act(async () => {
      editorState.value = 'SELECT * FROM fs_org_auth_application;\n\nSELECT * FROM fs_bcp_auth_info; ';
      editorState.latestOnChange?.(editorState.value);
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{ text: ' ' }],
      }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getQueryTabDraft('tab-1')).toBe('SELECT * FROM fs_org_auth_application;\n\nSELECT * FROM fs_bcp_auth_info; ');
    expect(storeState.updateQueryTabDraft).not.toHaveBeenCalledWith('tab-1', expect.objectContaining({
      query: expect.any(String),
    }));
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValue).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValueLength).not.toHaveBeenCalled();
  });

  it('skips SQL literals when collecting object decoration candidates for insert scripts', () => {
    const insertValues = Array.from({ length: 120 }, (_, index) => {
      const suffix = String(index + 1).padStart(3, '0');
      return `('legacy-seed-L${suffix}', '旧版企业-L${suffix}', '深圳市南山区 ${suffix} 号', 'legacy${suffix}@demo.test')`;
    }).join(',\n');
    const sql = [
      '-- 字符串里的 fs_org_auth_file 不应参与对象装饰扫描',
      'INSERT INTO mkefu_location_dev_local.uk_corp (id, corp_name, address, email) VALUES',
      `${insertValues};`,
      'SELECT uk_corp.id FROM uk_corp;',
    ].join('\n');

    const candidates = collectQueryEditorObjectDecorationCandidates(sql, 1000);
    const candidateTexts = candidates.map((candidate) => candidate.lineContent.slice(candidate.positionColumn - 1, candidate.positionColumn + 30));

    expect(candidateTexts.some((text) => text.includes('legacy-seed'))).toBe(false);
    expect(candidateTexts.some((text) => text.includes('旧版企业'))).toBe(false);
    expect(candidateTexts.some((text) => text.includes('demo.test'))).toBe(false);
    expect(candidateTexts.some((text) => text.includes('mkefu_location_dev_local'))).toBe(true);
    expect(candidateTexts.some((text) => text.includes('uk_corp'))).toBe(true);
  });

  it('does not provide metadata hover inside SQL string literals', async () => {
    editorState.value = "insert into users(name) values ('users.id should stay plain');";
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({
      success: true,
      data: [{ tableName: 'users', name: 'id', type: 'bigint', comment: '主键ID' }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const hoverProvider = editorState.hoverProviders[2];
    expect(hoverProvider).toBeTruthy();
    const literalColumn = editorState.value.indexOf('users.id should') + 3;
    const hover = hoverProvider.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: literalColumn },
    );

    expect(hover).toBeNull();
  });

  it('registers Ctrl/Cmd+S to quick-save the active query', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    storeState.savedQueries = [
      {
        id: 'saved-1',
        name: '常用查询',
        sql: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        createdAt: 100,
      },
    ];

    await act(async () => {
      create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    const saveAction = findEditorAction('gonavi.saveQuery');
    expect(saveAction).toMatchObject({
      label: 'GoNavi: 保存查询',
    });
    expect(saveAction?.keybindings?.[0]).toBeGreaterThan(0);

    editorState.value = 'select 5;';
    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const event = {
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: false,
      key: 's',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: '常用查询',
      sql: 'select 5;',
      connectionId: 'conn-1',
      dbName: 'main',
      createdAt: 100,
    }));
    expect(messageApi.success).toHaveBeenCalledWith('查询已保存。');
  });

  it('registers Cmd/Ctrl+Shift+S to open save as for a saved query', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    storeState.savedQueries = [
      {
        id: 'saved-1',
        name: '常用查询',
        sql: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        createdAt: 100,
      },
    ];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    const saveAsAction = findEditorAction('gonavi.saveQueryAs');
    expect(saveAsAction).toMatchObject({
      label: 'GoNavi: 查询另存为',
      keybindings: [2048 | 1024 | 83],
    });
    expect(textContent(findButton(renderer, '另存为'))).toContain('⌘⇧S');

    const event = {
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
      key: 's',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(saveQueryNameInputFocus).toHaveBeenCalledWith({ cursor: 'all' });
    expect(storeState.saveQuery).not.toHaveBeenCalled();
  });

  it('does not consume Cmd/Ctrl+Shift+S for new or external SQL query tabs', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ title: '新建查询' })} />);
    });

    const newQueryEvent = {
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
      key: 's',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(newQueryEvent));
    });
    expect(newQueryEvent.preventDefault).not.toHaveBeenCalled();
    expect(newQueryEvent.stopPropagation).not.toHaveBeenCalled();
    expect(saveQueryNameInputFocus).not.toHaveBeenCalled();

    let externalRenderer!: ReactTestRenderer;
    await act(async () => {
      externalRenderer = create(<QueryEditor tab={createTab({ filePath: '/tmp/report.sql' })} />);
    });

    const externalQueryEvent = {
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
      key: 's',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(externalQueryEvent));
    });
    expect(externalQueryEvent.preventDefault).not.toHaveBeenCalled();
    expect(externalQueryEvent.stopPropagation).not.toHaveBeenCalled();
    expect(saveQueryNameInputFocus).not.toHaveBeenCalled();
    externalRenderer.unmount();
  });

  it('allows Ctrl/Cmd+S to save external SQL files from document-level targets', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';
    editorState.hasTextFocus = false;

    await act(async () => {
      create(<QueryEditor tab={createTab({ filePath })} />);
    });

    editorState.value = 'select 6;';
    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const event = {
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: false,
      key: 's',
      target: document.body,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(backendApp.WriteSQLFile).toHaveBeenCalledWith(filePath, 'select 6;');
    expect(messageApi.success).toHaveBeenCalledWith(expect.stringContaining('SQL 文件已保存'));
  });

  it('does not create saved queries when external SQL file writes fail', async () => {
    let renderer!: ReactTestRenderer;
    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';
    backendApp.WriteSQLFile.mockResolvedValueOnce({ success: false, message: '磁盘只读' });

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ filePath })} />);
    });

    editorState.value = 'select 4;';

    await act(async () => {
      await findButton(renderer!, '保存').props.onClick();
    });

    expect(backendApp.WriteSQLFile).toHaveBeenCalledWith(filePath, 'select 4;');
    expect(storeState.saveQuery).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.error).toHaveBeenCalledWith('保存 SQL 文件失败：磁盘只读');
  });

  it('focuses the query name input when first saving a new query', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ title: '新建查询' })} />);
    });

    await act(async () => {
      findButton(renderer!, '保存').props.onClick();
      await Promise.resolve();
    });

    expect(saveQueryNameInputFocus).toHaveBeenCalledWith({ cursor: 'all' });
  });

  it('keeps saved query quick-save behavior for non-file tabs', async () => {
    storeState.savedQueries = [
      {
        id: 'saved-1',
        name: '常用查询',
        sql: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        createdAt: 100,
      },
    ];
    storeState.saveQuery.mockImplementationOnce(async (savedQuery: SavedQuery) => {
      storeState.savedQueries = storeState.savedQueries.map((item) => (
        item.id === savedQuery.id ? savedQuery : item
      ));
      storeSubscribers.forEach((subscriber) => subscriber());
      return savedQuery;
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    await act(async () => {
      editorState.value = 'select 3;';
      editorState.latestOnChange?.(editorState.value);
    });
    expect(getQueryTabDraft('tab-1')).toBe('select 3;');

    await act(async () => {
      await findButton(renderer!, '保存').props.onClick();
    });

    expect(backendApp.WriteSQLFile).not.toHaveBeenCalled();
    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: '常用查询',
      sql: 'select 3;',
      connectionId: 'conn-1',
      dbName: 'main',
      createdAt: 100,
    }));
    expect(getQueryTabDraft('tab-1')).toBe('');
  });

  it('saves a copy of an existing query without overwriting the original', async () => {
    const originalQuery: SavedQuery = {
      id: 'saved-1',
      name: '常用查询',
      sql: 'select 1;',
      connectionId: 'conn-1',
      dbName: 'main',
      createdAt: 100,
    };
    storeState.savedQueries = [originalQuery];
    const sourceTab = createTab({
      id: originalQuery.id,
      title: originalQuery.name,
      query: originalQuery.sql,
      savedQueryId: originalQuery.id,
    });
    storeState.tabs = [sourceTab];
    storeState.addTab.mockImplementation((nextTab: TabData) => {
      const existingIndex = storeState.tabs.findIndex((item) => item.id === nextTab.id);
      storeState.tabs = existingIndex >= 0
        ? storeState.tabs.map((item, index) => index === existingIndex ? { ...item, ...nextTab } : item)
        : [...storeState.tabs, nextTab];
      storeState.activeTabId = nextTab.id;
      notifyStoreSubscribers();
    });
    storeState.saveQuery.mockImplementation(async (savedQuery: SavedQuery) => {
      const existing = storeState.savedQueries.some((item) => item.id === savedQuery.id);
      storeState.savedQueries = existing
        ? storeState.savedQueries.map((item) => item.id === savedQuery.id ? savedQuery : item)
        : [...storeState.savedQueries, savedQuery];
      notifyStoreSubscribers();
      return savedQuery;
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={sourceTab} />);
    });

    await act(async () => {
      editorState.value = 'select 9;';
      editorState.latestOnChange?.(editorState.value);
      findButton(renderer!, '另存为').props.onClick();
    });
    await act(async () => {
      const saveAsButtons = renderer!.root.findAll(
        (node) => node.type === 'button' && textContent(node) === '另存为',
      );
      await saveAsButtons[saveAsButtons.length - 1]?.props.onClick();
    });

    const copiedQuery = storeState.saveQuery.mock.calls[0]?.[0] as SavedQuery;
    expect(copiedQuery).toEqual(expect.objectContaining({
      name: '查询',
      sql: 'select 9;',
      connectionId: 'conn-1',
      dbName: 'main',
    }));
    expect(copiedQuery.id).not.toBe(originalQuery.id);
    expect(copiedQuery.createdAt).not.toBe(originalQuery.createdAt);
    expect(storeState.savedQueries).toEqual(expect.arrayContaining([originalQuery, copiedQuery]));
    expect(storeState.addTab).toHaveBeenLastCalledWith(expect.objectContaining({
      id: copiedQuery.id,
      title: '查询',
      savedQueryId: copiedQuery.id,
      query: 'select 9;',
    }));
    expect(storeState.tabs).toEqual(expect.arrayContaining([
      sourceTab,
      expect.objectContaining({
        id: copiedQuery.id,
        savedQueryId: copiedQuery.id,
        query: 'select 9;',
      }),
    ]));
    expect(storeState.activeTabId).toBe(copiedQuery.id);
    expect(getQueryTabDraft(sourceTab.id)).toBe('select 9;');
    expect(getQueryTabDraft(copiedQuery.id)).toBe('');
  });

  it('keeps edits made while a saved-query write is pending', async () => {
    storeState.savedQueries = [
      {
        id: 'saved-1',
        name: '常用查询',
        sql: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        createdAt: 100,
      },
    ];
    let finishSave!: () => void;
    storeState.saveQuery.mockImplementationOnce((savedQuery: SavedQuery) => new Promise((resolve) => {
      finishSave = () => {
        storeState.savedQueries = storeState.savedQueries.map((item) => (
          item.id === savedQuery.id ? savedQuery : item
        ));
        notifyStoreSubscribers();
        resolve(savedQuery);
      };
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    let savePromise!: Promise<void>;
    await act(async () => {
      editorState.value = 'select 2;';
      editorState.latestOnChange?.(editorState.value);
      savePromise = findButton(renderer, '保存').props.onClick();
      await Promise.resolve();
    });
    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({ sql: 'select 2;' }));

    await act(async () => {
      editorState.value = 'select 3;';
      editorState.latestOnChange?.(editorState.value);
      finishSave();
      await savePromise;
    });

    expect(storeState.addTab).toHaveBeenLastCalledWith(expect.objectContaining({
      savedQueryId: 'saved-1',
      query: 'select 3;',
    }));
    expect(getQueryTabDraft('tab-1')).toBe('select 3;');
  });

  it('keeps edits made while an external SQL file write is pending', async () => {
    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';
    let finishWrite!: () => void;
    backendApp.WriteSQLFile.mockImplementationOnce(() => new Promise((resolve) => {
      finishWrite = () => resolve({ success: true });
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ filePath })} />);
    });

    let savePromise!: Promise<void>;
    await act(async () => {
      editorState.value = 'select 2;';
      editorState.latestOnChange?.(editorState.value);
      savePromise = findButton(renderer, '保存').props.onClick();
      await Promise.resolve();
    });
    expect(backendApp.WriteSQLFile).toHaveBeenCalledWith(filePath, 'select 2;');

    await act(async () => {
      editorState.value = 'select 3;';
      editorState.latestOnChange?.(editorState.value);
      finishWrite();
      await savePromise;
    });

    expect(storeState.addTab).toHaveBeenLastCalledWith(expect.objectContaining({
      filePath,
      query: 'select 3;',
    }));
    expect(getSQLFileTabDraft('tab-1')).toBe('select 3;');
  });

  it('does not reopen an external SQL file tab after a pending write outlives the editor', async () => {
    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';
    let finishWrite!: () => void;
    backendApp.WriteSQLFile.mockImplementationOnce(() => new Promise((resolve) => {
      finishWrite = () => resolve({ success: true });
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ filePath })} />);
    });

    let savePromise!: Promise<void>;
    await act(async () => {
      editorState.value = 'select 2;';
      editorState.latestOnChange?.(editorState.value);
      savePromise = findButton(renderer, '保存').props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      finishWrite();
      await savePromise;
    });

    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.success).not.toHaveBeenCalled();
  });

  it('serializes repeated saved-query writes so the newest content is persisted last', async () => {
    storeState.savedQueries = [
      {
        id: 'saved-1',
        name: '常用查询',
        sql: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        createdAt: 100,
      },
    ];
    const finishWrites: Array<() => void> = [];
    storeState.saveQuery.mockImplementation((savedQuery: SavedQuery) => new Promise((resolve) => {
      finishWrites.push(() => {
        storeState.savedQueries = storeState.savedQueries.map((item) => (
          item.id === savedQuery.id ? savedQuery : item
        ));
        notifyStoreSubscribers();
        resolve(savedQuery);
      });
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    let firstSavePromise!: Promise<void>;
    await act(async () => {
      editorState.value = 'select 2;';
      editorState.latestOnChange?.(editorState.value);
      firstSavePromise = findButton(renderer, '保存').props.onClick();
      await Promise.resolve();
    });

    let secondSavePromise!: Promise<void>;
    await act(async () => {
      editorState.value = 'select 3;';
      editorState.latestOnChange?.(editorState.value);
      secondSavePromise = findButton(renderer, '保存').props.onClick();
      await Promise.resolve();
    });
    expect(storeState.saveQuery).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishWrites[0]();
      await firstSavePromise;
      await Promise.resolve();
    });
    expect(storeState.saveQuery).toHaveBeenCalledTimes(2);
    expect(storeState.saveQuery).toHaveBeenLastCalledWith(expect.objectContaining({ sql: 'select 3;' }));

    await act(async () => {
      finishWrites[1]();
      await secondSavePromise;
    });
    expect(storeState.savedQueries[0].sql).toBe('select 3;');
    expect(getQueryTabDraft('tab-1')).toBe('');
  });

  it('keeps the latest editor draft when saved-query metadata rerenders', async () => {
    storeState.savedQueries = [
      {
        id: 'saved-1',
        name: '常用查询',
        sql: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        createdAt: 100,
      },
    ];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    await act(async () => {
      editorState.value = 'select 3;';
      editorState.latestOnChange?.(editorState.value);
    });
    expect(getQueryTabDraft('tab-1')).toBe('select 3;');

    await act(async () => {
      renderer.update(
        <QueryEditor tab={createTab({ title: '已重命名查询', savedQueryId: 'saved-1' })} />,
      );
    });

    expect(getQueryTabDraft('tab-1')).toBe('select 3;');
  });

  it('keeps untitled fallback when the new query tab title is localized', async () => {
    setCurrentLanguage('en-US');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ title: 'New Query', savedQueryId: 'saved-1' })} />);
    });

    editorState.value = 'select 8;';

    await act(async () => {
      findButton(renderer!, 'Save').props.onClick();
    });

    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: 'Untitled query',
      sql: 'select 8;',
      connectionId: 'conn-1',
      dbName: 'main',
    }));
  });

  it('keeps untitled fallback after a language switch when the tab title came from another locale', async () => {
    setCurrentLanguage('ja-JP');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ title: 'New Query', savedQueryId: 'saved-1' })} />);
    });

    editorState.value = 'select 10;';

    await act(async () => {
      findButton(renderer!, '保存').props.onClick();
    });

    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: '無題のクエリ',
      sql: 'select 10;',
      connectionId: 'conn-1',
      dbName: 'main',
    }));
  });

  it('keeps untitled fallback for database-scoped new query titles after a language switch', async () => {
    setCurrentLanguage('ja-JP');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ title: 'New query (main)', savedQueryId: 'saved-1' })} />);
    });

    editorState.value = 'select 11;';

    await act(async () => {
      findButton(renderer!, '保存').props.onClick();
    });

    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: '無題のクエリ',
      sql: 'select 11;',
      connectionId: 'conn-1',
      dbName: 'main',
    }));
  });

  it('renames saved queries without creating a new saved query id', async () => {
    storeState.savedQueries = [
      {
        id: 'saved-1',
        name: '常用查询',
        sql: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        createdAt: 100,
      },
    ];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    editorState.value = 'select 9;';
    await act(async () => {
      findButton(renderer!, '重命名查询').props.onClick();
    });
    await act(async () => {
      await findExactButton(renderer!, '重命名').props.onClick();
    });

    expect(storeState.saveQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'saved-1',
      name: '查询',
      sql: 'select 9;',
      connectionId: 'conn-1',
      dbName: 'main',
      createdAt: 100,
    }));
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      title: '查询',
      savedQueryId: 'saved-1',
    }));
    expect(messageApi.success).toHaveBeenCalledWith('查询已重命名。');
  });

  it('opens the existing rename flow for the query tab context-menu request', async () => {
    storeState.savedQueries = [
      {
        id: 'saved-1',
        name: '常用查询',
        sql: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        createdAt: 100,
      },
    ];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    const renameRequestListenerCalls = (window.addEventListener as any).mock.calls
      .filter(([eventName]: [string]) => eventName === QUERY_TAB_RENAME_REQUEST_EVENT);
    const renameRequestListener = renameRequestListenerCalls[renameRequestListenerCalls.length - 1]?.[1];
    expect(renameRequestListener).toBeTypeOf('function');

    await act(async () => {
      renameRequestListener(new CustomEvent(QUERY_TAB_RENAME_REQUEST_EVENT, {
        detail: { tabId: 'another-tab' },
      }));
    });
    expect(findExactButton(renderer!, '重命名')).toBeUndefined();

    await act(async () => {
      renameRequestListener(new CustomEvent(QUERY_TAB_RENAME_REQUEST_EVENT, {
        detail: { tabId: 'tab-1' },
      }));
    });
    expect(findExactButton(renderer!, '重命名')).toBeTruthy();
  });

  it('exports the current editor SQL without changing saved query state', async () => {
    storeState.savedQueries = [
      {
        id: 'saved-1',
        name: '常用查询',
        sql: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        createdAt: 100,
      },
    ];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    editorState.value = 'select 10;';
    await act(async () => {
      await findButton(renderer!, '导出 SQL 文件').props.onClick();
    });

    expect(backendApp.ExportSQLFile).toHaveBeenCalledWith('常用查询', 'select 10;');
    expect(storeState.saveQuery).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalledWith(expect.objectContaining({
      query: 'select 10;',
    }));
    expect(messageApi.success).toHaveBeenCalledWith('SQL 文件已导出。');
  });

  it('downloads SQL directly in the web runtime without invoking the desktop export dialog', async () => {
    storeState.savedQueries = [{
      id: 'saved-1',
      name: '常用查询',
      sql: 'select 1;',
      connectionId: 'conn-1',
      dbName: 'main',
      createdAt: 100,
    }];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
    });

    (window as any).__GONAVI_WEB_RUNTIME__ = { buildType: 'web' };
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
    };
    (document.createElement as any).mockReturnValueOnce(anchor);
    (document.body as any).removeChild = vi.fn();
    const createObjectURL = vi.fn(() => 'blob:web-sql');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    editorState.value = 'select 10;';

    await act(async () => {
      await findButton(renderer, '导出 SQL 文件').props.onClick();
    });

    expect(backendApp.ExportSQLFile).not.toHaveBeenCalled();
    expect(anchor).toMatchObject({ href: 'blob:web-sql', download: '常用查询.sql' });
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:web-sql');
    expect(messageApi.success).toHaveBeenCalledWith('SQL 文件已导出。');
  });

  describe('export sql file toast localization', () => {
    const prepareSavedQueryExport = async () => {
      storeState.savedQueries = [
        {
          id: 'saved-1',
          name: '常用查询',
          sql: 'select 1;',
          connectionId: 'conn-1',
          dbName: 'main',
          createdAt: 100,
        },
      ];

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ savedQueryId: 'saved-1' })} />);
      });

      editorState.value = 'select 10;';
      return renderer;
    };

    it('shows the English success toast after exporting a SQL file', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      const renderer = await prepareSavedQueryExport();

      await act(async () => {
        await findButton(renderer, 'Export SQL file').props.onClick();
      });

      expect(backendApp.ExportSQLFile).toHaveBeenCalledWith('常用查询', 'select 10;');
      expect(messageApi.success).toHaveBeenCalledWith('SQL file exported.');
      expect(messageApi.success).not.toHaveBeenCalledWith('SQL 文件已导出！');
    });

    it('shows the English response failure toast while preserving the raw error detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      backendApp.ExportSQLFile.mockResolvedValueOnce({ success: false, message: 'disk full' });
      const renderer = await prepareSavedQueryExport();

      await act(async () => {
        await findButton(renderer, 'Export SQL file').props.onClick();
      });

      expect(backendApp.ExportSQLFile).toHaveBeenCalledWith('常用查询', 'select 10;');
      expect(messageApi.error).toHaveBeenCalledWith('Export SQL file failed: disk full');
      expect(messageApi.error).not.toHaveBeenCalledWith('导出 SQL 文件失败: disk full');
    });

    it('shows the English rejected failure toast while preserving the raw error detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      backendApp.ExportSQLFile.mockRejectedValueOnce(new Error('permission denied'));
      const renderer = await prepareSavedQueryExport();

      await act(async () => {
        await findButton(renderer, 'Export SQL file').props.onClick();
      });

      expect(backendApp.ExportSQLFile).toHaveBeenCalledWith('常用查询', 'select 10;');
      expect(messageApi.error).toHaveBeenCalledWith('Export SQL file failed: permission denied');
      expect(messageApi.error).not.toHaveBeenCalledWith('导出 SQL 文件失败: permission denied');
    });

    it('falls back to the English unknown detail when export SQL file rejection has no usable detail', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      backendApp.ExportSQLFile.mockRejectedValueOnce({});
      const renderer = await prepareSavedQueryExport();

      await act(async () => {
        await findButton(renderer, 'Export SQL file').props.onClick();
      });

      expect(backendApp.ExportSQLFile).toHaveBeenCalledWith('常用查询', 'select 10;');
      expect(messageApi.error).toHaveBeenCalledWith('Export SQL file failed: Unknown');
      expect(messageApi.error).not.toHaveBeenCalledWith('Export SQL file failed: [object Object]');
      expect(messageApi.error).not.toHaveBeenCalledWith('导出 SQL 文件失败：未知');
    });
  });

  it('shows Chinese semantic meaning for SQL execution errors', async () => {
    storeState.appearance.uiVersion = 'v2';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      message: 'pq: syntax error at or near "from"',
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * from' })} />);
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const pageText = textContent(renderer!.root);
    expect(pageText).toContain('SQL 执行日志');
    expect(pageText).toContain('执行失败');
    expect(pageText).toContain('中文语义：SQL 语法错误');
    expect(pageText).toContain('处理建议：');
    expect(pageText).toContain('原始错误：pq: syntax error at or near "from"');
  });

  it('runs SQL editor DML through a pending managed transaction and commits manually', async () => {
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-1',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 2 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: "UPDATE users SET name = 'new' WHERE id = 1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('UPDATE users SET name'),
      'query-1',
    );
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(textContent(renderer!.root)).not.toContain('未提交');
    expect(textContent(renderer!.root)).toContain('提交');
    expect(textContent(renderer!.root)).toContain('影响行数：2');
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-1',
      dbType: 'mysql',
      dbName: 'main',
      statements: ["UPDATE users SET name = 'new' WHERE id = 1"],
      executionDurationMs: expect.any(Number),
    });

    const latestConnectionSelect = [...antdSelectState.props].reverse().find((props) => (
      props.placeholder === catalogs['zh-CN']['query_editor.placeholder.connection']
    ));
    const latestDatabaseSelect = [...antdSelectState.props].reverse().find((props) => (
      props.placeholder === catalogs['zh-CN']['query_editor.placeholder.database']
    ));
    expect(latestConnectionSelect?.disabled).toBe(true);
    expect(latestDatabaseSelect?.disabled).toBe(true);

    await act(async () => {
      latestDatabaseSelect?.onChange('analytics');
    });
    expect(storeState.updateQueryTabDraft).not.toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ dbName: 'analytics' }),
    );

    await act(async () => {
      await findButton(renderer!, '提交').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledWith('tx-1', 'manual');
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: "START TRANSACTION;\nUPDATE users SET name = 'new' WHERE id = 1;\nCOMMIT;",
      status: 'success',
      dbName: 'main',
    }));
    expect(textContent(renderer!.root)).not.toContain('未提交');
  });

  it('locks the query context while a managed transaction request is in flight', async () => {
    let resolveTransaction!: (value: any) => void;
    backendApp.DBQueryMultiTransactional.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTransaction = resolve;
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: "UPDATE users SET name = 'new' WHERE id = 1" })} />);
    });

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = Promise.resolve(findButton(renderer!, '运行').props.onClick());
      await vi.waitFor(() => {
        expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledTimes(1);
      });
    });

    const inFlightToolbar = renderer.root.findByType(QueryEditorToolbar);
    expect(inFlightToolbar.props.contextSelectionDisabled).toBe(true);

    await act(async () => {
      inFlightToolbar.props.onDatabaseChange('analytics');
    });
    expect(storeState.updateQueryTabDraft).not.toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ dbName: 'analytics' }),
    );
    expect(renderer.root.findByType(QueryEditorToolbar).props.currentDb).toBe('main');

    await act(async () => {
      resolveTransaction({
        success: true,
        transactionId: 'tx-in-flight',
        transactionPending: true,
        data: [],
      });
      await runPromise;
    });

    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-in-flight',
      dbName: 'main',
    });
    expect(renderer.root.findByType(QueryEditorToolbar).props.contextSelectionDisabled).toBe(true);
  });

  it('keeps DML with a trailing line comment in a pending managed transaction', async () => {
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-comment',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: 'DELETE FROM users WHERE id = 1; -- keep this operation pending',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      'DELETE FROM users WHERE id = 1',
      'query-1',
    );
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-comment',
      dbType: 'mysql',
      statements: ['DELETE FROM users WHERE id = 1'],
    });
  });

  it('keeps TDengine insert on the regular query path because it has no managed transaction support', async () => {
    storeState.connections[0].config.type = 'tdengine';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: 'INSERT INTO meters(ts, current) VALUES (NOW, 10.2)',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('INSERT INTO meters'),
      'query-1',
    );
    expect(backendApp.DBQueryMultiTransactional).not.toHaveBeenCalled();
    expect(messageApi.error).not.toHaveBeenCalledWith(expect.stringContaining('SQL 编辑器托管事务'));
    expect(textContent(renderer!.root)).toContain('影响行数：1');
  });

  it('reuses the pending managed transaction for follow-up read-only SQL in the same tab', async () => {
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-1',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });
    backendApp.DBQueryMultiInTransaction.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-1',
      transactionPending: true,
      data: [
        { columns: ['name'], rows: [{ name: 'new' }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: "UPDATE users SET name = 'new' WHERE id = 1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: 'SELECT name FROM users WHERE id = 1' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledTimes(1);
    expect(backendApp.DBQueryMultiInTransaction).toHaveBeenCalledWith(
      'tx-1',
      expect.stringContaining('SELECT name FROM users'),
      'query-1',
    );
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(dataGridState.latestProps?.columnNames).toEqual(['name']);
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ name: 'new' });
    expect(textContent(renderer!.root)).toContain('提交');
    expect(textContent(renderer!.root)).toContain('回滚');
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      statements: [
        "UPDATE users SET name = 'new' WHERE id = 1",
        'SELECT name FROM users WHERE id = 1',
      ],
      statementCount: 2,
    });

    await act(async () => {
      await findButton(renderer!, '提交').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: "START TRANSACTION;\nUPDATE users SET name = 'new' WHERE id = 1;\nSELECT name FROM users WHERE id = 1;\nCOMMIT;",
      status: 'success',
    }));
  });

  it('runs SQL editor WITH DML through a pending managed transaction', async () => {
    const sql = 'WITH target AS (SELECT id FROM users WHERE active = 1) UPDATE users SET synced = 1 WHERE id IN (SELECT id FROM target)';
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-with-dml',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 2 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
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

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('WITH target AS'),
      'query-1',
    );
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(textContent(renderer!.root)).not.toContain('未提交');
    expect(textContent(renderer!.root)).toContain('提交');

    await act(async () => {
      await findButton(renderer!, '提交').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledWith('tx-with-dml', 'manual');
  });

  it('shows the pending statement count for multi-SQL manual transactions', async () => {
    const sql = "UPDATE users SET active = 0 WHERE id = 1; DELETE FROM users WHERE id = 2;";
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-multi-dml',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 2 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: sql })} />);
    });
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: sql.length + 1,
    };

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('DELETE FROM users'),
      'query-1',
    );
    expect(textContent(renderer!.root)).not.toContain('未提交');
    expect(textContent(renderer!.root)).toContain('提交 (2)');
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-multi-dml',
      statementCount: 2,
    });
  });

  it('keeps SQL editor WITH SELECT on the regular query path', async () => {
    const sql = 'WITH target AS (SELECT id FROM users WHERE active = 1) SELECT * FROM target';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [
        { columns: ['id'], rows: [{ id: 1 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
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

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('WITH target AS'),
      'query-1',
    );
    expect(backendApp.DBQueryMultiTransactional).not.toHaveBeenCalled();
  });

  it('keeps manual SQL transaction actions inline in the top toolbar without duplicating them in result tabs', async () => {
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-toolbar-inline',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: "UPDATE users SET active = 0 WHERE id = 1" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const pageText = textContent(renderer!.root);
    expect(pageText).not.toContain('未提交');
    expect(findButtons(renderer!, '提交')).toHaveLength(1);
    expect(findButtons(renderer!, '回滚')).toHaveLength(1);
  });

  it('adds pagination to limited query results and reloads the selected page only', async () => {
    const firstPageRows = Array.from({ length: 500 }, (_item, index) => ({ id: index + 1 }));
    const secondPageRows = Array.from({ length: 500 }, (_item, index) => ({ id: index + 501 }));
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: firstPageRows, statementIndex: 1 },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: secondPageRows, statementIndex: 1 },
        ],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT id FROM users LIMIT 0,500' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.pagination).toMatchObject({
      current: 1,
      pageSize: 500,
      total: 1000,
      totalKnown: false,
    });
    expect(dataGridState.latestProps?.resultExportAllSql).toBe('SELECT id FROM users');

    await act(async () => {
      await dataGridState.latestProps?.onPageChange?.(2, 500);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    const pageSql = String(backendApp.DBQueryMulti.mock.calls[1][2]);
    expect(pageSql).toContain('SELECT * FROM (SELECT id FROM users) AS __gonavi_query_page__');
    expect(pageSql).toContain('LIMIT 501 OFFSET 500');
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      current: 2,
      pageSize: 500,
      total: 1000,
      totalKnown: true,
    });
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ id: 501 });
  });

  it('counts the exact total for a limited query result and updates pagination', async () => {
    const firstPageRows = Array.from({ length: 500 }, (_item, index) => ({ id: index + 1 }));
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-page-initial')
      .mockResolvedValueOnce('query-total-count');
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: firstPageRows, statementIndex: 1 },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['__gonavi_total__'], rows: [{ __gonavi_total__: 1234 }], statementIndex: 1 },
        ],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT id FROM users LIMIT 0,500' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.pagination).toMatchObject({
      total: 1000,
      totalKnown: false,
    });
    expect(dataGridState.latestProps?.onRequestTotalCount).toEqual(expect.any(Function));

    await act(async () => {
      await dataGridState.latestProps.onRequestTotalCount();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledTimes(2);
    expect(backendApp.DBQueryMulti).toHaveBeenLastCalledWith(
      expect.anything(),
      'main',
      'SELECT COUNT(*) AS __gonavi_total__ FROM (SELECT id FROM users) __gonavi_query_count__',
      'query-total-count',
    );
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      total: 1234,
      totalKnown: true,
      totalCountLoading: false,
    });
  });

  it('cancels a query-result total count without applying its late response', async () => {
    const firstPageRows = Array.from({ length: 500 }, (_item, index) => ({ id: index + 1 }));
    let resolveCount!: (value: any) => void;
    const pendingCount = new Promise((resolve) => {
      resolveCount = resolve;
    });
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-page-initial')
      .mockResolvedValueOnce('query-total-count');
    backendApp.CancelQuery.mockResolvedValueOnce({ success: true });
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [
          { columns: ['id'], rows: firstPageRows, statementIndex: 1 },
        ],
      })
      .mockImplementationOnce(() => pendingCount);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT id FROM users LIMIT 0,500' })} />);
    });
    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
      await Promise.resolve();
    });

    await act(async () => {
      void dataGridState.latestProps.onRequestTotalCount();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.pagination?.totalCountLoading).toBe(true);
    expect(dataGridState.latestProps?.onCancelTotalCount).toEqual(expect.any(Function));

    await act(async () => {
      await dataGridState.latestProps.onCancelTotalCount();
    });
    expect(backendApp.CancelQuery).toHaveBeenCalledWith('query-total-count');
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      total: 1000,
      totalKnown: false,
      totalCountLoading: false,
    });

    await act(async () => {
      resolveCount({
        success: true,
        data: [
          { columns: ['__gonavi_total__'], rows: [{ __gonavi_total__: 9999 }] },
        ],
      });
      await pendingCount;
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      total: 1000,
      totalKnown: false,
      totalCountLoading: false,
    });
  });

  it('does not apply an old total-count response to a newly executed result with the same key', async () => {
    const firstQueryRows = Array.from({ length: 500 }, (_item, index) => ({ old_id: index + 1 }));
    const secondQueryRows = Array.from({ length: 500 }, (_item, index) => ({ new_id: index + 1 }));
    let resolveOldCount!: (value: any) => void;
    const oldCount = new Promise((resolve) => {
      resolveOldCount = resolve;
    });
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-first')
      .mockResolvedValueOnce('query-old-total')
      .mockResolvedValueOnce('query-second');
    backendApp.CancelQuery.mockResolvedValue({ success: true });
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['old_id'], rows: firstQueryRows, statementIndex: 1 }],
      })
      .mockImplementationOnce(() => oldCount)
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['new_id'], rows: secondQueryRows, statementIndex: 1 }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT old_id FROM old_users LIMIT 0,500' })} />);
    });
    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      void dataGridState.latestProps.onRequestTotalCount();
      await Promise.resolve();
      await Promise.resolve();
    });

    editorState.value = 'SELECT new_id FROM new_users LIMIT 0,500';
    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.data?.[0]).toMatchObject({ new_id: 1 });

    await act(async () => {
      resolveOldCount({
        success: true,
        data: [{ columns: ['__gonavi_total__'], rows: [{ __gonavi_total__: 9999 }] }],
      });
      await oldCount;
      await Promise.resolve();
    });

    expect(backendApp.CancelQuery).toHaveBeenCalledWith('query-old-total');
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      total: 1000,
      totalKnown: false,
    });
  });

  it('keeps an exact counted total while navigating through non-final pages', async () => {
    const firstPageRows = Array.from({ length: 500 }, (_item, index) => ({ id: index + 1 }));
    const secondPageWithLookahead = Array.from({ length: 501 }, (_item, index) => ({ id: index + 501 }));
    backendApp.GenerateQueryID
      .mockResolvedValueOnce('query-initial')
      .mockResolvedValueOnce('query-total')
      .mockResolvedValueOnce('query-page-2');
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['id'], rows: firstPageRows, statementIndex: 1 }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['__gonavi_total__'], rows: [{ __gonavi_total__: 1234 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['id'], rows: secondPageWithLookahead, statementIndex: 1 }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT id FROM users LIMIT 0,500' })} />);
    });
    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      await dataGridState.latestProps.onRequestTotalCount();
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.pagination).toMatchObject({ total: 1234, totalKnown: true });

    await act(async () => {
      await dataGridState.latestProps.onPageChange(2, 500);
      await Promise.resolve();
    });
    expect(dataGridState.latestProps?.pagination).toMatchObject({
      current: 2,
      total: 1234,
      totalKnown: true,
    });
  });

  it('runs SQL editor data-changing CTEs through a pending managed transaction', async () => {
    const sql = 'WITH moved AS (DELETE FROM audit_logs WHERE created_at < NOW() RETURNING id) SELECT * FROM moved';
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-write-cte',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 3 }], statementIndex: 1 },
      ],
    });

    let renderer!: ReactTestRenderer;
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

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('DELETE FROM audit_logs'),
      'query-1',
    );
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(textContent(renderer!.root)).not.toContain('未提交');
  });

  it('auto commits SQL editor DML transactions after the configured delay', async () => {
    vi.useFakeTimers();
    storeState.sqlEditorTransactionOptions = {
      commitMode: 'auto',
      autoCommitDelayMs: 3000,
    };
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-auto',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });

    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ query: "DELETE FROM users WHERE id = 1" })} />);
      });

      await act(async () => {
        await findButton(renderer!, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(textContent(renderer!.root)).toContain('3s 后自动提交');
      expect(backendApp.DBCommitTransactionWithTrigger).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(3000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledWith('tx-auto', 'auto');
      expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports DBeaver-style immediate auto-commit for SQL editor DML transactions', async () => {
    vi.useFakeTimers();
    storeState.sqlEditorTransactionOptions = {
      commitMode: 'auto',
      autoCommitDelayMs: 0,
    };
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-auto-now',
      transactionPending: true,
      data: [
        { columns: ['affectedRows'], rows: [{ affectedRows: 1 }], statementIndex: 1 },
      ],
    });

    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({ query: "UPDATE users SET active = 0 WHERE id = 1" })} />);
      });

      await act(async () => {
        await findButton(renderer!, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalled();
      expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
      expect(textContent(renderer!.root)).toContain('自动提交中');
      expect(textContent(renderer!.root)).toContain('提交 (1)');
      expect(backendApp.DBCommitTransactionWithTrigger).not.toHaveBeenCalled();

      await act(async () => {
        vi.runOnlyPendingTimers();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledWith('tx-auto-now', 'auto');
      expect(textContent(renderer!.root)).not.toContain('自动提交中');
    } finally {
      vi.useRealTimers();
    }
  });

  it('automatically appends hidden primary key locator columns for editable query results', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_locator_1_ID'], rows: [{ NAME: 'old-name', __gonavi_locator_1_ID: 7 }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'ID', key: 'PRI' }, { name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ANONYMOUS', query: 'SELECT NAME FROM MYCIMLED.EDC_LOG' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('MYCIMLED.EDC_LOG');
    expect(dataGridState.latestProps?.pkColumns).toEqual(['ID']);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['ID'],
      valueColumns: ['__gonavi_locator_1_ID'],
      hiddenColumns: ['__gonavi_locator_1_ID'],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(dataGridState.latestProps?.resultSql).toBe('SELECT NAME FROM MYCIMLED.EDC_LOG');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('"ID" AS "__gonavi_locator_1_ID"');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('normalizes unquoted lowercase Oracle identifiers before committing query result edits', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_locator_1_ID'], rows: [{ NAME: 'old-name', __gonavi_locator_1_ID: 7 }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'ID', key: 'PRI' }, { name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'anonymous', query: 'select name from mycimled.edc_log' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'MYCIMLED', 'EDC_LOG');
    expect(dataGridState.latestProps?.tableName).toBe('MYCIMLED.EDC_LOG');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['ID'],
      valueColumns: ['__gonavi_locator_1_ID'],
      hiddenColumns: ['__gonavi_locator_1_ID'],
      writableColumns: {
        name: 'NAME',
      },
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('keeps dotted Dameng owner and table boundaries in editable query results', async () => {
    storeState.connections[0].config.type = 'dameng';
    storeState.connections[0].config.database = 'PEM2.4_V1_1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['ID', 'NAME'], rows: [{ ID: 7, NAME: 'old-name' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'ID', key: 'PRI' }, { name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'PEM2.4_V1_1',
        query: 'SELECT * FROM "PEM2.4_V1_1"."COM_APPROVE_INFO"',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(
      expect.anything(),
      'PEM2.4_V1_1',
      'COM_APPROVE_INFO',
    );
    expect(dataGridState.latestProps?.dbName).toBe('PEM2.4_V1_1');
    expect(dataGridState.latestProps?.tableName).toBe('PEM2.4_V1_1.COM_APPROVE_INFO');
    expect(dataGridState.latestProps?.readOnly).toBe(false);
  });

  it('keeps Dameng USER_COL_COMMENTS queries read-only without injecting ROWID', async () => {
    storeState.connections[0].config.type = 'dameng';
    storeState.connections[0].config.database = 'APP';
    const sql = `SELECT T.TABLE_NAME, T.COLUMN_NAME, T.COMMENTS
FROM USER_COL_COMMENTS T
WHERE T.TABLE_NAME = 'MEITUAN_COMMENT_INFO';`;
    backendApp.DBGetColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetIndexes.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['TABLE_NAME', 'COLUMN_NAME', 'COMMENTS'],
        rows: [{
          TABLE_NAME: 'MEITUAN_COMMENT_INFO',
          COLUMN_NAME: 'CONTENT',
          COMMENTS: '评论内容',
        }],
      }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'APP', query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('FROM USER_COL_COMMENTS T');
    expect(executedSql).not.toMatch(/\bROWID\b/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({ readOnly: true });
    expect(dataGridState.latestProps?.readOnly).toBe(true);
  });

  it('keeps Dameng DBA_TAB_PRIVS queries read-only without injecting ROWID', async () => {
    storeState.connections[0].config.type = 'dameng';
    storeState.connections[0].config.database = 'APP';
    const sql = `SELECT *
FROM DBA_TAB_PRIVS
WHERE GRANTEE = 'APPUSER';`;
    backendApp.DBGetColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetIndexes.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['GRANTEE', 'OWNER', 'TABLE_NAME', 'PRIVILEGE'],
        rows: [{
          GRANTEE: 'APPUSER',
          OWNER: 'APPUSER',
          TABLE_NAME: 'MEITUAN_COMMENT_INFO',
          PRIVILEGE: 'SELECT',
        }],
      }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'APP', query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('FROM DBA_TAB_PRIVS');
    expect(executedSql).not.toMatch(/\bROWID\b/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({ readOnly: true });
    expect(dataGridState.latestProps?.readOnly).toBe(true);
  });

  it('uses Oracle login user as default schema for unqualified query result metadata', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.user = 'dev';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'DEV.PER_CERT_INFO' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['PID', 'BUSILOG_ID', 'ZJLX_ID', ORACLE_ROWID_LOCATOR_COLUMN],
        rows: [{
          PID: '200005000000010',
          BUSILOG_ID: '00000000000000000000',
          ZJLX_ID: '01',
          [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAATestAABAAABrXAAA',
        }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'PID', type: 'CHAR(15)', comment: '个人标识', key: '' },
        { name: 'BUSILOG_ID', type: 'VARCHAR2(20)', comment: '业务日志编号', key: '' },
        { name: 'ZJLX_ID', type: 'CHAR(2)', comment: '证件类型', key: '' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: 'select * from per_cert_info' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'DEV', 'PER_CERT_INFO');
    expect(dataGridState.latestProps?.tableName).toBe('DEV.PER_CERT_INFO');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'oracle-rowid',
      columns: ['ROWID'],
      valueColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('gonavi_query_source.ROWID');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('uses a unique index locator for query results without primary keys', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_locator_1_EMAIL'], rows: [{ NAME: 'old-name', __gonavi_locator_1_EMAIL: 'a@example.com' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'EMAIL', key: '' }, { name: 'NAME', key: '' }],
    });
    backendApp.DBGetIndexes.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'UK_EMAIL', columnName: 'EMAIL', nonUnique: 0, seqInIndex: 1, indexType: 'BTREE' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ANONYMOUS', query: 'SELECT NAME FROM MYCIMLED.EDC_LOG' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'unique-key',
      columns: ['EMAIL'],
      valueColumns: ['__gonavi_locator_1_EMAIL'],
      hiddenColumns: ['__gonavi_locator_1_EMAIL'],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('"EMAIL" AS "__gonavi_locator_1_EMAIL"');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('uses snake_case unique index metadata for query result row locators', async () => {
    storeState.connections[0].config.type = 'kingbase';
    storeState.connections[0].config.database = 'KINGBASE';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_locator_1_EMAIL'], rows: [{ NAME: 'old-name', __gonavi_locator_1_EMAIL: 'a@example.com' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ column_name: 'EMAIL' }, { column_name: 'NAME' }],
    });
    backendApp.DBGetIndexes.mockResolvedValueOnce({
      success: true,
      data: [{ index_name: 'users_email_key', column_name: 'EMAIL', is_unique: 't', seq_in_index: '1', index_type: 'btree' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'KINGBASE', query: 'SELECT NAME FROM users' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'unique-key',
      columns: ['EMAIL'],
      valueColumns: ['__gonavi_locator_1_EMAIL'],
      hiddenColumns: ['__gonavi_locator_1_EMAIL'],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('keeps Kingbase schema-qualified query results writable without treating the schema as the database', async () => {
    storeState.connections[0].config.type = 'kingbase';
    storeState.connections[0].config.database = 'ldf_server_dbs_dev';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['id', 'work_order_no'],
        rows: [{ id: 1001, work_order_no: 'MO-1001' }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'id', key: 'PRI' }, { name: 'work_order_no', key: '' }],
    });
    backendApp.DBGetIndexes.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'mes_work_order_pkey', columnName: 'id', nonUnique: 0, seqInIndex: 1 }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'ldf_server_dbs_dev',
        query: 'SELECT * FROM ldf_server.mes_work_order',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'ldf_server_dbs_dev', 'ldf_server.mes_work_order');
    expect(backendApp.DBGetIndexes).toHaveBeenCalledWith(expect.anything(), 'ldf_server_dbs_dev', 'ldf_server.mes_work_order');
    expect(dataGridState.latestProps?.tableName).toBe('ldf_server.mes_work_order');
    expect(dataGridState.latestProps?.pkColumns).toEqual(['id']);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['id'],
      valueColumns: ['id'],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('uses hidden Oracle ROWID for query results without primary or unique keys', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'MYCIMLED.EDC_LOG' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', ORACLE_ROWID_LOCATOR_COLUMN], rows: [{ NAME: 'old-name', [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAAA' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ANONYMOUS', query: 'SELECT NAME FROM MYCIMLED.EDC_LOG' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'oracle-rowid',
      columns: ['ROWID'],
      valueColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      hiddenColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain(`ROWID AS "${ORACLE_ROWID_LOCATOR_COLUMN}"`);
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('keeps Oracle FOR UPDATE result columns editable when column metadata is unavailable', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.user = 'dev';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['WAFER_ID', 'STATUS'],
        rows: [{ WAFER_ID: 'R015Z10F08', STATUS: 'READY' }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'ORCLPDB1',
        query: 'SELECT * FROM table_name FOR UPDATE;',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toBe('SELECT * FROM table_name FOR UPDATE');
    expect(dataGridState.latestProps?.tableName).toBe('DEV.TABLE_NAME');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      columns: [],
      valueColumns: [],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    renderer?.unmount();
  });

  it('does not inject Oracle ROWID when the selected object is a view', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'H2.S_BUSI' }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'COMPID', key: '' }, { name: 'SALENO', key: '' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['COMPID', 'SALENO'], rows: [{ COMPID: 'H2', SALENO: '1001' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'H2',
        query: 'select * from cv_gd_yncrm_salesdtllist for update',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.anything(), 'H2');
    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toMatch(/select \* from cv_gd_yncrm_salesdtllist/i);
    expect(executedSql).not.toMatch(/\bROWID\b/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      columns: ['COMPID', 'SALENO'],
    });
    renderer?.unmount();
  });

  it('rechecks fresh Oracle table metadata before injecting ROWID after a stale completion cache', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'hydeekf';
    editorState.value = 'select * from cv_gd_yncrm_salesdtllist';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'H2' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'H2.CV_GD_YNCRM_SALESDTLLIST' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'H2' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    backendApp.DBGetTables.mockClear();
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'COMPID', key: '' }, { name: 'SALENO', key: '' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['COMPID', 'SALENO'], rows: [{ COMPID: 'H2', SALENO: '1001' }] }],
    });

    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.anything(), 'H2');
    const executedSql = String(backendApp.DBQueryMulti.mock.calls[backendApp.DBQueryMulti.mock.calls.length - 1]?.[2] || '');
    expect(executedSql).not.toMatch(/\bROWID\b/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      columns: ['COMPID', 'SALENO'],
    });
    renderer.unmount();
  });

  it('rewrites Oracle SELECT * queries before injecting hidden ROWID locator columns', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'MYCIMLED.EDC_LOG' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['WAFER_ID', ORACLE_ROWID_LOCATOR_COLUMN], rows: [{ WAFER_ID: 'R015Z10F08', [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAAA' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'WAFER_ID', key: '' }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ANONYMOUS', query: 'SELECT * FROM MYCIMLED.EDC_LOG' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('FROM MYCIMLED.EDC_LOG');
    expect(executedSql).toContain('FROM MYCIMLED.EDC_LOG gonavi_query_source');
    expect(executedSql).not.toContain('__gonavi_query_source__');
    expect(executedSql).not.toContain('SELECT *, ROWID AS');
    expect(executedSql).toMatch(/SELECT\s+gonavi_query_source\.\*\s*,\s+gonavi_query_source\.ROWID\s+AS\s+"__gonavi_oracle_rowid__"/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'oracle-rowid',
      columns: ['ROWID'],
      valueColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      hiddenColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(messageApi.warning).not.toHaveBeenCalled();
    renderer?.unmount();
  });

  it('rewrites OceanBase Oracle SELECT * queries before injecting hidden ROWID locator columns', async () => {
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.user = 'dev';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'DEV.EDC_LOG' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['WAFER_ID', ORACLE_ROWID_LOCATOR_COLUMN], rows: [{ WAFER_ID: 'R015Z10F08', [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAAA' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'WAFER_ID', key: '' }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: 'SELECT * FROM EDC_LOG' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'DEV', 'EDC_LOG');
    expect(executedSql).toContain('FROM EDC_LOG gonavi_query_source');
    expect(executedSql).toMatch(/SELECT\s+gonavi_query_source\.\*\s*,\s+gonavi_query_source\.ROWID\s+AS\s+"__gonavi_oracle_rowid__"/i);
    expect(dataGridState.latestProps?.tableName).toBe('DEV.EDC_LOG');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'oracle-rowid',
      columns: ['ROWID'],
      valueColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      hiddenColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    // 行号改由 appearance.showDataTableRowNumber 控制，不再按数据源硬编码写入结果集
    expect(dataGridState.latestProps?.showRowNumberColumn).toBeUndefined();
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: 'SELECT * FROM EDC_LOG',
      status: 'success',
    }));
    expect(messageApi.warning).not.toHaveBeenCalled();
    renderer?.unmount();
  });

  it('does not inject ROWID for an OceanBase Oracle synonym that is not a base table', async () => {
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.user = 'B';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'B.OTHER_TABLE' }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'ID', key: '' }, { name: 'NAME', key: '' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['ID', 'NAME'], rows: [{ ID: 7, NAME: 'synonym-row' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: 'SELECT * FROM person' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toMatch(/FROM\s+person/i);
    expect(executedSql).not.toMatch(/\bROWID\b/i);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      columns: ['ID', 'NAME'],
      readOnly: false,
    });
    renderer?.unmount();
  });

  it('keeps OceanBase Oracle sequence queries out of the ROWNUM auto-limit wrapper', async () => {
    const sql = 'SELECT IMP_BASICINFO.SEQ_HIS_AZA7.nextval FROM dual';
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NEXTVAL'], rows: [{ NEXTVAL: 42 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'IMP_BASICINFO', query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('IMP_BASICINFO.SEQ_HIS_AZA7.nextval');
    expect(executedSql).not.toContain('SELECT * FROM (');
    expect(executedSql).not.toMatch(/\bROWNUM\b/i);
    expect(backendApp.DBQueryMultiTransactional).not.toHaveBeenCalled();
    renderer?.unmount();
  });

  it('quotes exact-case OceanBase Oracle lowercase tables for execution while keeping sql logs unchanged', async () => {
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.user = 'SYS@oracle_tenant#cluster';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'SYS.test' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', ORACLE_ROWID_LOCATOR_COLUMN], rows: [{ NAME: 'demo', [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAAA' }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'NAME', key: '' }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: 'select * from test' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(backendApp.DBGetTables).toHaveBeenCalledWith(expect.anything(), 'SYS');
    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'SYS', 'test');
    expect(executedSql).toMatch(/from\s+"test"\s+gonavi_query_source/i);
    expect(executedSql).toMatch(/SELECT\s+gonavi_query_source\.\*\s*,\s+gonavi_query_source\.ROWID\s+AS\s+"__gonavi_oracle_rowid__"/i);
    expect(dataGridState.latestProps?.tableName).toBe('SYS.test');
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: 'select * from test',
      status: 'success',
    }));
    expect(messageApi.warning).not.toHaveBeenCalled();
    renderer?.unmount();
  });

  it('qualifies OceanBase Oracle read-only queries with the selected schema instead of the login user', async () => {
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.user = 'SBDEVREAD';
    storeState.connections[0].config.database = 'ORCLPDB1';
    (storeState.connections[0].config as any).readOnly = true;
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [],
    });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'SBDEV.PERSON_INFO' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['ZJJHM'], rows: [{ ZJJHM: '' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'SBDEV', query: "select * from person_info where zjjhm=''" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(backendApp.DBGetTables).toHaveBeenNthCalledWith(1, expect.anything(), 'SBDEVREAD');
    expect(backendApp.DBGetTables).toHaveBeenNthCalledWith(2, expect.anything(), 'SBDEV');
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(executedSql).toMatch(/from\s+"SBDEV"\."PERSON_INFO"\s+where\s+zjjhm=''/i);
    expect(executedSql).not.toContain('SBDEVREAD.PERSON_INFO');
    expect(dataGridState.latestProps?.readOnly).toBe(true);
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: "select * from person_info where zjjhm=''",
      status: 'success',
    }));
    renderer?.unmount();
  });

  it('keeps qualifying OceanBase Oracle read-only queries when config.database already equals the selected schema', async () => {
    storeState.connections[0].config.type = 'oceanbase';
    (storeState.connections[0].config as any).oceanBaseProtocol = 'oracle';
    storeState.connections[0].config.user = 'SBDEVREAD';
    storeState.connections[0].config.database = 'SBDEV';
    (storeState.connections[0].config as any).readOnly = true;
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [],
    });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Table: 'SBDEV.SYSM_USER' }],
    });
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['USER_ID'], rows: [{ USER_ID: '0001477884' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'SBDEV', query: "select * from sysm_user where user_id='0001477884'" })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(backendApp.DBGetTables).toHaveBeenNthCalledWith(1, expect.anything(), 'SBDEVREAD');
    expect(backendApp.DBGetTables).toHaveBeenNthCalledWith(2, expect.anything(), 'SBDEV');
    expect(executedSql).toMatch(/from\s+"SBDEV"\."SYSM_USER"\s+where\s+user_id='0001477884'/i);
    expect(executedSql).not.toContain('SBDEVREAD.SYSM_USER');
    renderer?.unmount();
  });

  it('keeps Oracle anonymous PL/SQL block DML pending for a manual transaction', async () => {
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
    expect(textContent(renderer!.root)).toContain('提交');
    expect(textContent(renderer!.root)).toContain('回滚');
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: plsql,
      status: 'success',
    }));

    await act(async () => {
      await findButton(renderer!, '回滚').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(backendApp.DBRollbackTransactionWithTrigger).toHaveBeenCalledWith('tx-oracle-block', 'manual');
    renderer?.unmount();
  });

  it('preserves Oracle SQLPlus slash delimiters for selected object-edit PL/SQL definitions', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });
    const expectedPlsql = [
      '-- 修改函数/存储过程：H2.cproc_tzhssr_order2sale_A1',
      '-- 请确认语法兼容当前数据库后执行',
      'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1 AS',
      'BEGIN',
      '  NULL;',
      'END cproc_tzhssr_order2sale_A1;',
      '/',
    ].join('\n');
    const legacyEditorPlsql = expectedPlsql.replace(/\n\/$/, '\n/;');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: legacyEditorPlsql, queryMode: 'object-edit' })} />);
    });
    editorState.selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 7,
      endColumn: 3,
      positionLineNumber: 7,
      positionColumn: 3,
    };

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'ORCLPDB1', expectedPlsql, 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('/;');
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
    expect(queryResultMessageText(renderer!)).toContain("Table 'users'. Scan count 1, logical reads 3.");
    expect(dataGridState.latestProps?.columnNames).not.toEqual([]);
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
    expect(queryResultMessageText(renderer!)).toContain("insert into c_dyscript(projectid,name) values (1,'demo')");
    expect(textContent(renderer!.toJSON())).not.toContain('影响行数：0');
    expect(dataGridState.latestProps).toBeNull();
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
    expect(queryResultMessageText(renderer!)).toContain("insert into c_dyscript(projectid,name) values (1,'demo')");
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

  it('falls back to all-columns editing when no safe locator exists for non-Oracle results', async () => {
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

  it('falls back to all-columns editing when unique index metadata is unavailable', async () => {
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

  it('falls back to all-columns editing when table locator metadata is unavailable', async () => {
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

  it('renders the V2 SQL log tab for the active non-Chinese language', async () => {
    storeState.appearance.uiVersion = 'v2';
    storeState.languagePreference = 'en-US';
    setCurrentLanguage('en-US');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    await act(async () => {
      findButton(renderer!, 'Show results panel').props.onClick();
    });

    const rendered = textContent(renderer!.toJSON());
    expect(findSqlLogTab(renderer!)).toHaveLength(1);
    expect(rendered).toContain(catalogs['en-US']['log_panel.short_title']);
    expect(rendered).not.toContain(catalogs['en-US']['query_editor.empty_state.title']);
    expect(rendered).not.toContain(catalogs['en-US']['query_editor.empty_state.description']);
    expect(rendered).not.toContain('等待执行 SQL');
    expect(rendered).not.toContain('运行查询后，结果会在下方以新版数据网格展示。');
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

  it('runs the statement at the cursor end from the keyboard shortcut when nothing is selected', async () => {
    storeState.shortcutOptions.runQuery.mac = { enabled: true, combo: 'Meta+Enter' };
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+Enter' };
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
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

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: [
          "SELECT * FROM uk_back_corp WHERE mobile = '18823406451';",
          "UPDATE uk_user SET email = NULL WHERE email = 'liuzhen@mail.chat5188.com'",
        ].join('\n'),
      })} />);
    });

    editorState.selection = null;
    editorState.position = {
      lineNumber: 2,
      column: "UPDATE uk_user SET email = NULL WHERE email = 'liuzhen@mail.chat5188.com'".length + 1,
    };
    editorState.cursorPositionListeners.forEach((listener) => {
      listener({ position: editorState.position });
    });

    const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const event = {
      ctrlKey: !isMacRuntime,
      metaKey: isMacRuntime,
      altKey: false,
      shiftKey: false,
      key: 'Enter',
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      windowListeners.keydown?.forEach((listener) => listener(event));
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      "UPDATE uk_user SET email = NULL WHERE email = 'liuzhen@mail.chat5188.com'",
      'query-1',
    );
    expect(String(backendApp.DBQueryMultiTransactional.mock.calls[0][2])).not.toContain('SELECT * FROM uk_back_corp');
    expect(messageApi.info).not.toHaveBeenCalledWith('没有可选择的 SQL 语句。');

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('executes all SQL when the cursor is on a trailing blank line', async () => {
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
        query: 'select 1 as a;\nselect 2 as b;\nselect 3 as c;\n',
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

    editorState.position = { lineNumber: 4, column: 1 };
    editorState.selection = {
      startLineNumber: 4,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 1,
      positionLineNumber: 4,
      positionColumn: 1,
    };
    editorState.cursorPositionListeners.forEach((listener) => {
      listener({ position: { lineNumber: 4, column: 1 } });
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
      expect(rendered).toContain('Statement 2 failed:');
      expect(rendered).toContain('Raw error: driver exploded');
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

    it('renders the non-Mongo zero-row transactional result in English', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      const query = 'update users set active = 1 where 1 = 0;';
      backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
        success: true,
        transactionId: 'tx-zero-rows',
        transactionPending: true,
        data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 0 }], statementIndex: 1 }],
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

      const rendered = textContent(renderer.toJSON());
      expect(backendApp.DBQueryWithCancel).not.toHaveBeenCalled();
      expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
      expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledTimes(1);
      expect(String(backendApp.DBQueryMultiTransactional.mock.calls[0][2])).toContain('update users set active = 1 where 1 = 0');
      expect(rendered).toContain(catalogs['en-US']['query_editor.result.execution_success']);
      expect(rendered).toContain(catalogs['en-US']['query_editor.result.affected_rows'].replace('{{count}}', '0'));
      expect(rendered).not.toContain('执行成功');
      expect(rendered).not.toContain('影响行数：0');
      expect(messageApi.success).not.toHaveBeenCalledWith('Execution succeeded.');
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
    const unlockedToolbar = renderer.root.findByType(QueryEditorToolbar);
    expect(unlockedToolbar.props.contextSelectionDisabled).toBe(false);

    await act(async () => {
      unlockedToolbar.props.onDatabaseChange('analytics');
    });
    expect(storeState.updateQueryTabDraft).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ dbName: 'analytics' }),
    );

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
    await act(async () => {
      frameCallbacks.splice(0).forEach((callback) => callback(0));
    });
    vi.mocked(window.requestAnimationFrame).mockClear();
    editorState.editor.layout.mockClear();

    const resizer = renderer.root.find((node) => node.props?.title === '拖动调整高度');
    await act(async () => {
      resizer.props.onMouseDown({ clientY: 300, preventDefault: vi.fn() });
      moveListeners.forEach((listener) => listener({ clientY: 340 } as MouseEvent));
      moveListeners.forEach((listener) => listener({ clientY: 380 } as MouseEvent));
    });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(editorState.editor.layout).not.toHaveBeenCalled();

    await act(async () => {
      frameCallbacks.splice(0).forEach((callback) => callback(16));
    });
    expect(editorState.editor.layout).toHaveBeenCalledTimes(1);

    await act(async () => {
      upListeners.forEach((listener) => listener());
    });
    expect(editorState.editor.layout).toHaveBeenCalledTimes(2);
    expect(document.removeEventListener).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(document.removeEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function));
  });

  it('persists the editor and result panel split ratio after dragging the splitter', async () => {
    storeState.appearance.uiVersion = 'v2';
    const moveListeners: Array<(event: MouseEvent) => void> = [];
    const upListeners: Array<() => void> = [];
    vi.mocked(document.addEventListener).mockImplementation((type: string, listener: any) => {
      if (type === 'mousemove') moveListeners.push(listener);
      if (type === 'mouseup') upListeners.push(listener);
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryEditor tab={createTab({ resultPanelVisible: true })} />,
        { createNodeMock: createQueryEditorSplitNodeMock },
      );
    });

    const resizer = renderer.root.find((node) => node.props?.title === '拖动调整高度');
    await act(async () => {
      resizer.props.onMouseDown({ clientY: 300, preventDefault: vi.fn() });
      moveListeners.forEach((listener) => listener({ clientY: 420 } as MouseEvent));
    });
    await act(async () => {
      upListeners.forEach((listener) => listener());
    });

    expect(storeState.setQueryOptions).toHaveBeenCalledWith({
      queryEditorEditorHeightRatio: 0.6,
    });
  });

  it('applies the persisted editor and result split ratio when opening another query tab', async () => {
    storeState.appearance.uiVersion = 'v2';
    storeState.activeTabId = 'tab-2';
    storeState.queryOptions = {
      ...storeState.queryOptions,
      queryEditorEditorHeightRatio: 0.75,
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryEditor tab={createTab({ id: 'tab-2', resultPanelVisible: true })} />,
        { createNodeMock: createQueryEditorSplitNodeMock },
      );
    });

    const editorStage = renderer.root.find((node) => {
      const className = String(node.props?.className || '');
      return className.includes('gn-v2-query-monaco-stage');
    });
    expect(editorStage.props.style.height).toBe(525);
  });

  it('inserts sidebar object text when dropped into the SQL editor', async () => {
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode = {
      style: { cursor: '' },
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        domListeners[type] ||= [];
        domListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
    } as any;

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'select * from ' })} />);
    });

    editorState.position = { lineNumber: 1, column: 'select * from '.length + 1 };

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
              return JSON.stringify({ text: 'reporting.active_users' });
            }
            if (type === 'text/plain') {
              return 'reporting.active_users';
            }
            return '';
          },
        },
      }));
    });

    expect(editorState.editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-sidebar-drop',
      [expect.objectContaining({ text: 'reporting.active_users' })],
    );
    expect(editorState.value).toContain('reporting.active_users');
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

    const hover = editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 'SELECT * FROM fs_mkefu_regist_record'.length },
    );
    expect(editorState.value).toContain('fs_mkefu_regist_record');
    expect(hover?.contents?.[0]?.value).toContain('**表** `fs_mkefu_regist_record`');

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
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'front_end_sys',
      tableName: 'fs_mkefu_regist_record',
      initialViewMode: 'fields',
      initialViewModeRequestId: expect.any(String),
      objectType: 'table',
    }));
  });

  it('keeps sidebar object navigation tied to the dragged database after drop', async () => {
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

    expect(editorState.value).toContain('front_end_sys.fs_mkefu_regist_record');

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
      initialViewMode: 'fields',
      initialViewModeRequestId: expect.any(String),
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

  it('keeps a reverse Shift+Home selection and caret when the Monaco run action executes it', async () => {
    storeState.shortcutOptions.runQuery.mac = { enabled: true, combo: 'Meta+Enter' };
    storeState.shortcutOptions.runQuery.windows = { enabled: true, combo: 'Ctrl+Enter' };
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
      data: [{ columns: ['selected'], rows: [{ selected: 2 }] }],
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as selected;\nselect 3;',
      })} />);
    });

    const reverseSelection = {
      selectionStartLineNumber: 2,
      selectionStartColumn: 'select 2 as selected'.length + 1,
      positionLineNumber: 2,
      positionColumn: 1,
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'select 2 as selected'.length + 1,
    };
    editorState.position = { lineNumber: 2, column: 1 };
    editorState.selection = reverseSelection;
    editorState.editor.setPosition.mockClear();
    editorState.editor.setSelection.mockClear();

    const runAction = findEditorAction('gonavi.runQuery');
    expect(runAction).toBeTruthy();
    await act(async () => {
      runAction.run();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.anything(),
      'main',
      expect.stringContaining('select 2 as selected'),
      'query-1',
    );
    expect(editorState.position).toEqual({ lineNumber: 2, column: 1 });
    expect(editorState.selection).toEqual(reverseSelection);
    expect(editorState.editor.setPosition).not.toHaveBeenCalled();
    expect(editorState.editor.setSelection).not.toHaveBeenCalled();
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
