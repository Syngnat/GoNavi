import React from 'react';
import { taskKindCanCreateTarget } from '../modelTaskKinds';
import { compareTargetObjectName } from '../dataSyncCompareTargets';
import type { DataSyncTableMapping, DataSyncTaskKind, DataSyncObjectMetadata } from '../model';
import type { DataSyncWorkbenchTextKey, DataSyncWorkbenchTranslate } from '../text';
import type { DataSyncMetadataResult } from '../useDataSyncMetadata';

export const normalizeName = (value: string): string => value.trim().toLowerCase();

type MappingTargetStatus = 'exists' | 'create' | 'missing' | 'pending';

// 对比只读：目标缺表照样要能跑，所以不要求目标名存在、也不要求目标表已存在。
const compareReady = (mapping: DataSyncTableMapping, targetState: MappingTargetStatus): boolean =>
  Boolean(mapping.sourceObject.trim() && targetState !== 'pending');

export const mappingReady = (
  mapping: DataSyncTableMapping,
  taskKind: DataSyncTaskKind,
  targetState: MappingTargetStatus,
): boolean =>
  taskKind === 'compare'
    ? compareReady(mapping, targetState)
    : Boolean(
        (taskKind === 'querySink' || mapping.sourceObject.trim()) &&
          mapping.targetObject.trim() &&
          targetState !== 'pending' &&
          (mapping.targetMode !== 'existing_only' || targetState === 'exists') &&
          (!['reconcile', 'cdc'].includes(taskKind) || mapping.keyColumns.length > 0) &&
          (taskKind !== 'cdc' || mapping.fields.length > 0),
      );

export const ObjectMetadataStatus: React.FC<{
  side: 'source' | 'target';
  state: DataSyncMetadataResult<DataSyncObjectMetadata>;
  t: DataSyncWorkbenchTranslate;
  showRetry?: boolean;
}> = ({ side, state, t, showRetry = true }) => (
  <div
    className="gn-data-sync-object-status"
    data-metadata-scope={`${side}-objects`}
    data-status={state.status}
  >
    <span>{t(`mapping.${side}`)}</span>
    <strong>
      {state.status === 'loading'
        ? t('metadata.loading_objects')
        : state.status === 'error'
          ? t('metadata.load_failed')
          : state.status === 'idle'
            ? t('metadata.endpoint_required')
            : t('metadata.objects_count', { count: state.items.length })}
    </strong>
    {showRetry && state.status === 'error' ? (
      <button
        type="button"
        className="gn-data-sync-link-button"
        onClick={state.reload}
      >
        {t('metadata.retry')}
      </button>
    ) : null}
  </div>
);

export { taskKindCanCreateTarget };

/** 目标缺失且任务类型不能建表时，改用说明原因的提示。 */
export const targetHintKey = (
  targetState: MappingTargetStatus,
  taskKind: DataSyncTaskKind,
): DataSyncWorkbenchTextKey => {
  if (targetState === 'missing' && taskKind === 'compare') {
    return 'mapping.target_hint.missing_compare';
  }
  return targetState === 'missing' && !taskKindCanCreateTarget(taskKind)
    ? 'mapping.target_hint.missing_requires_existing'
    : `mapping.target_hint.${targetState}`;
};

export const targetStatus = (
  mapping: DataSyncTableMapping,
  targetObjects: DataSyncMetadataResult<DataSyncObjectMetadata>,
): MappingTargetStatus => {
  if (targetObjects.status !== 'ready') return 'pending';
  // 目标名留空时按源对象同名比对（对比任务的目标缺表场景），否则永远判成缺失。
  const targetObject = compareTargetObjectName(mapping);
  const exists = targetObjects.items.some(
    (object) =>
      object.kind !== 'view' &&
      normalizeName(object.name) === normalizeName(targetObject),
  );
  if (exists) return 'exists';
  if (mapping.targetObject.trim() && mapping.targetMode === 'create_or_reuse') {
    return 'create';
  }
  return 'missing';
};
