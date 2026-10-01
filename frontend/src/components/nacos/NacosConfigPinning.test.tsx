import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import { NacosConfigRow, useNacosConfigPinning } from './NacosConfigPinning';
import { isNacosConfigPinned } from './nacosPinning';

vi.mock('@ant-design/icons', () => ({ PushpinOutlined: () => <span />, StarFilled: () => <span /> }));

vi.mock('antd', async () => {
  const React = await import('react');
  return {
    Button: ({ children, icon, ...props }: Record<string, unknown>) => React.createElement('button', props, icon as React.ReactNode, children as React.ReactNode),
    Dropdown: ({ children, menu }: {children: React.ReactNode; menu: unknown}) => React.createElement('div', { 'data-pin-menu': true, menu }, children),
    Tag: ({children}: {children: React.ReactNode}) => React.createElement('span', {}, children),
    Tooltip: ({children}: {children: React.ReactNode}) => children,
  };
});

describe('Nacos config row pinning', () => {
  const previousPins = useStore.getState().pinnedSidebarTables;
  let renderer: ReactTestRenderer | undefined;
  afterEach(() => { act(() => renderer?.unmount()); useStore.setState({pinnedSidebarTables: previousPins}); });
  it('persists a click and right-click pin, rerenders list order, and keeps pin clicks out of row selection', () => {
    useStore.setState({pinnedSidebarTables: []});
    const items = [{dataId: 'a.yaml', group: 'G'}, {dataId: 'b.yaml', group: 'G'}];
    const Harness = () => {
      const rows = useNacosConfigPinning(items, 'c1', 'dev');
      return <div>{rows.map(row => <NacosConfigRow key={row.dataId} row={row} connectionId="c1" namespaceId="dev" />)}</div>;
    };
    act(() => { renderer = create(<Harness />); });
    const stopPropagation = vi.fn();
    act(() => renderer!.root.findAllByType('button')[1].props.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalled();
    expect(isNacosConfigPinned(useStore.getState().pinnedSidebarTables, 'c1', 'dev', items[1])).toBe(true);
    expect(renderer!.root.findAllByProps({className: 'gn-nacos-config-row__id'})[0].children).toEqual(['b.yaml']);
    const menu = renderer!.root.findAllByProps({'data-pin-menu': true})[0].props.menu;
    act(() => menu.items[0].onClick());
    expect(isNacosConfigPinned(useStore.getState().pinnedSidebarTables, 'c1', 'dev', items[1])).toBe(false);
    expect(renderer!.root.findAllByProps({className: 'gn-nacos-config-row__id'})[0].children).toEqual(['a.yaml']);
  });
});
