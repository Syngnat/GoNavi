export interface SSHConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  keyPath?: string;
}

export interface ConnectionConfig {
  type: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  useSSH?: boolean;
  ssh?: SSHConfig;
  redisDB?: number; // Redis database index (0-15)
}

export interface SavedConnection {
  id: string;
  name: string;
  config: ConnectionConfig;
  includeDatabases?: string[];
  includeRedisDatabases?: number[]; // Redis databases to show (0-15)
}

export interface ColumnDefinition {
  name: string;
  type: string;
  nullable: string;
  key: string;
  default?: string;
  extra: string;
  comment: string;
}

export interface IndexDefinition {
  name: string;
  columnName: string;
  nonUnique: number;
  seqInIndex: number;
  indexType: string;
}

export interface ForeignKeyDefinition {
  name: string;
  columnName: string;
  refTableName: string;
  refColumnName: string;
  constraintName: string;
}

export interface TriggerDefinition {
  name: string;
  timing: string;
  event: string;
  statement: string;
}

export interface TabData {
  id: string;
  title: string;
  type: 'query' | 'table' | 'design' | 'redis-keys' | 'redis-command' | 'trigger';
  connectionId: string;
  dbName?: string;
  tableName?: string;
  query?: string;
  initialTab?: string;
  readOnly?: boolean;
  redisDB?: number; // Redis database index for redis tabs
  triggerName?: string; // Trigger name for trigger tabs
}

export interface DatabaseNode {
  title: string;
  key: string;
  isLeaf?: boolean;
  children?: DatabaseNode[];
  icon?: any;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  connectionId: string;
  dbName: string;
  createdAt: number;
}

// Redis types
export interface RedisKeyInfo {
  key: string;
  type: string;
  ttl: number;
}

export interface RedisScanResult {
  keys: RedisKeyInfo[];
  cursor: number;
}

export interface RedisValue {
  type: 'string' | 'hash' | 'list' | 'set' | 'zset';
  ttl: number;
  value: any;
  length: number;
}

export interface RedisDBInfo {
  index: number;
  keys: number;
}

export interface ZSetMember {
  member: string;
  score: number;
}
