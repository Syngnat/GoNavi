import { describe, expect, it } from 'vitest';

import { buildUriFromValues, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import { findPotentiallyMutatingConnectionStatements, supportsConnectionReadOnlyMode } from '../connectionReadOnly';
import { isInfluxFluxQuery } from './commandReadOnly';
import { usesHttpRegistryUri } from './uriScheme';

const influx = { type: 'influxdb' } as never;

describe('InfluxDB registry behavior', () => {
  it('joins the time-series group on port 8086 with http(s) connection URIs', () => {
    const group = CONNECTION_TYPE_GROUPS.find((item) => item.labelKey.endsWith('.timeseries'));
    expect(group?.items.map((item) => item.key)).toContain('influxdb');
    expect(getConnectionTypeDefaultPort('influxdb')).toBe(8086);
    expect(usesHttpRegistryUri('influxdb')).toBe(true);
    expect(parseUriToValues('https://metrics.example.com:8181', 'influxdb')).toMatchObject({ host: 'metrics.example.com', port: 8181, useSSL: true });
    expect(buildUriFromValues({ type: 'influxdb', host: '127.0.0.1', port: 8086 }).startsWith('http://127.0.0.1:8086')).toBe(true);
    expect(supportsConnectionReadOnlyMode(influx)).toBe(true);
  });

  it('treats read-only Flux, InfluxQL and SQL as reads and to(), INSERT, INTO and DROP as writes', () => {
    expect(isInfluxFluxQuery('from(bucket: "b") |> range(start: -1h)')).toBe(true);
    expect(isInfluxFluxQuery('SELECT * FROM cpu')).toBe(false);
    for (const statement of [
      'from(bucket: "b") |> range(start: -1h)',
      'import "influxdata/influxdb/schema"\nschema.measurements(bucket: "b")',
      `SELECT * FROM "cpu" WHERE "host" = 'a'`,
      'SHOW MEASUREMENTS',
    ]) {
      expect(findPotentiallyMutatingConnectionStatements(influx, statement), statement).toEqual([]);
    }
    for (const statement of [
      'from(bucket: "a") |> range(start: 0) |> to(bucket: "b")',
      'INSERT cpu,host=a usage=1',
      'SELECT * INTO "copy" FROM "cpu"',
      'DROP MEASUREMENT "cpu"',
    ]) {
      expect(findPotentiallyMutatingConnectionStatements(influx, statement), statement).toEqual([statement]);
    }
  });
});
