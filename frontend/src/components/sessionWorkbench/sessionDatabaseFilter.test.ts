import { describe, expect, it } from 'vitest';
import { filterSessionsByDatabase, sessionDatabaseOptions } from './sessionDatabaseFilter';

const sessions = [
  { key: 'a', databaseOrTenant: 'shop' },
  { key: 'b', databaseOrTenant: 'Analytics' },
  { key: 'c', databaseOrTenant: 'shop' },
  { key: 'd' },
];

describe('sessionDatabaseFilter', () => {
  it('lists the distinct databases that own sessions, ignoring rows without one', () => {
    expect(sessionDatabaseOptions(sessions)).toEqual(['Analytics', 'shop']);
  });

  it('prefers the server catalog so a quiet database stays selectable', () => {
    // "archive" owns no session right now; without the catalog it would be
    // impossible to pick, which is the bug the picker is meant to avoid.
    expect(sessionDatabaseOptions(sessions, ['shop', 'archive']))
      .toEqual(['Analytics', 'archive', 'shop']);
  });

  it('drops blank entries from the catalog', () => {
    expect(sessionDatabaseOptions([], ['shop', '', '   '])).toEqual(['shop']);
  });

  it('still offers a database that owns sessions but is missing from the catalog', () => {
    expect(sessionDatabaseOptions([{ key: 'e', databaseOrTenant: 'private_db' }], ['shop']))
      .toEqual(['private_db', 'shop']);
  });

  it('narrows to one database and leaves the list untouched when none is picked', () => {
    expect(filterSessionsByDatabase(sessions, 'shop').map((row) => row.key)).toEqual(['a', 'c']);
    expect(filterSessionsByDatabase(sessions, '')).toBe(sessions);
    expect(filterSessionsByDatabase(sessions, 'missing')).toEqual([]);
  });
});
