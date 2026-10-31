import { useCallback, useEffect, useRef, useState } from 'react';

import {
  collectOverviewRangeNames,
  isOverviewNameTarget,
  isRenameHotkeyTarget,
  resolveOverviewClickSelection,
  resolveOverviewRowElement,
  resolveOverviewRowNameFromElement,
} from '../tableOverviewSelection';

type UseTableOverviewSelectionArgs = {
  /** 表概览内容区（三种视图共同的祖先），选中手势只在这里生效。 */
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
  /** 单选状态下再次单击表名时触发（就地改名入口）。 */
  onActivateName?: (name: string) => void;
};

// 按下后位移超过该阈值才视为拖选，避免把单击误判成拖动。
const DRAG_ACTIVATE_DISTANCE_PX = 5;
// 拖选结束后这一窗口内的 click 吞掉，避免把区间选中缩回单行。
const POST_DRAG_SUPPRESS_MS = 400;

const rowNameFromPoint = (x: number, y: number): string => (
  resolveOverviewRowNameFromElement(document.elementFromPoint(x, y))
);

/**
 * 表概览的选中手势：
 *
 * 1. 单击一行 → 只选中它；再点别处（列表外或空白处）→ 清空；
 * 2. 在行上按下并拖动 → 锚点..指针所在行的区间选中；
 * 3. Shift + 点击 → 上次点击行..本次行 的区间；
 * 4. Ctrl / Cmd + 点击 → 切换该行的选中状态。
 *
 * 行的选中状态通过 class 渲染，事件全部在捕获阶段自行判定，
 * 不影响既有的双击打开表与右键菜单。
 */
export const useTableOverviewSelection = ({ contentRef, onActivateName }: UseTableOverviewSelectionArgs) => {
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const selectedNamesRef = useRef<string[]>([]);
  const anchorRef = useRef<string | null>(null);
  const pressRef = useRef<{ name: string; x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const suppressClickUntilRef = useRef(0);
  // 回调放 ref，避免它变化时重新挂一遍 document 监听。
  const activateNameRef = useRef(onActivateName);
  activateNameRef.current = onActivateName;

  const commitSelection = useCallback((next: string[]) => {
    const current = selectedNamesRef.current;
    if (current.length === next.length && current.every((name, index) => name === next[index])) return;
    selectedNamesRef.current = next;
    setSelectedNames(next);
  }, []);

  const clearSelection = useCallback(() => {
    anchorRef.current = null;
    commitSelection([]);
  }, [commitSelection]);

  useEffect(() => {
    // 内容区在 loading / 视图切换时会重建，这里不在挂载时抓 DOM 引用，
    // 统一监听 document、事件发生时再解析容器，避免监听挂不上或残留。
    const resolveContainer = (): HTMLDivElement | null => contentRef.current;

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Node | null;
      const container = resolveContainer();
      if (!container || !target || !container.contains(target)) {
        // 点击列表以外的区域（工具栏、左侧树、编辑区…）取消选中。
        if ((target as Element | null)?.closest?.('[data-gonavi-close-shortcut-guard]')) return;
        clearSelection();
        pressRef.current = null;
        draggingRef.current = false;
        return;
      }
      const name = resolveOverviewRowNameFromElement(target as Element | null);
      pressRef.current = name ? { name, x: event.clientX, y: event.clientY } : null;
      draggingRef.current = false;
      // 按在空白处（或非可选行）→ 清空选中；按在行上由 click 决定新选中集。
      if (!name) clearSelection();
    };

    const handleMouseMove = (event: MouseEvent) => {
      const press = pressRef.current;
      if (!press) return;
      if (!draggingRef.current) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_ACTIVATE_DISTANCE_PX) return;
        draggingRef.current = true;
        document.body.style.userSelect = 'none';
      }
      const currentName = rowNameFromPoint(event.clientX, event.clientY);
      if (!currentName || currentName === press.name) return;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        if (!draggingRef.current || !pressRef.current) return;
        const range = collectOverviewRangeNames(resolveContainer(), pressRef.current.name, currentName);
        if (range.length > 0) commitSelection(range);
      });
    };

    const handleMouseUp = () => {
      if (draggingRef.current) {
        suppressClickUntilRef.current = Date.now() + POST_DRAG_SUPPRESS_MS;
        anchorRef.current = null;
      }
      pressRef.current = null;
      draggingRef.current = false;
      document.body.style.userSelect = '';
    };

    const handleClick = (event: MouseEvent) => {
      if (Date.now() < suppressClickUntilRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const target = event.target as Node | null;
      const container = resolveContainer();
      if (!container || !target || !container.contains(target)) return;
      const name = resolveOverviewRowNameFromElement(target as Element | null);
      if (!name) return;
      const current = selectedNamesRef.current;
      const onlyThisSelected = current.length === 1 && current[0] === name;
      // 已单选该表、且点在表名上 → 进入就地改名，不改选中集。
      if (onlyThisSelected && !event.shiftKey && !event.metaKey && !event.ctrlKey
          && isOverviewNameTarget(target as Element | null)) {
        anchorRef.current = name;
        activateNameRef.current?.(name);
        return;
      }
      const next = resolveOverviewClickSelection(
        container,
        current,
        name,
        { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey },
        anchorRef.current,
      );
      commitSelection(next);
      anchorRef.current = name;
      // 让被点中的行拿到焦点，回车改名据此判定作用范围。
      resolveOverviewRowElement(target as Element | null)?.focus?.({ preventScroll: true });
    };

    // 单选某张表时按回车 → 进入改名（与「再次单击表名」同一入口）。
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      const container = resolveContainer();
      const target = event.target as Node | null;
      if (!container || !target || !container.contains(target)) return;
      if (!isRenameHotkeyTarget(target as Element | null)) return;
      const current = selectedNamesRef.current;
      if (current.length !== 1) return;
      event.preventDefault();
      anchorRef.current = current[0];
      activateNameRef.current?.(current[0]);
    };

    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      document.body.style.userSelect = '';
    };
  }, [clearSelection, commitSelection, contentRef]);

  const isSelected = useCallback((name: string) => selectedNames.includes(name), [selectedNames]);

  return {
    selectedNames,
    isSelected,
    clearSelection,
    setSelection: commitSelection,
  };
};

export type TableOverviewSelectionApi = ReturnType<typeof useTableOverviewSelection>;
