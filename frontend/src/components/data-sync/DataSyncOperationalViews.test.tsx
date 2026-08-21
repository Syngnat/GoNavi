import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { DataSyncScheduleView } from './DataSyncOperationalViews';
import type { DataSyncScheduleSummary } from './model';
import { createDataSyncWorkbenchTranslate } from './text';

const schedule: DataSyncScheduleSummary = {
  id: 'orders:schedule',
  taskId: 'orders',
  taskName: 'Orders to warehouse',
  revision: 7,
  lifecycle: 'enabled',
  enabled: true,
  expression: '0 */5 * * * *',
  timezone: 'Asia/Shanghai',
  nextRunAt: '2026-08-21T03:05:00.000Z',
  latestRun: {
    id: 'orders:run:failed',
    status: 'failed',
    startedAt: '2026-08-21T03:00:00.000Z',
    finishedAt: '2026-08-21T03:00:12.000Z',
    errorSummary: 'target write failed: password=[REDACTED]',
  },
};

describe('DataSyncScheduleView', () => {
  it('shows the latest failure and routes each control through its supplied callback', () => {
    const onRefresh = vi.fn();
    const onToggle = vi.fn();
    const onRunNow = vi.fn();
    const onViewRun = vi.fn();
    const renderer = TestRenderer.create(
      <DataSyncScheduleView
        schedules={[schedule]}
        t={createDataSyncWorkbenchTranslate('en-US')}
        refreshing={false}
        onRefresh={onRefresh}
        onToggle={onToggle}
        onRunNow={onRunNow}
        onViewRun={onViewRun}
      />,
    );

    expect(
      renderer.root.findByProps({ 'data-task-id': schedule.taskId }).props['data-enabled'],
    ).toBe('true');
    expect(renderer.root.findAllByProps({ children: 'Failed' })).toHaveLength(1);
    expect(
      renderer.root
        .findAllByType('small')
        .some((node) =>
          node.children.join('') ===
          `${schedule.latestRun!.startedAt} \u2192 ${schedule.latestRun!.finishedAt}`,
        ),
    ).toBe(true);
    expect(renderer.root.findAllByProps({ children: schedule.latestRun!.errorSummary }))
      .toHaveLength(1);

    const button = (label: string) =>
      renderer.root
        .findAllByType('button')
        .find((candidate) => candidate.children.includes(label))!;
    act(() => {
      button('Refresh').props.onClick();
      button('Disable').props.onClick();
      button('Run now').props.onClick();
      button('View run').props.onClick();
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(schedule);
    expect(onRunNow).toHaveBeenCalledWith(schedule);
    expect(onViewRun).toHaveBeenCalledWith(schedule.latestRun!.id);
  });

  it('disables both schedule mutations while one is in flight', () => {
    const renderer = TestRenderer.create(
      <DataSyncScheduleView
        schedules={[schedule]}
        t={createDataSyncWorkbenchTranslate('en-US')}
        refreshing={false}
        onRefresh={vi.fn()}
        onToggle={vi.fn()}
        onRunNow={vi.fn()}
        busyAction={`disable:${schedule.taskId}`}
      />,
    );
    const button = (label: string) =>
      renderer.root
        .findAllByType('button')
        .find((candidate) => candidate.children.includes(label))!;

    expect(button('Disable').props.disabled).toBe(true);
    expect(button('Run now').props.disabled).toBe(true);

    renderer.update(
      <DataSyncScheduleView
        schedules={[schedule]}
        t={createDataSyncWorkbenchTranslate('en-US')}
        refreshing={false}
        onRefresh={vi.fn()}
        onToggle={vi.fn()}
        onRunNow={vi.fn()}
        busyAction={`run-now:${schedule.taskId}`}
      />,
    );

    expect(button('Disable').props.disabled).toBe(true);
    expect(button('Run now').props.disabled).toBe(true);
  });
});
