import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentLanguage } from '../i18n';
import { formatSqlExecutionError } from '../utils/sqlErrorSemantics';
import QueryEditor from './QueryEditor';
import {
    create,
    storeState,
    notifyStoreSubscribers,
    backendApp,
    autoFetchState,
    editorState,
    textContent,
    findButton,
    findExactButton,
    findSqlCompletionProvider,
    createSqlCompletionModel,
    getLastInjectedPrompt,
    createTab,
    createDefaultConnections,
} from './queryEditorExternalSqlSaveTestSupport';
import { setUpQueryEditorExternalSqlSaveTest, tearDownQueryEditorExternalSqlSaveTest } from './queryEditorExternalSqlSaveTestHooks';

vi.mock('../store', async (importOriginal) => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule1(importOriginal));

vi.mock('../../wailsjs/runtime', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule2());

vi.mock('../../wailsjs/go/app/App', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule3());

vi.mock('../utils/autoFetchVisibility', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule4());

vi.mock('@monaco-editor/react', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule5());

vi.mock('./DataGrid', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule6());

vi.mock('./resultDiff/ResultDiffWizard', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule7());

vi.mock('./resultDiff/ViewDataVerifyWizard', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule8());

vi.mock('./LogPanel', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule9());

vi.mock('@ant-design/icons', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule10());

vi.mock('antd', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule11());

describe('QueryEditor external SQL save', () => {
  beforeEach(setUpQueryEditorExternalSqlSaveTest);

  afterEach(tearDownQueryEditorExternalSqlSaveTest);

  it('uses localized toolbar AI prompts and execution-error diagnose prompt', async () => {
    vi.useFakeTimers();
    try {
      storeState.aiPanelVisible = true;


      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({
          dbName: 'main',
          query: 'select * from first_table\n\nselect * from broken_table where id = ;',
        })} />);
      });

      await act(async () => {
        storeState.languagePreference = 'en-US';
        setCurrentLanguage('en-US');
        notifyStoreSubscribers();
      });

      await act(async () => {
        findExactButton(renderer, 'Schema analysis').props.onClick();
        await Promise.resolve();
      });
      expect(getLastInjectedPrompt()).toBe(
        'Context: mysql "local", selected database "main", database version unknown.\nAnalyze the current database schema and suggest performance and design improvements.',
      );
      expect(getLastInjectedPrompt()).not.toContain('请针对当前数据库的表结构进行系统分析');

      backendApp.DBGetServerVersion.mockResolvedValue({ success: true, message: '5.7.44-log' });
      backendApp.DBQueryMulti.mockResolvedValueOnce({
        success: false,
        message: 'You have an error in your SQL syntax at line 1',
        data: [],
      });
      editorState.selection = {
        startLineNumber: 3,
        startColumn: 1,
        endLineNumber: 3,
        endColumn: 'select * from broken_table where id = ;'.length + 1,
        positionLineNumber: 3,
        positionColumn: 'select * from broken_table where id = ;'.length + 1,
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
      editorState.value = 'select changed;';
      editorState.selection = null;

      await act(async () => {
        findButton(renderer, 'AI diagnose').props.onClick();
        await Promise.resolve();
        vi.runAllTimers();
      });

      const diagnoseError = formatSqlExecutionError('You have an error in your SQL syntax at line 1');
      // 诊断提示词首行是「库名 · 错误首行」标题（截断到 80 字符），用作 AI 会话标题。
      const diagnoseHeadline = ['main', diagnoseError.split('\n')[0].trim()].join(' · ').slice(0, 80);
      expect(getLastInjectedPrompt()).toBe(
        `${diagnoseHeadline}\nContext: mysql "local", selected database "main", database version 5.7.44-log.\nI got an error while executing this SQL:\n\`\`\`sql\nselect * from broken_table where id = ;\n\`\`\`\n\nThe database returned this error:\n\`\`\`text\n${diagnoseError}\n\`\`\`\n\nAnalyze the cause and suggest a fix.`,
      );
      expect(getLastInjectedPrompt()).not.toContain('first_table');
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

      const hoverProvider = editorState.hoverProviders[0];
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

      const hoverProvider = editorState.hoverProviders[0];
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

      const hoverProvider = editorState.hoverProviders[0];
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

      const hoverProvider = editorState.hoverProviders[0];
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

      const hoverProvider = editorState.hoverProviders[0];
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

      const hoverProvider = editorState.hoverProviders[0];
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

      const hoverProvider = editorState.hoverProviders[0];
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

      const hoverProvider = editorState.hoverProviders[0];
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

      const hoverProvider = editorState.hoverProviders[0];
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
    const hover = editorState.hoverProviders[0].provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: 18 },
    );
    const hoverText = String(hover?.contents?.[0]?.value || '');
    expect(hoverText.match(/\*\*表\*\*/g)).toHaveLength(1);
    expect(hoverText).toContain('`H2.S_BUSI`');

    firstRenderer!.unmount();
    secondRenderer!.unmount();
  });
});
