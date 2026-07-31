import { describe, expect, it } from 'vitest';

import { buildSidebarTableStatusSQL } from './sidebar/sidebarMetadataLoaders';

describe('Sidebar Dameng table count regression', () => {
  it('keeps oracle-like table metadata schema-aware for schema-grouped sidebars', () => {
    const damengSql = buildSidebarTableStatusSQL({ config: { type: 'dameng' } } as any, 'APP');
    const oracleSql = buildSidebarTableStatusSQL({ config: { type: 'oracle' } } as any, 'APP');

    expect(damengSql).toContain('owner AS schema_name');
    expect(damengSql).toContain('comments AS table_comment');
    expect(damengSql).toContain('COALESCE(t.blocks, 0) * 8192 AS table_size');
    expect(damengSql).not.toContain('all_segments');
    expect(oracleSql).toContain('owner AS schema_name');
    expect(oracleSql).toContain('COALESCE(t.blocks, 0) * 8192 AS table_size');
    expect(oracleSql).not.toContain('all_segments');
  });
});
