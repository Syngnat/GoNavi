import type { ImportInferredColumn } from '../importTableTypeMapping.types';
import { decimalType } from '../importTableTypeMapping.shared';

export const mapClickHouseType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'Int64';
    case 'decimal':
      return decimalType('Decimal', column, 30, 10, 76, 30);
    case 'boolean':
      return 'UInt8';
    case 'date':
      return 'Date';
    case 'datetime':
      return 'DateTime64(6)';
    default:
      return 'String';
  }
};
