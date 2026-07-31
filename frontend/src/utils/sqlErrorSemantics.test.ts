import { describe, expect, it } from 'vitest';

import { formatSqlExecutionError } from './sqlErrorSemantics';

describe('formatSqlExecutionError', () => {
  it('adds semantic explanation for SQL syntax errors and keeps raw text', () => {
    const formatted = formatSqlExecutionError('pq: syntax error at or near "from"');

    expect(formatted).toContain('Semantic meaning: SQL syntax error');
    expect(formatted).toContain('Suggestion:');
    expect(formatted).toContain('Raw error: pq: syntax error at or near "from"');
  });

  it('recognizes missing table errors', () => {
    const formatted = formatSqlExecutionError('ERROR: relation "orders" does not exist');

    expect(formatted).toContain('Semantic meaning: Table or object does not exist');
    expect(formatted).toContain('Raw error: ERROR: relation "orders" does not exist');
  });

  it('recognizes duplicate key errors with statement prefix', () => {
    const formatted = formatSqlExecutionError('Duplicate entry "1" for key "PRIMARY"', {
      prefix: 'Statement 2 failed:',
    });

    expect(formatted.startsWith('Statement 2 failed:\nSemantic meaning: Unique constraint or primary key conflict')).toBe(true);
    expect(formatted).toContain('Raw error: Duplicate entry "1" for key "PRIMARY"');
  });

  it('falls back to a generic database execution error', () => {
    const formatted = formatSqlExecutionError('driver returned unexpected status 123');

    expect(formatted).toContain('Semantic meaning: Database execution error');
    expect(formatted).toContain('Raw error: driver returned unexpected status 123');
  });

  it('recognizes driver bad connection during SQL execution as timeout semantics', () => {
    const formatted = formatSqlExecutionError('第 1 条语句执行失败：driver: bad connection');

    expect(formatted).toContain('Semantic meaning: Query timed out or was canceled');
    expect(formatted).toContain('Raw error: 第 1 条语句执行失败：driver: bad connection');
  });

  it('recognizes localized connection-timeout wrappers as timeout semantics', () => {
    const translate = (key: string, params?: Record<string, unknown>) => {
      if (key === 'query_editor.sql_error.wrapper.semantic_line') {
        return `SEM:${params?.label}|${params?.explanation}`;
      }
      if (key === 'query_editor.sql_error.wrapper.suggestion_line') {
        return `SUG:${params?.suggestion}`;
      }
      if (key === 'query_editor.sql_error.wrapper.raw_line') {
        return `RAW:${params?.error}`;
      }
      if (key === 'query_editor.sql_error.rule.timeout_or_canceled.label') {
        return 'TIMEOUT_LABEL';
      }
      if (key === 'query_editor.sql_error.rule.timeout_or_canceled.explanation') {
        return 'TIMEOUT_EXPLANATION';
      }
      if (key === 'query_editor.sql_error.rule.timeout_or_canceled.suggestion') {
        return 'TIMEOUT_SUGGESTION';
      }
      if (key === 'query_editor.sql_error.rule.generic.label') {
        return 'GENERIC_LABEL';
      }
      if (key === 'query_editor.sql_error.rule.generic.explanation') {
        return 'GENERIC_EXPLANATION';
      }
      if (key === 'query_editor.sql_error.rule.generic.suggestion') {
        return 'GENERIC_SUGGESTION';
      }
      return key;
    };

    const localizedTimeoutMessages = [
      '\u8cc7\u6599\u5eab\u9023\u7dda\u903e\u6642\uff1amysql 127.0.0.1:3306/main\uff1a\u7db2\u8def\u903e\u6642',
      '\u30c7\u30fc\u30bf\u30d9\u30fc\u30b9\u63a5\u7d9a\u304c\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u3057\u307e\u3057\u305f: mysql 127.0.0.1:3306/main: \u30bf\u30a4\u30e0\u30a2\u30a6\u30c8',
      'Zeit\u00fcberschreitung bei der Datenbankverbindung: mysql 127.0.0.1:3306/main: netzwerk-timeout',
      '\u0422\u0430\u0439\u043c-\u0430\u0443\u0442 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u044f \u043a \u0431\u0430\u0437\u0435 \u0434\u0430\u043d\u043d\u044b\u0445: mysql 127.0.0.1:3306/main: \u0442\u0430\u0439\u043c-\u0430\u0443\u0442 \u0441\u0435\u0442\u0438',
    ] as const;

    for (const raw of localizedTimeoutMessages) {
      const formatted = formatSqlExecutionError(raw, { translate });

      expect(formatted).toContain('SEM:TIMEOUT_LABEL|TIMEOUT_EXPLANATION');
      expect(formatted).toContain('SUG:TIMEOUT_SUGGESTION');
      expect(formatted).toContain(`RAW:${raw}`);
      expect(formatted).not.toContain('SEM:GENERIC_LABEL|GENERIC_EXPLANATION');
    }
  });

  it('localizes semantic wrapper copy with a supplied translator without translating raw database errors', () => {
    const seen: Array<{ key: string; params?: Record<string, unknown> }> = [];
    const formatted = formatSqlExecutionError('ERROR: relation "orders" does not exist', {
      translate: (key, params) => {
        seen.push({ key, params });
        if (key === 'query_editor.sql_error.wrapper.semantic_line') {
          return `语义:${params?.label}|${params?.explanation}`;
        }
        if (key === 'query_editor.sql_error.wrapper.suggestion_line') {
          return `建议:${params?.suggestion}`;
        }
        if (key === 'query_editor.sql_error.wrapper.raw_line') {
          return `RAW:${params?.error}`;
        }
        return `T:${key}`;
      },
    });

    expect(formatted).toContain('语义:T:query_editor.sql_error.rule.object_missing.label|T:query_editor.sql_error.rule.object_missing.explanation');
    expect(formatted).toContain('建议:T:query_editor.sql_error.rule.object_missing.suggestion');
    expect(formatted).toContain('RAW:ERROR: relation "orders" does not exist');
    expect(seen.map((entry) => entry.key)).toContain('query_editor.sql_error.rule.object_missing.label');
    expect(seen.map((entry) => entry.key)).toContain('query_editor.sql_error.wrapper.raw_line');
  });

  it('does not format an already formatted message again', () => {
    const raw = [
      '中文语义：SQL 语法错误。通常是关键字、逗号、括号、引号、语句顺序或当前数据库方言不匹配。',
      '处理建议：检查报错位置附近的 SQL 片段，并确认当前连接的数据源类型与 SQL 方言一致。',
      '原始错误：pq: syntax error at or near "from"',
    ].join('\n');

    expect(formatSqlExecutionError(raw)).toBe(raw);
  });
});

describe('锁竞争错误的语义分类', () => {
  // 回归背景：timeout_or_canceled 规则的 /timeout/i 过宽，把 MySQL 的
  // "Lock wait timeout exceeded" 也吞成「查询超时」，于是给出「检查执行计划、过滤条件和索引，
  // 必要时调整超时时间」这种完全无效的建议 —— 行锁等待超时的成因是另一个事务持锁，
  // 调大超时只会让用户等更久。lock_contention 规则必须先于 timeout 规则命中。
  it('MySQL 1205 锁等待超时不再被归类为查询超时', () => {
    const formatted = formatSqlExecutionError(
      'Error 1205 (HY000): Lock wait timeout exceeded; try restarting transaction',
    );

    expect(formatted).toContain('Semantic meaning: Blocked by another transaction holding locks');
    expect(formatted).not.toContain('Query timed out or was canceled');
    expect(formatted).toContain('Raw error: Error 1205 (HY000): Lock wait timeout exceeded; try restarting transaction');
  });

  it('建议指向提交或回滚未完成事务，而不是调整超时', () => {
    const formatted = formatSqlExecutionError('Lock wait timeout exceeded; try restarting transaction');

    expect(formatted).toContain('Commit or roll back the pending transaction first');
    expect(formatted).not.toContain('adjust the timeout');
  });

  it('覆盖各方言的锁竞争与死锁错误', () => {
    const messages = [
      'Error 1213 (40001): Deadlock found when trying to get lock; try restarting transaction',
      'ERROR: deadlock detected',
      'ERROR: canceling statement due to lock timeout',
      'Lock request time out period exceeded.',
      'Transaction (Process ID 52) was deadlocked on lock resources with another process',
      'ORA-00060: deadlock detected while waiting for resource',
      'ORA-00054: resource busy and acquire with NOWAIT specified',
      'database is locked',
    ];
    for (const message of messages) {
      expect(
        formatSqlExecutionError(message),
        `未被识别为锁竞争：${message}`,
      ).toContain('Semantic meaning: Blocked by another transaction holding locks');
    }
  });

  it('普通查询超时仍归类为查询超时，未被新规则误吞', () => {
    for (const message of ['context deadline exceeded', 'sql: statement canceled', 'query execution timeout']) {
      expect(
        formatSqlExecutionError(message),
        `被锁竞争规则误吞：${message}`,
      ).toContain('Semantic meaning: Query timed out or was canceled');
    }
  });
});
