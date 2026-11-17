import type { ImportInferredColumn } from '../importTableTypeMapping.types';
import { decimalType } from '../importTableTypeMapping.shared';

export const mapHiveType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'BIGINT';
    case 'decimal':
      return decimalType('DECIMAL', column, 38, 18, 38, 18);
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMP';
    case 'binary':
      return 'BINARY';
    default:
      return 'STRING';
  }
};
