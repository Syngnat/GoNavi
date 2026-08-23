import { describe, expect, it } from 'vitest';

import {
    buildBoundedQueryEditorCompletionSuggestions,
    buildQueryEditorAliasMap,
    buildQueryEditorResultSetMergeKey,
    collectQueryEditorReferencedDatabaseNames,
    collectQueryEditorTableReferences,
    createBoundedQueryEditorCompletionCandidateBatch,
    findCompletionTablesByDatabase,
    getCompletionTableSchemaCounts,
    isOracleBaseTableReference,
    isQueryEditorTableSourceCompletionContext,
    materializeBoundedQueryEditorCompletionBatches,
    rankQueryEditorCompletionCandidate,
    resolveQueryEditorCompletionFilterText,
    resolveQueryEditorConnectionTimeout,
    resolveOracleLikeDefaultSchemaName,
    resolveOracleLikeExecutionSchemaName,
    resolveOracleLikeLookupSchemaCandidates,
    resolveQueryEditorMonacoLanguage,
    resolveQueryEditorNavigationTarget,
    selectUnqualifiedCompletionSynonyms,
    shouldHandleQueryEditorRunShortcutFallback,
    splitCompletionSchemaAndTable,
} from './QueryEditorHelpers';

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
        expect(isQueryEditorTableSourceCompletionContext('SELECT * FROM users WHERE id = 1')).toBe(false);
        expect(isQueryEditorTableSourceCompletionContext('SELECT EXTRACT(YEAR FROM created_at)')).toBe(false);
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

    it('resolves database.schema.table three-part names for PostgreSQL-style metadata', () => {
        const tables = [
            { dbName: 'analytics', tableName: 'public.events' },
            { dbName: 'analytics', tableName: 'events' },
        ];
        expect(resolveQueryEditorNavigationTarget(
            'select * from analytics.public.events',
            'select * from analytics.public.events'.length,
            'appdb',
            ['appdb', 'analytics'],
            tables,
        )).toEqual({
            type: 'table',
            dbName: 'analytics',
            tableName: 'public.events',
            schemaName: 'public',
        });
    });

    it('still resolves schema-qualified objects when the first segment is also a visible database name but no table exists there', () => {
        // 边界：可见库列表里碰巧有 "billing" 这个库，但当前库下才有 billing.orders
        const tables = [
            { dbName: 'main', tableName: 'billing.orders' },
        ];
        expect(resolveQueryEditorNavigationTarget(
            'select * from billing.orders',
            'select * from billing.orders'.length,
            'main',
            ['main', 'billing'],
            tables,
        )).toEqual({
            type: 'table',
            dbName: 'main',
            tableName: 'billing.orders',
            schemaName: 'billing',
        });
    });
});
