import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type {
  DataSyncObjectMetadata,
  DataSyncTableMapping,
  DataSyncTaskKind,
} from './model';
import type { DataSyncWorkbenchTranslate } from './text';
import type { DataSyncMetadataResult } from './useDataSyncMetadata';

const normalizeName = (value: string): string => value.trim().toLowerCase();

const MAPPING_BATCH_SIZE = 100;
const OBJECT_COMBOBOX_MENU_GAP = 3;
const OBJECT_COMBOBOX_MENU_MAX_HEIGHT = 260;
const OBJECT_COMBOBOX_MENU_MIN_HEIGHT = 120;

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
  labelledBy?: string;
  t: DataSyncWorkbenchTranslate;
  onChange: (value: string) => void;
}> = ({ id, side, value, options, disabled, allowCustom, labelledBy, t, onChange }) => {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listId = `gn-data-sync-object-list-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const canPortal = typeof document !== 'undefined';
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
  const updateMenuPosition = useCallback(() => {
    const root = rootRef.current;
    if (!root || typeof root.getBoundingClientRect !== 'function') return;
    const rect = root.getBoundingClientRect();
    const viewportHeight = Math.max(globalThis.innerHeight || 0, 1);
    const viewportWidth = Math.max(globalThis.innerWidth || 0, rect.width);
    const spaceBelow = viewportHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openUpward =
      spaceBelow < OBJECT_COMBOBOX_MENU_MIN_HEIGHT && spaceAbove > spaceBelow;
    const available = openUpward ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(
      80,
      Math.min(
        OBJECT_COMBOBOX_MENU_MAX_HEIGHT,
        Number.isFinite(available) && available > 0
          ? available
          : OBJECT_COMBOBOX_MENU_MAX_HEIGHT,
      ),
    );
    const width = Math.max(rect.width, 0);
    const left = Math.max(
      8,
      Math.min(rect.left, Math.max(8, viewportWidth - width - 8)),
    );
    setMenuStyle({
      position: 'fixed',
      top: openUpward ? undefined : rect.bottom + OBJECT_COMBOBOX_MENU_GAP,
      bottom: openUpward
        ? viewportHeight - rect.top + OBJECT_COMBOBOX_MENU_GAP
        : undefined,
      left,
      width: width || undefined,
      maxHeight,
      zIndex: 2100,
    });
  }, []);

  useEffect(() => {
    setActiveIndex(-1);
  }, [filtered.length, open, showAll, value]);

  useLayoutEffect(() => {
    if (!open || !canPortal) return undefined;
    updateMenuPosition();
    const onReposition = () => updateMenuPosition();
    globalThis.addEventListener?.('resize', onReposition);
    document.addEventListener('scroll', onReposition, true);
    return () => {
      globalThis.removeEventListener?.('resize', onReposition);
      document.removeEventListener('scroll', onReposition, true);
    };
  }, [canPortal, filtered.length, open, updateMenuPosition, value]);

  useEffect(() => {
    if (!open || !canPortal) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (typeof Node === 'undefined' || !(target instanceof Node)) return;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [canPortal, open]);

  const menu = open ? (
    <div
      ref={menuRef}
      id={listId}
      className="gn-data-sync-object-combobox__menu"
      role="listbox"
      data-object-combobox-menu="true"
      data-portaled={canPortal ? 'true' : 'false'}
      style={canPortal ? menuStyle : undefined}
    >
      {filtered.map((object, optionIndex) => (
        <button
          id={`${listId}-option-${optionIndex}`}
          type="button"
          role="option"
          aria-selected={normalizeName(object.name) === normalizeName(value)}
          data-active={activeIndex === optionIndex ? 'true' : 'false'}
          key={`${object.kind}:${object.name}`}
          onMouseDown={(event) => {
            event.preventDefault();
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
  ) : null;

  return (
    <div
      ref={rootRef}
      className="gn-data-sync-object-combobox"
      data-open={open ? 'true' : 'false'}
    >
      <input
        ref={inputRef}
        className="gn-data-sync-table-input gn-data-sync-mono"
        data-object-side={side}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-labelledby={labelledBy}
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
          setShowAll(true);
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
          if (open && showAll) {
            setOpen(false);
            return;
          }
          setShowAll(true);
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        ▾
      </button>
      {canPortal && menu ? createPortal(menu, document.body) : menu}
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
  const [catalogSearch, setCatalogSearch] = useState('');
  const [expandedMappingIds, setExpandedMappingIds] = useState<Set<string>>(
    new Set(),
  );
  const [visibleLimit, setVisibleLimit] = useState(MAPPING_BATCH_SIZE);
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

  return (
    <section
      className={`gn-data-sync-section${showCatalog ? ' gn-data-sync-section--mappings' : ''}`}
      data-data-sync-mapping-section="true"
    >
      <header className="gn-data-sync-section__header">
        <div>
          <h2>{t('mapping.title')}</h2>
          <p>{t(querySink ? 'mapping.query_help' : 'mapping.help')}</p>
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
          <p>{showCatalog ? t('mapping.none_selected_desc') : emptyDescription}</p>
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
                      {t(showCatalog ? 'mapping.write_to' : 'mapping.target')}
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
