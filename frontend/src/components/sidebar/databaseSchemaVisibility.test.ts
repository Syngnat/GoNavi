import { describe, expect, it } from 'vitest';

import {
  buildDatabaseSchemaVisibilityDraft,
  getDatabaseTreeTriState,
  mergeDatabaseVisibilityCandidates,
  mergeSchemaSelectionAfterRefresh,
  resolveSchemaSelection,
} from './databaseSchemaVisibility';

describe('database and schema visibility selection', () => {
  it('merges discovered and historical databases without losing hidden rules', () => {
    expect(mergeDatabaseVisibilityCandidates(['app', 'audit'], {
      includeDatabases: ['legacy'],
      schemaVisibilityByDatabase: {
        archive: { mode: 'include', schemas: ['public'] },
      },
    })).toEqual([
      { name: 'app', discovered: true, historical: false },
      { name: 'archive', discovered: false, historical: true },
      { name: 'audit', discovered: true, historical: false },
      { name: 'legacy', discovered: false, historical: true },
    ]);
  });

  it('builds an exact database selection and a dbo-only SQL Server rule', () => {
    const result = buildDatabaseSchemaVisibilityDraft({
      source: {},
      databaseNames: ['app', 'audit'],
      selectedDatabases: ['app'],
      databaseRuleOwnership: 'exact',
      includeDatabasePatterns: [],
      excludeDatabasePatterns: [],
      exactSelectionChanged: true,
      databaseCaseSensitive: false,
      schemaCaseSensitive: false,
      schemaSelectionsByDatabase: {
        app: {
          status: 'loaded',
          availableSchemas: ['dbo', 'guest'],
          selectedSchemas: ['dbo'],
        },
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.draft).toEqual({
      includeDatabases: ['app'],
      includeDatabasePatterns: [],
      excludeDatabasePatterns: [],
      schemaVisibilityByDatabase: {
        app: { mode: 'include', schemas: ['dbo'] },
      },
    });
  });

  it('requires explicit conversion before checkbox changes replace patterns', () => {
    const result = buildDatabaseSchemaVisibilityDraft({
      source: { includeDatabasePatterns: ['team%'] },
      databaseNames: ['team_a', 'team_b'],
      selectedDatabases: ['team_a'],
      databaseRuleOwnership: 'advanced',
      includeDatabasePatterns: ['team%'],
      excludeDatabasePatterns: [],
      exactSelectionChanged: true,
      databaseCaseSensitive: false,
      schemaCaseSensitive: false,
    });

    expect(result.errors).toContainEqual({ code: 'exact-conversion-required' });
    expect(result.draft).toBeUndefined();
  });

  it('rejects zero databases and zero schemas for an enabled database', () => {
    expect(buildDatabaseSchemaVisibilityDraft({
      source: {},
      databaseNames: ['app'],
      selectedDatabases: [],
      databaseRuleOwnership: 'exact',
      includeDatabasePatterns: [],
      excludeDatabasePatterns: [],
      exactSelectionChanged: true,
      databaseCaseSensitive: false,
      schemaCaseSensitive: false,
    }).errors).toContainEqual({ code: 'no-database-selected' });

    expect(buildDatabaseSchemaVisibilityDraft({
      source: {},
      databaseNames: ['app'],
      selectedDatabases: ['app'],
      databaseRuleOwnership: 'exact',
      includeDatabasePatterns: [],
      excludeDatabasePatterns: [],
      exactSelectionChanged: true,
      databaseCaseSensitive: false,
      schemaCaseSensitive: false,
      schemaSelectionsByDatabase: {
        app: {
          status: 'loaded',
          availableSchemas: ['dbo'],
          selectedSchemas: [],
        },
      },
    }).errors).toContainEqual({ code: 'no-schema-selected', database: 'app' });
  });

  it('keeps PostgreSQL case-distinct schemas selectable', () => {
    const snapshot = resolveSchemaSelection(
      { mode: 'include', schemas: ['foo'] },
      ['foo', 'Foo'],
      true,
    );

    expect(snapshot.selectedSchemas).toEqual(['foo']);
    expect(getDatabaseTreeTriState({
      databaseSelected: true,
      supportsSchemas: true,
      schemaSnapshot: snapshot,
      hasExistingSchemaRule: true,
      schemaCaseSensitive: true,
    })).toBe('partial');
  });

  it('preserves an unsaved select-all schema draft after refresh', () => {
    expect(mergeSchemaSelectionAfterRefresh({
      status: 'loaded',
      availableSchemas: ['dbo', 'guest'],
      selectedSchemas: ['dbo', 'guest'],
    }, { mode: 'include', schemas: ['dbo'] }, ['dbo', 'guest', 'reporting'], false))
      .toEqual({
        status: 'loaded',
        availableSchemas: ['dbo', 'guest', 'reporting'],
        selectedSchemas: ['dbo', 'guest', 'reporting'],
      });
  });

  it('keeps case-distinct database rules separate for PostgreSQL', () => {
    const result = buildDatabaseSchemaVisibilityDraft({
      source: {
        schemaVisibilityByDatabase: {
          app: { mode: 'include', schemas: ['public'] },
          App: { mode: 'include', schemas: ['audit'] },
        },
      },
      databaseNames: ['app', 'App'],
      selectedDatabases: ['app', 'App'],
      databaseRuleOwnership: 'exact',
      includeDatabasePatterns: [],
      excludeDatabasePatterns: [],
      exactSelectionChanged: false,
      databaseCaseSensitive: true,
      schemaCaseSensitive: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.draft?.schemaVisibilityByDatabase).toEqual({
      app: { mode: 'include', schemas: ['public'] },
      App: { mode: 'include', schemas: ['audit'] },
    });
  });

  it('deduplicates DuckDB schemas case-insensitively', () => {
    expect(resolveSchemaSelection(
      { mode: 'include', schemas: ['main'] },
      ['main', 'MAIN'],
      false,
    )).toEqual({
      status: 'loaded',
      availableSchemas: ['main'],
      selectedSchemas: ['main'],
    });
  });
});
