package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/syncjob"
)

// 对比任务的全部表必须合并进同一个分析配置：analyze 按表循环并复用同一对连接，
// 逐映射建连接会在上千张表时把耗时放大到不可用。
func TestBuildDataSyncCompareEngineConfigMergesEveryMapping(t *testing.T) {
	definition := syncjob.JobDefinition{
		Kind: syncjob.JobKindCompare,
		Options: syncjob.ExecutionOptions{
			Content: "schema",
		},
	}
	source := resolvedDataSyncJobEndpoint{
		Config:   connection.ConnectionConfig{Type: "mysql"},
		Database: "dev240",
		Schema:   "dev240",
	}
	target := resolvedDataSyncJobEndpoint{
		Config:   connection.ConnectionConfig{Type: "mysql"},
		Database: "prod1",
		Schema:   "prod1",
	}
	mappings := []syncjob.TableMapping{
		// 未指定源 schema 时保留裸表名，由 config 的库/schema 上下文定位。
		{Enabled: true, SourceTable: "kf_ai_platform", TargetTable: "kf_ai_platform"},
		// 指定了源 schema 的映射必须带前缀，否则同名表会跨 schema 混起来。
		{Enabled: true, SourceSchema: "dev240", SourceTable: "kf_ai_config", TargetTable: "kf_ai_config_alias"},
	}

	config, err := buildDataSyncCompareEngineConfig(definition, "run-1", source, target, mappings)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !config.CompareOnly {
		t.Fatal("compare config must carry the read-only compare marker")
	}
	if len(config.Tables) != 2 {
		t.Fatalf("expected 2 source tables, got %d: %v", len(config.Tables), config.Tables)
	}
	if config.Tables[0] != "kf_ai_platform" || config.Tables[1] != "dev240.kf_ai_config" {
		t.Fatalf("unexpected qualified source tables: %v", config.Tables)
	}
	if len(config.Mappings) != 2 {
		t.Fatalf("expected 2 engine mappings, got %d", len(config.Mappings))
	}
	// 目标名可被用户改写，必须原样带进引擎，否则会按同名去比错的表。
	if config.Mappings[1].Target.Name != "kf_ai_config_alias" {
		t.Fatalf("unexpected target override: %+v", config.Mappings[1].Target)
	}
	if config.TargetTableStrategy != "existing_only" {
		t.Fatalf("compare must never create targets, got %q", config.TargetTableStrategy)
	}
}

func TestBuildDataSyncCompareEngineConfigRejectsEmptyMappings(t *testing.T) {
	definition := syncjob.JobDefinition{Kind: syncjob.JobKindCompare}
	source := resolvedDataSyncJobEndpoint{Config: connection.ConnectionConfig{Type: "mysql"}, Database: "dev240"}
	target := resolvedDataSyncJobEndpoint{Config: connection.ConnectionConfig{Type: "mysql"}, Database: "prod1"}

	if _, err := buildDataSyncCompareEngineConfig(definition, "run-1", source, target, nil); err == nil {
		t.Fatal("expected an error when nothing can be compared")
	}
}
