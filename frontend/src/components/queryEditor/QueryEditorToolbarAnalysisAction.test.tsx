import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage, t } from '../../i18n';
import { QueryEditorToolbarAnalysisAction } from './QueryEditorToolbarAnalysisAction';

const antdState = vi.hoisted(() => ({
  buttonProps: [] as any[],
  dropdownProps: [] as any[],
  tooltipProps: [] as any[],
}));

vi.mock('antd', () => ({
  Button: (props: any) => {
    antdState.buttonProps.push(props);
    return <button type="button" aria-label={props['aria-label']}>{props.children}</button>;
  },
  Dropdown: (props: any) => {
    antdState.dropdownProps.push(props);
    return <>{props.children}</>;
  },
  Tooltip: (props: any) => {
    antdState.tooltipProps.push(props);
    return <>{props.children}</>;
  },
}));

describe('QueryEditorToolbarAnalysisAction', () => {
  beforeEach(() => {
    antdState.buttonProps = [];
    antdState.dropdownProps = [];
    antdState.tooltipProps = [];
    setCurrentLanguage('zh-CN');
  });

  it('renders a labelled trigger instead of an icon-only button', () => {
    const label = t('query_editor.action.analysis');
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <QueryEditorToolbarAnalysisAction
          items={[{ key: 'show-query-history', label: 'history' }]}
          open={false}
          label={label}
          tooltip={t('query_editor.action.analysis_tooltip')}
          onOpenChange={vi.fn()}
        />,
      );
    });
    expect(label).toBe('历史与诊断');
    expect(JSON.stringify(renderer!.toJSON())).toContain(label);
    expect(antdState.buttonProps[0]).toMatchObject({
      'aria-label': label,
      'aria-haspopup': 'menu',
      'aria-expanded': false,
    });
  });

  it('forwards open state and suppresses the tooltip while the menu is open', () => {
    const onOpenChange = vi.fn();
    act(() => {
      create(
        <QueryEditorToolbarAnalysisAction
          items={[]}
          open
          label="label"
          tooltip="tooltip"
          onOpenChange={onOpenChange}
        />,
      );
    });
    expect(antdState.dropdownProps[0]).toMatchObject({ open: true, trigger: ['click'] });
    expect(antdState.tooltipProps[0].open).toBe(false);
    antdState.dropdownProps[0].onOpenChange(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
