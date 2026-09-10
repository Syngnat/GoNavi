import { describe, expect, it } from "vitest";

import {
  buildDataSyncMappingsFromSelection,
  createDataSyncTableMapping,
  migrationAllowTargetCreate,
  repairMigrationTargetModes,
  clearDataSyncTargetModeExplicitMarks,
  type DataSyncObjectMetadata,
  type DataSyncRouteCapability,
  type DataSyncTableMapping,
} from "./model";

// 一次性迁移（kind=migration）在能力快照返回前就选表时，targetMode 不得被
// 永久错定为 existing_only——否则后端预检会报 target_table_missing，
// 用户被迫手工建表。能力未就绪时必须推迟判定，就绪后自修复。
describe("buildDataSyncMappingsFromSelection capability timing", () => {
  const targetObjects: DataSyncObjectMetadata[] = [
    { name: "archive", kind: "table" },
  ];

  it("deferred capability (unknown) must not lock migration mappings to existing_only", () => {
    const unknownCapabilityMappings = buildDataSyncMappingsFromSelection({
      taskId: "migration-timing",
      taskKind: "migration",
      sourceNames: ["customers"],
      targetObjects,
      existingMappings: [],
      allowTargetCreate: undefined,
    });

    // 能力未知时选表：迁移任务必须给出可建表的映射，或推迟判定。
    // 一旦定为 existing_only，能力返回后没有任何自动翻转路径。
    expect(unknownCapabilityMappings[0].targetMode).toBe("create_or_reuse");

    // 对照：能力就绪后的行为保持不变。
    const resolvedMappings = buildDataSyncMappingsFromSelection({
      taskId: "migration-timing",
      taskKind: "migration",
      sourceNames: ["customers"],
      targetObjects,
      existingMappings: [],
      allowTargetCreate: true,
    });
    expect(resolvedMappings[0].targetMode).toBe("create_or_reuse");

    // 对照：显式不允许建表（能力返回 false）时必须 existing_only。
    const deniedMappings: DataSyncTableMapping[] =
      buildDataSyncMappingsFromSelection({
        taskId: "migration-timing",
        taskKind: "migration",
        sourceNames: ["customers"],
        targetObjects,
        existingMappings: [],
        allowTargetCreate: false,
      });
    expect(deniedMappings[0].targetMode).toBe("existing_only");
  });
});

describe("migrationAllowTargetCreate", () => {
  const base: DataSyncRouteCapability = {
    level: "partial",
    canExecute: true,
    supportsAutoCreate: true,
    supportsCdc: false,
  };

  it("returns undefined while the capability snapshot is unknown", () => {
    expect(
      migrationAllowTargetCreate("migration", {
        ...base,
        level: "unknown",
        canExecute: false,
        supportsAutoCreate: false,
      }),
    ).toBeUndefined();
  });

  it("returns true for an executable auto-create route", () => {
    expect(migrationAllowTargetCreate("migration", base)).toBe(true);
  });

  it("returns false when auto-create is unsupported or non-migration", () => {
    expect(
      migrationAllowTargetCreate("migration", {
        ...base,
        supportsAutoCreate: false,
      }),
    ).toBe(false);
    expect(
      migrationAllowTargetCreate("migration", {
        ...base,
        requiresExistingTarget: true,
      }),
    ).toBe(false);
    expect(migrationAllowTargetCreate("reconcile", base)).toBe(false);
  });
});

describe("repairMigrationTargetModes", () => {
  const autoCreate: DataSyncRouteCapability = {
    level: "partial",
    canExecute: true,
    supportsAutoCreate: true,
    supportsCdc: false,
  };
  const targetObjects: DataSyncObjectMetadata[] = [
    { name: "archive", kind: "table" },
    { name: "customers", kind: "table" },
  ];

  it("promotes an existing_only mapping whose target table is missing once auto-create resolves", () => {
    const legacy: DataSyncTableMapping[] = [
      createDataSyncTableMapping("m1", "customers", "customers"),
    ];
    const repaired = repairMigrationTargetModes(
      legacy,
      "migration",
      autoCreate,
      [{ name: "archive", kind: "table" }],
      true,
    );
    expect(repaired[0].targetMode).toBe("create_or_reuse");
  });

  it("preserves a user-selected existing_only mode while repairing other mappings", () => {
    const mappings: DataSyncTableMapping[] = [
      createDataSyncTableMapping("manual", "manual_source", "manual_target"),
      createDataSyncTableMapping("automatic", "automatic_source", "automatic_target"),
    ];
    const repaired = repairMigrationTargetModes(
      mappings,
      "migration",
      autoCreate,
      [],
      true,
      new Set(["manual"]),
    );
    expect(repaired[0].targetMode).toBe("existing_only");
    expect(repaired[1].targetMode).toBe("create_or_reuse");
  });

  it("preserves an explicit mode restored from persisted task data", () => {
    const mappings: DataSyncTableMapping[] = [
      {
        ...createDataSyncTableMapping("persisted", "source", "target"),
        targetMode: "existing_only",
        targetModeExplicit: true,
      },
    ];
    const repaired = repairMigrationTargetModes(
      mappings,
      "migration",
      autoCreate,
      [],
      true,
    );
    expect(repaired).toBe(mappings);
    expect(repaired[0].targetMode).toBe("existing_only");
  });

  it("never promotes a mapping whose target table already exists", () => {
    const existing: DataSyncTableMapping[] = [
      createDataSyncTableMapping("m1", "customers", "customers"),
    ];
    const repaired = repairMigrationTargetModes(
      existing,
      "migration",
      autoCreate,
      targetObjects,
      true,
    );
    expect(repaired).toBe(existing);
    expect(repaired[0].targetMode).toBe("existing_only");
  });

  it("matches schema-qualified mappings against base-name metadata", () => {
    const existing: DataSyncTableMapping[] = [
      createDataSyncTableMapping("m1", "customers", "customers"),
    ];
    const repaired = repairMigrationTargetModes(
      existing,
      "migration",
      autoCreate,
      [{ name: "customers", kind: "table" }],
      true,
    );
    expect(repaired).toBe(existing);
    expect(repaired[0].targetMode).toBe("existing_only");
  });

  it("does not promote an ambiguous base-name match", () => {
    const existing: DataSyncTableMapping[] = [
      createDataSyncTableMapping("m1", "customers", "customers"),
    ];
    const repaired = repairMigrationTargetModes(
      existing,
      "migration",
      autoCreate,
      [
        { name: "source.customers", kind: "table" },
        { name: "other.customers", kind: "table" },
      ],
      true,
    );
    expect(repaired).toBe(existing);
    expect(repaired[0].targetMode).toBe("existing_only");
  });

  it("does not treat a different qualified schema as the mapped target", () => {
    const missing: DataSyncTableMapping[] = [
      createDataSyncTableMapping("m1", "source.customers", "ods.customers"),
    ];
    const repaired = repairMigrationTargetModes(
      missing,
      "migration",
      autoCreate,
      [{ name: "other.customers", kind: "table" }],
      true,
    );
    expect(repaired[0].targetMode).toBe("create_or_reuse");
  });

  it("demotes create_or_reuse mappings when the resolved capability denies auto-create", () => {
    const optimistic: DataSyncTableMapping[] = [
      {
        ...createDataSyncTableMapping("m1", "customers", "customers"),
        targetMode: "create_or_reuse",
      },
    ];
    const repaired = repairMigrationTargetModes(
      optimistic,
      "migration",
      { ...autoCreate, supportsAutoCreate: false },
      [],
      true,
    );
    expect(repaired[0].targetMode).toBe("existing_only");
  });

  it("allows a safety-demoted explicit create mode to recover when support returns", () => {
    const optimistic: DataSyncTableMapping[] = [
      {
        ...createDataSyncTableMapping("m1", "customers", "customers"),
        targetMode: "create_or_reuse",
        targetModeExplicit: true,
      },
    ];
    const demoted = repairMigrationTargetModes(
      optimistic,
      "migration",
      { ...autoCreate, supportsAutoCreate: false },
      [],
      true,
    );
    expect(demoted[0]).toMatchObject({ targetMode: "existing_only" });
    expect(demoted[0].targetModeExplicit).toBeUndefined();
    expect(
      repairMigrationTargetModes(demoted, "migration", autoCreate, [], true)[0]
        .targetMode,
    ).toBe("create_or_reuse");
  });

  it("does nothing while the capability is unknown or metadata is not ready", () => {
    const legacy: DataSyncTableMapping[] = [
      createDataSyncTableMapping("m1", "customers", "customers"),
    ];
    expect(
      repairMigrationTargetModes(
        legacy,
        "migration",
        { ...autoCreate, level: "unknown" },
        [],
        true,
      ),
    ).toBe(legacy);
    expect(
      repairMigrationTargetModes(legacy, "migration", autoCreate, [], false),
    ).toBe(legacy);
  });
});

describe("clearDataSyncTargetModeExplicitMarks", () => {
  it("clears only persisted user-choice markers when endpoints change", () => {
    const mappings: DataSyncTableMapping[] = [
      {
        ...createDataSyncTableMapping("manual", "source", "target"),
        targetModeExplicit: true,
      },
      createDataSyncTableMapping("automatic", "source2", "target2"),
    ];
    const cleared = clearDataSyncTargetModeExplicitMarks(mappings);
    expect(cleared[0].targetModeExplicit).toBeUndefined();
    expect(cleared[1]).toBe(mappings[1]);
    expect(clearDataSyncTargetModeExplicitMarks(cleared)).toBe(cleared);
  });
});
