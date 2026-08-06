import { describe, expect, it, vi } from 'vitest';

import {
  buildTabularClipboardPayload,
  buildTabularClipboardPayloadFromTsv,
  writeClipboardPayloadToEvent,
} from './dataGridClipboardPayload';

describe('dataGridClipboardPayload', () => {
  it('builds plain text, HTML and CSV from one table payload', () => {
    const payload = buildTabularClipboardPayload({
      columns: ['id', 'name'],
      rows: [
        ['1', 'Alice & Bob'],
        ['2', '<Admin>'],
      ],
      jsonRows: [
        { id: 1, name: 'Alice & Bob' },
        { id: 2, name: '<Admin>' },
      ],
    });

    expect(payload.plainText).toBe('id\tname\n1\tAlice & Bob\n2\t<Admin>');
    expect(payload.csv).toBe('"id","name"\n"1","Alice & Bob"\n"2","<Admin>"');
    expect(payload.html).toContain('<th>name</th>');
    expect(payload.html).toContain('<td>Alice &amp; Bob</td>');
    expect(payload.html).toContain('<td>&lt;Admin&gt;</td>');
    expect(payload.markdown).toBe('| id | name |\n| --- | --- |\n| 1 | Alice & Bob |\n| 2 | <Admin> |');
    expect(payload.json).toBe('[\n  {\n    "id": 1,\n    "name": "Alice & Bob"\n  },\n  {\n    "id": 2,\n    "name": "<Admin>"\n  }\n]');
  });

  it('keeps the original TSV plain text when deriving rich formats', () => {
    const payload = buildTabularClipboardPayloadFromTsv('id\tname\n1\talpha', { firstRowIsHeader: true });

    expect(payload.plainText).toBe('id\tname\n1\talpha');
    expect(payload.html).toContain('<thead><tr><th>id</th><th>name</th></tr></thead>');
    expect(payload.csv).toBe('"id","name"\n"1","alpha"');
  });

  it('keeps rich formats lossless while plain text remains a safe TSV fallback', () => {
    const payload = buildTabularClipboardPayload({
      rows: [['alpha\tbeta', 'line1\nline2']],
    });

    expect(payload.plainText).toBe('alpha beta\tline1 line2');
    expect(payload.csv).toBe('"alpha\tbeta","line1\nline2"');
    expect(payload.html).toContain('<td>alpha\tbeta</td>');
    expect(payload.html).toContain('<td>line1\nline2</td>');
  });

  it('sets multiple clipboard MIME types without overwriting different formats', () => {
    const values: Record<string, string> = {};
    const event = {
      clipboardData: {
        clearData: vi.fn(() => {
          Object.keys(values).forEach((key) => delete values[key]);
        }),
        setData: vi.fn((type: string, value: string) => {
          values[type] = value;
        }),
      },
      preventDefault: vi.fn(),
    };

    const payload = buildTabularClipboardPayload({
      columns: ['id'],
      rows: [['1']],
      jsonRows: [{ id: 1 }],
    });

    expect(writeClipboardPayloadToEvent(event, payload)).toBe(true);
    expect(values['text/plain']).toBe('id\n1');
    expect(values['text/html']).toContain('<table>');
    expect(values['text/csv']).toBe('"id"\n"1"');
    expect(values['text/markdown']).toBe('| id |\n| --- |\n| 1 |');
    expect(values['application/json']).toBe('[\n  {\n    "id": 1\n  }\n]');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});
