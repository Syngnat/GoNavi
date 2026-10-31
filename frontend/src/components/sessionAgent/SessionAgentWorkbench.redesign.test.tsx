// @vitest-environment jsdom
import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('antd', () => {
  const Light = (tag: string) => (props: any) => React.createElement(tag, props, props.children);
  return {
    Button: (props: any) => React.createElement('button', { ...props, icon: undefined, loading: undefined, size: undefined, danger: undefined }, props.children),
    Input: (props: any) => React.createElement('input', props),
    Select: Light('select'),
    Tooltip: Light('span'),
    Spin: Light('span'),
    Empty: Object.assign(Light('span'), { PRESENTED_IMAGE_SIMPLE: null }),
    Pagination: Light('div'),
    Tag: Light('span'),
    Modal: Object.assign(Light('span'), { confirm: vi.fn() }),
    message: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  };
});

import { SessionAgentWorkbench } from './SessionAgentWorkbench';
import type { SessionAgentApi } from './sessionAgentApi';

const item = {
  providerId: 'codex', sessionId: 'session-1', title: 'CLI 修复', summary: '摘要优先展示', firstMessage: '首问',
  projectDir: '/work/cli', createdAt: 1, lastActiveAt: 2, sourcePath: '/sessions/1.jsonl', resumeCommand: 'codex resume session-1',
};

const buildApi = (): SessionAgentApi => ({
  list: vi.fn(async () => [item]),
  detail: vi.fn(async () => ({
    messages: [
      { role: 'user' as const, content: '修复退出码', ts: 1 },
      { role: 'assistant' as const, content: '已修复 **退出码**。', ts: 2, blocks: [
        { type: 'tool_call' as const, toolCall: {
          id: 'call-1', rawName: 'apply_patch', kind: 'patch', title: '修改 main.go', inputPreview: '+os.Exit(1)',
          inputFull: { kind: 'jsonl' as const, pointer: '/patch/1' },
          diff: { files: [{ path: 'cmd/main.go', op: 'update', added: 1, removed: 0 }], added: 1, removed: 0 },
        } },
        { type: 'tool_result' as const, toolResult: { callId: 'call-1', status: 'success', preview: 'ok' } },
      ] },
    ],
    turns: [{ turnId: 'turn-1', firstMessageIndex: 0, lastMessageIndex: 1, questionPreview: '修复退出码', ts: 1, stepCount: 1, errorCount: 0, hasFinalReply: true, aborted: false }],
    cached: false,
  })),
  readPage: vi.fn(async () => []),
  blockContent: vi.fn(async () => ({ text: '完整 patch', totalLen: 9, truncated: false })),
  exportMarkdown: vi.fn(async () => '# export'),
  copyResume: vi.fn(async () => 'codex resume session-1'),
  delete: vi.fn(async () => true),
  revealPath: vi.fn(async () => ''),
  imageDataUrl: vi.fn(async () => ''),
  imageInlineDataUrl: vi.fn(async () => ''),
  timeGroups: vi.fn(async () => ({ groups: {}, total: 1 })),
});

const renderDetail = async (api: SessionAgentApi) => {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<SessionAgentWorkbench tab={{ id: 'agent', title: 'Agent', type: 'agent-assets', connectionId: '', agentIntegrationId: 'codex' }} api={api} />);
  });
  await act(async () => {});
  const row = tree.root.findByProps({ 'data-session-agent-row': 'true' });
  await act(async () => row.props.onClick());
  await act(async () => {});
  return tree;
};

const flatten = (node: any): string => {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flatten).join('');
  return node.children ? node.children.map(flatten).join('') : '';
};

describe('SessionAgentWorkbench redesign', () => {
  it('uses an immersive detail instead of keeping the list beside it', async () => {
    const tree = await renderDetail(buildApi());
    expect(tree.root.findAllByProps({ 'data-session-agent-detail': 'true' })).toHaveLength(1);
    expect(tree.root.findAllByProps({ 'data-session-agent-list': 'true' })).toHaveLength(0);
  });

  it('renders aggregated file changes in the dedicated changes tab', async () => {
    const tree = await renderDetail(buildApi());
    const tabs = tree.root.findAll((node) => node.props.className === 'gn-session-agent-detail-views');
    const buttons = tabs[0].findAllByType('button');
    await act(async () => buttons[1].props.onClick());
    expect(tree.root.findByProps({ 'data-session-agent-changes': 'true' })).toBeTruthy();
    expect(flatten(tree.toJSON())).toContain('cmd/main.go');
    expect(flatten(tree.toJSON())).toContain('+os.Exit(1)');
  });

  it('filters turns while preserving markdown rendering', async () => {
    const tree = await renderDetail(buildApi());
    const search = tree.root.findByProps({ className: 'gn-session-agent-detail-search' });
    await act(async () => search.props.onChange({ target: { value: '退出码' } }));
    expect(tree.root.findAllByProps({ 'data-session-agent-turn': 'turn-1' })).toHaveLength(1);
    expect(tree.root.findAllByProps({ 'data-session-agent-markdown': 'true' }).length).toBeGreaterThan(0);
    await act(async () => search.props.onChange({ target: { value: '没有匹配' } }));
    expect(tree.root.findAllByProps({ 'data-session-agent-turn': 'turn-1' })).toHaveLength(0);
  });

  it('loads and collapses full tool input through the existing content api', async () => {
    const api = buildApi();
    const tree = await renderDetail(api);
    await act(async () => tree.root.findByProps({ className: 'gn-session-agent-exec-head' }).props.onClick());
    await act(async () => tree.root.findByProps({ className: 'gn-session-agent-toolline' }).props.onClick());
    const expand = tree.root.findByProps({ 'data-session-agent-expand-full': 'true' });
    await act(async () => expand.props.onClick());
    expect(api.blockContent).toHaveBeenCalled();
    expect(flatten(tree.toJSON())).toContain('完整 patch');
    await act(async () => expand.props.onClick());
    expect(flatten(tree.toJSON())).not.toContain('完整 patch');
  });
});
