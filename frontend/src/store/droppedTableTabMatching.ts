import type { TabData } from "../types";
import { splitQualifiedNameSegmentsDetailed } from "../utils/qualifiedName";

export interface DroppedTableTabTarget {
  connectionId: string;
  dbName: string;
  tableNames: string[];
  schemaName?: string;
}

type ParsedTableName = {
  full: string;
  objectName: string;
  qualifier: string;
};

const normalizeText = (value: unknown): string => String(value ?? "").trim();

const parseTableName = (value: unknown): ParsedTableName => {
  const source = normalizeText(value);
  if (!source) return { full: "", objectName: "", qualifier: "" };
  const segments = splitQualifiedNameSegmentsDetailed(source, "");
  if (segments.length === 0) {
    return { full: source, objectName: source, qualifier: "" };
  }
  return {
    full: segments.map((segment) => segment.value).join("."),
    objectName: segments[segments.length - 1]?.value || source,
    qualifier: segments.length > 1
      ? segments.slice(0, -1).map((segment) => segment.value).join(".")
      : "",
  };
};

const valuesEqual = (
  left: unknown,
  right: unknown,
  caseInsensitive: boolean,
): boolean => {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return caseInsensitive
    ? normalizedLeft.localeCompare(normalizedRight, undefined, { sensitivity: "accent" }) === 0
    : normalizedLeft === normalizedRight;
};

const scopeMatches = (
  tab: TabData,
  parsedTab: ParsedTableName,
  target: DroppedTableTabTarget,
  parsedTarget: ParsedTableName,
  useParsedTargetQualifier: boolean,
  useParsedTabQualifier: boolean,
  caseInsensitive: boolean,
): boolean => {
  if (useParsedTargetQualifier && parsedTarget.qualifier) {
    const qualifierMatches = [
      parsedTab.qualifier,
      tab.schemaName,
      tab.dbName,
    ].some((value) => valuesEqual(value, parsedTarget.qualifier, caseInsensitive));
    if (!qualifierMatches) return false;
    const targetDbName = normalizeText(target.dbName);
    return !targetDbName
      || valuesEqual(tab.dbName, targetDbName, caseInsensitive)
      || valuesEqual(tab.schemaName, targetDbName, caseInsensitive);
  }

  const targetSchema = normalizeText(target.schemaName);
  const targetDbName = normalizeText(target.dbName);
  if (targetSchema) {
    const tabSchema = normalizeText(tab.schemaName)
      || (useParsedTabQualifier ? parsedTab.qualifier : "");
    if (tabSchema) {
      if (!valuesEqual(tabSchema, targetSchema, caseInsensitive)) return false;
      return !targetDbName
        || valuesEqual(tab.dbName, targetDbName, caseInsensitive)
        || valuesEqual(tab.schemaName, targetDbName, caseInsensitive);
    }
    return Boolean(targetDbName)
      && valuesEqual(tab.dbName, targetDbName, caseInsensitive);
  }

  if (!targetDbName) return true;
  return valuesEqual(tab.dbName, targetDbName, caseInsensitive)
    || valuesEqual(tab.schemaName, targetDbName, caseInsensitive)
    || valuesEqual(parsedTab.qualifier, targetDbName, caseInsensitive);
};

const matchesDroppedTable = (
  tab: TabData,
  target: DroppedTableTabTarget,
  tableName: string,
  caseInsensitive: boolean,
): boolean => {
  const parsedTab = parseTableName(tab.tableName);
  const parsedTarget = parseTableName(tableName);
  if (!parsedTarget.objectName) return false;

  const exactFullName = valuesEqual(parsedTab.full, parsedTarget.full, caseInsensitive);
  if (
    !exactFullName
    && !valuesEqual(parsedTab.objectName, parsedTarget.objectName, caseInsensitive)
  ) {
    return false;
  }

  return scopeMatches(
    tab,
    parsedTab,
    target,
    parsedTarget,
    !exactFullName && Boolean(parsedTarget.qualifier),
    !exactFullName,
    caseInsensitive,
  );
};

export const resolveDroppedTableTabIds = (
  tabs: TabData[],
  target: DroppedTableTabTarget,
): string[] => {
  const connectionId = normalizeText(target.connectionId);
  const tableNames = (Array.isArray(target.tableNames) ? target.tableNames : [])
    .map(normalizeText)
    .filter(Boolean);
  if (!connectionId || tableNames.length === 0) return [];

  const candidates = tabs.filter((tab) => (
    tab.type === "table"
    && tab.objectType !== "view"
    && tab.objectType !== "materialized-view"
    && normalizeText(tab.connectionId) === connectionId
  ));
  const droppedTabIds = new Set<string>();

  for (const tableName of tableNames) {
    const exactMatches = candidates.filter((tab) => (
      matchesDroppedTable(tab, target, tableName, false)
    ));
    if (exactMatches.length > 0) {
      exactMatches.forEach((tab) => droppedTabIds.add(tab.id));
      continue;
    }

    const foldedMatches = candidates.filter((tab) => (
      matchesDroppedTable(tab, target, tableName, true)
    ));
    // 大小写不敏感只作为兜底，且多候选时不猜，避免在区分大小写的库里关错表。
    if (foldedMatches.length === 1) {
      droppedTabIds.add(foldedMatches[0].id);
    }
  }

  return Array.from(droppedTabIds);
};
