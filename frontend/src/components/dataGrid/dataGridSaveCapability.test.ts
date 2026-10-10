import { describe, expect, it } from 'vitest';
import { getDataGridSaveCapability } from './dataGridSaveCapability';
import { getDataSourceOperationCapability } from '../../utils/dataSourceCapabilities';
import type { ConnectionConfig } from '../../types';

const makeConfig = (overrides: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  type: 'mysql', host: 'localhost', port: 3306, user: 'test', ...overrides,
});

describe('data grid save capability', () => {
  it('restricts script tunnel saving while preserving query and transaction type capabilities', () => {
    const config = makeConfig({
      useHttpTunnel: true,
      httpTunnel: { host: 'https://example.test/ntunnel_mysql.php', port: 443 },
    });
    expect(getDataGridSaveCapability(config)).toEqual({
      supported: false, messageKey: 'data_grid.message.navicat_http_tunnel_save_unsupported',
    });
    expect(getDataSourceOperationCapability(config, 'query').supported).toBe(true);
    expect(getDataSourceOperationCapability(config, 'transaction').supported).toBe(true);
  });

  it.each([
    {},
    { useSSH: true },
    { useProxy: true },
    { useHttpTunnel: true, httpTunnel: { host: 'proxy.test', port: 8080 } },
    { useHttpTunnel: false, httpTunnel: { host: 'https://example.test/tunnel.php', port: 443 } },
  ])('preserves saving for other transports %j', (overrides) => {
    expect(getDataGridSaveCapability(makeConfig(overrides))).toEqual({ supported: true });
  });
});
