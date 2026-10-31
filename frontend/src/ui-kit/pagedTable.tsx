import React, { useMemo, useState } from 'react';
import type { TablePaginationConfig } from 'antd';
import { GonaviDataTable, type GonaviDataTableProps } from './components';

export function paginateRows<Row>(rows: readonly Row[], page: number, pageSize: number): Row[] {
  const size = Math.max(1, Math.trunc(pageSize));
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, Math.trunc(page)), totalPages);
  return rows.slice((current - 1) * size, current * size);
}

export interface GonaviPagedTableProps<Row extends object> extends GonaviDataTableProps<Row> {
  pageSize?: number;
  pageSizeOptions?: number[];
}

/**
 * Client-side paged read-only table for plugin result sets. The host still
 * owns query limits; this component only slices rows the plugin already has.
 */
export function GonaviPagedTable<Row extends object>({
  rows,
  pageSize = 50,
  pageSizeOptions = [20, 50, 100],
  ...tableProps
}: GonaviPagedTableProps<Row>) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(pageSize);
  const total = rows.length;
  const maxPage = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(page, maxPage);
  const pageRows = useMemo(() => paginateRows(rows, currentPage, size), [currentPage, rows, size]);
  const pagination: TablePaginationConfig = {
    current: currentPage,
    pageSize: size,
    total,
    showSizeChanger: true,
    pageSizeOptions: pageSizeOptions.map(String),
    showTotal: (count) => `${count} rows`,
    onChange: (nextPage, nextSize) => {
      setPage(nextPage);
      setSize(nextSize);
    },
  };
  return <GonaviDataTable {...tableProps} rows={pageRows} pagination={pagination} />;
}
