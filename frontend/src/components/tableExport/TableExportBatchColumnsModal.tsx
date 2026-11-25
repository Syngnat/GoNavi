import React, { useEffect, useState } from 'react';
import { Alert, Button } from 'antd';
import Modal from '../common/ResizableDraggableModal';
import { t } from '../../i18n';
import { fetchTableInfo } from '../../utils/backendTableInfo';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { splitQualifiedName } from '../../utils/qualifiedName';
import type { TableExportBatchColumnState, TableExportStateApi } from './hooks/useTableExportState';
import './TableExportBatchColumnsModal.css';

export interface TableExportBatchColumnsModalProps {
  open: boolean;
  selectedObjectNames: string[];
  columnStates: Record<string, TableExportBatchColumnState>;
  connectionConfig: TableExportStateApi['connectionConfig'];
  selectedDbName: TableExportStateApi['selectedDbName'];
  disabled?: boolean;
  onChange: (tableName: string, columns: string[]) => void;
  onClose: () => void;
}

export const TableExportBatchColumnsModal: React.FC<TableExportBatchColumnsModalProps> = ({
  open,
  selectedObjectNames,
  columnStates,
  connectionConfig,
  selectedDbName,
  disabled = false,
  onChange,
  onClose,
}) => {
  const [activeTableName, setActiveTableName] = useState('');
  const [tableComments, setTableComments] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open || selectedObjectNames.length === 0) return;
    if (!selectedObjectNames.includes(activeTableName)) {
      setActiveTableName(selectedObjectNames[0]);
    }
  }, [activeTableName, open, selectedObjectNames]);

  useEffect(() => {
    if (!open || !connectionConfig || !selectedDbName || selectedObjectNames.length === 0) {
      return undefined;
    }
    let alive = true;
    const tables = Array.from(new Set(selectedObjectNames.map((name) => String(name || '').trim()).filter(Boolean)));
    Promise.all(tables.map(async (tableName) => {
      const { parentPath, objectName } = splitQualifiedName(tableName, connectionConfig.type);
      const result = await fetchTableInfo(
        buildRpcConnectionConfig(connectionConfig) as any,
        selectedDbName,
        parentPath,
        objectName || tableName,
      );
      return {
        tableName,
        comment: result.success ? String(result.details?.comment || '').trim() : '',
      };
    })).then((results) => {
      if (!alive) return;
      setTableComments((prev) => {
        const next = { ...prev };
        results.forEach(({ tableName, comment }) => {
          next[tableName] = comment;
        });
        return next;
      });
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [connectionConfig, open, selectedDbName, selectedObjectNames]);

  const effectiveTableName = selectedObjectNames.includes(activeTableName)
    ? activeTableName
    : (selectedObjectNames[0] || '');
  const activeState = columnStates[effectiveTableName];
  const availableColumns = activeState?.availableColumns || [];
  const selectedColumns = activeState?.selectedColumns || [];
  const selectedColumnSet = new Set(selectedColumns);
  const columnDefinitions = activeState?.columnDefinitions || [];

  const updateSelectedColumns = (nextSelected: string[]) => {
    const nextSelectedSet = new Set(nextSelected);
    onChange(
      effectiveTableName,
      availableColumns.filter((column) => nextSelectedSet.has(column)),
    );
  };

  const toggleColumn = (column: string) => {
    const nextSelectedSet = new Set(selectedColumns);
    if (nextSelectedSet.has(column)) {
      nextSelectedSet.delete(column);
    } else {
      nextSelectedSet.add(column);
    }
    updateSelectedColumns(Array.from(nextSelectedSet));
  };

  return (
    <Modal
      open={open}
      title={t('data_export.dialog.field.columns')}
      width={1040}
      onCancel={onClose}
      maskClosable={false}
      destroyOnHidden
      footer={(
        <Button type="primary" onClick={onClose}>
          {t('common.ok')}
        </Button>
      )}
    >
      <div
        data-batch-columns-modal="true"
        className="gn-table-export-columns-modal"
      >
        <div
          data-batch-columns-table-list="true"
          className="gn-table-export-columns-table-list"
        >
          {selectedObjectNames.map((tableName) => {
            const state = columnStates[tableName];
            const selectedCount = state?.selectedColumns.length || 0;
            const availableCount = state?.availableColumns.length || 0;
            const tableComment = tableComments[tableName] || '';
            const active = tableName === effectiveTableName;
            return (
              <Button
                key={tableName}
                type="text"
                block
                data-batch-columns-table={tableName}
                onClick={() => setActiveTableName(tableName)}
                style={{
                  justifyContent: 'flex-start',
                  height: 'auto',
                  padding: '8px 10px',
                  textAlign: 'left',
                  background: active ? 'var(--gn-bg-active, rgba(22,119,255,0.1))' : undefined,
                }}
              >
                <span style={{ display: 'flex', width: '100%', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {tableName}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--gn-fg-3, rgba(0,0,0,0.45))' }}>
                    {t('data_export.dialog.field.columns_selected', {
                      selected: selectedCount,
                      total: availableCount,
                    })}
                  </span>
                  {tableComment ? (
                    <span
                      data-batch-columns-table-comment={tableName}
                      title={tableComment}
                      style={{
                        maxWidth: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 12,
                        color: 'var(--gn-fg-3, rgba(0,0,0,0.45))',
                      }}
                    >
                      {tableComment}
                    </span>
                  ) : null}
                </span>
              </Button>
            );
          })}
        </div>

        <div style={{ display: 'flex', minWidth: 0, flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {effectiveTableName}
            </div>
            <div style={{ display: 'flex', flex: '0 0 auto', gap: 4 }}>
              <Button size="small" type="text" disabled={disabled || availableColumns.length === 0} onClick={() => updateSelectedColumns(availableColumns)}>
                {t('data_export.action.select_all')}
              </Button>
              <Button size="small" type="text" disabled={disabled || selectedColumns.length === 0} onClick={() => updateSelectedColumns([])}>
                {t('data_export.action.clear')}
              </Button>
            </div>
          </div>
          <div
            data-batch-columns-selected-count="true"
            style={{ fontSize: 12, color: 'var(--gn-fg-3, rgba(0,0,0,0.45))' }}
          >
            {t('data_export.dialog.field.columns_selected', {
              selected: selectedColumns.length,
              total: availableColumns.length,
            })}
          </div>
          {activeState?.loading === true ? (
            <div style={{ padding: 20, color: 'var(--gn-fg-3, rgba(0,0,0,0.45))' }}>...</div>
          ) : (
            <div
              data-batch-columns-bubbles="true"
              className="gn-table-export-column-chips"
            >
              {columnDefinitions.map((column) => {
                const selected = selectedColumnSet.has(column.name);
                const details = [column.type, column.comment].filter(Boolean).join(' · ');
                return (
                  <button
                    key={column.name}
                    type="button"
                    aria-pressed={selected}
                    data-batch-column-bubble={column.name}
                    data-selected={selected ? 'true' : 'false'}
                    title={[column.name, details].filter(Boolean).join('\n')}
                    disabled={disabled}
                    onClick={() => toggleColumn(column.name)}
                    className="gn-table-export-column-chip"
                  >
                    {selected ? <span className="gn-table-export-column-chip-check" aria-hidden="true">✓</span> : null}
                    <span className="gn-table-export-column-chip-text">
                      <span className="gn-table-export-column-chip-name">{column.name}</span>
                      {details ? <span className="gn-table-export-column-chip-meta">{details}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--gn-fg-3, rgba(0,0,0,0.45))' }}>
            {t('data_export.dialog.field.columns_help')}
          </div>
          {activeState?.error ? (
            <Alert type="error" showIcon message={activeState.error} />
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

export default TableExportBatchColumnsModal;
