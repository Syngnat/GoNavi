import { describe, expect, it } from 'vitest';

import {
  collectDataGridRecordFieldCandidates,
  findDataGridJsonFieldOccurrences,
  resolveDataGridRecordFieldTarget,
} from './dataGridRecordFieldSearch';

describe('dataGridRecordFieldSearch', () => {
  it('ranks exact, prefix, contains, and comment matches in a stable order', () => {
    const candidates = collectDataGridRecordFieldCandidates({
      fieldNames: ['legacy_title', 'title', 'title_suffix', 'display_name', 'summary'],
      commentsByField: {
        display_name: 'Title shown to users',
        summary: 'Article title summary',
      },
      query: 'title',
      includeComments: true,
    });

    expect(candidates.map(({ fieldName, matchKind }) => [fieldName, matchKind])).toEqual([
      ['title', 'field-exact'],
      ['title_suffix', 'field-prefix'],
      ['legacy_title', 'field-contains'],
      ['display_name', 'comment-prefix'],
      ['summary', 'comment-contains'],
    ]);
  });

  it('matches without case sensitivity and excludes comments when requested', () => {
    expect(collectDataGridRecordFieldCandidates({
      fieldNames: ['USER_ID', 'display_name'],
      commentsByField: { display_name: 'User label' },
      query: 'user',
    }).map((candidate) => candidate.fieldName)).toEqual(['USER_ID']);
  });

  it('resolves only an exact or unique candidate automatically', () => {
    const candidates = collectDataGridRecordFieldCandidates({
      fieldNames: ['user_id', 'user_name'],
      query: 'user',
    });
    expect(resolveDataGridRecordFieldTarget(candidates, 'user')).toBe('');
    expect(resolveDataGridRecordFieldTarget(candidates, 'user_id')).toBe('user_id');
    expect(resolveDataGridRecordFieldTarget(candidates.slice(0, 1), 'user')).toBe('user_id');
  });

  it('finds only top-level row properties in formatted JSON', () => {
    const jsonText = JSON.stringify([
      { id: 1, profile: { id: 10 }, note: '"id": value text' },
      { id: 2, profile: { id: 20 } },
    ], null, 2);
    const occurrences = findDataGridJsonFieldOccurrences(jsonText, 'id');

    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((range) => jsonText.slice(range.start, range.end))).toEqual(['"id"', '"id"']);
  });

  it('handles field names that require JSON escaping', () => {
    const fieldName = 'quoted"field';
    const jsonText = JSON.stringify([{ [fieldName]: 1 }], null, 2);
    const [occurrence] = findDataGridJsonFieldOccurrences(jsonText, fieldName);

    expect(jsonText.slice(occurrence.start, occurrence.end)).toBe(JSON.stringify(fieldName));
  });
});
