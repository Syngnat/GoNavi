import type { ImportInferredColumn } from '../importTableTypeMapping.types';
import { decimalType, isLongText } from '../importTableTypeMapping.shared';

export const mapPostgresType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'bigint';
    case 'decimal':
      return decimalType('numeric', column, 30, 10, 65, 30);
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'timestamp(6)';
    case 'time':
      return 'time(6)';
    case 'uuid':
      return 'uuid';
    case 'json':
      return 'jsonb';
    case 'longtext':
      return 'text';
    case 'text':
      return isLongText(column) ? 'text' : 'varchar(255)';
    case 'binary':
      return 'bytea';
    default:
      return isLongText(column) ? 'text' : 'varchar(255)';
  }
};
