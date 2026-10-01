import { describe, expect, it } from 'vitest';

import { describeToolArguments, formatToolResult } from './aiToolPayloadFormat';

describe('AI tool payload formatting', () => {
  it('shows SQL probes as readable SQL with the remaining arguments on one line', () => {
    expect(describeToolArguments(JSON.stringify({
      connectionId: '1782364920490',
      dbName: 'H2',
      sql: '  SELECT COUNT(*) FROM H2.T  ',
    }))).toEqual({
      primary: 'SELECT COUNT(*) FROM H2.T',
      meta: 'connectionId=1782364920490 · dbName=H2',
    });
  });

  it('indents other arguments and hides empty ones', () => {
    expect(describeToolArguments('{"connectionId":"c1"}').primary).toBe('{\n  "connectionId": "c1"\n}');
    expect(describeToolArguments('{}')).toEqual({ primary: '', meta: '' });
    expect(describeToolArguments(undefined)).toEqual({ primary: '', meta: '' });
  });

  it('keeps malformed argument text verbatim', () => {
    expect(describeToolArguments('{"sql":')).toEqual({ primary: '{"sql":', meta: '' });
  });

  it('indents JSON results only, and leaves text and oversized payloads untouched', () => {
    expect(formatToolResult('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatToolResult('plain text')).toBe('plain text');
    expect(formatToolResult('{broken')).toBe('{broken');
    const huge = `{"v":"${'x'.repeat(200_001)}"}`;
    expect(formatToolResult(huge)).toBe(huge);
  });
});
