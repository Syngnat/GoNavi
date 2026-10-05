import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DataSyncCompareMode,
  DataSyncObjectMetadata,
  DataSyncTableMapping,
  DataSyncTaskKind,
} from './model';
import type { DataSyncWorkbenchTranslate } from './text';
import type { DataSyncMetadataResult } from './useDataSyncMetadata';
import {
  normalizeName,
  ObjectMetadataStatus,
  targetStatus,
  mappingReady,
} from './mappingTable/dataSyncMappingStatus';
import { DataSyncObjectCombobox } from './mappingTable/DataSyncObjectCombobox';

const MAPPING_BATCH_SIZE = 100;
/** 定位高亮的保留时长：够看清跳到了哪一行，又不至于长时间干扰阅读。 */
const LOCATED_HIGHLIGHT_MS = 2400;

export const DataSyncMappingTable: React.FC<{
  mappings: DataSyncTableMapping[];
  taskKind: DataSyncTaskKind;
  compareMode?: DataSyncCompareMode;
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
  onRemoveMany?: (mappingIds: string[]) => void;
  onInspectFields?: (mappingId: string) => void;
  /**
   * 需要滚动到并高亮的映射行 id。预检问题点「定位」时由外层传入；
   * 行被找到后由 `onLocated` 通知外层清空，避免再次渲染时重复跳动。
   */
  focusMappingId?: string;
  onLocated?: () => void;
}> = ({
  mappings,
  taskKind,
  compareMode,
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
  onRemoveMany,
  onInspectFields,
  focusMappingId,
  onLocated,
}) => {
  const [catalogSearch, setCatalogSearch] = useState('');
  const [expandedMappingIds, setExpandedMappingIds] = useState<Set<string>>(
    new Set(),
  );
  const [visibleLimit, setVisibleLimit] = useState(MAPPING_BATCH_SIZE);
  // 定位后短暂高亮的行。定时清除，避免用户下一次进来看见一个「不知道哪来的」高亮。
  const [locatedMappingId, setLocatedMappingId] = useState('');
  const locateTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const mappingListRef = useRef<HTMLDivElement | null>(null);
  const previousMappingIdsRef = useRef(
    new Set(mappings.map((mapping) => mapping.id)),
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
  const orderedMappings = useMemo(() => {
    if (querySink || sourceObjects.items.length === 0) return mappings;
    const catalogIndex = new Map(
      sourceObjects.items.map((object, index) => [
        normalizeName(object.name),
        index,
      ]),
    );
    return mappings
      .map((mapping, index) => ({ mapping, index }))
      .sort((left, right) => {
        const leftRank = catalogIndex.get(normalizeName(left.mapping.sourceObject));
        const rightRank = catalogIndex.get(
          normalizeName(right.mapping.sourceObject),
        );
        if (leftRank == null && rightRank == null) return left.index - right.index;
        if (leftRank == null) return 1;
        if (rightRank == null) return -1;
        return leftRank - rightRank || left.index - right.index;
      })
      .map((item) => item.mapping);
  }, [mappings, querySink, sourceObjects.items]);
  const visibleMappings = orderedMappings.slice(0, visibleLimit);
  const remainingCount = orderedMappings.length - visibleMappings.length;
  const mappingIndexById = useMemo(
    () => new Map(orderedMappings.map((mapping, index) => [mapping.id, index + 1])),
    [orderedMappings],
  );
  const mappedSourceNames = useMemo(
    () => new Set(mappings.map((mapping) => normalizeName(mapping.sourceObject)).filter(Boolean)),
    [mappings],
  );
  const catalogNeedle = normalizeName(catalogSearch);
  const catalogObjects = useMemo(
    () =>
      sourceObjects.items.filter(
        (object) =>
          object.kind !== 'view' &&
          (!catalogNeedle || normalizeName(object.name).includes(catalogNeedle)),
      ),
    [catalogNeedle, sourceObjects.items],
  );
  const showCatalog = !querySink && canPickSources;
  const compareTask = taskKind === 'compare';
  const mappingTitleKey = compareTask
    ? compareMode === 'schema'
      ? 'mapping.title_schema_compare'
      : 'mapping.title_data_compare'
    : 'mapping.title';
  const mappingHelpKey = compareTask
    ? compareMode === 'schema'
      ? 'mapping.help_schema_compare'
      : 'mapping.help_data_compare'
    : querySink
      ? 'mapping.query_help'
      : 'mapping.help';
  const mappingWriteToKey = compareTask ? 'mapping.write_to_compare' : 'mapping.write_to';
  const mappingEmptyDescKey = compareTask
    ? 'mapping.none_selected_desc_compare'
    : 'mapping.none_selected_desc';
  const catalogSelectedCount = catalogObjects.filter((object) =>
    mappedSourceNames.has(normalizeName(object.name)),
  ).length;
  const catalogAllSelected =
    catalogObjects.length > 0 && catalogSelectedCount === catalogObjects.length;
  const catalogSomeSelected = catalogSelectedCount > 0 && !catalogAllSelected;
  const toggleCatalogObject = (objectName: string, checked: boolean) => {
    if (checked) {
      const selected = mappings
        .map((mapping) => mapping.sourceObject.trim())
        .filter(Boolean);
      if (
        !selected.some((name) => normalizeName(name) === normalizeName(objectName))
      ) {
        selected.push(objectName);
      }
      onAddMany(selected);
      return;
    }
    const mapping = mappings.find(
      (item) => normalizeName(item.sourceObject) === normalizeName(objectName),
    );
    if (mapping) onRemove(mapping.id);
  };
  const toggleCatalogFiltered = (checked: boolean) => {
    if (checked) {
      const selected = mappings
        .map((mapping) => mapping.sourceObject.trim())
        .filter(Boolean);
      const selectedKeys = new Set(selected.map(normalizeName));
      catalogObjects.forEach((object) => {
        const key = normalizeName(object.name);
        if (!selectedKeys.has(key)) {
          selected.push(object.name);
          selectedKeys.add(key);
        }
      });
      onAddMany(selected);
      return;
    }
    const filteredKeys = new Set(
      catalogObjects.map((object) => normalizeName(object.name)),
    );
    const removedIds = mappings
      .filter((mapping) => filteredKeys.has(normalizeName(mapping.sourceObject)))
      .map((mapping) => mapping.id);
    if (removedIds.length === 0) return;
    if (onRemoveMany) {
      onRemoveMany(removedIds);
      return;
    }
    onRemove(removedIds[0]);
  };

  useEffect(() => {
    const currentIds = new Set(mappings.map((mapping) => mapping.id));
    const addedIds = mappings
      .filter((mapping) => !previousMappingIdsRef.current.has(mapping.id))
      .map((mapping) => mapping.id);
    previousMappingIdsRef.current = currentIds;
    if (addedIds.length === 0) return;
    const lastAddedIndex = Math.max(
      ...addedIds.map((mappingId) =>
        orderedMappings.findIndex((mapping) => mapping.id === mappingId),
      ),
      0,
    );
    setVisibleLimit((current) =>
      lastAddedIndex < current ? current : lastAddedIndex + 1,
    );
  }, [mappings, orderedMappings]);

  useEffect(() => {
    const target = (focusMappingId || '').trim();
    if (!target) return undefined;
    const index = orderedMappings.findIndex((mapping) => mapping.id === target);
    if (index < 0) {
      // 行可能对不上（后端稳定键与本地行 id 分属两套标识）。交给外层决定
      // 如何处理，这里保持沉默，避免弹出与用户操作无关的错误。
      onLocated?.();
      return undefined;
    }
    // 目标行可能落在「显示更多」之外：先展开到它，再滚动定位。
    setVisibleLimit((current) => (index < current ? current : index + 1));
    const schedule =
      typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : (callback: FrameRequestCallback) => {
            callback(0);
            return 0;
          };
    const handle = schedule(() => {
      // 逐行比对而不是拼选择器：映射 id 含冒号，直接拼进 querySelector 会
      // 被当成伪类，且 CSS.escape 在测试环境里不一定可用。
      const rows = Array.from(
        mappingListRef.current?.querySelectorAll<HTMLElement>('[data-mapping-id]') || [],
      );
      const row = rows.find((candidate) => candidate.dataset.mappingId === target);
      if (!row) {
        onLocated?.();
        return;
      }
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row
        .querySelector<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
        )
        ?.focus();
      setLocatedMappingId(target);
      if (locateTimerRef.current !== null) {
        globalThis.clearTimeout(locateTimerRef.current);
      }
      locateTimerRef.current = globalThis.setTimeout(() => {
        locateTimerRef.current = null;
        setLocatedMappingId('');
      }, LOCATED_HIGHLIGHT_MS);
      onLocated?.();
    });
    return () => {
      if (typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(handle);
      }
    };
  }, [focusMappingId, orderedMappings, onLocated]);

  useEffect(
    () => () => {
      if (locateTimerRef.current !== null) {
        globalThis.clearTimeout(locateTimerRef.current);
        locateTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <section
      className={`gn-data-sync-section${showCatalog ? ' gn-data-sync-section--mappings' : ''}`}
      data-data-sync-mapping-section="true"
    >
      <header className="gn-data-sync-section__header">
        <div>
          <h2>{t(mappingTitleKey)}</h2>
          <p>{t(mappingHelpKey)}</p>
        </div>
        {endpointsReady && querySink && targetObjects.status === 'ready' ? (
          <button
            type="button"
            className="gn-data-sync-button gn-data-sync-button--primary"
            disabled={disabled || selectionBusy || mappings.length >= 1}
            title={selectionBusy ? t('mapping.probe_running') : undefined}
            onClick={onAdd}
          >
            {t('mapping.add_target')}
          </button>
        ) : null}
      </header>

      {endpointsReady && !showCatalog ? (
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

      {showCatalog ? (
        <aside className="gn-data-sync-mapping-catalog" data-mapping-catalog="true">
          <header className="gn-data-sync-mapping-catalog__header">
            <strong>{t('mapping.catalog_title')}</strong>
            <span>{t('metadata.objects_count', { count: sourceObjects.items.length })}</span>
          </header>
          <label className="gn-data-sync-mapping-catalog__search">
            <span className="gn-data-sync-visually-hidden">{t('mapping.search_objects')}</span>
            <input
              type="search"
              value={catalogSearch}
              placeholder={t('mapping.search_objects')}
              onChange={(event) => setCatalogSearch(event.target.value)}
            />
          </label>
          {catalogObjects.length > 0 ? (
            <label className="gn-data-sync-mapping-catalog__select-all">
              <input
                type="checkbox"
                checked={catalogAllSelected}
                disabled={disabled || selectionBusy}
                ref={(input) => {
                  if (input) input.indeterminate = catalogSomeSelected;
                }}
                onChange={() =>
                  toggleCatalogFiltered(!(catalogAllSelected || catalogSomeSelected))
                }
              />
              <span>
                {catalogNeedle
                  ? t('mapping.select_filtered', { count: catalogObjects.length })
                  : t('mapping.select_all', { count: catalogObjects.length })}
              </span>
            </label>
          ) : null}
          <div className="gn-data-sync-mapping-catalog__list">
            {catalogObjects.map((object) => {
              const checked = mappedSourceNames.has(normalizeName(object.name));
              return (
                <label
                  key={`${object.kind}:${object.name}`}
                  className="gn-data-sync-mapping-catalog__item"
                  data-checked={checked ? 'true' : 'false'}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || selectionBusy}
                    onChange={(event) =>
                      toggleCatalogObject(object.name, event.target.checked)
                    }
                  />
                  <span className="gn-data-sync-mapping-catalog__name">{object.name}</span>
                  <small>{t(`mapping.object_kind.${object.kind}`)}</small>
                </label>
              );
            })}
          </div>
        </aside>
      ) : null}

      {!endpointsReady || mappings.length === 0 ? (
        <div className="gn-data-sync-mapping-empty" data-state={showCatalog ? 'catalog' : emptyState}>
          {showCatalog || emptyState !== 'prerequisite' ? (
            <strong>{showCatalog ? t('mapping.none_selected_title') : emptyTitle}</strong>
          ) : null}
          <p>{showCatalog ? t(mappingEmptyDescKey) : emptyDescription}</p>
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
          ) : null}
        </div>
      ) : (
        <div ref={mappingListRef} className="gn-data-sync-mapping-list">
          {visibleMappings.map((mapping, index) => {
            const targetState = targetStatus(mapping, targetObjects);
            const ready = mappingReady(mapping, taskKind, targetState);
            const detailsOpen = expandedMappingIds.has(mapping.id);
            return (
              <article
                key={mapping.id}
                className="gn-data-sync-mapping-row"
                data-mapping-id={mapping.id}
                data-located={locatedMappingId === mapping.id ? 'true' : 'false'}
                data-ready={ready ? 'true' : 'false'}
                data-source-locked={showCatalog ? 'true' : 'false'}
                data-expanded={detailsOpen ? 'true' : 'false'}
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
                  {showCatalog ? (
                    <div className="gn-data-sync-mapping-row__endpoint">
                      <span
                        id={`${mapping.id}-source-label`}
                        data-mapping-field-label="source"
                      >
                        {t('mapping.selected_source')}
                      </span>
                      <div
                        className="gn-data-sync-mapping-row__source-name"
                        data-object-side="source"
                        data-object-name={mapping.sourceObject}
                        title={mapping.sourceObject}
                        aria-labelledby={`${mapping.id}-source-label`}
                      >
                        {mapping.sourceObject}
                      </div>
                    </div>
                  ) : (
                    <div className="gn-data-sync-mapping-row__endpoint">
                      <span id={`${mapping.id}-source-label`}>{t('mapping.source')}</span>
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
                          labelledBy={`${mapping.id}-source-label`}
                          t={t}
                          onChange={(sourceObject) =>
                            onChange({ ...mapping, sourceObject, keyColumns: [], fields: [] })
                          }
                        />
                      )}
                    </div>
                  )}
                  <span className="gn-data-sync-mapping-row__arrow" aria-hidden="true">→</span>
                  <div className="gn-data-sync-mapping-row__endpoint">
                    <span
                      id={`${mapping.id}-target-label`}
                      data-mapping-field-label="target"
                    >
                      {t(showCatalog ? mappingWriteToKey : 'mapping.target')}
                    </span>
                    <div className="gn-data-sync-mapping-row__target-controls">
                      <DataSyncObjectCombobox
                        id={`${mapping.id}-target`}
                        side="target"
                        value={mapping.targetObject}
                        options={targetObjects.items}
                        labelledBy={`${mapping.id}-target-label`}
                        disabled={disabled || !mapping.enabled}
                        allowCustom={mapping.targetMode === 'create_or_reuse'}
                        t={t}
                        onChange={(targetObject) =>
                          onChange({ ...mapping, targetObject, fields: [] })
                        }
                      />
                      <div className="gn-data-sync-mapping-row__actions">
                        <button
                          type="button"
                          className="gn-data-sync-link-button gn-data-sync-mapping-row__exceptions-toggle"
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
                          {detailsOpen
                            ? t('mapping.collapse_exceptions')
                            : t('mapping.edit_exceptions')}
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
                    {targetState === 'exists' ? null : (
                    <small
                      className="gn-data-sync-mapping-row__hint"
                      data-mapping-hint="target"
                      data-state={targetState}
                    >
                      {t(`mapping.target_hint.${targetState}`)}
                    </small>
                    )}
                  </div>
                </div>

                {detailsOpen ? (
                <div
                  className="gn-data-sync-mapping-row__details"
                  data-mapping-details="true"
                >
                  <p
                    className="gn-data-sync-mapping-row__details-caption"
                    data-mapping-exceptions-for={mapping.sourceObject}
                  >
                    {t('mapping.exceptions_caption', {
                      source: mapping.sourceObject || t('mapping.query_result_source'),
                      target: mapping.targetObject,
                    })}
                  </p>
                  <label className="gn-data-sync-mapping-row__detail">
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
                  <label className="gn-data-sync-mapping-row__detail">
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
                      className="gn-data-sync-mapping-row__fields-action"
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
