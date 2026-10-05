export type SecurityUpdateOverallStatus =
  | "not_detected"
  | "pending"
  | "postponed"
  | "in_progress"
  | "needs_attention"
  | "completed"
  | "rolled_back";

export type SecurityUpdateIssueScope =
  | "connection"
  | "global_proxy"
  | "ai_provider"
  | "system";
export type SecurityUpdateIssueSeverity = "high" | "medium" | "low";
export type SecurityUpdateItemStatus =
  | "pending"
  | "updated"
  | "needs_attention"
  | "skipped"
  | "failed";
export type SecurityUpdateIssueReasonCode =
  | "migration_required"
  | "secret_missing"
  | "field_invalid"
  | "write_conflict"
  | "validation_failed"
  | "environment_blocked";
export type SecurityUpdateIssueAction =
  | "open_connection"
  | "open_proxy_settings"
  | "open_ai_settings"
  | "retry_update"
  | "view_details";

export interface SecurityUpdateSummary {
  total: number;
  updated: number;
  pending: number;
  skipped: number;
  failed: number;
}

export interface SecurityUpdateIssue {
  id: string;
  scope?: SecurityUpdateIssueScope;
  refId?: string;
  title?: string;
  severity?: SecurityUpdateIssueSeverity;
  status?: SecurityUpdateItemStatus;
  reasonCode?: SecurityUpdateIssueReasonCode;
  action?: SecurityUpdateIssueAction;
  message?: string;
}

export interface SecurityUpdateStatus {
  schemaVersion?: number;
  migrationId?: string;
  overallStatus: SecurityUpdateOverallStatus;
  sourceType?: "current_app_saved_config";
  reminderVisible?: boolean;
  canStart?: boolean;
  canPostpone?: boolean;
  canRetry?: boolean;
  backupAvailable?: boolean;
  backupPath?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  postponedAt?: string;
  summary: SecurityUpdateSummary;
  issues: SecurityUpdateIssue[];
  lastError?: string;
}
