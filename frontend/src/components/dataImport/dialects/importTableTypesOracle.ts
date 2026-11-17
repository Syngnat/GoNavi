import type { ImportInferredColumn } from '../importTableTypeMapping.types';
import { decimalType, isLongText } from '../importTableTypeMapping.shared';

export const mapOracleType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'NUMBER(19)';
    case 'decimal':
      return decimalType('NUMBER', column, 30, 10, 38, 30);
    case 'boolean':
      return 'NUMBER(1)';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMP(6)';
    case 'time':
      return 'VARCHAR2(255)';
    case 'uuid':
      return 'VARCHAR2(36)';
    case 'json':
      return 'CLOB';
    case 'longtext':
      return 'CLOB';
    case 'text':
      return isLongText(column) ? 'CLOB' : 'VARCHAR2(255)';
    case 'binary':
      return 'BLOB';
    default:
      return isLongText(column) ? 'CLOB' : 'VARCHAR2(255)';
  }
};
