import { describe, expect, it } from 'vitest';

import { formatDdlForDisplay } from './ddlFormat';

describe('formatDdlForDisplay', () => {
  it('formats DuckDB create table SQL into multiline output', () => {
    const raw = 'CREATE TABLE customers(customer_id BIGINT, customer_code VARCHAR, city VARCHAR, tier VARCHAR, signup_date DATE, lifetime_value DECIMAL(12,2), PRIMARY KEY(customer_id));';

    const formatted = formatDdlForDisplay(raw, 'duckdb');

    expect(formatted).toContain('CREATE TABLE customers (');
    expect(formatted).toContain('customer_id BIGINT,');
    expect(formatted).toContain('PRIMARY KEY (customer_id)');
    expect(formatted).toContain('\n');
  });

  it('returns original text when formatter cannot parse the statement', () => {
    const raw = 'not valid ddl(';

    expect(formatDdlForDisplay(raw, 'duckdb')).toBe(raw);
  });

  it('keeps Oracle comment statements separated from create table DDL', () => {
    const raw = `CREATE TABLE "H2"."S_BUSI" (
  "ID" NUMBER
) TABLESPACE "H2DB";

COMMENT ON TABLE "H2"."S_BUSI" IS '业务机构信息';
COMMENT ON COLUMN "H2"."S_BUSI"."ID" IS '主键';`;

    const formatted = formatDdlForDisplay(raw, 'oracle');

    expect(formatted).toContain('TABLESPACE "H2DB";\n\nCOMMENT ON TABLE "H2"."S_BUSI"');
    expect(formatted).toContain(`COMMENT ON COLUMN "H2"."S_BUSI"."ID" IS '主键';`);
  });

  it('preserves Oracle view DDL formatting', () => {
    const raw = `CREATE OR REPLACE FORCE EDITIONABLE VIEW "APP"."V_RISK" ("ID", "ORG_NAME", "PARENT_NAME", "LEVEL_NO") DEFAULT COLLATION "USING_NLS_COMP" AS SELECT a.id,NVL(b.org_name,'-') org_name,DECODE(a.parent_id,NULL,'ROOT',c.org_name) parent_name,LEVEL level_no FROM org a,org_info b,org_info c WHERE a.id=b.org_id(+) AND a.parent_id=c.org_id(+) START WITH a.parent_id IS NULL CONNECT BY PRIOR a.id=a.parent_id WITH READ ONLY;`;

    expect(formatDdlForDisplay(raw, 'oracle')).toBe(raw);
  });
});
