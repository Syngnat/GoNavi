import { resolveSqlDialect, isPgLikeDialect } from '../../utils/sqlDialect';
import { buildMetadataIdentityKey } from '../../utils/metadataIdentity';
import { splitQualifiedNameSegmentsDetailed } from '../../utils/qualifiedName';
import { buildQueryEditorNavigationTableMetas } from './queryEditorNavigationTableMetas';
import {
    buildQueryEditorNamedObjectMetas,
    buildQueryEditorTriggerObjectMetas,
    buildQueryEditorRoutineObjectMetas,
} from './queryEditorNamedObjectMetas';
import type {
    CompletionTableMeta,
    CompletionViewMeta,
    CompletionTriggerMeta,
    CompletionRoutineMeta,
    CompletionSequenceMeta,
    CompletionPackageMeta,
} from './queryEditorCompletionCandidates';
import {
    type QueryEditorNavigationTarget,
    splitQueryIdentifierPathSegments,
    type QueryIdentifierPathSegment,
} from './queryEditorIdentifierPaths';
import {
    findIdentifierWindowAtOffset,
    findQualifiedIdentifierWindowAtOffset,
    maskQueryEditorSqlLiteralsAndComments,
    isQueryEditorTableSourcePrefix,
} from './queryEditorSqlScan';
import {
    normalizeQueryEditorHoverIdentifier,
    normalizeNavigationIdentifierParts,
    matchesQueryEditorIdentifierSegment,
    matchesQueryEditorMetadataTablePath,
} from './queryEditorReferenceIdentity';
import {
    usesQueryEditorSchemaQualifiedTwoPartNames,
    QUERY_EDITOR_COMMON_SCHEMA_NAME_SET,
} from './queryEditorExecutionContext';

export const resolveQueryEditorNavigationTarget = (
    lineContent: string,
    column: number,
    currentDb: string,
    visibleDbs: string[],
    tables: CompletionTableMeta[],
    views: CompletionViewMeta[] = [],
    materializedViews: CompletionViewMeta[] = [],
    triggers: CompletionTriggerMeta[] = [],
    routines: CompletionRoutineMeta[] = [],
    sequences: CompletionSequenceMeta[] = [],
    packages: CompletionPackageMeta[] = [],
    tableSourceContext = false,
    documentContext?: { text: string; offset: number },
    currentSchema = '',
    dialect = '',
): QueryEditorNavigationTarget | null => {
    const text = String(lineContent || '');
    const offset = Math.max(0, Number(column || 1) - 2);
    const windowRange = findIdentifierWindowAtOffset(text, offset, true, dialect);

    // 默认按单行解析；提供全文上下文时改用全文窗口，限定名拆行后仍能取到库名/Schema 前缀
    const documentText = String(documentContext?.text || '');
    const documentOffset = Number(documentContext?.offset);
    const documentWindow = documentText && Number.isFinite(documentOffset)
        ? findQualifiedIdentifierWindowAtOffset(documentText, documentOffset, true, dialect)
        : null;
    if (!windowRange && !documentWindow) return null;
    const prefixSliceStart = documentWindow ? documentWindow.start : windowRange!.start;
    const rawIdentifier = normalizeQueryEditorHoverIdentifier(documentWindow
        ? documentText.slice(documentWindow.start, documentWindow.end).trim()
        : text.slice(windowRange!.start, windowRange!.end).trim());
    if (!rawIdentifier) return null;

    const parts = normalizeNavigationIdentifierParts(rawIdentifier, dialect);
    if (parts.length === 0) return null;

    const currentDbName = String(currentDb || '').trim();
    const currentSchemaName = String(currentSchema || '').trim();
    const connectionScopedDialect = resolveSqlDialect(dialect) === 'sqlite';
    const schemaQualifiedTwoPartDialect = usesQueryEditorSchemaQualifiedTwoPartNames(dialect);
    const pgLikeIdentifierResolution = isPgLikeDialect(dialect);
    const visibleDbSet = new Set(
        visibleDbs
            .map((db) => buildMetadataIdentityKey(dialect, db))
            .filter(Boolean),
    );
    const tableMetas = buildQueryEditorNavigationTableMetas(
        tables,
        dialect,
        connectionScopedDialect,
    );

    const rawIdentifierSegments = splitQueryIdentifierPathSegments(rawIdentifier, dialect);
    // A single delimited segment such as `order.items` or [order.items] is
    // one literal object name. Catalog metadata often returns that name
    // without delimiters, where a generic sidebar parser would incorrectly
    // reclassify its first word as a schema.
    const singleQuotedDottedTableIdentifier = rawIdentifierSegments.length === 1
        && rawIdentifierSegments[0].quoted
        && String(rawIdentifierSegments[0].value || '').includes('.');
    const matchesSingleQuotedDottedTableIdentifier = (meta: typeof tableMetas[number]): boolean => {
        if (!singleQuotedDottedTableIdentifier) return false;
        const querySegment = rawIdentifierSegments[0];
        const rawMetadataName = String(meta.rawTableName || '').trim();
        if (matchesQueryEditorIdentifierSegment(querySegment, rawMetadataName, dialect)) {
            return true;
        }
        const metadataSegments = splitQualifiedNameSegmentsDetailed(rawMetadataName, dialect);
        if (metadataSegments.length === 1) {
            return matchesQueryEditorIdentifierSegment(querySegment, metadataSegments[0].value, dialect);
        }
        // SQL Server resolves an unqualified table against dbo. Its metadata
        // formatter preserves the schema when a table name contains a dot.
        return resolveSqlDialect(dialect) === 'sqlserver'
            && metadataSegments.length === 2
            && String(metadataSegments[0].value || '').trim().toLowerCase() === 'dbo'
            && matchesQueryEditorIdentifierSegment(
                querySegment,
                metadataSegments[1].value,
                dialect,
            );
    };
    const buildTableNavigationTarget = (meta: typeof tableMetas[number]): QueryEditorNavigationTarget => {
        const literalDottedName = matchesSingleQuotedDottedTableIdentifier(meta);
        return {
            type: 'table',
            dbName: meta.dbName,
            tableName: meta.rawTableName,
            schemaName: literalDottedName ? undefined : meta.schemaName || undefined,
            ...(literalDottedName ? { lookupTableName: rawIdentifierSegments[0].raw } : {}),
        };
    };
    const isLegacySQLiteDottedTableReference = connectionScopedDialect
        && rawIdentifierSegments.length === 2
        && rawIdentifierSegments[1].quoted
        && String(rawIdentifierSegments[1].value || '').includes('.')
        && String(rawIdentifierSegments[0].value || '').trim().toLowerCase()
            === String(rawIdentifierSegments[1].value || '').trim().split('.', 1)[0].toLowerCase()
        && !visibleDbs.some((dbName) => buildMetadataIdentityKey(dialect, dbName)
            === buildMetadataIdentityKey(dialect, rawIdentifierSegments[0].value));
    if (isLegacySQLiteDottedTableReference) {
        return {
            type: 'table',
            dbName: currentDbName,
            tableName: rawIdentifierSegments[1].value,
            schemaName: undefined,
        };
    }
    const findExactPostgresTable = (): typeof tableMetas[number] | undefined => {
        if (!pgLikeIdentifierResolution || rawIdentifierSegments.length === 0) return undefined;
        const queryObjectSegment = rawIdentifierSegments[rawIdentifierSegments.length - 1];
        const currentSchemaSegments = currentSchemaName
            ? splitQueryIdentifierPathSegments(currentSchemaName, dialect)
            : [];
        const candidates: Array<{
            dbName: string;
            schemaSegments?: QueryIdentifierPathSegment[];
        }> = [];

        if (parts.length === 1) {
            candidates.push({
                dbName: currentDbName,
                schemaSegments: currentSchemaSegments.length > 0 ? currentSchemaSegments : undefined,
            });
        } else if (parts.length === 2) {
            const firstSegment = rawIdentifierSegments[0];
            if (schemaQualifiedTwoPartDialect) {
                candidates.push({ dbName: currentDbName, schemaSegments: [firstSegment] });
            } else if (visibleDbSet.has(buildMetadataIdentityKey(dialect, firstSegment.value))) {
                candidates.push({ dbName: firstSegment.value });
            } else {
                candidates.push({ dbName: currentDbName, schemaSegments: [firstSegment] });
                candidates.push({ dbName: firstSegment.value });
            }
        } else if (parts.length === 3) {
            candidates.push({
                dbName: rawIdentifierSegments[0].value,
                schemaSegments: [rawIdentifierSegments[1]],
            });
        }

        for (const candidate of candidates) {
            const candidateDbKey = buildMetadataIdentityKey(dialect, candidate.dbName);
            const matched = tableMetas.find((meta) => (
                meta.metadataDbKey === candidateDbKey
                && matchesQueryEditorMetadataTablePath(
                    queryObjectSegment,
                    candidate.schemaSegments,
                    meta.identifierSegments,
                    dialect,
                )
            ));
            if (matched) return matched;
        }
        return undefined;
    };

    const exactPostgresTable = findExactPostgresTable();
    if (exactPostgresTable) {
        return {
            type: 'table',
            dbName: exactPostgresTable.dbName,
            tableName: exactPostgresTable.rawTableName,
            schemaName: exactPostgresTable.schemaName || undefined,
        };
    }

    const normalizedIdentifier = parts.join('.').toLowerCase();
    const directTable = !pgLikeIdentifierResolution && parts.length >= 2
        ? tableMetas.find((meta) => {
            const matchesCurrentQualifiedName = meta.normalizedDbName === currentDbName.toLowerCase()
                && normalizedIdentifier === meta.normalizedRawTableName;
            if (parts.length === 2 && schemaQualifiedTwoPartDialect) {
                return matchesCurrentQualifiedName;
            }
            return normalizedIdentifier === `${meta.normalizedDbName}.${meta.normalizedObjectName}`
                || normalizedIdentifier === `${meta.normalizedDbName}.${meta.normalizedRawTableName}`
                || matchesCurrentQualifiedName;
        })
        : undefined;
    if (directTable) {
        return buildTableNavigationTarget(directTable);
    }
    if (parts.length > 3) return null;

    // Normalized once per catalog snapshot rather than once per identifier candidate:
    // non-table objects outnumber tables in large schemas and dominated the input path.
    const viewMetas = buildQueryEditorNamedObjectMetas(views, 'viewName', dialect);
    const materializedViewMetas = buildQueryEditorNamedObjectMetas(materializedViews, 'viewName', dialect);
    const triggerMetas = buildQueryEditorTriggerObjectMetas(triggers, dialect);
    const routineMetas = buildQueryEditorRoutineObjectMetas(routines, dialect);
    const sequenceMetas = buildQueryEditorNamedObjectMetas(sequences, 'sequenceName', dialect);
    const packageMetas = buildQueryEditorNamedObjectMetas(packages, 'packageName', dialect);

    const findTable = (candidateDbName: string, candidateTableName: string, schemaName = ''): QueryEditorNavigationTarget | null => {
        const normalizedDbName = String(candidateDbName || '').trim().toLowerCase();
        const normalizedTableName = String(candidateTableName || '').trim().toLowerCase();
        const normalizedSchemaName = String(schemaName || '').trim().toLowerCase();
        // Connection-scoped sources (for example SQLite) legitimately use an
        // empty database name. Keep the table-name guard independent from the
        // database scope so their metadata can still resolve.
        if (!normalizedTableName) return null;

        if (pgLikeIdentifierResolution && rawIdentifierSegments.length > 0) {
            const queryObjectSegment = rawIdentifierSegments[rawIdentifierSegments.length - 1];
            const querySchemaSegments = rawIdentifierSegments.length > 1
                ? rawIdentifierSegments.slice(
                    rawIdentifierSegments.length === 3 ? 1 : 0,
                    -1,
                )
                : schemaName
                    ? splitQueryIdentifierPathSegments(schemaName, dialect)
                    : undefined;
            const exact = tableMetas.find((meta) => (
                meta.metadataDbKey === buildMetadataIdentityKey(dialect, candidateDbName)
                && matchesQueryEditorMetadataTablePath(
                    queryObjectSegment,
                    querySchemaSegments && querySchemaSegments.length > 0 ? querySchemaSegments : undefined,
                    meta.identifierSegments,
                    dialect,
                )
            ));
            if (!exact) return null;
            return {
                type: 'table',
                dbName: exact.dbName,
                tableName: exact.rawTableName,
                schemaName: exact.schemaName || undefined,
            };
        }

        const exactQualifiedName = normalizedSchemaName ? `${normalizedSchemaName}.${normalizedTableName}` : normalizedTableName;
        const exact = tableMetas.find((meta) =>
            meta.normalizedDbName === normalizedDbName
            && meta.normalizedRawTableName === exactQualifiedName
        );
        if (exact) {
            return buildTableNavigationTarget(exact);
        }

        const matched = tableMetas.find((meta) =>
            meta.normalizedDbName === normalizedDbName
            && meta.normalizedObjectName === normalizedTableName
            && (!normalizedSchemaName || meta.normalizedSchemaName === normalizedSchemaName)
        );
        if (!matched) return null;
        return buildTableNavigationTarget(matched);
    };

    const findNamedObject = <TMeta extends {
        dbName: string;
        rawObjectName: string;
        objectName: string;
        normalizedDbName: string;
        normalizedRawObjectName: string;
        normalizedObjectName: string;
        normalizedSchemaName: string;
        schemaName: string;
        metadataDbKey: string;
        identifierSegments: ReturnType<typeof splitQualifiedNameSegmentsDetailed>;
    }>(
        metas: TMeta[],
        candidateDbName: string,
        candidateObjectName: string,
        schemaName = '',
    ): TMeta | null => {
        const normalizedDbName = String(candidateDbName || '').trim().toLowerCase();
        const normalizedObjectName = String(candidateObjectName || '').trim().toLowerCase();
        const normalizedSchemaName = String(schemaName || '').trim().toLowerCase();
        if (!normalizedObjectName) return null;

        if (pgLikeIdentifierResolution && rawIdentifierSegments.length > 0) {
            const queryObjectSegment = rawIdentifierSegments[rawIdentifierSegments.length - 1];
            const querySchemaSegments = rawIdentifierSegments.length > 1
                ? rawIdentifierSegments.slice(
                    rawIdentifierSegments.length === 3 ? 1 : 0,
                    -1,
                )
                : schemaName
                    ? splitQueryIdentifierPathSegments(schemaName, dialect)
                    : undefined;
            return metas.find((meta) => (
                meta.metadataDbKey === buildMetadataIdentityKey(dialect, candidateDbName)
                && matchesQueryEditorMetadataTablePath(
                    queryObjectSegment,
                    querySchemaSegments && querySchemaSegments.length > 0
                        ? querySchemaSegments
                        : undefined,
                    meta.identifierSegments,
                    dialect,
                )
            )) || null;
        }

        const exactQualifiedName = normalizedSchemaName ? `${normalizedSchemaName}.${normalizedObjectName}` : normalizedObjectName;
        const exact = metas.find((meta) =>
            meta.normalizedDbName === normalizedDbName
            && meta.normalizedRawObjectName === exactQualifiedName
        );
        if (exact) {
            if (!normalizedSchemaName && !exact.normalizedSchemaName) {
                const schemaQualifiedMatches = metas.filter((meta) =>
                    meta.normalizedDbName === normalizedDbName
                    && meta.normalizedObjectName === normalizedObjectName
                    && Boolean(meta.normalizedSchemaName)
                );
                if (schemaQualifiedMatches.length === 1) {
                    return schemaQualifiedMatches[0];
                }
            }
            return exact;
        }

        return metas.find((meta) =>
            meta.normalizedDbName === normalizedDbName
            && meta.normalizedObjectName === normalizedObjectName
            && (!normalizedSchemaName || meta.normalizedSchemaName === normalizedSchemaName)
        ) || null;
    };

    const findView = (candidateDbName: string, candidateViewName: string, schemaName = ''): QueryEditorNavigationTarget | null => {
        const matched = findNamedObject(viewMetas, candidateDbName, candidateViewName, schemaName);
        if (!matched) return null;
        return {
            type: 'view',
            dbName: matched.dbName,
            viewName: matched.rawObjectName,
            schemaName: matched.schemaName || undefined,
        };
    };

    const findMaterializedView = (candidateDbName: string, candidateViewName: string, schemaName = ''): QueryEditorNavigationTarget | null => {
        const matched = findNamedObject(materializedViewMetas, candidateDbName, candidateViewName, schemaName);
        if (!matched) return null;
        return {
            type: 'materialized-view',
            dbName: matched.dbName,
            viewName: matched.rawObjectName,
            schemaName: matched.schemaName || undefined,
        };
    };

    const findTrigger = (candidateDbName: string, candidateTriggerName: string, schemaName = ''): QueryEditorNavigationTarget | null => {
        const matched = findNamedObject(triggerMetas, candidateDbName, candidateTriggerName, schemaName);
        if (!matched) return null;
        return {
            type: 'trigger',
            dbName: matched.dbName,
            triggerName: matched.rawObjectName,
            tableName: matched.tableName,
            schemaName: matched.schemaName || undefined,
        };
    };

    const findRoutine = (candidateDbName: string, candidateRoutineName: string, schemaName = ''): QueryEditorNavigationTarget | null => {
        const matched = findNamedObject(routineMetas, candidateDbName, candidateRoutineName, schemaName);
        if (!matched) return null;
        return {
            type: 'routine',
            dbName: matched.dbName,
            routineName: matched.rawObjectName,
            routineType: matched.routineType,
            schemaName: matched.schemaName || undefined,
        };
    };

    const findSequence = (candidateDbName: string, candidateSequenceName: string, schemaName = ''): QueryEditorNavigationTarget | null => {
        const matched = findNamedObject(sequenceMetas, candidateDbName, candidateSequenceName, schemaName);
        if (!matched) return null;
        return {
            type: 'sequence',
            dbName: matched.dbName,
            sequenceName: matched.rawObjectName,
            schemaName: matched.schemaName || undefined,
        };
    };

    const findPackage = (candidateDbName: string, candidatePackageName: string, schemaName = ''): QueryEditorNavigationTarget | null => {
        const matched = findNamedObject(packageMetas, candidateDbName, candidatePackageName, schemaName);
        if (!matched) return null;
        return {
            type: 'package',
            dbName: matched.dbName,
            packageName: matched.rawObjectName,
            schemaName: matched.schemaName || undefined,
        };
    };

    const findObjectInPriorityOrder = (candidateDbName: string, candidateObjectName: string, schemaName = ''): QueryEditorNavigationTarget | null => (
        findTable(candidateDbName, candidateObjectName, schemaName)
        || findView(candidateDbName, candidateObjectName, schemaName)
        || findMaterializedView(candidateDbName, candidateObjectName, schemaName)
        || findTrigger(candidateDbName, candidateObjectName, schemaName)
        || findRoutine(candidateDbName, candidateObjectName, schemaName)
        || findSequence(candidateDbName, candidateObjectName, schemaName)
        || findPackage(candidateDbName, candidateObjectName, schemaName)
    );

    const isTableSourceIdentifier = (identifierStart: number): boolean => {
        const prefix = maskQueryEditorSqlLiteralsAndComments(
            (documentWindow ? documentText : text).slice(0, Math.max(0, identifierStart)),
            dialect,
        );
        // A selected database gives an unqualified table reference its local
        // meaning, even when another visible database has the same name.
        return tableSourceContext || isQueryEditorTableSourcePrefix(prefix, dialect);
    };

    if (parts.length === 1) {
        const [singlePart] = parts;
        const singlePartDbKey = buildMetadataIdentityKey(dialect, singlePart);
        const literalDottedTable = singleQuotedDottedTableIdentifier
            ? tableMetas.find((meta) => (
                meta.metadataDbKey === buildMetadataIdentityKey(dialect, currentDbName)
                && matchesSingleQuotedDottedTableIdentifier(meta)
            ))
            : undefined;
        // PostgreSQL 等支持 schema 的方言中，未限定对象与当前 search_path 同义。
        // 有明确选择时先匹配该 schema，避免 metadata 返回顺序把 public.users 盖过 sales.users。
        const currentDatabaseObject = singleQuotedDottedTableIdentifier
            ? (literalDottedTable ? buildTableNavigationTarget(literalDottedTable) : null)
            : (
                currentSchemaName
                    ? findObjectInPriorityOrder(currentDbName, singlePart, currentSchemaName)
                    : null
            ) || findObjectInPriorityOrder(currentDbName, singlePart);
        if (isTableSourceIdentifier(prefixSliceStart)) {
            return currentDatabaseObject;
        }
        if (visibleDbSet.has(singlePartDbKey)) {
            return { type: 'database', dbName: singlePart };
        }
        return currentDatabaseObject;
    }

    if (parts.length === 2) {
        const [firstPart, secondPart] = parts;
        const firstKey = firstPart.toLowerCase();
        const firstIsVisibleDb = visibleDbSet.has(buildMetadataIdentityKey(dialect, firstPart));
        const firstLooksLikeSchema = QUERY_EDITOR_COMMON_SCHEMA_NAME_SET.has(firstKey);

        // SQLite exposes `main.table`/`temp.table` as connection-local
        // qualifiers. They are not separate database contexts, so resolve
        // them against the same empty-db metadata partition used by an
        // unqualified table reference.
        if (
            connectionScopedDialect
            && (firstKey === 'main' || firstKey === 'temp')
        ) {
            const connectionScopedObject = Array.from(new Set([currentDbName, firstPart, '']))
                .map((scope) => (
                    findObjectInPriorityOrder(scope, secondPart)
                    || findObjectInPriorityOrder(scope, `${firstPart}.${secondPart}`)
                ))
                .find(Boolean);
            if (connectionScopedObject) {
                return connectionScopedObject;
            }
        }

        // 1) 首段是可见库 → MySQL/ClickHouse 风格 db.table（或跨库）
        if (!schemaQualifiedTwoPartDialect && firstIsVisibleDb) {
            const asDatabaseObject = findObjectInPriorityOrder(firstPart, secondPart);
            if (asDatabaseObject) {
                return asDatabaseObject;
            }
        }

        // 2) 当前库下的 schema.table（PostgreSQL / SQL Server / Oracle owner）
        //    元数据里 tableName 可能是 "public.users" 或裸名 + schemaName
        const asSchemaObject = findObjectInPriorityOrder(currentDbName, secondPart, firstPart);
        if (asSchemaObject) {
            return asSchemaObject;
        }
        const asRawQualifiedUnderCurrent = findObjectInPriorityOrder(
            currentDbName,
            `${firstPart}.${secondPart}`,
        );
        if (asRawQualifiedUnderCurrent) {
            return asRawQualifiedUnderCurrent;
        }

        // 3) 首段不在可见库列表，但元数据里已有该库（或拉取中的跨库结果）
        //    跳过明显 schema 名，避免 public.xxx 误当成库
        if (!schemaQualifiedTwoPartDialect && !firstIsVisibleDb && !firstLooksLikeSchema) {
            const asInferredDatabaseObject = findObjectInPriorityOrder(firstPart, secondPart);
            if (asInferredDatabaseObject) {
                return asInferredDatabaseObject;
            }
        }

        return null;
    }

    // 三段：database.schema.object（PG/SQL Server 跨库限定）
    const [dbName, schemaName, tableName] = parts;
    const dbKey = buildMetadataIdentityKey(dialect, dbName);
    const dbIsKnown = visibleDbSet.has(dbKey)
        || tableMetas.some((meta) => meta.metadataDbKey === dbKey)
        || viewMetas.some((meta) => meta.metadataDbKey === dbKey)
        || materializedViewMetas.some((meta) => meta.metadataDbKey === dbKey);

    if (!dbIsKnown) {
        // Oracle 风格：schema.package.member / schema.sequence.nextval（库仍是 currentDb）
        const schemaQualifiedSequence = findSequence(currentDbName, schemaName, dbName);
        if (schemaQualifiedSequence && ['nextval', 'currval'].includes(tableName.toLowerCase())) {
            return schemaQualifiedSequence;
        }
        const schemaQualifiedPackage = findPackage(currentDbName, schemaName, dbName);
        if (schemaQualifiedPackage) {
            return schemaQualifiedPackage;
        }
        // 仍尝试把首段当库解析（元数据可能已按 SQL 引用拉取）
        return findObjectInPriorityOrder(dbName, tableName, schemaName)
            || findObjectInPriorityOrder(dbName, `${schemaName}.${tableName}`);
    }
    return findObjectInPriorityOrder(dbName, tableName, schemaName)
        || findObjectInPriorityOrder(dbName, `${schemaName}.${tableName}`);
};
