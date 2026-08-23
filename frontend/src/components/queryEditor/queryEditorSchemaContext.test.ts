import { describe, expect, it } from 'vitest';

import {
  applyQueryEditorSchemaSearchPath,
  extractQueryEditorCurrentSchema,
  quotePostgresSearchPathIdentifier,
  resolveLoadedQueryEditorSchema,
  shouldIncludeQueryEditorSchemaObject,
  supportsQueryEditorSchemaSelection,
} from './queryEditorSchemaContext';

describe('queryEditorSchemaContext', () => {
  it.each(['postgres', 'postgresql', 'pg', 'kingbase', 'highgo', 'vastbase', 'opengauss', 'gaussdb'])('enables schema selection for %s', (dbType) => {
    expect(supportsQueryEditorSchemaSelection(dbType)).toBe(true);
  });

  it.each(['mysql', 'custom'])('does not enable query editor schema selection for %s', (dbType) => {
    expect(supportsQueryEditorSchemaSelection(dbType)).toBe(false);
  });

  it('keeps unqualified metadata but excludes objects from other selected schemas', () => {
    expect(shouldIncludeQueryEditorSchemaObject('advert_statis', 'advert_statis')).toBe(true);
    expect(shouldIncludeQueryEditorSchemaObject('advert_statis', '')).toBe(true);
    expect(shouldIncludeQueryEditorSchemaObject('', 'advert_dev')).toBe(true);
    expect(shouldIncludeQueryEditorSchemaObject('advert_statis', 'advert_dev')).toBe(false);
    expect(shouldIncludeQueryEditorSchemaObject('Foo', 'foo')).toBe(false);
  });

  it('extracts the current schema from PostgreSQL metadata rows', () => {
    expect(extractQueryEditorCurrentSchema([{ schema_name: 'tenant' }])).toBe('tenant');
    expect(extractQueryEditorCurrentSchema([{ current_schema: 'sales' }])).toBe('sales');
    expect(extractQueryEditorCurrentSchema([])).toBe('');
  });

  it('ignores stale loads and keeps a selection made while loading', () => {
    expect(resolveLoadedQueryEditorSchema({
      requestSeq: 1,
      currentRequestSeq: 2,
      latestSelectedSchema: 'sales',
      rememberedSchema: '',
      currentSchema: 'public',
      schemaNames: ['public', 'sales'],
    })).toBeNull();
    expect(resolveLoadedQueryEditorSchema({
      requestSeq: 2,
      currentRequestSeq: 2,
      latestSelectedSchema: 'sales',
      rememberedSchema: '',
      currentSchema: 'public',
      schemaNames: ['public'],
    })).toEqual({
      selectedSchema: 'sales',
      schemaNames: ['sales', 'public'],
    });
  });

  it('prefers a valid remembered schema, then current_schema, then public', () => {
    expect(resolveLoadedQueryEditorSchema({
      requestSeq: 1,
      currentRequestSeq: 1,
      latestSelectedSchema: '',
      rememberedSchema: 'sales',
      currentSchema: 'tenant',
      schemaNames: ['public', 'sales', 'tenant'],
    })?.selectedSchema).toBe('sales');
    expect(resolveLoadedQueryEditorSchema({
      requestSeq: 1,
      currentRequestSeq: 1,
      latestSelectedSchema: '',
      rememberedSchema: 'removed',
      currentSchema: 'tenant',
      schemaNames: ['public', 'tenant'],
    })?.selectedSchema).toBe('tenant');
    expect(resolveLoadedQueryEditorSchema({
      requestSeq: 1,
      currentRequestSeq: 1,
      latestSelectedSchema: '',
      rememberedSchema: '',
      currentSchema: '',
      schemaNames: ['archive', 'public'],
    })?.selectedSchema).toBe('public');
  });

  it('keeps distinct quoted-case schema names in the selector', () => {
    expect(resolveLoadedQueryEditorSchema({
      requestSeq: 1,
      currentRequestSeq: 1,
      latestSelectedSchema: '',
      rememberedSchema: '',
      currentSchema: 'foo',
      schemaNames: ['foo', 'Foo', 'foo'],
    })?.schemaNames).toEqual(['foo', 'Foo']);
  });

  it('quotes schema identifiers and appends public as a fallback search_path', () => {
    expect(quotePostgresSearchPathIdentifier('Tenant"Blue')).toBe('"Tenant""Blue"');
    const result = applyQueryEditorSchemaSearchPath({
      connectionParams: 'application_name=gonavi&search_path=public',
    }, 'Tenant"Blue');
    const params = new URLSearchParams(result.connectionParams);
    expect(params.get('application_name')).toBe('gonavi');
    expect(params.get('search_path')).toBe('"Tenant""Blue","public"');
  });

  it('does not duplicate public when public is selected', () => {
    const result = applyQueryEditorSchemaSearchPath({ connectionParams: '' }, 'public');

    const params = new URLSearchParams(result.connectionParams);
    expect(params.get('search_path')).toBe('"public"');
  });

  it('returns the original config when no schema is selected', () => {
    const config = { connectionParams: 'application_name=gonavi' };
    expect(applyQueryEditorSchemaSearchPath(config, '')).toBe(config);
  });
});
