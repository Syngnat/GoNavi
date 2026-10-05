import {
    sharedConnections, sharedCurrentConnectionId, sharedQueryEditorMetadataContextKey,
    sharedCurrentDb, sharedCurrentSchema,
} from '../queryEditorCompletionState';
import {
    resolveSqlDialect, isOracleLikeDialect, resolveSqlKeywords, resolveSqlFunctions,
} from '../../../utils/sqlDialect';
import {
    resolveOracleLikeDefaultSchemaName, stripCompletionIdentifierQuotes,
    normalizeCompletionQualifiedName, splitCompletionSchemaAndTable,
} from '../QueryEditorHelpers';
import { isPostgresSchemaDialect } from '../../../utils/connectionDriverType';
import { quoteIdentPart, quoteQualifiedIdent } from '../../../utils/sql';
import { applyQueryEditorCompletionFragmentCase } from '../QueryEditorAiAssist';
import { isConnectionScopedQueryEditorMetadata } from '../queryEditorLazyTablesCache';
import { peekDatabaseServerVersion } from '../queryEditorServerVersion';
import type { TabData } from '../../../types';

export interface CreateSqlCompletionDialectContextInput {
    model: any;
    position: any;
    currentDbRef: React.MutableRefObject<string>;
    currentDb: string;
    tab: TabData;
    currentConnectionIdRef: React.MutableRefObject<string>;
}

export const createSqlCompletionDialectContext = ({ model, position, currentDbRef, currentDb, tab, currentConnectionIdRef }: CreateSqlCompletionDialectContextInput) => {
    const word = model.getWordUntilPosition(position);
    const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
    };
    const activeConnection = sharedConnections.find(c => c.id === sharedCurrentConnectionId);
    const activeDialect = resolveSqlDialect(
        String(activeConnection?.config?.type || ''),
        String(activeConnection?.config?.driver || ''),
        { oceanBaseProtocol: activeConnection?.config?.oceanBaseProtocol },
    );
    const oracleLoginOwner = isOracleLikeDialect(activeDialect)
        ? resolveOracleLikeDefaultSchemaName(activeConnection?.config)
        : '';
    const shouldQuoteCompletionIdentifiers = isPostgresSchemaDialect(activeDialect);
    const quoteCompletionPart = (ident: string) => {
        const raw = String(ident || '').trim();
        if (!raw) return raw;
        return shouldQuoteCompletionIdentifiers ? quoteIdentPart(activeDialect, raw) : raw;
    };
    const quoteCompletionPath = (ident: string) => {
        const raw = String(ident || '').trim();
        if (!raw) return raw;
        return shouldQuoteCompletionIdentifiers ? quoteQualifiedIdent(activeDialect, raw) : raw;
    };
    const applyCompletionFragmentCase = (ident: string, fragment: string) => (
        shouldQuoteCompletionIdentifiers
            ? ident
            : applyQueryEditorCompletionFragmentCase(ident, fragment)
    );
    const getActiveCompletionDbName = () => String(
        sharedQueryEditorMetadataContextKey
            ? sharedCurrentDb
            : (currentDbRef.current ?? currentDb ?? tab.dbName ?? ''),
    ).trim();
    const getActiveCompletionSchemaName = () => (
        isPostgresSchemaDialect(activeDialect)
            ? String(sharedCurrentSchema || '').trim()
            : ''
    );
    const activeConnectionHasScopedMetadata = isConnectionScopedQueryEditorMetadata(activeConnection);
    const dialectKeywords = resolveSqlKeywords(activeDialect);
    // 版本感知补全（#1328）：已探测到的服务端版本喂给函数解析，
    // 低于函数最低版本的候选不出现在补全列表里。
    const activeServerVersion = peekDatabaseServerVersion(
        String(currentConnectionIdRef.current || '').trim(),
    );
    const dialectFunctions = resolveSqlFunctions(activeDialect, activeServerVersion);

    const stripQuotes = stripCompletionIdentifierQuotes;
    const normalizeQualifiedName = normalizeCompletionQualifiedName;
    const splitSchemaAndTable = splitCompletionSchemaAndTable;
    return {
        word, range, activeDialect, oracleLoginOwner, quoteCompletionPart, quoteCompletionPath,
        applyCompletionFragmentCase, getActiveCompletionDbName, getActiveCompletionSchemaName,
        activeConnectionHasScopedMetadata, dialectKeywords, dialectFunctions, stripQuotes,
        splitSchemaAndTable,
    };
};
