import type { ImportInferredColumn } from '../importTableTypeMapping.types';
import { decimalType, isLongText } from '../importTableTypeMapping.shared';

export const mapMysqlType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'bigint';
    case 'decimal':
      return decimalType('decimal', column, 30, 10, 65, 30);
    case 'boolean':
      return 'tinyint(1)';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime(6)';
    case 'time':
      return 'time(6)';
    case 'uuid':
      return 'char(36)';
    case 'json':
      return 'json';
    case 'longtext':
      return 'longtext';
    case 'text':
      return isLongText(column) ? 'longtext' : 'varchar(255)';
    case 'binary':
      return 'varbinary(255)';
    default:
      return isLongText(column) ? 'longtext' : 'varchar(255)';
  }
};
