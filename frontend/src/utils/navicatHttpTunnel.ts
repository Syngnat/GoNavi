import type { ConnectionConfig } from '../types';

type TunnelConnection = Pick<ConnectionConfig, 'type' | 'useHttpTunnel' | 'httpTunnel'>;

export const isNavicatHttpTunnelConnection = (
  config: TunnelConnection | null | undefined,
): boolean => {
  if (!config?.useHttpTunnel) return false;
  const type = String(config.type || '').trim().toLowerCase();
  if (!['', 'mysql', 'goldendb', 'greatdb', 'gdb'].includes(type)) return false;
  const host = String(config.httpTunnel?.host || '').trim();
  const authority = /^https?:\/\/([^/?#]+)/i.exec(host)?.[1];
  if (!authority || /[\\\s]/.test(authority)) return false;
  try {
    const url = new URL(host);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== '';
  } catch {
    return false;
  }
};
