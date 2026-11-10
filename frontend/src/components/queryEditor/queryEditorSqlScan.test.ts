import { describe, expect, it } from 'vitest';
import { maskQueryEditorSqlLiteralsAndComments } from './queryEditorSqlScan';

describe('maskQueryEditorSqlLiteralsAndComments', () => {
    it('keeps offsets and newlines while masking literals and comments', () => {
        const sql = "SELECT 'a:b'\n-- :c\n, :d";
        expect(maskQueryEditorSqlLiteralsAndComments(sql, 'mysql')).toBe("SELECT      \n     \n, :d");
    });

    it('masks dollar-quoted bodies that contain SQL-looking text', () => {
        const sql = 'SELECT $tag$ FROM hidden ; $tag$, 1';
        const masked = maskQueryEditorSqlLiteralsAndComments(sql, 'postgres');
        expect(masked).toHaveLength(sql.length);
        expect(sql.slice(masked.lastIndexOf(',') + 1)).toBe(' 1');
        expect(masked.slice(0, 7)).toBe('SELECT ');
        expect(masked.slice(7, masked.lastIndexOf(','))).toBe(' '.repeat(sql.lastIndexOf(',') - 7));
    });

    // 回归：旧实现每遇到 `$` 就 `slice(i)` 复制剩余全文再 `indexOf` 找闭合标签，
    // 未配对标签（Oracle 的 V$SQL、PG dump 里的成片 $tag$）会让掩码退化为
    // 平方级，10MB 级文档直接卡死编辑器。此用例锁定「必须近线性」。
    it('stays fast when many dollar tags never close', () => {
        const parts: string[] = [];
        for (let i = 0; i < 60_000; i += 1) parts.push(`$t${i}$`);
        const text = parts.join(' ');
        const startedAt = performance.now();
        maskQueryEditorSqlLiteralsAndComments(text, 'postgres');
        expect(performance.now() - startedAt).toBeLessThan(3_000);
    });

    it('masks a large PostgreSQL dump in bounded time', () => {
        const parts: string[] = [];
        let length = 0;
        let index = 0;
        while (length < 2 * 1024 * 1024) {
            const body = 'BEGIN\n  PERFORM pg_sleep(0.01);\n'.repeat(40);
            const statement = `CREATE OR REPLACE FUNCTION f_${index}() RETURNS void AS $fn_${index}$\n${body}\n$fn_${index}$ LANGUAGE plpgsql;\n`;
            parts.push(statement);
            length += statement.length;
            index += 1;
        }
        const startedAt = performance.now();
        maskQueryEditorSqlLiteralsAndComments(parts.join(''), 'postgres');
        expect(performance.now() - startedAt).toBeLessThan(5_000);
    });
});
