import React from 'react';
import type { DataSyncTableMapping, DataSyncTaskKind, DataSyncObjectMetadata } from '../model';
import type { DataSyncWorkbenchTranslate } from '../text';
import type { DataSyncMetadataResult } from '../useDataSyncMetadata';

export const normalizeName = (value: string): string => value.trim().toLowerCase();

type MappingTargetStatus = 'exists' | 'create' | 'missing' | 'pending';

export const mappingReady = (
  mapping: DataSyncTableMapping,
  taskKind: DataSyncTaskKind,
  targetState: MappingTargetStatus,
): boolean =>
  Boolean(
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

export const targetStatus = (
  mapping: DataSyncTableMapping,
  targetObjects: DataSyncMetadataResult<DataSyncObjectMetadata>,
): MappingTargetStatus => {
  if (targetObjects.status !== 'ready') return 'pending';
  const exists = targetObjects.items.some(
    (object) =>
      object.kind !== 'view' &&
      normalizeName(object.name) === normalizeName(mapping.targetObject),
  );
  if (exists) return 'exists';
  if (mapping.targetObject.trim() && mapping.targetMode === 'create_or_reuse') {
    return 'create';
  }
  return 'missing';
};
