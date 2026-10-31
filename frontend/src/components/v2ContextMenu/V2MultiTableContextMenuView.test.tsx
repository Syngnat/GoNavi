/** @vitest-environment jsdom */
import React from 'react';
import { create, act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { V2MultiTableContextMenuView } from './V2MultiTableContextMenuView';

// 多表菜单只保留批量语义的动作：单表专属能力（重命名 / 设计表 / DDL 等）
// 不应出现，防止多选后误触发只对单表有意义的行为。action 挂在按钮的
// onClick 闭包里，用逐项点击 + mock 回调断言动作序列。

const findMenuButtons = (renderer: any) => renderer.root.findAll(
  (node: any) => typeof node.props?.className === 'string'
    && node.props.className.split(' ').includes('gn-v2-context-menu-item'),
);

const clickAll = (renderer: any) => {
  findMenuButtons(renderer).forEach((button: any) => {
    act(() => { button.props.onClick({ preventDefault: () => {}, stopPropagation: () => {} }); });
  });
};

describe('V2MultiTableContextMenuView', () => {
  it('只提供多表可用的动作，不含重命名/设计表等单表专属项', () => {
    const onAction = vi.fn();
    const renderer = create(
      <V2MultiTableContextMenuView tableNames={['a', 'b', 'c']} onAction={onAction} />,
    );
    const buttons0 = findMenuButtons(renderer);
    expect(buttons0.length).toBe(5);
    clickAll(renderer);
    const actions = onAction.mock.calls.map(([action]) => action);
    expect(actions).toEqual(['open-data', 'copy-table-name', 'batch-tables', 'truncate-table', 'drop-table']);
    expect(actions).not.toContain('rename-table');
    expect(actions).not.toContain('design-table');
  });

  it('能力开关关闭时隐藏截断与批量工作台入口', () => {
    const onAction = vi.fn();
    const renderer = create(
      <V2MultiTableContextMenuView
        tableNames={['a', 'b']}
        supportsTruncate={false}
        supportsBatchTables={false}
        onAction={onAction}
      />,
    );
    const buttons0 = findMenuButtons(renderer);
    expect(buttons0.length).toBe(3);
    clickAll(renderer);
    const actions = onAction.mock.calls.map(([action]) => action);
    expect(actions).toEqual(['open-data', 'copy-table-name', 'drop-table']);
  });
});
