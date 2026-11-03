import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabData } from '../types';
import { I18nProvider } from '../i18n/provider';
import DefinitionViewer from './DefinitionViewer';
import TriggerViewer from './TriggerViewer';

const storeState = vi.hoisted(() => ({
  connections: [
    {
      id: 'conn-1',
      name: 'local',
      config: {
        type: 'postgres',
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        password: '',
        database: 'main',
      },
    },
    {
      id: 'conn-mysql',
      name: 'mysql',
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
  theme: 'light',
  addTab: vi.fn(),
  setActiveContext: vi.fn(),
}));

const backendApp = vi.hoisted(() => ({
  DBGetTriggers: vi.fn(),
  DBQuery: vi.fn(),
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('../../wailsjs/go/app/App', () => backendApp);
vi.mock('../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('@ant-design/icons', () => ({
  EditOutlined: () => <span data-icon="edit" />,
}));

vi.mock('./MonacoEditor', () => ({
  default: ({ value, options, gonaviTypography, language }: any) => (
    <pre
      data-editor="true"
      data-language={String(language)}
      data-typography={String(gonaviTypography)}
      data-readonly={String(options?.readOnly)}
      data-sticky-scroll-enabled={String(options?.stickyScroll?.enabled)}
      data-font-size={String(options?.fontSize)}
      data-line-height={String(options?.lineHeight)}
      data-line-numbers-min-chars={String(options?.lineNumbersMinChars)}
    >
      {value}
    </pre>
  ),
}));

vi.mock('antd', () => ({
  Spin: ({ tip }: any) => <div>{tip}</div>,
  Alert: ({ message, description }: any) => <div>{message}{description}</div>,
  Button: ({ children, onClick, icon }: any) => (
    <button type="button" onClick={onClick}>
      {icon}
      {children}
    </button>
  ),
}));

const flushPromises = async (count = 6) => {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
};

const renderWithI18n = (node: React.ReactElement) => (
  <I18nProvider
    preference="en-US"
    systemLanguages={['en-US']}
    onPreferenceChange={() => undefined}
  >
    {node}
  </I18nProvider>
);

const routineTab: TabData = {
  id: 'routine-def-conn-1-main-reporting.refresh_stats',
  title: '函数: reporting.refresh_stats',
  type: 'routine-def',
  connectionId: 'conn-1',
  dbName: 'main',
  routineName: 'reporting.refresh_stats',
  routineType: 'FUNCTION',
  schemaName: 'reporting',
};

const triggerTab: TabData = {
  id: 'trigger-conn-1-main-audit.users_bi',
  title: '触发器: audit.users_bi',
  type: 'trigger',
  connectionId: 'conn-1',
  dbName: 'main',
  triggerName: 'audit.users_bi',
  triggerTableName: 'audit.users',
  schemaName: 'audit',
};

describe('Object definition viewers Monaco options', () => {
  beforeEach(() => {
    backendApp.DBQuery.mockReset();
    backendApp.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [{ routine_definition: 'CREATE OR REPLACE FUNCTION reporting.refresh_stats() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;' }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ trigger_definition: 'CREATE TRIGGER users_bi BEFORE INSERT ON audit.users EXECUTE FUNCTION audit.audit_users();' }],
      });
  });

  it('disables sticky scroll for read-only routine definitions', async () => {
    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(<DefinitionViewer tab={routineTab} />));
      await flushPromises();
    });

    const editor = renderer.root.findByProps({ 'data-editor': 'true' });
    expect(editor.props['data-typography']).toBe('sql');
    expect(editor.props['data-language']).toBe('sql');
    expect(editor.props['data-sticky-scroll-enabled']).toBe('false');
    expect(editor.props['data-font-size']).toBe('undefined');
    expect(editor.props['data-line-height']).toBe('undefined');
    expect(editor.props['data-line-numbers-min-chars']).toBe('4');
  });

  it('disables sticky scroll for read-only trigger definitions', async () => {
    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(<TriggerViewer tab={triggerTab} />));
      await flushPromises();
    });

    const editor = renderer.root.findByProps({ 'data-editor': 'true' });
    expect(editor.props['data-typography']).toBe('sql');
    expect(editor.props['data-language']).toBe('sql');
    expect(editor.props['data-sticky-scroll-enabled']).toBe('false');
    expect(editor.props['data-font-size']).toBe('undefined');
  });

  // MySQL 系连接的编辑器用 mysql 分词器；查看器必须跟着走，否则关键字配色不一致。
  it('uses the same keyword tokenizer as the editor for mysql-family connections', async () => {
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{ routine_definition: 'CREATE PROCEDURE p() BEGIN END;', trigger_definition: 'CREATE TRIGGER t BEFORE INSERT ON audit.users FOR EACH ROW BEGIN END;' }],
    });

    let routineRenderer: any;
    await act(async () => {
      routineRenderer = create(
        renderWithI18n(<DefinitionViewer tab={{ ...routineTab, connectionId: 'conn-mysql' }} />),
      );
      await flushPromises();
    });
    expect(routineRenderer.root.findByProps({ 'data-editor': 'true' }).props['data-language']).toBe('mysql');

    let triggerRenderer: any;
    await act(async () => {
      triggerRenderer = create(
        renderWithI18n(<TriggerViewer tab={{ ...triggerTab, connectionId: 'conn-mysql' }} />),
      );
      await flushPromises();
    });
    expect(triggerRenderer.root.findByProps({ 'data-editor': 'true' }).props['data-language']).toBe('mysql');
  });
});
