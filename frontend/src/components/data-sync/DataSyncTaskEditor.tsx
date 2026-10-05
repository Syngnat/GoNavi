import React, { useEffect, useRef, useState } from 'react';
import { isWebRPCAbortError } from '../../utils/webRpc';
import { DataSyncFieldMappingEditor } from './DataSyncFieldMappingEditor';
import { DataSyncMappingTable } from './DataSyncMappingTable';
import { dataSyncMappingKey } from './dataSyncMappingKey';
import { DataSyncRouteBar } from './DataSyncRouteBar';
import type { DataSyncWorkbenchGateway } from './gateway';
import {
  autoMatchDataSyncFields, buildDataSyncMappingsFromSelection, createDataSyncTableMapping,
  clearDataSyncTargetModeExplicitMarks, dataSyncTaskStages, migrationAllowTargetCreate,
  repairMigrationTargetModes, validateDataSyncTask, type DataSyncConnectionTreeItem,
  type DataSyncFieldMetadata, type DataSyncPreflightSnapshot, type DataSyncRouteCapability,
  type DataSyncTableMapping, type DataSyncTaskDefinition, type DataSyncTaskStage,
} from './model';
import { dataSyncStageTextKey, type DataSyncWorkbenchTranslate } from './text';
import { useDataSyncObjects } from './useDataSyncMetadata';
import { type TaskPatchUpdater, updateMapping } from './taskEditor/taskEditorModel';
import { EndpointStage } from './taskEditor/EndpointStage';
import { DeliveryStage } from './taskEditor/DeliveryStage';
import { TriggerStage } from './taskEditor/TriggerStage';
import { PreflightStage } from './taskEditor/PreflightStage';
export { TriggerStage } from './taskEditor/TriggerStage';

export const DataSyncTaskEditor: React.FC<{
  task: DataSyncTaskDefinition;
  gateway: DataSyncWorkbenchGateway;
  connectionTree?: DataSyncConnectionTreeItem[];
  capability: DataSyncRouteCapability;
  activeStage: DataSyncTaskStage;
  preflight: DataSyncPreflightSnapshot | null;
  preflightStale: boolean;
  preflightContent?: React.ReactNode;
  /**
   * 预检问题点「定位」时传入的映射标识。本地校验给出的是映射行 id，
   * 后端问题给出的是稳定键（`源 -> 目标`），两种情况都要能定位到行。
   */
  focusMappingRef?: string;
  onMappingLocated?: () => void;
  t: DataSyncWorkbenchTranslate;
  onStageChange: (stage: DataSyncTaskStage) => void;
  onPatch: (patch: TaskPatchUpdater) => void;
}> = ({
  task,
  gateway,
  connectionTree = [],
  capability,
  activeStage,
  preflight,
  preflightStale,
  preflightContent,
  focusMappingRef,
  onMappingLocated,
  t,
  onStageChange,
  onPatch,
}) => {
  const stages = dataSyncTaskStages(task.kind);
  const sourceObjects = useDataSyncObjects(gateway, task.source);
  const targetObjects = useDataSyncObjects(gateway, task.target);
  const navigationIssues =
    preflight && !preflightStale ? preflight.issues : validateDataSyncTask(task);
  const currentTaskRef = useRef(task);
  const stageNavRef = useRef<HTMLElement | null>(null);
  const userSelectedTargetModeIdsRef = useRef<Set<string>>(new Set());
  const endpointScope = JSON.stringify([
    task.source.connectionId,
    task.source.type,
    task.source.database,
    task.source.schema,
    task.target.connectionId,
    task.target.type,
    task.target.database,
    task.target.schema,
  ]);
  const endpointScopeRef = useRef({ taskId: task.id, value: endpointScope });
  currentTaskRef.current = task;
  const [inspectedMappingId, setInspectedMappingId] = useState('');
  const mappingProbeEpochRef = useRef(0);
  const mappingProbeAbortRef = useRef<AbortController | null>(null);
  const [mappingProbe, setMappingProbe] = useState<{
    taskId: string;
    epoch: number;
    completed: number;
    total: number;
  } | null>(null);
  const inspectedMapping =
    task.mappings.find((mapping) => mapping.id === inspectedMappingId) || null;

  /**
   * 把预检问题的映射引用解析成映射行 id。
   *
   * 两套标识并存：本地校验给出的是映射行 id（`${taskId}:mapping:...`），后端
   * 给出的是稳定键（`源 -> 目标`）。先按行 id 试，再按稳定键比对 —— 后者需要
   * 用任务级 schema 补齐，才能与后端算法算出同一个值。
   */
  const resolvedFocusMappingId = (() => {
    const reference = (focusMappingRef || '').trim();
    if (!reference) return undefined;
    if (task.mappings.some((mapping) => mapping.id === reference)) return reference;
    const matched = task.mappings.find(
      (mapping) =>
        dataSyncMappingKey(mapping, task.source.schema, task.target.schema) ===
        reference.toLowerCase(),
    );
    return matched?.id;
  })();

  useEffect(() => {
    setInspectedMappingId('');
    mappingProbeEpochRef.current += 1;
    mappingProbeAbortRef.current?.abort();
    mappingProbeAbortRef.current = null;
    setMappingProbe(null);
    return () => {
      mappingProbeEpochRef.current += 1;
      mappingProbeAbortRef.current?.abort();
      mappingProbeAbortRef.current = null;
    };
  }, [
    task.id,
    task.source.connectionId,
    task.source.type,
    task.source.database,
    task.source.schema,
    task.target.connectionId,
    task.target.type,
    task.target.database,
    task.target.schema,
  ]);

  useEffect(() => {
    if (inspectedMappingId && !inspectedMapping) setInspectedMappingId('');
  }, [inspectedMapping, inspectedMappingId]);

  useEffect(() => {
    const previous = endpointScopeRef.current;
    if (previous.taskId !== task.id) {
      endpointScopeRef.current = { taskId: task.id, value: endpointScope };
      userSelectedTargetModeIdsRef.current.clear();
      return;
    }
    if (previous.value === endpointScope) return;
    endpointScopeRef.current = { taskId: task.id, value: endpointScope };
    userSelectedTargetModeIdsRef.current.clear();
    const mappings = clearDataSyncTargetModeExplicitMarks(task.mappings);
    if (mappings !== task.mappings) onPatch({ mappings });
  }, [endpointScope, onPatch, task.id, task.mappings]);

  // 能力快照就绪后自修复迁移映射的 targetMode：存量任务在自动建表支持
  // 上线前保存的 existing_only 映射、以及能力加载完成前手工添加的行，
  // 在目标表确实缺失且后端支持建表时升为 create_or_reuse，否则预检会
  // 报"目标表不存在，且当前任务不能自动创建该表"且 UI 无从解释原因。
  const repairedMappings = repairMigrationTargetModes(
    task.mappings,
    task.kind,
    capability,
    targetObjects.items,
    targetObjects.status === 'ready',
    userSelectedTargetModeIdsRef.current,
  );
  useEffect(() => {
    if (repairedMappings !== task.mappings) {
      onPatch({ mappings: repairedMappings });
    }
  }, [repairedMappings, task.mappings, onPatch]);

  useEffect(() => {
    const navigation = stageNavRef.current;
    if (!navigation) return undefined;
    const activeButton = navigation.querySelector<HTMLElement>(
      `button[data-stage="${activeStage}"]`,
    );
    if (!activeButton) return undefined;

    const keepActiveStageVisible = () => {
      const navigationBounds = navigation.getBoundingClientRect();
      const buttonBounds = activeButton.getBoundingClientRect();
      const hidden =
        buttonBounds.left < navigationBounds.left + 6 ||
        buttonBounds.right > navigationBounds.right - 6;
      if (!hidden) return;
      const buttonLeftInsideNavigation =
        navigation.scrollLeft + buttonBounds.left - navigationBounds.left;
      const left = Math.min(
        Math.max(0, navigation.scrollWidth - navigation.clientWidth),
        Math.max(
          0,
          buttonLeftInsideNavigation -
            (navigation.clientWidth - buttonBounds.width) / 2,
        ),
      );
      const reduceMotion =
        typeof globalThis.matchMedia === 'function' &&
        globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (typeof navigation.scrollTo === 'function') {
        navigation.scrollTo({ left, behavior: reduceMotion ? 'auto' : 'smooth' });
      } else {
        navigation.scrollLeft = left;
      }
    };

    keepActiveStageVisible();
    if (typeof globalThis.ResizeObserver !== 'function') return undefined;
    const observer = new globalThis.ResizeObserver(keepActiveStageVisible);
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [activeStage]);

  const changeMapping = (mapping: DataSyncTableMapping) => {
    const currentMapping = task.mappings.find(({ id }) => id === mapping.id);
    if (currentMapping && currentMapping.targetMode !== mapping.targetMode) {
      if (mapping.targetMode === 'existing_only') {
        userSelectedTargetModeIdsRef.current.add(mapping.id);
        mapping = { ...mapping, targetModeExplicit: true };
      } else {
        userSelectedTargetModeIdsRef.current.delete(mapping.id);
        mapping = { ...mapping, targetModeExplicit: undefined };
      }
    }
    onPatch({ mappings: updateMapping(task, mapping) });
  };

  const addSelectedObjects = (sourceNames: string[]) => {
    const requestTask = task;
    const requestSourceScope = JSON.stringify([
      requestTask.source.connectionId,
      requestTask.source.type,
      requestTask.source.database,
      requestTask.source.schema,
    ]);
    const requestTargetScope = JSON.stringify([
      requestTask.target.connectionId,
      requestTask.target.type,
      requestTask.target.database,
      requestTask.target.schema,
    ]);
    const buildMappings = (existingMappings: DataSyncTableMapping[]) =>
      buildDataSyncMappingsFromSelection({
        taskId: requestTask.id,
        taskKind: requestTask.kind,
        sourceNames,
        targetObjects: targetObjects.items,
        existingMappings,
        // 能力未知（加载中/解析失败）必须传 undefined，让选表回落到迁移
        // 默认许可并由后端预检兜底；传 false 会把映射永久锁死在
        // existing_only，能力返回后预检只能报"不能自动创建该表"。
        allowTargetCreate: migrationAllowTargetCreate(
          requestTask.kind,
          capability,
        ),
      });
    const mappings = buildMappings(requestTask.mappings);
    onPatch({ mappings });
    if (requestTask.kind !== 'reconcile' && requestTask.kind !== 'cdc') {
      setMappingProbe(null);
      return;
    }

    const selectedSources = new Set(
      sourceNames.map((name) => name.trim().toLowerCase()).filter(Boolean),
    );
    const addedMappings = mappings.filter((mapping) =>
      selectedSources.has(mapping.sourceObject.trim().toLowerCase()),
    );
    if (addedMappings.length === 0) return;
    const probeEpoch = ++mappingProbeEpochRef.current;
    mappingProbeAbortRef.current?.abort();
    const probeController = new AbortController();
    mappingProbeAbortRef.current = probeController;
    setMappingProbe({
      taskId: requestTask.id,
      epoch: probeEpoch,
      completed: 0,
      total: addedMappings.length,
    });
    type DetectedMappingMetadata = {
      keyColumns: string[];
      sourceFields: DataSyncFieldMetadata[];
      targetFields: DataSyncFieldMetadata[];
      targetObject: string;
    };
    const detectInBackground = async () => {
      const metadataByMappingId = new Map<string, DetectedMappingMetadata>();
      const progressStride = Math.max(1, Math.ceil(addedMappings.length / 40));
      let completedCount = 0;
      let publishedCount = 0;
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(4, addedMappings.length) },
        async () => {
          while (
            cursor < addedMappings.length &&
            mappingProbeEpochRef.current === probeEpoch
          ) {
            const index = cursor;
            cursor += 1;
            const mapping = addedMappings[index];
            try {
              const sourceFields = await gateway.listFields(
                requestTask.source,
                mapping.sourceObject,
                { signal: probeController.signal },
              );
              let targetFields: DataSyncFieldMetadata[] = [];
              if (requestTask.kind === 'cdc' && mapping.targetObject.trim()) {
                try {
                  targetFields = await gateway.listFields(
                    requestTask.target,
                    mapping.targetObject,
                    { signal: probeController.signal },
                  );
                } catch (error) {
                  if (
                    probeController.signal.aborted ||
                    isWebRPCAbortError(error) ||
                    mappingProbeEpochRef.current !== probeEpoch
                  ) {
                    return;
                  }
                  targetFields = [];
                }
              }
              metadataByMappingId.set(mapping.id, {
                keyColumns: sourceFields
                  .filter((field) => field.key)
                  .sort((left, right) => left.ordinal - right.ordinal)
                  .map((field) => field.name),
                sourceFields,
                targetFields,
                targetObject: mapping.targetObject,
              });
            } catch (error) {
              if (
                probeController.signal.aborted ||
                isWebRPCAbortError(error) ||
                mappingProbeEpochRef.current !== probeEpoch
              ) {
                return;
              }
              metadataByMappingId.set(mapping.id, {
                keyColumns: [],
                sourceFields: [],
                targetFields: [],
                targetObject: mapping.targetObject,
              });
            } finally {
              completedCount += 1;
              if (
                completedCount === addedMappings.length ||
                completedCount - publishedCount >= progressStride
              ) {
                publishedCount = completedCount;
                setMappingProbe((current) =>
                  current?.epoch === probeEpoch
                    ? {
                        ...current,
                        completed: Math.min(current.total, completedCount),
                      }
                    : current,
                );
              }
            }
          }
        },
      );
      await Promise.all(workers);
      if (mappingProbeAbortRef.current === probeController) {
        mappingProbeAbortRef.current = null;
      }
      if (
        probeController.signal.aborted ||
        mappingProbeEpochRef.current !== probeEpoch
      ) {
        return;
      }

      const currentTask = currentTaskRef.current;
      const currentSourceScope = JSON.stringify([
        currentTask.source.connectionId,
        currentTask.source.type,
        currentTask.source.database,
        currentTask.source.schema,
      ]);
      const currentTargetScope = JSON.stringify([
        currentTask.target.connectionId,
        currentTask.target.type,
        currentTask.target.database,
        currentTask.target.schema,
      ]);
      if (
        currentTask.id !== requestTask.id ||
        currentTask.kind !== requestTask.kind ||
        currentSourceScope !== requestSourceScope ||
        currentTargetScope !== requestTargetScope
      ) {
        setMappingProbe((current) =>
          current?.epoch === probeEpoch ? null : current,
        );
        return;
      }

      onPatch((latestTask) => ({
        mappings: latestTask.mappings.map((mapping) => {
          const detected = metadataByMappingId.get(mapping.id);
          if (!detected) return mapping;
          const sameTarget =
            detected.targetObject.trim().toLowerCase() ===
            mapping.targetObject.trim().toLowerCase();
          return {
            ...mapping,
            keyColumns:
              mapping.keyColumns.length > 0
                ? mapping.keyColumns
                : detected.keyColumns,
            fields:
              requestTask.kind === 'cdc' &&
              sameTarget &&
              mapping.fields.length === 0 &&
              detected.sourceFields.length > 0 &&
              detected.targetFields.length > 0
                ? autoMatchDataSyncFields(
                    mapping.id,
                    detected.sourceFields,
                    detected.targetFields,
                    mapping.fields,
                  )
                : mapping.fields,
          };
        }),
      }));
    };
    void detectInBackground();
  };

  const mappingProbeRunning = Boolean(
    mappingProbe?.taskId === task.id && mappingProbe.completed < mappingProbe.total,
  );
  const editEndpoints = () => {
    const endpointStageButton = stageNavRef.current?.querySelector<HTMLButtonElement>(
      'button[data-stage="endpoints"]',
    );
    onStageChange('endpoints');
    endpointStageButton?.focus();
  };

  const moveStageFromKeyboard = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    const targetIndex =
      event.key === 'ArrowRight'
        ? Math.min(stages.length - 1, currentIndex + 1)
        : event.key === 'ArrowLeft'
          ? Math.max(0, currentIndex - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? stages.length - 1
              : -1;
    if (targetIndex < 0) return;

    event.preventDefault();
    const targetStage = stages[targetIndex];
    onStageChange(targetStage);
    stageNavRef.current
      ?.querySelector<HTMLButtonElement>(`button[data-stage="${targetStage}"]`)
      ?.focus();
  };

  return (
  <div className="gn-data-sync-task-editor" data-data-sync-task-editor="true">
    <nav
      ref={stageNavRef}
      className="gn-data-sync-stage-nav"
      aria-label={t('workbench.task_steps')}
    >
      {stages.map((stage, index) => {
        const issues = navigationIssues.filter((issue) => issue.stage === stage);
        const blockers = issues.filter((issue) => issue.severity === 'blocker').length;
        const warnings = issues.filter((issue) => issue.severity === 'warning').length;
        const isFutureStage = index > stages.indexOf(activeStage);
        const status =
          stage === 'preflight'
            ? preflightStale
              ? 'warning'
              : !preflight
                ? 'pending'
                : preflight.status === 'passed'
                  ? 'ready'
                  : preflight.status
            : blockers > 0
              ? 'blocked'
              : warnings > 0
                ? 'warning'
                : isFutureStage
                  ? 'pending'
                  : 'ready';
        const statusLabel =
          stage === 'preflight' && preflightStale
            ? t('preflight.stale')
            : status === 'ready'
              ? stage === 'preflight'
                ? t('preflight.passed')
                : t('workbench.stage_ready')
              : status === 'blocked'
                ? t('preflight.blocked', { count: blockers || 1 })
                : status === 'warning'
                  ? t('preflight.warning', { count: warnings || 1 })
                  : stage === 'preflight'
                    ? t('preflight.not_run')
                    : t('workbench.stage_pending');
        return (
          <button
            key={stage}
            type="button"
            data-stage={stage}
            data-active={stage === activeStage ? 'true' : 'false'}
            data-status={status}
            aria-current={stage === activeStage ? 'step' : undefined}
            aria-label={`${t(dataSyncStageTextKey(stage, task.kind, task.compareMode))} · ${statusLabel}`}
            title={statusLabel}
            onClick={() => onStageChange(stage)}
            onKeyDown={(event) => moveStageFromKeyboard(event, index)}
          >
            <span className="gn-data-sync-stage-nav__node" aria-hidden="true">
              {status === 'ready' ? '✓' : index + 1}
            </span>
            <span className="gn-data-sync-stage-nav__label">
              <span className="gn-data-sync-stage-nav__label-full">
                {t(dataSyncStageTextKey(stage, task.kind, task.compareMode))}
              </span>
              <span className="gn-data-sync-stage-nav__label-short" aria-hidden="true">
                {t(`stage_short.${stage}`)}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
    <div
      className="gn-data-sync-task-editor__body"
      data-data-sync-stage-content="true"
    >
      {activeStage !== 'endpoints' ? (
        <DataSyncRouteBar
          source={task.source}
          target={task.target}
          capability={capability}
          t={t}
          compare={task.kind === 'compare'}
          onEditEndpoints={editEndpoints}
        />
      ) : null}
      {activeStage === 'endpoints' ? (
        <EndpointStage
          task={task}
          gateway={gateway}
          connectionTree={connectionTree}
          t={t}
          onPatch={onPatch}
          onContinue={() => onStageChange('mappings')}
        />
      ) : null}
      {activeStage === 'mappings' ? (
        <>
          {/* Compare tasks never reach a delivery stage, so the read-only
              contract is repeated where the objects are picked. */}
          {task.kind === 'compare' ? (
            <div
              className="gn-data-sync-readonly-note"
              role="note"
              data-data-sync-compare-readonly="true"
            >
              <strong>{t('delivery.read_only_title')}</strong>
              <span>{t('delivery.read_only_note')}</span>
            </div>
          ) : null}
          {mappingProbe?.taskId === task.id ? (
            <div
              className="gn-data-sync-mapping-probe"
              data-mapping-probe={
                mappingProbe.completed >= mappingProbe.total ? 'complete' : 'running'
              }
              role="status"
              aria-live="polite"
            >
              <span>
                {t(
                  mappingProbe.completed >= mappingProbe.total
                    ? 'mapping.probe_complete'
                    : 'mapping.probe_running',
                )}
              </span>
              <strong>
                {t('mapping.probe_progress', {
                  completed: mappingProbe.completed,
                  total: mappingProbe.total,
                })}
              </strong>
            </div>
          ) : null}
          <DataSyncMappingTable
            key={task.id}
            mappings={task.mappings}
            taskKind={task.kind}
            compareMode={task.compareMode}
            focusMappingId={resolvedFocusMappingId}
            onLocated={onMappingLocated}
            sourceObjects={sourceObjects}
            targetObjects={targetObjects}
            endpointsReady={Boolean(
              task.source.connectionId.trim() && task.target.connectionId.trim(),
            )}
            selectionBusy={mappingProbeRunning}
            t={t}
            onAdd={() =>
              onPatch({
                mappings: [
                  ...task.mappings,
                  createDataSyncTableMapping(
                    `${task.id}:mapping:${task.mappings.length + 1}:${task.editEpoch + 1}`,
                  ),
                ],
              })
            }
            onAddMany={addSelectedObjects}
            onChange={changeMapping}
            onRemove={(mappingId) =>
              onPatch({
                mappings: task.mappings.filter((mapping) => mapping.id !== mappingId),
              })
            }
            onRemoveMany={(mappingIds) => {
              const removed = new Set(mappingIds);
              onPatch({
                mappings: task.mappings.filter((mapping) => !removed.has(mapping.id)),
              });
            }}
            onInspectFields={setInspectedMappingId}
          />
          {inspectedMapping ? (
            <DataSyncFieldMappingEditor
              gateway={gateway}
              source={task.source}
              target={task.target}
              mapping={inspectedMapping}
              t={t}
              onChange={changeMapping}
              onClose={() => setInspectedMappingId('')}
            />
          ) : null}
        </>
      ) : null}
      {activeStage === 'delivery' && task.kind !== 'compare' ? (
        <DeliveryStage
          task={task}
          capability={capability}
          t={t}
          onPatch={onPatch}
        />
      ) : null}
      {activeStage === 'trigger' && task.kind !== 'compare' ? (
        <TriggerStage
          task={task}
          gateway={gateway}
          capability={capability}
          t={t}
          onPatch={onPatch}
        />
      ) : null}
      {activeStage === 'preflight' && task.kind !== 'compare' ? (
        preflightContent || (
          <PreflightStage
            task={task}
            snapshot={preflight}
            stale={preflightStale}
            t={t}
            onLocate={onStageChange}
          />
        )
      ) : null}
    </div>
  </div>
  );
};
