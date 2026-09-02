import type { SavedConnection, SchemaVisibilityRule } from '../types';

export type SchemaIdentifierOptions = {
  caseSensitive?: boolean;
};

const normalizeIdentifier = (
  value: unknown,
  options: SchemaIdentifierOptions = {},
): string => {
  const identifier = String(value || '').trim();
  return options.caseSensitive ? identifier : identifier.toLocaleLowerCase();
};

export const normalizeSchemaVisibilityRule = (
  value: unknown,
  options: SchemaIdentifierOptions = {},
): SchemaVisibilityRule | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const mode = raw.mode === 'include' || raw.mode === 'exclude'
    ? raw.mode
    : undefined;
  if (!mode || !Array.isArray(raw.schemas)) return undefined;

  const seen = new Set<string>();
  const schemas = raw.schemas.reduce<string[]>((result, item) => {
    const schema = String(item || '').trim();
    const key = normalizeIdentifier(schema, options);
    if (!schema || !key || seen.has(key)) return result;
    seen.add(key);
    result.push(schema);
    return result;
  }, []);

  return schemas.length > 0 ? { mode, schemas } : undefined;
};

export const getSchemaVisibilityRule = (
  connection: Pick<SavedConnection, 'schemaVisibilityByDatabase'> | null | undefined,
  dbName: unknown,
  options: SchemaIdentifierOptions = {},
): SchemaVisibilityRule | undefined => {
  const databaseKey = String(dbName || '').trim();
  if (!databaseKey || !connection?.schemaVisibilityByDatabase) return undefined;
  const rules = connection.schemaVisibilityByDatabase;
  const exact = normalizeSchemaVisibilityRule(rules[databaseKey], options);
  if (exact) return exact;

  const normalizedDatabaseKey = normalizeIdentifier(databaseKey, options);
  const matchedKey = Object.keys(rules).find(
    (key) => normalizeIdentifier(key, options) === normalizedDatabaseKey,
  );
  return matchedKey ? normalizeSchemaVisibilityRule(rules[matchedKey], options) : undefined;
};

export const isSchemaVisible = (
  rule: SchemaVisibilityRule | undefined,
  schemaName: unknown,
  options: SchemaIdentifierOptions = {},
): boolean => {
  if (!rule) return true;
  const normalizedSchemaName = normalizeIdentifier(schemaName, options);
  const selected = rule.schemas.some(
    (schema) => normalizeIdentifier(schema, options) === normalizedSchemaName,
  );
  return rule.mode === 'include' ? selected : !selected;
};

export const updateSchemaVisibilityRule = (
  connection: SavedConnection,
  dbName: unknown,
  rule: SchemaVisibilityRule | undefined,
  options: SchemaIdentifierOptions = {},
): SavedConnection => {
  const databaseName = String(dbName || '').trim();
  if (!databaseName) return connection;

  const nextRules = { ...(connection.schemaVisibilityByDatabase || {}) };
  const existingKey = Object.keys(nextRules).find(
    (key) => normalizeIdentifier(key, options) === normalizeIdentifier(databaseName, options),
  );
  if (existingKey && existingKey !== databaseName) {
    delete nextRules[existingKey];
  }
  const normalizedRule = normalizeSchemaVisibilityRule(rule, options);
  if (normalizedRule) {
    nextRules[databaseName] = normalizedRule;
  } else {
    delete nextRules[databaseName];
  }

  return {
    ...connection,
    schemaVisibilityByDatabase:
      Object.keys(nextRules).length > 0 ? nextRules : undefined,
  };
};

export const moveSchemaVisibilityRule = (
  connection: SavedConnection,
  fromDbName: unknown,
  toDbName: unknown,
  options: SchemaIdentifierOptions = {},
): SavedConnection => {
  const rule = getSchemaVisibilityRule(connection, fromDbName, options);
  const destination = String(toDbName || '').trim();
  if (!rule || !destination) return connection;

  return updateSchemaVisibilityRule(
    updateSchemaVisibilityRule(connection, fromDbName, undefined, options),
    destination,
    rule,
    options,
  );
};

export const moveSchemaVisibilityEntry = (
  connection: SavedConnection,
  dbName: unknown,
  fromSchemaName: unknown,
  toSchemaName: unknown,
  options: SchemaIdentifierOptions = {},
): SavedConnection => {
  const rule = getSchemaVisibilityRule(connection, dbName, options);
  const source = normalizeIdentifier(fromSchemaName, options);
  const destination = String(toSchemaName || '').trim();
  if (!rule || !source || !destination) return connection;

  const schemas = rule.schemas.map((schema) => (
    normalizeIdentifier(schema, options) === source ? destination : schema
  ));
  return updateSchemaVisibilityRule(connection, dbName, { ...rule, schemas }, options);
};

export const removeSchemaVisibilityEntry = (
  connection: SavedConnection,
  dbName: unknown,
  schemaName: unknown,
  options: SchemaIdentifierOptions = {},
  remainingSchemas: readonly unknown[] = [],
): SavedConnection => {
  const rule = getSchemaVisibilityRule(connection, dbName, options);
  const target = normalizeIdentifier(schemaName, options);
  if (!rule || !target) return connection;

  const schemas = rule.schemas.filter(
    (schema) => normalizeIdentifier(schema, options) !== target,
  );
  const remainingVisibleSchemas = Array.from(new Map(
    remainingSchemas
      .map((schema) => String(schema || '').trim())
      .filter(Boolean)
      .map((schema) => [normalizeIdentifier(schema, options), schema]),
  ).values());
  const nextRule = schemas.length > 0
    ? { ...rule, schemas }
    : rule.mode === 'include'
      ? {
        mode: 'include' as const,
        schemas: remainingVisibleSchemas.length > 0 ? remainingVisibleSchemas : [String(schemaName).trim()],
      }
      : undefined;
  return updateSchemaVisibilityRule(connection, dbName, nextRule, options);
};
