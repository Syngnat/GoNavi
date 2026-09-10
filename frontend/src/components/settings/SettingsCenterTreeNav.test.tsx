import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

vi.mock('@ant-design/icons', () => ({
  CaretRightOutlined: () => React.createElement('span', { 'data-tree-caret': 'true' }),
}));

import SettingsCenterTreeNav, {
  SETTINGS_CENTER_EXPANDED_KEYS_STORAGE_KEY,
  flattenVisibleSettingsCenterTree,
  settingsCenterTreeNodeId,
} from './SettingsCenterTreeNav';

const ensureLocalStorage = () => {
  if (typeof globalThis.localStorage !== 'undefined' && typeof globalThis.localStorage.clear === 'function') {
    return;
  }
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  });
};

const overlayTheme = buildOverlayWorkbenchTheme(false);

const createGroups = (onLanguageClick = vi.fn(), onProxyClick = vi.fn()) => ([
  {
    key: 'preferences',
    icon: <span>P</span>,
    title: '偏好设置',
    description: '语言与外观',
    items: [
      {
        key: 'language',
        icon: <span>L</span>,
        title: '语言',
        description: '界面语言',
        onClick: onLanguageClick,
      },
      {
        key: 'theme',
        icon: <span>T</span>,
        title: '主题',
        description: '外观主题',
        onClick: vi.fn(),
      },
    ],
  },
  {
    key: 'services',
    icon: <span>S</span>,
    title: '服务配置',
    description: '代理与下载',
    items: [
      {
        key: 'proxy',
        icon: <span>X</span>,
        title: '代理',
        description: '网络代理',
        onClick: onProxyClick,
      },
    ],
  },
]);

describe('SettingsCenterTreeNav', () => {
  beforeEach(() => {
    ensureLocalStorage();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('flattens expanded groups and hides collapsed children', () => {
    const groups = createGroups();
    const expanded = flattenVisibleSettingsCenterTree(groups, new Set());
    expect(expanded.map((node) => node.id)).toEqual([
      'group:preferences',
      'item:preferences:language',
      'item:preferences:theme',
      'group:services',
      'item:services:proxy',
    ]);

    const collapsed = flattenVisibleSettingsCenterTree(groups, new Set(['group:services']));
    expect(collapsed.map((node) => node.id)).toEqual([
      'group:preferences',
      'item:preferences:language',
      'item:preferences:theme',
      'group:services',
    ]);
    expect(settingsCenterTreeNodeId({ type: 'item', groupKey: 'preferences', itemKey: 'language' }))
      .toBe('item:preferences:language');
  });

  it('starts with expandable groups collapsed on first visit', () => {
    const onLanguageClick = vi.fn();
    const onSelectGroup = vi.fn();
    const renderer = create(
      <SettingsCenterTreeNav
        groups={createGroups(onLanguageClick)}
        activeGroupKey="preferences"
        activeItemKey="language"
        darkMode={false}
        overlayTheme={overlayTheme}
        ariaLabel="设置中心"
        onSelectGroup={onSelectGroup}
      />,
    );

    const tree = renderer.root.findByProps({ role: 'tree' });
    expect(tree.props['aria-label']).toBe('设置中心');
    expect(renderer.root.findAllByProps({ role: 'treeitem' })).toHaveLength(2);
    expect(renderer.root.findAllByProps({ 'data-settings-pane-key': 'language' })).toHaveLength(0);

    const preferencesGroup = renderer.root.findByProps({ 'data-settings-tree-node': 'group:preferences' });
    expect(preferencesGroup.props['aria-expanded']).toBe(false);

    const caret = renderer.root.findByProps({ 'data-settings-tree-toggle': 'group:preferences' });
    act(() => {
      caret.props.onClick({ stopPropagation() { /* caret should not bubble to the group */ } });
    });

    expect(renderer.root.findAllByProps({ role: 'treeitem' })).toHaveLength(4);
    const languageNode = renderer.root.findByProps({ 'data-settings-pane-key': 'language' });
    expect(languageNode.props['aria-selected']).toBe(true);
    expect(languageNode.props.className).toContain('is-active');
    expect(renderer.root.findAllByProps({ className: 'gonavi-settings-center-tree-icon' })).toHaveLength(0);

    act(() => {
      languageNode.props.onClick();
    });
    expect(onLanguageClick).toHaveBeenCalledTimes(1);
    expect(onSelectGroup).not.toHaveBeenCalled();
  });

  it('collapses a group from the caret without changing the selected leaf', () => {
    const onSelectGroup = vi.fn();
    const renderer = create(
      <SettingsCenterTreeNav
        groups={createGroups()}
        activeGroupKey="preferences"
        activeItemKey="language"
        darkMode={false}
        overlayTheme={overlayTheme}
        ariaLabel="设置中心"
        onSelectGroup={onSelectGroup}
      />,
    );

    const preferencesGroup = renderer.root.findByProps({ 'data-settings-tree-node': 'group:preferences' });
    expect(preferencesGroup.props['aria-expanded']).toBe(false);
    const caret = renderer.root.findByProps({ 'data-settings-tree-toggle': 'group:preferences' });

    act(() => {
      caret.props.onClick({ stopPropagation() { /* caret should not bubble to the group */ } });
    });
    expect(renderer.root.findByProps({ 'data-settings-tree-node': 'group:preferences' }).props['aria-expanded']).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-settings-pane-key': 'language' })).toHaveLength(1);

    act(() => {
      caret.props.onClick({ stopPropagation() { /* caret should not bubble to the group */ } });
    });

    const collapsedGroup = renderer.root.findByProps({ 'data-settings-tree-node': 'group:preferences' });
    expect(collapsedGroup.props['aria-expanded']).toBe(false);
    expect(renderer.root.findAllByProps({ 'data-settings-pane-key': 'language' })).toHaveLength(0);
    expect(onSelectGroup).not.toHaveBeenCalled();
  });

  it('remembers expanded groups across remounts via localStorage', () => {
    const groups = createGroups();
    const first = create(
      <SettingsCenterTreeNav
        groups={groups}
        activeGroupKey="preferences"
        activeItemKey="language"
        darkMode={false}
        overlayTheme={overlayTheme}
        ariaLabel="设置中心"
        onSelectGroup={vi.fn()}
      />,
    );

    expect(first.root.findByProps({ 'data-settings-tree-node': 'group:preferences' }).props['aria-expanded']).toBe(false);
    expect(first.root.findByProps({ 'data-settings-tree-node': 'group:services' }).props['aria-expanded']).toBe(false);

    act(() => {
      first.root.findByProps({ 'data-settings-tree-toggle': 'group:preferences' }).props.onClick({
        stopPropagation() { /* caret */ },
      });
    });
    expect(first.root.findByProps({ 'data-settings-tree-node': 'group:preferences' }).props['aria-expanded']).toBe(true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_CENTER_EXPANDED_KEYS_STORAGE_KEY) ?? 'null')).toEqual([
      'group:preferences',
    ]);

    act(() => {
      first.unmount();
    });

    const second = create(
      <SettingsCenterTreeNav
        groups={groups}
        activeGroupKey="preferences"
        activeItemKey="language"
        darkMode={false}
        overlayTheme={overlayTheme}
        ariaLabel="设置中心"
        onSelectGroup={vi.fn()}
      />,
    );

    expect(second.root.findByProps({ 'data-settings-tree-node': 'group:preferences' }).props['aria-expanded']).toBe(true);
    expect(second.root.findByProps({ 'data-settings-tree-node': 'group:services' }).props['aria-expanded']).toBe(false);
    expect(second.root.findAllByProps({ 'data-settings-pane-key': 'language' })).toHaveLength(1);
    expect(second.root.findAllByProps({ 'data-settings-pane-key': 'proxy' })).toHaveLength(0);
  });

  it('activates another group from the tree instead of requiring a settings list', () => {
    const onSelectGroup = vi.fn();
    const renderer = create(
      <SettingsCenterTreeNav
        groups={createGroups()}
        activeGroupKey="preferences"
        activeItemKey="language"
        darkMode={false}
        overlayTheme={overlayTheme}
        ariaLabel="设置中心"
        onSelectGroup={onSelectGroup}
      />,
    );

    const servicesGroup = renderer.root.findByProps({ 'data-settings-tree-node': 'group:services' });
    act(() => {
      servicesGroup.props.onClick();
    });
    expect(onSelectGroup).toHaveBeenCalledWith('services');
  });

  it('exposes nested section leaves under a settings node', () => {
    const onThemeClick = vi.fn();
    const onAppearanceClick = vi.fn();
    const groups = [{
      key: 'preferences',
      icon: <span>P</span>,
      title: '偏好设置',
      description: '语言与外观',
      items: [{
        key: 'theme',
        icon: <span>T</span>,
        title: '主题与外观',
        description: '主题设置',
        onClick: onThemeClick,
        children: [
          {
            key: 'theme-theme',
            icon: <span>I</span>,
            title: '主题与界面',
            description: '亮暗模式',
            onClick: vi.fn(),
          },
          {
            key: 'theme-appearance',
            icon: <span>F</span>,
            title: '显示与字体',
            description: '缩放字体',
            onClick: onAppearanceClick,
          },
          {
            key: 'theme-workspace',
            icon: <span>W</span>,
            title: '工作区',
            description: '工作区',
            onClick: vi.fn(),
          },
        ],
      }],
    }];

    expect(flattenVisibleSettingsCenterTree(groups, new Set()).map((node) => node.id)).toEqual([
      'group:preferences',
      'item:preferences:theme',
      'item:preferences:theme-theme',
      'item:preferences:theme-appearance',
      'item:preferences:theme-workspace',
    ]);
    expect(flattenVisibleSettingsCenterTree(groups, new Set(['item:preferences:theme'])).map((node) => node.id)).toEqual([
      'group:preferences',
      'item:preferences:theme',
    ]);

    localStorage.setItem(
      SETTINGS_CENTER_EXPANDED_KEYS_STORAGE_KEY,
      JSON.stringify(['group:preferences', 'item:preferences:theme']),
    );

    const renderer = create(
      <SettingsCenterTreeNav
        groups={groups}
        activeGroupKey="preferences"
        activeItemKey="theme-appearance"
        darkMode={false}
        overlayTheme={overlayTheme}
        ariaLabel="设置中心"
        onSelectGroup={() => undefined}
      />,
    );

    expect(renderer.root.findAllByProps({ role: 'treeitem' })).toHaveLength(5);
    expect(renderer.root.findAllByProps({ className: 'gonavi-settings-center-tree-icon' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ className: 'gonavi-settings-center-tree-branch' })).toHaveLength(1);
    const appearanceNode = renderer.root.findByProps({ 'data-settings-pane-key': 'theme-appearance' });
    expect(appearanceNode.props.className).toContain('is-grandchild');
    expect(appearanceNode.props['aria-selected']).toBe(true);
    act(() => {
      appearanceNode.props.onClick();
    });
    expect(onAppearanceClick).toHaveBeenCalledTimes(1);

    const themeNode = renderer.root.findByProps({ 'data-settings-pane-key': 'theme' });
    act(() => {
      themeNode.props.onClick();
    });
    expect(onThemeClick).toHaveBeenCalledTimes(1);
  });

  it('exposes a fourth-level leaf under a nested settings node', () => {
    const onConnectedClick = vi.fn();
    const groups = [{
      key: 'services',
      title: '服务配置',
      description: '服务',
      items: [{
        key: 'ai',
        title: 'AI 设置',
        description: 'AI',
        onClick: vi.fn(),
        children: [{
          key: 'ai-providers',
          title: '模型供应商',
          description: '供应商',
          onClick: vi.fn(),
          children: [{
            key: 'ai-providers-connected',
            title: '已接入',
            description: '已保存配置',
            onClick: onConnectedClick,
          }],
        }],
      }],
    }];

    expect(flattenVisibleSettingsCenterTree(groups, new Set()).map((node) => node.id)).toEqual([
      'group:services',
      'item:services:ai',
      'item:services:ai-providers',
      'item:services:ai-providers-connected',
    ]);

    localStorage.setItem(
      SETTINGS_CENTER_EXPANDED_KEYS_STORAGE_KEY,
      JSON.stringify(['group:services', 'item:services:ai', 'item:services:ai-providers']),
    );

    const renderer = create(
      <SettingsCenterTreeNav
        groups={groups}
        activeGroupKey="services"
        activeItemKey="ai-providers-connected"
        darkMode={false}
        overlayTheme={overlayTheme}
        ariaLabel="设置中心"
        onSelectGroup={() => undefined}
      />,
    );

    const connectedNode = renderer.root.findByProps({ 'data-settings-pane-key': 'ai-providers-connected' });
    expect(connectedNode.props.className).toContain('is-great-grandchild');
    expect(connectedNode.props['aria-selected']).toBe(true);
    act(() => {
      connectedNode.props.onClick();
    });
    expect(onConnectedClick).toHaveBeenCalledTimes(1);
  });


  it('auto-expands ancestors when an active nested item is selected programmatically', () => {
    const groups = [{
      key: 'services',
      title: '服务配置',
      description: '服务',
      items: [{
        key: 'ai',
        title: 'AI 设置',
        description: 'AI',
        onClick: vi.fn(),
        children: [{
          key: 'ai-providers',
          title: '模型供应商',
          description: '供应商',
          onClick: vi.fn(),
        }],
      }],
    }];

    // First visit: everything starts collapsed in storage default.
    localStorage.removeItem(SETTINGS_CENTER_EXPANDED_KEYS_STORAGE_KEY);

    const renderer = create(
      <SettingsCenterTreeNav
        groups={groups}
        activeGroupKey="services"
        activeItemKey="ai-providers"
        darkMode={false}
        overlayTheme={overlayTheme}
        ariaLabel="设置中心"
        onSelectGroup={() => undefined}
      />,
    );

    expect(renderer.root.findByProps({ 'data-settings-tree-node': 'group:services' }).props['aria-expanded']).toBe(true);
    expect(renderer.root.findByProps({ 'data-settings-tree-node': 'item:services:ai' }).props['aria-expanded']).toBe(true);
    const providersNode = renderer.root.findByProps({ 'data-settings-pane-key': 'ai-providers' });
    expect(providersNode.props['aria-selected']).toBe(true);
  });

  it('renders a leaf group as a first-level node without a nested child', () => {
    const onSelectGroup = vi.fn();
    const groups = [{
      key: 'about',
      title: '关于 GoNavi',
      description: '版本与更新',
      items: [],
    }];

    expect(flattenVisibleSettingsCenterTree(groups, new Set()).map((node) => node.id)).toEqual([
      'group:about',
    ]);

    const renderer = create(
      <SettingsCenterTreeNav
        groups={groups}
        activeGroupKey="about"
        activeItemKey="about-go-navi"
        darkMode={false}
        overlayTheme={overlayTheme}
        ariaLabel="设置中心"
        onSelectGroup={onSelectGroup}
      />,
    );

    expect(renderer.root.findAllByProps({ role: 'treeitem' })).toHaveLength(1);
    const aboutNode = renderer.root.findByProps({ 'data-settings-tree-node': 'group:about' });
    expect(aboutNode.props['aria-selected']).toBe(true);
    expect(aboutNode.props['aria-expanded']).toBeUndefined();
    expect(aboutNode.props['aria-label']).toBe('关于 GoNavi');
    expect(renderer.root.findAllByProps({ 'data-settings-pane-key': 'about-go-navi' })).toHaveLength(0);

    act(() => {
      aboutNode.props.onClick();
    });
    expect(onSelectGroup).not.toHaveBeenCalled();
  });
});
