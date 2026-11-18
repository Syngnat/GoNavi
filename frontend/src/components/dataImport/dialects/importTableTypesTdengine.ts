import type { ImportInferredColumn } from '../importTableTypeMapping.types';

export const mapTdengineType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'BIGINT';
    case 'decimal':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOL';
    case 'date':
    case 'datetime':
    case 'time':
      return 'TIMESTAMP';
    case 'text':
      return 'VARCHAR(255)';
    default:
      return 'NCHAR(255)';
  }
};
