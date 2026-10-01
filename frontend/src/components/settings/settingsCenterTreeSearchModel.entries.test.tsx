import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsCenterTreeGroup } from './SettingsCenterTreeNav';
import type { SettingsCenterSearchEntrySource } from './settingsCenterSearchEntries';

const focusRequests = vi.hoisted(() => ({ requestSettingsCenterEntryFocus: vi.fn() }));
vi.mock('./settingsCenterEntryFocus', () => focusRequests);

import { filterSettingsCenterTreeGroups } from './settingsCenterTreeSearchModel';

const TEXTS: Record<string, string> = {
  'proxy.host': '代理地址',
  'proxy.host_hint': '例如 127.0.0.1',
  'proxy.type': '代理类型',
  'proxy.type_socks5': 'SOCKS5',
  'theme.font_size': '基础字体大小',
  'ai.mcp.addr': '监听地址 / 端口',
};
const translate = (key: string) => TEXTS[key] ?? key;

const proxyOnClick = vi.fn();
const groups: SettingsCenterTreeGroup[] = [
  {
    key: 'preferences',
    title: '偏好设置',
    description: '语言与外观',
    items: [
      {
        key: 'theme',
        title: '主题与外观',
        description: '主题设置',
        onClick: vi.fn(),
        children: [{ key: 'theme-appearance', title: '显示与字体', description: '缩放', onClick: vi.fn() }],
      },
    ],
  },
  {
    key: 'services',
    title: '服务配置',
    description: '代理与下载',
    items: [
      { key: 'proxy', title: '全局代理', description: '网络', onClick: proxyOnClick },
      {
        key: 'ai',
        title: 'AI 设置',
        description: 'AI',
        onClick: vi.fn(),
        children: [{ key: 'ai-mcp', title: 'MCP 服务', description: 'MCP', onClick: vi.fn() }],
      },
    ],
  },
];

const entries: SettingsCenterSearchEntrySource[] = [
  { group: 'services', item: 'proxy', labelKey: 'proxy.host', descriptionKey: 'proxy.host_hint' },
  { group: 'services', item: 'proxy', labelKey: 'proxy.type', aliasKeys: ['proxy.type_socks5'] },
  { group: 'preferences', item: 'theme-appearance', labelKey: 'theme.font_size' },
  { group: 'services', item: 'ai-mcp', labelKey: 'ai.mcp.addr' },
  { group: 'services', item: 'gone', labelKey: 'proxy.host' },
  { group: 'services', item: 'proxy', labelKey: 'unresolved.key' },
];

const search = (query: string) => filterSettingsCenterTreeGroups(groups, query, { entries, translate });

const tree = (filtered: ReadonlyArray<SettingsCenterTreeGroup>) => filtered.map((group) => ({
  key: group.key,
  items: group.items.map((item) => ({
    key: item.key,
    children: item.children?.map((child) => child.key),
  })),
}));

describe('settings center tree search with in-page settings', () => {
  beforeEach(() => {
    focusRequests.requestSettingsCenterEntryFocus.mockClear();
    proxyOnClick.mockClear();
  });

  it('finds a setting by its label and shows it under the page that owns it', () => {
    expect(tree(search('代理地址'))).toEqual([
      { key: 'services', items: [{ key: 'proxy', children: ['entry:proxy:proxy.host'] }] },
    ]);
  });

  it('reaches settings nested under a child page', () => {
    expect(tree(search('字体大小'))).toEqual([
      { key: 'preferences', items: [{ key: 'theme', children: [{ key: 'theme-appearance', children: ['entry:theme-appearance:theme.font_size'] }].map((child) => child.key) }] },
    ]);
  });

  it('matches descriptions and aliases as well as labels', () => {
    expect(tree(search('127.0.0.1'))[0].items[0].children).toEqual(['entry:proxy:proxy.host']);
    expect(tree(search('socks5'))[0].items[0].children).toEqual(['entry:proxy:proxy.type']);
  });

  it('shows matching settings under a page that itself matches', () => {
    const [services] = search('代理');
    const proxy = services.items.find((item) => item.key === 'proxy');

    expect(proxy?.children?.map((child) => child.key)).toEqual([
      'entry:proxy:proxy.host',
      'entry:proxy:proxy.type',
    ]);
  });

  it('marks hits as entries, titled by the setting and described by its page', () => {
    const [services] = search('代理地址');
    const [hit] = services.items[0].children ?? [];

    expect(hit).toMatchObject({ kind: 'entry', title: '代理地址', description: '全局代理' });
  });

  it('opens the owning page then asks the page to reveal the setting', () => {
    const [services] = search('代理地址');

    services.items[0].children?.[0].onClick();

    expect(proxyOnClick).toHaveBeenCalledTimes(1);
    expect(focusRequests.requestSettingsCenterEntryFocus).toHaveBeenCalledWith({ text: '代理地址' });
    expect(proxyOnClick.mock.invocationCallOrder[0])
      .toBeLessThan(focusRequests.requestSettingsCenterEntryFocus.mock.invocationCallOrder[0]);
  });

  it('ignores entries for pages that are not in the tree and keys that do not resolve', () => {
    expect(search('unresolved.key')).toEqual([]);
    expect(tree(search('代理地址'))[0].items).toHaveLength(1);
  });

  it('is unchanged when no entries are given', () => {
    expect(tree(filterSettingsCenterTreeGroups(groups, '代理地址', { translate }))).toEqual([]);
  });
});
