import { describe, expect, it, vi } from 'vitest';

import {
  handleSidebarV2ContextMenuShortcut,
  type SidebarContextMenuState,
} from './useSidebarV2ContextMenu';

const createKeyEvent = (overrides: Partial<KeyboardEvent> = {}): KeyboardEvent => ({
  key: 'c',
  code: 'KeyC',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 67,
  which: 67,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...overrides,
} as unknown as KeyboardEvent);

const createTableMenu = (node: Record<string, unknown>): SidebarContextMenuState => ({
  x: 10,
  y: 20,
  items: [],
  kind: 'v2-table',
  node,
});

describe('V2 sidebar context-menu shortcuts', () => {
  it.each([
    ['mac', { metaKey: true }],
    ['windows', { ctrlKey: true }],
  ] as const)('routes the primary copy shortcut on %s to the current table', (platform, modifiers) => {
    const node = { key: `table-${platform}`, title: 'ir_staff' };
    const event = createKeyEvent(modifiers);
    const onTableAction = vi.fn();
    const onClose = vi.fn();

    expect(handleSidebarV2ContextMenuShortcut({
      event,
      contextMenu: createTableMenu(node),
      shortcutPlatform: platform,
      onTableAction,
      onClose,
    })).toBe(true);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onTableAction).toHaveBeenCalledWith(node, 'copy-table-name');
  });

  it.each([
    createKeyEvent(),
    createKeyEvent({ altKey: true, metaKey: true }),
    createKeyEvent({ ctrlKey: true, shiftKey: true }),
  ])('ignores copy-like keys that do not match the platform shortcut', (event) => {
    const onTableAction = vi.fn();
    const onClose = vi.fn();

    expect(handleSidebarV2ContextMenuShortcut({
      event,
      contextMenu: createTableMenu({ key: 'table-a' }),
      shortcutPlatform: 'mac',
      onTableAction,
      onClose,
    })).toBe(false);

    expect(onTableAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses the latest node when a table menu is replaced without changing kind', () => {
    const onTableAction = vi.fn();
    const firstNode = { key: 'table-a' };
    const latestNode = { key: 'table-b' };

    handleSidebarV2ContextMenuShortcut({
      event: createKeyEvent({ metaKey: true }),
      contextMenu: createTableMenu(latestNode),
      shortcutPlatform: 'mac',
      onTableAction,
      onClose: vi.fn(),
    });

    expect(onTableAction).toHaveBeenCalledWith(latestNode, 'copy-table-name');
    expect(onTableAction).not.toHaveBeenCalledWith(firstNode, 'copy-table-name');
  });
});
