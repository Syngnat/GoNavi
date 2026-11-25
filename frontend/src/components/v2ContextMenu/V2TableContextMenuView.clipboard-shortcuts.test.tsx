// @vitest-environment jsdom

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { t } from '../../i18n';
import { V2TableContextMenuView } from './V2TableContextMenuView';

describe('table context menu clipboard shortcuts', () => {
  it.each([
    ['mac', '⌘⇧C', '⌘C'],
    ['windows', 'Ctrl+Shift+C', 'Ctrl+C'],
  ] as const)('distinguishes copying names from copying complete tables on %s', (platform, nameShortcut, tableShortcut) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<V2TableContextMenuView tableName="orders" supportsCopyTable shortcutPlatform={platform} />);
    });
    const items = renderer.root.findAll((node) => node.type === 'button' && node.props.role === 'menuitem');
    const findItem = (label: string) => items.find((node) => node.findAll((child) =>
      child.type === 'span' && child.props.className === 'gn-v2-context-menu-item-title' && child.props.children === label,
    ).length > 0)!;
    const shortcutOf = (item: TestRenderer.ReactTestInstance) => item.findByProps({ className: 'gn-v2-context-menu-kbd' }).props.children;

    expect(shortcutOf(findItem(t('sidebar.v2_table_menu.copy_table_name')))).toBe(nameShortcut);
    expect(shortcutOf(findItem(t('table_copy.action.label')))).toBe(tableShortcut);
    expect(findItem(t('sidebar.menu.copy_table_structure')).findAllByProps({ className: 'gn-v2-context-menu-kbd' })).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
