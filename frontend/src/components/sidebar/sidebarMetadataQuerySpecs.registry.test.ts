import { describe, expect, it } from 'vitest';

import type { SavedConnection } from '../../types';
import { resolveSidebarMetadataDialect } from '../../utils/sidebarMetadata';
import { getSidebarTableDisplayName } from './sidebarMetadataBasics';
import { filterRegistryObjectGroups, isRegistryHiddenSchema } from './sidebarRegistryObjectGroups';
import {
  buildFunctionsMetadataQuerySpecs,
  buildSchemasMetadataQuerySpecs,
  buildViewsMetadataQuerySpecs,
} from './sidebarMetadataQuerySpecs';

const connectionOf = (type: string) => ({ config: { type } }) as unknown as SavedConnection;

describe('sidebar metadata queries for registry data sources', () => {
  it('hides object groups a registry data source does not support', () => {
    const groups = ['tables', 'views', 'routines', 'triggers', 'events'].map((groupKey) => ({
      key: groupKey,
      title: groupKey,
      dataRef: { groupKey },
    }));
    expect(filterRegistryObjectGroups(connectionOf('tidb'), groups).map((group) => group.key)).toEqual(['tables', 'views']);
    expect(filterRegistryObjectGroups(connectionOf('cockroachdb'), groups)).toHaveLength(5);
    expect(filterRegistryObjectGroups(connectionOf('mysql'), groups)).toHaveLength(5);
  });

  it('hides extension-internal schemas declared by the registry', () => {
    const timescale = connectionOf('timescaledb');
    expect(isRegistryHiddenSchema(timescale, '_timescaledb_catalog')).toBe(true);
    expect(isRegistryHiddenSchema(timescale, 'timescaledb_information')).toBe(true);
    expect(isRegistryHiddenSchema(timescale, 'public')).toBe(false);
    expect(isRegistryHiddenSchema(connectionOf('postgres'), '_timescaledb_catalog')).toBe(false);
  });

  it('groups PostgreSQL-family registry tables by schema like PostgreSQL', () => {
    expect(getSidebarTableDisplayName(connectionOf('cockroachdb'), 'public.customers')).toBe('customers');
    expect(getSidebarTableDisplayName(connectionOf('kwdb'), 'public.sensors')).toBe('sensors');
    expect(getSidebarTableDisplayName(connectionOf('tidb'), 'customers')).toBe('customers');
  });

  it('loads TiDB views through the MySQL metadata queries', () => {
    const dialect = resolveSidebarMetadataDialect('tidb');
    expect(dialect).toBe('mysql');
    expect(buildViewsMetadataQuerySpecs(dialect, 'shop')[0]?.sql).toContain("information_schema.views WHERE table_schema = 'shop'");
  });

  it('hides CockroachDB and KWDB internal schemas and built-in routines', () => {
    for (const type of ['cockroachdb', 'kwdb']) {
      const dialect = resolveSidebarMetadataDialect(type);
      const specs = [...buildFunctionsMetadataQuerySpecs(dialect, 'shop'), ...buildSchemasMetadataQuerySpecs(dialect, 'shop')];
      expect(specs).toHaveLength(4);
      for (const spec of specs) {
        expect(spec.sql).toContain("'crdb_internal'");
        expect(spec.sql).toContain("'kwdb_internal'");
      }
    }
  });
});
