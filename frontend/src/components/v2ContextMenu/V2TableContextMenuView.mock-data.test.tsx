// @vitest-environment jsdom
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { t } from '../../i18n';
import { V2TableContextMenuView } from './V2TableContextMenuView';
import { V2ConnectionContextMenuView, V2DatabaseContextMenuView } from '../V2TableContextMenu';

const findMockDataItem = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findAll(
  (node) => node.type === 'span'
    && node.props.className === 'gn-v2-context-menu-item-title'
    && node.props.children === t('sidebar.v2_table_menu.generate_mock_data'),
).map((title) => title.parent!);

describe('V2TableContextMenuView mock data item', () => {
  it('shows the item only when the data source supports mock data and reports the action', () => {
    const onAction = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<V2TableContextMenuView tableName="users" supportsMockData onAction={onAction} />);
    });
    const items = findMockDataItem(renderer);
    expect(items).toHaveLength(1);
    act(() => items[0].props.onClick({ preventDefault: () => undefined, stopPropagation: () => undefined }));
    expect(onAction).toHaveBeenCalledWith('mock-data');

    act(() => {
      renderer.update(<V2TableContextMenuView tableName="users" onAction={onAction} />);
    });
    expect(findMockDataItem(renderer)).toHaveLength(0);
  });
});

describe('V2TableContextMenuView plugin actions', () => {
  it('renders a plugin action section and invokes its own callback', () => {
    const onSelect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<V2TableContextMenuView tableName="sessions" pluginActions={[
        { key: 'plugin-connection-action:com.gonavi.mongo-shell:open-shell', title: 'MongoShell', onSelect },
      ]} />);
    });
    const titles = renderer.root.findAll((node) => node.type === 'span'
      && node.props.className === 'gn-v2-context-menu-item-title'
      && node.props.children === 'MongoShell');
    expect(titles).toHaveLength(1);
    act(() => titles[0].parent!.props.onClick({ preventDefault: () => undefined, stopPropagation: () => undefined }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});


describe('V2 connection and database plugin actions', () => {
  it.each([
    ['database', <V2DatabaseContextMenuView dbName="app" pluginActions={[{ key: 'plugin:open', title: 'MongoShell', onSelect: vi.fn() }]} />],
    ['connection', <V2ConnectionContextMenuView connectionName="MongoDB" pluginActions={[{ key: 'plugin:open', title: 'MongoShell', onSelect: vi.fn() }]} />],
  ])('renders the plugin section for a %s node', (_kind, element) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(element); });
    expect(renderer.root.findAll((node) => node.type === 'span'
      && node.props.className === 'gn-v2-context-menu-item-title'
      && node.props.children === 'MongoShell')).toHaveLength(1);
  });
});
