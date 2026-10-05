import type { JVMConfig } from './jvmTypes';

export interface SSHConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  keyPath?: string;
  knownHostsPath?: string;
  hostKeyFingerprint?: string;
}

export interface ProxyConfig {
  type: "socks5" | "http";
  host: string;
  port: number;
  user?: string;
  password?: string;
}

export interface HTTPTunnelConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  encodeBase64?: boolean;
}

export interface ConnectionProtectionConfig {
  restrictDataEdit?: boolean;
  restrictStructureEdit?: boolean;
  restrictScriptExecution?: boolean;
  restrictDataImport?: boolean;
}

export interface ConnectionConfig {
  id?: string;
  type: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  savePassword?: boolean;
  database?: string;
  readOnly?: boolean;
  protection?: ConnectionProtectionConfig;
  useSSL?: boolean;
  sslMode?: "preferred" | "required" | "skip-verify" | "disable";
  sslCAPath?: string;
  sslCertPath?: string;
  sslKeyPath?: string;
  useSSH?: boolean;
  ssh?: SSHConfig;
  useProxy?: boolean;
  proxy?: ProxyConfig;
  useHttpTunnel?: boolean;
  httpTunnel?: HTTPTunnelConfig;
  driver?: string;
  dsn?: string;
  connectionParams?: string;
  timeout?: number;
  queryTimeout?: number; // transient per-request override; not a saved connection setting
  keepAliveEnabled?: boolean;
  keepAliveIntervalMinutes?: number;
  keepAliveSQL?: string;
  redisDB?: number; // Redis database index
  uri?: string; // Connection URI for copy/paste
  clickHouseProtocol?: "auto" | "http" | "native"; // ClickHouse connection protocol override
  oceanBaseProtocol?: "mysql" | "oracle"; // OceanBase tenant compatibility protocol
  driverVariant?: string; // Registry data sources: "auto" or a declared driver variant id
  hosts?: string[]; // Multi-host addresses: host:port
  topology?: "single" | "replica" | "cluster" | "sentinel";
  redisSentinelMaster?: string;
  redisSentinelUser?: string;
  redisSentinelPassword?: string;
  mysqlReplicaUser?: string;
  mysqlReplicaPassword?: string;
  replicaSet?: string;
  authSource?: string;
  readPreference?: string;
  mongoSrv?: boolean;
  mongoAuthMechanism?: string;
  mongoReplicaUser?: string;
  mongoReplicaPassword?: string;
  jvm?: JVMConfig;
}

export type ConnectionEnvironmentType =
  | 'production'
  | 'test'
  | 'development'
  | 'local';

export interface MongoMemberInfo {
  host: string;
  role: string;
  state: string;
  stateCode?: number;
  healthy: boolean;
  isSelf?: boolean;
}

export interface SavedConnection {
  id: string;
  name: string;
  createdAt?: number;
  environmentType?: ConnectionEnvironmentType;
  config: ConnectionConfig;
  secretRef?: string;
  hasPrimaryPassword?: boolean;
  hasSSHPassword?: boolean;
  hasProxyPassword?: boolean;
  hasHttpTunnelPassword?: boolean;
  hasMySQLReplicaPassword?: boolean;
  hasMongoReplicaPassword?: boolean;
  hasRedisSentinelPassword?: boolean;
  hasOpaqueURI?: boolean;
  hasOpaqueDSN?: boolean;
  /** Legacy exact database names kept for backwards-compatible visibility rules. */
  includeDatabases?: string[];
  /** Database name masks. `*`/`%` match any text and `_` matches one character. */
  includeDatabasePatterns?: string[];
  /** Database name masks that always take precedence over include rules. */
  excludeDatabasePatterns?: string[];
  includeRedisDatabases?: number[]; // Redis databases to show
  schemaVisibilityByDatabase?: Record<string, SchemaVisibilityRule>;
  iconType?: string; // 自定义图标类型（如 'mysql','postgres'），不填则取 config.type
  iconColor?: string; // 自定义图标颜色（十六进制），不填则取类型默认色
}

export interface SchemaVisibilityRule {
  mode: 'include' | 'exclude';
  schemas: string[];
}

export interface GlobalProxyConfig extends ProxyConfig {
  enabled: boolean;
  hasPassword?: boolean;
  secretRef?: string;
}

export interface ConnectionTag {
  id: string;
  name: string;
  createdAt?: number;
  /**
   * Parent group id. An omitted value keeps the group at the sidebar root.
   * Hosts are always owned by exactly one direct group, while groups can nest.
   */
  parentTagId?: string;
  connectionIds: string[];
  /**
   * Direct child display order. Entries use the same `tag:<id>` and
   * `connection:<id>` tokens as the sidebar root order.
   */
  childOrder?: string[];
  /** Direct connection display order within this group. */
  connectionSortMode?: ConnectionDisplaySortMode;
  sortMode?: ConnectionSortMode;
}

export type ConnectionSortMode = 'manual' | 'name' | 'createdAt';
export type ConnectionDisplaySortMode = 'manual' | 'name' | 'createdAt';

export interface ConnectionSidebarLayoutInput {
  connectionTags: ConnectionTag[];
  sidebarRootOrder: string[];
  rootSortMode?: ConnectionSortMode;
  rootConnectionSortMode?: ConnectionDisplaySortMode;
}

export interface ConnectionSidebarLayout extends ConnectionSidebarLayoutInput {
  initialized: boolean;
  revision: number;
}

export interface SaveConnectionSidebarLayoutInput {
  expectedRevision: number;
  layout: ConnectionSidebarLayoutInput;
}

export interface SaveConnectionSidebarLayoutResult {
  conflict: boolean;
  layout: ConnectionSidebarLayout;
}
