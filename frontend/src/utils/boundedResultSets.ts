/* boundedResultSets.ts — 结果集数量上限（内存治理）
 *
 * 背景：QueryEditor 的 mergeResultSets 会随执行次数不断 push 新 resultSet，而每个结果集
 * 常驻一个结果 Tabs pane 的 DOM 与行数据，长会话下内存随执行次数线性上涨。
 *
 * 与既有 queryEditorResultHistory 预算的关系（重要）：
 * 仓库里已有 applyQueryEditorResultHistoryBudget（经 useQueryEditorResultHistoryBudget 挂载）
 * 在 effect 阶段按「条数 + 行数 + 字节」三维裁剪，条数维度已经是 20。本文件是同一语义的
 * **合并期同步守卫**：mergeResultSets 到 effect 之间存在一个渲染窗口，期间新结果集已经进入
 * state；同步裁剪让上界不依赖 effect 是否被触发，也避免「先进 state 再被 effect 裁掉」的
 * 一次多余渲染。
 *
 * 因此裁剪必须与既有预算保持**同一套豁免规则与计数口径**，否则两条机制会互相拉扯：
 *   - pinned 结果集（用户固定，不能被淘汰）
 *   - hasPendingChanges 结果集（持有未提交编辑，淘汰即静默丢弃用户改动）
 *   - 调用方显式保护的 key（当前激活结果 + 本次执行刚产出的结果）
 * 漏掉任何一条都会造成行为回归——尤其 pinned 与 hasPendingChanges 在既有预算里是被
 * requiredKeys 强制保留的，同步裁剪若只看条数就会把用户固定/未提交的结果集删掉。
 */

/**
 * 每个编辑器的结果集数量兜底上限，与 QUERY_EDITOR_RESULT_HISTORY_MAX_RESULTS 对齐。
 *
 * 这不是产品层面的「结果数量限制」：用户主动打开的结果标签就该留着。该上限只在
 * 估算内存超过兜底线时才起作用，避免长会话把应用撑爆。
 */
export const MAX_RESULT_SETS_PER_EDITOR = 200;

export interface CapResultSetsOptions {
  /** 上限，默认 MAX_RESULT_SETS_PER_EDITOR。 */
  max?: number;
  /**
   * 额外豁免的 key（当前激活结果、本次执行产出的结果）。
   * 这些条目不会被淘汰；但**仍计入总数**，与既有预算的计数口径一致。
   */
  protectedKeys?: Iterable<string>;
}

export interface CappedResultSets<T> {
  /** 裁剪后保留的结果集（保持原顺序）。 */
  items: T[];
  /** 被淘汰的结果集（按原顺序，队首最旧）。 */
  evicted: T[];
}

type CapsulableResultSet = {
  key?: string;
  pinned?: boolean;
  hasPendingChanges?: boolean;
};

/**
 * 把超过上限的最旧结果集从队首淘汰（数组顺序即加入顺序，队首最旧）。
 *
 * 计数与既有预算一致：所有条目都计入总数；但只有**非豁免**条目可被淘汰。
 * 因此当豁免条目本身已达到或超过上限时，淘汰会提前停止，此时保留总数会超过 max——
 * 这是有意为之的降级：豁免优先于上限（宁可超出上界，也不能丢弃用户固定或未提交的结果）。
 * 与 applyQueryEditorResultHistoryBudget 的行为一致（它同样只保留 requiredKeys、不再保留其他）。
 */
export const capResultSets = <T extends CapsulableResultSet>(
  items: T[],
  options: CapResultSetsOptions = {},
): CappedResultSets<T> => {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: Array.isArray(items) ? items : [], evicted: [] };
  }

  const max = Number.isFinite(options.max) && (options.max as number) >= 0
    ? Math.floor(options.max as number)
    : MAX_RESULT_SETS_PER_EDITOR;
  if (items.length <= max) {
    return { items, evicted: [] };
  }

  const protectedKeys = new Set(options.protectedKeys || []);
  const isExempt = (item: T): boolean => (
    item?.pinned === true
    || item?.hasPendingChanges === true
    || (!!item?.key && protectedKeys.has(String(item.key)))
  );

  // 需要腾出的条目数；豁免条目会「消耗」配额但不被淘汰，所以实际淘汰数可能少于该值。
  let remainingToEvict = items.length - max;
  const kept: T[] = [];
  const evicted: T[] = [];
  items.forEach((item) => {
    if (remainingToEvict > 0 && !isExempt(item)) {
      remainingToEvict -= 1;
      evicted.push(item);
      return;
    }
    kept.push(item);
  });

  return { items: kept, evicted };
};
