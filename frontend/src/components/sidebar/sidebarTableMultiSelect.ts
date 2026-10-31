// 连接树表节点多选的纯辅助：可视顺序收集与「右键是否作用于多表」判定。
// DOM 顺序即树的可见顺序（虚拟滚动容器内同样成立），拖选 / Shift 范围
// 都以它为准，避免重算 treeData × expandedKeys 的展开序。

export type MultiSelectableNode = {
  key?: unknown;
  type?: string;
  dataRef?: Record<string, any>;
};

const TABLE_NODE_DOM_SELECTOR = '[data-sidebar-node-type="table"][data-sidebar-node-key]';

const readRowKey = (element: Element | null | undefined): string => (
  String((element as HTMLElement | null)?.dataset?.sidebarNodeKey || '').trim()
);

/**
 * 从行内任意子元素解出所属表行的 key：
 * 表节点的 data 标记落在标题 span 上，按下图标 / 缩进 / 行内空白时目标不是它，
 * 因此再向上一级取树行，从行内回查标记。非表行返回空串。
 */
export const resolveTableRowKeyFromElement = (element: Element | null | undefined): string => {
  if (!element || typeof (element as Element).closest !== 'function') return '';
  const marker = element.closest(TABLE_NODE_DOM_SELECTOR);
  if (marker) return readRowKey(marker);
  const row = element.closest('.ant-tree-treenode');
  if (!row) return '';
  return readRowKey(row.querySelector(TABLE_NODE_DOM_SELECTOR));
};

/** 按可视顺序返回容器内全部表行 key（去重、过滤空值）。 */
export const collectVisibleTableKeys = (container: HTMLElement | null): string[] => {
  if (!container) return [];
  const keys: string[] = [];
  container.querySelectorAll<HTMLElement>(TABLE_NODE_DOM_SELECTOR).forEach((row) => {
    const key = String(row.dataset.sidebarNodeKey || '').trim();
    if (key && !keys.includes(key)) keys.push(key);
  });
  return keys;
};

/**
 * 返回 fromKey..toKey（含两端）在可视顺序中的表 key 闭区间。
 * 任一端不在可视表行中时返回空数组：调用方据此放弃本次范围操作，
 * 回落到树的默认单选行为。
 */
export const collectVisibleTableRangeKeys = (
  container: HTMLElement | null,
  fromKey: string,
  toKey: string,
): string[] => {
  if (!container || !fromKey || !toKey) return [];
  const visibleKeys = collectVisibleTableKeys(container);
  const fromIndex = visibleKeys.indexOf(fromKey);
  const toIndex = visibleKeys.indexOf(toKey);
  if (fromIndex < 0 || toIndex < 0) return [];
  const [start, end] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
  return visibleKeys.slice(start, end + 1);
};

/**
 * 右键落在 node 上时，若当前选中集是「多张表且包含该表」则返回这些节点，
 * 否则返回 null（走单表菜单）。非 table 节点一律视为单选。
 */
export const resolveMultiTableSelection = (
  node: MultiSelectableNode | null | undefined,
  selectedNodes: ReadonlyArray<MultiSelectableNode | null | undefined> | null | undefined,
): MultiSelectableNode[] | null => {
  if (!node || node.type !== 'table') return null;
  const nodes = (selectedNodes || []).filter(Boolean) as MultiSelectableNode[];
  if (nodes.length <= 1) return null;
  const nodeKey = String(node.key || '');
  if (!nodes.every((candidate) => candidate.type === 'table')) return null;
  return nodes.some((candidate) => String(candidate.key || '') === nodeKey) ? nodes : null;
};

/**
 * 把树的选中集归一成「普通单击 = 单选」：
 * 树开启 multiple 后会按 arrAdd / arrDel 累计选中，普通单击必须回到单个节点，
 * 否则点第二张表会把上一张也留在高亮里。
 * 返回 null 表示调用方保留原选中集（带修饰键的单击 / Ctrl / Cmd 多选）。
 */
export const resolvePlainClickSelectedKeys = (
  keys: ReadonlyArray<unknown>,
  clickedKey: unknown,
  hasModifier: boolean,
): unknown[] | null => {
  if (hasModifier) return null;
  if (clickedKey === undefined || clickedKey === null) return null;
  const current = Array.isArray(keys) ? keys : [];
  const stillSelected = current.some((key) => String(key) === String(clickedKey));
  // 点击未选中行 → 只选它；点击已选中行 → 取消（保持原有的二次点击取消语义）。
  return stillSelected ? [clickedKey] : [];
};
