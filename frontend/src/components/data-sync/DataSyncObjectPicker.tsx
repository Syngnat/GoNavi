import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DataSyncObjectMetadata } from './model';
import type { DataSyncWorkbenchTranslate } from './text';

const normalizeName = (value: string): string => value.trim().toLowerCase();
const OBJECT_BATCH_SIZE = 160;
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

const formatBytes = (value?: number): string => {
  if (!Number.isFinite(value) || Number(value) < 0) return '';
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

const ObjectFacts: React.FC<{
  object: DataSyncObjectMetadata;
  t: DataSyncWorkbenchTranslate;
}> = ({ object, t }) => {
  const hasSize = object.dataBytes !== undefined || object.indexBytes !== undefined;
  const totalBytes = hasSize
    ? (object.dataBytes ?? 0) + (object.indexBytes ?? 0)
    : undefined;
  const facts = [
    Number.isFinite(object.rowCount)
      ? t('mapping.rows_count', {
          count: Number(object.rowCount).toLocaleString(),
        })
      : '',
    formatBytes(totalBytes),
  ].filter(Boolean);
  return facts.length > 0 ? <small>{facts.join(' · ')}</small> : null;
};

export const DataSyncObjectPicker: React.FC<{
  open: boolean;
  objects: DataSyncObjectMetadata[];
  mappedSourceNames: string[];
  disabled?: boolean;
  t: DataSyncWorkbenchTranslate;
  onClose: () => void;
  onConfirm: (sourceNames: string[]) => void | Promise<void>;
}> = ({
  open,
  objects,
  mappedSourceNames,
  disabled = false,
  t,
  onClose,
  onConfirm,
}) => {
  const [search, setSearch] = useState('');
  const [includeViews, setIncludeViews] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(OBJECT_BATCH_SIZE);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setIncludeViews(false);
    setSelected(new Set());
    setSubmitting(false);
    setVisibleLimit(OBJECT_BATCH_SIZE);
  }, [open]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusSearch = () =>
      dialogRef.current
        ?.querySelector<HTMLInputElement>('[data-object-picker-control="search"]')
        ?.focus();
    const frame =
      typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame(focusSearch)
        : undefined;
    if (frame === undefined) focusSearch();
    return () => {
      if (frame !== undefined && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(frame);
      }
      returnFocus?.focus();
    };
  }, [open]);

  const mapped = useMemo(
    () => new Set(mappedSourceNames.map(normalizeName).filter(Boolean)),
    [mappedSourceNames],
  );
  const filtered = useMemo(() => {
    const needle = normalizeName(search);
    return objects.filter(
      (object) =>
        (includeViews || object.kind !== 'view') &&
        (!needle || normalizeName(object.name).includes(needle)),
    );
  }, [includeViews, objects, search]);
  const eligibleFiltered = useMemo(
    () => filtered.filter((object) => !mapped.has(normalizeName(object.name))),
    [filtered, mapped],
  );
  const visibleObjects = filtered.slice(0, visibleLimit);
  const remainingCount = Math.max(0, filtered.length - visibleObjects.length);
  const allFilteredSelected =
    eligibleFiltered.length > 0 &&
    eligibleFiltered.every((object) => selected.has(object.name));

  if (!open) return null;

  const requestClose = () => {
    if (!submitting) onClose();
  };

  const toggleSelected = (name: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const picker = (
    <div
      className="gn-data-sync-overlay"
      data-data-sync-overlay="object-picker"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="gn-data-sync-object-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t('mapping.picker_title')}
        data-data-sync-object-picker="true"
        onKeyDown={handleKeyDown}
      >
        <header className="gn-data-sync-object-picker__header">
          <strong>{t('mapping.picker_title')}</strong>
          <button
            type="button"
            className="gn-data-sync-icon-button"
            aria-label={t('common.dismiss')}
            disabled={submitting}
            onClick={requestClose}
          >
            ×
          </button>
        </header>
      <div className="gn-data-sync-object-picker__toolbar">
        <label className="gn-data-sync-object-picker__search">
          <span className="gn-data-sync-visually-hidden">{t('mapping.search_objects')}</span>
          <input
            type="search"
            data-object-picker-control="search"
            value={search}
            placeholder={t('mapping.search_objects')}
            autoFocus
            onChange={(event) => {
              setVisibleLimit(OBJECT_BATCH_SIZE);
              setSearch(event.target.value);
            }}
          />
        </label>
        <label className="gn-data-sync-object-picker__view-toggle">
          <input
            type="checkbox"
            data-object-picker-control="include-views"
            checked={includeViews}
            onChange={(event) => {
              setVisibleLimit(OBJECT_BATCH_SIZE);
              setIncludeViews(event.target.checked);
            }}
          />
          <span>{t('mapping.include_views')}</span>
        </label>
        <span className="gn-data-sync-object-picker__count" aria-live="polite">
          {t('mapping.selected_count', {
            selected: selected.size,
            total: objects.length,
          })}
        </span>
      </div>

      <div className="gn-data-sync-object-picker__select-all">
        <label>
          <input
            type="checkbox"
            data-object-picker-control="select-filtered"
            checked={allFilteredSelected}
            disabled={eligibleFiltered.length === 0}
            onChange={(event) => {
              const checked = event.target.checked;
              setSelected((previous) => {
                const next = new Set(previous);
                eligibleFiltered.forEach((object) => {
                  if (checked) next.add(object.name);
                  else next.delete(object.name);
                });
                return next;
              });
            }}
          />
          <span>{t('mapping.select_filtered', { count: eligibleFiltered.length })}</span>
        </label>
        <span>{t('mapping.selection_fixed_scope')}</span>
      </div>

      <div
        className="gn-data-sync-object-picker__list"
        role="group"
        aria-label={t('mapping.picker_title')}
      >
        {filtered.length === 0 ? (
          <p className="gn-data-sync-object-picker__empty">{t('mapping.no_objects')}</p>
        ) : (
          visibleObjects.map((object) => {
            const alreadyMapped = mapped.has(normalizeName(object.name));
            const checked = selected.has(object.name);
            return (
              <label
                key={`${object.kind}:${object.name}`}
                className="gn-data-sync-object-picker__item"
                data-disabled={alreadyMapped ? 'true' : 'false'}
                data-object-name={object.name}
              >
                <input
                  type="checkbox"
                  checked={checked || alreadyMapped}
                  disabled={disabled || alreadyMapped}
                  onChange={(event) => toggleSelected(object.name, event.target.checked)}
                />
                <span className="gn-data-sync-object-picker__object">
                  <strong>{object.name}</strong>
                  <small>{t(`mapping.object_kind.${object.kind}`)}</small>
                </span>
                <ObjectFacts object={object} t={t} />
                {alreadyMapped ? (
                  <span className="gn-data-sync-object-picker__mapped">
                    {t('mapping.already_added')}
                  </span>
                ) : null}
              </label>
            );
          })
        )}
        {remainingCount > 0 ? (
          <button
            type="button"
            className="gn-data-sync-object-picker__more"
            data-object-picker-control="show-more"
            onClick={() => {
              const firstNewRowIndex = visibleObjects.length;
              const buttonWillUnmount = remainingCount <= OBJECT_BATCH_SIZE;
              setVisibleLimit((current) => current + OBJECT_BATCH_SIZE);
              if (buttonWillUnmount && typeof globalThis.requestAnimationFrame === 'function') {
                globalThis.requestAnimationFrame(() => {
                  const dialog = dialogRef.current;
                  const firstNewEnabledInput = Array.from(
                    dialog?.querySelectorAll<HTMLElement>(
                      '.gn-data-sync-object-picker__item',
                    ) || [],
                  )
                    .slice(firstNewRowIndex)
                    .map((row) =>
                      row.querySelector<HTMLInputElement>('input:not(:disabled)'),
                    )
                    .find((input): input is HTMLInputElement => Boolean(input));
                  const fallback = dialog?.querySelector<HTMLButtonElement>(
                    '.gn-data-sync-object-picker__actions button:not(:disabled)',
                  );
                  (firstNewEnabledInput || fallback)?.focus();
                });
              }
            }}
          >
            {t('mapping.show_more', {
              count: Math.min(OBJECT_BATCH_SIZE, remainingCount),
              remaining: remainingCount,
            })}
          </button>
        ) : null}
      </div>

      <footer className="gn-data-sync-object-picker__actions">
        <button
          type="button"
          className="gn-data-sync-button"
          disabled={submitting}
          onClick={requestClose}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="gn-data-sync-button gn-data-sync-button--primary"
          disabled={disabled || submitting || selected.size === 0}
          onClick={() => {
            setSubmitting(true);
            void Promise.resolve(onConfirm(Array.from(selected))).then(
              () => {
                setSubmitting(false);
                onClose();
              },
              () => setSubmitting(false),
            );
          }}
        >
          {submitting
            ? t('mapping.detecting_keys')
            : t('mapping.add_selected', { count: selected.size })}
        </button>
      </footer>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? picker : createPortal(picker, document.body);
};
