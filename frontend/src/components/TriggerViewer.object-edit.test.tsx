import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabData } from '../types';
import { I18nProvider } from '../i18n/provider';
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
  useStore: (selector: (state: typeof storeState) => any) => selector(storeState),
}));

vi.mock('../../wailsjs/go/app/App', () => backendApp);
vi.mock('../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('@ant-design/icons', () => ({
  EditOutlined: () => <span data-icon="edit" />,
}));

vi.mock('./MonacoEditor', () => ({
  default: ({ value, options }: any) => (
    <pre data-editor="true" data-readonly={String(options?.readOnly)}>
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

const renderWithI18n = (tab: TabData) => (
  <I18nProvider
    preference="en-US"
    systemLanguages={['en-US']}
    onPreferenceChange={() => undefined}
  >
    <TriggerViewer tab={tab} />
  </I18nProvider>
);

const findButtonText = (node: any): string => (
  (node.children || [])
    .map((item: any) => (typeof item === 'string' ? item : findButtonText(item)))
    .join('')
);

const tab: TabData = {
  id: 'trigger-conn-1-main-audit.users_bi',
  title: '触发器: audit.users_bi',
  type: 'trigger',
  connectionId: 'conn-1',
  dbName: 'main',
  triggerName: 'audit.users_bi',
  triggerTableName: 'audit.users',
  schemaName: 'audit',
};

describe('TriggerViewer object edit entry', () => {
  beforeEach(() => {
    storeState.addTab.mockReset();
    storeState.setActiveContext.mockReset();
    storeState.connections[0].config.type = 'postgres';
    backendApp.DBGetTriggers.mockReset();
    backendApp.DBGetTriggers.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQuery.mockReset();
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{ trigger_definition: 'CREATE TRIGGER users_bi BEFORE INSERT ON audit.users EXECUTE FUNCTION audit.audit_users();' }],
    });
  });

  it('opens an editable query tab for trigger definitions', async () => {
    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(tab));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      button.props.onClick();
    });

    expect(storeState.setActiveContext).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'audit',
    });
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Edit trigger: audit.users_bi',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'audit',
      queryMode: 'object-edit',
      query: expect.stringContaining('CREATE TRIGGER users_bi BEFORE INSERT'),
    }));
  });

  it('loads the complete Oracle trigger definition through metadata instead of the bounded query preview', async () => {
    storeState.connections[0].config.type = 'oracle';
    const fullDDL = `CREATE OR REPLACE TRIGGER "AUDIT"."USERS_BI"
BEFORE INSERT ON "AUDIT"."USERS"
FOR EACH ROW
BEGIN
${'  NULL;\n'.repeat(700)}  -- FULL_TRIGGER_DDL_TAIL
END;`;
    backendApp.DBGetTriggers.mockResolvedValue({
      success: true,
      data: [{ name: 'USERS_BI', timing: 'BEFORE EACH ROW', event: 'INSERT', statement: fullDDL }],
    });
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{ trigger_definition: `[CLOB preview: 4096/${fullDDL.length} bytes] ${fullDDL.slice(0, 4096)}` }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(tab));
      await flushPromises();
    });

    expect(backendApp.DBGetTriggers).toHaveBeenCalledWith(expect.anything(), 'main', 'audit.users');
    expect(backendApp.DBQuery).not.toHaveBeenCalled();
    const editorText = String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''));
    expect(editorText).toContain('FULL_TRIGGER_DDL_TAIL');
    expect(editorText).not.toContain('[CLOB preview:');

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];
    await act(async () => {
      await button.props.onClick();
      await flushPromises();
    });

    const query = String(storeState.addTab.mock.calls[0][0].query || '');
    expect(query).toContain('FULL_TRIGGER_DDL_TAIL');
    expect(query).not.toContain('[CLOB preview:');
    expect(query).not.toContain('Only a trigger definition fragment was returned');
    expect(query).not.toMatch(/\bDROP\s+TRIGGER\b/i);
  });

  it('resolves the table before loading Oracle metadata for a restored trigger tab', async () => {
    storeState.connections[0].config.type = 'oracle';
    const restoredTab: TabData = {
      ...tab,
      triggerTableName: undefined,
    };
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{ OWNER: 'AUDIT', TABLE_OWNER: 'AUDIT', TABLE_NAME: 'USERS', TRIGGER_NAME: 'USERS_BI' }],
    });
    backendApp.DBGetTriggers.mockResolvedValue({
      success: true,
      data: [{
        name: 'USERS_BI',
        statement: 'CREATE OR REPLACE TRIGGER "AUDIT"."USERS_BI" BEFORE INSERT ON "AUDIT"."USERS" BEGIN NULL; END;',
      }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(restoredTab));
      await flushPromises();
    });

    expect(backendApp.DBQuery).toHaveBeenCalledTimes(1);
    expect(String(backendApp.DBQuery.mock.calls[0][2])).toContain('FROM ALL_TRIGGERS');
    expect(String(backendApp.DBQuery.mock.calls[0][2])).not.toContain('DBMS_METADATA.GET_DDL');
    expect(String(backendApp.DBQuery.mock.calls[0][2])).not.toContain('TRIGGER_BODY');
    expect(backendApp.DBGetTriggers).toHaveBeenCalledWith(expect.anything(), 'main', 'AUDIT.USERS');
    const editorText = String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''));
    expect(editorText).toContain('CREATE OR REPLACE TRIGGER');
    expect(editorText).not.toContain('[CLOB preview:');
  });

  it('uses SQL Server catalog metadata when loading trigger definitions', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{ trigger_definition: 'CREATE TRIGGER [audit].[users_bi] ON [audit].[users] AFTER INSERT AS SELECT 1;' }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(tab));
      await flushPromises();
    });

    const sql = String(backendApp.DBQuery.mock.calls[0][2] || '');
    expect(sql).toContain('FROM [main].sys.all_sql_modules AS m');
    expect(sql).toContain("WHERE o.name = N'users_bi'");
    expect(sql).toContain("AND s.name = N'audit'");
    expect(sql).toContain("o.type IN ('TR', 'TA')");
    expect(sql).not.toContain('OBJECT_DEFINITION');
    expect(String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''))).toContain('CREATE TRIGGER [audit].[users_bi]');
  });

  it('adds CREATE OR REPLACE for trigger source snippets returned without ddl prefix', async () => {
    storeState.connections[0].config.type = 'oracle';
    backendApp.DBGetTriggers.mockResolvedValue({
      success: true,
      data: [{
        name: 'users_bi',
        statement: 'TRIGGER users_bi\nBEFORE INSERT ON audit.users\nFOR EACH ROW\nBEGIN\n  :NEW.created_at := SYSDATE;\nEND;',
      }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(tab));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      button.props.onClick();
    });

    const query = storeState.addTab.mock.calls[0][0].query;
    expect(query).toContain('CREATE OR REPLACE TRIGGER users_bi');
    expect(query).toContain('BEFORE INSERT ON audit.users');
    expect(query).toContain(':NEW.created_at := SYSDATE;');
    expect(query).not.toContain('请补全 CREATE TRIGGER 语句');
  });

  it('adds trigger name for trigger body snippets returned without ddl header', async () => {
    storeState.connections[0].config.type = 'oracle';
    backendApp.DBGetTriggers.mockResolvedValue({
      success: true,
      data: [{
        name: 'users_bi',
        statement: 'BEFORE UPDATE ON audit.users\nFOR EACH ROW\nBEGIN\n  :NEW.updated_at := SYSDATE;\nEND;',
      }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(tab));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      button.props.onClick();
    });

    const query = storeState.addTab.mock.calls[0][0].query;
    expect(query).toContain('CREATE OR REPLACE TRIGGER audit.users_bi');
    expect(query).toContain('BEFORE UPDATE ON audit.users');
    expect(query).toContain(':NEW.updated_at := SYSDATE;');
    expect(query).not.toContain('请补全 CREATE TRIGGER 语句');
  });

  it('rebuilds mysql trigger ddl from metadata rows when only action statement is available', async () => {
    storeState.connections[0].config.type = 'mysql';
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{
        TRIGGER_NAME: 'users_bi',
        TRIGGER_SCHEMA: 'main',
        EVENT_OBJECT_SCHEMA: 'audit',
        EVENT_OBJECT_TABLE: 'users',
        ACTION_TIMING: 'BEFORE',
        EVENT_MANIPULATION: 'INSERT',
        ACTION_ORIENTATION: 'ROW',
        ACTION_STATEMENT: 'SET NEW.created_at = NOW()',
      }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(tab));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      button.props.onClick();
    });

    const query = storeState.addTab.mock.calls[0][0].query;
    expect(query).toContain('CREATE TRIGGER `main`.`users_bi`');
    expect(query).toContain('BEFORE INSERT ON `audit`.`users`');
    expect(query).toContain('FOR EACH ROW');
    expect(query).toContain('SET NEW.created_at = NOW();');
    expect(query).not.toContain('请补全 CREATE TRIGGER 语句');
  });

  it('uses the rebuilt Oracle trigger DDL returned by the metadata API', async () => {
    storeState.connections[0].config.type = 'oracle';
    backendApp.DBGetTriggers.mockResolvedValue({
      success: true,
      data: [{
        name: 'USERS_BU',
        timing: 'BEFORE EACH ROW',
        event: 'UPDATE',
        statement: 'CREATE OR REPLACE TRIGGER AUDIT.USERS_BU\nBEFORE UPDATE ON AUDIT.USERS\nFOR EACH ROW\nWHEN (NEW.UPDATED_AT IS NULL)\nBEGIN\n  :NEW.UPDATED_AT := SYSDATE;\nEND;',
      }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n({
        ...tab,
        id: 'trigger-conn-1-main-audit.users_bu',
        title: 'Trigger: audit.users_bu',
        triggerName: 'audit.users_bu',
      }));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      button.props.onClick();
    });

    const query = storeState.addTab.mock.calls[0][0].query;
    expect(query).toContain('CREATE OR REPLACE TRIGGER AUDIT.USERS_BU');
    expect(query).toContain('BEFORE UPDATE ON AUDIT.USERS');
    expect(query).toContain('FOR EACH ROW');
    expect(query).toContain('WHEN (NEW.UPDATED_AT IS NULL)');
    expect(query).toContain(':NEW.UPDATED_AT := SYSDATE;');
  });

  it('reloads the latest trigger definition before opening object edit', async () => {
    backendApp.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [{ trigger_definition: 'CREATE TRIGGER users_bi BEFORE INSERT ON audit.users EXECUTE FUNCTION audit.audit_users();' }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ trigger_definition: 'CREATE TRIGGER users_bi BEFORE INSERT OR UPDATE ON audit.users EXECUTE FUNCTION audit.audit_users_v2();' }],
      });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(tab));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      await button.props.onClick();
      await flushPromises();
    });

    expect(backendApp.DBQuery).toHaveBeenCalledTimes(2);
    const query = storeState.addTab.mock.calls[0][0].query;
    expect(query).toContain('CREATE TRIGGER users_bi BEFORE INSERT OR UPDATE ON audit.users');
    expect(query).toContain('audit.audit_users_v2()');

    const editor = renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0];
    expect(String(editor.children.join(''))).toContain('CREATE TRIGGER users_bi BEFORE INSERT OR UPDATE ON audit.users');
  });

  it('keeps the current trigger definition visible when refresh for object edit fails', async () => {
    backendApp.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [{ trigger_definition: 'CREATE TRIGGER users_bi BEFORE INSERT ON audit.users EXECUTE FUNCTION audit.audit_users();' }],
      })
      .mockResolvedValueOnce({
        success: false,
        message: 'refresh failed',
        data: [],
      });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(tab));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      await button.props.onClick();
      await flushPromises();
    });

    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''))).toContain('CREATE TRIGGER users_bi BEFORE INSERT ON audit.users');
    expect(findButtonText(renderer.root)).toContain('Failed to refresh the latest definition');
    expect(findButtonText(renderer.root)).toContain('refresh failed');
  });

  it('does not keep the previous trigger definition when switching objects and the new load fails', async () => {
    backendApp.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [{ trigger_definition: 'CREATE TRIGGER users_bi BEFORE INSERT ON audit.users EXECUTE FUNCTION audit.audit_users();' }],
      })
      .mockResolvedValueOnce({
        success: false,
        message: 'load failed',
        data: [],
      });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(tab));
      await flushPromises();
    });

    await act(async () => {
      renderer.update(renderWithI18n({
        ...tab,
        id: 'trigger-conn-1-main-audit.users_bu',
        title: 'Trigger: audit.users_bu',
        triggerName: 'audit.users_bu',
      }));
      await flushPromises();
    });

    expect(findButtonText(renderer.root)).toContain('Load failed');
    expect(findButtonText(renderer.root)).toContain('load failed');
    expect(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')).toHaveLength(0);
    expect(findButtonText(renderer.root)).not.toContain('CREATE TRIGGER users_bi BEFORE INSERT');
  });
});
