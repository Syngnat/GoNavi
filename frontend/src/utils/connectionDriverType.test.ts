import { describe, expect, it } from "vitest";

import {
  isPostgresSchemaDialect,
  normalizeDriverType,
  resolveConnectionDriverType,
  resolveSavedConnectionDriverType,
  supportsIndependentSchemaSelection,
} from "./connectionDriverType";

describe("connectionDriverType", () => {
  it("normalizes built-in driver aliases shared by connection modal and sidebar", () => {
    expect(normalizeDriverType("postgresql")).toBe("postgres");
    expect(normalizeDriverType("pgx")).toBe("postgres");
    expect(normalizeDriverType("elastic")).toBe("elasticsearch");
    expect(normalizeDriverType("chromadb")).toBe("chroma");
    expect(normalizeDriverType("chroma-db")).toBe("chroma");
    expect(normalizeDriverType("qdrantdb")).toBe("qdrant");
    expect(normalizeDriverType("qdrant-db")).toBe("qdrant");
    expect(normalizeDriverType("milvusdb")).toBe("milvus");
    expect(normalizeDriverType("milvus-db")).toBe("milvus");
    expect(normalizeDriverType("apache-iotdb")).toBe("iotdb");
    expect(normalizeDriverType("apache_iotdb")).toBe("iotdb");
    expect(normalizeDriverType("apache-kafka")).toBe("kafka");
    expect(normalizeDriverType("apache_kafka")).toBe("kafka");
    expect(normalizeDriverType("doris")).toBe("diros");
    expect(normalizeDriverType("open-gauss")).toBe("opengauss");
    expect(normalizeDriverType("gauss-db")).toBe("gaussdb");
    expect(normalizeDriverType("greatdb")).toBe("goldendb");
    expect(normalizeDriverType("gdb")).toBe("goldendb");
    expect(normalizeDriverType("InterSystemsIRIS")).toBe("iris");
    expect(normalizeDriverType("InterSystems-Cache")).toBe("cache");
    expect(normalizeDriverType("InterSystems Caché")).toBe("cache");
    expect(normalizeDriverType("Caché")).toBe("cache");
    expect(normalizeDriverType("CacheDB")).toBe("cache");
  });

  it("resolves custom connection driver types from the selected driver field", () => {
    expect(resolveConnectionDriverType("mysql", "postgresql")).toBe("mysql");
    expect(resolveConnectionDriverType("custom", "postgresql")).toBe(
      "postgres",
    );
    expect(resolveConnectionDriverType("custom", "open_gauss")).toBe(
      "opengauss",
    );
    expect(resolveConnectionDriverType("custom", "gauss_db")).toBe("gaussdb");
    expect(resolveConnectionDriverType("custom", "goldendb")).toBe("goldendb");
    expect(resolveConnectionDriverType("custom", "ClickHouse")).toBe(
      "clickhouse",
    );
    expect(resolveConnectionDriverType("custom", "")).toBe("");
  });

  it("resolves saved custom connections using the same driver aliases", () => {
    const conn = {
      config: {
        type: "custom",
        driver: "pg",
      },
    } as any;
    expect(resolveSavedConnectionDriverType(conn)).toBe("postgres");
  });

  it("detects postgres-compatible schema dialects", () => {
    expect(isPostgresSchemaDialect("postgres")).toBe(true);
    expect(isPostgresSchemaDialect("kingbase")).toBe(true);
    expect(isPostgresSchemaDialect("open-gauss")).toBe(true);
    expect(isPostgresSchemaDialect("gauss-db")).toBe(true);
    expect(isPostgresSchemaDialect("mysql")).toBe(false);
  });

  it("detects dialects that need independent schema selection", () => {
    expect(supportsIndependentSchemaSelection("postgres")).toBe(true);
    expect(supportsIndependentSchemaSelection("sqlserver")).toBe(true);
    expect(supportsIndependentSchemaSelection("iris")).toBe(true);
    expect(supportsIndependentSchemaSelection("cache")).toBe(true);
    expect(supportsIndependentSchemaSelection("intersystems-cache")).toBe(true);
    expect(supportsIndependentSchemaSelection("duckdb")).toBe(true);
    expect(supportsIndependentSchemaSelection("oracle")).toBe(false);
    expect(supportsIndependentSchemaSelection("mysql")).toBe(false);
  });
});
