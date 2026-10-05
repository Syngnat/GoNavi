import {
    collectQueryEditorTableReferences, buildQueryEditorReferenceIdentityKeys,
    rankQueryEditorCompletionCandidate,
} from '../QueryEditorHelpers';
import type { createSqlCompletionDialectContext } from './sqlCompletionDialectContext';

export interface CreateSqlCompletionRankingContextInput {
    completionReferenceText: string;
    activeDialect: ReturnType<typeof createSqlCompletionDialectContext>['activeDialect'];
    getActiveCompletionDbName: ReturnType<typeof createSqlCompletionDialectContext>['getActiveCompletionDbName'];
    activeConnectionHasScopedMetadata: ReturnType<typeof createSqlCompletionDialectContext>['activeConnectionHasScopedMetadata'];
    word: ReturnType<typeof createSqlCompletionDialectContext>['word'];
    isTableSourceCompletion: boolean;
    linePrefix: string;
    dialectKeywords: ReturnType<typeof createSqlCompletionDialectContext>['dialectKeywords'];
    currentStatementPrefix: string;
}

export const createSqlCompletionRankingContext = ({
    completionReferenceText, activeDialect, getActiveCompletionDbName,
    activeConnectionHasScopedMetadata, word, isTableSourceCompletion, linePrefix, dialectKeywords,
    currentStatementPrefix,
}: CreateSqlCompletionRankingContextInput) => {
    // 2) global/table/column completion
    const foundTables = new Set<string>();
    for (const reference of collectQueryEditorTableReferences(completionReferenceText, activeDialect)) {
        buildQueryEditorReferenceIdentityKeys(reference, activeDialect).forEach((key) => {
            if (key) {
                foundTables.add(key);
            }
        });
    }

    const currentDatabase = getActiveCompletionDbName();
    const hasCompletionDatabaseScope = Boolean(currentDatabase) || activeConnectionHasScopedMetadata;
    const isCurrentCompletionDatabase = (dbName: string) =>
        String(dbName || '').toLowerCase() === currentDatabase.toLowerCase();
    const rawWordPrefix = String(word.word || '');
    const wordPrefix = rawWordPrefix.toLowerCase();
    const getPrefixMatchRank = (...candidates: string[]) => {
        if (!wordPrefix) return '0';
        const matchRank = rankQueryEditorCompletionCandidate(wordPrefix, candidates);
        return matchRank === null ? '9' : String(matchRank);
    };
    const expectsTableName = isTableSourceCompletion
        || /\b(?:TABLE|DESCRIBE|DESC|EXPLAIN)\s+[`"]?[\w.]*$/i.test(linePrefix);
    const expectsRoutineName = /\bCALL\s+[`"]?[\w.]*$/i.test(linePrefix);
    const matchesKeywordPrefix = wordPrefix.length > 0
        && dialectKeywords.some((keyword) => keyword.toLowerCase().startsWith(wordPrefix));
    const statementPrefixBeforeWord = currentStatementPrefix.slice(
        0,
        Math.max(0, currentStatementPrefix.length - String(word.word || '').length),
    );
    const isNewStatementKeywordContext = !expectsTableName
        && !expectsRoutineName
        && matchesKeywordPrefix
        && !statementPrefixBeforeWord.trim();
    const shouldBoostKeywords = !expectsTableName
        && !expectsRoutineName
        && matchesKeywordPrefix;
    const sortGroups = isNewStatementKeywordContext
        ? { keyword: '00', func: '10', routineCurrent: '11', routineOther: '12', tableCurrent: '20', tableOther: '21', columnCurrent: '30', columnOther: '31', db: '40' }
        : shouldBoostKeywords
        ? { keyword: '00', func: '05', routineCurrent: '06', routineOther: '07', columnCurrent: '10', columnOther: '11', tableCurrent: '20', tableOther: '21', db: '30' }
        : expectsRoutineName
            ? { keyword: '30', func: '40', routineCurrent: '00', routineOther: '01', columnCurrent: '20', columnOther: '21', tableCurrent: '10', tableOther: '11', db: '35' }
        : expectsTableName
            ? { keyword: '20', func: '25', routineCurrent: '26', routineOther: '27', columnCurrent: '10', columnOther: '11', tableCurrent: '00', tableOther: '01', db: '30' }
            : { keyword: '30', func: '25', routineCurrent: '26', routineOther: '27', columnCurrent: '00', columnOther: '01', tableCurrent: '10', tableOther: '11', db: '20' };
    return {
        foundTables, currentDatabase, hasCompletionDatabaseScope, isCurrentCompletionDatabase,
        rawWordPrefix, wordPrefix, getPrefixMatchRank, expectsTableName, expectsRoutineName,
        sortGroups,
    };
};
