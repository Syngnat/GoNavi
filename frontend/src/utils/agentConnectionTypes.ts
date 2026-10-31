/**
 * 智能体连接类型工具。智能体是「添加式」对象：在新建连接弹窗的
 * 智能体分类里选择工具，检测本地安装并二次确认后添加；每工具一实例。
 * 类型键同时用于连接分类目录与智能体添加面板，新增工具在此扩展。
 */
export const AGENT_CONNECTION_TYPES: readonly string[] = ['codex', 'claude'];

const AGENT_CONNECTION_TYPE_SET = new Set(AGENT_CONNECTION_TYPES);

export const isAgentConnectionType = (type: unknown): boolean =>
  AGENT_CONNECTION_TYPE_SET.has(String(type || '').trim().toLowerCase());

/** 主页固定"智能体"分组下，一个工具节点的树键。 */
export const agentTreeNodeKey = (integrationId: string): string =>
  `agent-integration-${integrationId}`;

/** 主页智能体分组节点的工具摘要（对应后端 SessionAgentListIntegrations）。 */
export interface AgentIntegrationSummaryView {
  integrationId: string;
  kind: string;
  displayName: string;
  enabled: boolean;
  assetCount: number;
  /** 扫描数据目录（编辑智能体时回填）。 */
  dataDir: string;
}

/** 检测结果（对应后端 sessionagent.Detection）。 */
export interface AgentDetectionView {
  kind: string;
  status: string;
  commandPath: string;
  version: string;
  dataDir: string;
  dataReadable: boolean;
  details: string[];
}

/** 已添加的智能体实例（对应后端 app.AgentIntegration）。 */
export interface AgentIntegrationRecord {
  kind: string;
  dataDir: string;
  displayName: string;
  addedAt: number;
}
