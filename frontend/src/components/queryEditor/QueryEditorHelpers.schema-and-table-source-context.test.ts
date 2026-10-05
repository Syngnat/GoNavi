import { describe, expect, it } from 'vitest';
import { getCurrentLanguage, setCurrentLanguage } from '../../i18n';
import {
    collectQueryEditorObjectDecorationCandidates,
    collectQueryEditorTableReferences,
    findIdentifierWindowAtOffset,
    getQueryEditorDocumentOffsetAtPosition,
    isQueryEditorTableSourceAtPosition,
    resolveQueryEditorHoverTarget,
    resolveQueryEditorNavigationTarget,
    resolveQueryEditorNavigationDecorations,
    maskQueryEditorSqlLiteralsAndComments,
    splitQueryIdentifierPathSegments,
} from './QueryEditorHelpers';

describe('QueryEditorHelpers qualified navigation (MySQL db.table + PG schema.table)', () => {
    it('prefers the selected PostgreSQL schema for an unqualified table name', () => {
        const sql = 'SELECT * FROM users';
        const tables = [
            { dbName: 'appdb', tableName: 'public.users' },
            { dbName: 'appdb', tableName: 'sales.users' },
        ];

        expect(resolveQueryEditorNavigationTarget(
            sql,
            sql.length,
            'appdb',
            ['appdb'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            undefined,
            'sales',
        )).toEqual({
            type: 'table',
            dbName: 'appdb',
            tableName: 'sales.users',
            schemaName: 'sales',
        });
        expect(resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'appdb',
            ['appdb'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            undefined,
            'sales',
        )).toMatchObject({
            kind: 'table',
            dbName: 'appdb',
            tableName: 'sales.users',
            schemaName: 'sales',
        });
    });

    it('distinguishes PostgreSQL quoted table names from folded unquoted names', () => {
        const tables = [
            { dbName: 'appdb', tableName: 'public.users', comment: 'lowercase table' },
            { dbName: 'appdb', tableName: 'public.Users', comment: 'quoted uppercase table' },
        ];
        const quotedSql = 'SELECT * FROM "Users"';
        const unquotedSql = 'SELECT * FROM users';

        expect(resolveQueryEditorNavigationTarget(
            quotedSql,
            quotedSql.length,
            'appdb',
            ['appdb'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            undefined,
            'public',
            'postgres',
        )).toEqual({
            type: 'table',
            dbName: 'appdb',
            tableName: 'public.Users',
            schemaName: 'public',
        });
        expect(resolveQueryEditorNavigationTarget(
            unquotedSql,
            unquotedSql.length,
            'appdb',
            ['appdb'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            undefined,
            'public',
            'postgres',
        )).toEqual({
            type: 'table',
            dbName: 'appdb',
            tableName: 'public.users',
            schemaName: 'public',
        });

        expect(resolveQueryEditorHoverTarget(
            quotedSql,
            quotedSql,
            quotedSql.length,
            'appdb',
            ['appdb'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            undefined,
            'public',
            undefined,
            true,
            'postgres',
        )).toMatchObject({
            kind: 'table',
            tableName: 'public.Users',
            comment: 'quoted uppercase table',
            lookupTableName: 'public."Users"',
        });
    });

    it('distinguishes PostgreSQL quoted named objects from folded unquoted names', () => {
        const views = [
            { dbName: 'appdb', viewName: 'public.users', schemaName: 'public' },
            { dbName: 'appdb', viewName: 'public.Users', schemaName: 'public' },
        ];
        const quotedSql = 'SELECT * FROM "Users"';
        const unquotedSql = 'SELECT * FROM users';

        expect(resolveQueryEditorNavigationTarget(
            quotedSql,
            quotedSql.length,
            'appdb',
            ['appdb'],
            [],
            views,
            [],
            [],
            [],
            [],
            [],
            false,
            undefined,
            'public',
            'postgres',
        )).toEqual({
            type: 'view',
            dbName: 'appdb',
            viewName: 'public.Users',
            schemaName: 'public',
        });
        expect(resolveQueryEditorNavigationTarget(
            unquotedSql,
            unquotedSql.length,
            'appdb',
            ['appdb'],
            [],
            views,
            [],
            [],
            [],
            [],
            [],
            false,
            undefined,
            'public',
            'postgres',
        )).toEqual({
            type: 'view',
            dbName: 'appdb',
            viewName: 'public.users',
            schemaName: 'public',
        });
    });

    it('keeps the selected PostgreSQL schema when inferring a table without metadata', () => {
        const sql = 'SELECT * FROM users';

        expect(resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'appdb',
            ['appdb'],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            undefined,
            'sales',
            undefined,
            true,
        )).toMatchObject({
            kind: 'table',
            dbName: 'appdb',
            tableName: 'users',
            schemaName: 'sales',
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

describe('QueryEditorHelpers cross-line qualified identifier resolution', () => {
    const tables = [
        { dbName: 'other', tableName: 'users' },
        { dbName: 'mydb', tableName: 'users' },
    ];

    it('resolves a db.table qualifier split across lines instead of falling back to the current database', () => {
        // 悬停第二行的 users：限定名被格式化拆行后必须仍解析到 mydb，而不是当前库 other 的同名表
        const sql = 'SELECT * FROM mydb\n        . users';
        expect(resolveQueryEditorHoverTarget(
            sql,
            '        . users',
            12,
            'other',
            ['other', 'mydb'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 2, 12) },
        )).toMatchObject({ kind: 'table', dbName: 'mydb', tableName: 'users' });

        // 反向断言：不给全文上下文时保持旧行为（回退当前库），确保参数可选且不破坏既有调用
        expect(resolveQueryEditorHoverTarget(
            sql,
            '        . users',
            12,
            'other',
            ['other', 'mydb'],
            tables,
            [],
        )).toMatchObject({ kind: 'table', dbName: 'other', tableName: 'users' });
    });

    it('absorbs backtick-quoted segments split across lines', () => {
        const sql = 'SELECT * FROM `mydb`.\n    `users` WHERE id = 1';
        expect(resolveQueryEditorHoverTarget(
            sql,
            '    `users` WHERE id = 1',
            10,
            'other',
            ['other', 'mydb'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 2, 10) },
        )).toMatchObject({ kind: 'table', dbName: 'mydb', tableName: 'users' });
    });

    it('keeps single-line resolution intact when document context is provided', () => {
        const sql = 'select * from mydb.users';
        expect(resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'other',
            ['other', 'mydb'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            true,
            { text: sql, offset: sql.length - 1 },
        )).toMatchObject({ kind: 'table', dbName: 'mydb', tableName: 'users' });
    });

    it('does not let a stale qualified document offset replace the current line token', () => {
        const line = 'SELECT value';
        const documentText = 'SELECT * FROM other.users';
        const target = resolveQueryEditorHoverTarget(
            documentText,
            line,
            line.length,
            'main',
            ['main', 'other'],
            [
                { dbName: 'main', tableName: 'value' },
                { dbName: 'other', tableName: 'users' },
            ],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: documentText, offset: documentText.length - 1 },
            '',
            undefined,
            true,
        );

        expect(target).toMatchObject({ kind: 'table', dbName: 'main', tableName: 'value' });
    });

    it('does not treat PostgreSQL quoted and folded names as the same stale token', () => {
        const line = 'SELECT users';
        const documentText = 'SELECT * FROM "Users"';
        const target = resolveQueryEditorHoverTarget(
            documentText,
            line,
            line.length,
            'main',
            ['main'],
            [
                { dbName: 'main', tableName: 'users' },
                { dbName: 'main', tableName: 'Users' },
            ],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: documentText, offset: documentText.length - 1 },
            '',
            undefined,
            true,
            'postgres',
        );

        expect(target).toMatchObject({ kind: 'table', dbName: 'main', tableName: 'users' });
    });

    it('does not absorb across statement terminators while expanding the window', () => {
        const sql = 'select * from a.b;\nselect * from c.d';
        const target = resolveQueryEditorHoverTarget(
            sql,
            'select * from c.d',
            18,
            'other',
            ['other'],
            [{ dbName: 'c', tableName: 'd' }],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            true,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 2, 18) },
        );
        expect(target).toMatchObject({ kind: 'table', dbName: 'c', tableName: 'd' });
    });

    it('resolves an unqualified table when FROM and the table are on different lines', () => {
        const sql = 'SELECT *\nFROM\n  users';
        const lineContent = '  users';
        const column = lineContent.length + 1;
        const target = resolveQueryEditorHoverTarget(
            sql,
            lineContent,
            column,
            'other',
            ['other'],
            [{ dbName: 'other', tableName: 'users' }],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 3, column) },
        );

        expect(target).toMatchObject({ kind: 'table', dbName: 'other', tableName: 'users' });
    });

    it('resolves a qualified table when the dot is on its own line', () => {
        const sql = 'SELECT * FROM mydb\n  .\n  users';
        const lineContent = '  users';
        const column = lineContent.length + 1;
        const target = resolveQueryEditorHoverTarget(
            sql,
            lineContent,
            column,
            'other',
            ['other', 'mydb'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 3, column) },
        );

        expect(target).toMatchObject({ kind: 'table', dbName: 'mydb', tableName: 'users' });
    });

    it('resolves a three-part table when the last line keeps schema.table together', () => {
        const sql = 'SELECT * FROM analytics\n  . public.events';
        const lineContent = '  . public.events';
        const column = lineContent.length + 1;
        const target = resolveQueryEditorHoverTarget(
            sql,
            lineContent,
            column,
            'other',
            ['other', 'analytics'],
            [{ dbName: 'analytics', tableName: 'public.events' }],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 2, column) },
        );

        expect(target).toMatchObject({
            kind: 'table',
            dbName: 'analytics',
            tableName: 'public.events',
            schemaName: 'public',
        });
    });

    it('keeps a cross-line target when the current line probe is temporarily empty', () => {
        const sql = 'SELECT * FROM mydb\n  .\n  users';
        const target = resolveQueryEditorHoverTarget(
            sql,
            '',
            1,
            'other',
            ['other', 'mydb'],
            tables,
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 3, 3) },
        );

        expect(target).toMatchObject({ kind: 'table', dbName: 'mydb', tableName: 'users' });
    });

    it('infers a table source while table metadata is still loading', () => {
        const sql = 'SELECT *\nFROM test_users;';
        const lineContent = 'FROM test_users;';
        const target = resolveQueryEditorHoverTarget(
            sql,
            lineContent,
            12,
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
            true,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 2, 12) },
            '',
            undefined,
            true,
        );

        expect(target).toMatchObject({ kind: 'table', dbName: 'main', tableName: 'test_users' });
    });

    it('infers a table source from the SQL prefix even when the caller probe is false', () => {
        const sql = 'SELECT *\nFROM test_users;';
        const target = resolveQueryEditorHoverTarget(
            sql,
            'FROM test_users;',
            12,
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
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 2, 12) },
            '',
            undefined,
            true,
        );

        expect(target).toMatchObject({ kind: 'table', dbName: 'main', tableName: 'test_users' });
    });

    it('infers a cross-line table source when metadata misses the table', () => {
        const sql = 'SELECT *\nFROM\n  test_users;';
        const lineContent = '  test_users;';
        const column = lineContent.length + 1;
        const target = resolveQueryEditorHoverTarget(
            sql,
            lineContent,
            column,
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
            true,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 3, column) },
            '',
            undefined,
            true,
        );

        expect(target).toMatchObject({
            kind: 'table',
            dbName: 'main',
            tableName: 'test_users',
        });
    });

    it('preserves an explicit database in three-part fallback while metadata is loading', () => {
        const sql = 'select * from missingdb.audit.users';
        const target = resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'appdb',
            ['appdb'],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            true,
            { text: sql, offset: sql.length - 1 },
            '',
            undefined,
            true,
        );

        expect(target).toMatchObject({
            kind: 'table',
            dbName: 'missingdb',
            tableName: 'users',
            schemaName: 'audit',
            lookupTableName: 'audit.users',
        });
    });

    it('infers the second source in a comma-separated FROM list when metadata misses it', () => {
        const sql = 'SELECT * FROM known_table, missing_table';
        const target = resolveQueryEditorHoverTarget(
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
        );

        expect(target).toMatchObject({
            kind: 'table',
            dbName: 'main',
            tableName: 'missing_table',
        });
    });

    it('infers an arbitrary schema-qualified table when metadata misses it', () => {
        const sql = 'SELECT * FROM billing.orders';
        const target = resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'appdb',
            ['appdb'],
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
        );

        expect(target).toMatchObject({
            kind: 'table',
            dbName: 'appdb',
            tableName: 'orders',
            schemaName: 'billing',
        });
    });

    it.each(['mysql', 'oracle'])(
        'preserves an explicit %s database or owner while metadata is still loading',
        (dialect) => {
            const sql = 'SELECT * FROM missingdb.users';
            const target = resolveQueryEditorHoverTarget(
                sql,
                sql,
                sql.length,
                'appdb',
                ['appdb'],
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
                dialect,
            );

            expect(target).toMatchObject({
                kind: 'table',
                dbName: 'missingdb',
                tableName: 'users',
                lookupTableName: 'users',
            });
        },
    );

    it('keeps PostgreSQL schema.table in the current database when a same-name database also has that table', () => {
        const sql = 'select * from billing.orders';
        const tables = [
            { dbName: 'billing', tableName: 'orders' },
            { dbName: 'appdb', tableName: 'billing.orders' },
        ];

        expect(resolveQueryEditorNavigationTarget(
            sql,
            sql.length,
            'appdb',
            ['appdb', 'billing'],
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
            'postgres',
        )).toEqual({
            type: 'table',
            dbName: 'appdb',
            tableName: 'billing.orders',
            schemaName: 'billing',
        });
    });

    it('keeps a quoted table identifier containing spaces intact for fallback hover', () => {
        const sql = 'SELECT * FROM "Sales Data"';
        const target = resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'appdb',
            ['appdb'],
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
        );

        expect(target).toMatchObject({
            kind: 'table',
            dbName: 'appdb',
            tableName: 'Sales Data',
        });
    });

    it.each([
        ['SELECT * FROM `Sales.Data`', '`Sales.Data`'],
        ['SELECT * FROM [Sales Data]', '[Sales Data]'],
        ['SELECT * FROM "Sales""Data"', '"Sales""Data"'],
    ])('keeps delimited identifier %s intact', (sql, identifier) => {
        const target = resolveQueryEditorHoverTarget(
            sql,
            sql,
            sql.length,
            'appdb',
            ['appdb'],
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
        );
        expect(target).toMatchObject({ kind: 'table' });
        expect(target?.kind === 'table' ? target.tableName : '').toBe(identifier.slice(1, -1).replace(/""/g, '"').replace(/``/g, '`').replace(/\]\]/g, ']'));
    });

    it('does not let a quote in a preceding comment consume the real table token', () => {
        const line = '-- dangling [comment\nSELECT * FROM users';
        const window = findIdentifierWindowAtOffset(line, line.length - 1, true);
        expect(window).toEqual({ start: line.lastIndexOf('users'), end: line.length });
        expect(collectQueryEditorObjectDecorationCandidates('SELECT * FROM "Sales Data"'))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({
                    lineNumber: 1,
                    positionColumn: 16,
                }),
            ]));
    });

    it('masks line comments that begin immediately after a statement delimiter', () => {
        const sql = 'SELECT 1;-- FROM fake_table\nSELECT * FROM users';
        const masked = maskQueryEditorSqlLiteralsAndComments(sql);
        expect(masked.split('\n')[0]).not.toContain('FROM fake_table');
        expect(masked.split('\n')[1]).toContain('FROM users');
    });

    it.each(['postgres', 'clickhouse', 'duckdb'])('keeps nested array brackets from swallowing later comments for %s', (dialect) => {
        const sql = 'SELECT [[1],[2]];\n-- FROM fake_table\nSELECT * FROM real_table';
        const masked = maskQueryEditorSqlLiteralsAndComments(sql, dialect);

        expect(masked.split('\n')[1]).not.toContain('FROM fake_table');
        expect(collectQueryEditorTableReferences(sql, dialect)).toEqual([
            { tableIdent: 'real_table', parts: ['real_table'] },
        ]);
    });

    it('keeps SQL Server and SQLite bracket identifiers opaque while treating array brackets as syntax elsewhere', () => {
        expect(splitQueryIdentifierPathSegments('[Sales Data]', 'sqlserver')).toEqual([
            { raw: '[Sales Data]', value: 'Sales Data', quoted: true },
        ]);
        expect(splitQueryIdentifierPathSegments('[Sales Data]', 'sqlite')).toEqual([
            { raw: '[Sales Data]', value: 'Sales Data', quoted: true },
        ]);
        expect(splitQueryIdentifierPathSegments('[Sales Data]', 'postgres')).toEqual([
            { raw: '[Sales Data]', value: '[Sales Data]', quoted: false },
        ]);
        expect(collectQueryEditorTableReferences('SELECT * FROM [Sales]]Data]', 'sqlserver')).toEqual([
            { tableIdent: 'Sales]Data', parts: ['Sales]Data'] },
        ]);
        expect(collectQueryEditorTableReferences('SELECT * FROM [Sales Data]', 'sqlite')).toEqual([
            { tableIdent: 'Sales Data', parts: ['Sales Data'] },
        ]);
    });

    it('does not let a trailing backslash inside a MySQL identifier hide later SQL', () => {
        const sql = 'SELECT * FROM `C:\\temp\\`; -- FROM fake_table\nSELECT * FROM real_table';
        const masked = maskQueryEditorSqlLiteralsAndComments(sql, 'mysql');

        expect(masked.split('\n')[0]).not.toContain('FROM fake_table');
        expect(collectQueryEditorTableReferences(sql, 'mysql')).toEqual([
            { tableIdent: 'C:\\temp\\', parts: ['C:\\temp\\'] },
            { tableIdent: 'real_table', parts: ['real_table'] },
        ]);
    });

    it('masks PostgreSQL dollar-quoted function bodies before collecting table references', () => {
        const sql = [
            'CREATE FUNCTION audit_row() RETURNS trigger AS $fn$',
            'BEGIN',
            '  INSERT INTO fake_audit_log VALUES (1);',
            '  -- FROM fake_table',
            '  RETURN NEW;',
            'END;',
            '$fn$ LANGUAGE plpgsql;',
            'SELECT * FROM real_table;',
        ].join('\n');

        const masked = maskQueryEditorSqlLiteralsAndComments(sql);
        expect(masked).not.toContain('fake_audit_log');
        expect(masked).not.toContain('fake_table');
        expect(masked).toContain('real_table');
        expect(collectQueryEditorTableReferences(sql)).toEqual([
            { tableIdent: 'real_table', parts: ['real_table'] },
        ]);
    });

    it('anchors the hover range on the table token after FROM', () => {
        const sql = 'SELECT *\nFROM test_users;';
        const target = resolveQueryEditorHoverTarget(
            sql,
            'FROM test_users;',
            6,
            'main',
            ['main'],
            [{ dbName: 'main', tableName: 'test_users' }],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            true,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 2, 6) },
        );

        expect(target).toMatchObject({
            kind: 'table',
            tableName: 'test_users',
            range: { startColumn: 6, endColumn: 16 },
        });
    });

    it('anchors navigation decoration on the table token after FROM', () => {
        const line = 'SELECT * FROM users';
        const decorations = resolveQueryEditorNavigationDecorations(
            line,
            15,
            'main',
            ['main'],
            [{ dbName: 'main', tableName: 'users' }],
            [],
            [],
            [],
            [],
            [],
            [],
            'Ctrl',
        );

        expect(decorations).toMatchObject([
            { startColumn: 15, endColumn: 20 },
        ]);
    });

    it('uses the sidebar locate hint when table ctrl-click is configured for locating', () => {
        const previousLanguage = getCurrentLanguage();
        setCurrentLanguage('en-US');
        try {
            const decorations = resolveQueryEditorNavigationDecorations(
                'SELECT * FROM users',
                15,
                'main',
                ['main'],
                [{ dbName: 'main', tableName: 'users' }],
                [],
                [],
                [],
                [],
                [],
                [],
                'Ctrl',
                false,
                undefined,
                '',
                'locate',
            );

            expect(decorations[0]?.hoverMessage).toBe('Ctrl + click to locate this table in the left schema tree');
        } finally {
            setCurrentLanguage(previousLanguage);
        }
    });

    it('strips a stale SQL keyword tail from a hover identifier', () => {
        const sql = 'SELECT *\nFROM test_users;';
        const target = resolveQueryEditorHoverTarget(
            sql,
            'OM test_users;',
            12,
            'main',
            ['main'],
            [{ dbName: 'main', tableName: 'test_users' }],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            true,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 2, 12) },
        );

        expect(target).toMatchObject({ kind: 'table', tableName: 'test_users' });
    });

    it('resolves the table in the second cross-line statement without losing its source context', () => {
        const sql = [
            'SELECT * FROM test_users;',
            '',
            'SELECT *',
            'FROM',
            '  test_users;',
        ].join('\n');
        const lineContent = '  test_users;';
        const column = lineContent.length + 1;
        const target = resolveQueryEditorHoverTarget(
            sql,
            lineContent,
            column,
            'db1',
            ['db1'],
            [{ dbName: 'db1', tableName: 'test_users' }],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            true,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, 5, column) },
            '',
            undefined,
            true,
        );

        expect(target).toMatchObject({
            kind: 'table',
            dbName: 'db1',
            tableName: 'test_users',
        });
    });

    it('keeps CRLF document offsets aligned for a cross-line table source', () => {
        const sql = 'SELECT *\r\nFROM\r\n  test_users';
        const lineContent = '  test_users';
        const column = lineContent.length + 1;
        const rawOffset = 'SELECT *\r\nFROM\r\n'.length + lineContent.length;
        const target = resolveQueryEditorHoverTarget(
            sql,
            lineContent,
            column,
            'db1',
            ['db1'],
            [{ dbName: 'db1', tableName: 'test_users' }],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            true,
            { text: sql, offset: rawOffset },
            '',
            undefined,
            true,
        );

        expect(target).toMatchObject({ kind: 'table', dbName: 'db1', tableName: 'test_users' });
    });

    it('keeps CRLF offsets aligned for a qualified cross-line table source', () => {
        const sql = 'SELECT *\r\nFROM\r\n  audit\r\n.\r\n  test_users';
        const lineContent = '  test_users';
        const column = lineContent.length + 1;
        const rawOffset = 'SELECT *\r\nFROM\r\n  audit\r\n.\r\n'.length + lineContent.length;
        const target = resolveQueryEditorHoverTarget(
            sql,
            lineContent,
            column,
            'db1',
            ['db1'],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            true,
            { text: sql, offset: rawOffset },
            '',
            undefined,
            true,
        );

        expect(target).toMatchObject({
            kind: 'table',
            dbName: 'db1',
            tableName: 'test_users',
            schemaName: 'audit',
        });
    });

    it.each([
        ['SELECT * FROM\n\n  test_users', '  test_users'],
        ['SELECT *\nFROM /* source comment */\n  test_users', '  test_users'],
        ['SELECT *\nFROM\n  audit\n.\n  test_users', '  test_users'],
    ])('keeps table-source context through formatter whitespace/comments: %s', (sql, lineContent) => {
        const lineNumber = sql.split('\n').findIndex((line) => line === lineContent) + 1;
        const column = lineContent.length + 1;
        expect(lineNumber).toBeGreaterThan(0);
        const sourceContext = isQueryEditorTableSourceAtPosition(sql, lineNumber, column);
        expect(sourceContext).toBe(true);
        const resolvedTarget = resolveQueryEditorHoverTarget(
            sql,
            lineContent,
            column,
            'other',
            ['other', 'audit'],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            [],
            false,
            { text: sql, offset: getQueryEditorDocumentOffsetAtPosition(sql, lineNumber, column) },
            '',
            undefined,
            true,
        );
        expect(resolvedTarget).toMatchObject({ kind: 'table', tableName: lineContent.trim() });
    });
});
