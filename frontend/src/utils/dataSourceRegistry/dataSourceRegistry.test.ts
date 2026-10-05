import { describe, expect, it } from 'vitest';

import {
  canonicalizeDataSourceType,
  dataSourceVariantNeedsSeparateAgent,
  getDataSourceSpec,
  getDataSourceVariants,
  getDefaultDataSourceVariant,
  isDataSourceFamily,
  listDataSourceSpecs,
  supportsAutoDataSourceVariant,
} from '.';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import {
  isMySQLCompatibleType,
  supportsConnectionParamsForType,
  supportsSSLForType,
} from '../connectionTypeCapabilities';

describe('data source registry', () => {
  it('loads every spec file once with unique types', () => {
    const types = listDataSourceSpecs().map((spec) => spec.type);
    expect(types).toContain('tidb');
    expect(new Set(types).size).toBe(types.length);
  });

  it('resolves aliases case-insensitively and leaves other types alone', () => {
    expect(canonicalizeDataSourceType(' PingCAP-TiDB ')).toBe('tidb');
    expect(canonicalizeDataSourceType('MySQL')).toBe('mysql');
    expect(getDataSourceSpec('tidb-server')?.displayName).toBe('TiDB');
  });

  it('declares at most three driver variants with a valid default', () => {
    for (const spec of listDataSourceSpecs()) {
      const variants = getDataSourceVariants(spec.type);
      expect(variants.length).toBeGreaterThan(0);
      expect(variants.length).toBeLessThanOrEqual(3);
      const fallback = getDefaultDataSourceVariant(spec.type);
      if (fallback === 'auto') {
        expect(supportsAutoDataSourceVariant(spec.type)).toBe(true);
      } else {
        expect(variants.map((item) => item.id)).toContain(fallback);
      }
    }
  });

  it('wires TiDB into the catalog and MySQL-family capabilities', () => {
    const relational = CONNECTION_TYPE_GROUPS.find((group) => group.labelKey.endsWith('.relational'));
    expect(relational?.items.map((item) => item.key)).toContain('tidb');
    expect(getConnectionTypeDefaultPort('tidb')).toBe(4000);
    expect(isDataSourceFamily('tidb', 'mysql')).toBe(true);
    expect(isMySQLCompatibleType('tidb')).toBe(true);
    expect(supportsSSLForType('tidb')).toBe(true);
    expect(supportsConnectionParamsForType('tidb')).toBe(true);
    expect(dataSourceVariantNeedsSeparateAgent('tidb', 'v8')).toBe(false);
  });

  it('keeps registry-only catalog groups hidden until they have members', () => {
    const groupKeys = CONNECTION_TYPE_GROUPS.map((group) => group.labelKey);
    const populated = new Set(listDataSourceSpecs().map((spec) => `connection_modal.step1.group.${spec.group}`));
    for (const key of ['connection_modal.step1.group.search', 'connection_modal.step1.group.bigdata']) {
      expect(groupKeys.includes(key)).toBe(populated.has(key));
    }
  });
});
