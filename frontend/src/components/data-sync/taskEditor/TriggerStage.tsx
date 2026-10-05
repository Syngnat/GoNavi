import React, { useState, useEffect } from 'react';
import { toLocalDateTimeInput, fromLocalDateTimeInput } from '../dataSyncDateTime';
import { DataSyncBackgroundNotice } from '../DataSyncBackgroundNotice';
import { DataSyncCronTriggerFields } from '../DataSyncCronTriggerFields';
import { DataSyncField as Field } from '../DataSyncField';
import type { DataSyncWorkbenchGateway } from '../gateway';
import type {
  DataSyncTaskDefinition,
  DataSyncRouteCapability,
  DataSyncTriggerPolicy,
  DataSyncIncrementalPolicy,
} from '../model';
import type { DataSyncWorkbenchTranslate } from '../text';
import { type TaskPatch, createTrigger, createIncremental } from './taskEditorModel';

export const TriggerStage: React.FC<{
  task: DataSyncTaskDefinition;
  gateway: DataSyncWorkbenchGateway;
  capability: DataSyncRouteCapability;
  t: DataSyncWorkbenchTranslate;
  onPatch: (patch: TaskPatch) => void;
}> = ({ task, gateway, capability, t, onPatch }) => {
  const trigger = task.trigger;
  const incremental = task.incremental;
  const hasMixedWatermarks =
    incremental.mode === 'watermark' &&
    new Set(
      task.mappings
        .filter((mapping) => mapping.enabled && mapping.watermark)
        .map(
          (mapping) =>
            `${mapping.watermark!.column}\u0000${mapping.watermark!.tieBreaker}`,
        ),
    ).size > 1;
  const [cdcAdapterName, setCdcAdapterName] = useState('');
  const [cdcMetadataState, setCdcMetadataState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [checkpointAvailable, setCheckpointAvailable] = useState(false);

  useEffect(() => {
    if (incremental.mode !== 'cdc') {
      setCdcMetadataState('idle');
      setCdcAdapterName('');
      setCheckpointAvailable(false);
      return undefined;
    }
    let active = true;
    setCdcMetadataState('loading');
    void Promise.all([
      gateway.getCheckpoint(task.id),
    ])
      .then(([checkpoint]) => {
        if (!active) return;
        setCdcAdapterName(incremental.adapter || capability.cdcAdapter || '');
        setCheckpointAvailable(Boolean(checkpoint));
        setCdcMetadataState('ready');
      })
      .catch(() => {
        if (!active) return;
        setCdcAdapterName('');
        setCheckpointAvailable(false);
        setCdcMetadataState('error');
      });
    return () => {
      active = false;
    };
  }, [
    capability.cdcAdapter,
    gateway,
    incremental.mode === 'cdc' ? incremental.adapter : '',
    incremental.mode,
    task.id,
  ]);
  return (
  <section className="gn-data-sync-section" data-data-sync-trigger="true">
    <header className="gn-data-sync-section__header">
      <div>
        <h2>{t('trigger.title')}</h2>
        <p>{t('trigger.help')}</p>
        <DataSyncBackgroundNotice />
      </div>
    </header>
    <div className="gn-data-sync-field-grid gn-data-sync-field-grid--policy">
      <Field label={t('trigger.mode')}>
        <select
          className="gn-data-sync-control"
          value={trigger.mode}
          onChange={(event) =>
            onPatch({
              trigger: createTrigger(event.target.value as DataSyncTriggerPolicy['mode']),
            })
          }
        >
          <option value="manual" disabled={task.kind === 'cdc'}>{t('trigger.manual')}</option>
          <option value="once" disabled={task.kind === 'cdc'}>{t('trigger.once')}</option>
          <option value="interval" disabled={task.kind === 'cdc'}>{t('trigger.interval')}</option>
          <option value="cron" disabled={task.kind === 'cdc'}>{t('trigger.cron')}</option>
          <option value="continuous" disabled={task.kind !== 'cdc'}>{t('trigger.continuous')}</option>
        </select>
      </Field>
      <Field label={task.kind === 'backup' ? t('backup.run_mode') : t('incremental.mode')}>
        <select
          className="gn-data-sync-control"
          disabled={task.kind === 'backup'}
          value={incremental.mode}
          onChange={(event) => {
            const mode = event.target.value as DataSyncIncrementalPolicy['mode'];
            onPatch({
              incremental: createIncremental(mode),
              ...(mode === 'watermark'
                ? {
                    mappings: task.mappings.map((mapping) => ({
                      ...mapping,
                      watermark: {
                        column:
                          mapping.watermark?.column ||
                          (incremental.mode === 'watermark'
                            ? incremental.column
                            : ''),
                        tieBreaker:
                          mapping.watermark?.tieBreaker ||
                          (incremental.mode === 'watermark'
                            ? incremental.tieBreaker
                            : ''),
                      },
                    })),
                  }
                : {}),
              ...(mode === 'watermark'
                ? {
                    delivery: {
                      ...task.delivery,
                      writeMode:
                        task.delivery.writeMode === 'append'
                          ? ('upsert' as const)
                          : task.delivery.writeMode,
                      errorPolicy: 'stop' as const,
                      captureErrorPayload: false,
                    },
                  }
                : {}),
            });
          }}
        >
          <option value="snapshot" disabled={task.kind === 'cdc'}>{t('incremental.snapshot')}</option>
          {task.kind !== 'backup' ? <option value="watermark" disabled={task.kind === 'cdc'}>{t('incremental.watermark')}</option> : null}
          {task.kind !== 'backup' ? <option value="cdc" disabled={task.kind !== 'cdc'}>{t('incremental.cdc')}</option> : null}
        </select>
      </Field>
      {task.kind === 'backup' ? <p className="gn-data-sync-inline-note" role="note">{t('backup.full_snapshot_help')}</p> : null}
      {trigger.mode === 'once' ? (
        <>
          <Field label={t('trigger.run_at')}>
            <input
              type="datetime-local"
              className="gn-data-sync-control gn-data-sync-mono"
              value={toLocalDateTimeInput(trigger.runAt)}
              onChange={(event) =>
                onPatch({
                  trigger: {
                    ...trigger,
                    runAt: fromLocalDateTimeInput(event.target.value),
                    timezone: 'Local',
                  },
                })
              }
            />
          </Field>
        </>
      ) : null}
      {trigger.mode === 'cron' ? (
        <DataSyncCronTriggerFields
          trigger={trigger}
          t={t}
          onPatch={(nextTrigger) => onPatch({ trigger: nextTrigger })}
        />
      ) : null}
      {trigger.mode === 'interval' ? (
        <>
          <Field label={t('trigger.interval_seconds')}>
            <input
              type="number"
              min={60}
              className="gn-data-sync-control gn-data-sync-mono"
              value={trigger.intervalSeconds}
              onChange={(event) =>
                onPatch({
                  trigger: {
                    ...trigger,
                    intervalSeconds: Number(event.target.value),
                  },
                })
              }
            />
          </Field>
          <Field label={t('trigger.timezone')}>
            <input
              className="gn-data-sync-control gn-data-sync-mono"
              value={trigger.timezone}
              onChange={(event) =>
                onPatch({ trigger: { ...trigger, timezone: event.target.value } })
              }
            />
          </Field>
        </>
      ) : null}
      {incremental.mode === 'watermark' ? (
        <>
          <Field label={t('incremental.watermark_column')}>
            <input
              className="gn-data-sync-control gn-data-sync-mono"
              value={incremental.column}
              onChange={(event) =>
                onPatch({
                  incremental: { ...incremental, column: event.target.value },
                  mappings: task.mappings.map((mapping) => ({
                    ...mapping,
                    watermark: {
                      column: event.target.value,
                      tieBreaker:
                        mapping.watermark?.tieBreaker || incremental.tieBreaker,
                    },
                  })),
                })
              }
            />
          </Field>
          <Field label={t('incremental.tie_breaker')}>
            <input
              className="gn-data-sync-control gn-data-sync-mono"
              value={incremental.tieBreaker}
              onChange={(event) =>
                onPatch({
                  incremental: {
                    ...incremental,
                    tieBreaker: event.target.value,
                  },
                  mappings: task.mappings.map((mapping) => ({
                    ...mapping,
                    watermark: {
                      column: mapping.watermark?.column || incremental.column,
                      tieBreaker: event.target.value,
                    },
                  })),
                })
              }
            />
          </Field>
          <p className="gn-data-sync-inline-note" role="note">
            {t('incremental.watermark_delivery_note')}
          </p>
          {hasMixedWatermarks ? (
            <p className="gn-data-sync-inline-note" role="note">
              {t('incremental.watermark_mixed_note')}
            </p>
          ) : null}
        </>
      ) : null}
      {incremental.mode === 'cdc' ? (
        <>
          <Field label={t('incremental.cdc_adapter')}>
            <output className="gn-data-sync-control gn-data-sync-control--read-only gn-data-sync-mono">
              {cdcMetadataState === 'loading'
                ? t('metadata.loading_cdc_adapters')
                : cdcAdapterName || t('incremental.select_cdc_adapter')}
            </output>
          </Field>
          {capability.cdcAdapter && capability.cdcProbeReady === true ? (
            <p
              className="gn-data-sync-inline-note"
              role="status"
              data-cdc-probe-status="ready"
            >
              {t('incremental.cdc_probe_ready')}
            </p>
          ) : null}
          {capability.cdcAdapter && capability.cdcProbeReady === false ? (
            <div
              className="gn-data-sync-safety-note"
              role="alert"
              data-cdc-probe-status="blocked"
            >
              <strong>{t('incremental.cdc_probe_unready')}</strong>
              {capability.cdcProbeReason ? <p>{capability.cdcProbeReason}</p> : null}
            </div>
          ) : null}
          <Field label={t('incremental.start_position')}>
            <select
              className="gn-data-sync-control"
              value={incremental.startPosition}
              onChange={(event) =>
                onPatch({
                  incremental: {
                    ...incremental,
                    startPosition: event.target.value as
                      | 'latest'
                      | 'earliest'
                      | 'checkpoint',
                  },
                })
              }
            >
              <option value="latest">{t('incremental.position.latest')}</option>
              <option value="earliest" disabled>{t('incremental.position.earliest')}</option>
              <option value="checkpoint" disabled={!checkpointAvailable}>
                {t('incremental.position.checkpoint')}
              </option>
            </select>
          </Field>
          <div className="gn-data-sync-safety-note" role="note">
            <strong>{t('incremental.cdc_safety_title')}</strong>
            <p>{t('incremental.cdc_safety_note')}</p>
            <p>{t('incremental.cdc_snapshot_gap_warning')}</p>
            {!checkpointAvailable ? (
              <p>{t('incremental.cdc_checkpoint_unavailable')}</p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  </section>
  );
};
