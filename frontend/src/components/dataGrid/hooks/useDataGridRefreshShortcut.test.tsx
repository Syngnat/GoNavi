/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';

import { useDataGridRefreshShortcut } from './useDataGridRefreshShortcut';
import { cloneShortcutOptions } from '../../../utils/shortcutOptions';
import { DEFAULT_SHORTCUT_OPTIONS } from '../../../utils/shortcutDefinitions';

type Options = Partial<Parameters<typeof useDataGridRefreshShortcut>[0]>;

const render = (overrides: Options = {}) => {
    const onRefresh = vi.fn();
    const root = document.createElement('div');
    const inner = document.createElement('div');
    root.appendChild(inner);
    document.body.appendChild(root);

    const Probe = () => {
        useDataGridRefreshShortcut({
            isActive: true,
            viewMode: 'table',
            rootRef: { current: root } as React.RefObject<HTMLElement | null>,
            shortcutOptions: cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS),
            activeShortcutPlatform: 'windows',
            canRefresh: true,
            onRefresh,
            ...overrides,
        });
        return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<Probe />); });
    return { onRefresh, root, inner, unmount: () => { act(() => renderer.unmount()); root.remove(); } };
};

const press = (target: EventTarget, key: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    act(() => { target.dispatchEvent(event); });
    return event;
};

describe('refresh table data shortcut', () => {
    it('refreshes on F5 while the grid has focus', () => {
        const { onRefresh, inner, unmount } = render();
        const event = press(inner, 'F5');

        expect(onRefresh).toHaveBeenCalledTimes(1);
        // 不 preventDefault 的话 WebView 会刷新整个页面。
        expect(event.defaultPrevented).toBe(true);
        unmount();
    });

    // 焦点不在表格里时不抢 F5：用户在侧边栏按 F5 应当刷新页面而不是刷新表格。
    it('ignores the shortcut when focus is outside the grid', () => {
        const { onRefresh, unmount } = render();
        const outside = document.createElement('button');
        document.body.appendChild(outside);

        press(outside, 'F5');

        expect(onRefresh).not.toHaveBeenCalled();
        outside.remove();
        unmount();
    });

    it('does not refresh while a cell editor has focus', () => {
        const { onRefresh, inner, unmount } = render();
        const input = document.createElement('input');
        inner.appendChild(input);
        input.focus();

        press(input, 'F5');

        expect(onRefresh).not.toHaveBeenCalled();
        unmount();
    });

    it('does not refresh while a reload is already running', () => {
        const { onRefresh, inner, unmount } = render({ canRefresh: false });
        press(inner, 'F5');
        expect(onRefresh).not.toHaveBeenCalled();
        unmount();
    });

    it('stays inert outside the table view', () => {
        const { onRefresh, inner, unmount } = render({ viewMode: 'json' });
        press(inner, 'F5');
        expect(onRefresh).not.toHaveBeenCalled();
        unmount();
    });

    // 用户可以在快捷键面板改组合键，这里跟随配置而不是写死 F5。
    it('follows a customised binding', () => {
        const options = cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS);
        options.refreshTableData = {
            mac: { combo: 'Meta+Shift+R', enabled: true },
            windows: { combo: 'Ctrl+Shift+R', enabled: true },
        };
        const { onRefresh, inner, unmount } = (() => {
            const root = document.createElement('div');
            const innerNode = document.createElement('div');
            root.appendChild(innerNode);
            document.body.appendChild(root);
            const fn = vi.fn();
            const Probe = () => {
                useDataGridRefreshShortcut({
                    isActive: true,
                    viewMode: 'table',
                    rootRef: { current: root } as React.RefObject<HTMLElement | null>,
                    shortcutOptions: options,
                    activeShortcutPlatform: 'windows',
                    canRefresh: true,
                    onRefresh: fn,
                });
                return null;
            };
            let renderer!: TestRenderer.ReactTestRenderer;
            act(() => { renderer = TestRenderer.create(<Probe />); });
            return { onRefresh: fn, inner: innerNode, unmount: (() => { act(() => renderer.unmount()); root.remove(); }) };
        })();

        press(inner, 'F5');
        expect(onRefresh).not.toHaveBeenCalled();

        press(inner, 'R', { ctrlKey: true, shiftKey: true });
        expect(onRefresh).toHaveBeenCalledTimes(1);
        unmount();
    });

    it('stays inert when the action is disabled', () => {
        const options = cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS);
        options.refreshTableData = {
            mac: { combo: 'Meta+Shift+R', enabled: false },
            windows: { combo: 'F5', enabled: false },
        };
        const { onRefresh, inner, unmount } = render({ shortcutOptions: options });
        press(inner, 'F5');
        expect(onRefresh).not.toHaveBeenCalled();
        unmount();
    });
});
