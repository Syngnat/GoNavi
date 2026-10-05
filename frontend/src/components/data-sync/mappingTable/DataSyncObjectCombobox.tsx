import React, { useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type { DataSyncObjectMetadata } from '../model';
import type { DataSyncWorkbenchTranslate } from '../text';
import { normalizeName } from './dataSyncMappingStatus';

const OBJECT_COMBOBOX_MENU_GAP = 3;
const OBJECT_COMBOBOX_MENU_MAX_HEIGHT = 260;
const OBJECT_COMBOBOX_MENU_MIN_HEIGHT = 120;

export const DataSyncObjectCombobox: React.FC<{
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
