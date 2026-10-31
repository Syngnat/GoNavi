import { describe, expect, it } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { buildAgentTreeNodes } from './sidebarAgentTreeNodes';

// 智能体侧栏节点的构建：与数据连接同级的顶层节点，必须带品牌图标，
// 否则侧栏 Codex 节点没有图标可显示（用户反馈缺陷回归）。

describe('buildAgentTreeNodes', () => {
  it('returns no node when no integration exists', () => {
    expect(buildAgentTreeNodes([])).toEqual([]);
  });

  it('builds a top-level node per integration without a wrapper group', () => {
    const nodes = buildAgentTreeNodes([
      { integrationId: 'int-1', kind: 'codex', displayName: 'ChatGPT', enabled: true, assetCount: 3, dataDir: 'C:/Users/me/.codex' },
      { integrationId: 'int-2', kind: 'claude', displayName: 'Claude Code', enabled: true, assetCount: 1, dataDir: 'C:/Users/me/.claude' },
    ]);
    expect(nodes).toHaveLength(2);
    // 每个集成自身就是顶层节点：没有 agent-root 分组节点。
    expect(nodes.every((node) => node.type === 'agent-integration')).toBe(true);
    expect(nodes.some((node) => String(node.type) === 'agent-root')).toBe(false);
    expect(nodes[0].title).toBe('ChatGPT');
    expect(nodes[0].isLeaf).toBe(true);
    expect(nodes[0].selectable).toBe(true);
  });

  it('attaches the OpenAI brand icon to integration nodes', () => {
    const nodes = buildAgentTreeNodes([
      { integrationId: 'int-1', kind: 'codex', displayName: 'ChatGPT', enabled: true, assetCount: 3, dataDir: 'C:/Users/me/.codex' },
    ]);
    const node = nodes[0];
    // 图标包在 v2 主题的树图标槽位钩子类里；内层是 GnOpenAIAgentIcon。
    const iconElement = node.icon as ReactElement<{ className?: string; children?: ReactNode }> | null;
    expect(iconElement?.props?.className).toContain('gn-v2-tree-folder-icon');
    const inner = iconElement?.props?.children as ReactElement | undefined;
    expect((inner?.type as { displayName?: string })?.displayName).toBe('GnIcon(openai-agent)');
  });

  it('keeps integration nodes without an icon for unknown agent kinds', () => {
    const nodes = buildAgentTreeNodes([
      { integrationId: 'int-2', kind: 'future-agent', displayName: 'Future', enabled: true, assetCount: 0, dataDir: '' },
    ]);
    expect(nodes[0].icon).toBeNull();
  });
});
