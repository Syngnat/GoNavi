import { metadataObjectBaseName, type DataSyncTableMapping, type DataSyncTaskKind } from './model';

/**
 * 对比任务的目标对象名。
 *
 * 对比是只读任务，目标库缺这张表本身就是它要报告的差异，所以目标名留空时按
 * 源对象同名比对。写任务不走这条回落：它们要么自动建表，要么必须显式指定目标。
 */
export const compareTargetObjectName = (mapping: DataSyncTableMapping): string => {
  const targetObject = mapping.targetObject.trim();
  if (targetObject) return targetObject;
  return metadataObjectBaseName(mapping.sourceObject);
};

/**
 * 修复存量对比任务的目标对象名。
 *
 * 旧版本选表时目标库没有同名表就把 targetObject 留空，导致校验报「填写目标对象
 * 名称」、对比被静默拦住。这里按同名补齐，让已保存的草稿直接可执行。
 */
export const repairCompareTargetObjects = (
  kind: DataSyncTaskKind,
  mappings: DataSyncTableMapping[],
): DataSyncTableMapping[] => {
  if (kind !== 'compare') return mappings;
  let changed = false;
  const next = mappings.map((mapping) => {
    if (mapping.targetObject.trim()) return mapping;
    const targetObject = compareTargetObjectName(mapping);
    if (!targetObject) return mapping;
    changed = true;
    return { ...mapping, targetObject };
  });
  return changed ? next : mappings;
};
