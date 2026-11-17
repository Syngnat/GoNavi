import type { ImportInferredColumn } from '../importTableTypeMapping.types';

export const mapQuestDbType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'LONG';
    case 'decimal':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMP';
    case 'uuid':
      return 'UUID';
    default:
      return 'STRING';
  }
};
