import { t } from '../i18n';
import type { TabData } from '../types';

/**
 * 智能体会话资产工作台页签：每个集成一个固定 ID 页签，重复打开激活
 * 已有页签（driver-manager 同款机制）。
 */
export const agentAssetsTabId = (integrationId: string): string =>
  `agent-assets:${integrationId}`;

export const buildAgentAssetsWorkbenchTab = (integration: {
  integrationId: string;
  displayName?: string;
}): TabData => ({
  id: agentAssetsTabId(integration.integrationId),
  title: t('session_agent.workbench.tab_title', {
    name: integration.displayName || 'ChatGPT',
  }),
  type: 'agent-assets',
  connectionId: '',
  agentIntegrationId: integration.integrationId,
});
