import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import TitleBarPrimaryActions from './TitleBarPrimaryActions';

vi.mock('antd', () => ({
  Button: ({ icon, children, type: _type, ...props }: any) => (
    <button {...props}>{icon}{children}</button>
  ),
}));

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span data-icon="true" />;
  return {
    ConsoleSqlOutlined: Icon,
    PlusOutlined: Icon,
  };
});

describe('TitleBarPrimaryActions', () => {
  it('shows both labels in query-first order and invokes their actions', () => {
    const onNewQuery = vi.fn();
    const onNewConnection = vi.fn();
    const renderer = create(
      <TitleBarPrimaryActions
        newQueryLabel="新建查询"
        newConnectionLabel="新建连接"
        onNewQuery={onNewQuery}
        onNewConnection={onNewConnection}
      />,
    );

    const actions = renderer.root.findByProps({ 'data-titlebar-primary-actions': 'true' });
    const buttons = actions.findAllByType('button');
    expect(actions.props['data-no-titlebar-toggle']).toBe('true');
    expect(buttons.map((button) => button.props['aria-label'])).toEqual(['新建查询', '新建连接']);
    expect(buttons.map((button) => button.children[button.children.length - 1])).toEqual(['新建查询', '新建连接']);

    buttons[0].props.onClick();
    buttons[1].props.onClick();
    expect(onNewQuery).toHaveBeenCalledTimes(1);
    expect(onNewConnection).toHaveBeenCalledTimes(1);
  });
});
