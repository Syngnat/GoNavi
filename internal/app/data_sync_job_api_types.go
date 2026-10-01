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
	UnmigratedIndex   *sync.UnmigratedIndex         `json:"unmigratedIndex,omitempty"`
	PreflightProgress *DataSyncJobPreflightProgress `json:"preflightProgress,omitempty"`
}

// DataSyncJobPreflightProgress 记录预检被中止时映射校验的进度。
//
// 报「超时」但不说查到哪一张，用户无从判断是任务太大还是源端真的卡住；
// MappingKey 用与前端一致的稳定键，使「定位」能直接跳到卡住的那一行。
type DataSyncJobPreflightProgress struct {
	Checked    int    `json:"checked"`
	Total      int    `json:"total"`
	MappingKey string `json:"mappingKey,omitempty"`
	// MappingLabel 是给人看的源→目标描述。MappingKey 是给前端匹配行用的稳定
	// 标识，两者不能混用：展示串含 " -> "，前端无法用它定位到映射行。
	MappingLabel string `json:"mappingLabel,omitempty"`
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
