import type { ConnectionConfig } from '../types';
import { t } from '../i18n';
import { getDataSourceSpec } from './dataSourceRegistry';

export type HiveFamily = 'hive' | 'spark' | 'impala';
export type HiveTransport = 'binary' | 'http';
export type HiveAuth = 'NONE' | 'NOSASL' | 'LDAP' | 'CUSTOM' | 'PAM' | 'KERBEROS';
export const HIVE_AUTH_MODES: HiveAuth[] = ['NONE', 'NOSASL', 'LDAP', 'CUSTOM', 'PAM', 'KERBEROS'];
export const isHiveConnectionType = (type: unknown): boolean => {
  const token = String(type ?? '').trim().toLowerCase();
  return token === 'hive' || getDataSourceSpec(token)?.dialect === 'hive';
};

export const readHiveParams = (raw: unknown): URLSearchParams =>
  new URLSearchParams(String(raw ?? '').trim().replace(/^[?&]+/, ''));

export const hiveFamily = (params: URLSearchParams): HiveFamily => {
  const value = params.get('hiveFamily')?.trim().toLowerCase();
  return value === 'spark' || value === 'impala' ? value : 'hive';
};
export const hiveTransport = (params: URLSearchParams): HiveTransport =>
  params.get('transportMode')?.trim().toLowerCase() === 'http' ? 'http' : 'binary';
export const hiveAuth = (params: URLSearchParams): HiveAuth => {
  const value = (params.get('authMode') ?? params.get('auth'))?.trim().toUpperCase();
  return HIVE_AUTH_MODES.find((mode) => mode === value) ?? (params.get('principal') ? 'KERBEROS' : 'NONE');
};
export const getHiveDefaultPort = (family: HiveFamily, transport: HiveTransport): number =>
  transport === 'http' ? (family === 'impala' ? 28000 : 10001) : family === 'impala' ? 21050 : 10000;

export const updateHiveParam = (raw: unknown, key: string, value: unknown): string => {
  const params = readHiveParams(raw);
  const text = String(value ?? '').trim();
  if (text) params.set(key, text);
  else params.delete(key);
  return params.toString();
};

export const invalidHiveConnectionOption = (params: URLSearchParams): string | undefined => {
  const auth = params.get('authMode') ?? params.get('auth');
  if (auth && !HIVE_AUTH_MODES.some(mode => mode === auth.trim().toUpperCase())) return 'authMode';
  const family = params.get('hiveFamily')?.trim().toLowerCase();
  if (family && !['hive', 'spark', 'impala'].includes(family)) return 'hiveFamily';
  const transport = params.get('transportMode')?.trim().toLowerCase();
  if (transport && !['binary', 'http'].includes(transport)) return 'transportMode';
  const qop = params.get('saslQop')?.trim();
  if (qop && qop !== 'auth') return 'saslQop';
  return undefined;
};

export const normalizeHiveConnectionParams = (raw: unknown): string => {
  const params = readHiveParams(raw);
  const invalid = invalidHiveConnectionOption(params);
  if (invalid) throw new Error(t('connection.modal.hive.invalidOptions', { option: invalid }));
  params.set('hiveFamily', hiveFamily(params));
  params.set('transportMode', hiveTransport(params));
  params.set('authMode', hiveAuth(params));
  params.delete('auth');
  return params.toString();
};

export type HiveUriValues = Pick<ConnectionConfig,
  'host' | 'port' | 'user' | 'password' | 'database' | 'connectionParams' | 'useSSL' | 'sslMode'
>;
const decode = (value: string): string => decodeURIComponent(value);
const bool = (value: string | null): boolean => /^(true|1|yes)$/i.test(value ?? '');

// JDBC HiveServer2 properties follow the database path, separated by semicolons.
// Keep passwords in the existing secret field, never in ConnectionParams.
export const parseHiveUri = (raw: string): HiveUriValues | null => {
  const text = String(raw ?? '').trim();
  if (text.length > 65536 || /[\r\n\0]/.test(text) || /%(?![a-f0-9]{2})/i.test(text)) return null;
  if (/^https?:\/\//i.test(text)) return parseHiveHTTPUri(text);
  const match = /^(?:jdbc:)?hive2?:\/\/([^/?;#]+)(?:\/([^?;#]*))?((?:;[^?#]*)?)(?:\?([^#]*))?$/i.exec(text);
  if (!match) return null;
  try {
    const params = new URLSearchParams(match[4] ?? '');
    for (const property of (match[3] ?? '').split(';').filter(Boolean)) {
      const separator = property.indexOf('=');
      if (separator < 1) return null;
      params.set(decode(property.slice(0, separator)), decode(property.slice(separator + 1)));
    }
    if (invalidHiveConnectionOption(params)) return null;
    const authority = new URL('hive://' + match[1]);
    if (!authority.hostname || authority.hostname.includes(',') || /\s/.test(authority.hostname)) return null;
    const family = hiveFamily(params);
    const transport = hiveTransport(params);
    const port = authority.port ? Number(authority.port) : getHiveDefaultPort(family, transport);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const user = params.get('user') ?? decode(authority.username);
    const password = params.get('password') ?? decode(authority.password);
    const useSSL = bool(params.get('ssl') ?? params.get('tls'));
    const sslMode = useSSL ? (bool(params.get('skip_verify')) ? 'skip-verify' : 'required') : 'disable';
    for (const key of ['user', 'password', 'ssl', 'tls', 'skip_verify']) params.delete(key);
    params.set('hiveFamily', family);
    params.set('transportMode', transport);
    params.set('authMode', hiveAuth(params));
    params.delete('auth');
    return {
      host: authority.hostname.replace(/^\[|\]$/g, ''), port, user, password,
      database: decode(match[2] ?? '') || 'default', useSSL, sslMode,
      connectionParams: params.toString(),
    };
  } catch { return null; }
};

const parseHiveHTTPUri = (text: string): HiveUriValues | null => {
  try {
    const url = new URL(text);
    if (url.hash) return null;
    const params = new URLSearchParams(url.search);
    const database = params.get('database') || 'default';
    params.delete('database');
    params.set('transportMode', 'http');
    params.set('httpPath', decode(url.pathname).replace(/^\/+/, '') || 'cliservice');
    params.set('ssl', String(url.protocol === 'https:'));
    const authority = (url.username ? url.username + (url.password ? ':' + url.password : '') + '@' : '')
      + url.hostname + ':' + (url.port || (url.protocol === 'https:' ? '443' : '80'));
    return parseHiveUri('jdbc:hive2://' + authority + '/' + encodeURIComponent(database) + '?' + params.toString());
  } catch { return null; }
};

export const buildHiveUri = (values: Partial<ConnectionConfig>): string => {
  const params = readHiveParams(normalizeHiveConnectionParams(values.connectionParams));
  const family = hiveFamily(params);
  const transport = hiveTransport(params);
  params.set('hiveFamily', family);
  params.set('transportMode', transport);
  params.set('authMode', hiveAuth(params));
  params.delete('auth');
  for (const key of ['user', 'password', 'ssl', 'tls', 'skip_verify']) params.delete(key);
  if (values.user) params.set('user', values.user);
  if (values.password) params.set('password', values.password);
  if (values.useSSL) params.set('ssl', 'true');
  if (values.useSSL && values.sslMode === 'skip-verify') params.set('skip_verify', 'true');
  const host = String(values.host || 'localhost').replace(/^\[|\]$/g, '');
  const address = host.includes(':') ? '[' + host + ']' : host;
  const port = Number(values.port) || getHiveDefaultPort(family, transport);
  const properties = Array.from(params).map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join(';');
  return 'jdbc:hive2://' + address + ':' + port + '/' + encodeURIComponent(values.database || 'default') + (properties ? ';' + properties : '');
};
