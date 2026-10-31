// @vitest-environment jsdom
import React from 'react';

vi.mock('antd', () => {
  const Light = (tag: string) => (props: any) =>
    React.createElement(tag, { ...props, title: undefined, 'aria-label': props['aria-label'] }, props.children);
  const Button = (props: any) =>
    React.createElement('button', { ...props, loading: undefined, block: undefined, size: undefined, danger: undefined, icon: undefined }, props.children);
  return {
    Button,
    Input: Object.assign(
      (props: any) => React.createElement('input', { value: props.value, onChange: props.onChange, placeholder: props.placeholder }),
      { Search: (props: any) => React.createElement('input', { value: props.value, onChange: props.onChange, placeholder: props.placeholder }) },
    ),
    Select: (props: any) => React.createElement('select', { value: props.value, onChange: props.onChange }),
    Tooltip: (props: any) => React.createElement('span', null, props.children),
    Spin: Light('span'),
    Empty: Object.assign(Light('span'), { PRESENTED_IMAGE_SIMPLE: null }),
    Alert: (props: any) => React.createElement('div', { 'data-testid': 'alert' }, props.message, props.description),
    Tabs: (props: any) => React.createElement('div', null, (props.items || []).map((item: any) => React.createElement('div', { key: item.key }, item.children))),
    Tag: Light('span'),
    Typography: { Text: (props: any) => React.createElement('span', null, props.children) },
    Modal: Object.assign(Light('span'), { confirm: vi.fn() }),
    message: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
});
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { SessionAgentWorkbench } from './SessionAgentWorkbench';
import type { SessionAgentApi } from './sessionAgentApi';

/**
 * 端到端：点击会话 → 详情页展示后端拆好的正文，而不是原始 JSON 外壳。
 * 拆解在 Go 侧完成（internal/sessionagent 的 splitStructuredBody），前端
 * 只按结果渲染。
 */
const RAW_JSON = '{"acceptance":[],"findings":[],"summary":"审查被环境能力阻塞：会话仅提供协作等待相关工具。","verdict":"blocked","verification":[]}';

const buildApi = (): SessionAgentApi => ({
  list: vi.fn(async () => [{
    providerId: 'codex',
    sessionId: 'th-1',
    title: '你是 Market Review 项目的独立审查 Agent',
    summary: '',
    firstMessage: '开始审查',
    projectDir: '/work/market-review',
    createdAt: 1760000000000,
    lastActiveAt: 1760000100000,
    sourcePath: '/work/.codex/sessions/rollout-a.jsonl.zst',
    resumeCommand: 'codex resume th-1',
  }]),
  detail: vi.fn(async () => ({
    messages: [{
      role: 'assistant' as const,
      content: RAW_JSON,
      ts: 1760000100000,
      structured: {
        prose: '审查被环境能力阻塞：会话仅提供协作等待相关工具。',
        proseField: 'summary',
        fields: [
          { key: 'acceptance', kind: 'array' as const, count: 0 },
          { key: 'findings', kind: 'array' as const, count: 0 },
          { key: 'verdict', kind: 'scalar' as const, value: 'blocked' },
        ],
      },
    }],
    turns: [{
      turnId: 't1',
      firstMessageIndex: 0,
      lastMessageIndex: 0,
      questionPreview: '',
      ts: 1760000100000,
      stepCount: 0,
      errorCount: 0,
      hasFinalReply: true,
      aborted: false,
    }],
    cached: false,
  })),
  readPage: vi.fn(async () => []),
  blockContent: vi.fn(async () => null),
  exportMarkdown: vi.fn(async () => ''),
  copyResume: vi.fn(async () => ''),
  delete: vi.fn(async () => true),
  revealPath: vi.fn(async () => ''),
  imageDataUrl: vi.fn(async () => ''),
  imageInlineDataUrl: vi.fn(async () => ''),
  timeGroups: vi.fn(async () => ({ groups: {}, total: 0 })),
});

const flatten = (node: any): string => {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flatten).join('');
  if (node.children) return node.children.map(flatten).join('');
  return '';
};

describe('SessionAgentWorkbench structured conclusion', () => {
  it('shows the prose instead of the raw json envelope', async () => {
    const api = buildApi();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <SessionAgentWorkbench
          tab={{ id: 'agent-assets:codex', title: 'ChatGPT · 会话管理', type: 'agent-assets', connectionId: '', agentIntegrationId: 'codex' }}
          api={api}
        />,
      );
    });
    await act(async () => {});

    const row = tree.root.findAll((node) => node.props?.['data-session-agent-row'] === 'true')[0];
    await act(async () => {
      row.props.onClick();
    });
    await act(async () => {});

    // 详情面板已经展开。
    expect(tree.root.findAll((node) => node.props?.['data-session-agent-detail'] === 'true').length).toBeGreaterThan(0);

    const text = flatten(tree.toJSON());
    // 正文按对话呈现。
    expect(text).toContain('审查被环境能力阻塞');
    // 原始 JSON 外壳不再出现在界面上。
    expect(text).not.toContain('"acceptance"');
    expect(text).not.toContain('"verdict":"blocked"');
    // 其余字段收成一行可展开的摘要。
    expect(text).toContain('verdict');
    expect(text).toContain('blocked');
  });
});
