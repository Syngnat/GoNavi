import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../wailsjs/go/app/App", () => ({
  DBQuery: vi.fn(),
}));

import { DBQuery } from "../../../wailsjs/go/app/App";
import {
  buildFunctionsMetadataQuerySpecs,
  buildPackagesMetadataQuerySpecs,
  buildQualifiedName,
  buildSchemasMetadataQuerySpecs,
  buildSequencesMetadataQuerySpecs,
  buildSidebarObjectKeyName,
  buildSidebarTableStatusSQL,
  buildTriggersMetadataQuerySpecs,
  buildViewsMetadataQuerySpecs,
  getSidebarTableName,
  loadDatabaseTriggers,
  loadFunctions,
  loadPackages,
  loadSchemas,
  loadSequences,
  loadViews,
  parseSidebarTableRowCount,
  shouldHideSchemaPrefix,
  supportsDatabaseSequences,
} from "./sidebarMetadataLoaders";

const mockedDBQuery = vi.mocked(DBQuery);

beforeEach(() => {
  mockedDBQuery.mockReset();
});

describe("sidebar table metadata", () => {
  it("keeps the table name when SQLite table rows include an exact row count", () => {
    expect(getSidebarTableName({ Rows: "2", Table: "orders" })).toBe("orders");
  });

  it("loads PostgreSQL partition parents without running an exact row count", () => {
    const sql = buildSidebarTableStatusSQL(
      { config: { type: "postgres" } } as any,
      "analytics",
    );

    expect(sql).toContain("pg_inherits");
    expect(sql).toContain("AS partition_parent_table");
    expect(sql).toContain("c.relkind IN ('r', 'p')");
    expect(sql).toContain(
      "CASE WHEN c.relkind = 'p' THEN NULL ELSE c.reltuples::bigint END AS table_rows",
    );
    expect(sql).not.toMatch(/COUNT\s*\(/i);
  });

  it("treats a zero InnoDB estimate as unknown without hiding reliable zero counts", () => {
    const mysql = { config: { type: "mysql" } } as any;

    expect(parseSidebarTableRowCount({ table_rows: 0, table_engine: "InnoDB" }, mysql)).toBeUndefined();
    expect(parseSidebarTableRowCount({ table_rows: 0 }, mysql)).toBeUndefined();
    expect(parseSidebarTableRowCount({ table_rows: 12, table_engine: "InnoDB" }, mysql)).toBe(12);
    expect(parseSidebarTableRowCount({ table_rows: 0, table_engine: "MyISAM" }, mysql)).toBe(0);
    expect(parseSidebarTableRowCount(
      { table_rows: 0, table_engine: "InnoDB" },
      { config: { type: "starrocks" } } as any,
    )).toBe(0);
  });

  it("loads the MySQL engine so unreliable InnoDB zero estimates can be identified", () => {
    const sql = buildSidebarTableStatusSQL(
      { config: { type: "mysql" } } as any,
      "sales",
    );

    expect(sql).toContain("ENGINE AS table_engine");
    expect(sql).not.toMatch(/COUNT\s*\(/i);
  });

  it("groups DuckDB objects under schemas", () => {
    expect(shouldHideSchemaPrefix({ config: { type: "duckdb" } } as any)).toBe(true);
  });
});

describe("sidebar object identities", () => {
  it("keeps quoted-dot object names scoped to their schema", () => {
    expect(buildQualifiedName("sales", '"daily.report"')).toBe(
      'sales."daily.report"',
    );
    expect(buildQualifiedName("sales", 'sales."daily.report"')).toBe(
      'sales."daily.report"',
    );

    expect(
      buildSidebarObjectKeyName("app", "sales", '"daily.report"'),
    ).toBe('sales."daily.report"');
    expect(
      buildSidebarObjectKeyName("app", "archive", '"daily.report"'),
    ).toBe('archive."daily.report"');
  });
});

describe("sidebar trigger metadata identifiers", () => {
  it("keeps dotted trigger and table names as single identifiers", async () => {
    mockedDBQuery.mockResolvedValue({
      success: true,
      message: "",
      data: [{
        trigger_name: "a.b",
        table_name: "order.items",
        schema_name: "audit",
      }],
    });

    await expect(loadDatabaseTriggers({ config: { type: "mysql" } }, "app")).resolves.toEqual({
      supported: true,
      triggers: [{
        displayName: "a.b (audit.\`order.items\`)",
        triggerName: "a.b",
        tableName: "audit.\`order.items\`",
        schemaName: "audit",
      }],
    });
  });

  it("keeps legacy qualified trigger metadata working when schema metadata is absent", async () => {
    mockedDBQuery.mockResolvedValue({
      success: true,
      message: "",
      data: [{
        trigger_name: "audit.users_bi",
        table_name: "audit.users",
      }],
    });

    await expect(loadDatabaseTriggers({ config: { type: "mysql" } }, "app")).resolves.toEqual({
      supported: true,
      triggers: [{
        displayName: "users_bi (audit.users)",
        triggerName: "audit.users_bi",
        tableName: "audit.users",
        schemaName: "audit",
      }],
    });
  });
});

describe("buildSchemasMetadataQuerySpecs", () => {
  it("returns schema queries for independent-schema targets", () => {
    expect(
      buildSchemasMetadataQuerySpecs("sqlserver", "app_db")[0]?.sql,
    ).toContain(".sys.schemas");
    expect(
      buildSchemasMetadataQuerySpecs("iris", "USER")[0]?.sql.toLowerCase(),
    ).toContain("information_schema.schemata");
    expect(
      buildSchemasMetadataQuerySpecs(
        "duckdb",
        "analytics",
      )[0]?.sql.toLowerCase(),
    ).toContain("information_schema.schemata");
  });

  it("keeps unsupported dialects empty", () => {
    expect(buildSchemasMetadataQuerySpecs("mysql", "app")).toEqual([]);
  });

  it.each([
    ["postgres", undefined],
    ["kingbase", undefined],
    ["custom", "pgx"],
  ])("keeps case-distinct schemas selectable for %s", async (type, driver) => {
    mockedDBQuery.mockResolvedValue({
      success: true,
      message: "",
      data: [
        { schema_name: "foo" },
        { schema_name: "Foo" },
        { schema_name: "foo" },
      ],
    });

    await expect(loadSchemas({ config: { type, ...(driver ? { driver } : {}) } }, "analytics")).resolves.toEqual({
      supported: true,
      schemas: ["foo", "Foo"],
    });
  });

  it("deduplicates DuckDB schemas case-insensitively", async () => {
    mockedDBQuery.mockResolvedValue({
      success: true,
      message: "",
      data: [
        { schema_name: "foo" },
        { schema_name: "Foo" },
        { schema_name: "foo" },
      ],
    });

    await expect(loadSchemas({ config: { type: "duckdb" } }, "analytics")).resolves.toEqual({
      supported: true,
      schemas: ["foo"],
    });
  });

  it("deduplicates MySQL view metadata when fallback queries omit schema names", async () => {
    mockedDBQuery.mockImplementation(async (_config: unknown, _dbName: string, sql: string) => {
      if (sql.includes("information_schema.views")) {
        return {
          success: true,
          message: "",
          data: [{ view_name: "CHARACTER_SETS", schema_name: "information_schema" }],
        };
      }
      if (sql.includes("information_schema.tables")) {
        return {
          success: true,
          message: "",
          data: [{ view_name: "CHARACTER_SETS", schema_name: "information_schema", table_type: "SYSTEM VIEW" }],
        };
      }
      if (sql.includes("SHOW FULL TABLES FROM `information_schema` WHERE Table_type = 'VIEW'")) {
        return {
          success: true,
          message: "",
          data: [{ Tables_in_information_schema: "CHARACTER_SETS", Table_type: "VIEW" }],
        };
      }
      return { success: false, message: "", data: [] };
    });

    const result = await loadViews({ config: { type: "mysql" } }, "information_schema");

    expect(result.supported).toBe(true);
    expect(result.views).toEqual([
      { viewName: "CHARACTER_SETS", schemaName: "information_schema" },
    ]);
  });

  it("retains a view metadata failure when every fallback query fails", async () => {
    mockedDBQuery.mockResolvedValue({
      success: false,
      message: "view metadata permission denied",
      data: [],
    });

    await expect(loadViews({ config: { type: "mysql" } }, "app")).resolves.toMatchObject({
      supported: false,
      views: [],
      failureMessage: "view metadata permission denied",
    });
  });

  it("keeps PostgreSQL case-distinct views instead of collapsing them", async () => {
    mockedDBQuery.mockResolvedValue({
      success: true,
      message: "",
      data: [
        { schema_name: "public", view_name: "users", table_type: "VIEW" },
        { schema_name: "public", view_name: "Users", table_type: "VIEW" },
        { schema_name: "public", view_name: "users", table_type: "VIEW" },
      ],
    });

    const result = await loadViews({ config: { type: "postgres" } }, "app");

    expect(result.views).toEqual([
      { schemaName: "public", viewName: "public.users" },
      { schemaName: "public", viewName: "public.Users" },
    ]);
  });
});

describe("PostgreSQL sequence metadata", () => {
  it("queries visible non-system sequences for PostgreSQL-compatible dialects", () => {
    const specs = buildSequencesMetadataQuerySpecs("postgres", "saas_cloud");

    expect(specs).toHaveLength(1);
    expect(specs[0]?.sql).toContain("information_schema.sequences");
    expect(specs[0]?.sql).toContain("sequence_schema NOT IN ('pg_catalog', 'information_schema')");
    expect(specs[0]?.sql).not.toContain("saas_cloud");
    expect(supportsDatabaseSequences({ config: { type: "postgres" } } as any)).toBe(true);
    expect(supportsDatabaseSequences({ config: { type: "mysql" } } as any)).toBe(false);
  });

  it("loads schema-qualified PostgreSQL sequence names", async () => {
    mockedDBQuery.mockResolvedValue({
      success: true,
      message: "",
      data: [
        { schema_name: "public", sequence_name: "pay_method_info_id_seq" },
      ],
    });

    await expect(loadSequences({ config: { type: "postgres" } }, "saas_cloud")).resolves.toEqual({
      supported: true,
      sequences: [{
        displayName: "public.pay_method_info_id_seq",
        schemaName: "public",
        sequenceName: "public.pay_method_info_id_seq",
      }],
    });
  });
});

describe("Oracle object metadata loaders", () => {
  it("loads Oracle compiler status for routines and triggers", async () => {
    expect(buildFunctionsMetadataQuerySpecs("oracle", "SBDEV")[0]?.sql).toContain(
      "STATUS AS object_status",
    );
    expect(buildTriggersMetadataQuerySpecs("oracle", "SBDEV")[0]?.sql).toContain(
      "STATUS AS object_status",
    );

    mockedDBQuery.mockImplementation(async (_config: unknown, _dbName: string, sql: string) => {
      if (sql.includes("ALL_TRIGGERS")) {
        return {
          success: true,
          message: "",
          data: [{ OWNER: "SBDEV", TABLE_NAME: "ORDERS", TRIGGER_NAME: "TRG_AUDIT", OBJECT_STATUS: "INVALID" }],
        };
      }
      if (sql.includes("ALL_OBJECTS")) {
        return {
          success: true,
          message: "",
          data: [{ OWNER: "SBDEV", OBJECT_NAME: "P_REBUILD", OBJECT_TYPE: "PROCEDURE", OBJECT_STATUS: "VALID" }],
        };
      }
      return { success: false, message: "", data: [] };
    });

    await expect(loadFunctions({ config: { type: "oracle" } }, "SBDEV")).resolves.toEqual({
      supported: true,
      routines: [{
        displayName: "SBDEV.P_REBUILD [P]",
        routineName: "SBDEV.P_REBUILD",
        routineType: "PROCEDURE",
        objectStatus: "VALID",
      }],
    });
    await expect(loadDatabaseTriggers({ config: { type: "oracle" } }, "SBDEV")).resolves.toEqual({
      supported: true,
      triggers: [{
        displayName: "TRG_AUDIT (SBDEV.ORDERS)",
        triggerName: "TRG_AUDIT",
        tableName: "SBDEV.ORDERS",
        schemaName: "SBDEV",
        objectStatus: "INVALID",
      }],
    });
  });

  it("builds owner-scoped object queries for the selected Oracle schema", () => {
    expect(buildViewsMetadataQuerySpecs("oracle", "SBDEV").map((spec) => spec.sql)).toEqual([
      "SELECT OWNER AS schema_name, VIEW_NAME AS view_name FROM ALL_VIEWS WHERE OWNER = 'SBDEV' ORDER BY VIEW_NAME",
    ]);
    expect(buildFunctionsMetadataQuerySpecs("oracle", "SBDEV").map((spec) => spec.sql)).toEqual([
      "SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, OBJECT_TYPE AS routine_type, STATUS AS object_status FROM ALL_OBJECTS WHERE OWNER = 'SBDEV' AND OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_TYPE, OBJECT_NAME",
    ]);
    expect(buildSequencesMetadataQuerySpecs("oracle", "MYCIMLED").map((spec) => spec.sql)).toEqual([
      "SELECT OWNER AS schema_name, OBJECT_NAME AS sequence_name FROM ALL_OBJECTS WHERE OWNER = 'MYCIMLED' AND OBJECT_TYPE = 'SEQUENCE' ORDER BY OBJECT_NAME",
      "SELECT SEQUENCE_OWNER AS schema_name, SEQUENCE_NAME AS sequence_name FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = 'MYCIMLED' ORDER BY SEQUENCE_NAME",
    ]);
    expect(buildPackagesMetadataQuerySpecs("oracle", "MYCIMLED").map((spec) => spec.sql)).toEqual([
      "SELECT OWNER AS schema_name, OBJECT_NAME AS package_name FROM ALL_OBJECTS WHERE OWNER = 'MYCIMLED' AND OBJECT_TYPE = 'PACKAGE' ORDER BY OBJECT_NAME",
    ]);
  });

  it("loads and deduplicates Oracle sequences and packages", async () => {
    mockedDBQuery.mockImplementation(async (_config: unknown, _dbName: string, sql: string) => {
      if (sql.includes("ALL_SEQUENCES")) {
        return {
          success: true,
          message: "",
          data: [
            { schema_name: "MYCIMLED", sequence_name: "SEQ_PERSON_ID" },
            { SEQUENCE_OWNER: "MYCIMLED", SEQUENCE_NAME: "SEQ_PERSON_ID" },
          ],
        };
      }
      if (sql.includes("ALL_OBJECTS") && sql.includes("PACKAGE")) {
        return {
          success: true,
          message: "",
          data: [
            { schema_name: "MYCIMLED", package_name: "PKG_PERSON" },
            { OWNER: "MYCIMLED", OBJECT_NAME: "PKG_PERSON" },
          ],
        };
      }
      return { success: false, message: "", data: [] };
    });

    await expect(loadSequences({ config: { type: "oracle" } }, "MYCIMLED")).resolves.toEqual({
      supported: true,
      sequences: [
        {
          displayName: "MYCIMLED.SEQ_PERSON_ID",
          schemaName: "MYCIMLED",
          sequenceName: "MYCIMLED.SEQ_PERSON_ID",
        },
      ],
    });
    await expect(loadPackages({ config: { type: "oracle" } }, "MYCIMLED")).resolves.toEqual({
      supported: true,
      packages: [
        {
          displayName: "MYCIMLED.PKG_PERSON",
          packageName: "MYCIMLED.PKG_PERSON",
          schemaName: "MYCIMLED",
        },
      ],
    });
  });

  it("uses the selected owner catalog for OceanBase Oracle read-only connections", async () => {
    const executedSql: string[] = [];
    mockedDBQuery.mockImplementation(async (_config: unknown, _dbName: string, sql: string) => {
      executedSql.push(sql);
      if (sql.includes("ALL_VIEWS") && sql.includes("OWNER = 'SBDEV'")) {
        return {
          success: true,
          message: "",
          data: [{ OWNER: "SBDEV", VIEW_NAME: "V_RISK" }],
        };
      }
      if (sql.includes("ALL_OBJECTS") && sql.includes("('FUNCTION','PROCEDURE')")) {
        return {
          success: true,
          message: "",
          data: [{ OWNER: "SBDEV", OBJECT_NAME: "P_REFRESH", OBJECT_TYPE: "PROCEDURE" }],
        };
      }
      if (sql.includes("ALL_OBJECTS") && sql.includes("OBJECT_TYPE = 'SEQUENCE'")) {
        return {
          success: true,
          message: "",
          data: [{ OWNER: "SBDEV", OBJECT_NAME: "SEQ_RISK" }],
        };
      }
      return { success: false, message: "", data: [] };
    });

    const conn = { config: { type: "oceanbase", oceanBaseProtocol: "oracle" } };

    await expect(loadViews(conn, "SBDEV")).resolves.toEqual({
      supported: true,
      views: [{ schemaName: "SBDEV", viewName: "SBDEV.V_RISK" }],
    });
    await expect(loadFunctions(conn, "SBDEV")).resolves.toEqual({
      supported: true,
      routines: [{ displayName: "SBDEV.P_REFRESH [P]", routineName: "SBDEV.P_REFRESH", routineType: "PROCEDURE" }],
    });
    await expect(loadSequences(conn, "SBDEV")).resolves.toEqual({
      supported: true,
      sequences: [{ displayName: "SBDEV.SEQ_RISK", schemaName: "SBDEV", sequenceName: "SBDEV.SEQ_RISK" }],
    });

    expect(executedSql).toHaveLength(3);
    expect(executedSql).not.toContain(expect.stringContaining("USER_"));
    expect(executedSql).not.toContain(expect.stringContaining("ALL_SEQUENCES"));
  });
});

describe("Kingbase/PG routine metadata loaders", () => {
  it("builds multi-step function fallback queries for kingbase", () => {
    const specs = buildFunctionsMetadataQuerySpecs("kingbase", "ldf_server_dbs");
    expect(specs.length).toBeGreaterThanOrEqual(2);
    expect(specs[0]?.sql).toContain("pg_proc");
    expect(specs.some((spec) => spec.sql.includes("information_schema.routines"))).toBe(true);
  });

  it("does not stack the same kingbase function when multiple catalog fallbacks succeed", async () => {
    let queryCount = 0;
    mockedDBQuery.mockImplementation(async (_config: unknown, _dbName: string, sql: string) => {
      queryCount += 1;
      if (sql.includes("pg_proc") && sql.includes("prokind")) {
        return {
          success: true,
          message: "",
          data: [
            { schema_name: "ldf_server", routine_name: "p1", routine_type: "FUNCTION" },
            { schema_name: "ldf_server", routine_name: "p1", routine_type: "PROCEDURE" },
            { schema_name: "ldf_server", routine_name: "pk_zero_fn", routine_type: "FUNCTION" },
            // overload rows with same name/type must collapse
            { schema_name: "ldf_server", routine_name: "p1", routine_type: "FUNCTION" },
            { schema_name: "ldf_server", routine_name: "p1", routine_type: "FUNCTION" },
          ],
        };
      }
      if (sql.includes("information_schema.routines")) {
        return {
          success: true,
          message: "",
          data: [
            { schema_name: "ldf_server", routine_name: "p1", routine_type: "FUNCTION" },
            { schema_name: "ldf_server", routine_name: "p1", routine_type: "PROCEDURE" },
            { schema_name: "ldf_server", routine_name: "pk_zero_fn", routine_type: "FUNCTION" },
          ],
        };
      }
      if (sql.includes("pg_proc")) {
        return {
          success: true,
          message: "",
          data: [
            { schema_name: "ldf_server", routine_name: "p1", routine_type: "FUNCTION" },
            { schema_name: "ldf_server", routine_name: "p1", routine_type: "FUNCTION" },
            { schema_name: "ldf_server", routine_name: "pk_zero_fn", routine_type: "FUNCTION" },
          ],
        };
      }
      return { success: false, message: "", data: [] };
    });

    const result = await loadFunctions({ config: { type: "kingbase" } }, "ldf_server_dbs");

    expect(result.supported).toBe(true);
    // First full catalog success must short-circuit fallback queries.
    expect(queryCount).toBe(1);
    const p1Funcs = result.routines.filter((item) => item.routineName.toLowerCase().endsWith(".p1") && item.routineType === "FUNCTION");
    const p1Procs = result.routines.filter((item) => item.routineName.toLowerCase().endsWith(".p1") && item.routineType === "PROCEDURE");
    expect(p1Funcs).toHaveLength(1);
    expect(p1Procs).toHaveLength(1);
    expect(result.routines.filter((item) => item.routineName.toLowerCase().includes("pk_zero_fn"))).toHaveLength(1);
  });

  it("still collects complementary SHOW FUNCTION/PROCEDURE fallbacks for MySQL", async () => {
    mockedDBQuery.mockImplementation(async (_config: unknown, _dbName: string, sql: string) => {
      if (sql.includes("information_schema.routines")) {
        return { success: false, message: "no routines view", data: [] };
      }
      if (sql.includes("SHOW FUNCTION STATUS")) {
        return {
          success: true,
          message: "",
          data: [{ Db: "app", Name: "fn_a", Type: "FUNCTION" }],
        };
      }
      if (sql.includes("SHOW PROCEDURE STATUS")) {
        return {
          success: true,
          message: "",
          data: [{ Db: "app", Name: "sp_b", Type: "PROCEDURE" }],
        };
      }
      return { success: false, message: "", data: [] };
    });

    const result = await loadFunctions({ config: { type: "mysql" } }, "app");
    expect(result.supported).toBe(true);
    expect(result.routines.map((item) => `${item.routineType}:${item.routineName}`).sort()).toEqual([
      "FUNCTION:app.fn_a",
      "PROCEDURE:app.sp_b",
    ]);
  });
});
