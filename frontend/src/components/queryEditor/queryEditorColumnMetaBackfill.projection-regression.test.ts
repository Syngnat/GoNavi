import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLocatorMetaCache } from '../../utils/queryLocatorMetaCache';
import { clearQueryResultColumnMetaBackfillCache, resolveQueryResultColumnMetaByCandidateTables, resolveQueryResultColumnMetaForStatements } from './queryEditorColumnMetaBackfill';

const backend = vi.hoisted(() => ({ DBGetColumns: vi.fn() }));
vi.mock('../../../wailsjs/go/app/App', () => backend);

const customerColumns = [
  { name: 'id', type: 'bigint', comment: 'customer id' },
  { name: 'name', type: 'varchar', comment: 'customer name' },
  { name: 'status', type: 'integer', comment: 'customer status' },
];
const params = (statement: string, dbType = 'kingbase') => ({
  statement, dbType, currentDb: 'lab', defaultSchema: '',
  config: { id: 'test-meta', dbType, host: 'mock.invalid', user: 'test', database: 'lab' },
});

beforeEach(() => {
  clearLocatorMetaCache();
  clearQueryResultColumnMetaBackfillCache();
  backend.DBGetColumns.mockReset().mockImplementation((_config: unknown, _db: string, table: string) => Promise.resolve({
    success: table === 'customers', data: table === 'customers' ? customerColumns : [],
  }));
});

describe('CTE keyword boundaries', () => {
  it.each(['/* optimizer hint */', '-- leading comment\n'])('skips SELECT trivia without erasing quoted identifiers: %s', async comment => {
    const meta = await resolveQueryResultColumnMetaByCandidateTables(params(`SELECT ${comment} "name" FROM customers`));
    expect(meta?.name?.comment).toBe('customer name');
  });

  it.each(['preselected', 'selected_rows', 'select$rows'])('does not treat CTE name %s as SELECT', async name => {
    const meta = await resolveQueryResultColumnMetaByCandidateTables(params(
      `WITH ${name} AS (SELECT name FROM customers) SELECT name FROM ${name}`,
    ));
    expect(meta?.name?.comment).toBe('customer name');
  });
});

describe('wildcard projection order', () => {
  it('shares a failed table request within a batch and permits retry in the next batch', async () => {
    const requests = [params('SELECT COUNT(*) AS total FROM orders'), params('SELECT COUNT(*) AS count FROM orders')];
    await resolveQueryResultColumnMetaForStatements(requests);
    expect(backend.DBGetColumns).toHaveBeenCalledTimes(1);
    await resolveQueryResultColumnMetaForStatements(requests);
    expect(backend.DBGetColumns).toHaveBeenCalledTimes(2);
  });

  it.each(['kingbase', 'mysql', 'postgres'])('does not lend later metadata to an earlier unavailable wildcard in %s', async dbType => {
    const meta = await resolveQueryResultColumnMetaByCandidateTables(params(
      'SELECT o.*, c.* FROM customers c JOIN orders o ON c.id=o.id', dbType,
    ));
    expect(meta?.id).toBeUndefined();
    expect(meta?.name).toBeUndefined();
    expect(meta?.['c.id']?.comment).toBe('customer id');
  });

  it.each(['kingbase', 'mysql', 'postgres'])('keeps known columns projected before an unavailable wildcard in %s', async dbType => {
    const meta = await resolveQueryResultColumnMetaByCandidateTables(params(
      'SELECT c.*, o.* FROM orders o JOIN customers c ON c.id=o.id', dbType,
    ));
    expect(meta?.id?.comment).toBe('customer id');
    expect(meta?.name?.comment).toBe('customer name');
  });

  it.each(['kingbase', 'mysql', 'postgres'])('uses projection order for available wildcards in %s', async dbType => {
    backend.DBGetColumns.mockImplementation((_config: unknown, _db: string, table: string) => Promise.resolve({
      success: true, data: table === 'customers' ? customerColumns : [{ name: 'id', type: 'bigint', comment: 'order id' }],
    }));
    const meta = await resolveQueryResultColumnMetaByCandidateTables(params('SELECT o.*, c.* FROM customers c JOIN orders o ON c.id=o.id', dbType));
    expect(meta?.id?.comment).toBe('order id');
  });
});

describe('expression label casing', () => {
  it.each(['STATUS', 'Status', 'status'])('does not lend entity metadata to COUNT AS %s', async alias => {
    const meta = await resolveQueryResultColumnMetaByCandidateTables(params(`SELECT COUNT(*) AS ${alias} FROM customers`, 'mysql'));
    expect(meta?.status).toBeUndefined();
    expect(meta?.name?.comment).toBe('customer name');
  });

  it('folds unquoted Kingbase labels before resolving the first occurrence', async () => {
    const meta = await resolveQueryResultColumnMetaByCandidateTables(params('SELECT upper(name) AS NAME, name FROM customers'));
    expect(meta?.name).toBeUndefined();
  });

  it('preserves distinct quoted labels', async () => {
    const meta = await resolveQueryResultColumnMetaByCandidateTables(params('SELECT name AS "Name", upper(name) AS "name" FROM customers'));
    expect(meta?.Name?.comment).toBe('customer name');
    expect(meta?.name).toBeUndefined();
  });
});
