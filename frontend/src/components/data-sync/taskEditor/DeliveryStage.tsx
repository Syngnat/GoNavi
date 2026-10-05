import React, { useEffect } from 'react';
import { DataSyncField as Field } from '../DataSyncField';
import {
  type DataSyncTaskDefinition,
  type DataSyncRouteCapability,
  type DataSyncDeliveryPolicy,
  canUseDataSyncRowErrorIsolation,
} from '../model';
import type { DataSyncWorkbenchTranslate } from '../text';
import { type TaskPatch, hasIdentityMigrationMappings } from './taskEditorModel';

export const DeliveryStage: React.FC<{
  task: DataSyncTaskDefinition;
  capability: DataSyncRouteCapability;
  t: DataSyncWorkbenchTranslate;
  onPatch: (patch: TaskPatch) => void;
}> = ({ task, capability, t, onPatch }) => {
  const patchDelivery = (patch: Partial<DataSyncDeliveryPolicy>) =>
    onPatch({ delivery: { ...task.delivery, ...patch } });
  const routeCanWrite =
    capability.level === 'unknown' ||
    (capability.canExecute &&
      (task.kind !== 'cdc' || capability.supportsCdc === true));
  const rowIsolationAvailable =
    routeCanWrite && canUseDataSyncRowErrorIsolation(task);
  const appendOnlyTarget =
    capability.level !== 'unknown' && capability.supportsMutations === false;
  const enabledMappings = task.mappings.filter((mapping) => mapping.enabled);
  const hasConfiguredMappings = enabledMappings.some(
    (mapping) =>
      mapping.sourceObject.trim().length > 0 &&
      mapping.targetObject.trim().length > 0,
  );
  const allEnabledMappingsHaveKeys =
    enabledMappings.length > 0 &&
    enabledMappings.every((mapping) =>
      mapping.keyColumns.some((column) => column.trim().length > 0),
    );
  const canPropagateDeletes =
    routeCanWrite &&
    !appendOnlyTarget &&
    task.delivery.writeMode === 'upsert' &&
    ((task.kind === 'reconcile' &&
      task.incremental.mode === 'snapshot' &&
      allEnabledMappingsHaveKeys) ||
      (task.kind === 'cdc' &&
        task.incremental.mode === 'cdc' &&
        allEnabledMappingsHaveKeys));
  const identityMigrationMappings = hasIdentityMigrationMappings(task);
  const schemaOnlyMigration =
    task.kind === 'migration' && task.content === 'schema';
  const canConfigureMigrationStructure =
    (task.kind === 'migration' || task.kind === 'reconcile') &&
    capability.canExecute &&
    (identityMigrationMappings || schemaOnlyMigration);
  const canAutoAddColumns =
    canConfigureMigrationStructure && capability.supportsAutoAddColumns === true;
  const canCreateIndexes =
    task.kind === 'migration' &&
    canConfigureMigrationStructure &&
    capability.supportsAutoCreate &&
    capability.requiresExistingTarget !== true &&
    enabledMappings.some((mapping) => mapping.targetMode === 'create_or_reuse');
  const showStructureOptions = canAutoAddColumns || canCreateIndexes;
  const writeModeDescription =
    task.delivery.writeMode === 'append'
      ? t('delivery.write.append_desc')
      : task.delivery.writeMode === 'overwrite'
        ? t('delivery.write.overwrite_desc')
        : t('delivery.write.upsert_desc');
  const structureCapabilityResolved = capability.level !== 'unknown';
  const errorPolicies: DataSyncDeliveryPolicy['errorPolicy'][] =
    rowIsolationAvailable ? ['stop', 'skip', 'quarantine'] : ['stop'];
  const errorPolicyCopy: Record<
    DataSyncDeliveryPolicy['errorPolicy'],
    { label: string; description: string }
  > = {
    stop: {
      label: t('delivery.error.stop'),
      description: t('delivery.error.stop_desc'),
    },
    skip: {
      label: t('delivery.error.skip'),
      description: t('delivery.error.skip_desc'),
    },
    quarantine: {
      label: t('delivery.error.quarantine'),
      description: t('delivery.error.quarantine_desc'),
    },
  };

  useEffect(() => {
    const patch: Partial<DataSyncDeliveryPolicy> = {};
    const effectiveErrorPolicy =
      !rowIsolationAvailable ? 'stop' : task.delivery.errorPolicy;

    if (task.delivery.errorPolicy !== effectiveErrorPolicy) {
      patch.errorPolicy = effectiveErrorPolicy;
    }
    if (
      task.delivery.captureErrorPayload !==
      (effectiveErrorPolicy === 'quarantine')
    ) {
      patch.captureErrorPayload = effectiveErrorPolicy === 'quarantine';
    }
    if (!canPropagateDeletes && task.delivery.propagateDeletes) {
      patch.propagateDeletes = false;
    }
    if (appendOnlyTarget && task.delivery.writeMode !== 'append') {
      patch.writeMode = 'append';
      patch.retryLimit = 0;
    }
    if (
      hasConfiguredMappings &&
      structureCapabilityResolved &&
      !canAutoAddColumns &&
      task.delivery.autoAddColumns
    ) {
      patch.autoAddColumns = false;
    }
    if (
      hasConfiguredMappings &&
      structureCapabilityResolved &&
      !canCreateIndexes &&
      task.delivery.createIndexes
    ) {
      patch.createIndexes = false;
    }
    if (Object.keys(patch).length > 0) {
      onPatch({ delivery: { ...task.delivery, ...patch } });
    }
    if (task.delivery.writeMode === 'append' && task.resumePolicy !== 'never') {
      onPatch({ resumePolicy: 'never' });
    }
  }, [
    canAutoAddColumns,
    canCreateIndexes,
    canPropagateDeletes,
    appendOnlyTarget,
    hasConfiguredMappings,
    onPatch,
    rowIsolationAvailable,
    structureCapabilityResolved,
    task.delivery.autoAddColumns,
    task.delivery.captureErrorPayload,
    task.delivery.createIndexes,
    task.delivery.errorPolicy,
    task.delivery.propagateDeletes,
    task.delivery.writeMode,
    task.resumePolicy,
  ]);

  return (
    <section className="gn-data-sync-section" data-data-sync-delivery="true">
      <header className="gn-data-sync-section__header">
        <div>
          <h2>{t('delivery.title')}</h2>
          <p>{t('delivery.help')}</p>
        </div>
      </header>
      <div className="gn-data-sync-delivery-main">
        {task.kind === 'migration' ? (
          <Field label={t('delivery.content_mode')}>
            <select
              className="gn-data-sync-control"
              value={task.content || 'both'}
              onChange={(event) =>
                onPatch({
                  content: event.target.value as NonNullable<
                    DataSyncTaskDefinition['content']
                  >,
                })
              }
            >
              <option value="schema">{t('delivery.content.schema')}</option>
              <option value="data">{t('delivery.content.data')}</option>
              <option value="both">{t('delivery.content.both')}</option>
            </select>
          </Field>
        ) : null}
        {schemaOnlyMigration ? (
          <p className="gn-data-sync-inline-note" role="note" data-schema-only-task="true">
            {t('delivery.schema_only_note')}
          </p>
        ) : null}
        {appendOnlyTarget ? (
          <p className="gn-data-sync-inline-note" role="note" data-append-only-target="true">
            {t('delivery.append_only_target_note')}
          </p>
        ) : null}
        <Field label={t('delivery.write_mode')}>
          <select
            className="gn-data-sync-control"
            value={task.delivery.writeMode}
            onChange={(event) => {
              const writeMode =
                event.target.value as DataSyncDeliveryPolicy['writeMode'];
              patchDelivery({
                writeMode,
                ...(writeMode === 'append' ? { retryLimit: 0 } : {}),
                ...(writeMode === 'overwrite'
                  ? { errorPolicy: 'stop' as const, captureErrorPayload: false }
                  : {}),
                ...(writeMode !== 'upsert' ? { propagateDeletes: false } : {}),
              });
              if (writeMode === 'append' && task.resumePolicy !== 'never') {
                onPatch({ resumePolicy: 'never' });
              }
            }}
          >
            <option
              value="append"
              disabled={task.incremental.mode === 'watermark'}
            >
              {t('delivery.write.append')}
            </option>
            <option value="upsert" disabled={appendOnlyTarget}>
              {appendOnlyTarget
                ? t('delivery.write.upsert_unavailable')
                : t('delivery.write.upsert')}
            </option>
            <option value="overwrite" disabled>
              {t('delivery.write.overwrite_unavailable')}
            </option>
          </select>
          <small className="gn-data-sync-mode-help">{writeModeDescription}</small>
        </Field>
        <div
          className="gn-data-sync-policy-field"
          role="radiogroup"
          aria-label={t('delivery.error_policy')}
          data-delivery-policy="error"
        >
          <span className="gn-data-sync-policy-field__label">
            {t('delivery.error_policy')}
          </span>
          <div className="gn-data-sync-policy-options">
            {errorPolicies.map((errorPolicy) => (
                <label
                  key={errorPolicy}
                  className="gn-data-sync-policy-option"
                  data-selected={
                    task.delivery.errorPolicy === errorPolicy ? 'true' : 'false'
                  }
                  data-error-policy-option={errorPolicy}
                >
                  <input
                    type="radio"
                    name={`data-sync-error-policy-${task.id}`}
                    value={errorPolicy}
                    checked={task.delivery.errorPolicy === errorPolicy}
                    onChange={() =>
                      patchDelivery({
                        errorPolicy,
                        captureErrorPayload: errorPolicy === 'quarantine',
                      })
                    }
                  />
                  <span className="gn-data-sync-policy-option__copy">
                    <strong>{errorPolicyCopy[errorPolicy].label}</strong>
                    <small>{errorPolicyCopy[errorPolicy].description}</small>
                  </span>
                </label>
              ))}
          </div>
        </div>
        {!rowIsolationAvailable ? (
          <p className="gn-data-sync-inline-note" role="note">
            {t('delivery.row_isolation_note')}
          </p>
        ) : null}
      </div>

      {canPropagateDeletes ? (
        <div
          className="gn-data-sync-delete-risk"
          data-delete-propagation="true"
          data-enabled={task.delivery.propagateDeletes ? 'true' : 'false'}
        >
          <div className="gn-data-sync-delete-risk__heading">
            <strong>{t('delivery.delete_policy_title')}</strong>
            <span>{t('delivery.delete_risk_badge')}</span>
          </div>
          <label className="gn-data-sync-option-row">
          <input
            type="checkbox"
            checked={task.delivery.propagateDeletes}
            onChange={(event) =>
              patchDelivery({
                propagateDeletes: event.target.checked,
                ...(event.target.checked && task.kind !== 'cdc'
                  ? {
                      errorPolicy: 'stop' as const,
                      captureErrorPayload: false,
                    }
                  : {}),
              })
            }
          />
            <span className="gn-data-sync-option-row__copy">
              <strong>
                {t(
                  task.kind === 'cdc'
                    ? 'delivery.delete.cdc_label'
                    : 'delivery.delete.snapshot_label',
                )}
              </strong>
              <small>
                {t(
                  task.kind === 'cdc'
                    ? 'delivery.delete.cdc_desc'
                    : 'delivery.delete.snapshot_desc',
                )}
              </small>
            </span>
          </label>
          <p>{t('delivery.delete_risk_note')}</p>
        </div>
      ) : null}

      <details className="gn-data-sync-advanced" data-delivery-advanced="true">
        <summary>
          <span>{t('delivery.advanced')}</span>
          <small>{t('delivery.advanced_help')}</small>
        </summary>
        <div className="gn-data-sync-advanced__body">
          <section className="gn-data-sync-advanced__section">
            <header>
              <h3>{t('delivery.performance_title')}</h3>
              <p>{t('delivery.performance_help')}</p>
            </header>
            <div className="gn-data-sync-field-grid gn-data-sync-field-grid--policy">
              <Field label={t('delivery.batch_size')}>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  className="gn-data-sync-control gn-data-sync-mono"
                  value={task.delivery.batchSize}
                  onChange={(event) => {
                    const batchSize = Number(event.target.value);
                    patchDelivery({ batchSize, commitEvery: batchSize });
                  }}
                />
              </Field>
              <Field label={t('delivery.retry_limit')}>
                <input
                  type="number"
                  min={0}
                  max={20}
                  className="gn-data-sync-control gn-data-sync-mono"
                  value={task.delivery.retryLimit}
                  disabled={task.delivery.writeMode === 'append'}
                  onChange={(event) =>
                    patchDelivery({ retryLimit: Number(event.target.value) })
                  }
                />
              </Field>
              {task.delivery.writeMode === 'append' ? (
                <p className="gn-data-sync-inline-note" role="note">
                  {t('delivery.append_retry_note')}
                </p>
              ) : null}
              <Field label={t('delivery.recovery_policy')}>
                <select
                  className="gn-data-sync-control"
                  value={task.delivery.writeMode === 'append' ? 'never' : task.resumePolicy}
                  disabled={task.delivery.writeMode === 'append'}
                  data-delivery-recovery={task.delivery.writeMode}
                  onChange={(event) =>
                    onPatch({
                      resumePolicy: event.target.value as DataSyncTaskDefinition['resumePolicy'],
                    })
                  }
                >
                  <option value="never">{t('delivery.recovery.never')}</option>
                  <option value="manual">{t('delivery.recovery.manual')}</option>
                  <option value="auto">{t('delivery.recovery.auto')}</option>
                </select>
                {task.delivery.writeMode === 'append' ? (
                  <small className="gn-data-sync-mode-help">
                    {t('delivery.append_recovery_note')}
                  </small>
                ) : null}
              </Field>
              <Field label={t('delivery.retry_backoff')}>
                <input
                  type="number"
                  min={0}
                  className="gn-data-sync-control gn-data-sync-mono"
                  value={task.delivery.retryBackoffMs}
                  disabled={task.delivery.retryLimit === 0}
                  onChange={(event) =>
                    patchDelivery({ retryBackoffMs: Number(event.target.value) })
                  }
                />
              </Field>
            </div>
          </section>
          {showStructureOptions ? (
            <section
              className="gn-data-sync-advanced__section"
              data-delivery-structure="true"
            >
              <header>
                <h3>{t('delivery.structure_title')}</h3>
                <p>{t('delivery.structure_help')}</p>
              </header>
              <div className="gn-data-sync-structure-options">
                {canAutoAddColumns ? (
                  <label
                    className="gn-data-sync-option-row"
                    data-structure-option="auto-add-columns"
                  >
                    <input
                      type="checkbox"
                      checked={task.delivery.autoAddColumns}
                      onChange={(event) =>
                        patchDelivery({
                          autoAddColumns: event.target.checked,
                          ...(event.target.checked
                            ? {
                                errorPolicy: 'stop' as const,
                                captureErrorPayload: false,
                              }
                            : {}),
                        })
                      }
                    />
                    <span className="gn-data-sync-option-row__copy">
                      <strong>{t('delivery.auto_add_columns')}</strong>
                      <small>{t('delivery.auto_add_columns_desc')}</small>
                    </span>
                  </label>
                ) : null}
                {canCreateIndexes ? (
                  <label
                    className="gn-data-sync-option-row"
                    data-structure-option="create-indexes"
                  >
                    <input
                      type="checkbox"
                      checked={task.delivery.createIndexes}
                      onChange={(event) =>
                        patchDelivery({
                          createIndexes: event.target.checked,
                          ...(event.target.checked
                            ? {
                                errorPolicy: 'stop' as const,
                                captureErrorPayload: false,
                              }
                            : {}),
                        })
                      }
                    />
                    <span className="gn-data-sync-option-row__copy">
                      <strong>{t('delivery.create_indexes')}</strong>
                      <small>{t('delivery.create_indexes_desc')}</small>
                    </span>
                  </label>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </details>
    </section>
  );
};
