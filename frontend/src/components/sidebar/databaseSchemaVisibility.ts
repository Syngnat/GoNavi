import type { SchemaVisibilityRule } from '../../types';
import {
  isDatabaseVisible,
  type DatabaseVisibilitySource,
} from '../../utils/databaseVisibility';

export type DatabaseRuleOwnership = 'advanced' | 'exact';
export type VisibilityTriState = 'all' | 'partial' | 'none';
export type SchemaLoadStatus = 'idle' | 'loading' | 'loaded' | 'unsupported' | 'error';

export interface DatabaseSchemaVisibilitySource extends DatabaseVisibilitySource {
  schemaVisibilityByDatabase?: Record<string, SchemaVisibilityRule> | null;
}

export interface DatabaseSchemaVisibilityDraft {
  includeDatabases: string[];
  includeDatabasePatterns: string[];
  excludeDatabasePatterns: string[];
  schemaVisibilityByDatabase: Record<string, SchemaVisibilityRule>;
}

export interface DatabaseVisibilityCandidate {
  name: string;
  discovered: boolean;
  historical: boolean;
}

export interface SchemaSelectionSnapshot {
  status: SchemaLoadStatus;
  availableSchemas: string[];
  selectedSchemas: string[];
}

export interface VisibilityValidationError {
  code: 'no-database-selected' | 'no-schema-selected' | 'exact-conversion-required';
  database?: string;
}

export interface BuildDatabaseSchemaVisibilityDraftInput {
  source: DatabaseSchemaVisibilitySource;
  databaseNames: readonly string[];
  selectedDatabases: readonly string[];
  databaseRuleOwnership: DatabaseRuleOwnership;
  advancedExactIncludes?: readonly string[];
  includeDatabasePatterns: readonly string[];
  excludeDatabasePatterns: readonly string[];
  exactSelectionChanged: boolean;
  schemaSelectionsByDatabase?: Readonly<Record<string, SchemaSelectionSnapshot>>;
  databaseCaseSensitive: boolean;
  schemaCaseSensitive: boolean;
}

export interface BuildDatabaseSchemaVisibilityDraftResult {
  draft?: DatabaseSchemaVisibilityDraft;
  errors: VisibilityValidationError[];
  requiresExactConversion: boolean;
}

const trimName = (value: unknown): string => String(value ?? '').trim();
const databaseIdentity = (value: string): string => value;
const schemaIdentity = (value: string, caseSensitive: boolean): string =>
  caseSensitive ? value : value.toLocaleLowerCase();
const schemaRuleDatabaseIdentity = (value: string, caseSensitive: boolean): string =>
  caseSensitive ? value : value.toLocaleLowerCase();

const uniqueNames = (
  values: readonly unknown[] | null | undefined,
  identity: (value: string) => string,
): string[] => {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const name = trimName(value);
    if (!name) return;
    const key = identity(name);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(name);
  });
  return result;
};

export const normalizeDatabaseNames = (
  values: readonly unknown[] | null | undefined,
): string[] => uniqueNames(values, databaseIdentity);

export const normalizeSchemaNames = (
  values: readonly unknown[] | null | undefined,
  caseSensitive: boolean,
): string[] => uniqueNames(values, (value) => schemaIdentity(value, caseSensitive));

export const normalizeDatabasePatterns = (
  values: readonly unknown[] | null | undefined,
): string[] => uniqueNames(values, databaseIdentity);

export const parseDatabasePatternText = (value: unknown): string[] =>
  normalizeDatabasePatterns(String(value ?? '').split(/[\r\n,;]+/u));

export const formatDatabasePatternText = (
  values: readonly unknown[] | null | undefined,
): string => normalizeDatabasePatterns(values).join('\n');

const sourceRuleEntries = (
  source: DatabaseSchemaVisibilitySource,
): Array<[string, SchemaVisibilityRule]> => Object.entries(
  source.schemaVisibilityByDatabase || {},
).filter((entry): entry is [string, SchemaVisibilityRule] => Boolean(entry[1]));

export const findSchemaVisibilityRuleEntry = (
  rules: Record<string, SchemaVisibilityRule> | null | undefined,
  database: string,
  databaseCaseSensitive = false,
): [string, SchemaVisibilityRule] | undefined => {
  const name = trimName(database);
  if (!name || !rules) return undefined;
  if (rules[name]) return [name, rules[name]];
  const identity = schemaRuleDatabaseIdentity(name, databaseCaseSensitive);
  const matchedKey = Object.keys(rules).find(
    (key) => schemaRuleDatabaseIdentity(trimName(key), databaseCaseSensitive) === identity,
  );
  return matchedKey ? [matchedKey, rules[matchedKey]] : undefined;
};

export const mergeDatabaseVisibilityCandidates = (
  discoveredDatabases: readonly unknown[] | null | undefined,
  source: DatabaseSchemaVisibilitySource,
  initialDatabase?: unknown,
): DatabaseVisibilityCandidate[] => {
  const discovered = normalizeDatabaseNames(discoveredDatabases);
  const historical = normalizeDatabaseNames([
    ...(source.includeDatabases || []),
    ...sourceRuleEntries(source).map(([database]) => database),
    initialDatabase,
  ]);
  const discoveredSet = new Set(discovered.map(databaseIdentity));
  const candidates = normalizeDatabaseNames([...discovered, ...historical]);

  return candidates
    .map((name) => ({
      name,
      discovered: discoveredSet.has(databaseIdentity(name)),
      historical: !discoveredSet.has(databaseIdentity(name)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};

export const resolveSelectedDatabaseNames = (
  source: DatabaseVisibilitySource | null | undefined,
  databaseNames: readonly unknown[] | null | undefined,
): string[] => normalizeDatabaseNames(databaseNames).filter(
  (database) => isDatabaseVisible(source, database),
);

export const mergeSelectionAfterDatabaseRefresh = (
  previousCandidates: readonly DatabaseVisibilityCandidate[],
  nextCandidates: readonly DatabaseVisibilityCandidate[],
  previousSelection: readonly string[],
  source: DatabaseVisibilitySource | null | undefined,
  exactSelectionChanged: boolean,
): string[] => {
  if (!exactSelectionChanged) {
    return resolveSelectedDatabaseNames(source, nextCandidates.map((candidate) => candidate.name));
  }

  const previousNames = new Set(previousCandidates.map((candidate) => candidate.name));
  const selected = new Set(normalizeDatabaseNames(previousSelection));
  return nextCandidates
    .map((candidate) => candidate.name)
    .filter((database) => previousNames.has(database)
      ? selected.has(database)
      : isDatabaseVisible(source, database));
};

export const resolveSchemaSelection = (
  rule: SchemaVisibilityRule | null | undefined,
  loadedSchemas: readonly unknown[] | null | undefined,
  caseSensitive: boolean,
): SchemaSelectionSnapshot => {
  const availableSchemas = normalizeSchemaNames([
    ...(loadedSchemas || []),
    ...(rule?.schemas || []),
  ], caseSensitive);
  if (!rule) {
    return {
      status: 'loaded',
      availableSchemas,
      selectedSchemas: [...availableSchemas],
    };
  }

  const configured = new Set(
    normalizeSchemaNames(rule.schemas, caseSensitive)
      .map((schema) => schemaIdentity(schema, caseSensitive)),
  );
  const selectedSchemas = availableSchemas.filter((schema) => {
    const configuredSchema = configured.has(schemaIdentity(schema, caseSensitive));
    return rule.mode === 'include' ? configuredSchema : !configuredSchema;
  });

  return { status: 'loaded', availableSchemas, selectedSchemas };
};

export const mergeSchemaSelectionAfterRefresh = (
  previous: SchemaSelectionSnapshot | undefined,
  rule: SchemaVisibilityRule | null | undefined,
  loadedSchemas: readonly unknown[] | null | undefined,
  caseSensitive: boolean,
): SchemaSelectionSnapshot => {
  const next = resolveSchemaSelection(rule, loadedSchemas, caseSensitive);
  if (!previous || previous.status !== 'loaded') return next;

  const previousState = previous.availableSchemas.length === 0
    ? 'all'
    : getVisibilityTriState(
      previous.availableSchemas,
      previous.selectedSchemas,
      caseSensitive,
    );
  if (previousState === 'all') {
    return {
      ...next,
      selectedSchemas: [...next.availableSchemas],
    };
  }

  const previouslySelected = new Set(
    normalizeSchemaNames(previous.selectedSchemas, caseSensitive)
      .map((schema) => schemaIdentity(schema, caseSensitive)),
  );
  return {
    ...next,
    selectedSchemas: next.availableSchemas.filter(
      (schema) => previouslySelected.has(schemaIdentity(schema, caseSensitive)),
    ),
  };
};

export const getVisibilityTriState = (
  available: readonly unknown[],
  selected: readonly unknown[],
  caseSensitive: boolean,
): VisibilityTriState => {
  const availableNames = normalizeSchemaNames(available, caseSensitive);
  const availableIdentities = new Set(
    availableNames.map((name) => schemaIdentity(name, caseSensitive)),
  );
  const selectedCount = normalizeSchemaNames(selected, caseSensitive)
    .filter((name) => availableIdentities.has(schemaIdentity(name, caseSensitive)))
    .length;
  if (selectedCount === 0) return 'none';
  if (selectedCount === availableNames.length) return 'all';
  return 'partial';
};

export const getDatabaseTreeTriState = (input: {
  databaseSelected: boolean;
  supportsSchemas: boolean;
  schemaSnapshot?: SchemaSelectionSnapshot;
  hasExistingSchemaRule: boolean;
  schemaCaseSensitive: boolean;
}): VisibilityTriState => {
  if (!input.databaseSelected) return 'none';
  if (!input.supportsSchemas) return 'all';
  if (!input.schemaSnapshot || input.schemaSnapshot.status !== 'loaded') {
    return input.hasExistingSchemaRule ? 'partial' : 'all';
  }
  if (input.schemaSnapshot.availableSchemas.length === 0) return 'all';
  const schemaState = getVisibilityTriState(
    input.schemaSnapshot.availableSchemas,
    input.schemaSnapshot.selectedSchemas,
    input.schemaCaseSensitive,
  );
  return schemaState === 'all' ? 'all' : 'partial';
};

const normalizeRule = (
  rule: SchemaVisibilityRule,
  caseSensitive: boolean,
): SchemaVisibilityRule | undefined => {
  const schemas = normalizeSchemaNames(rule.schemas, caseSensitive);
  if ((rule.mode !== 'include' && rule.mode !== 'exclude') || schemas.length === 0) {
    return undefined;
  }
  return { mode: rule.mode, schemas };
};

const findSchemaSnapshotEntry = (
  snapshots: Readonly<Record<string, SchemaSelectionSnapshot>>,
  database: string,
  databaseCaseSensitive: boolean,
): [string, SchemaSelectionSnapshot] | undefined => {
  if (snapshots[database]) return [database, snapshots[database]];
  const identity = schemaRuleDatabaseIdentity(database, databaseCaseSensitive);
  const matchedKey = Object.keys(snapshots).find(
    (key) => schemaRuleDatabaseIdentity(key, databaseCaseSensitive) === identity,
  );
  return matchedKey ? [matchedKey, snapshots[matchedKey]] : undefined;
};

const buildSchemaRules = (
  source: DatabaseSchemaVisibilitySource,
  selectedDatabases: readonly string[],
  snapshots: Readonly<Record<string, SchemaSelectionSnapshot>>,
  databaseCaseSensitive: boolean,
  schemaCaseSensitive: boolean,
): {
  rules: Record<string, SchemaVisibilityRule>;
  errors: VisibilityValidationError[];
} => {
  const rules: Record<string, SchemaVisibilityRule> = {};
  const errors: VisibilityValidationError[] = [];
  const selected = new Set(normalizeDatabaseNames(selectedDatabases));
  const processedDatabases = new Set<string>();

  const processDatabase = (database: string, existingRule?: SchemaVisibilityRule) => {
    const databaseName = trimName(database);
    if (!databaseName) return;
    const databaseKey = schemaRuleDatabaseIdentity(databaseName, databaseCaseSensitive);
    if (processedDatabases.has(databaseKey)) return;
    processedDatabases.add(databaseKey);

    const selectedDatabase = Array.from(selected).find(
      (candidate) => schemaRuleDatabaseIdentity(candidate, databaseCaseSensitive) === databaseKey,
    );
    const normalizedExistingRule = existingRule
      ? normalizeRule(existingRule, schemaCaseSensitive)
      : undefined;

    // Hidden databases retain their historical rule exactly; the tree may not have
    // loaded enough metadata to safely reinterpret it.
    if (!selectedDatabase) {
      if (normalizedExistingRule) rules[databaseName] = normalizedExistingRule;
      return;
    }

    const snapshotEntry = findSchemaSnapshotEntry(
      snapshots,
      selectedDatabase,
      databaseCaseSensitive,
    );
    const snapshot = snapshotEntry?.[1];
    if (!snapshot || snapshot.status !== 'loaded') {
      if (normalizedExistingRule) rules[databaseName] = normalizedExistingRule;
      return;
    }

    const availableSchemas = normalizeSchemaNames(
      snapshot.availableSchemas,
      schemaCaseSensitive,
    );
    const selectedSchemas = normalizeSchemaNames(snapshot.selectedSchemas, schemaCaseSensitive)
      .filter((schema) => {
        const identity = schemaIdentity(schema, schemaCaseSensitive);
        return availableSchemas.some(
          (available) => schemaIdentity(available, schemaCaseSensitive) === identity,
        );
      });
    if (availableSchemas.length === 0) {
      if (normalizedExistingRule) rules[databaseName] = normalizedExistingRule;
      return;
    }

    const state = getVisibilityTriState(
      availableSchemas,
      selectedSchemas,
      schemaCaseSensitive,
    );
    if (state === 'none') {
      errors.push({ code: 'no-schema-selected', database: selectedDatabase });
      return;
    }
    if (state === 'partial') {
      rules[selectedDatabase] = { mode: 'include', schemas: selectedSchemas };
    }
    // All loaded schemas selected intentionally removes any existing rule.
  };

  sourceRuleEntries(source).forEach(([database, rule]) => processDatabase(database, rule));
  normalizeDatabaseNames(selectedDatabases).forEach((database) => {
    const existing = findSchemaVisibilityRuleEntry(
      source.schemaVisibilityByDatabase || undefined,
      database,
      databaseCaseSensitive,
    )?.[1];
    processDatabase(database, existing);
  });

  return { rules, errors };
};

export const buildDatabaseSchemaVisibilityDraft = (
  input: BuildDatabaseSchemaVisibilityDraftInput,
): BuildDatabaseSchemaVisibilityDraftResult => {
  const databaseNames = normalizeDatabaseNames(input.databaseNames);
  const selectedDatabases = normalizeDatabaseNames(input.selectedDatabases)
    .filter((database) => databaseNames.includes(database));
  const includeDatabasePatterns = normalizeDatabasePatterns(input.includeDatabasePatterns);
  const excludeDatabasePatterns = normalizeDatabasePatterns(input.excludeDatabasePatterns);
  const hasPatterns = includeDatabasePatterns.length > 0 || excludeDatabasePatterns.length > 0;
  const requiresExactConversion = input.databaseRuleOwnership === 'advanced'
    && input.exactSelectionChanged
    && hasPatterns;
  const errors: VisibilityValidationError[] = [];

  if (selectedDatabases.length === 0) {
    errors.push({ code: 'no-database-selected' });
  }
  if (requiresExactConversion) {
    errors.push({ code: 'exact-conversion-required' });
  }

  const schemaResult = buildSchemaRules(
    input.source,
    selectedDatabases,
    input.schemaSelectionsByDatabase || {},
    input.databaseCaseSensitive,
    input.schemaCaseSensitive,
  );
  errors.push(...schemaResult.errors);
  if (errors.length > 0) {
    return { errors, requiresExactConversion };
  }

  const exactRulesOwnSelection = input.databaseRuleOwnership === 'exact'
    || input.exactSelectionChanged;
  const everyKnownDatabaseSelected = databaseNames.length > 0
    && databaseNames.every((database) => selectedDatabases.includes(database));
  const includeDatabases = exactRulesOwnSelection
    ? (everyKnownDatabaseSelected ? [] : selectedDatabases)
    : normalizeDatabaseNames(input.advancedExactIncludes || input.source.includeDatabases || []);

  return {
    errors: [],
    requiresExactConversion: false,
    draft: {
      includeDatabases,
      includeDatabasePatterns: exactRulesOwnSelection ? [] : includeDatabasePatterns,
      excludeDatabasePatterns: exactRulesOwnSelection ? [] : excludeDatabasePatterns,
      schemaVisibilityByDatabase: schemaResult.rules,
    },
  };
};
