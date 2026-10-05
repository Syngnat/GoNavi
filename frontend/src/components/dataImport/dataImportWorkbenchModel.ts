import React from 'react';
import { Typography } from 'antd';
import type { SavedConnection } from '../../types';
import type { DataImportCapabilityDTO } from '../dataImportCapability';

export const { Text, Title } = Typography;

export const targetSelectStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
};

export type SelectOption = {
  value: string;
  label: React.ReactNode;
  title: string;
};

export type CapabilityLoadState = {
  connectionId: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  value?: DataImportCapabilityDTO;
};

export const normalizeConnectionConfig = (connection: SavedConnection) => ({
  ...connection.config,
  port: Number(connection.config.port),
  password: connection.config.password || '',
  database: connection.config.database || '',
  useSSH: connection.config.useSSH || false,
  ssh: connection.config.ssh || {
    host: '',
    port: 22,
    user: '',
    password: '',
    keyPath: '',
  },
});

export const toSortedOptions = (values: string[]): SelectOption[] => (
  Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map((value) => ({ value, label: value, title: value }))
);

export const normalizeDatabaseNames = (rows: unknown): string[] => {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => String(row?.Database || row?.database || '').trim())
    .filter(Boolean);
};

export const getFileName = (filePath: string): string => {
  const parts = String(filePath || '').split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
};

export const resolvePreferenceStorage = (): Storage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

const parseConflictKeyColumns = (value: string): string[] => (
  String(value || '')
    .split(',')
    .map((column) => column.trim().slice(0, 255))
    .filter(Boolean)
    .filter((column, index, columns) => (
      columns.findIndex((candidate) => candidate.toLowerCase() === column.toLowerCase()) === index
    ))
    .slice(0, 64)
);

export const normalizeConflictKeyColumnsInput = (value: string): {
  columns: string[];
  displayValue: string;
} => {
  const inputValue = String(value || '');
  const columns = parseConflictKeyColumns(inputValue);
  const trailingSeparator = inputValue.match(/,\s*$/)?.[0] || '';
  return {
    columns,
    displayValue: `${columns.join(', ')}${columns.length < 64 ? trailingSeparator : ''}`,
  };
};
