import React, { useEffect, useMemo, useRef, useState } from 'react';

import { DataSyncObjectPicker } from './DataSyncObjectPicker';
import type {
  DataSyncObjectMetadata,
  DataSyncTableMapping,
  DataSyncTaskKind,
} from './model';
import type { DataSyncWorkbenchTranslate } from './text';
import type { DataSyncMetadataResult } from './useDataSyncMetadata';

const normalizeName = (value: string): string => value.trim().toLowerCase();

const MAPPING_BATCH_SIZE = 100;

type MappingTargetStatus = 'exists' | 'create' | 'missing' | 'pending';

const mappingReady = (
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

const ObjectMetadataStatus: React.FC<{
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

const DataSyncObjectCombobox: React.FC<{
  id: string;
  side: 'source' | 'target';
  value: string;
  options: DataSyncObjectMetadata[];
  disabled: boolean;
  allowCustom: boolean;
  t: DataSyncWorkbenchTranslate;
  onChange: (value: string) => void;
}> = ({ id, side, value, options, disabled, allowCustom, t, onChange }) => {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listId = `gn-data-sync-object-list-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const filtered = useMemo(() => {
    const needle = showAll ? '' : normalizeName(value);
    return options
      .filter((object) => side === 'source' || object.kind !== 'view')
      .filter((object) => !needle || normalizeName(object.name).includes(needle))
      .slice(0, 100);
  }, [options, showAll, side, value]);
  const exactMatch = options.some(
    (object) => normalizeName(object.name) === normalizeName(value),
  );

  useEffect(() => {
    setActiveIndex(-1);
  }, [filtered.length, open, showAll, value]);

  return (
    <div
      className="gn-data-sync-object-combobox"
      data-open={open ? 'true' : 'false'}
    >
      <input
        className="gn-data-sync-table-input gn-data-sync-mono"
        data-object-side={side}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined
        }
        value={value}
        placeholder={t(`mapping.${side}_placeholder`)}
        disabled={disabled}
        autoComplete="off"
        onFocus={() => {
          setOpen(true);
          setShowAll(false);
        }}
        onBlur={() => globalThis.setTimeout(() => setOpen(false), 0)}
        onChange={(event) => {
          setShowAll(false);
          setOpen(true);
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) => {
              if (filtered.length === 0) return -1;
              const direction = event.key === 'ArrowDown' ? 1 : -1;
              if (current < 0) return direction > 0 ? 0 : filtered.length - 1;
              return (current + direction + filtered.length) % filtered.length;
            });
          }
          if (event.key === 'Enter' && activeIndex >= 0 && filtered[activeIndex]) {
            event.preventDefault();
            onChange(filtered[activeIndex].name);
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        className="gn-data-sync-object-combobox__toggle"
        aria-label={t('mapping.open_object_list')}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setShowAll(true);
          setOpen((valueOpen) => !valueOpen);
        }}
      >
        ▾
      </button>
      {open ? (
        <div id={listId} className="gn-data-sync-object-combobox__menu" role="listbox">
          {filtered.map((object, optionIndex) => (
            <button
              id={`${listId}-option-${optionIndex}`}
              type="button"
              role="option"
              aria-selected={normalizeName(object.name) === normalizeName(value)}
              data-active={activeIndex === optionIndex ? 'true' : 'false'}
              key={`${object.kind}:${object.name}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(object.name);
                setOpen(false);
                setShowAll(false);
              }}
            >
              <span>{object.name}</span>
              <small>{t(`mapping.object_kind.${object.kind}`)}</small>
            </button>
          ))}
          {filtered.length === 0 ? (
            allowCustom && value.trim() ? (
              <div className="gn-data-sync-object-combobox__custom">
                {t('mapping.will_create_named', { name: value.trim() })}
              </div>
            ) : (
              <div className="gn-data-sync-object-combobox__empty">
                {t('mapping.no_matching_objects')}
              </div>
            )
          ) : null}
          {allowCustom && value.trim() && !exactMatch && filtered.length > 0 ? (
            <div className="gn-data-sync-object-combobox__custom">
              {t('mapping.will_create_named', { name: value.trim() })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const targetStatus = (
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

export const DataSyncMappingTable: React.FC<{
  mappings: DataSyncTableMapping[];
  taskKind: DataSyncTaskKind;
  sourceObjects: DataSyncMetadataResult<DataSyncObjectMetadata>;
  targetObjects: DataSyncMetadataResult<DataSyncObjectMetadata>;
  endpointsReady?: boolean;
  disabled?: boolean;
  selectionBusy?: boolean;
  t: DataSyncWorkbenchTranslate;
  onAdd: () => void;
  onAddMany: (sourceNames: string[]) => void;
  onChange: (mapping: DataSyncTableMapping) => void;
  onRemove: (mappingId: string) => void;
  onInspectFields?: (mappingId: string) => void;
}> = ({
  mappings,
  taskKind,
  sourceObjects,
  targetObjects,
  endpointsReady: endpointsReadyProp,
  disabled = false,
  selectionBusy = false,
  t,
  onAdd,
  onAddMany,
  onChange,
  onRemove,
  onInspectFields,
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expandedMappingIds, setExpandedMappingIds] = useState<Set<string>>(
    new Set(),
  );
  const [visibleLimit, setVisibleLimit] = useState(MAPPING_BATCH_SIZE);
  const mappingListRef = useRef<HTMLDivElement | null>(null);
  const previousMappingIdsRef = useRef(
    new Set(mappings.map((mapping) => mapping.id)),
  );
  const [recentMappingIds, setRecentMappingIds] = useState<Set<string>>(
    new Set(),
  );
  const querySink = taskKind === 'querySink';
  const endpointsReady =
    endpointsReadyProp ??
    (sourceObjects.status !== 'idle' && targetObjects.status !== 'idle');
  const canPickSources =
    !querySink &&
    sourceObjects.status === 'ready' &&
    targetObjects.status === 'ready' &&
    sourceObjects.items.length > 0;
  const relevantMetadataStatuses = querySink
    ? [targetObjects.status]
    : [sourceObjects.status, targetObjects.status];
  const metadataLoading =
    endpointsReady &&
    relevantMetadataStatuses.some(
      (status) => status === 'idle' || status === 'loading',
    );
  const metadataError =
    endpointsReady &&
    relevantMetadataStatuses.some((status) => status === 'error');
  const sourceObjectsEmpty =
    !querySink &&
    endpointsReady &&
    sourceObjects.status === 'ready' &&
    sourceObjects.items.length === 0;
  const emptyState = !endpointsReady
    ? 'prerequisite'
    : metadataError
        ? 'error'
      : metadataLoading
        ? 'loading'
        : sourceObjectsEmpty
          ? 'no-source'
          : 'ready';
  const emptyTitle =
    emptyState === 'prerequisite'
      ? t('mapping.endpoints_required_title')
      : emptyState === 'loading'
        ? t('mapping.loading_title')
        : emptyState === 'error'
          ? t('mapping.metadata_error_title')
          : emptyState === 'no-source'
            ? t('mapping.no_source_objects_title')
            : t('mapping.empty_title');
  const emptyDescription =
    emptyState === 'prerequisite'
      ? t('mapping.endpoints_required_desc')
      : emptyState === 'loading'
        ? t('mapping.loading_desc')
        : emptyState === 'error'
          ? t('mapping.metadata_error_desc')
          : emptyState === 'no-source'
            ? t('mapping.no_source_objects_desc')
            : t('mapping.empty_desc');
  const retryFailedMetadata = () => {
    if (!querySink && sourceObjects.status === 'error') sourceObjects.reload();
    if (targetObjects.status === 'error') targetObjects.reload();
  };
  const addedMappingIds = mappings
    .filter((mapping) => !previousMappingIdsRef.current.has(mapping.id))
    .map((mapping) => mapping.id);
  const pinnedMappingIds =
    addedMappingIds.length > 0 ? new Set(addedMappingIds) : recentMappingIds;
  const pinnedMappings = mappings.filter((mapping) => pinnedMappingIds.has(mapping.id));
  const visiblePinnedMappings = pinnedMappings.slice(0, visibleLimit);
  const visibleMappings = [
    ...visiblePinnedMappings,
    ...mappings
      .filter((mapping) => !pinnedMappingIds.has(mapping.id))
      .slice(0, visibleLimit - visiblePinnedMappings.length),
  ];
  const remainingCount = mappings.length - visibleMappings.length;
  const mappingIndexById = useMemo(
    () => new Map(mappings.map((mapping, index) => [mapping.id, index + 1])),
    [mappings],
  );

  useEffect(() => {
    const currentIds = new Set(mappings.map((mapping) => mapping.id));
    previousMappingIdsRef.current = currentIds;
    if (addedMappingIds.length > 0) {
      setRecentMappingIds(new Set(addedMappingIds));
      return;
    }
    setRecentMappingIds((current) => {
      const retained = new Set(
        Array.from(current).filter((mappingId) => currentIds.has(mappingId)),
      );
      return retained.size === current.size ? current : retained;
    });
  }, [mappings]);

  return (
    <section className="gn-data-sync-section" data-data-sync-mapping-section="true">
      <header className="gn-data-sync-section__header">
        <div>
          <h2>{t('mapping.title')}</h2>
          <p>{t(querySink ? 'mapping.query_help' : 'mapping.help')}</p>
        </div>
        {endpointsReady &&
        (mappings.length > 0 || (querySink && targetObjects.status === 'ready')) ? (
          <button
            type="button"
            className="gn-data-sync-button gn-data-sync-button--primary"
            disabled={
              disabled ||
              selectionBusy ||
              (querySink && mappings.length >= 1) ||
              (!querySink && !canPickSources)
            }
            title={selectionBusy ? t('mapping.probe_running') : undefined}
            onClick={() => (querySink ? onAdd() : setPickerOpen(true))}
          >
            {t(querySink ? 'mapping.add_target' : 'mapping.add_source_objects')}
          </button>
        ) : null}
      </header>

      {endpointsReady ? (
        <div className="gn-data-sync-object-status-line" aria-live="polite">
          {!querySink ? (
            <ObjectMetadataStatus
              side="source"
              state={sourceObjects}
              t={t}
              showRetry={mappings.length > 0 || emptyState !== 'error'}
            />
          ) : null}
          <ObjectMetadataStatus
            side="target"
            state={targetObjects}
            t={t}
            showRetry={mappings.length > 0 || emptyState !== 'error'}
          />
        </div>
      ) : null}

      {endpointsReady ? (
        <DataSyncObjectPicker
          open={pickerOpen}
          objects={sourceObjects.items}
          mappedSourceNames={mappings.map((mapping) => mapping.sourceObject)}
          disabled={disabled || selectionBusy}
          t={t}
          onClose={() => setPickerOpen(false)}
          onConfirm={onAddMany}
        />
      ) : null}

      {!endpointsReady || mappings.length === 0 ? (
        <div className="gn-data-sync-mapping-empty" data-state={emptyState}>
          {emptyState !== 'prerequisite' ? <strong>{emptyTitle}</strong> : null}
          <p>{emptyDescription}</p>
          {emptyState === 'error' ? (
            <button
              type="button"
              className="gn-data-sync-button gn-data-sync-button--primary"
              onClick={retryFailedMetadata}
            >
              {t('mapping.retry_objects')}
            </button>
          ) : !querySink && emptyState === 'no-source' ? (
            <button
              type="button"
              className="gn-data-sync-button gn-data-sync-button--primary"
              onClick={sourceObjects.reload}
            >
              {t('mapping.refresh_objects')}
            </button>
          ) : !querySink && canPickSources && !disabled && !selectionBusy ? (
            <button
              type="button"
              className="gn-data-sync-button gn-data-sync-button--primary"
              onClick={() => setPickerOpen(true)}
            >
              {t('mapping.select_objects')}
            </button>
          ) : null}
        </div>
      ) : (
        <div ref={mappingListRef} className="gn-data-sync-mapping-list">
          {visibleMappings.map((mapping, index) => {
            const targetState = targetStatus(mapping, targetObjects);
            const targetPending = targetState === 'pending';
            const ready = mappingReady(mapping, taskKind, targetState);
            const detailsOpen = expandedMappingIds.has(mapping.id);
            return (
              <article
                key={mapping.id}
                className="gn-data-sync-mapping-row"
                data-mapping-id={mapping.id}
                data-ready={ready ? 'true' : 'false'}
              >
                <div className="gn-data-sync-mapping-row__route">
                  <label className="gn-data-sync-mapping-row__enabled">
                    <input
                      type="checkbox"
                      aria-label={t('mapping.enabled')}
                      checked={mapping.enabled}
                      disabled={disabled}
                      onChange={(event) =>
                        onChange({ ...mapping, enabled: event.target.checked })
                      }
                    />
                  <span>{mappingIndexById.get(mapping.id) ?? index + 1}</span>
                  </label>
                  <div className="gn-data-sync-mapping-row__endpoint">
                    <span>{t('mapping.source')}</span>
                    {querySink ? (
                      <strong className="gn-data-sync-query-source">
                        {t('mapping.query_result_source')}
                      </strong>
                    ) : (
                      <DataSyncObjectCombobox
                        id={`${mapping.id}-source`}
                        side="source"
                        value={mapping.sourceObject}
                        options={sourceObjects.items}
                        disabled={disabled || !mapping.enabled}
                        allowCustom={false}
                        t={t}
                        onChange={(sourceObject) =>
                          onChange({ ...mapping, sourceObject, keyColumns: [], fields: [] })
                        }
                      />
                    )}
                  </div>
                  <span className="gn-data-sync-mapping-row__arrow" aria-hidden="true">→</span>
                  <div className="gn-data-sync-mapping-row__endpoint">
                    <span>{t('mapping.target')}</span>
                    <DataSyncObjectCombobox
                      id={`${mapping.id}-target`}
                      side="target"
                      value={mapping.targetObject}
                      options={targetObjects.items}
                      disabled={disabled || !mapping.enabled}
                      allowCustom={mapping.targetMode === 'create_or_reuse'}
                      t={t}
                      onChange={(targetObject) =>
                        onChange({ ...mapping, targetObject, fields: [] })
                      }
                    />
                  </div>
                  <div className="gn-data-sync-mapping-row__status">
                    <span
                      className="gn-data-sync-target-state"
                      data-state={targetState}
                    >
                      {t(`mapping.target_state.${targetState}`)}
                    </span>
                    <span
                      className="gn-data-sync-state-label"
                      data-state={targetPending ? 'pending' : ready ? 'ready' : 'warning'}
                    >
                      {t(
                        targetPending
                          ? 'mapping.confirming'
                          : ready
                            ? 'mapping.ready'
                            : 'mapping.needs_attention',
                      )}
                    </span>
                  </div>
                  <div className="gn-data-sync-mapping-row__actions">
                    <button
                      type="button"
                      className="gn-data-sync-link-button"
                      aria-expanded={detailsOpen}
                      onClick={() =>
                        setExpandedMappingIds((current) => {
                          const next = new Set(current);
                          if (next.has(mapping.id)) next.delete(mapping.id);
                          else next.add(mapping.id);
                          return next;
                        })
                      }
                    >
                      {t(
                        detailsOpen
                          ? 'mapping.collapse_exceptions'
                          : 'mapping.edit_exceptions',
                      )}
                    </button>
                    <button
                      type="button"
                      className="gn-data-sync-link-button gn-data-sync-link-button--danger"
                      disabled={disabled || (querySink && mappings.length === 1)}
                      onClick={() => onRemove(mapping.id)}
                    >
                      {t('mapping.remove')}
                    </button>
                  </div>
                </div>

                {detailsOpen ? (
                <div
                  className="gn-data-sync-mapping-row__details"
                  data-mapping-details="true"
                >
                  <label>
                    <span>{t('mapping.target_mode')}</span>
                    <select
                      className="gn-data-sync-table-input"
                      value={mapping.targetMode}
                      disabled={disabled || !mapping.enabled || querySink}
                      onChange={(event) =>
                        onChange({
                          ...mapping,
                          targetMode: event.target.value as DataSyncTableMapping['targetMode'],
                        })
                      }
                    >
                      <option value="create_or_reuse">{t('mapping.create_or_reuse')}</option>
                      <option value="existing_only">{t('mapping.existing_only')}</option>
                    </select>
                  </label>
                  <label>
                    <span>{t('mapping.key_columns')}</span>
                    <input
                      className="gn-data-sync-table-input gn-data-sync-mono"
                      value={mapping.keyColumns.join(', ')}
                      placeholder={t('mapping.key_placeholder')}
                      disabled={disabled || !mapping.enabled}
                      onChange={(event) =>
                        onChange({
                          ...mapping,
                          keyColumns: event.target.value
                            .split(',')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                    <small>
                      {mapping.keyColumns.length > 0
                        ? t('mapping.key_detected')
                        : t('mapping.key_when_needed')}
                    </small>
                  </label>
                  <div className="gn-data-sync-mapping-row__fields">
                    <span>{t('mapping.fields')}</span>
                    <button
                      type="button"
                      className="gn-data-sync-link-button"
                      disabled={
                        !mapping.enabled ||
                        (!querySink && !mapping.sourceObject.trim()) ||
                        querySink ||
                        !mapping.targetObject.trim() ||
                        !onInspectFields
                      }
                      onClick={() => onInspectFields?.(mapping.id)}
                    >
                      {mapping.fields.length > 0
                        ? t('mapping.fields_count', { count: mapping.fields.length })
                        : t(
                            taskKind === 'cdc'
                              ? 'mapping.fields_required'
                              : 'mapping.fields_automatic',
                          )}
                    </button>
                    <small>
                      {t(
                        taskKind === 'cdc'
                          ? 'mapping.fields_cdc_help'
                          : 'mapping.fields_automatic_help',
                      )}
                    </small>
                  </div>
                </div>
                ) : null}
              </article>
            );
          })}
          {remainingCount > 0 ? (
            <button
              type="button"
              className="gn-data-sync-button gn-data-sync-mapping-list__more"
              data-mapping-control="show-more"
              onClick={() => {
                const firstNewRowIndex = visibleMappings.length;
                const buttonWillUnmount = remainingCount <= MAPPING_BATCH_SIZE;
                setVisibleLimit((current) =>
                  Math.min(mappings.length, current + MAPPING_BATCH_SIZE),
                );
                if (
                  buttonWillUnmount &&
                  typeof globalThis.requestAnimationFrame === 'function'
                ) {
                  globalThis.requestAnimationFrame(() => {
                    const list = mappingListRef.current;
                    const firstNewControl = Array.from(
                      list?.querySelectorAll<HTMLElement>('[data-mapping-id]') || [],
                    )
                      .slice(firstNewRowIndex)
                      .map((row) =>
                        row.querySelector<HTMLElement>(
                          'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
                        ),
                      )
                      .find((control): control is HTMLElement => Boolean(control));
                    const fallback = list?.querySelector<HTMLElement>(
                      '[data-mapping-id] button:not(:disabled), [data-mapping-id] input:not(:disabled)',
                    );
                    (firstNewControl || fallback)?.focus();
                  });
                }
              }}
            >
              {t('mapping.show_more', {
                count: Math.min(MAPPING_BATCH_SIZE, remainingCount),
                remaining: remainingCount,
              })}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
};
