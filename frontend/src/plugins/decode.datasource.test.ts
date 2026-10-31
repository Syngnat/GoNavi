import { describe, expect, it } from 'vitest';
import { decodeInspection } from './decode';
const inspection = (effect?: string, readOnly: boolean = true) => ({
  manifest: { schemaVersion: 1, apiVersion: 1, id: 'example.source', name: 'Source', version: '1.0.0', permissions: ['data.sources'],
    contributes: { commands: [{ id: 'database', title: 'Database', ...(effect == null ? {} : { effect }) }],
      dataSources: [{ id: 'fixture', name: 'Fixture', dialect: 'sqlite', command: 'database', readOnly }] } },
  digest: 'a'.repeat(64), sourcePath: 'fixture', sizeBytes: 10,
});
describe('data source manifest decoding', () => {
  it('keeps omitted, read, and unknown effects and rejects writes', () => {
    expect(decodeInspection(inspection()).manifest.contributes?.dataSources?.[0].command).toBe('database');
    expect(decodeInspection(inspection('read')).manifest.contributes?.commands?.[0].effect).toBe('read');
    expect(decodeInspection(inspection('unknown')).manifest.contributes?.commands?.[0].effect).toBe('unknown');
    expect(() => decodeInspection(inspection('write'))).toThrow();
    expect(() => decodeInspection(inspection('WRITE'))).toThrow();
    // Writable sources are part of the host contract; only read-only ones constrain effects.
    expect(decodeInspection(inspection('write', false)).manifest.contributes?.dataSources?.[0].command).toBe('database');
    expect(decodeInspection(inspection(undefined, false)).manifest.contributes?.dataSources?.[0].command).toBe('database');
    const upper = inspection();
    (upper.manifest.contributes.dataSources[0] as { dialect: string }).dialect = 'SQLite';
    expect(() => decodeInspection(upper)).toThrow();
    const port = inspection();
    (port.manifest.contributes.dataSources[0] as { defaultPort?: number }).defaultPort = 65536;
    expect(() => decodeInspection(port)).toThrow();
    const zero = inspection();
    (zero.manifest.contributes.dataSources[0] as { defaultPort?: number }).defaultPort = 0;
    expect(decodeInspection(zero).manifest.contributes?.dataSources?.[0].command).toBe('database');
  });
});
