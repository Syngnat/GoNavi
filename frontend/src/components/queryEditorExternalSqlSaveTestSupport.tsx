// QueryEditor.external-sql-save.test.tsx 拆分前的共享 mock 状态、mock 工厂与辅助函数；各拆分文件经 vi.mock 委托到这里。
import React from 'react';
import { create as createRenderer, type ReactTestRenderer } from 'react-test-renderer';
import { expect, vi } from 'vitest';
import type { SavedQuery, TabData } from '../types';

export const mountedRenderers = new Set<ReactTestRenderer>();

export const create = (...args: Parameters<typeof createRenderer>): ReactTestRenderer => {
  const renderer = createRenderer(...args);
  mountedRenderers.add(renderer);
  const unmount = renderer.unmount.bind(renderer);
  renderer.unmount = () => {
    mountedRenderers.delete(renderer);
    unmount();
  };
  return renderer;
};

export const createInlineAiHarnessService = (content = 'videos') => {
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
  activeContext: null as { connectionId: string; dbName: string } | null,
  setActiveContext: vi.fn(),
  updateQueryTabDraft: vi.fn(),
  savedQueries: [] as SavedQuery[],
  saveQuery: vi.fn(),
  theme: 'light',
  languagePreference: 'zh-CN' as 'zh-CN' | 'en-US',
  appearance: {
    newQuerySqlTemplate: null as string | null,
    autoAddTableAlias: true,
    customTableAliasPrefixEnabled: false,
    customTableAliasPrefix: '',
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
}))();

export const storeSubscribers = (() => new Set<() => void>())();

export const runtimeEventListeners = (() => new Map<string, Set<(...args: any[]) => void>>())();

export const runtimeApi = (() => ({
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
}))();

export const notifyStoreSubscribers = () => {
  storeSubscribers.forEach((subscriber) => subscriber());
};

export const backendApp = (() => {
  // The budgeted variants are thin wrappers over the base bindings so existing
  // assertions on DBQueryMulti / ...InTransaction / ...Transactional keep working.
  const queryMulti = vi.fn();
  const queryMultiInTransaction = vi.fn();
  const queryMultiTransactional = vi.fn();
  return {
  DBQuery: vi.fn(),
  DBQueryWithCancel: vi.fn(),
  DBQueryMulti: queryMulti,
  DBQueryMultiWithOptions: vi.fn((...args: any[]) => queryMulti(...args.slice(0, 4))),
  DBQueryMultiInTransaction: queryMultiInTransaction,
  DBQueryMultiInTransactionWithOptions: vi.fn((...args: any[]) => queryMultiInTransaction(...args.slice(0, 3))),
  DBQueryMultiTransactional: queryMultiTransactional,
  DBQueryMultiTransactionalWithOptions: vi.fn((...args: any[]) => queryMultiTransactional(...args.slice(0, 4))),
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
  DBGetServerVersion: vi.fn(),
  CancelQuery: vi.fn(),
  GenerateQueryID: vi.fn(),
  WriteSQLFile: vi.fn(),
  ExportSQLFile: vi.fn(),
  InspectElasticsearchConsole: vi.fn(),
  ExecuteElasticsearchConsole: vi.fn(),
  };
})();

export const messageApi = (() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}))();

export const saveQueryNameInputFocus = (() => vi.fn())();

export const dataGridState = (() => ({
  latestProps: null as any,
}))();

export const tabsState = (() => ({
  activeKey: undefined as string | undefined,
}))();

export const autoFetchState = (() => ({
  visible: false,
}))();

export const antdSelectState = (() => ({
  props: [] as any[],
}))();

export const monacoEditorMockState = (() => ({
  deferOnMount: false,
  latestProps: null as any,
}))();

export const defaultEditorContributionResolver = (state: {
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

export const editorState = (() => {
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
    hoverProviderRegistrationKinds: [] as string[],
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

// vi.mock('../../wailsjs/runtime')
export const mockModule2 = () => runtimeApi;

// vi.mock('../../wailsjs/go/app/App')
export const mockModule3 = () => backendApp;

// vi.mock('../utils/autoFetchVisibility')
export const mockModule4 = () => ({
  useAutoFetchVisibility: () => autoFetchState.visible,
});

// vi.mock('@monaco-editor/react')
export const mockModule5 = () => ({
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
            editorState.hoverProviderRegistrationKinds.push(String(provider?.__gonaviHoverProviderKind || 'unknown'));
            editorState.hoverProviders.push(provider);
            // Keep the legacy test accessors ([0] = metadata, [2] = DDL)
            // stable while separately recording the real registration order.
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
      if (monacoEditorMockState.deferOnMount) {
        const timer = setTimeout(mountEditor, 0);
        return () => clearTimeout(timer);
      }
      mountEditor();
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
});

// vi.mock('@ant-design/icons')
export const mockModule10 = () => {
  const Icon = () => <span />;
  return {
    ApiOutlined: Icon,
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
    FullscreenExitOutlined: Icon,
    FullscreenOutlined: Icon,
    HistoryOutlined: Icon,
    KeyOutlined: Icon,
    LoadingOutlined: Icon,
    PlayCircleOutlined: Icon,
    PushpinOutlined: Icon,
    RobotOutlined: Icon,
    AimOutlined: Icon,
    SaveOutlined: Icon,
    SearchOutlined: Icon,
    SettingOutlined: Icon,
    StopOutlined: Icon,
    SyncOutlined: Icon,
    TableOutlined: Icon,
    ThunderboltOutlined: Icon,
    UndoOutlined: Icon,
  };
};

// vi.mock('antd')
export const mockModule11 = () => {
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
    Checkbox: ({ children, checked, onChange }: any) => (
      <label>
        <input type="checkbox" checked={!!checked} onChange={(event) => onChange?.({ target: { checked: event.target.checked } })} />
        {children}
      </label>
    ),
    DatePicker: ({ value }: any) => <input data-mock="datepicker" value={value || ''} />,
    InputNumber: ({ value }: any) => <input data-mock="inputnumber" value={value ?? ''} />,
    Spin: () => <div className="mock-spin" />,
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

export const textContent = (node: any): string =>
  (node.children || [])
    .map((item: any) => (typeof item === 'string' ? item : textContent(item)))
    .join('');

export const findSqlLogTab = (renderer: ReactTestRenderer) => renderer.root.findAll(
  (node) => node.props?.['data-tab-key'] === '__gonavi_sql_execution_log__',
);

export const queryResultMessageText = (renderer: ReactTestRenderer): string => {
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

export const findButtons = (renderer: ReactTestRenderer, text: string) => {
  const ariaLabelMatches = renderer.root.findAll((node) => (
    node.type === 'button' && String(node.props?.['aria-label'] || '').includes(text)
  ));
  return ariaLabelMatches.length > 0
    ? ariaLabelMatches
    : renderer.root.findAll(
      (node) => node.type === 'button' && textContent(node).includes(text),
  );
};

export const findButton = (renderer: ReactTestRenderer, text: string) => findButtons(renderer, text)[0];

export const findExactButton = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll((node) => node.type === 'button' && textContent(node) === text)[0];

export const findEditorAction = (id: string) =>
  editorState.editor.addAction.mock.calls
    .map((call: any[]) => call[0])
    .reverse()
    .find((action: any) => action?.id === id);

export const findEditorActionLabels = (id: string) =>
  editorState.editor.addAction.mock.calls
    .map((call: any[]) => call[0])
    .filter((action: any) => action?.id === id)
    .map((action: any) => action.label);

export const findSqlCompletionProvider = () =>
  [...editorState.providers]
    .reverse()
    .find((provider: any) =>
      Array.isArray(provider?.triggerCharacters) && provider.triggerCharacters.includes('.'),
    );

export const createSqlCompletionModel = (line: string, word: string) => ({
  getWordUntilPosition: () => ({
    word,
    startColumn: 1,
    endColumn: word.length + 1,
  }),
  getValue: () => line,
  getLineContent: () => line,
});

export const getLastInjectedPrompt = (): string => {
  const dispatchCalls = (window.dispatchEvent as any).mock.calls;
  expect(dispatchCalls.length).toBeGreaterThan(0);
  const event = dispatchCalls[dispatchCalls.length - 1]?.[0];
  expect(event?.type).toBe('gonavi:ai:inject-prompt');
  return event?.detail?.prompt;
};

export const createTab = (overrides: Partial<TabData> = {}): TabData => ({
  id: 'tab-1',
  title: 'query.sql',
  type: 'query',
  connectionId: 'conn-1',
  dbName: 'main',
  query: 'select 1;',
  ...overrides,
});

export const createDefaultConnections = () => ([
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

export const createQueryEditorSplitNodeMock = (element: any) => {
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
