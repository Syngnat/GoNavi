import { connection } from '../../wailsjs/go/models';
import {
  deriveLegacyConnectionReadOnlyFlag,
  resolveConnectionProtectionConfig,
} from './connectionReadOnly';
import {
  OCEANBASE_PROTOCOL_PARAM_KEYS,
  resolveOceanBaseProtocolFromConfig,
} from './oceanBaseProtocol';

export type RpcConnectionConfig = connection.ConnectionConfig & { id?: string };
type ConnectionConfigInput = {
  id?: string;
  ssh?: Record<string, any>;
  proxy?: Record<string, any>;
  httpTunnel?: Record<string, any>;
  [key: string]: any;
};
type SSHConfigInput = Record<string, any>;
type ProxyConfigInput = Record<string, any>;
type HttpTunnelConfigInput = Record<string, any>;

const toStringValue = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
};

const toOptionalInteger = (value: unknown, fallback?: number): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
};

const normalizeProxyType = (value: unknown): 'socks5' | 'http' => {
  return toStringValue(value).toLowerCase() === 'http' ? 'http' : 'socks5';
};

const normalizeSSHConfig = (value: unknown): connection.SSHConfig => {
  const raw = (value ?? {}) as SSHConfigInput;
  return new connection.SSHConfig({
    host: toStringValue(raw.host),
    port: toOptionalInteger(raw.port, 22) ?? 22,
    user: toStringValue(raw.user),
    password: toStringValue(raw.password),
    keyPath: toStringValue(raw.keyPath),
  });
};

const normalizeProxyConfig = (value: unknown): connection.ProxyConfig => {
  const raw = (value ?? {}) as ProxyConfigInput;
  const type = normalizeProxyType(raw.type);
  return new connection.ProxyConfig({
    type,
    host: toStringValue(raw.host),
    port: toOptionalInteger(raw.port, type === 'http' ? 8080 : 1080) ?? (type === 'http' ? 8080 : 1080),
    user: toStringValue(raw.user),
    password: toStringValue(raw.password),
  });
};

const normalizeHttpTunnelConfig = (value: unknown): connection.HTTPTunnelConfig => {
  const raw = (value ?? {}) as HttpTunnelConfigInput;
  return new connection.HTTPTunnelConfig({
    host: toStringValue(raw.host),
    port: toOptionalInteger(raw.port, 8080) ?? 8080,
    user: toStringValue(raw.user),
    password: toStringValue(raw.password),
  });
};

const withOceanBaseProtocolParam = (config: ConnectionConfigInput): ConnectionConfigInput => {
  const type = toStringValue(config.type).trim().toLowerCase();
  if (type !== 'oceanbase') {
    return config;
  }
  const selectedProtocol = resolveOceanBaseProtocolFromConfig(config);
  const params = new URLSearchParams(toStringValue(config.connectionParams));
  for (const key of OCEANBASE_PROTOCOL_PARAM_KEYS) {
    params.delete(key);
  }
  params.set('protocol', selectedProtocol);
  return {
    ...config,
    connectionParams: params.toString(),
  };
};

export function buildRpcConnectionConfig(
  config: ConnectionConfigInput,
  overrides: ConnectionConfigInput = {},
): RpcConnectionConfig {
  const mergedSSH = {
    ...(config.ssh ?? {}),
    ...(overrides.ssh ?? {}),
  };
  const mergedProxy = {
    ...(config.proxy ?? {}),
    ...(overrides.proxy ?? {}),
  };
  const mergedHttpTunnel = {
    ...(config.httpTunnel ?? {}),
    ...(overrides.httpTunnel ?? {}),
  };
  const merged: ConnectionConfigInput = {
    ...config,
    ...overrides,
    ssh: mergedSSH,
    proxy: mergedProxy,
    httpTunnel: mergedHttpTunnel,
  };
  const rpcMerged = withOceanBaseProtocolParam(merged);
  const { oceanBaseProtocol: _oceanBaseProtocol, ...rpcPayload } = rpcMerged;

  const baseId = toStringValue(config.id).trim() || toStringValue(overrides.id).trim() || undefined;
  const timeout = toOptionalInteger(rpcMerged.timeout, toOptionalInteger(config.timeout));
  const redisDB = toOptionalInteger(rpcMerged.redisDB, toOptionalInteger(config.redisDB));
  const protection = resolveConnectionProtectionConfig({
    type: toStringValue(rpcMerged.type),
    driver: rpcMerged.driver,
    oceanBaseProtocol: rpcMerged.oceanBaseProtocol,
    readOnly: rpcMerged.readOnly,
    protection: rpcMerged.protection,
  });

  const rpcConfig = new connection.ConnectionConfig({
    ...rpcPayload,
    type: toStringValue(rpcMerged.type),
    host: toStringValue(rpcMerged.host),
    port: toOptionalInteger(rpcMerged.port, toOptionalInteger(config.port, 0)) ?? 0,
    user: toStringValue(rpcMerged.user),
    password: toStringValue(rpcMerged.password),
    database: toStringValue(rpcMerged.database),
    readOnly: deriveLegacyConnectionReadOnlyFlag(protection),
    protection: new connection.ConnectionProtectionConfig(protection),
    useSSH: rpcMerged.useSSH === true,
    ssh: normalizeSSHConfig(rpcMerged.ssh),
    useProxy: rpcMerged.useProxy === true,
    proxy: normalizeProxyConfig(rpcMerged.proxy),
    useHttpTunnel: rpcMerged.useHttpTunnel === true,
    httpTunnel: normalizeHttpTunnelConfig(rpcMerged.httpTunnel),
    timeout,
    redisDB,
  }) as RpcConnectionConfig;

  rpcConfig.id = baseId;
  return rpcConfig;
}
