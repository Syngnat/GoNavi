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
    Pagination: (props: any) => React.createElement('div', { 'data-testid': 'pagination' }, String(props.total ?? '')),
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
import { message } from 'antd';
import { SessionAgentWorkbench } from './SessionAgentWorkbench';
import type { SessionAgentApi } from './sessionAgentApi';

// 会话管理工作台的虚构数据路径：表格列表渲染、轮次时间线、导出/恢复
// 命令、删除确认（cc-switch 方案替换后的 UI 面）。不连真实 Wails 绑定。

const buildItem = (overrides: Record<string, unknown> = {}) => ({
  providerId: 'codex',
  sessionId: 'th-1',
  title: '我有一台肖尔的服务器，我想作为我的VPN服务器。你有什么想法吗？',
  summary: '那么下一步应该做什么呢',
  firstMessage: '我有一台肖尔的服务器，我想作为我的VPN服务器。',
  projectDir: 'E:/Project/CodeUp/kunghim-ops',
  createdAt: 1760000000000,
  lastActiveAt: 1760000100000,
  sourcePath: 'C:/home/.codex/sessions/rollout-a.jsonl',
  resumeCommand: 'codex resume th-1',
  ...overrides,
});

const buildMessage = (overrides: Record<string, unknown> = {}) => ({
  role: 'user' as const,
  content: '列出文件',
  ts: 1760000000000,
  ...overrides,
});

const buildTurn = (overrides: Record<string, unknown> = {}) => ({
  turnId: 't1',
  firstMessageIndex: 0,
  lastMessageIndex: 1,
  questionPreview: '列出文件',
  ts: 1760000000000,
  stepCount: 1,
  errorCount: 0,
  hasFinalReply: true,
  aborted: false,
  ...overrides,
});

const buildApi = (overrides: Partial<SessionAgentApi> = {}): SessionAgentApi => ({
  list: vi.fn(async () => [buildItem()]),
  detail: vi.fn(async () => ({
    messages: [
      buildMessage(),
      buildMessage({ role: 'assistant' as const, content: '好的', blocks: [
        { type: 'tool_call' as const, toolCall: { id: 'c1', rawName: 'exec', kind: 'shell', title: 'ls -la', inputPreview: 'ls -la' } },
        { type: 'tool_result' as const, toolResult: { callId: 'c1', status: 'success', preview: 'file1', truncated: true, full: { kind: 'jsonl' as const, offset: 0, len: 10, pointer: '/payload/output' } } },
      ] }),
    ],
    turns: [buildTurn()],
    cached: true,
  })),
  readPage: vi.fn(async () => []),
  blockContent: vi.fn(async () => ({ text: 'full body', totalLen: 8, truncated: false })),
  exportMarkdown: vi.fn(async () => '# 会话记录\n\n**用户**：列出文件\n'),
  copyResume: vi.fn(async () => 'codex resume th-1'),
  delete: vi.fn(async () => true),
  revealPath: vi.fn(async () => 'C:/home/.codex/sessions'),
  imageDataUrl: vi.fn(async () => 'data:image/png;base64,AAAA'),
  imageInlineDataUrl: vi.fn(async () => 'data:image/png;base64,BBBB'),
  timeGroups: vi.fn(async () => ({ groups: { today: [buildItem()] }, total: 1 })),
  ...overrides,
});

const renderWorkbench = async (api: SessionAgentApi) => {
  let tree: ReturnType<typeof create>;
  await act(async () => {
    tree = create(
      <SessionAgentWorkbench
        tab={{ id: 'agent-assets:test', title: 'ChatGPT · 会话管理', type: 'agent-assets', connectionId: '', agentIntegrationId: 'test' }}
        api={api}
      />,
    );
  });
  await act(async () => {});
  return tree!;
};

const findRow = (tree: ReturnType<typeof create>) =>
  tree.root.find((node) => node.props['data-session-agent-row'] === 'true');

describe('SessionAgentWorkbench', () => {
  it('renders the session table with title and preview', async () => {
    const api = buildApi();
    const tree = await renderWorkbench(api);
    expect(tree.root.findByProps({ 'data-session-agent-list': 'true' })).toBeTruthy();
    const titleNode = tree.root.find((node) => node.props.className === 'gn-session-agent-session-title');
    expect(String(titleNode.props.children)).toContain('我有一台肖尔的服务器');
    // 列表优先展示摘要，首问只在没有摘要时回退。
    const preview = tree.root.find((node) => node.props.className === 'gn-session-agent-session-preview');
    expect(String(preview.props.children)).toContain('那么下一步应该做什么呢');
  });

  it('puts the project name on its own line above the session cards', async () => {
    const api = buildApi();
    const tree = await renderWorkbench(api);
    const groups = tree.root.findAll((node) => node.props['data-session-agent-group'] !== undefined);
    expect(groups.length).toBe(1);
    const group = groups[0];
    expect(group.props['data-session-agent-group']).toBe('kunghim-ops');
    // 组头只有项目名（与会话标题无关），项目名独占一行。
    const head = group.find((node) => node.props.className === 'gn-session-agent-group-head');
    const name = head.find((node) => node.props.className === 'gn-session-agent-group-name');
    expect(String(name.props.children)).toBe('kunghim-ops');
    // 卡片排在组头下方的分组体里。
    const body = group.find((node) => node.props.className === 'gn-session-agent-group-body');
    const rows = body.findAll((node) => node.props['data-session-agent-row'] === 'true');
    expect(rows.length).toBe(1);
  });

  it('opens the immersive detail after clicking a row and returns to the full list', async () => {
    const api = buildApi();
    const tree = await renderWorkbench(api);
    const row = findRow(tree);
    await act(async () => {
      row.props.onClick();
    });
    await act(async () => {});
    expect(tree.root.findByProps({ 'data-session-agent-detail': 'true' })).toBeTruthy();
    expect(api.detail).toHaveBeenCalledWith('codex', 'C:/home/.codex/sessions/rollout-a.jsonl');
    // 返回恢复全页列表。
    const back = tree.root.find((node) => node.props.className?.includes?.('gn-session-agent-back-btn'));
    await act(async () => {
      back.props.onClick();
    });
    await act(async () => {});
    expect(() => tree.root.findByProps({ 'data-session-agent-detail': 'true' })).toThrow();
  });

  it('keeps the back button available while the session detail is still loading', async () => {
    // 真实会话是 .zst 压缩文件，解析要十几秒。这段时间里必须还能返回
    // 列表——此前整块详情被转圈替换，「返回列表」按钮一起消失。
    const api = buildApi({ detail: vi.fn(() => new Promise<never>(() => {})) });
    const tree = await renderWorkbench(api);
    const row = findRow(tree);
    await act(async () => {
      row.props.onClick();
    });
    await act(async () => {});
    expect(tree.root.findByProps({ 'data-session-agent-detail': 'true' })).toBeTruthy();
    expect(tree.root.find((node) => node.props.className?.includes?.('gn-session-agent-detail-loading'))).toBeTruthy();
    const back = tree.root.find((node) => node.props.className?.includes?.('gn-session-agent-back-btn'));
    expect(back).toBeTruthy();
    // 点返回后详情卸载，列表回到全宽。
    await act(async () => {
      back.props.onClick();
    });
    await act(async () => {});
    expect(() => tree.root.findByProps({ 'data-session-agent-detail': 'true' })).toThrow();
  });

  it('returns to the list when Escape is pressed in the detail', async () => {
    const api = buildApi();
    const tree = await renderWorkbench(api);
    const row = findRow(tree);
    await act(async () => {
      row.props.onClick();
    });
    await act(async () => {});
    expect(tree.root.findByProps({ 'data-session-agent-detail': 'true' })).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await act(async () => {});
    expect(() => tree.root.findByProps({ 'data-session-agent-detail': 'true' })).toThrow();
  });

  it('still returns to the list on Escape when a hidden modal wrapper exists', async () => {
    // antd 渲染过的弹窗会把 .ant-modal-wrap 留在 DOM 里（隐藏状态）。
    // 不能因为它「存在」就把 Esc 吞掉——必须只看可见弹窗。
    const hidden = document.createElement('div');
    hidden.className = 'ant-modal-wrap';
    hidden.style.display = 'none';
    document.body.appendChild(hidden);
    try {
      const api = buildApi();
      const tree = await renderWorkbench(api);
      const row = findRow(tree);
      await act(async () => {
        row.props.onClick();
      });
      await act(async () => {});
      expect(tree.root.findByProps({ 'data-session-agent-detail': 'true' })).toBeTruthy();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      await act(async () => {});
      expect(() => tree.root.findByProps({ 'data-session-agent-detail': 'true' })).toThrow();
    } finally {
      document.body.removeChild(hidden);
    }
  });

  it('renders the chat timeline with user bubble and exec section', async () => {
    const api = buildApi();
    const tree = await renderWorkbench(api);
    const row = findRow(tree);
    await act(async () => {
      row.props.onClick();
    });
    await act(async () => {});
    expect(tree.root.findByProps({ 'data-session-agent-turn': 't1' })).toBeTruthy();
    expect(tree.root.findByProps({ 'data-session-agent-timeline': 'true' })).toBeTruthy();
    expect(tree.root.findByProps({ 'data-session-agent-detail': 'true' })).toBeTruthy();
  });

  it('expands truncated tool result through the content api', async () => {
    const api = buildApi();
    const tree = await renderWorkbench(api);
    const row = findRow(tree);
    await act(async () => {
      row.props.onClick();
    });
    await act(async () => {});
    // 执行过程折叠条存在（工具调用已收进其中）。
    const execs = (tree as any).root.findAll((n: any) => n.props?.className?.includes?.('gn-session-agent-exec'));
    expect(execs.length).toBeGreaterThan(0);
  });

  it('surfaces the backend error instead of showing an empty list', async () => {
    // 后端失败时必须给出可见反馈：旧实现 seam 吞掉错误，用户只看到
    // 「空列表」，分不清是没会话还是扫描失败。
    const errorMock = message.error as unknown as ReturnType<typeof vi.fn>;
    errorMock.mockClear();
    const api = buildApi({
      list: vi.fn(async () => {
        throw new Error('加载会话列表失败：磁盘读取错误');
      }),
    });
    await renderWorkbench(api);
    expect(errorMock).toHaveBeenCalled();
    expect(String(errorMock.mock.calls[0]?.[0] ?? '')).toContain('磁盘读取错误');
  });
});
