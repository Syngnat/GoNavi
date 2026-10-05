export type SyncLogEvent = {
  jobId: string;
  level?: string;
  message?: string;
  ts?: number;
};
export type SyncProgressEvent = {
  jobId: string;
  percent?: number;
  current?: number;
  total?: number;
  table?: string;
  stage?: string;
};
export type SyncLogItem = { level: string; message: string; ts?: number };
export type TableDiffSummary = {
  table: string;
  pkColumn?: string;
  canSync?: boolean;
  inserts?: number;
  updates?: number;
  deletes?: number;
  same?: number;
  schemaDiffCount?: number;
  message?: string;
  targetTableExists?: boolean;
  plannedAction?: string;
  warnings?: string[];
  unsupportedObjects?: string[];
  indexesToCreate?: number;
  indexesSkipped?: number;
};
export type TableOps = {
  insert: boolean;
  update: boolean;
  delete: boolean;
  selectedInsertPks?: string[];
  selectedUpdatePks?: string[];
  selectedDeletePks?: string[];
};

export type WorkflowType = "sync" | "migration";
