package app

import (
	"context"
	"fmt"
	"strings"

	syncbackend "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

// enabledDataSyncTableMappings 取出任务里启用的映射，保持原顺序。
func enabledDataSyncTableMappings(definition syncjob.JobDefinition) []syncjob.TableMapping {
	enabled := make([]syncjob.TableMapping, 0, len(definition.Mappings))
	for _, mapping := range definition.Mappings {
		if mapping.Enabled {
			enabled = append(enabled, mapping)
		}
	}
	return enabled
}

// executeCompareJob 执行只读对比任务。
//
// 对比是「选完两端直接比」，不再逐表勾选，所以这里把全部表合并成一个分析配置：
// Analyze 内部按表循环并复用同一对连接，逐映射建连接会在上千张表上把耗时放大
// 到不可用。任务没有映射时按源库全部表同名展开。
func (executor appDataSyncJobExecutor) executeCompareJob(
	ctx context.Context,
	request syncjob.ExecutionRequest,
	definition syncjob.JobDefinition,
	source, target resolvedDataSyncJobEndpoint,
	reporter syncjob.RunReporter,
) (syncjob.ExecutionOutcome, error) {
	mappings := enabledDataSyncTableMappings(definition)
	if len(mappings) == 0 {
		enumerated, err := executor.enumerateCompareMappings(ctx, definition, source, target)
		if err != nil {
			return syncjob.ExecutionOutcome{}, err
		}
		mappings = enumerated
	}
	if len(mappings) == 0 {
		return syncjob.ExecutionOutcome{}, fmt.Errorf("源库里没有可比对的表")
	}
	config, err := buildDataSyncCompareEngineConfig(definition, request.Run.ID, source, target, mappings)
	if err != nil {
		return syncjob.ExecutionOutcome{}, err
	}
	if err := ctx.Err(); err != nil {
		return syncjob.ExecutionOutcome{Resumable: true}, err
	}
	adapter := syncbackend.Reporter{
		OnLog: func(event syncbackend.SyncLogEvent) {
			_ = reporter.Emit(syncjob.RunEventLog, event.Message, mustJSON(map[string]interface{}{
				"level": event.Level,
				"ts":    event.Ts,
			}))
		},
		OnProgress: func(event syncbackend.SyncProgressEvent) {
			_ = reporter.Emit(syncjob.RunEventProgress, event.Stage, mustJSON(event))
		},
	}
	analysis := syncbackend.NewSyncEngine(adapter).Analyze(config)
	if !analysis.Success {
		return syncjob.ExecutionOutcome{}, fmt.Errorf("%s", analysis.Message)
	}
	_ = reporter.Emit(syncjob.RunEventLog, analysis.Message, mustJSON(analysis))
	return syncjob.ExecutionOutcome{Message: analysis.Message}, nil
}

// enumerateCompareMappings 把源库全部表按同名展开成映射。
//
// 只读对比不建表、不改结构，所以这里不关心目标表是否存在：缺失的表由 analyze
// 作为整表缺表差异返回，前端据此生成建表语句。
func (executor appDataSyncJobExecutor) enumerateCompareMappings(
	ctx context.Context,
	definition syncjob.JobDefinition,
	source, target resolvedDataSyncJobEndpoint,
) ([]syncjob.TableMapping, error) {
	database, err := executor.app.getDatabaseWithContext(ctx, normalizeMetadataRunConfig(source.Config, source.Database), false)
	if err != nil {
		return nil, fmt.Errorf("连接源库以枚举表失败: %w", err)
	}
	tables, err := database.GetTables(source.Database)
	if err != nil {
		return nil, fmt.Errorf("读取源库表清单失败: %w", err)
	}
	targetSchema := firstNonEmptySyncJob(target.Schema, definition.Target.Schema)
	mappings := make([]syncjob.TableMapping, 0, len(tables))
	for _, raw := range tables {
		table := strings.TrimSpace(raw)
		if table == "" {
			continue
		}
		mappings = append(mappings, syncjob.TableMapping{
			Enabled:             true,
			SourceSchema:        firstNonEmptySyncJob(source.Schema, definition.Source.Schema),
			SourceTable:         table,
			TargetSchema:        targetSchema,
			TargetTable:         table,
			TargetTableStrategy: "existing_only",
		})
	}
	return mappings, nil
}

// buildDataSyncCompareEngineConfig 把全部对比映射合并成一次分析所需的配置。
func buildDataSyncCompareEngineConfig(
	definition syncjob.JobDefinition,
	runID string,
	source, target resolvedDataSyncJobEndpoint,
	mappings []syncjob.TableMapping,
) (syncbackend.SyncConfig, error) {
	config := syncbackend.SyncConfig{
		SourceConfig:   source.Config,
		TargetConfig:   target.Config,
		SourceDatabase: source.Database,
		TargetDatabase: target.Database,
		Content:        definition.Options.Content,
		Mode:           dataSyncJobEffectiveSyncMode(definition),
		JobID:          runID,
		// 只读对比：缺表是差异而不是失败。
		CompareOnly: true,
	}
	tables := make([]string, 0, len(mappings))
	engineMappings := make([]syncbackend.SyncObjectMapping, 0, len(mappings))
	tableOptions := make(map[string]syncbackend.TableOptions, len(mappings))
	for _, mapping := range mappings {
		sourceTable := strings.TrimSpace(mapping.SourceTable)
		if sourceTable == "" {
			continue
		}
		if mapping.SourceSchema != "" {
			sourceTable = strings.TrimSpace(mapping.SourceSchema) + "." + sourceTable
		}
		engineMapping, err := buildEngineObjectMapping(mapping)
		if err != nil {
			return syncbackend.SyncConfig{}, err
		}
		tables = append(tables, sourceTable)
		engineMappings = append(engineMappings, engineMapping)
		tableOptions[sourceTable] = syncbackend.TableOptions{}
	}
	if len(tables) == 0 {
		return syncbackend.SyncConfig{}, fmt.Errorf("源库里没有可比对的表")
	}
	config.Tables = tables
	config.Mappings = engineMappings
	config.TableOptions = tableOptions
	config.TargetSchema = firstNonEmptySyncJob(target.Schema, definition.Target.Schema)
	config.AutoAddColumns = false
	config.CreateIndexes = false
	config.TargetTableStrategy = "existing_only"
	return config, nil
}
