import React from 'react';
import { GnClaudeIcon, GnOpenAIAgentIcon } from '../icons/gnIcons';
import { agentTreeNodeKey } from '../../utils/agentConnectionTypes';
import type { AgentIntegrationSummaryView } from '../../utils/agentConnectionTypes';
import type { SidebarTreeNode as TreeNode } from './sidebarV2TreeNodes';

/**
 * 智能体工具节点的品牌图标：复用文件夹图标的树图标槽位钩子类，
 * v2 主题的 20px 槽位规则自动生效。
 */
const agentKindIcon = (kind: string): React.ReactNode => {
  const Icon = kind === 'codex' ? GnOpenAIAgentIcon : kind === 'claude' ? GnClaudeIcon : null;
  if (!Icon) return null;
  return (
    <span className="gn-v2-tree-folder-icon" data-sidebar-tree-folder-icon="true">
      <Icon />
    </span>
  );
};

/**
 * 已添加的智能体：与数据连接同级的顶层节点，每种工具一个。
 * 不再套「智能体」分组——分组是上一版的遗留设计，会让智能体看起来像
 * 数据库分组的一种，反而弱化了「智能体和数据连接同级」这层关系。
 * 点击打开会话管理工作台；右键菜单提供编辑与移除。
 */
export const buildAgentTreeNodes = (
  integrations: AgentIntegrationSummaryView[],
): TreeNode[] =>
  (integrations || [])
    .filter((item) => !!item?.integrationId)
    .map((integration) => ({
      title: integration.displayName || integration.kind,
      key: agentTreeNodeKey(integration.integrationId),
      type: 'agent-integration',
      isLeaf: true,
      selectable: true,
      icon: agentKindIcon(integration.kind),
      dataRef: integration,
    })) as TreeNode[];
