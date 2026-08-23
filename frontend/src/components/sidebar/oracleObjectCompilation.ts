import { splitQualifiedNameSegments } from '../../utils/qualifiedName';

export type OracleCompilableObject = {
  kind: 'routine' | 'trigger';
  objectName: unknown;
  schemaName?: unknown;
  routineType?: unknown;
};

const ORACLE_OBJECT_COMPILE_STATUSES = new Set(['VALID', 'INVALID']);

export const normalizeOracleObjectCompileStatus = (value: unknown): string => {
  const normalized = String(value ?? '').trim().toUpperCase();
  return ORACLE_OBJECT_COMPILE_STATUSES.has(normalized) ? normalized : '';
};

const quoteOracleIdentifier = (value: string): string => (
  `"${String(value || '').replace(/"/g, '""')}"`
);

const resolveOracleObjectReference = (
  objectName: unknown,
  schemaName: unknown,
): string => {
  const nameParts = splitQualifiedNameSegments(String(objectName ?? '').trim());
  if (nameParts.length === 0 || nameParts.length > 2) return '';

  const object = String(nameParts[nameParts.length - 1] || '').trim();
  if (!object) return '';

  let schema = nameParts.length === 2
    ? String(nameParts[0] || '').trim()
    : String(schemaName ?? '').trim();
  if (schema) {
    const schemaParts = splitQualifiedNameSegments(schema);
    if (schemaParts.length !== 1) return '';
    schema = String(schemaParts[0] || '').trim();
  }

  return [schema, object]
    .filter(Boolean)
    .map(quoteOracleIdentifier)
    .join('.');
};

export const buildOracleObjectCompileSQL = ({
  kind,
  objectName,
  schemaName,
  routineType,
}: OracleCompilableObject): string => {
  const objectReference = resolveOracleObjectReference(objectName, schemaName);
  if (!objectReference) return '';

  if (kind === 'trigger') {
    return `ALTER TRIGGER ${objectReference} COMPILE`;
  }
  if (kind !== 'routine') return '';

  const normalizedRoutineType = String(routineType ?? '').trim().toUpperCase();
  if (normalizedRoutineType !== 'PROCEDURE' && normalizedRoutineType !== 'FUNCTION') {
    return '';
  }
  return `ALTER ${normalizedRoutineType} ${objectReference} COMPILE`;
};
