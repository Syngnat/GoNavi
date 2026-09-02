import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import {
  autoMatchDataSyncFields,
  type DataSyncFieldMapping,
  type DataSyncFieldMetadata,
  type DataSyncTableMapping,
  type DataSyncEndpointRef,
} from './model';
import type { DataSyncWorkbenchTranslate } from './text';
import type { DataSyncWorkbenchGateway } from './gateway';
import {
  useDataSyncFields,
  type DataSyncMetadataResult,
} from './useDataSyncMetadata';

const SUPPORTED_TRANSFORMS = [
  '',
  'trim',
  'lower',
  'upper',
  'string',
  'int64',
  'bool',
  'date',
  'timestamp',
  'json',
] as const;
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

const nextFieldMappingId = (mapping: DataSyncTableMapping): string => {
  let sequence = mapping.fields.length + 1;
  while (mapping.fields.some((field) => field.id === `${mapping.id}:field:${sequence}`)) {
    sequence += 1;
  }
  return `${mapping.id}:field:${sequence}`;
};

const metadataFor = (
  items: DataSyncFieldMetadata[],
  name: string,
): DataSyncFieldMetadata | undefined =>
  items.find((field) => field.name.toLowerCase() === name.toLowerCase());

const FieldMetadataState: React.FC<{
  side: 'source' | 'target';
  state: DataSyncMetadataResult<DataSyncFieldMetadata>;
  t: DataSyncWorkbenchTranslate;
}> = ({ side, state, t }) => (
  <span
    className="gn-data-sync-field-metadata-state"
    data-metadata-scope={`${side}-fields`}
    data-status={state.status}
  >
    {t(`mapping.${side}`)}:{' '}
    {state.status === 'loading'
      ? t('metadata.loading_fields')
      : state.status === 'error'
        ? t('metadata.load_failed')
        : state.status === 'idle'
          ? t('metadata.object_required')
          : t('metadata.fields_count', { count: state.items.length })}
    {state.status === 'error' ? (
      <button
        type="button"
        className="gn-data-sync-link-button"
        onClick={state.reload}
      >
        {t('metadata.retry')}
      </button>
    ) : null}
  </span>
);

export const DataSyncFieldMappingEditor: React.FC<{
  gateway: DataSyncWorkbenchGateway;
  source: DataSyncEndpointRef;
  target: DataSyncEndpointRef;
  mapping: DataSyncTableMapping;
  t: DataSyncWorkbenchTranslate;
  onChange: (mapping: DataSyncTableMapping) => void;
  onClose: () => void;
}> = ({ gateway, source, target, mapping, t, onChange, onClose }) => {
  const sourceFields = useDataSyncFields(gateway, source, mapping.sourceObject);
  const targetFields = useDataSyncFields(gateway, target, mapping.targetObject);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  const patchField = (field: DataSyncFieldMapping) => {
    onChange({
      ...mapping,
      fields: mapping.fields.map((item) => (item.id === field.id ? field : item)),
    });
  };

  const addField = () => {
    const usedSource = new Set(mapping.fields.map((field) => field.sourceField));
    const usedTarget = new Set(mapping.fields.map((field) => field.targetField));
    const sourceField = sourceFields.items.find((field) => !usedSource.has(field.name));
    const matchingTarget = sourceField
      ? metadataFor(targetFields.items, sourceField.name)
      : undefined;
    const targetField =
      matchingTarget || targetFields.items.find((field) => !usedTarget.has(field.name));
    onChange({
      ...mapping,
      fields: [
        ...mapping.fields,
        {
          id: nextFieldMappingId(mapping),
          sourceField: sourceField?.name || '',
          targetField: targetField?.name || '',
          sourceType: sourceField?.type || '',
          targetType: targetField?.type || '',
          transform: '',
          nullable: targetField?.nullable ?? true,
        },
      ],
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === panelRef.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const editor = (
    <div
      className="gn-data-sync-overlay gn-data-sync-overlay--drawer"
      data-data-sync-overlay="field-mapping"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        className="gn-data-sync-field-mapper"
        data-data-sync-field-mapping={mapping.id}
        role="dialog"
        aria-modal="true"
        aria-label={t('field_mapping.title')}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
      <header className="gn-data-sync-section__header">
        <div>
          <h3>{t('field_mapping.title')}</h3>
          <p className="gn-data-sync-mono">
            {mapping.sourceObject} → {mapping.targetObject}
          </p>
        </div>
        <button
          type="button"
          className="gn-data-sync-link-button"
          onClick={onClose}
        >
          {t('field_mapping.close')}
        </button>
      </header>
      <div className="gn-data-sync-field-metadata-line" aria-live="polite">
        <FieldMetadataState side="source" state={sourceFields} t={t} />
        <FieldMetadataState side="target" state={targetFields} t={t} />
        <span className="gn-data-sync-field-metadata-line__spacer" />
        <button
          type="button"
          className="gn-data-sync-button"
          disabled={
            sourceFields.status !== 'ready' || targetFields.status !== 'ready'
          }
          onClick={() =>
            onChange({
              ...mapping,
              fields: autoMatchDataSyncFields(
                mapping.id,
                sourceFields.items,
                targetFields.items,
                mapping.fields,
              ),
            })
          }
        >
          {t('field_mapping.auto_match')}
        </button>
        <button
          type="button"
          className="gn-data-sync-button"
          disabled={sourceFields.status === 'loading' || targetFields.status === 'loading'}
          onClick={addField}
        >
          {t('field_mapping.add')}
        </button>
      </div>
      {mapping.fields.length === 0 ? (
        <div className="gn-data-sync-field-mapper__empty">
          <strong>{t('field_mapping.empty_title')}</strong>
          <span>{t('field_mapping.empty_desc')}</span>
        </div>
      ) : (
        <div className="gn-data-sync-table-scroll">
          <table className="gn-data-sync-field-table">
            <thead>
              <tr>
                <th>{t('field_mapping.source')}</th>
                <th>{t('field_mapping.target')}</th>
                <th>{t('field_mapping.transform')}</th>
                <th>{t('field_mapping.type')}</th>
                <th>
                  <span className="gn-data-sync-visually-hidden">
                    {t('field_mapping.remove')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {mapping.fields.map((field) => (
                <tr key={field.id} data-field-mapping-id={field.id}>
                  <td>
                    <select
                      className="gn-data-sync-table-input gn-data-sync-mono"
                      data-field-control="source"
                      value={field.sourceField}
                      onChange={(event) => {
                        const metadata = metadataFor(sourceFields.items, event.target.value);
                        patchField({
                          ...field,
                          sourceField: event.target.value,
                          sourceType: metadata?.type || '',
                        });
                      }}
                    >
                      {field.sourceField && !metadataFor(sourceFields.items, field.sourceField) ? (
                        <option value={field.sourceField}>{field.sourceField}</option>
                      ) : null}
                      <option value="">{t('field_mapping.select_field')}</option>
                      {sourceFields.items.map((item) => (
                        <option key={item.name} value={item.name}>{item.name}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="gn-data-sync-table-input gn-data-sync-mono"
                      data-field-control="target"
                      value={field.targetField}
                      onChange={(event) => {
                        const metadata = metadataFor(targetFields.items, event.target.value);
                        patchField({
                          ...field,
                          targetField: event.target.value,
                          targetType: metadata?.type || '',
                          nullable: metadata?.nullable ?? true,
                        });
                      }}
                    >
                      {field.targetField && !metadataFor(targetFields.items, field.targetField) ? (
                        <option value={field.targetField}>{field.targetField}</option>
                      ) : null}
                      <option value="">{t('field_mapping.select_field')}</option>
                      {targetFields.items.map((item) => (
                        <option key={item.name} value={item.name}>{item.name}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="gn-data-sync-table-input gn-data-sync-mono"
                      data-field-control="transform"
                      value={field.transform}
                      onChange={(event) =>
                        patchField({ ...field, transform: event.target.value })
                      }
                    >
                      {field.transform &&
                      !SUPPORTED_TRANSFORMS.includes(
                        field.transform as (typeof SUPPORTED_TRANSFORMS)[number],
                      ) ? (
                        <option value={field.transform} disabled>{field.transform}</option>
                      ) : null}
                      {SUPPORTED_TRANSFORMS.map((transform) => (
                        <option key={transform || 'identity'} value={transform}>
                          {transform || t('field_mapping.transform_identity')}
                        </option>
                      ))}
                    </select>
                    <input
                      className="gn-data-sync-table-input gn-data-sync-mono"
                      data-field-control="transform-argument"
                      value={field.transformArgument || ''}
                      placeholder={t('field_mapping.transform_argument')}
                      onChange={(event) =>
                        patchField({
                          ...field,
                          transformArgument: event.target.value,
                        })
                      }
                    />
                  </td>
                  <td>
                    <span className="gn-data-sync-field-type gn-data-sync-mono">
                      {field.sourceType || '—'} → {field.targetType || '—'}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="gn-data-sync-link-button gn-data-sync-link-button--danger"
                      onClick={() =>
                        onChange({
                          ...mapping,
                          fields: mapping.fields.filter((item) => item.id !== field.id),
                        })
                      }
                    >
                      {t('field_mapping.remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </section>
    </div>
  );

  return typeof document === 'undefined' ? editor : createPortal(editor, document.body);
};
