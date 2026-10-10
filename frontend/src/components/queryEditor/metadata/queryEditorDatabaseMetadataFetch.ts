import { DBGetAllColumns, DBGetTables } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import type { SavedConnection } from '../../../types';
import { buildMetadataDiscoveryScope } from '../../../utils/metadataDiscoveryScope';
import {
    getCaseInsensitiveValue,
    queryCompletionMetadataRowsBySpecs,
    buildCompletionSynonymsMetadataQuerySpecs,
    buildCompletionViewsMetadataQuerySpecs,
    buildCompletionMaterializedViewsMetadataQuerySpecs,
    buildCompletionTriggersMetadataQuerySpecs,
    buildCompletionFunctionsMetadataQuerySpecs,
    buildCompletionSequencesMetadataQuerySpecs,
    buildCompletionPackagesMetadataQuerySpecs,
    type CompletionColumnMeta,
    type CompletionPackageMeta,
    type CompletionRoutineMeta,
    type CompletionSequenceMeta,
    type CompletionSynonymMeta,
    type CompletionTableMeta,
    type CompletionTriggerMeta,
    type CompletionViewMeta,
    type MetadataQueryResult,
    type MetadataQuerySpec,
} from '../QueryEditorHelpers';
import { buildCompletionTableMeta, fetchCompletionTableCommentMap } from '../queryEditorCompletionTables';
import {
    collectQueryEditorSynonymMetadata,
    collectQueryEditorColumnMetadata,
    collectQueryEditorViewMetadata,
    collectQueryEditorMaterializedViewMetadata,
    collectQueryEditorTriggerMetadata,
    collectQueryEditorRoutineMetadata,
    collectQueryEditorSequenceMetadata,
    collectQueryEditorPackageMetadata,
} from './queryEditorMetadataRowCollectors';
import type {
    QueryEditorDatabaseMetadata,
    QueryEditorSessionLoadResult,
} from './queryEditorSessionMetadataStore';

export interface QueryEditorMetadataFetchContext {
    connection?: SavedConnection;
    /** Connection config normalised the way the RPC layer expects it. */
    config: Record<string, any>;
    metadataDialect: string;
    /** Login schema of an Oracle-like connection; empty for every other dialect. */
    oracleMetadataOwner: string;
}

export const createEmptyQueryEditorDatabaseMetadata = (): QueryEditorDatabaseMetadata => ({
    tables: [],
    columns: [],
    views: [],
    materializedViews: [],
    triggers: [],
    routines: [],
    sequences: [],
    packages: [],
});

const queryMetadataSpecs = async (
    context: QueryEditorMetadataFetchContext,
    dbName: string,
    specs: MetadataQuerySpec[],
    markFailed: () => void,
): Promise<MetadataQueryResult[]> => {
    const results = await queryCompletionMetadataRowsBySpecs(context.config, dbName, specs);
    // An empty successful catalog is valid; an empty result for a
    // non-empty spec set means every compatibility query failed and
    // must remain retryable (especially over SSH).
    if (specs.length > 0 && results.length === 0) {
        markFailed();
    }
    return results;
};

const includesCurrentOwnerFallback = (context: QueryEditorMetadataFetchContext, dbName: string): boolean => (
    context.metadataDialect !== 'oracle'
    || !context.oracleMetadataOwner
    || context.oracleMetadataOwner.toLowerCase() === dbName.toLowerCase()
);

const createMetadataRowOwnerFilter = (context: QueryEditorMetadataFetchContext) => (
    row: Record<string, any>,
    targetDbName: string,
    ownerKeys: string[],
): boolean => {
    if (context.metadataDialect !== 'oracle') return true;
    const targetOwner = String(targetDbName || '').trim();
    if (!targetOwner) return true;
    const rowOwner = String(getCaseInsensitiveValue(row, ownerKeys) || '').trim();
    if (rowOwner) {
        return rowOwner.toLowerCase() === targetOwner.toLowerCase();
    }
    // USER_* compatibility queries omit OWNER and always refer to
    // the login schema. Never attribute those rows to another
    // explicitly selected owner.
    return !context.oracleMetadataOwner
        || context.oracleMetadataOwner.toLowerCase() === targetOwner.toLowerCase();
};

export const fetchQueryEditorSynonymMetadata = async (
    context: QueryEditorMetadataFetchContext,
    dbName: string,
): Promise<QueryEditorSessionLoadResult<CompletionSynonymMeta[]>> => {
    let failed = false;
    const synonymSpecs = buildCompletionSynonymsMetadataQuerySpecs(context.metadataDialect);
    const synonymResults = await queryMetadataSpecs(context, dbName, synonymSpecs, () => { failed = true; });
    const synonyms: CompletionSynonymMeta[] = [];
    collectQueryEditorSynonymMetadata({
        synonymResults,
        metadataDialect: context.metadataDialect,
        seenSynonyms: new Set<string>(),
        allSynonyms: synonyms,
    });
    return { value: synonyms, cacheable: !failed };
};

/**
 * Loads the object catalog of one database. Every finished step is reported,
 * tables first, so navigation does not wait for the slower object kinds.
 * Resolves to null when the load was stopped.
 */
export const fetchQueryEditorDatabaseMetadata = async (
    context: QueryEditorMetadataFetchContext,
    dbName: string,
    report: (partial: QueryEditorDatabaseMetadata) => void,
    shouldStop: () => boolean,
): Promise<QueryEditorSessionLoadResult<QueryEditorDatabaseMetadata> | null> => {
    if (context.connection) context = { ...context, config: { ...context.config, metadataScope: buildMetadataDiscoveryScope(context.connection, dbName) } };
    const { config, metadataDialect } = context;
    const rpcConfig = buildRpcConnectionConfig(config) as any;
    const isMetadataRowForDatabase = createMetadataRowOwnerFilter(context);
    let metadata = createEmptyQueryEditorDatabaseMetadata();
    let failed = false;
    const markFailed = () => { failed = true; };
    const publish = (patch: Partial<QueryEditorDatabaseMetadata>) => {
        metadata = { ...metadata, ...patch };
        report(metadata);
    };

    // 获取表
    let tableRows: any[] = [];
    try {
        const resTables = await DBGetTables(rpcConfig, dbName);
        if (resTables?.success && Array.isArray(resTables.data)) {
            tableRows = resTables.data;
        } else {
            failed = true;
        }
    } catch (error) {
        failed = true;
        if (shouldStop()) return null;
        console.warn('GoNavi query editor table metadata fetch failed', error);
    }
    if (shouldStop()) return null;
    const buildTables = (tableComments: Map<string, string>): CompletionTableMeta[] => {
        const tables: CompletionTableMeta[] = [];
        tableRows.forEach((row) => {
            const tableMeta = buildCompletionTableMeta(dbName, row, tableComments, metadataDialect);
            if (tableMeta) {
                tables.push(tableMeta);
            }
        });
        return tables;
    };
    publish({ tables: buildTables(new Map<string, string>()) });

    // 表备注只是补全增强：先让表可用，再补备注。
    const tableComments = await fetchCompletionTableCommentMap(config, dbName, metadataDialect);
    if (shouldStop()) return null;
    if (tableComments.size > 0) {
        publish({ tables: buildTables(tableComments) });
    }

    // 获取列 (所有数据库类型都支持 DBGetAllColumns)
    let resCols: any = { success: false, data: [] };
    try {
        resCols = await DBGetAllColumns(rpcConfig, dbName);
    } catch (error) {
        failed = true;
        if (shouldStop()) return null;
        console.warn('GoNavi query editor column metadata fetch failed', error);
    }
    if (shouldStop()) return null;
    const hasColumnResponse = Boolean(resCols?.success && Array.isArray(resCols.data));
    if (!hasColumnResponse) {
        failed = true;
    }
    const columns: CompletionColumnMeta[] = [];
    const incompleteColumnMetadataDbsRef = { current: new Set<string>() };
    collectQueryEditorColumnMetadata({
        resCols, metadataDialect, dbName, incompleteColumnMetadataDbsRef, allColumns: columns,
    });
    publish(hasColumnResponse
        ? { columns, columnsIncomplete: incompleteColumnMetadataDbsRef.current.size > 0 }
        : { columns });

    const viewSpecs = buildCompletionViewsMetadataQuerySpecs(metadataDialect, dbName, {
        includeCurrentOwnerFallback: includesCurrentOwnerFallback(context, dbName),
    });
    const viewResults = await queryMetadataSpecs(context, dbName, viewSpecs, markFailed);
    if (shouldStop()) return null;
    const views: CompletionViewMeta[] = [];
    collectQueryEditorViewMetadata({
        viewResults, isMetadataRowForDatabase, dbName, metadataDialect, seenViews: new Set<string>(),
        allViews: views,
    });
    publish({ views });

    const materializedViewSpecs = buildCompletionMaterializedViewsMetadataQuerySpecs(metadataDialect, dbName);
    const materializedViewResults = await queryMetadataSpecs(context, dbName, materializedViewSpecs, markFailed);
    if (shouldStop()) return null;
    const materializedViews: CompletionViewMeta[] = [];
    collectQueryEditorMaterializedViewMetadata({
        materializedViewResults, metadataDialect, dbName, seenMaterializedViews: new Set<string>(),
        allMaterializedViews: materializedViews,
    });
    publish({ materializedViews });

    const triggerSpecs = buildCompletionTriggersMetadataQuerySpecs(metadataDialect, dbName);
    const triggerResults = await queryMetadataSpecs(context, dbName, triggerSpecs, markFailed);
    if (shouldStop()) return null;
    const triggers: CompletionTriggerMeta[] = [];
    collectQueryEditorTriggerMetadata({
        triggerResults, metadataDialect, dbName, seenTriggers: new Set<string>(), allTriggers: triggers,
    });
    publish({ triggers });

    const routineSpecs = buildCompletionFunctionsMetadataQuerySpecs(metadataDialect, dbName, {
        includeCurrentOwnerFallback: includesCurrentOwnerFallback(context, dbName),
    });
    const routineResults = await queryMetadataSpecs(context, dbName, routineSpecs, markFailed);
    if (shouldStop()) return null;
    const routines: CompletionRoutineMeta[] = [];
    collectQueryEditorRoutineMetadata({
        routineResults, isMetadataRowForDatabase, dbName, metadataDialect, seenRoutines: new Set<string>(),
        allRoutines: routines,
    });
    publish({ routines });

    const sequenceSpecs = buildCompletionSequencesMetadataQuerySpecs(metadataDialect, dbName);
    const sequenceResults = await queryMetadataSpecs(context, dbName, sequenceSpecs, markFailed);
    if (shouldStop()) return null;
    const sequences: CompletionSequenceMeta[] = [];
    collectQueryEditorSequenceMetadata({
        sequenceResults, metadataDialect, dbName, seenSequences: new Set<string>(), allSequences: sequences,
    });
    publish({ sequences });

    const packageSpecs = buildCompletionPackagesMetadataQuerySpecs(metadataDialect, dbName);
    const packageResults = await queryMetadataSpecs(context, dbName, packageSpecs, markFailed);
    if (shouldStop()) return null;
    const packages: CompletionPackageMeta[] = [];
    collectQueryEditorPackageMetadata({
        packageResults, metadataDialect, dbName, seenPackages: new Set<string>(), allPackages: packages,
    });
    publish({ packages });

    return { value: metadata, cacheable: !failed };
};
