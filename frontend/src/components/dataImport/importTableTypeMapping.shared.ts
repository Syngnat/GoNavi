import type { ImportInferredColumn } from './importTableTypeMapping.types';

export const asPositiveInteger = (value: unknown, fallback: number): number => {
  const numberValue = Math.trunc(Number(value));
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
};

export const asNonNegativeInteger = (value: unknown, fallback: number): number => {
  const numberValue = Math.trunc(Number(value));
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
};

export const decimalParts = (
  column: Pick<ImportInferredColumn, 'precision' | 'scale'>,
  defaultPrecision: number,
  defaultScale: number,
  maxPrecision: number,
  maxScale: number,
): { precision: number; scale: number } => {
  let precision = Math.min(maxPrecision, asPositiveInteger(column.precision, defaultPrecision));
  let scale = Math.min(maxScale, asNonNegativeInteger(column.scale, defaultScale));
  if (scale > precision) {
    if (precision < maxPrecision) {
      precision = Math.min(maxPrecision, scale);
    } else {
      scale = precision;
    }
  }
  return { precision, scale };
};

export const decimalType = (
  name: string,
  column: Pick<ImportInferredColumn, 'precision' | 'scale'>,
  defaultPrecision: number,
  defaultScale: number,
  maxPrecision: number,
  maxScale: number,
): string => {
  const parts = decimalParts(column, defaultPrecision, defaultScale, maxPrecision, maxScale);
  return `${name}(${parts.precision},${parts.scale})`;
};

export const isLongText = (column: Pick<ImportInferredColumn, 'logicalType' | 'maxLength'>): boolean => (
  column.logicalType === 'longtext' || asNonNegativeInteger(column.maxLength, 0) > 255
);
