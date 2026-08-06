export interface DatabaseVisibilitySource {
  includeDatabases?: readonly string[] | null;
  includeDatabasePatterns?: readonly string[] | null;
  excludeDatabasePatterns?: readonly string[] | null;
}

const REGEXP_SPECIAL_CHARACTERS = new Set([
  '\\',
  '^',
  '$',
  '.',
  '*',
  '+',
  '?',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
]);

const ESCAPABLE_PATTERN_CHARACTERS = new Set(['*', '%', '_', '\\']);
const ZERO_OR_MORE_CODE_POINTS = '[\\s\\S]*';
const EXACTLY_ONE_CODE_POINT = '[\\s\\S]';

interface PreparedDatabaseVisibility {
  exactIncludes: Set<string>;
  includePatterns: RegExp[];
  excludePatterns: RegExp[];
}

const escapeRegExpCharacter = (character: string): string =>
  REGEXP_SPECIAL_CHARACTERS.has(character) ? `\\${character}` : character;

const compileDatabasePattern = (pattern: string): RegExp => {
  const characters = Array.from(pattern);
  const source: string[] = ['^'];

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];

    if (character === '\\') {
      const nextCharacter = characters[index + 1];
      if (nextCharacter && ESCAPABLE_PATTERN_CHARACTERS.has(nextCharacter)) {
        source.push(escapeRegExpCharacter(nextCharacter));
        index += 1;
      } else {
        source.push(escapeRegExpCharacter(character));
      }
      continue;
    }

    if (character === '*' || character === '%') {
      source.push(ZERO_OR_MORE_CODE_POINTS);
      continue;
    }

    if (character === '_') {
      source.push(EXACTLY_ONE_CODE_POINT);
      continue;
    }

    source.push(escapeRegExpCharacter(character));
  }

  source.push('$');
  return new RegExp(source.join(''), 'u');
};

const nonEmptyStrings = (values: readonly string[] | null | undefined): string[] => {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
};

const nonEmptyPatterns = (values: readonly string[] | null | undefined): string[] => {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
};

const prepareDatabaseVisibility = (
  connection: DatabaseVisibilitySource | null | undefined,
): PreparedDatabaseVisibility => ({
  // includeDatabases predates wildcard filters and must remain exact. In particular,
  // underscores in existing database names must never acquire wildcard semantics.
  exactIncludes: new Set(nonEmptyStrings(connection?.includeDatabases)),
  includePatterns: nonEmptyPatterns(connection?.includeDatabasePatterns).map(compileDatabasePattern),
  excludePatterns: nonEmptyPatterns(connection?.excludeDatabasePatterns).map(compileDatabasePattern),
});

const matchesAnyPattern = (databaseName: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(databaseName));

const isDatabaseVisibleWithPreparedRules = (
  rules: PreparedDatabaseVisibility,
  databaseName: string,
): boolean => {
  if (matchesAnyPattern(databaseName, rules.excludePatterns)) return false;

  const hasIncludes = rules.exactIncludes.size > 0 || rules.includePatterns.length > 0;
  if (!hasIncludes) return true;

  return rules.exactIncludes.has(databaseName)
    || matchesAnyPattern(databaseName, rules.includePatterns);
};

export const matchesDatabasePattern = (databaseName: string, pattern: string): boolean =>
  compileDatabasePattern(pattern).test(databaseName);

export const hasDatabaseVisibilityRules = (
  connection: DatabaseVisibilitySource | null | undefined,
): boolean => nonEmptyStrings(connection?.includeDatabases).length > 0
  || nonEmptyPatterns(connection?.includeDatabasePatterns).length > 0
  || nonEmptyPatterns(connection?.excludeDatabasePatterns).length > 0;

export const isDatabaseVisible = (
  connection: DatabaseVisibilitySource | null | undefined,
  databaseName: string,
): boolean => isDatabaseVisibleWithPreparedRules(
  prepareDatabaseVisibility(connection),
  databaseName,
);

export const filterVisibleDatabaseNames = (
  connection: DatabaseVisibilitySource | null | undefined,
  databaseNames: readonly string[],
): string[] => {
  const rules = prepareDatabaseVisibility(connection);
  return databaseNames.filter((databaseName) =>
    isDatabaseVisibleWithPreparedRules(rules, databaseName));
};
