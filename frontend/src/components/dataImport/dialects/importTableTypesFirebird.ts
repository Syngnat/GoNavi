import type { ImportInferredColumn } from '../importTableTypeMapping.types';
import { decimalType, isLongText } from '../importTableTypeMapping.shared';

export const mapFirebirdType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'BIGINT';
    case 'decimal':
      return decimalType('DECIMAL', column, 18, 4, 18, 4);
    case 'boolean':
      return 'SMALLINT';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMP';
    case 'time':
      return 'TIME';
    case 'uuid':
      return 'VARCHAR(36)';
    case 'json':
    case 'longtext':
      return 'BLOB SUB_TYPE TEXT';
    case 'text':
      return isLongText(column) ? 'BLOB SUB_TYPE TEXT' : 'VARCHAR(255)';
    case 'binary':
      return 'BLOB';
    default:
      return isLongText(column) ? 'BLOB SUB_TYPE TEXT' : 'VARCHAR(255)';
  }
};
