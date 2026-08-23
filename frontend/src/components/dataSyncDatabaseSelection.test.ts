import { describe, expect, it } from 'vitest';

import { resolveDataSyncDatabaseSelection } from './dataSyncDatabaseSelection';

describe('resolveDataSyncDatabaseSelection', () => {
  it('deduplicates metadata rows and prefers the configured database', () => {
    expect(resolveDataSyncDatabaseSelection(
      { type: 'mysql', database: 'app' },
      [{ Database: 'mysql' }, { database: 'APP' }, 'app'],
    )).toEqual({
      options: ['mysql', 'APP'],
      preferred: 'APP',
    });
  });

  it('auto-selects the only database returned by the driver', () => {
    expect(resolveDataSyncDatabaseSelection(
      { type: 'trino' },
      [{ catalog: 'hive' }],
    )).toEqual({ options: ['hive'], preferred: 'hive' });
  });

  it('falls back to the configured database when enumeration is empty', () => {
    expect(resolveDataSyncDatabaseSelection(
      { type: 'sqlite', database: 'D:/data/app.db' },
      [],
    )).toEqual({
      options: ['D:/data/app.db'],
      preferred: 'D:/data/app.db',
    });
  });

  it('uses the owner for Oracle service-name connections', () => {
    expect(resolveDataSyncDatabaseSelection(
      { type: 'oracle', database: 'ORCL', user: 'APP_OWNER' },
      [],
    )).toEqual({ options: ['APP_OWNER'], preferred: 'APP_OWNER' });
  });

  it('uses the owner for OceanBase Oracle tenants', () => {
    expect(resolveDataSyncDatabaseSelection(
      {
        type: 'oceanbase',
        database: 'service',
        user: 'tenant_owner',
        oceanBaseProtocol: 'oracle',
      },
      [],
    )).toEqual({ options: ['tenant_owner'], preferred: 'tenant_owner' });
  });

  it('leaves a manual-entry fallback when no database can be inferred', () => {
    expect(resolveDataSyncDatabaseSelection(
      { type: 'custom', driver: 'acme-sql' },
      [],
    )).toEqual({ options: [], preferred: '' });
  });
});
