import type { ImportInferredColumn } from '../importTableTypeMapping.types';
import { decimalType, isLongText } from '../importTableTypeMapping.shared';

export const mapGbase8sType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'BIGINT';
    case 'decimal':
      return decimalType('DECIMAL', column, 18, 4, 32, 32);
    case 'boolean':
      return 'SMALLINT';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'DATETIME YEAR TO FRACTION(5)';
    case 'time':
      return 'DATETIME HOUR TO SECOND';
    case 'uuid':
      return 'VARCHAR(36)';
    case 'json':
    case 'longtext':
    case 'text':
      return 'TEXT';
    case 'binary':
      return 'BLOB';
    default:
      return isLongText(column) ? 'TEXT' : 'VARCHAR(255)';
  }
};
