import type { ImportInferredColumn } from '../importTableTypeMapping.types';
import { decimalType, isLongText } from '../importTableTypeMapping.shared';

export const mapSqlServerType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'BIGINT';
    case 'decimal':
      return decimalType('DECIMAL', column, 30, 10, 38, 30);
    case 'boolean':
      return 'BIT';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'DATETIME2(6)';
    case 'time':
      return 'TIME(6)';
    case 'uuid':
      return 'NVARCHAR(36)';
    case 'json':
      return 'NVARCHAR(MAX)';
    case 'longtext':
      return 'NVARCHAR(MAX)';
    case 'text':
      return isLongText(column) ? 'NVARCHAR(MAX)' : 'NVARCHAR(255)';
    case 'binary':
      return 'VARBINARY(MAX)';
    default:
      return isLongText(column) ? 'NVARCHAR(MAX)' : 'NVARCHAR(255)';
  }
};
