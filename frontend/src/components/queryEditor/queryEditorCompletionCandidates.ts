import {
    type MetadataIdentityMode,
    getMetadataIdentityMode,
    buildMetadataIdentityKey,
} from '../../utils/metadataIdentity';
import {
    QUERY_EDITOR_COMPLETION_SUGGESTION_LIMIT,
    type QueryEditorCompletionMatchRank,
} from './queryEditorCompletionMatch';

export type CompletionTableMeta = {dbName: string, tableName: string, comment?: string};
export type CompletionColumnMeta = {dbName: string, tableName: string, name: string, type: string, comment?: string};
export type CompletionViewMeta = {dbName: string, viewName: string, schemaName?: string};
export type CompletionSynonymMeta = {ownerName: string, synonymName: string, targetSchemaName?: string, targetName?: string};
export type CompletionTriggerMeta = {dbName: string, triggerName: string, tableName: string, schemaName?: string};
export type CompletionRoutineMeta = {dbName: string, routineName: string, routineType: string, schemaName?: string};
export type CompletionSequenceMeta = {dbName: string, sequenceName: string, schemaName?: string};
export type CompletionPackageMeta = {dbName: string, packageName: string, schemaName?: string};

// Metadata refreshes replace the source array, so identity-keyed partitions stay correct and let
// repeated completion requests avoid allocating/scanning another full-database filter result.
const completionTablesByDatabaseCache = new WeakMap<
    CompletionTableMeta[],
    Map<MetadataIdentityMode, Map<string, CompletionTableMeta[]>>
>();

export const findCompletionTablesByDatabase = (
    tables: CompletionTableMeta[],
    dbName: string,
    metadataDialect = '',
): CompletionTableMeta[] => {
    const identityMode = getMetadataIdentityMode(metadataDialect);
    let indexes = completionTablesByDatabaseCache.get(tables);
    if (!indexes) {
        indexes = new Map<MetadataIdentityMode, Map<string, CompletionTableMeta[]>>();
        completionTablesByDatabaseCache.set(tables, indexes);
    }
    let index = indexes.get(identityMode);
    if (!index) {
        index = new Map<string, CompletionTableMeta[]>();
        tables.forEach((table) => {
            const key = buildMetadataIdentityKey(metadataDialect, table.dbName);
            const matches = index!.get(key);
            if (matches) {
                matches.push(table);
            } else {
                index!.set(key, [table]);
            }
        });
        indexes.set(identityMode, index);
    }
    return index.get(buildMetadataIdentityKey(metadataDialect, dbName)) || [];
};

type RankedQueryEditorCompletionCandidate<Candidate> = {
    candidate: Candidate;
    selectionKey: string;
    sourceIndex: number;
};

export type QueryEditorCompletionCandidateBatch<Candidate, Suggestion> = {
    rankedCandidates: RankedQueryEditorCompletionCandidate<Candidate>[];
    buildSuggestion: (candidate: Candidate) => Suggestion;
};

const compareRankedQueryEditorCompletionCandidates = <Candidate,>(
    left: RankedQueryEditorCompletionCandidate<Candidate>,
    right: RankedQueryEditorCompletionCandidate<Candidate>,
): number => {
    if (left.selectionKey < right.selectionKey) return -1;
    if (left.selectionKey > right.selectionKey) return 1;
    return left.sourceIndex - right.sourceIndex;
};

export const createBoundedQueryEditorCompletionCandidateBatch = <Candidate, Suggestion>({
    candidates,
    prefix,
    getMatchRank,
    getSelectionKey,
    buildSuggestion,
    limit = QUERY_EDITOR_COMPLETION_SUGGESTION_LIMIT,
    sourceAlreadySortedBySelection = false,
}: {
    candidates: readonly Candidate[];
    prefix: string;
    getMatchRank: (candidate: Candidate, normalizedPrefix: string) => QueryEditorCompletionMatchRank;
    getSelectionKey: (
        candidate: Candidate,
        normalizedPrefix: string,
        matchRank: Exclude<QueryEditorCompletionMatchRank, null>,
    ) => string;
    buildSuggestion: (candidate: Candidate) => Suggestion;
    limit?: number;
    sourceAlreadySortedBySelection?: boolean;
}): QueryEditorCompletionCandidateBatch<Candidate, Suggestion> => {
    const normalizedLimit = Math.max(0, Math.floor(Number(limit) || 0));
    if (normalizedLimit === 0 || candidates.length === 0) {
        return { rankedCandidates: [], buildSuggestion };
    }

    const normalizedPrefix = String(prefix || '').trim().toLowerCase();
    const compareCandidateToRanked = (
        selectionKey: string,
        sourceIndex: number,
        right: RankedQueryEditorCompletionCandidate<Candidate>,
    ): number => {
        if (selectionKey < right.selectionKey) return -1;
        if (selectionKey > right.selectionKey) return 1;
        return sourceIndex - right.sourceIndex;
    };
    // Max-heap: the worst retained candidate stays at index 0 and can be replaced in O(log limit).
    const selectedHeap: RankedQueryEditorCompletionCandidate<Candidate>[] = [];
    const siftUpWorst = (startIndex: number) => {
        let childIndex = startIndex;
        while (childIndex > 0) {
            const parentIndex = Math.floor((childIndex - 1) / 2);
            if (compareRankedQueryEditorCompletionCandidates(selectedHeap[parentIndex], selectedHeap[childIndex]) >= 0) break;
            [selectedHeap[parentIndex], selectedHeap[childIndex]] = [selectedHeap[childIndex], selectedHeap[parentIndex]];
            childIndex = parentIndex;
        }
    };
    const siftDownWorst = (startIndex: number) => {
        let parentIndex = startIndex;
        while (true) {
            const leftIndex = parentIndex * 2 + 1;
            if (leftIndex >= selectedHeap.length) break;
            const rightIndex = leftIndex + 1;
            let worseChildIndex = leftIndex;
            if (
                rightIndex < selectedHeap.length
                && compareRankedQueryEditorCompletionCandidates(selectedHeap[rightIndex], selectedHeap[leftIndex]) > 0
            ) {
                worseChildIndex = rightIndex;
            }
            if (compareRankedQueryEditorCompletionCandidates(selectedHeap[parentIndex], selectedHeap[worseChildIndex]) >= 0) break;
            [selectedHeap[parentIndex], selectedHeap[worseChildIndex]] = [selectedHeap[worseChildIndex], selectedHeap[parentIndex]];
            parentIndex = worseChildIndex;
        }
    };

    for (let sourceIndex = 0; sourceIndex < candidates.length; sourceIndex += 1) {
        const candidate = candidates[sourceIndex];
        const rank = getMatchRank(candidate, normalizedPrefix);
        if (rank === null) continue;
        const selectionKey = String(getSelectionKey(candidate, normalizedPrefix, rank) || '');
        if (selectedHeap.length < normalizedLimit) {
            selectedHeap.push({ candidate, selectionKey, sourceIndex });
            siftUpWorst(selectedHeap.length - 1);
        } else {
            const worst = selectedHeap[0];
            if (compareCandidateToRanked(selectionKey, sourceIndex, worst) < 0) {
                // Reuse the root entry so descending input cannot allocate one retained wrapper per source row.
                worst.candidate = candidate;
                worst.selectionKey = selectionKey;
                worst.sourceIndex = sourceIndex;
                siftDownWorst(0);
            }
        }
        // Early-stop is safe only when the caller guarantees the source already follows the same
        // final selection-key + stable-input-order tuple used by this bounded top-k.
        if (sourceAlreadySortedBySelection && selectedHeap.length >= normalizedLimit) {
            break;
        }
    }

    selectedHeap.sort(compareRankedQueryEditorCompletionCandidates);
    return { rankedCandidates: selectedHeap, buildSuggestion };
};

export const materializeBoundedQueryEditorCompletionBatches = <Suggestion,>(
    batches: readonly QueryEditorCompletionCandidateBatch<any, Suggestion>[],
    limit = QUERY_EDITOR_COMPLETION_SUGGESTION_LIMIT,
): Suggestion[] => {
    const normalizedLimit = Math.max(0, Math.floor(Number(limit) || 0));
    if (normalizedLimit === 0 || batches.length === 0) return [];

    type GlobalRankedCandidate = {
        batchIndex: number;
        candidateIndex: number;
        selectionKey: string;
        sourceIndex: number;
    };
    const compareGlobalCandidates = (left: GlobalRankedCandidate, right: GlobalRankedCandidate): number => {
        if (left.selectionKey < right.selectionKey) return -1;
        if (left.selectionKey > right.selectionKey) return 1;
        if (left.batchIndex !== right.batchIndex) return left.batchIndex - right.batchIndex;
        return left.sourceIndex - right.sourceIndex;
    };
    const compareCandidateToGlobal = (
        batchIndex: number,
        selectionKey: string,
        sourceIndex: number,
        right: GlobalRankedCandidate,
    ): number => {
        if (selectionKey < right.selectionKey) return -1;
        if (selectionKey > right.selectionKey) return 1;
        if (batchIndex !== right.batchIndex) return batchIndex - right.batchIndex;
        return sourceIndex - right.sourceIndex;
    };
    const selectedHeap: GlobalRankedCandidate[] = [];
    const siftUpWorst = (startIndex: number) => {
        let childIndex = startIndex;
        while (childIndex > 0) {
            const parentIndex = Math.floor((childIndex - 1) / 2);
            if (compareGlobalCandidates(selectedHeap[parentIndex], selectedHeap[childIndex]) >= 0) break;
            [selectedHeap[parentIndex], selectedHeap[childIndex]] = [selectedHeap[childIndex], selectedHeap[parentIndex]];
            childIndex = parentIndex;
        }
    };
    const siftDownWorst = (startIndex: number) => {
        let parentIndex = startIndex;
        while (true) {
            const leftIndex = parentIndex * 2 + 1;
            if (leftIndex >= selectedHeap.length) break;
            const rightIndex = leftIndex + 1;
            let worseChildIndex = leftIndex;
            if (
                rightIndex < selectedHeap.length
                && compareGlobalCandidates(selectedHeap[rightIndex], selectedHeap[leftIndex]) > 0
            ) {
                worseChildIndex = rightIndex;
            }
            if (compareGlobalCandidates(selectedHeap[parentIndex], selectedHeap[worseChildIndex]) >= 0) break;
            [selectedHeap[parentIndex], selectedHeap[worseChildIndex]] = [selectedHeap[worseChildIndex], selectedHeap[parentIndex]];
            parentIndex = worseChildIndex;
        }
    };

    batches.forEach((batch, batchIndex) => {
        batch.rankedCandidates.forEach((candidate, candidateIndex) => {
            if (selectedHeap.length < normalizedLimit) {
                selectedHeap.push({
                    batchIndex,
                    candidateIndex,
                    selectionKey: candidate.selectionKey,
                    sourceIndex: candidate.sourceIndex,
                });
                siftUpWorst(selectedHeap.length - 1);
                return;
            }
            const worst = selectedHeap[0];
            if (compareCandidateToGlobal(batchIndex, candidate.selectionKey, candidate.sourceIndex, worst) < 0) {
                worst.batchIndex = batchIndex;
                worst.candidateIndex = candidateIndex;
                worst.selectionKey = candidate.selectionKey;
                worst.sourceIndex = candidate.sourceIndex;
                siftDownWorst(0);
            }
        });
    });

    selectedHeap.sort(compareGlobalCandidates);
    return selectedHeap.map(({ batchIndex, candidateIndex }) => {
        const batch = batches[batchIndex];
        return batch.buildSuggestion(batch.rankedCandidates[candidateIndex].candidate);
    });
};

export const buildBoundedQueryEditorCompletionSuggestions = <Candidate, Suggestion>(
    options: Parameters<typeof createBoundedQueryEditorCompletionCandidateBatch<Candidate, Suggestion>>[0],
): Suggestion[] => {
    const batch = createBoundedQueryEditorCompletionCandidateBatch(options);
    return materializeBoundedQueryEditorCompletionBatches([batch], options.limit);
};

export const selectUnqualifiedCompletionSynonyms = (
    synonyms: CompletionSynonymMeta[],
    loginOwnerName: string,
): CompletionSynonymMeta[] => {
    const loginOwner = String(loginOwnerName || '').trim().toLowerCase();
    const preferred = new Map<string, { synonym: CompletionSynonymMeta; rank: number }>();
    synonyms.forEach((synonym) => {
        const key = String(synonym.synonymName || '').trim().toLowerCase();
        const owner = String(synonym.ownerName || '').trim().toLowerCase();
        if (!key) return;
        const rank = loginOwner && owner === loginOwner ? 0 : owner === 'public' ? 1 : 2;
        if (rank > 1) return;
        const current = preferred.get(key);
        if (!current || rank < current.rank) {
            preferred.set(key, { synonym, rank });
        }
    });
    return Array.from(preferred.values(), ({ synonym }) => synonym);
};
