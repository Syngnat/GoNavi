import { describe, expect, it } from 'vitest';

import { buildUriFromValues, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { usesDriverObjectDefinition, usesDriverSequenceDefinition } from '../../components/definitionViewerDialect';
import {
  buildFunctionsMetadataQuerySpecs,
  buildSequencesMetadataQuerySpecs,
  buildTriggersMetadataQuerySpecs,
  buildViewsMetadataQuerySpecs,
} from '../../components/sidebar/sidebarMetadataQuerySpecs';
import { buildAlterTablePreviewSql } from '../../components/tableDesignerSchemaSqlAlter';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import { getDataSourceCapabilities } from '../dataSourceCapabilities';
import { buildPaginatedSelectSQL, quoteIdentPart } from '../sql';
import { applyQueryAutoLimit } from '../queryAutoLimit';
import { resolveSqlDialect } from '../sqlDialectCore';
import { resolveSidebarMetadataDialect } from '../sidebarMetadata';
import { getDataSourceSpec } from './index';

const firebirdConn = { config: { type: 'firebird' } };

describe('Firebird registry behavior', () => {
  it('joins the relational group on port 3050 with its own dialect', () => {
    const group = CONNECTION_TYPE_GROUPS.find((item) => item.labelKey.endsWith('.relational'));
    expect(group?.items.map((item) => item.key)).toContain('firebird');
    expect(getConnectionTypeDefaultPort('firebird')).toBe(3050);
    expect(resolveSqlDialect('firebird')).toBe('firebird');
    expect(getDataSourceSpec('firebird')?.ui?.defaultUser).toBe('SYSDBA');
    expect(getDataSourceSpec('firebird')?.ui?.paramFields?.map((field) => field.key)).toEqual(['databasePath']);
  });

  it('pages with ROWS m TO n and always quotes identifiers', () => {
    expect(buildPaginatedSelectSQL('firebird', 'SELECT * FROM "ORDERS"', ' ORDER BY "ID"', 50, 100))
      .toBe('SELECT * FROM "ORDERS" ORDER BY "ID" ROWS 101 TO 150');
    expect(quoteIdentPart('firebird', 'ORDERS')).toBe('"ORDERS"');
  });

  it('caps editor queries with ROWS instead of LIMIT and leaves explicit row clauses alone', () => {
    expect(applyQueryAutoLimit('SELECT * FROM sp_test(21);', 'firebird', 5000).sql).toBe('SELECT * FROM sp_test(21) ROWS 1 TO 5000;');
    expect(applyQueryAutoLimit('SELECT * FROM t ORDER BY id ROWS 10', 'firebird', 5000).applied).toBe(false);
    expect(applyQueryAutoLimit('SELECT FIRST 3 * FROM t', 'firebird', 5000).applied).toBe(false);
    expect(applyQueryAutoLimit('SELECT * FROM orders', 'gbase8s', 100).sql).toBe('SELECT SKIP 0 FIRST 100 * FROM orders');
  });

  it('accepts firebird:// connection strings', () => {
    expect(parseUriToValues('firebird://SYSDBA:masterkey@10.0.0.9:3050/employee', 'firebird')).toMatchObject({
      host: '10.0.0.9', port: 3050, user: 'SYSDBA', database: 'employee',
    });
    expect(buildUriFromValues({ type: 'firebird', host: '10.0.0.9', port: 3050, user: 'SYSDBA', database: 'employee' }))
      .toMatch(/^firebird:\/\/SYSDBA@10\.0\.0\.9:3050\/employee/);
  });

  it('lists views, triggers, routines and generators from the RDB$ catalog', () => {
    const dialect = resolveSidebarMetadataDialect('firebird');
    expect(buildViewsMetadataQuerySpecs(dialect, 'app')[0].sql).toContain('RDB$VIEW_BLR IS NOT NULL');
    expect(buildTriggersMetadataQuerySpecs(dialect, 'app')[0].sql).toContain('RDB$TRIGGERS');
    const routines = buildFunctionsMetadataQuerySpecs(dialect, 'app');
    expect(routines[0].sql).toContain('RDB$FUNCTIONS');
    expect(routines[1].sql).not.toContain('RDB$PACKAGE_NAME');
    expect(buildSequencesMetadataQuerySpecs(dialect, 'app')[0].sql).toContain('RDB$GENERATORS');
  });

  it('asks the driver for routine, trigger, package and generator definitions', () => {
    expect(usesDriverObjectDefinition(firebirdConn)).toBe(true);
    expect(usesDriverSequenceDefinition(firebirdConn, [])).toBe(true);
    expect(usesDriverSequenceDefinition(firebirdConn, ['SELECT 1'])).toBe(false);
    expect(usesDriverSequenceDefinition({ config: { type: 'gbase8s' } }, [])).toBe(false);
  });

  it('generates Firebird ALTER TABLE syntax in the table designer', () => {
    const base = { _key: 'b', name: 'TITLE', type: 'VARCHAR(40)', nullable: 'YES' };
    const sql = buildAlterTablePreviewSql({
      dbType: 'firebird',
      tableName: 'ITEMS',
      originalColumns: [
        { _key: 'a', name: 'ID', type: 'INTEGER', nullable: 'NO', key: 'PRI' },
        base,
        { _key: 'c', name: 'OLD_NOTE', type: 'VARCHAR(10)', nullable: 'YES' },
      ],
      columns: [
        { _key: 'a', name: 'ID', type: 'INTEGER', nullable: 'NO', key: 'PRI' },
        { ...base, name: 'CAPTION', type: 'VARCHAR(80)', nullable: 'NO', default: 'x', hasDefault: true, comment: '标题' },
        { _key: 'd', name: 'PRICE', type: 'NUMERIC(12,2)', nullable: 'NO', default: '0', hasDefault: true },
      ],
    });
    expect(sql.split('\n')).toEqual([
      'ALTER TABLE "ITEMS" DROP "OLD_NOTE";',
      'ALTER TABLE "ITEMS" ALTER COLUMN "TITLE" TO "CAPTION";',
      'ALTER TABLE "ITEMS" ALTER COLUMN "CAPTION" TYPE VARCHAR(80);',
      'ALTER TABLE "ITEMS" ALTER COLUMN "CAPTION" SET DEFAULT \'x\';',
      'ALTER TABLE "ITEMS" ALTER COLUMN "CAPTION" SET NOT NULL;',
      'COMMENT ON COLUMN "ITEMS"."CAPTION" IS \'标题\';',
      'ALTER TABLE "ITEMS" ADD "PRICE" NUMERIC(12,2) DEFAULT 0 NOT NULL;',
    ]);
  });

  it('turns off database management and EXPLAIN diagnosis', () => {
    const capabilities = getDataSourceCapabilities({ type: 'firebird' } as never);
    expect(capabilities.supportsCreateDatabase).toBe(false);
    expect(capabilities.supportsExplainDiagnosis).toBe(false);
    expect(capabilities.supportsUserManagement).toBe(false);
  });
});
