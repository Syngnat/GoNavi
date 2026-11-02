import { describe, expect, it } from 'vitest';

import { joinSqlTokens, tokenizeSql } from './dataSyncSqlHighlight';

const kindsOf = (sql: string) => tokenizeSql(sql).map((token) => token.kind);

describe('sql tokenizer', () => {
  // 分词只影响着色，绝不能改变文本本身：用户复制出去的内容必须和看到的一致。
  it('round-trips the input exactly', () => {
    const samples = [
      'ALTER TABLE `orders` MODIFY COLUMN `amount` bigint;',
      "-- note: it's a comment\nALTER TABLE t ADD COLUMN c TEXT;",
      "DEFAULT 'it''s'",
      'CREATE TABLE `t` (\n  `a` int NOT NULL DEFAULT 0\n);',
      '',
      '   ',
      '未闭合 \'引号',
      '`未闭合反引号',
    ];
    samples.forEach((sql) => {
      expect(joinSqlTokens(tokenizeSql(sql))).toBe(sql);
    });
  });

  it('classifies keywords, identifiers, strings, numbers and comments', () => {
    const sql = "ALTER TABLE `orders` MODIFY COLUMN `amount` bigint DEFAULT '0' -- trailing";
    const tokens = tokenizeSql(sql);
    const byText = (text: string) => tokens.find((token) => token.text === text)?.kind;

    expect(byText('ALTER')).toBe('keyword');
    expect(byText('TABLE')).toBe('keyword');
    expect(byText('`orders`')).toBe('ident');
    expect(byText('`amount`')).toBe('ident');
    expect(byText("'0'")).toBe('string');
    expect(byText('-- trailing')).toBe('comment');
  });

  it('does not treat identifiers as keywords regardless of case', () => {
    const tokens = tokenizeSql('alter table `t` add column `c` text');
    const keywords = tokens.filter((token) => token.kind === 'keyword').map((token) => token.text);
    expect(keywords).toEqual(['alter', 'table', 'add', 'column', 'text']);
  });

  it('keeps doubled single quotes inside one string token', () => {
    const tokens = tokenizeSql("DEFAULT 'it''s'");
    const strings = tokens.filter((token) => token.kind === 'string');
    expect(strings).toHaveLength(1);
    expect(strings[0]!.text).toBe("'it''s'");
  });

  // 表名与注释来自数据库，分词结果只作为文本节点插入，任何标记都必须保持字面。
  it('keeps markup-looking content as text', () => {
    const sql = "COMMENT '<img src=x onerror=alert(1)>'";
    expect(joinSqlTokens(tokenizeSql(sql))).toBe(sql);
    expect(kindsOf(sql)).toContain('string');
  });
});
