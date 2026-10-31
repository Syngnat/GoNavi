import { useEffect, useRef } from 'react';

import {
  collectVisibleTableRangeKeys,
  resolveTableRowKeyFromElement,
} from './sidebarTableMultiSelect';

type UseSidebarTableDragSelectArgs = {
  /** 树滚动容器（.sidebar-tree-scroll-shell），表行的共同祖先。 */
  treeContainerRef: React.MutableRefObject<HTMLDivElement | null>;
  /** 受控选中：写入数组即多选高亮（antd Tree 单选模式下 selectedKeys 同样按数组渲染）。 */
  setSidebarSelectedKeys: (keys: React.Key[]) => void;
  /** 与 selectedKeys 配套的节点引用，右键菜单用它在多选时取回全部节点。 */
  selectedNodesRef: React.MutableRefObject<unknown[]>;
  /** 按 key 从树数据取节点，用于同步 selectedNodesRef。 */
  findTreeNodeByKeyRef: React.MutableRefObject<((treeData: any, key: any) => any) | null>;
  treeDataRef: React.MutableRefObject<unknown>;
};

const DRAG_ACTIVATE_DISTANCE_PX = 5;
// 拖选结束后这一窗口内的树 click 全部吞掉，防止 antd 把选中重置回单击行。
const POST_DRAG_SUPPRESS_MS = 400;

const rowKeyFromPoint = (x: number, y: number): string | null => {
  const target = document.elementFromPoint(x, y);
  const key = resolveTableRowKeyFromElement(target);
  return key || null;
};

/**
 * 连接树表节点的范围多选手势：
 *
 * 1. 在表行按下并拖动超过阈值 → 按可视顺序把锚点..指针所在行之间的表
 *    全部置为选中（Navicat / 资源管理器的 rubber-band 语义）；
 * 2. Shift + 点击表行 → 上次点击的表 .. 本次点击的表 之间的表全部选中；
 * 3. 普通单击 / 双击行为不受影响（监听全部在 capture 阶段自行判定，
 *    不拦截非手势事件，因此不需要改动树的 onSelect 与双击打开链路）。
 */
export const useSidebarTableDragSelect = ({
  treeContainerRef,
  setSidebarSelectedKeys,
  selectedNodesRef,
  findTreeNodeByKeyRef,
  treeDataRef,
}: UseSidebarTableDragSelectArgs): void => {
  // 按下时的锚点（未激活拖选前只是候选，抬起前位移不足则视为普通点击）。
  const pressAnchorRef = useRef<{ key: string; x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const lastFrameRef = useRef<number | null>(null);
  const suppressClickUntilRef = useRef(0);
  // Shift 范围的锚点：最近一次普通单击的表 key。
  const lastClickedTableKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const container = treeContainerRef.current;
    if (!container) return;

    const applyRangeSelection = (fromKey: string, toKey: string) => {
      const keys = collectVisibleTableRangeKeys(container, fromKey, toKey);
      if (keys.length === 0) return;
      // 先同步节点引用再通知选中：右键菜单在选中态渲染时读的就是 selectedNodesRef。
      const resolve = findTreeNodeByKeyRef.current;
      const nodes = resolve
        ? keys.map((key) => resolve(treeDataRef.current, key)).filter(Boolean)
        : [];
      selectedNodesRef.current = nodes;
      setSidebarSelectedKeys(keys);
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const key = resolveTableRowKeyFromElement(event.target as Element | null);
      pressAnchorRef.current = key ? { key, x: event.clientX, y: event.clientY } : null;
      draggingRef.current = false;
    };

    const handleMouseMove = (event: MouseEvent) => {
      const press = pressAnchorRef.current;
      if (!press) return;
      if (!draggingRef.current) {
        const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
        if (distance < DRAG_ACTIVATE_DISTANCE_PX) return;
        draggingRef.current = true;
        document.body.style.userSelect = 'none';
      }
      const currentKey = rowKeyFromPoint(event.clientX, event.clientY);
      if (!currentKey || currentKey === press.key) return;
      if (lastFrameRef.current !== null) return;
      lastFrameRef.current = requestAnimationFrame(() => {
        lastFrameRef.current = null;
        if (!draggingRef.current || !pressAnchorRef.current) return;
        applyRangeSelection(pressAnchorRef.current.key, currentKey);
      });
    };

    const handleMouseUp = () => {
      if (draggingRef.current) {
        // 拖选已改写选中，随后落在树上的 click 不能再让 antd 复位成单行。
        suppressClickUntilRef.current = Date.now() + POST_DRAG_SUPPRESS_MS;
        lastClickedTableKeyRef.current = null;
      }
      pressAnchorRef.current = null;
      draggingRef.current = false;
      document.body.style.userSelect = '';
    };

    const handleClickCapture = (event: MouseEvent) => {
      const key = resolveTableRowKeyFromElement(event.target as Element | null);
      if (!key) return;
      if (Date.now() < suppressClickUntilRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.shiftKey) {
        const anchorKey = lastClickedTableKeyRef.current;
        if (anchorKey && anchorKey !== key) {
          event.preventDefault();
          event.stopPropagation();
          applyRangeSelection(anchorKey, key);
          return;
        }
      }
      lastClickedTableKeyRef.current = key;
    };

    container.addEventListener('mousedown', handleMouseDown, true);
    container.addEventListener('click', handleClickCapture, true);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      container.removeEventListener('mousedown', handleMouseDown, true);
      container.removeEventListener('click', handleClickCapture, true);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (lastFrameRef.current !== null) cancelAnimationFrame(lastFrameRef.current);
      document.body.style.userSelect = '';
    };
  }, [findTreeNodeByKeyRef, selectedNodesRef, setSidebarSelectedKeys, treeContainerRef, treeDataRef]);
};
