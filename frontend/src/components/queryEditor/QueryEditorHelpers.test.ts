import { describe, expect, it } from 'vitest';
import {
    buildBoundedQueryEditorCompletionSuggestions,
    appendQuerySelectExpressions,
    buildQueryEditorAliasMap,
    buildQueryEditorTableSourceAlias,
    buildQualifiedCompletionName,
    buildCompletionFunctionsMetadataQuerySpecs,
    buildCompletionViewsMetadataQuerySpecs,
    buildQueryEditorResultSetMergeKey,
    collectQueryEditorReferencedDatabaseNames,
    collectQueryEditorTableReferences,
    createBoundedQueryEditorCompletionCandidateBatch,
    findCompletionTablesByDatabase,
    getCompletionTableSchemaCounts,
    isSystemMetadataQueryResult,
    isOracleBaseTableReference,
    isQueryEditorTableAliasCompletionContext,
    isQueryEditorTableSourceAtPosition,
    isQueryEditorTableSourceCompletionContext,
    materializeBoundedQueryEditorCompletionBatches,
    rankQueryEditorCompletionCandidate,
    resolveQueryEditorCompletionFilterText,
    resolveQueryEditorConnectionTimeout,
    resolveOracleLikeDefaultSchemaName,
    resolveOracleLikeExecutionSchemaName,
    resolveOracleLikeLookupSchemaCandidates,
    resolveQueryEditorHoverTarget,
    resolveQueryEditorMonacoLanguage,
    resolveQueryEditorNavigationTarget,
    resolveNextQueryEditorTableLocateIndex,
    rewriteOracleSelectAllWithExpressions,
    selectUnqualifiedCompletionSynonyms,
    shouldHandleQueryEditorRunShortcutFallback,
    splitCompletionSchemaAndTable,
    splitTopLevelComma,
} from './QueryEditorHelpers';

describe('QueryEditor table locate cycle', () => {
    it('advances in order and wraps at the end of a line', () => {
        const signature = 'users\u0001orders\u0001items';
        expect(resolveNextQueryEditorTableLocateIndex(null, 2, signature, 3)).toBe(0);
        expect(resolveNextQueryEditorTableLocateIndex({ lineNumber: 2, signature, index: 0 }, 2, signature, 3)).toBe(1);
        expect(resolveNextQueryEditorTableLocateIndex({ lineNumber: 2, signature, index: 1 }, 2, signature, 3)).toBe(2);
        expect(resolveNextQueryEditorTableLocateIndex({ lineNumber: 2, signature, index: 2 }, 2, signature, 3)).toBe(0);
    });

    it('resets when the cursor line or references change', () => {
        const previous = { lineNumber: 2, signature: 'users\u0001orders', index: 1 };
        expect(resolveNextQueryEditorTableLocateIndex(previous, 3, previous.signature, 2)).toBe(0);
        expect(resolveNextQueryEditorTableLocateIndex(previous, 2, 'users\u0001items', 2)).toBe(0);
        expect(resolveNextQueryEditorTableLocateIndex(previous, 2, previous.signature, 0)).toBe(0);
    });
});

describe('QueryEditor SELECT structure parsing', () => {
    it.each([
        ['leading line comment', '-- exported row\nSELECT * FROM users'],
        ['leading block comment', '/* exported row */\nSELECT * FROM users'],
        ['comment in select list', 'SELECT * -- keep all columns\nFROM users'],
        ['comment before FROM table', 'SELECT * FROM /* source table */ users'],
    ])('recognizes a writable SELECT with %s', (_label, sql) => {
        const appended = appendQuerySelectExpressions(sql, ['id AS __gonavi_locator_1_id']);
        expect(appended).toContain('id AS __gonavi_locator_1_id');
        expect(appended).toMatch(/SELECT[\s\S]+FROM[\s\S]+users/i);
        expect(appended).not.toMatch(/--[^\n]*id AS __gonavi_locator_1_id/i);
    });

    it('does not split select items on commas inside comments or bracket identifiers', () => {
        expect(splitTopLevelComma('id /* historical, retained */, [name, legacy], code -- source, legacy\n'))
            .toEqual(['id /* historical, retained */', '[name, legacy]', 'code -- source, legacy']);
    });

    it('preserves comments when Oracle adds a hidden row locator to SELECT *', () => {
        const sql = '-- exported row\nSELECT * /* current fields */\nFROM /* live source */ users';
        expect(rewriteOracleSelectAllWithExpressions(sql, ['ROWID AS "__gonavi_oracle_rowid__"']))
            .toBe('-- exported row\nSELECT gonavi_query_source.*, gonavi_query_source.ROWID AS "__gonavi_oracle_rowid__" /* current fields */\nFROM /* live source */ users gonavi_query_source');
    });
});

describe('QueryEditor connection timeout', () => {
    it('keeps the configured MySQL timeout instead of forcing a 120 second minimum', () => {
        expect(resolveQueryEditorConnectionTimeout({ type: 'mysql' })).toBe(30);
        expect(resolveQueryEditorConnectionTimeout({ type: 'mysql', timeout: 45 })).toBe(45);
        expect(resolveQueryEditorConnectionTimeout({ type: 'mysql', timeout: 300 })).toBe(300);
    });

    it.each([
        [{ type: 'goldendb', timeout: 45 }, 45],
        [{ type: 'custom', driver: 'gdb', timeout: 60 }, 60],
    ])('keeps the configured connection timeout for compatible config %#', (config, expected) => {
        expect(resolveQueryEditorConnectionTimeout(config)).toBe(expected);
    });

    it.each([
        [{ type: 'postgres', timeout: 30 }, 30],
        [{ type: 'oracle', timeout: 45 }, 45],
        [{ type: 'elasticsearch', timeout: 60 }, 60],
    ])('keeps the configured connection timeout for every data source %#', (config, expected) => {
        expect(resolveQueryEditorConnectionTimeout(config)).toBe(expected);
    });
});

describe('QueryEditor result merge identity', () => {
    it('keeps zero-based Elasticsearch request indexes distinct', () => {
        const first = buildQueryEditorResultSetMergeKey({
            sql: 'GET /events/_count',
            sourceStatementIndex: 0,
            statementResultIndex: 0,
        });
        const second = buildQueryEditorResultSetMergeKey({
            sql: 'GET /events/_count',
            sourceStatementIndex: 1,
            statementResultIndex: 0,
        });

        expect(first).not.toBe(second);
        expect(first).toContain('::0::0');
        expect(second).toContain('::1::0');
    });
});

describe('QueryEditor system metadata guard', () => {
    it('keeps SQL Server system schemas read-only when metadata uses the current database', () => {
        expect(isSystemMetadataQueryResult({
            tableName: 'sys.objects',
            metadataDbName: 'appdb',
            metadataTableName: 'sys.objects',
        }, 'sqlserver')).toBe(true);
        expect(isSystemMetadataQueryResult({
            tableName: 'INFORMATION_SCHEMA.TABLES',
            metadataDbName: 'appdb',
            metadataTableName: '[INFORMATION_SCHEMA].[TABLES]',
        }, 'mssql')).toBe(true);
        expect(isSystemMetadataQueryResult({
            tableName: 'dbo.orders',
            metadataDbName: 'appdb',
            metadataTableName: 'dbo.orders',
        }, 'sqlserver')).toBe(false);
    });
});

describe('QueryEditor completion candidate budget', () => {
    it('builds at most the budget after ranking exact, prefix, and substring matches', () => {
        const candidates = [
            ...Array.from({ length: 5_000 }, (_, index) => `archive_entity_${String(index).padStart(4, '0')}`),
            'entity_primary',
            'entity',
        ];
        let materialized = 0;

        const suggestions = buildBoundedQueryEditorCompletionSuggestions({
            candidates,
            prefix: 'entity',
            getMatchRank: (candidate, prefix) => rankQueryEditorCompletionCandidate(prefix, [candidate]),
            getSelectionKey: (candidate, _prefix, rank) => `${rank}${candidate}`,
            buildSuggestion: (candidate) => {
                materialized += 1;
                const rank = rankQueryEditorCompletionCandidate('entity', [candidate]);
                return { label: candidate, sortText: `${rank}${candidate}` };
            },
        });

        expect(suggestions).toHaveLength(200);
        expect(materialized).toBe(200);
        expect(suggestions.slice(0, 2).map((item) => item.label)).toEqual(['entity', 'entity_primary']);
    });

    it('stops scanning an empty-prefix source once the budget is full', () => {
        let inspected = 0;
        const candidates = Array.from({ length: 10_000 }, (_, index) => `table_${String(index).padStart(5, '0')}`);

        const suggestions = buildBoundedQueryEditorCompletionSuggestions({
            candidates,
            prefix: '',
            getMatchRank: () => {
                inspected += 1;
                return 0;
            },
            getSelectionKey: (candidate) => candidate,
            buildSuggestion: (candidate) => ({ label: candidate }),
            sourceAlreadySortedBySelection: true,
        });

        expect(suggestions).toHaveLength(200);
        expect(inspected).toBe(200);
    });

    it('keeps a late same-rank candidate when its final sort key is better', () => {
        const candidates = [
            ...Array.from({ length: 200 }, (_, index) => ({
                label: `other_${index}`,
                sortText: `10${String(index).padStart(3, '0')}`,
            })),
            { label: 'current_late', sortText: '00current_late' },
        ];
        let materialized = 0;

        const suggestions = buildBoundedQueryEditorCompletionSuggestions({
            candidates,
            prefix: '',
            getMatchRank: () => 0,
            getSelectionKey: (candidate) => candidate.sortText,
            buildSuggestion: (candidate) => {
                materialized += 1;
                return candidate;
            },
        });

        expect(suggestions).toHaveLength(200);
        expect(materialized).toBe(200);
        expect(suggestions.map((item) => item.label)).toContain('current_late');
    });

    it('uses final sortText semantics when a late exact match ranks after current-database prefixes', () => {
        const candidates = [
            ...Array.from({ length: 200 }, (_, index) => ({
                label: `current_prefix_${String(index).padStart(3, '0')}`,
                matchRank: 1 as const,
                sortText: `00current_${String(index).padStart(3, '0')}`,
            })),
            { label: 'other_exact', matchRank: 0 as const, sortText: '01other_exact' },
        ];

        const suggestions = buildBoundedQueryEditorCompletionSuggestions({
            candidates,
            prefix: 'target',
            getMatchRank: (candidate) => candidate.matchRank,
            getSelectionKey: (candidate) => candidate.sortText,
            buildSuggestion: (candidate) => candidate,
        });

        expect(suggestions).toHaveLength(200);
        expect(suggestions.map((item) => item.label)).not.toContain('other_exact');
        expect(suggestions[199]?.label).toBe('current_prefix_199');
    });

    it('materializes at most one global budget across nine completion categories', () => {
        let materialized = 0;
        const batches = Array.from({ length: 9 }, (_, groupIndex) => (
            createBoundedQueryEditorCompletionCandidateBatch({
                candidates: Array.from({ length: 500 }, (_, candidateIndex) => ({
                    label: `group_${groupIndex}_${candidateIndex}`,
                    sortText: `${String(groupIndex).padStart(2, '0')}${String(candidateIndex).padStart(3, '0')}`,
                })),
                prefix: '',
                getMatchRank: () => 0,
                getSelectionKey: (candidate) => candidate.sortText,
                buildSuggestion: (candidate) => {
                    materialized += 1;
                    return candidate;
                },
            })
        ));

        expect(materialized).toBe(0);
        const suggestions = materializeBoundedQueryEditorCompletionBatches(batches);

        expect(suggestions).toHaveLength(200);
        expect(materialized).toBe(200);
        expect(suggestions[0]?.label).toBe('group_0_0');
        expect(suggestions[199]?.label).toBe('group_0_199');
    });

    it('caches schema counts on the current-database partition without reading other table names', () => {
        let currentTableNameReads = 0;
        let otherTableNameReads = 0;
        const currentTables = Array.from({ length: 3 }, (_, index) => ({
            dbName: 'main',
            get tableName() {
                currentTableNameReads += 1;
                return index < 2 ? `schema_${index}.users` : 'orders';
            },
        }));
        const otherTables = Array.from({ length: 5_000 }, (_, index) => ({
            dbName: 'archive',
            get tableName() {
                otherTableNameReads += 1;
                return `archive_${index}`;
            },
        }));
        const allTables = [...otherTables, ...currentTables];

        const firstPartition = findCompletionTablesByDatabase(allTables, 'main');
        const firstCounts = getCompletionTableSchemaCounts(firstPartition);
        const secondPartition = findCompletionTablesByDatabase(allTables, 'main');
        const secondCounts = getCompletionTableSchemaCounts(secondPartition);

        expect(firstPartition).toBe(secondPartition);
        expect(firstCounts).toBe(secondCounts);
        expect(firstCounts.get('users')).toBe(2);
        expect(firstCounts.get('orders')).toBe(1);
        expect(currentTableNameReads).toBe(3);
        expect(otherTableNameReads).toBe(0);
    });

    it('keeps PostgreSQL database partitions case-distinct', () => {
        const tables = [
            { dbName: 'app', tableName: 'public.users' },
            { dbName: 'App', tableName: 'public.Users' },
        ];

        expect(findCompletionTablesByDatabase(tables, 'app', 'postgres')).toEqual([
            tables[0],
        ]);
        expect(findCompletionTablesByDatabase(tables, 'App', 'postgres')).toEqual([
            tables[1],
        ]);
    });

    it('preserves PostgreSQL quoted table case in schema duplicate counts', () => {
        const tables = [
            { dbName: 'app', tableName: 'public.users' },
            { dbName: 'app', tableName: 'public.Users' },
        ];

        const postgresCounts = getCompletionTableSchemaCounts(tables, 'postgres');
        const mysqlCounts = getCompletionTableSchemaCounts(tables, 'mysql');

        expect(postgresCounts.get('users')).toBe(1);
        expect(postgresCounts.get('Users')).toBe(1);
        expect(mysqlCounts.get('users')).toBe(2);
    });
});

describe('QueryEditor completion filter text', () => {
    it('returns the matching suffix for Monaco substring filtering', () => {
        expect(resolveQueryEditorCompletionFilterText('title', ['short_title'])).toBe('title');
        expect(resolveQueryEditorCompletionFilterText('title', ['subtitle'])).toBe('title');
    });

    it('does not override the filter text for an empty prefix or a non-match', () => {
        expect(resolveQueryEditorCompletionFilterText('', ['short_title'])).toBeUndefined();
        expect(resolveQueryEditorCompletionFilterText('name', ['short_title'])).toBeUndefined();
    });
});

describe('QueryEditor Monaco SQL grammar', () => {
    it.each([
        [{ config: { type: 'mysql' } }, 'mysql'],
        [{ config: { type: 'mariadb' } }, 'mysql'],
        [{ config: { type: 'custom', driver: 'greatdb' } }, 'mysql'],
        [{ config: { type: 'oceanbase', oceanBaseProtocol: 'mysql' } }, 'mysql'],
        [{ config: { type: 'oceanbase', oceanBaseProtocol: 'oracle' } }, 'sql'],
        [{ config: { type: 'postgres' } }, 'sql'],
        [{ config: { type: 'elasticsearch' } }, 'elasticsearch-console'],
    ])('maps connection row %# to the expected Monaco grammar', (connection, expectedLanguage) => {
        expect(resolveQueryEditorMonacoLanguage(connection)).toBe(expectedLanguage);
    });
});

describe('QueryEditor run shortcut routing', () => {
    it('reserves editor-originated shortcuts for Monaco and keeps document targets as a fallback', () => {
        const editorTarget = {} as Node;
        const editorPane = {
            contains: (node: Node) => node === editorTarget,
        } as Pick<Node, 'contains'>;

        expect(shouldHandleQueryEditorRunShortcutFallback({
            editorHasFocus: true,
            targetNode: editorTarget,
            editorPane,
        })).toBe(false);
        expect(shouldHandleQueryEditorRunShortcutFallback({
            editorHasFocus: true,
            targetNode: null,
            editorPane,
        })).toBe(true);
        expect(shouldHandleQueryEditorRunShortcutFallback({
            editorHasFocus: false,
            targetNode: null,
            editorPane,
        })).toBe(false);
    });
});

describe('QueryEditorHelpers Oracle-like execution schema', () => {
    it('uses the selected schema when it differs from the login user', () => {
        const config = {
            type: 'oceanbase',
            oceanBaseProtocol: 'oracle',
            user: 'SBDEVREAD',
            database: 'SBDEV',
        };

        expect(resolveOracleLikeDefaultSchemaName(config)).toBe('SBDEVREAD');
        expect(resolveOracleLikeExecutionSchemaName(config, 'SBDEV')).toBe('SBDEVREAD');
        expect(resolveOracleLikeLookupSchemaCandidates(config, 'SBDEV')).toEqual(['SBDEVREAD', 'SBDEV']);
    });

    it('keeps the login user schema when the selected schema is the same owner', () => {
        const config = {
            type: 'oracle',
            user: 'APP_OWNER',
            database: 'ORCLPDB1',
        };

        expect(resolveOracleLikeExecutionSchemaName(config, 'APP_OWNER')).toBe('APP_OWNER');
        expect(resolveOracleLikeLookupSchemaCandidates(config, 'APP_OWNER')).toEqual(['APP_OWNER']);
    });

    it('recognizes base tables but not synonyms when deciding whether ROWID is safe', () => {
        const baseTables = [
            { dbName: 'A', tableName: 'A.PERSON' },
            { dbName: 'B', tableName: 'B.ORDERS' },
        ];

        expect(isOracleBaseTableReference('SELECT * FROM A.person', 'A', baseTables)).toBe(true);
        expect(isOracleBaseTableReference('SELECT * FROM person', 'B', baseTables)).toBe(false);
        expect(isOracleBaseTableReference('SELECT * FROM person_view', 'B', baseTables)).toBe(false);
    });

    it('prefers login-owner synonyms, falls back to PUBLIC, and excludes other owners', () => {
        const otherOwner = { ownerName: 'IMP_BASICINFO', synonymName: 'PERSON', targetName: 'OTHER_PERSON' };
        const publicOwner = { ownerName: 'PUBLIC', synonymName: 'PERSON', targetName: 'PUBLIC_PERSON' };
        const loginOwner = { ownerName: 'B', synonymName: 'PERSON', targetName: 'LOGIN_PERSON' };
        const otherOnly = { ownerName: 'IMP_BASICINFO', synonymName: 'AC02', targetName: 'AC02' };

        expect(selectUnqualifiedCompletionSynonyms(
            [otherOwner, publicOwner, otherOnly, loginOwner],
            'B',
        )).toEqual([loginOwner]);
        expect(selectUnqualifiedCompletionSynonyms([otherOwner, publicOwner, otherOnly], 'B')).toEqual([publicOwner]);
    });
});

describe('QueryEditorHelpers qualified navigation (MySQL db.table + PG schema.table)', () => {
    it('keeps a dot inside a quoted object name when adding its schema', () => {
        expect(buildQualifiedCompletionName('audit', '"order.items"')).toBe('audit."order.items"');
        expect(buildQualifiedCompletionName('audit', 'audit.orders')).toBe('audit.orders');
        expect(buildQualifiedCompletionName('audit', 'order.items', 'sqlserver')).toBe('audit.[order.items]');
        expect(buildQualifiedCompletionName('audit', 'order.items', 'mysql')).toBe('audit.`order.items`');
    });

    it('generates table source aliases from name initials and resolves collisions', () => {
        expect(buildQueryEditorTableSourceAlias('system_user', '')).toBe('su');
        expect(buildQueryEditorTableSourceAlias('code_query_record_zykj', '')).toBe('cqrz');
        expect(buildQueryEditorTableSourceAlias('public.system_user', 'SELECT * FROM system_user su')).toBe('su2');
        expect(buildQueryEditorTableSourceAlias('system_user', 'SELECT * FROM system_user su JOIN service_user su2')).toBe('su3');
    });

    it('uses a valid custom prefix with continuous case-insensitive numbering', () => {
        expect(buildQueryEditorTableSourceAlias('system_user', '', 'mysql', 't')).toBe('t0');
        expect(buildQueryEditorTableSourceAlias('service_user', 'SELECT * FROM system_user t0', 'mysql', 't')).toBe('t1');
        expect(buildQueryEditorTableSourceAlias('audit_user', 'SELECT * FROM system_user t0 JOIN service_user t1', 'mysql', 't')).toBe('t2');
        expect(buildQueryEditorTableSourceAlias('public.system_user', 'SELECT * FROM system_user T0', 'mysql', 't')).toBe('t1');
        expect(buildQueryEditorTableSourceAlias('system_user', '', 'oracle', 'T')).toBe('T0');
        expect(buildQueryEditorTableSourceAlias('service_user', 'SELECT * FROM system_user t0', 'oracle', 'T')).toBe('T1');
        expect(buildQueryEditorTableSourceAlias('audit_user', 'SELECT * FROM system_user T0 JOIN service_user T1', 'oracle', 'T')).toBe('T2');
    });

    it('falls back to table-name aliases for disabled or invalid custom prefixes', () => {
        expect(buildQueryEditorTableSourceAlias('system_user', '', 'mysql', '')).toBe('su');
        expect(buildQueryEditorTableSourceAlias('system_user', '', 'mysql', '1invalid')).toBe('su');
        expect(buildQueryEditorTableSourceAlias('system_user', 'SELECT * FROM system_user su', 'mysql', 'a'.repeat(25))).toBe('su2');
    });

    it('only permits table aliases for SELECT table sources', () => {
        for (const sql of [
            'UPDATE system_user ',
            'DELETE FROM system_user ',
            'INSERT INTO system_user ',
            'REPLACE INTO system_user ',
            'MERGE INTO system_user ',
        ]) {
            expect(isQueryEditorTableSourceCompletionContext(sql)).toBe(true);
            expect(isQueryEditorTableAliasCompletionContext(sql)).toBe(false);
        }

        for (const sql of [
            'SELECT * FROM system_user ',
            "SELECT REPLACE(name, 'x', 'y') FROM system_user ",
            'SELECT INSERT(name, 1, 0, \'x\') FROM system_user ',
            'SELECT * FROM system_user su JOIN service_user ',
            'SELECT * FROM system_user su, service_user ',
            'INSERT INTO audit_log SELECT * FROM system_user ',
            'INSERT INTO audit_log SELECT * FROM (SELECT * FROM system_user ',
        ]) {
            expect(isQueryEditorTableSourceCompletionContext(sql)).toBe(true);
            expect(isQueryEditorTableAliasCompletionContext(sql)).toBe(true);
        }
    });

    it('keeps a dotted Dameng owner intact when metadata already identifies it', () => {
        expect(splitCompletionSchemaAndTable(
            'PEM2.4_V1_1.COM_APPROVE_INFO',
            'PEM2.4_V1_1',
        )).toEqual({
            schema: 'PEM2.4_V1_1',
            table: 'COM_APPROVE_INFO',
        });
        expect(splitCompletionSchemaAndTable(
            '"PEM2.4_V1_1"."COM_APPROVE_INFO"',
        )).toEqual({
            schema: 'PEM2.4_V1_1',
            table: 'COM_APPROVE_INFO',
        });

        const sql = 'select * from PEM2.4_V1_1.COM_APPROVE_INFO';
        expect(resolveQueryEditorNavigationTarget(
            sql,
            sql.length,
            'PEM2.4_V1_1',
            ['PEM2.4_V1_1'],
            [{ dbName: 'PEM2.4_V1_1', tableName: 'COM_APPROVE_INFO' }],
        )).toEqual({
            type: 'table',
            dbName: 'PEM2.4_V1_1',
            tableName: 'COM_APPROVE_INFO',
            schemaName: undefined,
        });
    });

    it('tracks an explicit two-part owner separately from the current database', () => {
        const qualified = buildQueryEditorAliasMap('SELECT p.* FROM IMP_BASICINFO.PERSON p', 'A');
        expect(qualified.p).toEqual({
            dbName: 'IMP_BASICINFO',
            tableName: 'PERSON',
            explicitOwnerName: 'IMP_BASICINFO',
        });

        const unqualified = buildQueryEditorAliasMap('SELECT p.* FROM PERSON p', 'A');
        expect(unqualified.p).toEqual({ dbName: 'A', tableName: 'PERSON' });
    });

    it('uses a supplied full-document alias map when resolving a local hover probe', () => {
        const fullSql = 'SELECT u.id\nFROM users u';
        const aliasMap = buildQueryEditorAliasMap(fullSql, 'app');

        expect(resolveQueryEditorHoverTarget(
            'u.id',
            'u.id',
            2,
            'app',
            ['app'],
            [{ dbName: 'app', tableName: 'users' }],
            [{ dbName: 'app', tableName: 'users', name: 'id', type: 'bigint' }],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: 'u.id', offset: 1 },
            '',
            aliasMap,
        )).toMatchObject({
            kind: 'column',
            dbName: 'app',
            tableName: 'users',
            columnName: 'id',
        });
    });

    it('resolves columns through a schema-qualified PostgreSQL alias in the current database', () => {
        const fullSql = 'SELECT u.id FROM sales.users u';
        const aliasMap = buildQueryEditorAliasMap(fullSql, 'app');

        expect(resolveQueryEditorHoverTarget(
            'u.id',
            'u.id',
            2,
            'app',
            ['app', 'sales'],
            [
                { dbName: 'sales', tableName: 'users' },
                { dbName: 'app', tableName: 'sales.users' },
            ],
            [
                { dbName: 'sales', tableName: 'users', name: 'id', type: 'text' },
                { dbName: 'app', tableName: 'sales.users', name: 'id', type: 'bigint' },
            ],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: 'u.id', offset: 1 },
            'sales',
            aliasMap,
            false,
            'postgres',
        )).toMatchObject({
            kind: 'column',
            dbName: 'app',
            tableName: 'sales.users',
            columnName: 'id',
            schemaName: 'sales',
        });
    });

    it('resolves a three-part schema.table.column reference as a column when metadata matches', () => {
        const sql = 'SELECT sales.users.id FROM sales.users';
        const qualifiedColumn = 'sales.users.id';
        const columnEndColumn = sql.indexOf(qualifiedColumn) + qualifiedColumn.length;
        expect(resolveQueryEditorHoverTarget(
            sql,
            sql,
            columnEndColumn,
            'app',
            ['app'],
            [{ dbName: 'app', tableName: 'sales.users' }],
            [{ dbName: 'app', tableName: 'sales.users', name: 'id', type: 'bigint', comment: 'primary key' }],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: columnEndColumn - 1 },
            'sales',
            undefined,
            true,
        )).toMatchObject({
            kind: 'column',
            dbName: 'app',
            tableName: 'sales.users',
            columnName: 'id',
            type: 'bigint',
        });
    });

    it('collects table names and aliases from comma-separated FROM sources', () => {
        const aliases = buildQueryEditorAliasMap(
            'SELECT * FROM VULNERABILITY_INFO_T a, VULNERABILITY_DETAIL_T b '
            + 'WHERE VULNERABILITY_INFO_T.CODE = VULNERABILITY_DETAIL_T.',
            'DEV',
        );

        expect(aliases.vulnerability_info_t).toEqual({ dbName: 'DEV', tableName: 'VULNERABILITY_INFO_T' });
        expect(aliases.a).toEqual({ dbName: 'DEV', tableName: 'VULNERABILITY_INFO_T' });
        expect(aliases.vulnerability_detail_t).toEqual({ dbName: 'DEV', tableName: 'VULNERABILITY_DETAIL_T' });
        expect(aliases.b).toEqual({ dbName: 'DEV', tableName: 'VULNERABILITY_DETAIL_T' });
    });

    it('ignores expression commas, literals, comments, and table-valued functions', () => {
        const references = collectQueryEditorTableReferences(`
SELECT concat(a.code, 'FROM fake_one f, fake_two g'), a.name
FROM (
    SELECT * FROM inner_a ia, inner_b ib
) nested
JOIN generate_series(1, 2) series ON true
JOIN outer_table ot ON ot.id = nested.id
WHERE fn(ot.code, ot.name) = '-- JOIN fake_three z'
/* FROM fake_four q, fake_five w */
ORDER BY ot.code, ot.name
        `);

        expect(references.map((reference) => reference.tableIdent)).toEqual([
            'inner_a',
            'inner_b',
            'outer_table',
        ]);
        expect(references.map((reference) => reference.alias)).toEqual(['ia', 'ib', 'ot']);
    });

    it('preserves quoted identifier parts and allows quoted reserved aliases', () => {
        const references = collectQueryEditorTableReferences(
            'SELECT * FROM "Odd.Schema"."Table.Name" AS "where", [dbo].[Other Table] b',
        );

        expect(references).toEqual([
            {
                tableIdent: 'Odd.Schema.Table.Name',
                parts: ['Odd.Schema', 'Table.Name'],
                alias: 'where',
            },
            {
                tableIdent: 'dbo.Other Table',
                parts: ['dbo', 'Other Table'],
                alias: 'b',
            },
        ]);
    });

    it('keeps INSERT, UPDATE, and DELETE targets while skipping FROM table-valued functions', () => {
        const references = collectQueryEditorTableReferences(`
INSERT INTO audit_log (id, name) VALUES (1, 'created');
UPDATE users SET name = 'updated' WHERE id = 1;
DELETE FROM expired_sessions WHERE expires_at < CURRENT_TIMESTAMP;
SELECT * FROM generate_series(1, 2) series JOIN active_users au ON true;
        `);

        expect(references.map((reference) => reference.tableIdent)).toEqual([
            'audit_log',
            'users',
            'expired_sessions',
            'active_users',
        ]);
    });

    it('keeps PostgreSQL JSONB operators and ignores FROM inside SQL expressions', () => {
        const references = collectQueryEditorTableReferences(`
SELECT payload #>> '{id}',
       EXTRACT(YEAR FROM created_at),
       TRIM(BOTH ' ' FROM display_name)
FROM events e
WHERE e.id > 0
        `);

        expect(references).toEqual([{
            tableIdent: 'events',
            parts: ['events'],
            alias: 'e',
        }]);
    });

    it('recognizes table completion after a comma but not after an alias or WHERE clause', () => {
        expect(isQueryEditorTableSourceCompletionContext('SELECT * FROM users u, hrmres')).toBe(true);
        expect(isQueryEditorTableSourceCompletionContext('SELECT * FROM users u,')).toBe(true);
        expect(isQueryEditorTableSourceCompletionContext('SELECT * FROM users u')).toBe(false);
        expect(isQueryEditorTableSourceCompletionContext('SELECT * FROM users.')).toBe(false);
        expect(isQueryEditorTableAliasCompletionContext('SELECT * FROM public.')).toBe(true);
        expect(isQueryEditorTableAliasCompletionContext('INSERT INTO users.')).toBe(false);
        expect(isQueryEditorTableAliasCompletionContext('REPLACE INTO users.')).toBe(false);
        expect(isQueryEditorTableSourceCompletionContext('SELECT * FROM users WHERE id = 1')).toBe(false);
        expect(isQueryEditorTableSourceCompletionContext('SELECT EXTRACT(YEAR FROM created_at)')).toBe(false);
        const columnSql = 'SELECT users.id FROM users';
        const columnOffset = columnSql.indexOf('users.id') + 'users.id'.length - 1;
        expect(isQueryEditorTableSourceAtPosition(columnSql, 1, columnOffset + 1)).toBe(false);
    });

    it('collects cross-db names from SQL without requiring an empty visible list', () => {
        const sql = `
SELECT * FROM uk_back_corp u, reporting.audit_log a;
SELECT * FROM front_end_sys_new.fs_mkefu_regist_record WHERE mobile = '1';
DELETE FROM front_end_sys_new.fs_mkefu_regist_record WHERE mobile = '1';
SELECT * FROM public.users;
SELECT * FROM analytics.public.events;
`;
        const names = collectQueryEditorReferencedDatabaseNames(
            sql,
            'mkefu_test_new',
            ['mkefu_test_new', 'front_end_sys_new', 'analytics', 'reporting'],
        );
        expect(names).toEqual(expect.arrayContaining([
            'mkefu_test_new',
            'front_end_sys_new',
            'analytics',
            'reporting',
        ]));
        // public 是常见 schema，两段时不应当成库去拉取
        expect(names.map((name) => name.toLowerCase())).not.toContain('public');
    });

    it('infers MySQL-style db.table even when the db is not yet in visibleDbs', () => {
        const names = collectQueryEditorReferencedDatabaseNames(
            "SELECT * FROM front_end_sys_new.fs_mkefu_regist_record",
            'mkefu_test_new',
            ['mkefu_test_new'],
        );
        expect(names).toEqual(expect.arrayContaining(['mkefu_test_new', 'front_end_sys_new']));
    });

    it('does not treat PostgreSQL schema.table as a cross-database reference', () => {
        expect(collectQueryEditorReferencedDatabaseNames(
            'SELECT * FROM billing.orders',
            'appdb',
            ['appdb', 'billing'],
            'postgres',
        )).toEqual(['appdb']);
        expect(collectQueryEditorReferencedDatabaseNames(
            'SELECT * FROM analytics.public.events',
            'appdb',
            ['appdb', 'analytics'],
            'postgres',
        )).toEqual(['appdb', 'analytics']);
    });

    it.each(['trino', 'iris'])(
        'does not treat %s schema.table as a cross-database reference',
        (dialect) => {
            expect(collectQueryEditorReferencedDatabaseNames(
                'SELECT * FROM billing.orders',
                'appdb',
                ['appdb', 'billing'],
                dialect,
            )).toEqual(['appdb']);
        },
    );

    it('keeps SQLite main.table references in the connection scope', () => {
        expect(collectQueryEditorReferencedDatabaseNames(
            'SELECT * FROM main.users',
            '',
            ['main'],
            'sqlite',
        )).toEqual([]);
    });

    it('does not treat IoTDB timeseries path roots as metadata databases', () => {
        expect(collectQueryEditorReferencedDatabaseNames(
            'SELECT * FROM root.ln.wf01.wt01',
            'root.sg',
            ['root.ln', 'root.sg'],
            'iotdb',
        )).toEqual(['root.sg', 'root.ln']);
        expect(collectQueryEditorReferencedDatabaseNames(
            'SELECT * FROM root.other.wf01.wt01',
            'root.sg',
            ['root.ln', 'root.sg'],
            'iotdb',
        )).toEqual(['root.sg']);
    });

    it('treats Trino catalog.schema.table as a namespace, not the catalog alone', () => {
        expect(collectQueryEditorReferencedDatabaseNames(
            'SELECT * FROM hive.sales.orders',
            'iceberg.default',
            ['hive.sales', 'iceberg.default'],
            'trino',
        )).toEqual(['iceberg.default', 'hive.sales']);
        expect(collectQueryEditorReferencedDatabaseNames(
            'SELECT * FROM sales.orders',
            'hive.sales',
            ['hive.sales', 'hive.billing'],
            'trino',
        )).toEqual(['hive.sales']);
    });

    it('treats Oracle and Dameng qualified owners as metadata databases', () => {
        const sql = [
            'SELECT * FROM B.local_table',
            'SELECT * FROM A.remote_view',
            'SELECT * FROM C.pkg.proc_name',
        ].join('\n');

        expect(collectQueryEditorReferencedDatabaseNames(
            sql,
            'B',
            ['A', 'B'],
            'oracle',
        )).toEqual(['B', 'A', 'C']);
        expect(collectQueryEditorReferencedDatabaseNames(
            sql,
            'B',
            ['A', 'B'],
            'dameng',
        )).toEqual(['B', 'A', 'C']);
    });

    it('omits Oracle login-owner fallback queries for an explicitly selected remote owner', () => {
        const viewSpecs = buildCompletionViewsMetadataQuerySpecs('oracle', 'A', {
            includeCurrentOwnerFallback: false,
        });
        const routineSpecs = buildCompletionFunctionsMetadataQuerySpecs('oracle', 'A', {
            includeCurrentOwnerFallback: false,
        });

        expect(viewSpecs).toHaveLength(1);
        expect(viewSpecs[0].sql).toContain("FROM ALL_VIEWS WHERE OWNER = 'A'");
        expect(viewSpecs[0].sql).not.toContain('USER_VIEWS');
        expect(routineSpecs).toHaveLength(1);
        expect(routineSpecs[0].sql).toContain("FROM ALL_OBJECTS WHERE OWNER = 'A'");
        expect(routineSpecs[0].sql).not.toContain('USER_OBJECTS');
    });

    it('resolves MySQL db.table when the database is visible', () => {
        const tables = [
            { dbName: 'mkefu_test_new', tableName: 'uk_back_corp' },
            { dbName: 'front_end_sys_new', tableName: 'fs_mkefu_regist_record' },
        ];
        const sql = 'SELECT * FROM front_end_sys_new.fs_mkefu_regist_record';
        expect(resolveQueryEditorNavigationTarget(
            sql,
            sql.length,
            'mkefu_test_new',
            ['mkefu_test_new', 'front_end_sys_new'],
            tables,
        )).toEqual({
            type: 'table',
            dbName: 'front_end_sys_new',
            tableName: 'fs_mkefu_regist_record',
            schemaName: undefined,
        });
    });

    it('prefers an unqualified table in the selected database over a same-name visible database', () => {
        const sql = 'SELECT * FROM test';
        const tables = [{ dbName: 'ecom_dev_0705', tableName: 'test' }];
        const visibleDbs = ['ecom_dev_0705', 'ecom_test_0705', 'test'];

        expect(resolveQueryEditorNavigationTarget(
            sql,
            sql.length,
            'ecom_dev_0705',
            visibleDbs,
            tables,
        )).toEqual({
            type: 'table',
            dbName: 'ecom_dev_0705',
            tableName: 'test',
            schemaName: undefined,
        });
        expect(resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'ecom_dev_0705',
            visibleDbs,
            tables,
            [],
        )).toEqual(expect.objectContaining({
            kind: 'table',
            dbName: 'ecom_dev_0705',
            tableName: 'test',
        }));

        expect(resolveQueryEditorNavigationTarget(
            'USE test',
            'USE test'.length,
            'ecom_dev_0705',
            visibleDbs,
            tables,
        )).toEqual({ type: 'database', dbName: 'test' });
    });

    it('keeps a multiline table source in the selected database over a same-name visible database', () => {
        const sql = 'SELECT *\nFROM\n  test';
        const tables = [{ dbName: 'ecom_dev_0705', tableName: 'test' }];
        const visibleDbs = ['ecom_dev_0705', 'test'];

        expect(isQueryEditorTableSourceAtPosition(sql, 3, 7)).toBe(true);
        expect(resolveQueryEditorNavigationTarget(
            '  test',
            7,
            'ecom_dev_0705',
            visibleDbs,
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            true,
        )).toEqual({
            type: 'table',
            dbName: 'ecom_dev_0705',
            tableName: 'test',
            schemaName: undefined,
        });
    });

    it('resolves a connection-scoped table when the database name is empty', () => {
        const sql = 'SELECT * FROM users';
        expect(resolveQueryEditorNavigationTarget(
            sql,
            sql.length,
            '',
            [],
            [{ dbName: '', tableName: 'users' }],
        )).toEqual({
            type: 'table',
            dbName: '',
            tableName: 'users',
            schemaName: undefined,
        });
    });

    it('resolves a SQLite main.table reference against connection-scoped metadata', () => {
        const sql = 'SELECT * FROM main.users';
        expect(resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            '',
            ['main'],
            [{ dbName: '', tableName: 'users' }],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: sql.length - 1 },
            '',
            undefined,
            true,
            'sqlite',
        )).toMatchObject({ kind: 'table', dbName: '', tableName: 'users' });

        expect(resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'main',
            ['main'],
            [{ dbName: 'main', tableName: 'users' }],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: sql.length - 1 },
            '',
            undefined,
            true,
            'sqlite',
        )).toMatchObject({ kind: 'table', dbName: 'main', tableName: 'users' });
    });

    it('keeps a SQLite bracketed dotted catalog name out of the schema slot', () => {
        const sql = 'SELECT * FROM [order.items]';
        expect(resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'main',
            ['main'],
            [{ dbName: 'main', tableName: 'order.items' }],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: sql.length - 1 },
            '',
            undefined,
            true,
            'sqlite',
        )).toMatchObject({
            kind: 'table',
            dbName: 'main',
            tableName: 'order.items',
            schemaName: undefined,
            lookupTableName: '[order.items]',
        });
    });

    it.each([
        ['mysql', 'SELECT * FROM `order.items`', '`order.items`', 'order.items'],
        ['sqlserver', 'SELECT * FROM [order.items]', '[order.items]', '[dbo].[order.items]'],
    ])('keeps a quoted dotted table literal intact for %s navigation and hover', (dialect, sql, quotedTable, metadataTableName) => {
        const tables = [{ dbName: 'app', tableName: metadataTableName, comment: 'literal dotted table' }];
        const navigation = resolveQueryEditorNavigationTarget(
            sql,
            sql.length,
            'app',
            ['app'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            true,
            undefined,
            '',
            dialect,
        );
        expect(navigation).toEqual({
            type: 'table',
            dbName: 'app',
            tableName: metadataTableName,
            schemaName: undefined,
            lookupTableName: quotedTable,
        });

        const hover = resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'app',
            ['app'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: sql.length - 1 },
            '',
            undefined,
            true,
            dialect,
        );
        expect(hover).toMatchObject({
            kind: 'table',
            dbName: 'app',
            tableName: metadataTableName,
            schemaName: undefined,
            comment: 'literal dotted table',
            lookupTableName: quotedTable,
        });
    });

    it('treats the legacy SQLite schema-prefixed dotted form as one table', () => {
        const sql = 'SELECT * FROM order.[order.items]';
        expect(resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'main',
            ['main'],
            [{ dbName: 'main', tableName: 'order.items' }],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: sql.length - 1 },
            '',
            undefined,
            true,
            'sqlite',
        )).toMatchObject({
            kind: 'table',
            dbName: 'main',
            tableName: 'order.items',
            schemaName: undefined,
            lookupTableName: 'order.[order.items]',
        });
    });

    it('finds a table source when the formatter leaves multiple spaces after FROM', () => {
        const sql = 'SELECT * FROM    users';
        expect(isQueryEditorTableSourceAtPosition(sql, 1, sql.length)).toBe(true);
        expect(resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'main',
            ['main'],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: sql.length - 1 },
            '',
            undefined,
            true,
        )).toMatchObject({ kind: 'table', dbName: 'main', tableName: 'users' });
    });

    it('keeps spaces, escaped delimiters, and dots inside quoted table identifiers', () => {
        expect(collectQueryEditorTableReferences('SELECT * FROM "Sales Data"')).toEqual([
            { tableIdent: 'Sales Data', parts: ['Sales Data'] },
        ]);
        expect(collectQueryEditorTableReferences('SELECT * FROM `Sales.Data`')).toEqual([
            { tableIdent: 'Sales.Data', parts: ['Sales.Data'] },
        ]);
        expect(collectQueryEditorTableReferences('SELECT * FROM [Sales]]Data]')).toEqual([
            { tableIdent: 'Sales]Data', parts: ['Sales]Data'] },
        ]);
        expect(collectQueryEditorTableReferences('SELECT * FROM [Sales#Data]')).toEqual([
            { tableIdent: 'Sales#Data', parts: ['Sales#Data'] },
        ]);
        expect(collectQueryEditorTableReferences('SELECT * FROM `Sales--Data`')).toEqual([
            { tableIdent: 'Sales--Data', parts: ['Sales--Data'] },
        ]);
    });

    it('does not classify a table alias as a table source', () => {
        const sql = 'SELECT * FROM users u';
        expect(isQueryEditorTableSourceAtPosition(sql, 1, sql.length)).toBe(false);
    });

    it('resolves PostgreSQL schema.table under the current database', () => {
        const tables = [
            { dbName: 'appdb', tableName: 'public.users' },
            { dbName: 'appdb', tableName: 'billing.orders' },
        ];
        expect(resolveQueryEditorNavigationTarget(
            'select * from public.users',
            'select * from public.users'.length,
            'appdb',
            ['appdb', 'otherdb'],
            tables,
        )).toEqual({
            type: 'table',
            dbName: 'appdb',
            tableName: 'public.users',
            schemaName: 'public',
        });
        expect(resolveQueryEditorNavigationTarget(
            'select * from billing.orders',
            'select * from billing.orders'.length,
            'appdb',
            ['appdb'],
            tables,
        )).toEqual({
            type: 'table',
            dbName: 'appdb',
            tableName: 'billing.orders',
            schemaName: 'billing',
        });
    });
});
