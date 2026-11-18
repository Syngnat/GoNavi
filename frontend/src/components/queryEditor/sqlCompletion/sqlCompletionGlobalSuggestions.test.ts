import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    sharedAllColumnsData: [] as any[],
    sharedViewsData: [] as any[],
    sharedMaterializedViewsData: [] as any[],
    sharedSynonymsData: [] as any[],
    sharedRoutinesData: [] as any[],
    sharedVisibleDbs: [] as string[],
}));

vi.mock('../queryEditorCompletionState', () => state);

import {
    buildSqlCompletionGlobalSuggestions,
    stripCompletionIdentifierDelimiters,
    stripCompletionTableQualifiers,
} from './sqlCompletionGlobalSuggestions';
import type { CompletionColumnMeta } from '../QueryEditorHelpers';

const monaco = {
    languages: {
        CompletionItemKind: {
            Field: 1,
            Class: 2,
            Keyword: 3,
            Function: 4,
            Module: 5,
            Variable: 6,
            Unit: 7,
            Struct: 8,
            Event: 9,
            Snippet: 10,
        },
    },
    Range: class {
        constructor(
            public startLineNumber: number,
            public startColumn: number,
            public endLineNumber: number,
            public endColumn: number,
        ) {}
    },
    editor: { TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 } },
} as any;

const column = (name: string, tableName = 'fs_mkefu_server_info', dbName = 'mkefu_ai_dev'): CompletionColumnMeta => ({
    name,
    tableName,
    dbName,
    type: 'varchar(255)',
} as CompletionColumnMeta);

/**
 * 最小可用的构建参数。只关心候选合并与排序，其余能力用恒等实现占位，
 * 避免把测试绑死在补全器的内部细节上。
 */
const buildInput = (overrides: Record<string, unknown> = {}) => ({
    expectsTableName: false,
    foundTables: new Set(['mkefu_ai_dev\u0000fs_mkefu_server_info']),
    activeDialect: 'mysql',
    referencedColumns: [] as CompletionColumnMeta[],
    wordPrefix: '',
    isCurrentCompletionDatabase: () => true,
    sortGroups: {
        keyword: '1', func: '2', routineCurrent: '2', routineOther: '2',
        tableCurrent: '3', tableOther: '3', columnCurrent: '0', columnOther: '0',
        db: '4',
    },
    monaco,
    quoteCompletionPart: (value: string) => value,
    applyCompletionFragmentCase: (value: string) => value,
    rawWordPrefix: '',
    range: new monaco.Range(1, 1, 1, 1),
    currentDatabase: 'mkefu_ai_dev',
    completionTables: [] as any[],
    splitSchemaAndTable: (name: string) => ({ schema: '', table: name }),
    buildDbQualifiedTableSuggestionMeta: (dbName: string, tableName: string) => ({
        displayName: tableName,
        insertName: tableName,
        insertText: tableName,
        dbQualifiedLabel: dbName ? `${dbName}.${tableName}` : tableName,
    }),
    buildTableSuggestion: (label: string, detail: string) => ({ label, detail }),
    appendTableSourceAlias: (text: string) => text,
    quoteCompletionPath: (value: string) => value,
    getPrefixMatchRank: () => '0',
    buildViewSuggestionMeta: () => ({ displayName: '', insertText: '' }),
    getViewTypeLabel: () => 'view',
    getViewSuggestionScope: () => 'current',
    oracleLoginOwner: '',
    buildSynonymSuggestion: () => null,
    buildRoutineSuggestionMeta: () => ({ displayName: '', insertText: '' }),
    expectsRoutineName: false,
    getRoutineTypeLabel: () => 'fn',
    dialectKeywords: [] as string[],
    dialectFunctions: [] as string[],
    ...overrides,
});

describe('buildSqlCompletionGlobalSuggestions', () => {
    beforeEach(() => {
        state.sharedAllColumnsData.length = 0;
        state.sharedViewsData.length = 0;
        state.sharedMaterializedViewsData.length = 0;
        state.sharedSynonymsData.length = 0;
        state.sharedRoutinesData.length = 0;
        state.sharedVisibleDbs.length = 0;
    });

    // 回归：预加载列（sharedAllColumnsData 索引）与按别名解析出的引用列
    // 经常是同一列。直接拼接会让补全列表出现两条一模一样的候选。
    it('emits each referenced column once even when it is also preloaded', () => {
        const shared = column('encoding_aes_key');
        state.sharedAllColumnsData.push(shared);

        const { suggestions } = buildSqlCompletionGlobalSuggestions(buildInput({
            referencedColumns: [column('encoding_aes_key')],
        }) as any);

        const columnSuggestions = suggestions.filter((item: any) => (
            item.kind === monaco.languages.CompletionItemKind.Field
            && String(item.label?.label ?? item.label) === 'encoding_aes_key'
        ));
        expect(columnSuggestions).toHaveLength(1);
    });

    // 回归：同一张表在两个来源里的写法可能不同——DuckDB 附加库的 GetAllColumns
    // 返回 `catalog.schema.table`，别名解析出来的是 `schema.table`；SQL Server 的
    // 目录元数据还会带方括号。只按 trim + 大小写归一化会让同一列算出两个键。
    // 回归：DuckDB 附加库的目录元数据返回 `catalog.schema.table`，别名解析得到
    // `schema.table`；SQL Server 的目录名还带方括号。去重键必须能把这几种写法
    // 归一到同一张表，否则同一列会在候选里出现两次。
    it('normalizes table qualifiers and identifier delimiters for the dedupe key', () => {
        expect(stripCompletionTableQualifiers('analytics.main.users')).toBe('users');
        expect(stripCompletionTableQualifiers('main.users')).toBe('users');
        expect(stripCompletionTableQualifiers('users')).toBe('users');

        expect(stripCompletionIdentifierDelimiters('[Order Details]')).toBe('Order Details');
        expect(stripCompletionIdentifierDelimiters('"Order Details"')).toBe('Order Details');
        expect(stripCompletionIdentifierDelimiters('`Order Details`')).toBe('Order Details');
        expect(stripCompletionIdentifierDelimiters('payload')).toBe('payload');
    });

    it('keeps distinct columns even when they share a name across tables', () => {
        const usersId = column('id', 'users', 'db');
        const ordersId = column('id', 'orders', 'db');
        state.sharedAllColumnsData.push(usersId, ordersId);

        const { suggestions } = buildSqlCompletionGlobalSuggestions(buildInput({
            foundTables: new Set(['db\u0000users', 'db\u0000orders']),
            // 两列同名列、不同表：去重键必须包含表名，否则会被误合并成一条。
            activeDialect: 'mysql',
            // 直接给出引用列，避免依赖共享索引的键格式细节。
            referencedColumns: [usersId, ordersId],
        }) as any);

        const idSuggestions = suggestions.filter((item: any) => (
            item.kind === monaco.languages.CompletionItemKind.Field
            && String(item.label?.label ?? item.label) === 'id'
        ));
        expect(idSuggestions).toHaveLength(2);
    });

    // 回归：WHERE 里两张表的同名列会共享同一个排序组，只按「当前库」分组会让
    // 它们完全同序、退化成字母序，把用户正在查的表排到后面。
    it('ranks columns of tables in the current statement above other loaded tables', () => {
        const currentTableColumn = column('id', 'wechat_mp_auth_corp_info', 'mkefu_ai_dev');
        const otherTableColumn = column('id', 'fs_mkefu_server_info', 'mkefu_ai_dev');
        state.sharedAllColumnsData.push(otherTableColumn, currentTableColumn);

        const { suggestions } = buildSqlCompletionGlobalSuggestions(buildInput({
            // 当前语句只引用了 wechat_mp_auth_corp_info。
            foundTables: new Set(['mkefu_ai_dev\u0000wechat_mp_auth_corp_info']),
            referencedColumns: [currentTableColumn],
        }) as any);

        const idSuggestions = suggestions.filter((item: any) => (
            item.kind === monaco.languages.CompletionItemKind.Field
            && String(item.label?.label ?? item.label) === 'id'
        ));
        expect(idSuggestions).toHaveLength(1);
        // columnCurrent('00') + 引用表优先标记('0') + 匹配等级 + 列名。
        expect(idSuggestions[0].sortText.startsWith('000')).toBe(true);
    });

    // 回归：一句话里有多张表时，列候选必须按 FROM/JOIN 的出现顺序排，
    // 而不是把它们当成同一档退化成字母序（用户正在写的表会被挤到后面）。
    it('orders column candidates by the table position in the statement', () => {
        const first = column('id', 'wechat_customer_company_info', 'mkefu_ai_dev');
        const second = column('id', 'fs_mkefu_server_info', 'mkefu_ai_dev');
        state.sharedAllColumnsData.push(first, second);

        const firstKey = 'mkefu_ai_dev\u0000wechat_customer_company_info';
        const secondKey = 'mkefu_ai_dev\u0000fs_mkefu_server_info';
        const { suggestions } = buildSqlCompletionGlobalSuggestions(buildInput({
            foundTables: new Set([firstKey, secondKey]),
            tableReferenceOrder: new Map([[firstKey, 0], [secondKey, 1]]),
            referencedColumns: [first, second],
        }) as any);

        const ids = suggestions.filter((item: any) => (
            item.kind === monaco.languages.CompletionItemKind.Field
            && String(item.label?.label ?? item.label) === 'id'
        ));
        expect(ids).toHaveLength(2);
        // 先出现的表排序键更小。
        expect(String(ids[0].sortText) < String(ids[1].sortText)).toBe(true);
    });

    // 回归：分档以前夹紧到 8，第 9 张起的表全部落进同一档，在子查询多的语句里
    // 重新退化成字母序。另外档位必须定宽，否则 '10' 会排在 '2' 前面。
    it('keeps table order beyond the eighth reference and pads ranks to two digits', () => {
        const early = column('id', 't02', 'db');
        const late = column('id', 't10', 'db');
        state.sharedAllColumnsData.push(early, late);

        const earlyKey = 'db\u0000t02';
        const lateKey = 'db\u0000t10';
        const { suggestions } = buildSqlCompletionGlobalSuggestions(buildInput({
            foundTables: new Set([earlyKey, lateKey]),
            tableReferenceOrder: new Map([[earlyKey, 2], [lateKey, 10]]),
            referencedColumns: [early, late],
        }) as any);

        const ids = suggestions.filter((item: any) => (
            item.kind === monaco.languages.CompletionItemKind.Field
            && String(item.label?.label ?? item.label) === 'id'
        ));
        expect(ids).toHaveLength(2);
        expect(String(ids[0].sortText) < String(ids[1].sortText)).toBe(true);
        // 分组前缀是 1 个字符（本测试的 sortGroups.columnCurrent = '0'），
        // 其后是两位定宽档位：'02' 与 '10'。
        expect(String(ids[0].sortText).slice(1, 3)).toBe('02');
        expect(String(ids[1].sortText).slice(1, 3)).toBe('10');
    });
});
