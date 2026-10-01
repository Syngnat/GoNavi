import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { AIChatRunActivity } from '../../../types';
import { buildOverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';
import { AIActivityTimeline } from './AIActivityTimeline';

// Ant Design icons inject styles through the DOM, which this node test runner lacks.
vi.mock('@ant-design/icons', () => ({
  CaretRightOutlined: () => null,
  CheckOutlined: () => null,
  ClockCircleOutlined: () => null,
  CloseCircleFilled: () => null,
  StopFilled: () => null,
}));

const overlayTheme = buildOverlayWorkbenchTheme(false);

// Mount inside act() so the component's mount effects have run, as they have by the time a person clicks.
const render = (activities: AIChatRunActivity[]) => {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<AIActivityTimeline activities={activities} darkMode={false} overlayTheme={overlayTheme} />);
  });
  return renderer!;
};

const byClass = (root: ReactTestInstance, className: string) => root.findAll((node) => (
  typeof node.type === 'string'
  && String(node.props.className || '').split(' ').includes(className)
));

const text = (node: ReactTestInstance): string => node.children
  .map((child) => (typeof child === 'string' ? child : text(child)))
  .join('');

const finished: AIChatRunActivity[] = [
  { id: 'model:1', kind: 'model', status: 'completed', timestamp: 1_000 },
  { id: 'tool:1', kind: 'tool', status: 'completed', timestamp: 7_200, toolName: 'get_tables' },
  { id: 'approval:1', kind: 'approval', status: 'completed', timestamp: 9_200 },
  { id: 'model:2', kind: 'model', status: 'completed', timestamp: 129_200 },
  { id: 'run', kind: 'run', status: 'completed', timestamp: 1_000 },
];

describe('AIActivityTimeline', () => {
  it('starts collapsed for a finished run and summarises it', () => {
    const renderer = render(finished);

    expect(byClass(renderer.root, 'ai-run-header')[0].props['aria-expanded']).toBe(false);
    expect(byClass(renderer.root, 'ai-run-steps')).toHaveLength(0);
    expect(text(byClass(renderer.root, 'ai-run-header-summary')[0])).toBe('4 steps completed');
  });

  it('shows how long each finished step took, from one step to the next', () => {
    const renderer = render(finished);
    act(() => {
      byClass(renderer.root, 'ai-run-header')[0].props.onClick();
    });

    const rows = byClass(renderer.root, 'ai-run-step');
    expect(rows).toHaveLength(4);
    expect(byClass(renderer.root, 'ai-run-step-trailing').map(text)).toEqual(['6.2s', '2s', '2m', '']);
    expect(rows[1].props['aria-label']).toBe('Tool: Analyze table structure info · completed');
  });

  it('opens itself while a step is running and flags that step', () => {
    const renderer = render([
      { id: 'model:1', kind: 'model', status: 'completed', timestamp: 1_000 },
      { id: 'approval:1', kind: 'approval', status: 'waiting', timestamp: 3_000 },
    ]);

    expect(byClass(renderer.root, 'ai-run-header')[0].props['aria-expanded']).toBe(true);
    const rows = byClass(renderer.root, 'ai-run-step');
    expect(rows[1].props['data-activity-status']).toBe('waiting');
    expect(text(byClass(renderer.root, 'ai-run-step-trailing')[1])).toBe('waiting');
    expect(text(byClass(renderer.root, 'ai-run-header-summary')[0])).toBe('waiting');
  });

  it('never renders a redacted error code', () => {
    const renderer = render([
      { id: 'tool:1', kind: 'tool', status: 'failed', timestamp: 1, toolName: 'get_tables', errorCode: 'provider-secret' },
    ]);

    expect(JSON.stringify(renderer.toJSON())).not.toContain('provider-secret');
  });
});
