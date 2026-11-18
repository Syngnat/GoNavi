import { describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
import { act } from 'react';

import { useQueryEditorAutoTotalCount } from './useQueryEditorAutoTotalCount';

type ResultSets = Parameters<typeof useQueryEditorAutoTotalCount>[0]['resultSets'];

const resultSet = (overrides: Record<string, unknown> = {}) => ({
  key: 'result-1',
  sql: 'SELECT id FROM users',
  exportSql: 'SELECT id FROM users',
  sourceStatementIndex: 1,
  statementResultIndex: 1,
  rows: [{ id: 1 }],
  columns: ['id'],
  messages: [],
  pkColumns: [],
  readOnly: true,
  page: {
    current: 1,
    pageSize: 100,
    total: 200,
    totalKnown: false,
    baseSql: 'SELECT id FROM users',
  },
  ...overrides,
}) as unknown as ResultSets[number];

/**
 * 渲染承载 hook 的探针组件，并返回可触发的重渲染函数。
 *
 * hook 自己持有 handleRequestResultTotalCount 的 spy，不通过 props 传入，
 * 否则调用方传进来的 vi.fn() 会顶替掉 harness 记录调用次数的那一个。
 */
const renderAutoTotalCount = (initialResultSets: ResultSets) => {
  const handleRequestResultTotalCount = vi.fn(async () => {});
  const Probe = ({ resultSets }: { resultSets: ResultSets }) => {
    useQueryEditorAutoTotalCount({ resultSets, handleRequestResultTotalCount });
    return null;
  };
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Probe resultSets={initialResultSets} />);
  });
  return {
    handleRequestResultTotalCount,
    render: (resultSets: ResultSets) => {
      act(() => {
        renderer.update(<Probe resultSets={resultSets} />);
      });
    },
    unmount: () => renderer.unmount(),
  };
};

describe('useQueryEditorAutoTotalCount', () => {
  it('requests an exact total as soon as a result set has an unknown total', () => {
    const probe = renderAutoTotalCount([resultSet()]);

    expect(probe.handleRequestResultTotalCount).toHaveBeenCalledTimes(1);
    expect(probe.handleRequestResultTotalCount).toHaveBeenCalledWith('result-1', {
      silent: true,
      queryTimeoutSeconds: 10,
    });
  });

  it('skips results whose total is already known', () => {
    const probe = renderAutoTotalCount([
      resultSet({ page: { current: 1, pageSize: 100, total: 42, totalKnown: true, baseSql: 'SELECT id FROM users' } }),
    ]);
    expect(probe.handleRequestResultTotalCount).not.toHaveBeenCalled();
  });

  it('skips a count that is already running', () => {
    const probe = renderAutoTotalCount([
      resultSet({ page: { current: 1, pageSize: 100, total: 200, totalKnown: false, totalCountLoading: true, baseSql: 'SELECT id FROM users' } }),
    ]);
    expect(probe.handleRequestResultTotalCount).not.toHaveBeenCalled();
  });

  // 用户主动取消后不能自动重试，否则取消按钮形同虚设。
  it('skips a count the user cancelled', () => {
    const probe = renderAutoTotalCount([
      resultSet({ page: { current: 1, pageSize: 100, total: 200, totalKnown: false, totalCountCancelled: true, baseSql: 'SELECT id FROM users' } }),
    ]);
    expect(probe.handleRequestResultTotalCount).not.toHaveBeenCalled();
  });

  it('does not re-request the same result set on unrelated re-renders', () => {
    const probe = renderAutoTotalCount([resultSet()]);
    expect(probe.handleRequestResultTotalCount).toHaveBeenCalledTimes(1);

    probe.render([resultSet()]);
    expect(probe.handleRequestResultTotalCount).toHaveBeenCalledTimes(1);
  });

  // 结果集 key 是位置序号，重跑同一条语句会复用同一个 key。只按 key 去重会让
  // 新一轮结果永远拿不到精确总数。
  it('requests again when the same key now holds a different query', () => {
    const probe = renderAutoTotalCount([resultSet()]);

    probe.render([
      resultSet({ page: { current: 1, pageSize: 100, total: 200, totalKnown: false, baseSql: 'SELECT id FROM orders' } }),
    ]);

    expect(probe.handleRequestResultTotalCount).toHaveBeenCalledTimes(2);
  });
});
