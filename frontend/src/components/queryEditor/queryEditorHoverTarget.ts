import { resolveSqlDialect, isPgLikeDialect } from '../../utils/sqlDialect';
import { splitSidebarQualifiedName } from '../../utils/sidebarLocate';
import { buildMetadataIdentityKey } from '../../utils/metadataIdentity';
import { splitQualifiedNameSegmentsDetailed } from '../../utils/qualifiedName';
import type {
    CompletionTableMeta,
    CompletionColumnMeta,
    CompletionViewMeta,
    CompletionTriggerMeta,
    CompletionRoutineMeta,
    CompletionSequenceMeta,
    CompletionPackageMeta,
} from './queryEditorCompletionCandidates';
import {
    type QueryEditorAliasMap,
    usesQueryEditorSchemaQualifiedTwoPartNames,
    usesQueryEditorDatabaseQualifiedTwoPartNames,
    QUERY_EDITOR_COMMON_SCHEMA_NAME_SET,
    buildQueryEditorAliasMap,
} from './queryEditorExecutionContext';
import {
    type QueryEditorHoverTarget,
    splitQueryIdentifierPathSegments,
    type QueryIdentifierPathSegment,
} from './queryEditorIdentifierPaths';
import {
    findIdentifierWindowAtOffset,
    findQualifiedIdentifierWindowAtOffset,
    isQueryEditorTableSourceAtPosition,
} from './queryEditorSqlScan';
import {
    normalizeQueryEditorHoverIdentifier,
    buildQueryEditorIdentifierIdentityKey,
    isQualifiedQueryEditorHoverIdentifier,
    normalizeNavigationIdentifierParts,
    matchesQueryEditorIdentifierSegment,
    matchesQueryEditorMetadataTablePath,
} from './queryEditorReferenceIdentity';
import { getNormalizedPositionAtOffset } from './queryEditorEditorState';
import { splitCompletionSchemaAndTable } from './queryEditorCompletionMetadata';
import { resolveQueryEditorNavigationTarget } from './queryEditorNavigationTarget';
import { collectQueryEditorTableReferences } from './queryEditorTableReferences';

export const resolveQueryEditorHoverTarget = (
    fullText: string,
    lineContent: string,
    column: number,
    currentDb: string,
    visibleDbs: string[],
    tables: CompletionTableMeta[],
    allColumns: CompletionColumnMeta[],
    views: CompletionViewMeta[] = [],
    materializedViews: CompletionViewMeta[] = [],
    triggers: CompletionTriggerMeta[] = [],
    routines: CompletionRoutineMeta[] = [],
    sequences: CompletionSequenceMeta[] = [],
    packages: CompletionPackageMeta[] = [],
    tableSourceContext = false,
    documentContext?: { text: string; offset: number },
    currentSchema = '',
    aliasMap?: QueryEditorAliasMap,
    allowTableSourceInference = false,
    dialect = '',
): QueryEditorHoverTarget | null => {
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
    const lineIdentifier = windowRange
        ? normalizeQueryEditorHoverIdentifier(text.slice(windowRange.start, windowRange.end).trim())
        : '';
    const documentIdentifier = documentWindow
        ? normalizeQueryEditorHoverIdentifier(documentText.slice(documentWindow.start, documentWindow.end).trim())
        : '';
    const normalizedLineSegments = splitQueryIdentifierPathSegments(lineIdentifier, dialect)
        .map((segment) => buildQueryEditorIdentifierIdentityKey([segment], dialect));
    const normalizedDocumentSegments = splitQueryIdentifierPathSegments(documentIdentifier, dialect)
        .map((segment) => buildQueryEditorIdentifierIdentityKey([segment], dialect));
    const documentContainsLineSegments = normalizedLineSegments.length > 0
        && normalizedLineSegments.length <= normalizedDocumentSegments.length
        && normalizedDocumentSegments.some((_, startIndex) => (
            startIndex + normalizedLineSegments.length <= normalizedDocumentSegments.length
            && normalizedLineSegments.every((segment, offset) => (
                normalizedDocumentSegments[startIndex + offset] === segment
            ))
        ));
    // A stale document offset can point at a different token. A qualified
    // document window is useful for cross-line names only when the token on
    // the current line is a contiguous part of that qualified path; otherwise
    // use the line token as the authoritative value.
    const documentTokenMatchesLine = !lineIdentifier
        || documentContainsLineSegments;
    const useDocumentIdentifier = Boolean(documentIdentifier)
        && documentTokenMatchesLine
        && (!lineIdentifier || isQualifiedQueryEditorHoverIdentifier(documentIdentifier, dialect));
    const resolutionText = useDocumentIdentifier ? documentText : text;
    const rawIdentifier = useDocumentIdentifier ? documentIdentifier : lineIdentifier;
    if (!rawIdentifier) return null;

    const range = windowRange
        ? { startColumn: windowRange.start + 1, endColumn: windowRange.end + 1 }
        : {
            // Monaco can briefly report a stale/empty current line while the
            // model has already supplied a valid document offset (notably when
            // formatting moves a qualified name across lines). Keep the hover
            // anchored to the current position instead of dropping the target.
            startColumn: Math.max(1, Math.floor(Number(column) || 1)),
            endColumn: Math.max(2, Math.floor(Number(column) || 1) + 1),
        };
    const useDocumentSourceContext = Boolean(documentWindow && (useDocumentIdentifier || documentTokenMatchesLine));
    const sourceContextPosition = useDocumentSourceContext && documentWindow
        ? getNormalizedPositionAtOffset(documentText, documentWindow.start)
        : { lineNumber: 1, column };
    // Even when the document window contributes no extra qualification (an
    // unqualified table on a later line), it still carries the `FROM`/`JOIN`
    // context needed for metadata-missing fallback. Only trust that context
    // when the document token agrees with the token under the cursor; this
    // prevents a stale Monaco offset from classifying an unrelated source.
    const documentTableSourceContext = useDocumentSourceContext
        && isQueryEditorTableSourceAtPosition(
            documentText,
            sourceContextPosition.lineNumber,
            sourceContextPosition.column,
            dialect,
        );
    const inferredTableSourceContext = documentTableSourceContext || isQueryEditorTableSourceAtPosition(
        useDocumentSourceContext ? documentText : text,
        sourceContextPosition.lineNumber,
        sourceContextPosition.column,
        dialect,
    );
    const parts = normalizeNavigationIdentifierParts(rawIdentifier, dialect);
    if (parts.length === 0 || parts.length > 3) return null;
    const currentDbName = String(currentDb || '').trim();
    const currentSchemaName = String(currentSchema || '').trim();
    const connectionScopedDialect = resolveSqlDialect(dialect) === 'sqlite';
    const schemaQualifiedTwoPartDialect = usesQueryEditorSchemaQualifiedTwoPartNames(dialect);
    const rawIdentifierSegments = splitQueryIdentifierPathSegments(rawIdentifier, dialect);
    const pgLikeIdentifierResolution = isPgLikeDialect(dialect);
    const singleQuotedDottedTableIdentifier = rawIdentifierSegments.length === 1
        && rawIdentifierSegments[0].quoted
        && String(rawIdentifierSegments[0].value || '').includes('.');
    const buildTableLookupName = (targetDbName: string, targetSchemaName = ''): string => {
        const rawParts = rawIdentifierSegments.map((segment) => String(segment.raw || '').trim()).filter(Boolean);
        if (rawParts.length === 0) return '';
        if (rawParts.length === 1) {
            if (singleQuotedDottedTableIdentifier) {
                return rawParts[0];
            }
            return targetSchemaName ? `${targetSchemaName}.${rawParts[0]}` : rawParts[0];
        }
        const normalizedTargetDb = String(targetDbName || '').trim().toLowerCase();
        const normalizedFirst = String(parts[0] || '').trim().toLowerCase();
        if (rawParts.length === 2 && normalizedFirst === normalizedTargetDb && !targetSchemaName) {
            return rawParts[1];
        }
        if (rawParts.length === 3 && normalizedFirst === normalizedTargetDb) {
            return rawParts.slice(1).join('.');
        }
        return rawParts.join('.');
    };

    const findColumnTarget = (
        dbName: string,
        tableName: string,
        columnName: string,
        queryColumnSegment?: QueryIdentifierPathSegment,
        queryTableSegments?: QueryIdentifierPathSegment[],
    ): QueryEditorHoverTarget | null => {
        const metadataDbKey = buildMetadataIdentityKey(dialect, dbName);
        const columnSegment = queryColumnSegment || {
            raw: columnName,
            value: columnName,
            quoted: false,
        };
        const tableSegments = queryTableSegments && queryTableSegments.length > 0
            ? queryTableSegments
            : splitQueryIdentifierPathSegments(tableName, dialect);
        const column = allColumns.find((item) => {
            if (buildMetadataIdentityKey(dialect, item.dbName) !== metadataDbKey) return false;
            if (!matchesQueryEditorIdentifierSegment(columnSegment, String(item.name || ''), dialect)) return false;
            const metadataSegments = splitQualifiedNameSegmentsDetailed(
                String(item.tableName || '').trim(),
                dialect,
            );
            if (tableSegments.length === 0 || metadataSegments.length === 0) return false;
            if (tableSegments.length === 1) {
                return matchesQueryEditorIdentifierSegment(
                    tableSegments[0],
                    metadataSegments[metadataSegments.length - 1]?.value || '',
                    dialect,
                );
            }
            return matchesQueryEditorMetadataTablePath(
                tableSegments[tableSegments.length - 1],
                tableSegments.slice(0, -1),
                metadataSegments,
                dialect,
            );
        });
        if (!column) return null;
        const parsedTable = splitCompletionSchemaAndTable(column.tableName || '', column.dbName);
        return {
            kind: 'column',
            dbName: column.dbName,
            tableName: column.tableName,
            columnName: column.name,
            type: column.type,
            comment: column.comment,
            schemaName: parsedTable.schema || undefined,
            range,
        };
    };

    // Three-part references are ambiguous across SQL dialects: they can be a
    // database/schema/table source or a schema/table/column expression. When
    // the cursor is not in a table-source position, prefer an exact column
    // metadata match; source positions retain table navigation semantics.
    if (parts.length === 3 && !tableSourceContext && !inferredTableSourceContext) {
        const [firstPart, secondPart, columnPart] = parts;
        const queryColumnSegment = rawIdentifierSegments[rawIdentifierSegments.length - 1];
        const qualifiedColumnCandidates = [
            {
                dbName: currentDb,
                tableName: `${firstPart}.${secondPart}`,
                tableSegments: rawIdentifierSegments.slice(0, 2),
            },
            {
                dbName: firstPart,
                tableName: secondPart,
                tableSegments: rawIdentifierSegments.slice(1, 2),
            },
        ];
        for (const candidate of qualifiedColumnCandidates) {
            const qualifiedColumn = findColumnTarget(
                candidate.dbName,
                candidate.tableName,
                columnPart,
                queryColumnSegment,
                candidate.tableSegments,
            );
            if (qualifiedColumn) return qualifiedColumn;
        }
    }

    const findMatchingTable = (dbName: string, rawTableName: string, schemaName = ''): CompletionTableMeta | null => {
        const normalizedDbName = String(dbName || '').trim().toLowerCase();
        const normalizedRawTableName = String(rawTableName || '').trim().toLowerCase();
        const normalizedSchemaName = String(schemaName || '').trim().toLowerCase();

        // Keep PostgreSQL's quoted/unquoted spelling when finding the metadata
        // row used for comments. Falling back to a lower-case comparison here
        // would select the wrong row when `"Users"` and `users` coexist.
        const queryObjectSegment = rawIdentifierSegments[rawIdentifierSegments.length - 1];
        if (pgLikeIdentifierResolution && queryObjectSegment) {
            const querySchemaSegments = rawIdentifierSegments.length === 1
                ? undefined
                : rawIdentifierSegments.length === 2
                    ? [rawIdentifierSegments[0]]
                    : rawIdentifierSegments.slice(1, -1);
            const exact = tables.find((item) => {
                if (buildMetadataIdentityKey(dialect, item.dbName) !== buildMetadataIdentityKey(dialect, dbName)) return false;
                const metadataSegments = splitQualifiedNameSegmentsDetailed(
                    String(item.tableName || '').trim(),
                    dialect,
                );
                return matchesQueryEditorMetadataTablePath(
                    queryObjectSegment,
                    querySchemaSegments,
                    metadataSegments,
                    dialect,
                );
            });
            return exact || null;
        }

        return tables.find((item) => {
            if (buildMetadataIdentityKey(dialect, item.dbName) !== buildMetadataIdentityKey(dialect, dbName)) return false;
            const itemRawName = String(item.tableName || '').trim();
            const parsed = splitSidebarQualifiedName(itemRawName);
            const itemObjectName = String(parsed.objectName || itemRawName).trim().toLowerCase();
            const itemSchemaName = String(parsed.schemaName || '').trim().toLowerCase();
            if (normalizedSchemaName) {
                const normalizedItemRawName = String(itemRawName).trim().toLowerCase();
                return itemSchemaName === normalizedSchemaName
                    && (
                        itemObjectName === normalizedRawTableName
                        || normalizedItemRawName === normalizedRawTableName
                        || normalizedItemRawName === `${normalizedSchemaName}.${normalizedRawTableName}`
                    );
            }
            return itemObjectName === normalizedRawTableName || String(itemRawName).trim().toLowerCase() === normalizedRawTableName;
        }) || null;
    };

    const navigationTarget = resolveQueryEditorNavigationTarget(
        resolutionText,
        useDocumentIdentifier ? documentOffset + 1 : column,
        currentDb,
        visibleDbs,
        tables,
        views,
        materializedViews,
        triggers,
        routines,
        sequences,
        packages,
        tableSourceContext,
        useDocumentIdentifier ? { text: documentText, offset: documentOffset } : undefined,
        currentSchema,
        dialect,
    );
    if (navigationTarget) {
        if (navigationTarget.type === 'database') {
            return { kind: 'database', dbName: navigationTarget.dbName, range };
        }
        if (navigationTarget.type === 'table') {
            const meta = findMatchingTable(navigationTarget.dbName, navigationTarget.tableName, navigationTarget.schemaName || '');
            const sourceTableName = (inferredTableSourceContext || tableSourceContext)
                && /\s/.test(String(navigationTarget.tableName || ''))
                ? parts[parts.length - 1]
                : '';
            return {
                kind: 'table',
                dbName: navigationTarget.dbName,
                tableName: sourceTableName || navigationTarget.tableName,
                schemaName: navigationTarget.schemaName,
                comment: meta?.comment,
                lookupTableName: buildTableLookupName(navigationTarget.dbName, navigationTarget.schemaName),
                range,
            };
        }
        if (navigationTarget.type === 'view') {
            return { kind: 'view', dbName: navigationTarget.dbName, viewName: navigationTarget.viewName, schemaName: navigationTarget.schemaName, range };
        }
        if (navigationTarget.type === 'materialized-view') {
            return { kind: 'materialized-view', dbName: navigationTarget.dbName, viewName: navigationTarget.viewName, schemaName: navigationTarget.schemaName, range };
        }
        if (navigationTarget.type === 'trigger') {
            return { kind: 'trigger', dbName: navigationTarget.dbName, triggerName: navigationTarget.triggerName, tableName: navigationTarget.tableName, schemaName: navigationTarget.schemaName, range };
        }
        if (navigationTarget.type === 'routine') {
            return { kind: 'routine', dbName: navigationTarget.dbName, routineName: navigationTarget.routineName, routineType: navigationTarget.routineType, schemaName: navigationTarget.schemaName, range };
        }
        if (navigationTarget.type === 'sequence') {
            return { kind: 'sequence', dbName: navigationTarget.dbName, sequenceName: navigationTarget.sequenceName, schemaName: navigationTarget.schemaName, range };
        }
        return { kind: 'package', dbName: navigationTarget.dbName, packageName: navigationTarget.packageName, schemaName: navigationTarget.schemaName, range };
    }

    if (allowTableSourceInference && (tableSourceContext || inferredTableSourceContext)) {
        if (parts.length === 1) {
            return {
                kind: 'table',
                dbName: currentDb,
                tableName: parts[0],
                schemaName: currentSchemaName || undefined,
                lookupTableName: buildTableLookupName(currentDb, currentSchemaName),
                range,
            };
        }
        if (parts.length === 2) {
            const [firstPart, secondPart] = parts;
            const firstKey = firstPart.toLowerCase();
            if (
                connectionScopedDialect
                && (firstKey === 'main' || firstKey === 'temp')
            ) {
                return {
                    kind: 'table',
                    dbName: currentDb,
                    tableName: secondPart,
                    lookupTableName: buildTableLookupName(currentDb),
                    range,
                };
            }
            if (
                usesQueryEditorDatabaseQualifiedTwoPartNames(dialect)
                || (
                    !schemaQualifiedTwoPartDialect
                    && visibleDbs.some((dbName) => String(dbName || '').trim().toLowerCase() === firstKey)
                )
            ) {
                return {
                    kind: 'table',
                    dbName: firstPart,
                    tableName: secondPart,
                    lookupTableName: buildTableLookupName(firstPart),
                    range,
                };
            }
            if (currentSchemaName && firstKey === currentSchemaName.toLowerCase()) {
                return {
                    kind: 'table',
                    dbName: currentDb,
                    tableName: secondPart,
                    schemaName: firstPart,
                    lookupTableName: buildTableLookupName(currentDb, firstPart),
                    range,
                };
            }
            if (QUERY_EDITOR_COMMON_SCHEMA_NAME_SET.has(firstKey)) {
                return {
                    kind: 'table',
                    dbName: currentDb,
                    tableName: secondPart,
                    schemaName: firstPart,
                    lookupTableName: buildTableLookupName(currentDb, firstPart),
                    range,
                };
            }
            // Metadata can be incomplete while a user is working in a
            // non-standard schema. Preserve the qualifier and still provide
            // the selected database as the safe fallback context.
            return {
                kind: 'table',
                dbName: currentDb,
                tableName: secondPart,
                schemaName: firstPart,
                lookupTableName: buildTableLookupName(currentDb, firstPart),
                range,
            };
        }
        if (parts.length === 3) {
            const [dbName, schemaName, tableName] = parts;
            // A three-part reference is unambiguously database.schema.table for
            // the dialects that support it. Preserve the explicit database even
            // while the database list is still loading; falling back to the
            // current database would make the next metadata/DDL lookup parse
            // the catalog name as a schema and target the wrong object.
            return {
                kind: 'table',
                dbName,
                tableName,
                schemaName,
                lookupTableName: buildTableLookupName(dbName, schemaName),
                range,
            };
        }
    }

    if (parts.length === 2) {
        const [firstPart, secondPart] = parts;
        const resolvedAliasMap = aliasMap || buildQueryEditorAliasMap(fullText, currentDb, dialect);
        const aliasKey = buildQueryEditorIdentifierIdentityKey(
            [rawIdentifierSegments[0] || { raw: firstPart, value: firstPart, quoted: false }],
            dialect,
        );
        const aliasInfo = resolvedAliasMap[aliasKey] || resolvedAliasMap[firstPart.toLowerCase()];
        if (aliasInfo) {
            // The alias scanner intentionally keeps the first segment of a
            // two-part source as an explicit owner so MySQL/Oracle cross-db
            // references remain resolvable. PostgreSQL/SQL Server use the same
            // spelling for schema.table, however, and their column metadata is
            // keyed by the current database plus the qualified table name.
            // Prefer the explicit database interpretation, then fall back to
            // the current database/schema interpretation when that catalog is
            // unavailable.
            const explicitOwner = String(aliasInfo.explicitOwnerName || '').trim();
            const aliasReference = collectQueryEditorTableReferences(fullText, dialect).find((reference) => {
                const referenceAlias = reference.aliasSegment
                    || (reference.alias
                        ? splitQueryIdentifierPathSegments(reference.alias, dialect)[0]
                        : undefined);
                return referenceAlias
                    && buildQueryEditorIdentifierIdentityKey([referenceAlias], dialect) === aliasKey;
            });
            const sourceSegments = aliasReference?.segments
                || splitQueryIdentifierPathSegments(aliasInfo.tableName, dialect);
            const currentSchemaColumn = explicitOwner
                ? findColumnTarget(
                    currentDb,
                    `${explicitOwner}.${aliasInfo.tableName}`,
                    secondPart,
                    rawIdentifierSegments[1],
                    sourceSegments,
                )
                : null;
            let aliasedColumn = schemaQualifiedTwoPartDialect
                ? currentSchemaColumn
                : findColumnTarget(
                    aliasInfo.dbName,
                    aliasInfo.tableName,
                    secondPart,
                    rawIdentifierSegments[1],
                    sourceSegments,
                );
            if (!schemaQualifiedTwoPartDialect && !aliasedColumn && currentSchemaColumn) {
                aliasedColumn = currentSchemaColumn;
            }
            if (aliasedColumn) return aliasedColumn;
        }
        const qualifiedTable = findMatchingTable(currentDb, secondPart, firstPart);
        if (qualifiedTable) {
            return {
                kind: 'table',
                dbName: qualifiedTable.dbName,
                tableName: qualifiedTable.tableName,
                schemaName: firstPart,
                comment: qualifiedTable.comment,
                range,
            };
        }
    }

    if (parts.length === 1) {
        const [columnName] = parts;
        const normalizedCurrentDb = buildMetadataIdentityKey(dialect, currentDb);
        const queryColumnSegment = rawIdentifierSegments[0] || {
            raw: columnName,
            value: columnName,
            quoted: false,
        };
        const directColumns = allColumns.filter((item) =>
            buildMetadataIdentityKey(dialect, item.dbName) === normalizedCurrentDb
            && matchesQueryEditorIdentifierSegment(queryColumnSegment, String(item.name || ''), dialect)
        );
        if (directColumns.length === 1) {
            const column = directColumns[0];
            const parsedTable = splitCompletionSchemaAndTable(column.tableName || '', column.dbName);
            return {
                kind: 'column',
                dbName: column.dbName,
                tableName: column.tableName,
                columnName: column.name,
                type: column.type,
                comment: column.comment,
                schemaName: parsedTable.schema || undefined,
                range,
            };
        }
    }

    return null;
};
