import { describe, expect, it } from 'vitest';

import {
  compactJsonCellText,
  escapeCellText,
  formatJsonCellText,
  unescapeCellText,
} from './dataGridCellTextTransform';

describe('dataGridCellTextTransform', () => {
  it('formats and compacts JSON without changing its data', () => {
    const compact = '{"name":"GoNavi","items":[1,2],"enabled":true}';
    const formatted = formatJsonCellText(compact);

    expect(formatted).toContain('\n  "name": "GoNavi"');
    expect(compactJsonCellText(formatted)).toBe(compact);
  });

  it('escapes quotes and backslashes without collapsing formatted whitespace', () => {
    expect(escapeCellText('line 1\n"quoted"\\path\tend'))
      .toBe('line 1\n\\"quoted\\"\\\\path\tend');
  });

  it('keeps formatted JSON on multiple lines after escaping it', () => {
    const formatted = formatJsonCellText('{"name":"GoNavi","items":[1,2]}');
    const escaped = escapeCellText(formatted);

    expect(escaped).toBe([
      '{',
      '  \\"name\\": \\"GoNavi\\",',
      '  \\"items\\": [',
      '    1,',
      '    2',
      '  ]',
      '}',
    ].join('\n'));
  });

  it('round-trips arbitrary text through escape and unescape', () => {
    const text = '中文 😀\n"quoted"\\path\b\f\t';
    expect(unescapeCellText(escapeCellText(text))).toBe(text);
  });

  it('decodes JSON unicode and solidus escapes while preserving ordinary text', () => {
    expect(unescapeCellText('prefix\\u4e2d\\u6587 \\/ path'))
      .toBe('prefix中文 / path');
  });

  it.each([
    ['trailing\\', 'Trailing backslash'],
    ['bad\\q', 'Invalid escape sequence'],
    ['bad\\u12xy', 'Invalid Unicode escape'],
  ])('rejects invalid escaped text without returning a partial result', (value, message) => {
    expect(() => unescapeCellText(value)).toThrow(message);
  });
});
