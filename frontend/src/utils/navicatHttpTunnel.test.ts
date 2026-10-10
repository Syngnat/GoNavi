import { describe, expect, it } from 'vitest';
import { isNavicatHttpTunnelConnection } from './navicatHttpTunnel';
import type { ConnectionConfig } from '../types';

const makeConfig = (overrides: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  type: 'mysql', host: 'localhost', port: 3306, user: 'test',
  useHttpTunnel: true, httpTunnel: { host: 'https://example.test/ntunnel_mysql.php', port: 443 },
  ...overrides,
});

describe('Navicat HTTP script tunnel classification', () => {
  it.each(['', 'mysql', 'goldendb', 'greatdb', 'gdb', ' MYSQL ', 'GoldenDB'])(
    'recognizes the backend-supported type %j', (type) => {
      expect(isNavicatHttpTunnelConnection(makeConfig({ type }))).toBe(true);
    },
  );

  it.each(['http://example.test/tunnel.php', ' HTTPS://example.test/tunnel.php?token=test ',
    'https://[::1]:8443/tunnel.php'])(
    'accepts the complete HTTP script URL %j', (host) => {
      expect(isNavicatHttpTunnelConnection(makeConfig({ httpTunnel: { host, port: 0 } }))).toBe(true);
    },
  );

  it.each(['mariadb', 'oceanbase', 'doris', 'starrocks', 'custom', 'postgres'])(
    'does not infer script tunnel support for the type %j', (type) => {
      expect(isNavicatHttpTunnelConnection(makeConfig({ type, driver: 'mysql' }))).toBe(false);
    },
  );

  it.each(['proxy.test', 'proxy.test:8080', '127.0.0.1', '::1', '//example.test/tunnel.php',
    'ftp://example.test/tunnel.php', 'http:///tunnel.php', 'https://',
    'http://invalid host/tunnel.php', 'http://example.test:invalid/tunnel.php'])(
    'excludes CONNECT hosts and invalid script URLs %j', (host) => {
      expect(isNavicatHttpTunnelConnection(makeConfig({ httpTunnel: { host, port: 8080 } }))).toBe(false);
    },
  );

  it('requires the tunnel to be enabled and configured', () => {
    expect(isNavicatHttpTunnelConnection(makeConfig({ useHttpTunnel: false }))).toBe(false);
    expect(isNavicatHttpTunnelConnection(makeConfig({ httpTunnel: undefined }))).toBe(false);
    expect(isNavicatHttpTunnelConnection(undefined)).toBe(false);
    expect(isNavicatHttpTunnelConnection(null)).toBe(false);
  });
});
