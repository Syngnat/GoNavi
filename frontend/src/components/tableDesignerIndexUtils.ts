export type IndexKind = 'NORMAL' | 'UNIQUE' | 'PRIMARY' | 'FULLTEXT' | 'SPATIAL';

export interface IndexDisplaySnapshot {
  key: string;
  name: string;
  indexType: string;
  nonUnique: number;
  columnNames: string[];
}

export interface IndexFormSnapshot {
  name: string;
  columnNames: string[];
  kind: IndexKind;
  indexType: string;
}

export interface SchemaExecutionSnapshot {
  failedStatementIndex?: number;
}

export interface IndexMetadataResponse {
  success: boolean;
  data?: unknown;
  message?: unknown;
}

export interface IndexMetadataResolution<T> {
  indexes: T[];
  errorDetail: string | null;
}

export const resolveIndexMetadataResponse = <T = unknown>(
  response: IndexMetadataResponse,
): IndexMetadataResolution<T> => {
  if (!response.success) {
    return {
      indexes: [],
      errorDetail: String(response.message || '').trim(),
    };
  }

  return {
    indexes: Array.isArray(response.data) ? response.data as T[] : [],
    errorDetail: null,
  };
};

export const normalizeIndexFormFromRow = (
  row: IndexDisplaySnapshot,
  supportedKinds: IndexKind[],
): IndexFormSnapshot => {
  const selectedName = String(row.name || '').trim();
  const selectedNameUpper = selectedName.toUpperCase();
  const selectedTypeUpper = String(row.indexType || '').trim().toUpperCase();
  let kind: IndexKind = 'NORMAL';
  if (selectedNameUpper === 'PRIMARY') {
    kind = 'PRIMARY';
  } else if (selectedTypeUpper === 'FULLTEXT') {
    kind = 'FULLTEXT';
  } else if (selectedTypeUpper === 'SPATIAL') {
    kind = 'SPATIAL';
  } else if (row.nonUnique === 0) {
    kind = 'UNIQUE';
  }
  if (!supportedKinds.includes(kind)) {
    kind = row.nonUnique === 0 ? 'UNIQUE' : 'NORMAL';
  }
  return {
    name: kind === 'PRIMARY' ? 'PRIMARY' : selectedName,
    columnNames: [...row.columnNames],
    kind,
    indexType: kind === 'NORMAL' || kind === 'UNIQUE'
      ? (selectedTypeUpper || 'DEFAULT')
      : 'DEFAULT',
  };
};

export const hasIndexFormChanged = (
  previousForm: IndexFormSnapshot,
  nextForm: IndexFormSnapshot,
): boolean => {
  if (previousForm.name !== nextForm.name) return true;
  if (previousForm.kind !== nextForm.kind) return true;
  if (previousForm.indexType !== nextForm.indexType) return true;
  if (previousForm.columnNames.length !== nextForm.columnNames.length) return true;
  return previousForm.columnNames.some((col, idx) => col !== nextForm.columnNames[idx]);
};

export const toggleIndexSelection = (
  selectedKeys: string[],
  key: string,
  checked?: boolean,
): string[] => {
  const exists = selectedKeys.includes(key);
  const nextChecked = checked ?? !exists;
  if (nextChecked) {
    return exists ? selectedKeys : [...selectedKeys, key];
  }
  return selectedKeys.filter((item) => item !== key);
};

export const shouldRestoreOriginalIndex = (result: SchemaExecutionSnapshot): boolean => (
  (result.failedStatementIndex ?? -1) > 0
);
