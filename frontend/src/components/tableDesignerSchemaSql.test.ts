import { describe, expect, it } from 'vitest';

import {
  buildCreateTablePreviewSql,
  buildAlterTablePreviewSql,
  buildStarRocksMaterializedViewPreviewSql,
  hasAlterTableDraftChanges,
  type BuildAlterTablePreviewInput,
  type EditableColumnSnapshot,
} from './tableDesignerSchemaSql';
import { t as catalogTranslate } from '../i18n/catalog';

const translateEn = (key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
  catalogTranslate('en-US', key, params);

const baseColumn = (overrides: Partial<EditableColumnSnapshot>): EditableColumnSnapshot => ({
  _key: overrides._key ?? 'col',
  name: overrides.name ?? 'id',
  type: overrides.type ?? 'int',
  nullable: overrides.nullable ?? 'NO',
  default: Object.prototype.hasOwnProperty.call(overrides, 'default') ? overrides.default : undefined,
  hasDefault: Object.prototype.hasOwnProperty.call(overrides, 'hasDefault')
    ? overrides.hasDefault
    : overrides.default !== undefined && overrides.default !== null && String(overrides.default).trim().length > 0,
  extra: overrides.extra ?? '',
  comment: overrides.comment ?? '',
  key: overrides.key ?? '',
  charset: overrides.charset,
  collation: overrides.collation,
  isAutoIncrement: overrides.isAutoIncrement ?? false,
});

const buildInput = (overrides: Partial<BuildAlterTablePreviewInput>): BuildAlterTablePreviewInput => ({
  dbType: overrides.dbType || 'mysql',
  tableName: overrides.tableName || 'users',
  originalColumns: overrides.originalColumns || [baseColumn({ _key: 'id', name: 'id', key: 'PRI', nullable: 'NO' })],
  columns: overrides.columns || [
    baseColumn({ _key: 'id', name: 'id', key: 'PRI', nullable: 'NO' }),
    baseColumn({ _key: 'age', name: 'age', nullable: 'YES', comment: '年龄' }),
  ],
});

describe('tableDesignerSchemaSql', () => {

  it('localizes generated SQL warning comments while keeping SQL and identifiers raw', () => {
    const sqliteSql = buildAlterTablePreviewSql(buildInput({
      dbType: 'sqlite',
      tableName: 'users',
      originalColumns: [baseColumn({ _key: 'name', name: 'name', type: 'TEXT', nullable: 'YES' })],
      columns: [baseColumn({ _key: 'name', name: 'display_name', type: 'INTEGER', nullable: 'NO' })],
      translate: translateEn,
    }));
    const duckCommentSql = buildAlterTablePreviewSql(buildInput({
      dbType: 'duckdb',
      tableName: 'main.users',
      originalColumns: [baseColumn({ _key: 'name', name: 'name', type: 'VARCHAR', nullable: 'YES', comment: '' })],
      columns: [baseColumn({ _key: 'name', name: 'name', type: 'VARCHAR', nullable: 'YES', comment: 'visible name' })],
      translate: translateEn,
    }));
    const limitedSql = buildAlterTablePreviewSql(buildInput({
      dbType: 'clickhouse',
      tableName: 'events',
      originalColumns: [],
      columns: [baseColumn({ _key: 'name', name: 'name', type: 'String', nullable: 'NO', default: 'guest', comment: 'raw comment' })],
      translate: translateEn,
    }));
    const tdengineSql = buildCreateTablePreviewSql({
      dbType: 'tdengine',
      tableName: 'meters',
      columns: [baseColumn({ _key: 'value', name: 'value', type: 'FLOAT', nullable: 'YES' })],
      translate: translateEn,
    });

    expect(sqliteSql).toContain('-- SQLite cannot alter column properties directly.');
    expect(sqliteSql).toContain('column display_name');
    expect(sqliteSql).toContain('ALTER TABLE "users"');
    expect(sqliteSql).not.toContain('不支持直接修改字段属性');

    expect(duckCommentSql).toContain('-- DuckDB cannot persist column comments through COMMENT ON COLUMN.');
    expect(duckCommentSql).toContain('column name');
    expect(duckCommentSql).toContain('COMMENT ON COLUMN');
    expect(duckCommentSql).not.toContain('字段 name 的备注');

    expect(limitedSql).toContain('-- ClickHouse column constraint, default, and comment syntax differs from MySQL.');
    expect(limitedSql).toContain('ALTER TABLE `events`');
    expect(limitedSql).toContain('ADD COLUMN `name` String;');
    expect(limitedSql).not.toContain('字段约束/默认值/备注语法');

    expect(tdengineSql).toContain('CREATE TABLE `meters`');
    expect(tdengineSql).toContain('-- TDengine regular tables usually require a TIMESTAMP column.');
    expect(tdengineSql).not.toContain('普通表通常需要 TIMESTAMP 时间列');
  });

  it('detects when alter table drafts contain unsaved column changes', () => {
    expect(hasAlterTableDraftChanges(buildInput({ dbType: 'mysql' }))).toBe(true);
    expect(
      hasAlterTableDraftChanges(
        buildInput({
          dbType: 'mysql',
          columns: [baseColumn({ _key: 'id', name: 'id', key: 'PRI', nullable: 'NO' })],
        }),
      ),
    ).toBe(false);
  });

  it('keeps mysql alter preview syntax with column position clauses', () => {
    const sql = buildAlterTablePreviewSql(buildInput({ dbType: 'mysql' }));

    expect(sql).toContain('ALTER TABLE `users`');
    expect(sql).toContain('ADD COLUMN `age` int NULL');
    expect(sql).toContain("COMMENT '年龄'");
    expect(sql).toContain('AFTER `id`');
  });

  it('preserves explicit MySQL default states and expressions', () => {
    const columns = [
      baseColumn({ _key: 'none', name: 'none_value', type: 'varchar(16)', nullable: 'YES', hasDefault: false }),
      baseColumn({ _key: 'null', name: 'null_value', type: 'varchar(16)', nullable: 'YES', default: 'NULL', hasDefault: true }),
      baseColumn({ _key: 'empty', name: 'empty_value', type: 'varchar(16)', nullable: 'YES', default: '', hasDefault: true }),
      baseColumn({ _key: 'zero', name: 'zero_value', type: 'int', nullable: 'YES', default: '0', hasDefault: true }),
      baseColumn({ _key: 'text', name: 'text_value', type: 'varchar(16)', nullable: 'YES', default: 'active', hasDefault: true }),
      baseColumn({ _key: 'time', name: 'time_value', type: 'timestamp(6)', nullable: 'NO', default: 'CURRENT_TIMESTAMP(6)', hasDefault: true }),
      baseColumn({ _key: 'bit', name: 'bit_value', type: 'bit(1)', nullable: 'NO', default: "b'0'", hasDefault: true }),
      baseColumn({ _key: 'hex', name: 'hex_value', type: 'binary(1)', nullable: 'NO', default: '0x00', hasDefault: true }),
      baseColumn({ _key: 'uuid', name: 'uuid_value', type: 'binary(16)', nullable: 'NO', default: '(uuid_to_bin(uuid()))', hasDefault: true }),
    ];

    const sql = buildCreateTablePreviewSql({
      tableName: 'defaults_test',
      dbType: 'mysql',
      columns,
    });

    expect(sql).toContain("`none_value` varchar(16) NULL COMMENT ''");
    expect(sql).not.toContain('`none_value` varchar(16) NULL DEFAULT');
    expect(sql).toContain('`null_value` varchar(16) NULL DEFAULT NULL');
    expect(sql).toContain("`empty_value` varchar(16) NULL DEFAULT ''");
    expect(sql).toContain('`zero_value` int NULL DEFAULT 0');
    expect(sql).toContain("`text_value` varchar(16) NULL DEFAULT 'active'");
    expect(sql).toContain('`time_value` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)');
    expect(sql).toContain("`bit_value` bit(1) NOT NULL DEFAULT b'0'");
    expect(sql).toContain('`hex_value` binary(1) NOT NULL DEFAULT 0x00');
    expect(sql).toContain('`uuid_value` binary(16) NOT NULL DEFAULT (uuid_to_bin(uuid()))');
  });

  it('does not generate an empty string default for non-character columns', () => {
    const sql = buildCreateTablePreviewSql({
      tableName: 'invalid_default',
      dbType: 'mysql',
      columns: [baseColumn({
        _key: 'count',
        name: 'count',
        type: 'int',
        nullable: 'NO',
        default: '',
        hasDefault: true,
      })],
    });

    expect(sql).not.toContain('DEFAULT');
  });

  it('detects changes between no default and an explicit empty string default', () => {
    const original = baseColumn({
      _key: 'status',
      name: 'status',
      type: 'varchar(16)',
      default: undefined,
      hasDefault: false,
    });
    const changed = baseColumn({
      ...original,
      default: '',
      hasDefault: true,
    });

    const sql = buildAlterTablePreviewSql(buildInput({
      dbType: 'mysql',
      originalColumns: [original],
      columns: [changed],
    }));

    expect(sql).toContain("MODIFY COLUMN `status` varchar(16) NOT NULL DEFAULT ''");
  });

  it('generates MySQL character options only for character columns', () => {
    const createSql = buildCreateTablePreviewSql({
      tableName: 'column_options',
      dbType: 'mysql',
      columns: [
        baseColumn({
          _key: 'name',
          name: 'name',
          type: 'varchar(64)',
          charset: 'utf8mb4',
          collation: 'utf8mb4_unicode_ci',
        }),
        baseColumn({
          _key: 'count',
          name: 'count',
          type: 'int',
          charset: 'utf8mb4',
          collation: 'utf8mb4_unicode_ci',
        }),
      ],
    });

    expect(createSql).toContain('`name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    expect(createSql).not.toContain('`count` int CHARACTER SET');
  });

  it.each([
    {
      label: 'charset',
      change: { charset: 'utf8' },
      expected: 'CHARACTER SET utf8 COLLATE utf8mb4_general_ci',
    },
    {
      label: 'collation',
      change: { collation: 'utf8mb4_unicode_ci' },
      expected: 'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
    },
  ])('detects a MySQL $label change without extending mysql-family dialects', ({ change, expected }) => {
    const original = baseColumn({
      _key: 'name',
      name: 'name',
      type: 'varchar(64)',
      charset: 'utf8mb4',
      collation: 'utf8mb4_general_ci',
    });
    const changed = baseColumn({ ...original, ...change });

    const mysqlSql = buildAlterTablePreviewSql(buildInput({
      dbType: 'mysql',
      originalColumns: [original],
      columns: [changed],
    }));
    const mariadbSql = buildAlterTablePreviewSql(buildInput({
      dbType: 'mariadb',
      originalColumns: [original],
      columns: [changed],
    }));

    expect(mysqlSql).toContain(`MODIFY COLUMN \`name\` varchar(64) ${expected}`);
    expect(mariadbSql).toBe('');
  });

  it('filters MySQL DEFAULT_GENERATED metadata while preserving valid extras', () => {
    const sql = buildCreateTablePreviewSql({
      tableName: 'generated_defaults',
      dbType: 'mysql',
      columns: [baseColumn({
        _key: 'updated_at',
        name: 'updated_at',
        type: 'timestamp',
        default: 'CURRENT_TIMESTAMP',
        hasDefault: true,
        extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP',
      })],
    });

    expect(sql).toContain('DEFAULT CURRENT_TIMESTAMP on update CURRENT_TIMESTAMP');
    expect(sql).not.toContain('DEFAULT_GENERATED');
  });

  it('builds kingbase alter preview without mysql-only syntax', () => {
    const sql = buildAlterTablePreviewSql(buildInput({
      dbType: 'kingbase',
      tableName: 'public.users',
    }));

    expect(sql).toContain('ALTER TABLE public.users');
    expect(sql).toContain('ADD COLUMN age int');
    expect(sql).toContain("COMMENT ON COLUMN public.users.age IS '年龄';");
    expect(sql).not.toContain('`');
    expect(sql).not.toContain('AFTER');
    expect(sql).not.toContain(' FIRST');
  });

  it('uses mysql change column syntax when renaming a column', () => {
    const sql = buildAlterTablePreviewSql(buildInput({
      dbType: 'mysql',
      originalColumns: [baseColumn({ _key: 'name', name: 'name', type: 'varchar(64)', nullable: 'YES' })],
      columns: [baseColumn({ _key: 'name', name: 'display_name', type: 'varchar(64)', nullable: 'YES' })],
    }));

    expect(sql).toContain('CHANGE COLUMN `name` `display_name` varchar(64) NULL');
    expect(sql).toContain('FIRST');
    expect(sql).not.toContain('MODIFY COLUMN `display_name`');
  });

  it('builds oracle alter preview with oracle rename and modify syntax', () => {
    const sql = buildAlterTablePreviewSql(buildInput({
      dbType: 'oracle',
      tableName: 'HR.EMPLOYEES',
      originalColumns: [
        baseColumn({ _key: 'name', name: 'NAME', type: 'VARCHAR2(64)', nullable: 'YES', comment: '旧名称' }),
      ],
      columns: [
        baseColumn({
          _key: 'name',
          name: 'DISPLAY_NAME',
          type: 'VARCHAR2(128)',
          nullable: 'NO',
          default: 'guest',
          comment: '显示名',
        }),
      ],
    }));

    expect(sql).toContain('ALTER TABLE "HR"."EMPLOYEES"\nRENAME COLUMN "NAME" TO "DISPLAY_NAME";');
    expect(sql).toContain(`ALTER TABLE "HR"."EMPLOYEES"\nMODIFY ("DISPLAY_NAME" VARCHAR2(128) DEFAULT 'guest' NOT NULL);`);
    expect(sql).toContain(`COMMENT ON COLUMN "HR"."EMPLOYEES"."DISPLAY_NAME" IS '显示名';`);
    expect(sql).not.toContain('`');
    expect(sql).not.toContain('CHANGE COLUMN');
    expect(sql).not.toContain('AUTO_INCREMENT');
  });

  it('builds sqlserver alter preview with sp_rename and alter column syntax', () => {
    const sql = buildAlterTablePreviewSql(buildInput({
      dbType: 'sqlserver',
      tableName: 'dbo.Users',
      originalColumns: [
        baseColumn({ _key: 'name', name: 'name', type: 'nvarchar(64)', nullable: 'YES' }),
      ],
      columns: [
        baseColumn({ _key: 'name', name: 'display_name', type: 'nvarchar(128)', nullable: 'NO' }),
      ],
    }));

    expect(sql).toContain(`EXEC sp_rename 'dbo.Users.name', 'display_name', 'COLUMN';`);
    expect(sql).toContain('ALTER TABLE [dbo].[Users]\nALTER COLUMN [display_name] nvarchar(128) NOT NULL;');
    expect(sql).not.toContain('CHANGE COLUMN');
    expect(sql).not.toContain('MODIFY COLUMN');
    expect(sql).not.toContain('`');
  });

  it('keeps sqlite alter preview limited to sqlite-supported operations', () => {
    const sql = buildAlterTablePreviewSql(buildInput({
      dbType: 'sqlite',
      tableName: 'users',
      originalColumns: [
        baseColumn({ _key: 'name', name: 'name', type: 'TEXT', nullable: 'YES' }),
      ],
      columns: [
        baseColumn({ _key: 'name', name: 'display_name', type: 'INTEGER', nullable: 'NO' }),
      ],
    }));

    expect(sql).toContain('ALTER TABLE "users"\nRENAME COLUMN "name" TO "display_name";');
    expect(sql).toContain('-- SQLite cannot alter column properties directly.');
    expect(sql).not.toContain('CHANGE COLUMN');
    expect(sql).not.toContain('MODIFY COLUMN');
    expect(sql).not.toContain('AFTER');
  });

  it('builds duckdb alter preview without mysql-only syntax', () => {
    const sql = buildAlterTablePreviewSql(buildInput({
      dbType: 'duckdb',
      tableName: 'main.users',
      originalColumns: [
        baseColumn({ _key: 'score', name: 'score', type: 'INTEGER', nullable: 'YES', default: '0' }),
      ],
      columns: [
        baseColumn({ _key: 'score', name: 'score', type: 'BIGINT', nullable: 'NO', default: '1' }),
      ],
    }));

    expect(sql).toContain('ALTER TABLE "main"."users"\nALTER COLUMN "score" SET DATA TYPE BIGINT;');
    expect(sql).toContain('ALTER TABLE "main"."users"\nALTER COLUMN "score" SET DEFAULT 1;');
    expect(sql).toContain('ALTER TABLE "main"."users"\nALTER COLUMN "score" SET NOT NULL;');
    expect(sql).not.toContain('CHANGE COLUMN');
    expect(sql).not.toContain('MODIFY COLUMN');
  });

  it('builds duckdb alter preview with add primary key when adding first primary key', () => {
    const sql = buildAlterTablePreviewSql(buildInput({
      dbType: 'duckdb',
      tableName: 'main.events',
      originalColumns: [
        baseColumn({ _key: 'id', name: 'id', type: 'BIGINT', nullable: 'YES', key: '' }),
        baseColumn({ _key: 'name', name: 'name', type: 'VARCHAR', nullable: 'YES', key: '' }),
      ],
      columns: [
        baseColumn({ _key: 'id', name: 'id', type: 'BIGINT', nullable: 'NO', key: 'PRI' }),
        baseColumn({ _key: 'name', name: 'name', type: 'VARCHAR', nullable: 'YES', key: '' }),
      ],
    }));

    expect(sql).toContain('ALTER TABLE "main"."events"\nALTER COLUMN "id" SET NOT NULL;');
    expect(sql).toContain('ALTER TABLE "main"."events"\nADD PRIMARY KEY ("id");');
  });

  it('marks unsupported duckdb primary key replacement with explicit warning comment', () => {
    const sql = buildAlterTablePreviewSql(buildInput({
      dbType: 'duckdb',
      tableName: 'main.events',
      originalColumns: [
        baseColumn({ _key: 'id', name: 'id', type: 'BIGINT', nullable: 'NO', key: 'PRI' }),
        baseColumn({ _key: 'name', name: 'name', type: 'VARCHAR', nullable: 'YES', key: '' }),
      ],
      columns: [
        baseColumn({ _key: 'id', name: 'id', type: 'BIGINT', nullable: 'NO', key: '' }),
        baseColumn({ _key: 'name', name: 'name', type: 'VARCHAR', nullable: 'NO', key: 'PRI' }),
      ],
    }));

    expect(sql).toContain('-- DuckDB currently only supports adding PRIMARY KEY to tables without an existing primary key.');
    expect(sql).not.toContain('DROP CONSTRAINT');
    expect(sql).not.toContain('DROP PRIMARY KEY');
  });

  it('builds doris alter preview without mysql-only syntax or metadata extra', () => {
    const sql = buildAlterTablePreviewSql(buildInput({
      dbType: 'doris',
      tableName: 'sales.orders',
      originalColumns: [
        baseColumn({
          _key: 'carrier',
          name: 'carrier_id',
          type: 'bigint',
          nullable: 'YES',
          extra: 'NONE',
          comment: '承运商id',
        }),
      ],
      columns: [
        baseColumn({
          _key: 'carrier',
          name: 'carrier_code',
          type: 'bigint',
          nullable: 'YES',
          extra: 'NONE',
          comment: '承运商id1',
        }),
      ],
    }));

    expect(sql).toContain('ALTER TABLE `sales`.`orders`\nRENAME COLUMN `carrier_id` `carrier_code`;');
    expect(sql).toContain("ALTER TABLE `sales`.`orders`\nMODIFY COLUMN `carrier_code` bigint NULL COMMENT '承运商id1';");
    expect(sql).not.toContain('CHANGE COLUMN');
    expect(sql).not.toContain('AFTER');
    expect(sql).not.toContain(' FIRST');
    expect(sql).not.toContain('NONE');
  });

  it('uses native limited alter syntax for clickhouse and tdengine instead of mysql syntax', () => {
    const clickhouseSql = buildAlterTablePreviewSql(buildInput({
      dbType: 'clickhouse',
      tableName: 'events',
      originalColumns: [baseColumn({ _key: 'name', name: 'name', type: 'String', nullable: 'YES' })],
      columns: [baseColumn({ _key: 'name', name: 'display_name', type: 'String', nullable: 'YES' })],
    }));
    const tdengineSql = buildAlterTablePreviewSql(buildInput({
      dbType: 'tdengine',
      tableName: 'meters',
      originalColumns: [baseColumn({ _key: 'value', name: 'value', type: 'FLOAT', nullable: 'YES' })],
      columns: [baseColumn({ _key: 'value', name: 'value', type: 'DOUBLE', nullable: 'YES' })],
    }));

    expect(clickhouseSql).toContain('ALTER TABLE `events`\nRENAME COLUMN `name` TO `display_name`;');
    expect(tdengineSql).toContain('ALTER TABLE `meters`\nMODIFY COLUMN `value` DOUBLE;');
    expect(clickhouseSql).not.toContain('CHANGE COLUMN');
    expect(tdengineSql).not.toContain('CHANGE COLUMN');
    expect(clickhouseSql).not.toContain('AFTER');
    expect(tdengineSql).not.toContain('AFTER');
  });

  it('keeps freely entered MySQL spatial type attributes in schema SQL', () => {
    const location = baseColumn({
      _key: 'location',
      name: 'location',
      type: 'POINT SRID 4326',
      nullable: 'NO',
    });
    const createSql = buildCreateTablePreviewSql({
      tableName: 'places',
      dbType: 'mysql',
      columns: [location],
    });
    const alterSql = buildAlterTablePreviewSql(buildInput({
      tableName: 'places',
      originalColumns: [],
      columns: [location],
    }));

    expect(createSql).toContain('`location` POINT SRID 4326 NOT NULL');
    expect(alterSql).toContain('ADD COLUMN `location` POINT SRID 4326 NOT NULL');
  });

  it('builds StarRocks create table preview with OLAP engine and conservative distribution', () => {
    const sql = buildCreateTablePreviewSql({
      tableName: 'sales.orders',
      dbType: 'starrocks',
      columns: [
        baseColumn({ _key: 'id', name: 'id', type: 'BIGINT', nullable: 'NO', key: 'PRI' }),
        baseColumn({ _key: 'amount', name: 'amount', type: 'DECIMAL(10,2)', nullable: 'YES' }),
      ],
    });

    expect(sql).toContain('CREATE TABLE `sales`.`orders`');
    expect(sql).toContain('ENGINE=OLAP');
    expect(sql).toContain('DUPLICATE KEY (`id`)');
    expect(sql).toContain('DISTRIBUTED BY HASH(`id`) BUCKETS AUTO');
    expect(sql).not.toContain('ENGINE=InnoDB');
  });

  it('builds StarRocks advanced OLAP table preview with key model, partition, buckets, properties and rollup', () => {
    const sql = buildCreateTablePreviewSql({
      tableName: 'sales.events',
      dbType: 'starrocks',
      columns: [
        baseColumn({ _key: 'dt', name: 'dt', type: 'DATE', nullable: 'NO' }),
        baseColumn({ _key: 'user_id', name: 'user_id', type: 'BIGINT', nullable: 'NO' }),
        baseColumn({ _key: 'amount', name: 'amount', type: 'DECIMAL(10,2)', nullable: 'YES', extra: 'SUM' }),
      ],
      starRocksOptions: {
        keyModel: 'AGGREGATE',
        keyColumnNames: ['dt', 'user_id'],
        partitionClause: 'PARTITION BY date_trunc(\'day\', `dt`)',
        distributionColumnNames: ['user_id'],
        bucketMode: 'NUMBER',
        bucketCount: 12,
        properties: '"replication_num" = "1"',
        rollups: [{ name: 'rollup_dt', columnNames: ['dt', 'amount'] }],
      },
    });

    expect(sql).toContain('AGGREGATE KEY (`dt`, `user_id`)');
    expect(sql).toContain("PARTITION BY date_trunc('day', `dt`)");
    expect(sql).toContain('DISTRIBUTED BY HASH(`user_id`) BUCKETS 12');
    expect(sql).toContain('PROPERTIES (');
    expect(sql).toContain('ALTER TABLE `sales`.`events`\nADD ROLLUP `rollup_dt` (`dt`, `amount`);');
  });

  it('builds StarRocks external table preview with external engine and properties', () => {
    const sql = buildCreateTablePreviewSql({
      tableName: 'ext.raw_orders',
      dbType: 'starrocks',
      columns: [
        baseColumn({ _key: 'id', name: 'id', type: 'BIGINT', nullable: 'NO' }),
        baseColumn({ _key: 'payload', name: 'payload', type: 'STRING', nullable: 'YES' }),
      ],
      starRocksOptions: {
        tableKind: 'external',
        externalEngine: 'hive',
        externalProperties: '"resource" = "hive0"\n"database" = "ods"\n"table" = "orders"',
      },
    });

    expect(sql).toContain('CREATE EXTERNAL TABLE `ext`.`raw_orders`');
    expect(sql).toContain('ENGINE=HIVE');
    expect(sql).toContain('"resource" = "hive0"');
    expect(sql).not.toContain('ENGINE=OLAP');
  });

  it('builds StarRocks materialized view preview with refresh and distribution clauses', () => {
    const sql = buildStarRocksMaterializedViewPreviewSql({
      name: 'sales.mv_user_amount',
      query: 'SELECT user_id, SUM(amount) AS total_amount FROM sales.events GROUP BY user_id',
      distributionColumnNames: ['user_id'],
      bucketCount: 8,
      refreshClause: 'REFRESH SCHEDULE EVERY(INTERVAL 10 MINUTE)',
      properties: '"replication_num" = "1"',
    });

    expect(sql).toContain('CREATE MATERIALIZED VIEW `sales`.`mv_user_amount`');
    expect(sql).toContain('REFRESH SCHEDULE EVERY(INTERVAL 10 MINUTE)');
    expect(sql).toContain('DISTRIBUTED BY HASH(`user_id`) BUCKETS 8');
    expect(sql).toContain('AS\nSELECT user_id, SUM(amount) AS total_amount FROM sales.events GROUP BY user_id;');
  });

  it('treats mariadb and sphinx as mysql-family only where mysql syntax is intended', () => {
    for (const dbType of ['mariadb', 'sphinx']) {
      const sql = buildAlterTablePreviewSql(buildInput({ dbType }));
      expect(sql).toContain('ALTER TABLE `users`');
      expect(sql).toContain('ADD COLUMN `age` int NULL');
    }
  });

  it('builds oracle create table preview without mysql table options', () => {
    const sql = buildCreateTablePreviewSql({
      dbType: 'oracle',
      tableName: 'HR.EMPLOYEES',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
      columns: [
        baseColumn({ _key: 'id', name: 'ID', type: 'NUMBER(10)', nullable: 'NO', key: 'PRI', isAutoIncrement: true }),
        baseColumn({ _key: 'name', name: 'NAME', type: 'VARCHAR2(255)', nullable: 'YES', comment: '姓名' }),
      ],
    });

    expect(sql).toContain('CREATE TABLE "HR"."EMPLOYEES"');
    expect(sql).toContain('"ID" NUMBER(10) GENERATED BY DEFAULT AS IDENTITY NOT NULL');
    expect(sql).toContain('PRIMARY KEY ("ID")');
    expect(sql).toContain(`COMMENT ON COLUMN "HR"."EMPLOYEES"."NAME" IS '姓名';`);
    expect(sql).not.toContain('ENGINE=InnoDB');
    expect(sql).not.toContain('DEFAULT CHARSET');
    expect(sql).not.toContain('AUTO_INCREMENT');
    expect(sql).not.toContain('`');
  });
});
