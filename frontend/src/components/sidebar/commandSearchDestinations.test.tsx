import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCurrentLanguage, setCurrentLanguage, t } from '../../i18n';
import type { SavedQuery, TabData } from '../../types';

const focusRequests = vi.hoisted(() => ({ requestSettingsCenterEntryFocus: vi.fn() }));
vi.mock('../settings/settingsCenterEntryFocus', () => focusRequests);

import {
  COMMAND_SEARCH_MAX_SAVED_QUERY_RESULTS,
  COMMAND_SEARCH_MAX_TAB_RESULTS,
  buildCommandSearchDestinationSections,
  type CommandSearchDestinationsArgs,
} from './commandSearchDestinations';

const connections = [
  { id: 'conn-a', name: '生产 MySQL' },
  { id: 'conn-b', name: '测试 PostgreSQL' },
];

const makeArgs = (overrides: Partial<CommandSearchDestinationsArgs> = {}): CommandSearchDestinationsArgs => ({
  normalizedKeyword: '',
  translate: (key) => t(key),
  isWebRuntime: false,
  connections,
  tabs: [],
  savedQueries: [],
  openSettingsNavigation: vi.fn(),
  activateTab: vi.fn(),
  openSavedQuery: vi.fn(),
  ...overrides,
});

const titles = (items: ReadonlyArray<{ title: string }>) => items.map((item) => item.title);

describe('command search destinations', () => {
  const previousLanguage = getCurrentLanguage();

  beforeEach(() => {
    // The ranking test types Chinese keywords, so pin the language.
    setCurrentLanguage('zh-CN');
    focusRequests.requestSettingsCenterEntryFocus.mockClear();
  });

  afterEach(() => {
    setCurrentLanguage(previousLanguage);
  });

  it('shows nothing for an empty keyword so the default view stays short', () => {
    const sections = buildCommandSearchDestinationSections(makeArgs({
      tabs: [{ id: 't1', title: '查询 1', type: 'query', connectionId: 'conn-a' } as TabData],
    }));

    expect(sections).toEqual({ settings: [], tabs: [], savedQueries: [] });
  });

  describe('settings', () => {
    it('finds a settings page by its title and opens it', () => {
      const openSettingsNavigation = vi.fn();
      const { settings } = buildCommandSearchDestinationSections(makeArgs({
        normalizedKeyword: t('app.settings.entry.proxy.title').toLowerCase(),
        openSettingsNavigation,
      }));

      const page = settings.find((item) => item.key === 'settings-menu:services/proxy');
      expect(page?.title).toBe(t('app.settings.entry.proxy.title'));
      expect(page?.meta).toContain(t('app.settings.group.services.title'));
      expect(page?.kind).toBe('action');

      if (page?.kind === 'action') page.onRun();
      expect(openSettingsNavigation).toHaveBeenCalledWith({ group: 'services', pane: 'proxy' });
    });

    it('finds a setting inside a page, opens the page and asks it to reveal the setting', () => {
      const openSettingsNavigation = vi.fn();
      const label = t('app.proxy.host');
      const { settings } = buildCommandSearchDestinationSections(makeArgs({
        normalizedKeyword: label.toLowerCase(),
        openSettingsNavigation,
      }));

      const hit = settings.find((item) => item.title === label);
      expect(hit?.meta).toContain(t('app.settings.entry.proxy.title'));

      if (hit?.kind === 'action') hit.onRun();
      expect(openSettingsNavigation).toHaveBeenCalledWith({ group: 'services', pane: 'proxy' });
      expect(focusRequests.requestSettingsCenterEntryFocus).toHaveBeenCalledWith({ text: label });
    });

    it('opens the right child page for theme sections and AI sections', () => {
      const openSettingsNavigation = vi.fn();
      const run = (keyword: string, key: string) => {
        const { settings } = buildCommandSearchDestinationSections(makeArgs({
          normalizedKeyword: keyword.toLowerCase(),
          openSettingsNavigation,
        }));
        const item = settings.find((candidate) => candidate.key === key);
        if (item?.kind === 'action') item.onRun();
      };

      run(t('app.theme.nav.appearance.title'), 'settings-menu:preferences/theme-appearance');
      run(t('ai_settings.nav.mcp.title'), 'settings-menu:services/ai-mcp');

      expect(openSettingsNavigation).toHaveBeenNthCalledWith(1, { group: 'preferences', pane: 'theme', section: 'appearance' });
      expect(openSettingsNavigation).toHaveBeenNthCalledWith(2, { group: 'services', pane: 'ai', section: 'mcp' });
    });

    it('opens workbench-style pages through their action', () => {
      const openSettingsNavigation = vi.fn();
      const { settings } = buildCommandSearchDestinationSections(makeArgs({
        normalizedKeyword: t('app.tools.entry.request_diagnostics.title').toLowerCase(),
        openSettingsNavigation,
      }));

      const item = settings.find((candidate) => candidate.key === 'settings-menu:workspace/request-diagnostics');
      if (item?.kind === 'action') item.onRun();

      expect(openSettingsNavigation).toHaveBeenCalledWith({ group: 'workspace', action: 'request-diagnostics' });
    });

    it('finds shortcut rows generated from the shortcut definitions', () => {
      const { settings } = buildCommandSearchDestinationSections(makeArgs({
        normalizedKeyword: t('app.shortcuts.action.runQuery.label').toLowerCase(),
      }));

      expect(settings.some((item) => item.key === 'settings-entry:shortcut-settings:runQuery')).toBe(true);
    });

    it('hides web-only pages outside the browser build', () => {
      const keyword = t('app.settings.entry.web_auth.title').toLowerCase();

      const desktop = buildCommandSearchDestinationSections(makeArgs({ normalizedKeyword: keyword }));
      const web = buildCommandSearchDestinationSections(makeArgs({ normalizedKeyword: keyword, isWebRuntime: true }));

      expect(desktop.settings.some((item) => item.key.includes('web-auth'))).toBe(false);
      expect(web.settings.some((item) => item.key === 'settings-menu:services/web-auth')).toBe(true);
    });

    it('lists no settings when the host cannot open the settings center', () => {
      const { settings } = buildCommandSearchDestinationSections(makeArgs({
        normalizedKeyword: '代理',
        openSettingsNavigation: undefined,
      }));

      expect(settings).toEqual([]);
    });

    it('puts titles that start with the keyword before looser matches', () => {
      const { settings } = buildCommandSearchDestinationSections(makeArgs({ normalizedKeyword: '代理' }));

      const firstOther = settings.findIndex((item) => !item.title.toLowerCase().startsWith('代理'));
      const lastStarting = settings.map((item) => item.title.toLowerCase().startsWith('代理')).lastIndexOf(true);
      expect(settings.length).toBeGreaterThan(1);
      expect(firstOther === -1 || lastStarting < firstOther).toBe(true);
    });
  });

  describe('open tabs', () => {
    const tabs = [
      { id: 't1', title: '订单统计', type: 'query', connectionId: 'conn-a', dbName: 'shop' },
      { id: 't2', title: 'users', type: 'table', connectionId: 'conn-b', dbName: 'app', tableName: 'users' },
    ] as TabData[];

    it('matches the title, the connection name and the database', () => {
      const byTitle = buildCommandSearchDestinationSections(makeArgs({ normalizedKeyword: '订单', tabs }));
      const byConnection = buildCommandSearchDestinationSections(makeArgs({ normalizedKeyword: 'postgresql', tabs }));
      const byDatabase = buildCommandSearchDestinationSections(makeArgs({ normalizedKeyword: 'shop', tabs }));

      expect(titles(byTitle.tabs)).toEqual(['订单统计']);
      expect(titles(byConnection.tabs)).toEqual(['users']);
      expect(titles(byDatabase.tabs)).toEqual(['订单统计']);
      expect(byTitle.tabs[0].meta).toBe('生产 MySQL · shop');
    });

    it('activates the tab when run and caps the result count', () => {
      const activateTab = vi.fn();
      const many = Array.from({ length: 20 }, (_, index) => ({
        id: `m${index}`, title: `报表 ${index}`, type: 'query', connectionId: 'conn-a',
      })) as TabData[];

      const { tabs: found } = buildCommandSearchDestinationSections(makeArgs({
        normalizedKeyword: '报表', tabs: many, activateTab,
      }));
      if (found[0].kind === 'action') found[0].onRun();

      expect(found).toHaveLength(COMMAND_SEARCH_MAX_TAB_RESULTS);
      expect(activateTab).toHaveBeenCalledWith('m0');
    });
  });

  describe('saved queries', () => {
    const savedQueries = [
      { id: 'q1', name: '月度汇总', sql: 'SELECT month, SUM(amount) FROM orders GROUP BY month', connectionId: 'conn-a', dbName: 'shop', createdAt: 1 },
      { id: 'q2', name: '', sql: 'SELECT * FROM users WHERE id = 1', connectionId: 'conn-b', dbName: 'app', createdAt: 2 },
    ] as SavedQuery[];

    it('matches the name and also the SQL text', () => {
      const byName = buildCommandSearchDestinationSections(makeArgs({ normalizedKeyword: '汇总', savedQueries }));
      const bySql = buildCommandSearchDestinationSections(makeArgs({ normalizedKeyword: 'group by', savedQueries }));

      expect(titles(byName.savedQueries)).toEqual(['月度汇总']);
      expect(titles(bySql.savedQueries)).toEqual(['月度汇总']);
    });

    it('describes each hit by its connection, database and a SQL preview', () => {
      const { savedQueries: found } = buildCommandSearchDestinationSections(makeArgs({
        normalizedKeyword: '汇总', savedQueries,
      }));

      expect(found[0].meta).toBe('生产 MySQL · shop — SELECT month, SUM(amount) FROM orders GROUP BY month');
    });

    it('truncates long SQL in the preview and names unnamed queries', () => {
      const long = { ...savedQueries[1], sql: `SELECT ${'x, '.repeat(60)}y FROM users` } as SavedQuery;

      const { savedQueries: found } = buildCommandSearchDestinationSections(makeArgs({
        normalizedKeyword: 'users', savedQueries: [long],
      }));

      expect(found[0].title).toBe(t('query_editor.save_modal.unnamed'));
      expect(found[0].meta.endsWith('…')).toBe(true);
    });

    it('opens the saved query when run and caps the result count', () => {
      const openSavedQuery = vi.fn();
      const many = Array.from({ length: 40 }, (_, index) => ({
        ...savedQueries[0], id: `bulk-${index}`, name: `汇总 ${index}`,
      })) as SavedQuery[];

      const { savedQueries: found } = buildCommandSearchDestinationSections(makeArgs({
        normalizedKeyword: '汇总', savedQueries: many, openSavedQuery,
      }));
      if (found[0].kind === 'action') found[0].onRun();

      expect(found).toHaveLength(COMMAND_SEARCH_MAX_SAVED_QUERY_RESULTS);
      expect(openSavedQuery).toHaveBeenCalledWith(many[0]);
    });
  });
});
