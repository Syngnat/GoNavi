package sync

import "GoNavi-Wails/internal/connection"

// SyncConfig defines the parameters for a synchronization task
type SyncConfig struct {
	hiveMicrosecondTarget bool
	// characterLengthTarget is scoped to this plan; never serialized or shared across connections.
	characterLengthTarget *characterLengthTarget
	SourceConfig          connection.ConnectionConfig `json:"sourceConfig"`
	TargetConfig          connection.ConnectionConfig `json:"targetConfig"`
	SourceDatabase        string                      `json:"sourceDatabase,omitempty"`
	TargetDatabase        string                      `json:"targetDatabase,omitempty"`
	TargetSchema          string                      `json:"targetSchema,omitempty"`
	Tables                []string                    `json:"tables"`
	SourceQuery           string                      `json:"sourceQuery,omitempty"`
	Content               string                      `json:"content,omitempty"` // "data", "schema", "both"
	Mode                  string                      `json:"mode"`              // "insert_update", "insert_only", "full_overwrite"
	JobID                 string                      `json:"jobId,omitempty"`
	// CompareOnly 标记只读对比任务：目标缺表是它要报告的差异，不是失败，
	// 分析阶段要按整表缺表返回结构化列差异，供前端生成建表语句。
	CompareOnly           bool                        `json:"-"`
	AutoAddColumns        bool                        `json:"autoAddColumns,omitempty"` // 自动补齐缺失字段
	TargetTableStrategy   string                      `json:"targetTableStrategy,omitempty"`
	CreateIndexes         bool                        `json:"createIndexes,omitempty"`
	MongoCollectionName   string                      `json:"mongoCollectionName,omitempty"`
	TableOptions          map[string]TableOptions     `json:"tableOptions,omitempty"`
	Mappings              []SyncObjectMapping         `json:"mappings,omitempty"`
	// identityMappingTarget is populated only while a schema planner handles a
	// column-identity object rename. It is intentionally not part of the public
	// config payload: callers express it through Mappings.
	identityMappingTarget SyncObjectRef
	BatchSize             int    `json:"batchSize,omitempty"`
	RowErrorPolicy        string `json:"rowErrorPolicy,omitempty"`
	// ExistingTargetInsertWithoutKey 允许「目标表已存在 + 源表无物理主键」的
	// insert_update 任务降级为追加写入：不再要求稳定 key 做行级比对，
	// 直接把源行整体插入目标表。仅由任务编排层在确认该映射本可自动建表
	// （即用户预期是新建导入而非差异同步）时设置；手动复制的引擎调用不设。
	ExistingTargetInsertWithoutKey bool                    `json:"existingTargetInsertWithoutKey,omitempty"`
	OnRowError                     ChangeEventRowErrorFunc `json:"-"`
}
