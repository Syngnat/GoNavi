import { describe, expect, it, vi } from 'vitest';
import { gunzipSync, strFromU8 } from 'fflate';
import {
  buildCompressedExportPayload,
  exportDataRowsWithOptions,
} from './dataGridExportPayload';

const decodeRows = (encoded: string): unknown => {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return JSON.parse(strFromU8(gunzipSync(bytes)));
};

describe('data grid export payload transport', () => {
  it('leaves rows below the compression threshold untouched', async () => {
    const rows = [{ id: 1, name: 'Alice' }];
    const invoke = vi.fn().mockResolvedValue({ success: true });
    await exportDataRowsWithOptions(rows, ['id', 'name'], 'users', { format: 'xlsx' }, invoke, {
      compressThresholdBytes: 1024,
    });
    expect(invoke).toHaveBeenCalledWith(rows, ['id', 'name'], 'users', { format: 'xlsx' });
  });

  it('compresses large rows and preserves UTF-8 values across the bridge shape', async () => {
    const rows = [
      { id: 1, name: '中文', note: 'line\nbreak' },
      { id: 2, name: 'Alice', note: 'quoted "value"' },
    ];
    const invoke = vi.fn().mockResolvedValue({ success: true });
    await exportDataRowsWithOptions(rows, ['id', 'name', 'note'], 'users', { format: 'csv' }, invoke, {
      compressThresholdBytes: 1,
    });

    expect(invoke).toHaveBeenCalledOnce();
    const [data, columns, defaultName, options] = invoke.mock.calls[0];
    expect(data).toEqual([]);
    expect(columns).toEqual(['id', 'name', 'note']);
    expect(defaultName).toBe('users');
    expect(options.format).toBe('csv');
    expect(decodeRows(options.dataGzipBase64)).toEqual(rows);
  });

  it('rejects a compressed payload that still exceeds the runtime body ceiling', async () => {
    const invoke = vi.fn();
    await expect(exportDataRowsWithOptions(
      [{ id: 1, name: 'Alice' }],
      ['id', 'name'],
      'users',
      { format: 'csv' },
      invoke,
      { compressThresholdBytes: 1, maxEncodedBytes: 1 },
    )).rejects.toThrow(/single-request limit|单次请求上限/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports the compressed and raw sizes for diagnostics', () => {
    const payload = buildCompressedExportPayload([{ value: 'x'.repeat(1024) }], 1);
    expect(payload).not.toBeNull();
    expect(payload!.rawBytes).toBeGreaterThan(payload!.compressedBytes);
    expect(decodeRows(payload!.encoded)).toEqual([{ value: 'x'.repeat(1024) }]);
  });
});
