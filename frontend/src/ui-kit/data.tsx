import React, { useMemo, type ReactNode } from 'react';
import { Tree } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { GonaviDataTable, GonaviEmptyState } from './components';

export interface GonaviJsonViewerProps {
  value: unknown;
  rootLabel?: string;
  maxHeight?: number;
}

/** Renders a bounded, text-only JSON snapshot. It never interprets values as HTML. */
export const GonaviJsonViewer: React.FC<GonaviJsonViewerProps> = ({ value, rootLabel, maxHeight = 320 }) => (
  <div className="gonavi-json-viewer" style={{ maxHeight }} tabIndex={0}>
    {rootLabel && <div className="gonavi-json-root">{rootLabel}</div>}
    <pre>{formatJson(value)}</pre>
  </div>
);

export function formatJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
  } catch {
    return String(value);
  }
}

export interface GonaviTreeNode {
  key: string;
  title: ReactNode;
  children?: GonaviTreeNode[];
  disabled?: boolean;
  selectable?: boolean;
}

export interface GonaviTreeViewProps {
  nodes: GonaviTreeNode[];
  defaultExpandAll?: boolean;
  selectedKeys?: string[];
  height?: number;
  onSelect?: (key: string) => void;
}

/** A host-styled tree for database objects, files or arbitrary plugin data. */
export const GonaviTreeView: React.FC<GonaviTreeViewProps> = ({
  nodes,
  defaultExpandAll,
  selectedKeys,
  height = 360,
  onSelect,
}) => (
  <div className="gonavi-tree-view" style={{ height }}>
    <Tree
      treeData={nodes as never}
      defaultExpandAll={defaultExpandAll}
      selectedKeys={selectedKeys}
      onSelect={(keys) => {
        const key = keys[0];
        if (typeof key === 'string') onSelect?.(key);
      }}
    />
  </div>
);

export interface GonaviResultGridProps {
  rows: Record<string, unknown>[];
  columns?: ColumnsType<Record<string, unknown>>;
  height?: number;
  loading?: boolean;
  emptyText?: ReactNode;
  maxColumns?: number;
}

export function formatCapabilityCell(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return formatJson(value);
}

export function inferResultColumns(
  rows: readonly Record<string, unknown>[],
  maxColumns = 32,
): ColumnsType<Record<string, unknown>> {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) keys.push(key);
      if (keys.length >= maxColumns) break;
    }
    if (keys.length >= maxColumns) break;
  }
  return keys.map((key) => ({
    key,
    dataIndex: key,
    title: key,
    ellipsis: true,
    render: (value: unknown) => formatCapabilityCell(value),
  }));
}

/**
 * Read-only result grid for capability results. Rows are plain records; the
 * component infers stable columns when the plugin does not pass any, and never
 * renders database values as HTML.
 */
export const GonaviResultGrid: React.FC<GonaviResultGridProps> = ({
  rows,
  columns,
  height = 360,
  loading,
  emptyText,
  maxColumns = 32,
}) => {
  const resolvedColumns = useMemo(() => columns ?? inferResultColumns(rows, maxColumns), [columns, maxColumns, rows]);
  const data = useMemo(
    () => rows.map((row, index) => ({ ...row, __gonaviRowKey: index })),
    [rows],
  );
  if (!rows.length) {
    return <GonaviEmptyState title={emptyText ?? 'No rows'} />;
  }
  return (
    <GonaviDataTable
      columns={resolvedColumns}
      rows={data}
      rowKey={(row) => Number((row as Record<string, unknown>).__gonaviRowKey)}
      height={height}
      loading={loading}
    />
  );
};
