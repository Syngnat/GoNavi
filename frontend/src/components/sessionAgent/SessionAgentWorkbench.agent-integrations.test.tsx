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

/**
 * 移除智能体后工作台必须重新扫描。
 *
 * 之前工作台只在挂载/改筛选时扫一次，移除智能体后后端其实已经扫不到
 * 任何会话（启用集为空），但界面仍留着旧列表——用户看到「会话还在」。
 */
const { storeState } = vi.hoisted(() => ({
  storeState: {
    agentIntegrations: [] as Array<{ integrationId: string; displayName: string }>,
    agentIntegrationsLoaded: false,
  },
}));

vi.mock('../../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

import { SessionAgentWorkbench } from './SessionAgentWorkbench';
import type { SessionAgentApi } from './sessionAgentApi';

const buildApi = (): SessionAgentApi => ({
  list: vi.fn(async () => []),
  detail: vi.fn(async () => null),
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

const tab = {
  id: 'agent-assets:codex',
  title: 'ChatGPT · 会话管理',
  type: 'agent-assets' as const,
  connectionId: '',
  agentIntegrationId: 'codex',
};

describe('SessionAgentWorkbench agent integrations', () => {
  it('re-scans when an agent is removed', async () => {
    storeState.agentIntegrations = [{ integrationId: 'codex', displayName: 'ChatGPT' }];
    storeState.agentIntegrationsLoaded = true;

    const api = buildApi();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<SessionAgentWorkbench tab={tab} api={api} />);
    });
    await act(async () => {});

    const listMock = api.list as unknown as ReturnType<typeof vi.fn>;
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock.mock.calls[0][0]).toBe('codex');

    // 移除智能体：已添加列表变空。
    storeState.agentIntegrations = [];
    const before = listMock.mock.calls.length;
    await act(async () => {
      tree.update(<SessionAgentWorkbench tab={tab} api={api} />);
    });
    await act(async () => {});

    // 必须重新扫描，否则界面留着已移除智能体的旧会话。
    expect(listMock.mock.calls.length).toBeGreaterThan(before);
    // 筛选值指向已移除的工具时也要清掉，最后一次扫描不应再带旧筛选。
    expect(listMock.mock.calls[listMock.mock.calls.length - 1][0]).toBe('');
  });

  it('clears the detail pane when the list becomes empty', async () => {
    storeState.agentIntegrations = [{ integrationId: 'codex', displayName: 'ChatGPT' }];
    storeState.agentIntegrationsLoaded = true;

    const api = buildApi();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<SessionAgentWorkbench tab={tab} api={api} />);
    });
    await act(async () => {});
    expect((api.list as any).mock.calls.length).toBeGreaterThan(0);

    // 智能体被移除 → 列表为空 → 详情残留也要清掉。
    storeState.agentIntegrations = [];
    await act(async () => {
      tree.update(<SessionAgentWorkbench tab={tab} api={api} />);
    });
    await act(async () => {});

    const detailPanel = tree.root.findAll(
      (node) => node.props?.['data-session-agent-detail'] === 'true',
    );
    expect(detailPanel.length).toBe(0);
  });

  it('keeps the filter when the agent list has not loaded yet', async () => {
    // 空列表既可能是「还没加载」也可能是「一个都没添加」：未加载时不能
    // 把当前筛选清掉，否则点侧栏节点进来会先扫全部工具。
    storeState.agentIntegrations = [];
    storeState.agentIntegrationsLoaded = false;

    const api = buildApi();
    await act(async () => {
      create(<SessionAgentWorkbench tab={tab} api={api} />);
    });
    await act(async () => {});

    const listMock = api.list as unknown as ReturnType<typeof vi.fn>;
    expect(listMock.mock.calls[0][0]).toBe('codex');
  });
});
