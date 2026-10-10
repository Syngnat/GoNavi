import { DBQuery } from "../../../wailsjs/go/app/App";
import type { SavedConnection } from "../../types";
import { buildMetadataIdentityKey } from "../../utils/metadataIdentity";
import { getDataSourceCapabilities } from "../../utils/dataSourceCapabilities";
import { getDataSourceSpec } from "../../utils/dataSourceRegistry";
import { normalizeOracleObjectCompileStatus } from "./oracleObjectCompilation";
import {
  type MetadataLoadState,
  getMetadataDialect,
  getCaseInsensitiveValue,
  getFirstRowValue,
  splitQualifiedName,
  isIRISSystemSchemaName,
} from "./sidebarMetadataBasics";
import {
  buildFunctionsMetadataQuerySpecs,
  queryMetadataRowsBySpecs,
  buildSequencesMetadataQuerySpecs,
  buildPackagesMetadataQuerySpecs,
  buildEventsMetadataQuerySpecs,
  buildSchemasMetadataQuerySpecs,
} from "./sidebarMetadataQuerySpecs";
import { buildQualifiedName } from "./sidebarMetadataNames";

export const loadFunctions = async (
  conn: any,
  dbName: string,
): Promise<{
  routines: Array<{
    displayName: string;
    routineName: string;
    routineType: string;
    objectStatus?: string;
  }>;
} & MetadataLoadState> => {
  const dialect = getMetadataDialect(conn as SavedConnection);
  const querySpecs = buildFunctionsMetadataQuerySpecs(dialect, dbName, {
    excludeExtensionMembers: getDataSourceSpec(conn?.config?.type)?.ui?.hideExtensionRoutines === true,
  });
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const routines: Array<{
    displayName: string;
    routineName: string;
    routineType: string;
  }> = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const routineName = getCaseInsensitiveValue(row, [
        "routine_name",
        "object_name",
        "proname",
        "name",
      ]);
      if (!routineName) return;
      const schemaName = getCaseInsensitiveValue(row, [
        "schema_name",
        "nspname",
        "owner",
        "db",
        "database",
      ]);
      const rawType =
        getCaseInsensitiveValue(row, ["routine_type", "object_type", "type"]) ||
        queryResult.inferredType ||
        "FUNCTION";
      const normalizedType = rawType.toUpperCase().includes("PROC")
        ? "PROCEDURE"
        : "FUNCTION";
      const fullName = buildQualifiedName(schemaName, routineName);
      const uniqueKey = buildMetadataIdentityKey(
        dialect,
        fullName,
        normalizedType,
      );
      if (!fullName || seen.has(uniqueKey)) return;
      seen.add(uniqueKey);
      const typeLabel = normalizedType === "PROCEDURE" ? "P" : "F";
      const objectStatus = dialect === "oracle"
        ? normalizeOracleObjectCompileStatus(getCaseInsensitiveValue(row, ["object_status"]))
        : "";
      routines.push({
        displayName: `${fullName} [${typeLabel}]`,
        routineName: fullName,
        routineType: normalizedType,
        ...(objectStatus ? { objectStatus } : {}),
      });
    });
  });
  return { routines, supported: hasSuccessfulQuery, failureMessage };
};

export const loadSequences = async (
  conn: any,
  dbName: string,
): Promise<{
  sequences: Array<{
    displayName: string;
    sequenceName: string;
    schemaName: string;
  }>;
} & MetadataLoadState> => {
  const dialect = getMetadataDialect(conn as SavedConnection);
  const querySpecs = buildSequencesMetadataQuerySpecs(dialect, dbName);
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const sequences: Array<{
    displayName: string;
    sequenceName: string;
    schemaName: string;
  }> = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const rawSequenceName =
        getCaseInsensitiveValue(row, [
          "sequence_name",
          "sequencename",
          "object_name",
          "name",
        ]) || getFirstRowValue(row);
      if (!rawSequenceName) return;

      const sequenceParts = splitQualifiedName(rawSequenceName);
      const schemaName = (
        getCaseInsensitiveValue(row, [
          "schema_name",
          "sequence_owner",
          "owner",
        ]) ||
        sequenceParts.schemaName ||
        ""
      ).trim();
      const objectName = (sequenceParts.objectName || rawSequenceName).trim();
      const fullName = buildQualifiedName(schemaName, objectName);
      const uniqueKey = buildMetadataIdentityKey(
        dialect,
        schemaName,
        objectName,
      );
      if (!fullName || seen.has(uniqueKey)) return;
      seen.add(uniqueKey);
      sequences.push({
        displayName: fullName,
        sequenceName: fullName,
        schemaName,
      });
    });
  });
  return { sequences, supported: hasSuccessfulQuery, failureMessage };
};

export const loadPackages = async (
  conn: any,
  dbName: string,
): Promise<{
  packages: Array<{
    displayName: string;
    packageName: string;
    schemaName: string;
  }>;
} & MetadataLoadState> => {
  const dialect = getMetadataDialect(conn as SavedConnection);
  const querySpecs = buildPackagesMetadataQuerySpecs(dialect, dbName);
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const packages: Array<{
    displayName: string;
    packageName: string;
    schemaName: string;
  }> = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const rawPackageName =
        getCaseInsensitiveValue(row, [
          "package_name",
          "packagename",
          "object_name",
          "name",
        ]) || getFirstRowValue(row);
      if (!rawPackageName) return;

      const packageParts = splitQualifiedName(rawPackageName);
      const schemaName = (
        getCaseInsensitiveValue(row, [
          "schema_name",
          "owner",
        ]) ||
        packageParts.schemaName ||
        ""
      ).trim();
      const objectName = (packageParts.objectName || rawPackageName).trim();
      const fullName = buildQualifiedName(schemaName, objectName);
      const uniqueKey = buildMetadataIdentityKey(
        dialect,
        schemaName,
        objectName,
      );
      if (!fullName || seen.has(uniqueKey)) return;
      seen.add(uniqueKey);
      packages.push({
        displayName: fullName,
        packageName: fullName,
        schemaName,
      });
    });
  });
  return { packages, supported: hasSuccessfulQuery, failureMessage };
};

export const loadDatabaseEvents = async (
  conn: any,
  dbName: string,
): Promise<{
  events: Array<{
    displayName: string;
    eventName: string;
    schemaName: string;
    eventType: string;
    status: string;
  }>;
} & MetadataLoadState> => {
  const dialect = getMetadataDialect(conn as SavedConnection);
  const querySpecs = buildEventsMetadataQuerySpecs(dialect, dbName);
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const events: Array<{
    displayName: string;
    eventName: string;
    schemaName: string;
    eventType: string;
    status: string;
  }> = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const rawEventName = getCaseInsensitiveValue(row, [
        "event_name",
        "eventname",
        "name",
        "event",
      ]);
      if (!rawEventName) return;

      const rawSchemaName = getCaseInsensitiveValue(row, [
        "schema_name",
        "event_schema",
        "db",
        "database",
      ]);
      const parsed = splitQualifiedName(rawEventName);
      const schemaName = (rawSchemaName || parsed.schemaName || dbName).trim();
      const eventName = (parsed.objectName || rawEventName).trim();
      if (!eventName) return;

      const uniqueKey = buildMetadataIdentityKey(
        dialect,
        schemaName,
        eventName,
      );
      if (seen.has(uniqueKey)) return;
      seen.add(uniqueKey);

      const eventType = getCaseInsensitiveValue(row, ["event_type", "type"]);
      const status = getCaseInsensitiveValue(row, ["status"]);
      events.push({
        displayName: eventName,
        eventName,
        schemaName,
        eventType,
        status,
      });
    });
  });

  return { events, supported: hasSuccessfulQuery, failureMessage };
};

export const loadSchemas = async (conn: any, dbName: string, query = DBQuery, respectVisibility = false): Promise<{ schemas: string[] } & MetadataLoadState> => {
  const savedConnection = conn as SavedConnection;
  const dialect = getMetadataDialect(savedConnection);
  const querySpecs = buildSchemasMetadataQuerySpecs(dialect, dbName);
  const caseSensitive = getDataSourceCapabilities(savedConnection.config)
    .schemaIdentifierCaseSensitive;
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
    query,
    respectVisibility,
  );
  const seen = new Set<string>();
  const schemas: string[] = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const schemaName =
        getCaseInsensitiveValue(row, [
          "schema_name",
          "nspname",
          "schemaname",
        ]) || getFirstRowValue(row);
      if (!schemaName) return;
      if (dialect === "iris" && isIRISSystemSchemaName(schemaName)) return;
      const key = caseSensitive ? schemaName : schemaName.toLocaleLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      schemas.push(schemaName);
    });
  });

  return { schemas, supported: hasSuccessfulQuery, failureMessage };
};
