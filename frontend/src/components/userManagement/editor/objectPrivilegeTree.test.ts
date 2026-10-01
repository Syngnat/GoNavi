import { describe, expect, it } from 'vitest';
import { buildManualTarget, catalogObjectsFor, catalogObjectTarget, manualTargetNeedsObject, type CatalogObject } from './objectPrivilegeTree';

describe('buildManualTarget', () => {
  it('builds a database-level target from the container only', () => {
    expect(buildManualTarget('database', { scope: 'database', container: 'sales', object: '' })).toEqual({ privilege: '', scope: 'database', database: 'sales' });
    expect(manualTargetNeedsObject('database', 'database')).toBe(false);
  });

  it('requires an object name for table and routine scopes', () => {
    expect(buildManualTarget('database', { scope: 'table', container: 'sales', object: '' })).toBeNull();
    expect(buildManualTarget('database', { scope: 'routine', container: 'sales', object: 'calc', objectType: 'FUNCTION' })).toEqual({
      privilege: '', scope: 'routine', database: 'sales', object: 'calc', objectType: 'FUNCTION',
    });
  });

  it('splits schema.object for database-schema layouts and keeps flat names otherwise', () => {
    expect(buildManualTarget('database-schema', { scope: 'sequence', container: 'app', object: 'public.seq_id' })).toEqual({
      privilege: '', scope: 'sequence', database: 'app', schema: 'public', object: 'seq_id',
    });
    expect(buildManualTarget('database', { scope: 'table', container: 'sales', object: 'a.b' })).toEqual({
      privilege: '', scope: 'table', database: 'sales', object: 'a.b',
    });
  });

  it('uses the schema name as object for schema scope in database-schema layouts', () => {
    expect(buildManualTarget('database-schema', { scope: 'schema', container: 'app', object: 'public' })).toEqual({
      privilege: '', scope: 'schema', database: 'app', schema: 'public',
    });
  });

  it('treats the container as the owning schema for schema layouts', () => {
    expect(manualTargetNeedsObject('schema', 'schema')).toBe(false);
    expect(buildManualTarget('schema', { scope: 'schema', container: 'HR', object: '' })).toEqual({ privilege: '', scope: 'schema', schema: 'HR' });
    expect(buildManualTarget('schema', { scope: 'table', container: 'HR', object: 'EMP' })).toEqual({ privilege: '', scope: 'table', schema: 'HR', object: 'EMP' });
  });

  it('returns null without a container', () => {
    expect(buildManualTarget('database', { scope: 'table', container: ' ', object: 'orders' })).toBeNull();
  });
});

describe('catalog objects', () => {
  const objects: CatalogObject[] = [
    { kind: 'routine', schema: 'dbms_job', name: 'submit', objectType: 'PROCEDURE' },
    { kind: 'sequence', schema: 'public', name: 'seq_id' },
    { kind: 'view', schema: 'public', name: 'v_orders' },
  ];

  it('only lists objects that belong to the expanded schema in database-schema layouts', () => {
    expect(catalogObjectsFor('database-schema', objects, 'dbms_job').map((item) => item.name)).toEqual(['submit']);
    expect(catalogObjectsFor('database', objects, '')).toHaveLength(3);
  });

  it('builds routine, sequence and view targets from the container', () => {
    expect(catalogObjectTarget('database-schema', 'app', objects[0])).toEqual({
      privilege: '', scope: 'routine', database: 'app', schema: 'dbms_job', object: 'submit', objectType: 'PROCEDURE',
    });
    expect(catalogObjectTarget('database-schema', 'app', objects[1])).toEqual({
      privilege: '', scope: 'sequence', database: 'app', schema: 'public', object: 'seq_id',
    });
    expect(catalogObjectTarget('database-schema', 'app', objects[2])).toEqual({
      privilege: '', scope: 'table', database: 'app', object: 'v_orders', schema: 'public',
    });
    expect(catalogObjectTarget('schema', 'HR', { kind: 'routine', schema: 'HR', name: 'F1', objectType: 'FUNCTION' })).toEqual({
      privilege: '', scope: 'routine', schema: 'HR', object: 'F1', objectType: 'FUNCTION',
    });
  });
});
