import type { ImportInferredColumn } from '../importTableTypeMapping.types';

export const mapSqliteType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'INTEGER';
    case 'decimal':
      return 'NUMERIC';
    case 'boolean':
      return 'INTEGER';
    case 'longtext':
      return 'TEXT';
    case 'binary':
      return 'BLOB';
    default:
      return 'TEXT';
  }
};
