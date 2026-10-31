// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';

vi.mock('antd', () => ({
  Tooltip: ({ children }: any) => React.createElement('span', null, children),
}));

import { SessionAgentStructuredBody } from './SessionAgentStructuredBody';
import type { SessionStructuredBodyView } from './sessionAgentApi';

const flatten = (node: any): string => {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flatten).join('');
  if (node.children) return node.children.map(flatten).join('');
  return '';
};

const reviewBody: SessionStructuredBodyView = {
  prose: '审查被环境能力阻塞：会话仅提供协作等待相关工具。',
  proseField: 'summary',
  fields: [
    { key: 'acceptance', kind: 'array', count: 3, detail: '[\n  {"criterion": "x"}\n]' },
    { key: 'findings', kind: 'array', count: 0 },
    { key: 'verdict', kind: 'scalar', value: 'blocked' },
  ],
};

describe('SessionAgentStructuredBody', () => {
  it('renders the prose as the message body', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<SessionAgentStructuredBody body={reviewBody} />);
    });
    const text = flatten(tree.toJSON());
    expect(text).toContain('审查被环境能力阻塞');
    // 原始 JSON 外壳不再出现在界面上。
    expect(text).not.toContain('"summary"');
    expect(text).not.toContain('{"acceptance"');
  });

  it('collapses the remaining fields into one summary row', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<SessionAgentStructuredBody body={reviewBody} />);
    });
    const text = flatten(tree.toJSON());
    expect(text).toContain('verdict');
    expect(text).toContain('blocked');
    // 数组字段默认收起时不展开内容。
    expect(text).not.toContain('criterion');
  });

  it('expands the summary row to reveal the raw detail', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<SessionAgentStructuredBody body={reviewBody} />);
    });
    const head = tree.root.findByType('button');
    act(() => {
      head.props.onClick();
    });
    expect(flatten(tree.toJSON())).toContain('criterion');
  });

  it('labels a short enum conclusion with its field name', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <SessionAgentStructuredBody body={{ prose: 'allow', proseField: 'outcome', fields: [] }} />,
      );
    });
    expect(flatten(tree.toJSON())).toContain('outcome');
    expect(flatten(tree.toJSON())).toContain('allow');
  });

  it('renders a body without fields as plain prose', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <SessionAgentStructuredBody body={{ prose: '只有正文', proseField: 'summary' }} />,
      );
    });
    const text = flatten(tree.toJSON());
    expect(text).toContain('只有正文');
    expect(tree.root.findAllByType('button')).toHaveLength(0);
  });
});
