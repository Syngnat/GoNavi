import { describe, expect, it } from 'vitest';

import { resolveDefinitionViewerDialect, usesBackendViewDefinition } from './definitionViewerDialect';

const conn = (config: Record<string, unknown>) => ({ config });

describe('definition viewer dialect', () => {
  it('maps registry data sources to their borrowed dialect', () => {
    expect(resolveDefinitionViewerDialect(conn({ type: 'tidb' }))).toBe('mysql');
    expect(resolveDefinitionViewerDialect(conn({ type: 'cockroachdb' }))).toBe('postgres');
    expect(resolveDefinitionViewerDialect(conn({ type: 'timescaledb' }))).toBe('postgres');
    expect(resolveDefinitionViewerDialect(conn({ type: 'questdb' }))).toBe('questdb');
  });

  it('keeps the existing mapping for built-in and custom connections', () => {
    expect(resolveDefinitionViewerDialect(conn({ type: 'mariadb' }))).toBe('mysql');
    expect(resolveDefinitionViewerDialect(conn({ type: 'dameng' }))).toBe('dm');
    expect(resolveDefinitionViewerDialect(conn({ type: 'postgres' }))).toBe('postgres');
    expect(resolveDefinitionViewerDialect(conn({ type: 'oceanbase', oceanBaseProtocol: 'oracle' }))).toBe('oracle');
    expect(resolveDefinitionViewerDialect(conn({ type: 'custom', driver: 'doris' }))).toBe('mysql');
  });

  it('loads registry view definitions through the backend driver', () => {
    expect(usesBackendViewDefinition(conn({ type: 'timescaledb' }), 'postgres')).toBe(true);
    expect(usesBackendViewDefinition(conn({ type: 'greptimedb' }), 'greptimedb')).toBe(true);
    expect(usesBackendViewDefinition(conn({ type: 'oracle' }), 'oracle')).toBe(true);
    expect(usesBackendViewDefinition(conn({ type: 'postgres' }), 'postgres')).toBe(false);
  });
});
