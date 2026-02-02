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
}

export interface SavedConnection {
  id: string;
  name: string;
  config: ConnectionConfig;
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
  type: 'query' | 'table' | 'design';
  connectionId: string;
  dbName?: string;
  tableName?: string;
  query?: string;
  initialTab?: string;
  readOnly?: boolean;
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
