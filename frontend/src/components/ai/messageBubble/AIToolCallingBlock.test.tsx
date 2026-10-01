import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { AIChatMessage, AIToolCall } from '../../../types';
import { buildOverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';
import { AIToolCallingBlock } from './AIToolCallingBlock';

// Ant Design icons inject styles through the DOM, which this node test runner lacks.
vi.mock('@ant-design/icons', () => ({
  ApiOutlined: () => null,
  CaretRightOutlined: () => null,
  CheckOutlined: () => null,
}));

const overlayTheme = buildOverlayWorkbenchTheme(false);

const sqlCall: AIToolCall = {
  id: 'call-sql',
  type: 'function',
  function: {
    name: 'execute_sql',
    arguments: JSON.stringify({ connectionId: 'c1', dbName: 'H2', sql: 'SELECT COUNT(*) FROM H2.T' }),
  },
};

const resultFor = (overrides: Partial<AIChatMessage> = {}): AIChatMessage => ({
  id: 'tool-1',
  role: 'tool',
  content: '{"rows":[{"N":10}]}',
  timestamp: 1,
  tool_call_id: 'call-sql',
  ...overrides,
});

const render = (props: { loading?: boolean; results?: AIChatMessage[] } = {}) => create(
  <AIToolCallingBlock
    toolCalls={[sqlCall]}
    loading={props.loading ?? false}
    toolResultsById={new Map((props.results ?? []).map((message) => [message.tool_call_id as string, message]))}
    darkMode={false}
    overlayTheme={overlayTheme}
    hasContent
  />,
);

const findByClass = (root: ReactTestInstance, className: string) => root.findAll((node) => (
  typeof node.type === 'string'
  && String(node.props.className || '').split(' ').includes(className)
));

describe('AIToolCallingBlock', () => {
  it('names the probe after its tool call when the result message carries no tool name', () => {
    const renderer = render({ results: [resultFor()] });
    const row = findByClass(renderer.root, 'ai-probe-row')[0];

    expect(row.props['aria-label']).toContain('execute_sql');
    expect(row.props['aria-label']).not.toContain('unknown');
  });

  it('reveals the SQL and an indented result only after the row is opened', () => {
    const renderer = render({ results: [resultFor()] });
    expect(findByClass(renderer.root, 'ai-probe-code')).toHaveLength(0);

    act(() => {
      findByClass(renderer.root, 'ai-probe-row')[0].props.onClick();
    });

    const blocks = findByClass(renderer.root, 'ai-probe-code').map((node) => node.children.join(''));
    expect(blocks[0]).toBe('SELECT COUNT(*) FROM H2.T');
    expect(blocks[1]).toBe('{\n  "rows": [\n    {\n      "N": 10\n    }\n  ]\n}');
    expect(findByClass(renderer.root, 'ai-probe-meta')[0].children.join('')).toBe('connectionId=c1 · dbName=H2');
  });

  it('shows a running group with a spinner while the probe has no result yet', () => {
    const renderer = render({ loading: true });
    const block = findByClass(renderer.root, 'ai-probe')[0];

    expect(block.props['data-running']).toBe('true');
    expect(findByClass(renderer.root, 'ai-probe-spinner').length).toBeGreaterThan(0);
  });
});
