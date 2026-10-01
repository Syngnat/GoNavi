/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../TableDesignerSqlPreview', () => ({
  default: ({ sql }: { sql: string }) => <pre data-testid="sql-preview">{sql}</pre>,
}));

import { I18nProvider } from '../../i18n/provider';
import { useStore } from '../../store';
import type { SavedConnection, TabData } from '../../types';
import UserManagementWorkbench from './UserManagementWorkbench';
import type { UserManagementBackend } from './userManagementRpc';

const connection = {
  id: 'conn-mysql',
  name: 'Local MySQL',
  config: { id: 'conn-mysql', type: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '' },
} as unknown as SavedConnection;

const sqliteConnection = {
  id: 'conn-sqlite',
  name: 'Embedded',
  config: { id: 'conn-sqlite', type: 'sqlite', host: '', port: 0, user: '' },
} as unknown as SavedConnection;

const profile = (overrides: Record<string, unknown> = {}) => ({
  supported: true,
  readOnly: false,
  family: 'mysql',
  flavor: 'mysql',
  versionText: '8.0.36',
  currentUser: 'root@%',
  features: { roles: true },
  kinds: [
    { kind: 'user', creatable: true, identityFields: ['name', 'host'], renamable: true, supportsPassword: true },
    { kind: 'role', creatable: true, identityFields: ['name', 'host'], renamable: true, supportsPassword: false },
  ],
  editorTabs: ['general', 'advanced', 'server-privileges', 'membership', 'preview'],
  options: [
    { id: 'accountLocked', type: 'bool', tab: 'general', kinds: ['user'] },
    { id: 'maxUserConnections', type: 'int', tab: 'advanced', kinds: ['user'] },
  ],
  privileges: [{ name: 'SELECT', scopes: ['global', 'database'] }, { name: 'PROCESS', scopes: ['global'] }],
  objectScopes: ['database'],
  passwordPolicy: { minLength: 8 },
  permissions: {},
  notices: [{ code: 'mysql_db_wildcard', level: 'info', text: 'Wildcards notice' }],
  ...overrides,
});

const principals = [
  { ref: { kind: 'user', name: 'root', host: '%' }, current: true, superuser: true, tags: [] },
  { ref: { kind: 'user', name: 'app', host: '%' }, tags: [] },
  { ref: { kind: 'user', name: 'mysql.sys', host: 'localhost' }, system: true, tags: [] },
];

const createBackend = (profileOverrides: Record<string, unknown> = {}) => {
  const backend = {
    UserMgmtOverview: vi.fn(async () => ({ success: true, data: { profile: profile(profileOverrides), principals } })),
    UserMgmtDescribePrincipal: vi.fn(async () => ({
      success: true,
      data: {
        principal: { ref: { kind: 'user', name: 'app', host: '%' }, tags: [] },
        options: { accountLocked: 'false', maxUserConnections: '0' },
        grants: [{ privilege: 'SELECT', scope: 'global' }],
        memberOf: [],
      },
    })),
    UserMgmtPreview: vi.fn(async (_config: unknown, _request: unknown) => ({
      success: true,
      data: { statements: [{ display: 'ALTER USER `app`@`%` ACCOUNT LOCK', risk: 'high' }], transactional: false, fingerprint: 'fp-1' },
    })),
    UserMgmtApply: vi.fn(async () => ({ success: true, message: 'Applied 1 statement(s)', data: { results: [], executedCount: 1, failedIndex: 0 } })),
  } satisfies UserManagementBackend;
  return backend;
};

const flush = async (ms = 0) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

describe('UserManagementWorkbench', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (window as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    (window as any).matchMedia = (window as any).matchMedia || (() => ({
      matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    }));
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    useStore.setState({ connections: [connection, sqliteConnection] } as any);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useStore.setState({ connections: [] } as any);
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = async (tab: TabData, backend: UserManagementBackend) => {
    await act(async () => {
      root.render(
        <I18nProvider preference="en-US" systemLanguages={['en-US']} onPreferenceChange={vi.fn()}>
          <UserManagementWorkbench tab={tab} backend={backend} />
        </I18nProvider>,
      );
    });
    await flush();
  };

  const tab = { id: 'user-management:conn-mysql', title: 'User management', type: 'user-management', connectionId: 'conn-mysql' } as TabData;

  it('lists principals with the server profile and hides system accounts by default', async () => {
    const backend = createBackend();
    await render(tab, backend);
    expect(backend.UserMgmtOverview).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('8.0.36');
    expect(container.textContent).toContain('root@%');
    expect(container.textContent).toContain('app@%');
    expect(container.textContent).not.toContain('mysql.sys@localhost');
    expect(container.textContent).toContain('Wildcards notice');

    const toggle = Array.from(container.querySelectorAll('label')).find((label) => label.textContent?.includes('Show system accounts'));
    await act(async () => { toggle?.querySelector('input')?.click(); });
    expect(container.textContent).toContain('mysql.sys@localhost');
  });

  it('loads details, previews option changes without any password and applies with the fingerprint', async () => {
    const backend = createBackend();
    await render(tab, backend);
    const item = Array.from(container.querySelectorAll('[role="option"]')).find((node) => node.textContent?.includes('app@%'));
    await act(async () => { (item as HTMLElement).click(); });
    await flush();
    expect(backend.UserMgmtDescribePrincipal).toHaveBeenCalledWith(expect.anything(), { ref: { kind: 'user', name: 'app', host: '%' }, database: undefined });

    const lockSwitch = container.querySelector('[data-option-id="accountLocked"] button[role="switch"]') as HTMLButtonElement;
    await act(async () => { lockSwitch.click(); });
    await flush(500);
    expect(backend.UserMgmtPreview).toHaveBeenCalled();
    const previewCalls = backend.UserMgmtPreview.mock.calls;
    const previewRequest = previewCalls[previewCalls.length - 1]?.[1] as Record<string, unknown>;
    expect(previewRequest).toMatchObject({ action: 'alter', target: { name: 'app', host: '%' }, options: { accountLocked: 'true' } });
    expect(JSON.stringify(previewRequest)).not.toContain('"password":"');
    expect(container.textContent).toContain('1 unsaved change(s)');

    const applyButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Review and apply')) as HTMLButtonElement;
    await act(async () => { applyButton.click(); });
    await flush();
    const execute = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Apply') as HTMLButtonElement;
    await act(async () => { execute.click(); });
    await flush();
    expect(backend.UserMgmtApply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'alter' }), 'fp-1');
    expect(document.body.textContent).toContain('Applied 1 statement(s)');
  });

  it('disables writes for a read-only profile', async () => {
    const backend = createBackend({ readOnly: true });
    await render(tab, backend);
    const newButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('New')) as HTMLButtonElement;
    expect(newButton.disabled).toBe(true);
    expect(container.textContent).toContain('View only');
  });

  it('shows the connection picker for the unbound tab and disables unsupported sources', async () => {
    await render({ ...tab, id: 'user-management:picker', connectionId: '' }, createBackend());
    const items = Array.from(container.querySelectorAll('[role="listitem"]')) as HTMLButtonElement[];
    const sqlite = items.find((item) => item.textContent?.includes('Embedded'));
    const mysql = items.find((item) => item.textContent?.includes('Local MySQL'));
    expect(mysql?.disabled).toBe(false);
    expect(sqlite?.disabled).toBe(true);
  });
});
