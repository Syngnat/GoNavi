import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SidebarSearchPanel, { type V2CommandSearchItemLike } from './SidebarSearchPanel';

vi.mock('react-dom', () => ({
  createPortal: (children: React.ReactNode) => children,
}));

vi.mock('antd', async () => {
  const React = await import('react');
  const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    (props, ref) => <input ref={ref} {...props} />,
  );
  return { ConfigProvider: passthrough, Input, Tooltip: passthrough };
});

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span data-icon="true" />;
  return { CloseOutlined: Icon, CopyOutlined: Icon, SearchOutlined: Icon, TableOutlined: Icon };
});

vi.mock('../../i18n', () => ({
  t: (key: string) => key,
}));

const item = (key: string, kind: V2CommandSearchItemLike['kind'] = 'action'): V2CommandSearchItemLike => ({
  key,
  kind,
  title: key,
  icon: <span />,
});

const tree = item('node-1', 'node');
const openTab = item('tab:1');
const savedQuery = item('saved-query:1');
const setting = item('settings-entry:proxy:host');
const action = item('action-new-query');
const recent = item('recent-1', 'recent');

const renderPanel = (activeIndex: number, onItemSelect = vi.fn()) => {
  vi.stubGlobal('document', { body: {} });
  const flatItems = [tree, openTab, savedQuery, setting, action, recent];
  return create(
    <SidebarSearchPanel
      isOpen
      searchValue="x"
      activeIndex={activeIndex}
      label="Search"
      placeholder="Search"
      aiMode={false}
      objectMode={false}
      flatItems={flatItems}
      sections={{
        goTo: [tree],
        ai: [],
        tabs: [openTab],
        savedQueries: [savedQuery],
        settings: [setting],
        actions: [action],
        recent: [recent],
      }}
      inputRef={{ current: null }}
      handlers={{
        onSearchValueChange: vi.fn(),
        onKeyDown: vi.fn(),
        onClose: vi.fn(),
        onItemSelect,
        onItemHover: vi.fn(),
        onRemoveRecentItem: vi.fn(),
        onClearRecentItems: vi.fn(),
      }}
    />,
  );
};

describe('SidebarSearchPanel destination sections', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders tabs, saved queries and settings between the tree hits and the actions', () => {
    const renderer = renderPanel(0);

    const headings = renderer.root
      .findAllByProps({ className: 'gn-v2-command-section-title' })
      .map((node) => node.props.children);

    expect(headings).toEqual([
      'sidebar.command_search.section.goto',
      'sidebar.command_search.section.tabs',
      'sidebar.command_search.section.saved_queries',
      'sidebar.command_search.section.settings',
      'sidebar.command_search.section.actions',
      'sidebar.command_search.section.recent',
    ]);
  });

  it('keeps the keyboard-active row in step with the flat navigation order', () => {
    const activeKeys = [0, 1, 2, 3, 4, 5].map((index) => renderPanel(index).root
      .findAll((node) => typeof node.props.className === 'string'
        && node.props.className.includes('gn-v2-command-row-shell is-active'))
      .map((node) => node.props.onMouseEnter)
      .length);

    expect(activeKeys).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('runs the selected settings row', async () => {
    const onItemSelect = vi.fn();
    const renderer = renderPanel(3, onItemSelect);

    const rows = renderer.root.findAllByProps({ className: 'gn-v2-command-row' });
    await act(async () => {
      rows[3].props.onClick();
    });

    expect(onItemSelect).toHaveBeenCalledWith(setting);
  });

  it('still renders when a host passes only the original sections', () => {
    vi.stubGlobal('document', { body: {} });

    const renderer = create(
      <SidebarSearchPanel
        isOpen
        searchValue=""
        activeIndex={0}
        label="Search"
        placeholder="Search"
        aiMode={false}
        objectMode={false}
        flatItems={[action]}
        sections={{ goTo: [], ai: [], actions: [action], recent: [] }}
        inputRef={{ current: null }}
        handlers={{
          onSearchValueChange: vi.fn(),
          onKeyDown: vi.fn(),
          onClose: vi.fn(),
          onItemSelect: vi.fn(),
          onItemHover: vi.fn(),
          onRemoveRecentItem: vi.fn(),
          onClearRecentItems: vi.fn(),
        }}
      />,
    );

    expect(renderer.root.findAllByProps({ className: 'gn-v2-command-row' })).toHaveLength(1);
  });
});
