import { describe, it, expect } from 'vitest';
import { DEFAULT_SQL_SNIPPETS, BUILTIN_SNIPPET_MAP, createDefaultSqlSnippets } from './sqlSnippetDefaults';

describe('sqlSnippetDefaults', () => {
  it('DEFAULT_SQL_SNIPPETS should be a non-empty array', () => {
    expect(Array.isArray(DEFAULT_SQL_SNIPPETS)).toBe(true);
    expect(DEFAULT_SQL_SNIPPETS.length).toBeGreaterThan(0);
  });

  it('every default snippet should have required fields', () => {
    for (const s of DEFAULT_SQL_SNIPPETS) {
      expect(s.id).toBeTruthy();
      expect(s.prefix).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.body).toBeTruthy();
      expect(s.isBuiltin).toBe(true);
      expect(typeof s.createdAt).toBe('number');
    }
  });

  it('every prefix should be lowercase alphanumeric/underscore', () => {
    for (const s of DEFAULT_SQL_SNIPPETS) {
      expect(s.prefix).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('prefixes should be unique', () => {
    const prefixes = DEFAULT_SQL_SNIPPETS.map((s) => s.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('ids should be unique', () => {
    const ids = DEFAULT_SQL_SNIPPETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all default snippets should have snippet syntax in body', () => {
    for (const s of DEFAULT_SQL_SNIPPETS) {
      const hasTabStopOrVariable = /\$\d|\$\{|CURRENT_/.test(s.body);
      expect(hasTabStopOrVariable).toBe(true);
    }
  });

  it('time-variable snippets should contain CURRENT_ markers', () => {
    const seld = DEFAULT_SQL_SNIPPETS.find((s) => s.prefix === 'seld');
    expect(seld).toBeDefined();
    expect(seld!.body).toContain('CURRENT_YEAR');
    expect(seld!.body).toContain('CURRENT_MONTH');
    expect(seld!.body).toContain('CURRENT_DATE');

    const inst = DEFAULT_SQL_SNIPPETS.find((s) => s.prefix === 'inst');
    expect(inst).toBeDefined();
    expect(inst!.body).toContain('CURRENT_HOUR');
    expect(inst!.body).toContain('CURRENT_MINUTE');
    expect(inst!.body).toContain('CURRENT_SECOND');
  });

  it('BUILTIN_SNIPPET_MAP should contain all default snippet ids', () => {
    for (const s of DEFAULT_SQL_SNIPPETS) {
      expect(BUILTIN_SNIPPET_MAP[s.id]).toBeDefined();
      expect(BUILTIN_SNIPPET_MAP[s.id].prefix).toBe(s.prefix);
      expect(BUILTIN_SNIPPET_MAP[s.id].body).toBe(s.body);
    }
  });

  it('BUILTIN_SNIPPET_MAP entries should be independent copies', () => {
    for (const s of DEFAULT_SQL_SNIPPETS) {
      const mapped = BUILTIN_SNIPPET_MAP[s.id];
      expect(mapped).not.toBe(s);
    }
  });

  it('localizes built-in snippet metadata while keeping SQL bodies raw', () => {
    const snippets = createDefaultSqlSnippets((key) => `T(${key})`);
    const first = snippets.find((s) => s.id === 'builtin-sel');

    expect(first?.name).toBe('T(sql_snippets.builtin.sel.name)');
    expect(first?.description).toBe('T(sql_snippets.builtin.sel.description)');
    expect(first?.body).toBe('SELECT ${1:column_list} FROM ${2:table_name}$0;');
  });
});
