import type { SourceDatasetMode } from './dataSyncRequest';

type SyncContent = 'data' | 'schema' | 'both';
type WorkflowType = 'sync' | 'migration';

/**
 * 当前入口是否允许选择「目标表不存在时自动建表」。
 *
 * - 迁移入口始终允许。
 * - 数据同步（差异同步）入口只在同步内容含结构（仅结构 / 结构和数据）时允许：
 *   后端在「仅同步数据」下禁止改动目标结构，此时选了自动建表只会在执行期失败，
 *   所以「仅同步数据」仍然固定为只用已有目标表。
 * - SQL 结果集来源恒为仅数据 + 已有目标表，不允许建表。
 */
export const isTargetTableCreationAllowed = (
  workflowType: WorkflowType,
  syncContent: SyncContent,
  sourceDatasetMode: SourceDatasetMode,
): boolean => (
  sourceDatasetMode === 'table' && (workflowType === 'migration' || syncContent !== 'data')
);
