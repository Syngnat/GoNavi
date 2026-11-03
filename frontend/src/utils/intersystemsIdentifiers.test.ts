import { describe, expect, it } from 'vitest';
import { quoteInterSystemsIdent } from './intersystemsIdentifiers';
import { quoteIdentPart, quoteQualifiedIdent } from './sql';

// 规则来源：IRIS 2026.1 与 Caché 2018.1 实测。DelimitedIds 关闭时双引号是字符串字面量，
// 所以只有裸写不成立的名字才加引号。
describe('quoteInterSystemsIdent', () => {
  it.each([
    'BDA_Store', 'USER_TABLE', '_private', '%ID', '%VID',
    'Order', 'Value', 'Index', 'Key', 'Name', 'Status', 'Type', 'Data', 'Comment',
  ])('keeps the bare form of %s', (ident) => {
    expect(quoteInterSystemsIdent(ident)).toBe(ident);
  });

  it.each([
    ['LEVEL', '"LEVEL"'],
    ['User', '"User"'],
    ['Select', '"Select"'],
    ['top', '"top"'],
    ['Group', '"Group"'],
    ['Values', '"Values"'],
  ])('quotes reserved word %s', (ident, expected) => {
    expect(quoteInterSystemsIdent(ident)).toBe(expected);
  });

  it.each([
    ['has space', '"has space"'],
    ['a-b', '"a-b"'],
    ['1starts_with_digit', '"1starts_with_digit"'],
    ['we"ird', '"we""ird"'],
  ])('quotes %s because it cannot be written bare', (ident, expected) => {
    expect(quoteInterSystemsIdent(ident)).toBe(expected);
  });

  it('strips an existing quote pair before deciding', () => {
    expect(quoteInterSystemsIdent('"BDA_Store"')).toBe('BDA_Store');
    expect(quoteInterSystemsIdent('"LEVEL"')).toBe('"LEVEL"');
  });

  it('returns an empty string for an empty identifier', () => {
    expect(quoteInterSystemsIdent('')).toBe('');
    expect(quoteInterSystemsIdent('   ')).toBe('');
  });
});

describe('IRIS quoting through the shared SQL helpers', () => {
  it('keeps IRIS/Caché table and column references bare', () => {
    expect(quoteQualifiedIdent('iris', 'BDA_Store.SysParameter')).toBe('BDA_Store.SysParameter');
    expect(quoteQualifiedIdent('cache', 'BDA_Store.SysParameter')).toBe('BDA_Store.SysParameter');
    expect(quoteIdentPart('iris', 'ID')).toBe('ID');
  });

  it('keeps mixed-case names bare because IRIS undelimited identifiers ignore case', () => {
    expect(quoteQualifiedIdent('iris', 'CaseC.MixCase')).toBe('CaseC.MixCase');
    expect(quoteIdentPart('iris', 'OrderNo')).toBe('OrderNo');
  });

  it('still quotes reserved words so the preview SQL parses', () => {
    expect(quoteQualifiedIdent('iris', 'Sample.Level')).toBe('Sample."Level"');
    expect(quoteIdentPart('iris', 'User')).toBe('"User"');
  });

  it('does not quote PostgreSQL the same way', () => {
    // PostgreSQL 大小写折叠，含大写名字必须加引号；IRIS 不应跟随这条规则。
    expect(quoteQualifiedIdent('postgres', 'BDA_Store.SysParameter')).toBe('"BDA_Store"."SysParameter"');
    expect(quoteQualifiedIdent('iris', 'BDA_Store.SysParameter')).toBe('BDA_Store.SysParameter');
  });
});
