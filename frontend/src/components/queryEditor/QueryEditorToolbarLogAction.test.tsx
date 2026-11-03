import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QueryEditorToolbarLogAction } from './QueryEditorToolbarLogAction';

const antdState = vi.hoisted(() => ({
  buttonProps: [] as any[],
  tooltipProps: [] as any[],
}));

vi.mock('antd', () => ({
  Button: (props: any) => {
    antdState.buttonProps.push(props);
    return (
      <button
        type="button"
        aria-label={props['aria-label']}
        aria-pressed={props['aria-pressed']}
        onClick={props.onClick}
      />
    );
  },
  Tooltip: (props: any) => {
    antdState.tooltipProps.push(props);
    return <>{props.children}</>;
  },
}));

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span />;
  return { BugOutlined: Icon };
});

vi.mock('../../i18n', () => ({ t: (key: string) => key }));

vi.mock('../../i18n/provider', () => ({ useOptionalI18n: () => ({ t: (key: string) => key }) }));

describe('QueryEditorToolbarLogAction', () => {
  beforeEach(() => {
    antdState.buttonProps = [];
    antdState.tooltipProps = [];
  });

  it('marks the log tab as shown and toggles on click', () => {
    const onToggle = vi.fn();
    act(() => {
      create(<QueryEditorToolbarLogAction enabled onToggle={onToggle} />);
    });

    expect(antdState.buttonProps[0]).toMatchObject({ 'aria-pressed': true, type: 'primary' });
    expect(antdState.tooltipProps[0]).toMatchObject({ title: 'query_editor.action.hide_sql_execution_log' });

    act(() => {
      antdState.buttonProps[0].onClick();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('offers to show the log tab when it is disabled', () => {
    act(() => {
      create(<QueryEditorToolbarLogAction enabled={false} onToggle={vi.fn()} />);
    });

    expect(antdState.buttonProps[0]).toMatchObject({ 'aria-pressed': false, type: 'default' });
    expect(antdState.tooltipProps[0]).toMatchObject({ title: 'query_editor.action.show_sql_execution_log' });
  });
});
