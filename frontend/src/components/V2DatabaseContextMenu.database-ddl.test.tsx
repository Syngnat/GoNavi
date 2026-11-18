// @vitest-environment jsdom
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { V2DatabaseContextMenuView } from './V2TableContextMenu';
import { V2TableContextMenuItem } from './v2ContextMenu/v2ContextMenuPrimitives';

const renderMenu = (supportsCreateDatabaseDdl: boolean, onAction = vi.fn()) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <V2DatabaseContextMenuView
        dbName="tenant"
        supportsCreateDatabaseDdl={supportsCreateDatabaseDdl}
        onAction={onAction}
      />,
    );
  });
  return { renderer, onAction };
};

describe('database definition menu action', () => {
  it('shows the view-create-database action only when the dialect can provide DDL', () => {
    const supported = renderMenu(true);
    const supportedActions = supported.renderer.root
      .findAllByType(V2TableContextMenuItem)
      .map((item) => item.props.item.action);
    expect(supportedActions).toContain('view-create-database');
    act(() => supported.renderer.unmount());

    const unsupported = renderMenu(false);
    const unsupportedActions = unsupported.renderer.root
      .findAllByType(V2TableContextMenuItem)
      .map((item) => item.props.item.action);
    expect(unsupportedActions).not.toContain('view-create-database');
    act(() => unsupported.renderer.unmount());
  });

  it('routes the menu item through the shared database action handler', () => {
    const { renderer, onAction } = renderMenu(true);
    const item = renderer.root
      .findAllByType(V2TableContextMenuItem)
      .find((candidate) => candidate.props.item.action === 'view-create-database');
    expect(item).toBeTruthy();

    act(() => item!.findByType('button').props.onClick({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }));
    expect(onAction).toHaveBeenCalledWith('view-create-database');
    act(() => renderer.unmount());
  });
});
