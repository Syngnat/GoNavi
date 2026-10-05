import { describe, expect, it } from 'vitest';

import { buildUriFromValues, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { buildIndexCreateSqlPreview } from '../../components/tableDesignerIndexSql';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import { getDataSourceCapabilityContract } from '../dataSourceCapabilities';
import { isMysqlFamilyDialect, resolveSqlDialect } from '../sqlDialectCore';
import { filterIndexKindsByDesign, getRegistryIndexDesign } from './indexDesign';

const gbase8a = { type: 'gbase8a' } as never;

describe('GBase 8a registry behavior', () => {
  it('joins the domestic group on port 5258 and borrows the MySQL dialect', () => {
    const group = CONNECTION_TYPE_GROUPS.find((item) => item.labelKey.endsWith('.domestic'));
    expect(group?.items.map((item) => item.key)).toContain('gbase8a');
    expect(getConnectionTypeDefaultPort('gbase8a')).toBe(5258);
    expect(resolveSqlDialect('gbase8a')).toBe('mysql');
    expect(isMysqlFamilyDialect('gbase8a')).toBe(true);
  });

  it('keeps transactions but turns off MySQL user management', () => {
    const contract = getDataSourceCapabilityContract(gbase8a);
    expect(contract.transaction?.supported).toBe(true);
    expect(contract.ui?.userManagement).toBe(false);
  });

  it('parses jdbc-style gbase:// connection strings', () => {
    expect(parseUriToValues('gbase://root:secret@10.0.0.5:5258/sales', 'gbase8a')).toMatchObject({
      host: '10.0.0.5', port: 5258, user: 'root', password: 'secret', database: 'sales',
    });
    expect(buildUriFromValues({ type: 'gbase8a', host: '10.0.0.5', port: 5258, user: 'root', database: 'sales' }))
      .toMatch(/^gbase8a:\/\/root@10\.0\.0\.5:5258\/sales/);
  });

  it('limits the table designer to normal HASH indexes', () => {
    const design = getRegistryIndexDesign('gbase8a');
    expect(design).toEqual({ kinds: ['NORMAL'], methods: ['HASH'] });
    expect(filterIndexKindsByDesign([{ value: 'NORMAL' }, { value: 'UNIQUE' }, { value: 'PRIMARY' }], design)).toEqual([{ value: 'NORMAL' }]);
    expect(getRegistryIndexDesign('mysql')).toBeUndefined();
    const result = buildIndexCreateSqlPreview({
      dbType: resolveSqlDialect('gbase8a'), tableRef: '`orders`', name: 'idx_customer', columnNames: ['customer_id'], kind: 'NORMAL', indexType: 'HASH',
    });
    expect(result.sql).toBe('ALTER TABLE `orders`\nADD INDEX `idx_customer` USING HASH (`customer_id`);');
  });
});
