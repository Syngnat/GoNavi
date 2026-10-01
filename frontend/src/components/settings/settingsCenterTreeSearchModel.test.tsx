import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { SettingsCenterTreeGroup } from './SettingsCenterTreeNav';
import {
  filterSettingsCenterTreeGroups,
  normalizeSettingsCenterSearchQuery,
  renderSettingsCenterTreeLabel,
} from './settingsCenterTreeSearchModel';

const groups: SettingsCenterTreeGroup[] = [
  {
    key: 'preferences',
    title: '偏好设置',
    description: '语言与外观',
    items: [
      { key: 'language', title: '语言', description: '界面语言', onClick: vi.fn() },
      {
        key: 'theme',
        title: '主题与外观',
        description: '主题设置',
        onClick: vi.fn(),
        children: [
          { key: 'theme-theme', title: '主题与界面', description: '亮暗模式', onClick: vi.fn() },
          { key: 'theme-appearance', title: '显示与字体', description: '缩放字体', onClick: vi.fn() },
        ],
      },
    ],
  },
  {
    key: 'services',
    title: '服务配置',
    description: '代理与下载',
    items: [
      { key: 'proxy', title: '全局代理', description: '网络代理', onClick: vi.fn() },
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

const ids = (filtered: ReadonlyArray<SettingsCenterTreeGroup>) => filtered.map((group) => ({
  key: group.key,
  items: group.items.map((item) => ({
    key: item.key,
    children: item.children?.map((child) => child.key),
  })),
}));

describe('settingsCenterTreeSearchModel', () => {
  it('normalizes queries case-insensitively and trims whitespace', () => {
    expect(normalizeSettingsCenterSearchQuery('  MCP ')).toBe('mcp');
    expect(normalizeSettingsCenterSearchQuery('   ')).toBe('');
  });

  it('returns the original groups for an empty query', () => {
    expect(filterSettingsCenterTreeGroups(groups, '')).toBe(groups);
    expect(filterSettingsCenterTreeGroups(groups, '   ')).toBe(groups);
  });

  it('keeps only branches that lead to a match and preserves keys', () => {
    expect(ids(filterSettingsCenterTreeGroups(groups, '字体'))).toEqual([
      { key: 'preferences', items: [{ key: 'theme', children: ['theme-appearance'] }] },
    ]);
    expect(ids(filterSettingsCenterTreeGroups(groups, 'mcp'))).toEqual([
      { key: 'services', items: [{ key: 'ai', children: ['ai-mcp'] }] },
    ]);
  });

  it('keeps the whole subtree when the node itself matches', () => {
    expect(ids(filterSettingsCenterTreeGroups(groups, '主题与外观'))).toEqual([
      { key: 'preferences', items: [{ key: 'theme', children: ['theme-theme', 'theme-appearance'] }] },
    ]);
    expect(ids(filterSettingsCenterTreeGroups(groups, '服务配置'))).toEqual([
      { key: 'services', items: [{ key: 'proxy', children: undefined }, { key: 'ai', children: ['ai-mcp'] }] },
    ]);
  });

  it('matches descriptions too and returns nothing when nothing matches', () => {
    expect(ids(filterSettingsCenterTreeGroups(groups, '网络'))).toEqual([
      { key: 'services', items: [{ key: 'proxy', children: undefined }] },
    ]);
    expect(filterSettingsCenterTreeGroups(groups, 'nothing-here')).toEqual([]);
  });

  it('keeps click handlers on filtered copies', () => {
    const [services] = filterSettingsCenterTreeGroups(groups, 'mcp');
    expect(services.items[0].children?.[0].onClick).toBe(groups[1].items[1].children?.[0].onClick);
  });

  it('highlights the first hit inside the label', () => {
    expect(renderToStaticMarkup(<>{renderSettingsCenterTreeLabel('MCP 服务', 'mcp')}</>)).toBe(
      '<mark class="gonavi-settings-center-tree-highlight">MCP</mark> 服务',
    );
    expect(renderToStaticMarkup(<>{renderSettingsCenterTreeLabel('显示与字体', '字体')}</>)).toBe(
      '显示与<mark class="gonavi-settings-center-tree-highlight">字体</mark>',
    );
    expect(renderSettingsCenterTreeLabel('语言', '')).toBe('语言');
    // A hit deep inside long page copy keeps a short lead-in so truncation cannot hide it.
    expect(renderToStaticMarkup(<>{renderSettingsCenterTreeLabel('部分编辑器和系统级菜单可能需要重新打开窗口后完全生效。', '重新打开窗口')}</>)).toBe(
      '…统级菜单可能需要<mark class="gonavi-settings-center-tree-highlight">重新打开窗口</mark>后完全生效。',
    );
    expect(renderSettingsCenterTreeLabel('语言', '字体')).toBe('语言');
  });
});
