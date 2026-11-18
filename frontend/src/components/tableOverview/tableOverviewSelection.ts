// 表概览（表 / 视图 / 函数三套视图模式）多选的纯辅助：
// 行标记解析、可视顺序收集与区间计算。DOM 顺序即渲染顺序，三种视图
// （卡片 / 列表 / 紧凑表）都带同一个 data-table-overview-select 标记，
// 因此拖选与 Shift 区间不依赖具体视图实现。

export const OVERVIEW_SELECTABLE_SELECTOR = '[data-table-overview-select]';

/** 取点击目标所属的可选行元素（用于把焦点放到行上）。 */
export const resolveOverviewRowElement = (element: Element | null | undefined): HTMLElement | null => {
  if (!element || typeof (element as Element).closest !== 'function') return null;
  return element.closest(OVERVIEW_SELECTABLE_SELECTOR) as HTMLElement | null;
};

const readRowName = (element: Element | null | undefined): string => (
  String((element as HTMLElement | null)?.dataset?.tableOverviewSelect || '').trim()
);

/** 从行内任意子元素解出所属表名；非可选行返回空串。 */
export const resolveOverviewRowNameFromElement = (element: Element | null | undefined): string => {
  if (!element || typeof (element as Element).closest !== 'function') return '';
  const row = element.closest(OVERVIEW_SELECTABLE_SELECTOR);
  return readRowName(row);
};

/** 按渲染顺序返回容器内全部可选表名（去重、过滤空值）。 */
export const collectOverviewRowNames = (container: HTMLElement | null): string[] => {
  if (!container) return [];
  const names: string[] = [];
  container.querySelectorAll<HTMLElement>(OVERVIEW_SELECTABLE_SELECTOR).forEach((row) => {
    const name = readRowName(row);
    if (name && !names.includes(name)) names.push(name);
  });
  return names;
};

/**
 * 返回 from..to（含两端）在渲染顺序中的表名闭区间。
 * 任一端不在可视行中时返回空数组，调用方据此放弃本次范围操作。
 */
export const collectOverviewRangeNames = (
  container: HTMLElement | null,
  from: string,
  to: string,
): string[] => {
  if (!container || !from || !to) return [];
  const names = collectOverviewRowNames(container);
  const fromIndex = names.indexOf(from);
  const toIndex = names.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return [];
  const [start, end] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
  return names.slice(start, end + 1);
};

/**
 * 一次点击后的选中集：
 * - 带 Shift 且有锚点 → 锚点..本次 的区间；
 * - 带 Ctrl / Cmd → 在现有集合里切换该行；
 * - 普通点击 → 只选该行。
 */
export const resolveOverviewClickSelection = (
  container: HTMLElement | null,
  current: ReadonlyArray<string>,
  name: string,
  modifiers: { shift: boolean; toggle: boolean },
  anchor: string | null,
): string[] => {
  if (!name) return [...current];
  if (modifiers.shift && anchor && anchor !== name) {
    const range = collectOverviewRangeNames(container, anchor, name);
    return range.length > 0 ? range : [name];
  }
  if (modifiers.toggle) {
    return current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
  }
  return [name];
};
