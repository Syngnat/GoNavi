/**
 * 工作台标签条的溢出布局。
 *
 * antd 自带的收纳把溢出的 tab 塞进一个大卡片下拉（每项两行、带关闭按钮），
 * 和 IDEA 那种紧凑的单行列表差得远，也无法自定义。这里改为自己算「放得下
 * 哪几个」，剩下的交给自绘的下拉。
 *
 * 三条规则：
 *   1. 激活的 tab 必须可见——否则用户不知道自己当前在哪，也不能点关闭。
 *   2. 可见区从激活项向两侧扩展，优先保住它左右相邻的 tab（上下文连续）。
 *   3. 放不下的按原顺序进入「更多」，顺序与标签条一致，避免二次找。
 */

export type TabOverflowItem = {
  id: string;
};

export type TabOverflowLayout<T extends TabOverflowItem> = {
  /** 标签条上直接渲染的 tab，保持原始顺序。 */
  visible: T[];
  /** 收进「更多」菜单的 tab，保持原始顺序。 */
  hidden: T[];
  /** 放得下几个；容器宽度未知时等于总数。 */
  capacity: number;
};

/**
 * 计算可见与隐藏的 tab。
 *
 * `availableWidth` 是标签条扣除「更多」按钮与其他固定控件后的可用宽度；
 * `tabWidth` 是每个 tab 的固定宽度（由 resolveV2WorkbenchTabWidth 算出的统一值，
 * 保证标签条等宽，不会出现长短参差）。
 */
export const resolveTabOverflowLayout = <T extends TabOverflowItem>({
  tabs,
  activeTabId,
  availableWidth,
  tabWidth,
  tabGap = 2,
  widthOf,
  moreButtonWidth = 0,
}: {
  tabs: T[];
  activeTabId?: string;
  availableWidth: number;
  tabWidth: number;
  /** 相邻标签之间的间距（与 CSS 的 gap 保持一致），必须计入总宽。 */
  tabGap?: number;
  /**
   * 单个标签的宽度。默认所有标签等宽（tabWidth）；设置中心这类固定宽度
   * 的标签需要更窄时，用它可以算准能放下几个。
   */
  widthOf?: (tab: T, index: number) => number;
  /**
   * 为「更多」按钮额外预留的宽度。
   *
   * 注意：若 availableWidth 测的是「标签滚动区」的宽度，按钮是它的兄弟
   * 节点、flex 已经把它排除在外，这里必须传 0，否则会多收一个标签。
   */
  moreButtonWidth?: number;
}): TabOverflowLayout<T> => {
  const total = tabs.length;
  if (total === 0) {
    return { visible: [], hidden: [], capacity: 0 };
  }
  // 宽度未测量（首帧）或参数异常时不做收纳，全部渲染由 CSS 兜底。
  if (
    !Number.isFinite(availableWidth) ||
    availableWidth <= 0 ||
    !Number.isFinite(tabWidth) ||
    tabWidth <= 0
  ) {
    return { visible: [...tabs], hidden: [], capacity: total };
  }

  const gap = Math.max(0, tabGap);
  const widthAt = (index: number): number => {
    const resolved = widthOf ? widthOf(tabs[index]!, index) : tabWidth;
    return Number.isFinite(resolved) && resolved > 0 ? resolved : tabWidth;
  };
  // 逐个累加而不是「总宽 ÷ 单项宽」：标签宽度可能不同（如设置中心更窄），
  // 除法只能处理等宽。
  const capacityFor = (available: number): number => {
    let used = 0;
    let count = 0;
    for (let index = 0; index < total; index += 1) {
      const next = used + widthAt(index) + (index === 0 ? 0 : gap);
      if (next > available) break;
      used = next;
      count += 1;
    }
    return count;
  };
  const usable = Math.max(0, availableWidth - Math.max(0, moreButtonWidth));
  // 全部放得下：不需要「更多」按钮，可用宽度不必再扣它。
  if (capacityFor(availableWidth) >= total) {
    return { visible: [...tabs], hidden: [], capacity: total };
  }
  const fitted = capacityFor(usable);
  const capacity = Math.max(0, fitted);
  if (capacity === 0) {
    return { visible: [], hidden: [...tabs], capacity: 0 };
  }
  if (capacity >= total) {
    return { visible: [...tabs], hidden: [], capacity: total };
  }

  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  // 没有激活项（或它不在列表里）时退化为「从头取」。
  if (activeIndex < 0) {
    return {
      visible: tabs.slice(0, capacity),
      hidden: tabs.slice(capacity),
      capacity,
    };
  }

  // 以激活项为中心向两侧扩展：先右后左，尽量保住紧随其后的 tab。
  const picked = new Set<number>([activeIndex]);
  let left = activeIndex - 1;
  let right = activeIndex + 1;
  while (picked.size < capacity && (left >= 0 || right < total)) {
    if (right < total) {
      picked.add(right);
      right += 1;
    }
    if (picked.size < capacity && left >= 0) {
      picked.add(left);
      left -= 1;
    }
  }

  const visible: T[] = [];
  const hidden: T[] = [];
  tabs.forEach((tab, index) => {
    (picked.has(index) ? visible : hidden).push(tab);
  });
  return { visible, hidden, capacity };
};

/** 「更多」按钮的显示文案：只给数字，宽度稳定，不随标题变化。 */
export const formatHiddenTabCount = (count: number): string => (
  count > 99 ? '99+' : String(count)
);
