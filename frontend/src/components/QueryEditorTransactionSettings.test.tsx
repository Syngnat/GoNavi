import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QueryEditorTransactionSettings from './QueryEditorTransactionSettings';

const antdState = vi.hoisted(() => ({
  selectProps: [] as any[],
  tooltipProps: [] as any[],
}));

vi.mock('antd', () => ({
  Select: (props: any) => {
    antdState.selectProps.push(props);
    return <button type="button">{props.value}</button>;
  },
  Tooltip: (props: any) => {
    antdState.tooltipProps.push(props);
    return <div>{props.children}</div>;
  },
}));

vi.mock('../i18n/provider', () => ({
  useOptionalI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => params?.seconds ? `${params.seconds}s后提交` : key,
  }),
}));

const latestSelectProps = (className: string) => [...antdState.selectProps].reverse().find(
  (props) => String(props.className).includes(className),
);

const latestTooltipProps = (selectClassName: string) => [...antdState.tooltipProps].reverse().find(
  (props) => String(props.children?.props?.className).includes(selectClassName),
);

describe('QueryEditorTransactionSettings', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    antdState.selectProps = [];
    antdState.tooltipProps = [];
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it('keeps the DBeaver reference tooltip above the transaction mode select', () => {
    act(() => {
      renderer = create(
        <QueryEditorTransactionSettings

          commitMode="manual"
          autoCommitDelayMs={0}
          onCommitModeChange={vi.fn()}
          onAutoCommitDelayMsChange={vi.fn()}
        />,
      );
    });

    expect(antdState.tooltipProps[0].placement).toBe('topLeft');
    expect(antdState.tooltipProps[0]).not.toHaveProperty('autoAdjustOverflow', false);
    expect(antdState.tooltipProps[0].title).toContain('query_editor.transaction.mode.tooltip');
    expect(antdState.selectProps[0].onOpenChange).toBeTypeOf('function');
  });

  it('shows only state icons in the v2 selectors while keeping localized accessible labels', () => {
    act(() => {
      renderer = create(
        <QueryEditorTransactionSettings

          commitMode="auto"
          autoCommitDelayMs={0}
          onCommitModeChange={vi.fn()}
          onAutoCommitDelayMsChange={vi.fn()}
        />,
      );
    });

    const [modeSelect, delaySelect] = antdState.selectProps;
    expect(modeSelect.className).toContain('gn-v2-query-toolbar-icon-select');
    expect(modeSelect['aria-label']).toBe('query_editor.transaction.mode.auto');
    expect(modeSelect.popupMatchSelectWidth).toBe(false);
    expect(typeof modeSelect.labelRender).toBe('function');
    expect(React.isValidElement(modeSelect.labelRender({ value: 'auto' }))).toBe(true);
    expect(modeSelect.options.map(({ label }: { label: string }) => label)).toEqual([
      'query_editor.transaction.mode.manual',
      'query_editor.transaction.mode.auto',
    ]);

    expect(delaySelect.className).toContain('gn-v2-query-toolbar-icon-select');
    expect(delaySelect['aria-label']).toBe('query_editor.transaction.delay.immediate_commit');
    expect(delaySelect.popupMatchSelectWidth).toBe(false);
    expect(typeof delaySelect.labelRender).toBe('function');
    expect(React.isValidElement(delaySelect.labelRender({ value: 0 }))).toBe(true);
    expect(delaySelect.options.map(({ label }: { label: string }) => label)).toEqual([
      'query_editor.transaction.delay.immediate_commit',
      '3s后提交',
      '5s后提交',
      '10s后提交',
      '30s后提交',
    ]);

    expect(antdState.tooltipProps[0].title).toContain('query_editor.transaction.mode.auto');
    expect(antdState.tooltipProps[1].title).toContain('query_editor.transaction.delay.immediate_commit');
  });

  it('hides each selector tooltip while its v2 dropdown is open', () => {
    act(() => {
      renderer = create(
        <QueryEditorTransactionSettings

          commitMode="auto"
          autoCommitDelayMs={0}
          onCommitModeChange={vi.fn()}
          onAutoCommitDelayMsChange={vi.fn()}
        />,
      );
    });

    act(() => {
      latestSelectProps('gn-v2-query-toolbar-transaction-mode-select').onOpenChange(true);
    });
    expect(latestTooltipProps('gn-v2-query-toolbar-transaction-mode-select').title).toBeNull();

    act(() => {
      latestSelectProps('gn-v2-query-toolbar-transaction-mode-select').onOpenChange(false);
      latestSelectProps('gn-v2-query-toolbar-transaction-delay-select').onOpenChange(true);
    });
    expect(latestTooltipProps('gn-v2-query-toolbar-transaction-mode-select').title).toContain(
      'query_editor.transaction.mode.tooltip',
    );
    expect(latestTooltipProps('gn-v2-query-toolbar-transaction-delay-select').title).toBeNull();
  });

  it('always renders the current icon selector contract', () => {
    act(() => {
      renderer = create(
        <QueryEditorTransactionSettings

          commitMode="manual"
          autoCommitDelayMs={0}
          onCommitModeChange={vi.fn()}
          onAutoCommitDelayMsChange={vi.fn()}
        />,
      );
    });

    expect(antdState.selectProps[0].labelRender).toEqual(expect.any(Function));
    expect(antdState.selectProps[0].className).toContain('gn-v2-query-toolbar-transaction-mode-select');
    expect(antdState.selectProps[0].popupMatchSelectWidth).toBe(false);
    expect(antdState.selectProps[0].onOpenChange).toEqual(expect.any(Function));
  });
});
