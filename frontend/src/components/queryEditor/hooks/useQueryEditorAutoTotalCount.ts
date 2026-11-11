import { useEffect, useRef } from 'react';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorResultReloadApi } from './useQueryEditorResultReload';

/**
 * 后台自动统计查询结果总数。
 *
 * 背景：查询结果按页加载，首屏只取 pageSize 行，`total` 是
 * `(current+1)*pageSize` 的估算值且 `totalKnown=false`。原先必须由用户点
 * 「统计总数」才会执行 `SELECT COUNT(*)`，于是结果区一直显示「当前 100 条 /
 * 未统计总数」，页签徽标也停在页大小上，看起来像"只查出了这么多"。
 *
 * 表数据浏览（useDataViewerFetchData）早就是异步自动统计 + 手动兜底的模式，
 * 查询结果这边漏了对接。这里补上同样的行为，区别是：
 *   - 静默失败：自动统计是后台行为，报错不该打断用户，失败后按钮仍可手动重试；
 *   - 短查询超时：COUNT(*) 在无索引条件下可能很慢，不能让连接被长期占用。
 *
 * `preferManualTotalCount` 能力位管的是表数据浏览（整表 COUNT 可能极慢），
 * 不适用于这里：查询结果统计的是用户刚跑过的那条 SQL 的结果集。
 */

/** 自动统计的查询超时（秒）。超时后静默放弃，等待用户手动触发。 */
export const QUERY_EDITOR_AUTO_TOTAL_COUNT_QUERY_TIMEOUT_SECONDS = 10;

export interface UseQueryEditorAutoTotalCountInput {
    resultSets: QueryEditorCoreStateApi['resultSets'];
    handleRequestResultTotalCount: QueryEditorResultReloadApi['handleRequestResultTotalCount'];
}

/**
 * 已经自动统计过的结果集指纹，避免重复请求。
 *
 * 键里必须带上 baseSql：resultSet 的 key 是位置序号（result-1、result-2），
 * 重跑同一条语句时 key 会复用，只按 key 去重会让新一轮结果永远不再统计。
 */
const buildAutoTotalCountKey = (resultKey: string, baseSql: string): string =>
    `${resultKey}\u0000${baseSql}`;

/** 去重集合的上限：超过后整体清空重建，避免长时间会话里无界增长。 */
const QUERY_EDITOR_AUTO_TOTAL_COUNT_SEEN_LIMIT = 500;

export const useQueryEditorAutoTotalCount = ({
    resultSets,
    handleRequestResultTotalCount,
}: UseQueryEditorAutoTotalCountInput) => {
    const requestedKeysRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        for (const rs of resultSets) {
            const page = rs.page;
            if (!page?.baseSql) continue;
            // 总数已知、正在统计、或用户主动取消过的不再自动触发。
            if (page.totalKnown === true) continue;
            if (page.totalCountLoading === true) continue;
            if (page.totalCountCancelled === true) continue;

            const requestKey = buildAutoTotalCountKey(rs.key, page.baseSql);
            if (requestedKeysRef.current.has(requestKey)) continue;
            if (requestedKeysRef.current.size >= QUERY_EDITOR_AUTO_TOTAL_COUNT_SEEN_LIMIT) {
                requestedKeysRef.current.clear();
            }
            requestedKeysRef.current.add(requestKey);

            void handleRequestResultTotalCount(rs.key, {
                silent: true,
                queryTimeoutSeconds: QUERY_EDITOR_AUTO_TOTAL_COUNT_QUERY_TIMEOUT_SECONDS,
            });
        }
    }, [resultSets, handleRequestResultTotalCount]);
};
