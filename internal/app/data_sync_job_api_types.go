package app

import (
	"GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/synccdc"
	"GoNavi-Wails/internal/syncjob"
)

type DataSyncJobPreflightSeverity string

const (
	DataSyncJobPreflightBlocker DataSyncJobPreflightSeverity = "blocker"
	DataSyncJobPreflightWarning DataSyncJobPreflightSeverity = "warning"
	DataSyncJobPreflightInfo    DataSyncJobPreflightSeverity = "info"
)

type DataSyncJobPreflightIssueDetail struct {
	UnmigratedIndex *sync.UnmigratedIndex `json:"unmigratedIndex,omitempty"`
}

type DataSyncJobPreflightIssue struct {
	Code      string                           `json:"code"`
	Severity  DataSyncJobPreflightSeverity     `json:"severity"`
	Stage     string                           `json:"stage"`
	Message   string                           `json:"message"`
	MappingID string                           `json:"mappingId,omitempty"`
	Detail    *DataSyncJobPreflightIssueDetail `json:"detail,omitempty"`
}

type DataSyncJobPreflightResult struct {
	Success           bool                        `json:"success"`
	Status            string                      `json:"status"`
	Definition        syncjob.JobDefinition       `json:"definition"`
	DefinitionHash    string                      `json:"definitionHash,omitempty"`
	SourceFingerprint string                      `json:"sourceFingerprint,omitempty"`
	TargetFingerprint string                      `json:"targetFingerprint,omitempty"`
	ApprovalRequired  bool                        `json:"approvalRequired"`
	Capability        sync.MigrationCapability    `json:"capability"`
	CDCCapability     *synccdc.Capability         `json:"cdcCapability,omitempty"`
	Issues            []DataSyncJobPreflightIssue `json:"issues"`
	NextRunAt         []int64                     `json:"nextRunAt"`
	CheckedAt         int64                       `json:"checkedAt"`
}

type DataSyncJobApprovalResult struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expiresAt"`
}

type DataSyncJobApprovalChallengeResult struct {
	Challenge string `json:"challenge"`
	NotBefore int64  `json:"notBefore"`
	ExpiresAt int64  `json:"expiresAt"`
}
