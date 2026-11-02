import { useEffect } from 'react';

import { isEditableElement, isShortcutMatch } from '../../../utils/shortcuts';
import { resolveShortcutBinding } from '../../../utils/shortcutOptions';
import type { ShortcutOptions, ShortcutPlatform } from '../../../utils/shortcutDefinitions';

type Params = {
    isActive: boolean;
    viewMode: string;
    rootRef: React.RefObject<HTMLElement | null>;
    shortcutOptions: ShortcutOptions;
    activeShortcutPlatform: ShortcutPlatform;
    /** 刷新中或不可刷新时传 false，避免快捷键触发重复请求。 */
    canRefresh: boolean;
    onRefresh: () => void;
};

/**
 * 表格数据刷新的快捷键。
 *
 * 只在表格本身有焦点时生效：F5 在整页范围内是浏览器刷新，抢过来会让用户
 * 在侧边栏按 F5 得到「刷新表格」而不是刷新页面。范围收紧到表格焦点内，
 * 语义才明确。
 *
 * 焦点判定沿用列宽/页内查找那套（事件目标或 activeElement 落在 root 内），
 * 同时复用 isShortcutMatch，确保用户自定义过组合键后这里跟着变。
 */
export const useDataGridRefreshShortcut = ({
    isActive,
    viewMode,
    rootRef,
    shortcutOptions,
    activeShortcutPlatform,
    canRefresh,
    onRefresh,
}: Params) => {
    useEffect(() => {
        if (!isActive || viewMode !== 'table') return;

        const binding = resolveShortcutBinding(
            shortcutOptions,
            'refreshTableData',
            activeShortcutPlatform,
        );
        if (!binding?.enabled || !binding.combo) return;

        const handleRefreshShortcut = (event: KeyboardEvent) => {
            if (!isShortcutMatch(event, binding.combo)) return;

            const root = rootRef.current;
            if (!root) return;
            const eventTarget = event.target;
            const targetNode = typeof Node !== 'undefined' && eventTarget instanceof Node
                ? eventTarget
                : null;
            const activeElement = document.activeElement;
            const inGrid = (node: Node | null | undefined): boolean =>
                !!(root && node && root.contains(node));
            if (!inGrid(targetNode) && !inGrid(activeElement)) return;

            // 单元格仍在编辑时不要刷新：那会把用户没提交的草稿冲掉。
            // 例外是页内查找框，它不是单元格编辑器。
            const targetElement = targetNode && typeof (targetNode as Element).closest === 'function'
                ? targetNode as Element
                : null;
            const inPageFind = !!targetElement?.closest('[data-grid-page-find="true"]');
            if (!inPageFind && (isEditableElement(eventTarget) || isEditableElement(activeElement))) {
                return;
            }

            if (!canRefresh) return;

            event.preventDefault();
            event.stopPropagation();
            onRefresh();
        };

        window.addEventListener('keydown', handleRefreshShortcut, true);
        return () => window.removeEventListener('keydown', handleRefreshShortcut, true);
    }, [
        isActive, viewMode, rootRef, shortcutOptions, activeShortcutPlatform, canRefresh, onRefresh,
    ]);
};
