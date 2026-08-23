// Redis Cluster/Sentinel 与 SSH 隧道的组合当前不被后端支持：
// internal/redis/redis_impl.go 在连接开始时无条件拒绝
// （redis.backend.error.topology_ssh_tunnel_unsupported）。
// 前端所有 SSH 入口统一复用此判定，避免保存必然失败的组合。
const REDIS_SSH_UNSUPPORTED_TOPOLOGIES = new Set(['cluster', 'sentinel']);

export const normalizeRedisTopologyToken = (raw: unknown): string => (
  String(raw || '').trim().toLowerCase()
);

export const supportsRedisSshTunnel = (topology: unknown): boolean => (
  !REDIS_SSH_UNSUPPORTED_TOPOLOGIES.has(normalizeRedisTopologyToken(topology))
);
