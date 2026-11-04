import React, { useMemo, useState } from 'react';
import { Input, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { formatCapabilityCell } from './data';
import { GonaviEmptyState } from './components';

/** One grid column. Only columns marked editable accept cell edits. */
export interface GonaviGridColumn {
  key: string;
  title: string;
  width?: number;
  editable?: boolean;
  align?: 'left' | 'right' | 'center';
}

export interface GonaviEditableGridProps<Row extends Record<string, unknown>> {
  columns: readonly GonaviGridColumn[];
  rows: readonly Row[];
  rowKey: string | ((row: Row) => string);
  height?: number;
  readOnly?: boolean;
  loading?: boolean;
  emptyText?: React.ReactNode;
  /** A committed cell edit. The grid is controlled: return the new rows yourself. */
  onChangeRow?: (key: string, column: string, value: unknown) => void;
}

export function gonaviRowKey<Row extends Record<string, unknown>>(
  row: Row,
  rowKey: string | ((row: Row) => string),
): string {
  if (typeof rowKey === 'function') return rowKey(row);
  const value = row[rowKey];
  return value === undefined || value === null ? '' : String(value);
}

/** Immutable cell update used by plugins that keep rows in local state. */
export function applyGonaviGridEdit<Row extends Record<string, unknown>>(
  rows: readonly Row[],
  rowKey: string | ((row: Row) => string),
  key: string,
  column: string,
  value: unknown,
): Row[] {
  return rows.map((row) => (gonaviRowKey(row, rowKey) === key ? { ...row, [column]: value } : row));
}

/**
 * Controlled editable grid for plugin windows. It renders data the plugin owns
 * and reports committed edits; it never fetches, executes or persists anything
 * itself. Visual language follows the host DataGrid without depending on it.
 */
export const GonaviEditableGrid = <Row extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  height = 360,
  readOnly = false,
  loading = false,
  emptyText,
  onChangeRow,
}: GonaviEditableGridProps<Row>) => {
  const [editing, setEditing] = useState<{ key: string; column: string } | null>(null);

  const tableColumns = useMemo<ColumnsType<Row>>(() => columns.map((column) => ({
    key: column.key,
    dataIndex: column.key,
    title: column.title,
    width: column.width,
    align: column.align,
    ellipsis: true,
    render: (value: unknown, row: Row) => {
      const key = gonaviRowKey(row, rowKey);
      const isEditing = editing?.key === key && editing.column === column.key;
      if (isEditing && !readOnly && column.editable) {
        const commit = (next: string) => {
          setEditing(null);
          if (next !== formatCapabilityCell(value)) onChangeRow?.(key, column.key, next);
        };
        return (
          <Input
            size="small"
            autoFocus
            defaultValue={formatCapabilityCell(value)}
            onBlur={(event) => commit(event.target.value)}
            onPressEnter={(event) => commit((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setEditing(null); }}
          />
        );
      }
      return <span onDoubleClick={() => {
        if (!readOnly && column.editable) setEditing({ key, column: column.key });
      }}>{formatCapabilityCell(value)}</span>;
    },
  })), [columns, editing, onChangeRow, readOnly, rowKey]);

  if (!rows.length && !loading) {
    return <GonaviEmptyState title={emptyText ?? 'No rows'} />;
  }

  return (
    <div className="gonavi-editable-grid">
      <Table<Row>
        size="small"
        bordered={false}
        columns={tableColumns}
        dataSource={rows as Row[]}
        rowKey={(row) => gonaviRowKey(row, rowKey)}
        loading={loading}
        pagination={false}
        scroll={{ y: height, x: 'max-content' }}
      />
    </div>
  );
};
