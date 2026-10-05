package sync

import (
	"context"
	"errors"
	"fmt"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

const (
	WatermarkCursorVersion        = 1
	WatermarkDeliveryIdempotent   = "idempotent"
	WatermarkDeliveryAtLeastOnce  = "at_least_once"
	defaultWatermarkSyncBatchSize = 500
	maxWatermarkSyncBatchSize     = 10000
)

// WatermarkCursorValue is a JSON-safe, typed scalar used by durable cursors.
// Value is always canonical text so integers and decimals never pass through a
// lossy JSON float representation.
type WatermarkCursorValue struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

// WatermarkCursor is the durable position immediately after one committed
// source row. SourceTable and column metadata prevent accidental reuse for a
// different object or key definition.
type WatermarkCursor struct {
	Version           int                    `json:"version"`
	SourceTable       string                 `json:"sourceTable"`
	WatermarkColumn   string                 `json:"watermarkColumn"`
	TieBreakerColumns []string               `json:"tieBreakerColumns"`
	Watermark         WatermarkCursorValue   `json:"watermark"`
	TieBreakers       []WatermarkCursorValue `json:"tieBreakers"`
}

// WatermarkSyncRequest executes one table per call. Sync.Mappings may rename
// the object and project its columns; Table identifies the source-side object.
type WatermarkSyncRequest struct {
	Sync              SyncConfig       `json:"sync"`
	Table             string           `json:"table"`
	WatermarkColumn   string           `json:"watermarkColumn"`
	TieBreakerColumns []string         `json:"tieBreakerColumns"`
	Cursor            *WatermarkCursor `json:"cursor,omitempty"`
	BatchSize         int              `json:"batchSize,omitempty"`
	DeliverySemantics string           `json:"deliverySemantics,omitempty"`
}

// WatermarkCheckpoint is emitted only after a non-empty target change set has
// committed, or after a source page was confirmed as an insert_update no-op.
type WatermarkCheckpoint struct {
	Cursor          WatermarkCursor `json:"cursor"`
	UpperBound      WatermarkCursor `json:"upperBound"`
	Batch           int             `json:"batch"`
	SourceRows      int             `json:"sourceRows"`
	RowsInserted    int             `json:"rowsInserted"`
	RowsUpdated     int             `json:"rowsUpdated"`
	TotalSourceRows int             `json:"totalSourceRows"`
}

type WatermarkCheckpointFunc func(context.Context, WatermarkCheckpoint) error

type WatermarkSyncResult struct {
	Success           bool             `json:"success"`
	Message           string           `json:"message,omitempty"`
	Cancelled         bool             `json:"cancelled,omitempty"`
	OutcomeUnknown    bool             `json:"outcomeUnknown,omitempty"`
	SourceRowsRead    int              `json:"sourceRowsRead"`
	RowsInserted      int              `json:"rowsInserted"`
	RowsUpdated       int              `json:"rowsUpdated"`
	BatchesProcessed  int              `json:"batchesProcessed"`
	BatchesApplied    int              `json:"batchesApplied"`
	Checkpoints       int              `json:"checkpoints"`
	Cursor            *WatermarkCursor `json:"cursor,omitempty"`
	UpperBound        *WatermarkCursor `json:"upperBound,omitempty"`
	DeliverySemantics string           `json:"deliverySemantics"`
}

type watermarkRuntimePlan struct {
	config           SyncConfig
	tableName        string
	mode             string
	batchSize        int
	sourceType       string
	targetType       string
	sourceQueryTable string
	targetQueryTable string
	applyTableName   string
	sourceColumns    []connection.ColumnDefinition
	targetColumns    []connection.ColumnDefinition
	watermarkColumn  string
	tieColumns       []string
	targetTieColumns []string
	projection       *CompiledProjection
}

// SupportsWatermarkSyncDialect reports whether the execution engine can build
// bounded composite-keyset SQL for the dialect.
func SupportsWatermarkSyncDialect(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb",
		"postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb",
		"sqlserver", "sqlite", "duckdb":
		return true
	default:
		return false
	}
}

// RunWatermarkSync copies one bounded incremental window. The upper tuple is
// captured before the first page, so concurrent higher-watermark writes are
// deferred to the next invocation instead of extending this run forever.
func (s *SyncEngine) RunWatermarkSync(ctx context.Context, request WatermarkSyncRequest, checkpoint WatermarkCheckpointFunc) WatermarkSyncResult {
	if ctx == nil {
		ctx = context.Background()
	}
	runCtx := markSyncDriverContext(ctx)
	delivery, _ := normalizeWatermarkDeliverySemantics(request.DeliverySemantics)
	result := WatermarkSyncResult{Cursor: cloneWatermarkCursor(request.Cursor), DeliverySemantics: delivery}

	config, tableName, mode, batchSize, err := validateWatermarkSyncRequest(request)
	if err != nil {
		return failWatermarkSync(result, runCtx, err)
	}
	if err := runCtx.Err(); err != nil {
		return failWatermarkSync(result, runCtx, err)
	}

	sourceDB, err := newSyncDatabase(config.SourceConfig.Type)
	if err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("初始化 watermark 源数据库失败: %w", err))
	}
	targetDB, err := newSyncDatabase(config.TargetConfig.Type)
	if err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("初始化 watermark 目标数据库失败: %w", err))
	}
	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("连接 watermark 源数据库失败: %w", err))
	}
	defer sourceDB.Close()
	if err := runCtx.Err(); err != nil {
		return failWatermarkSync(result, runCtx, err)
	}
	if err := targetDB.Connect(config.TargetConfig); err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("连接 watermark 目标数据库失败: %w", err))
	}
	defer targetDB.Close()

	plan, err := buildWatermarkRuntimePlan(config, tableName, mode, batchSize, request.WatermarkColumn, request.TieBreakerColumns, sourceDB, targetDB)
	if err != nil {
		return failWatermarkSync(result, runCtx, err)
	}
	applier, ok := targetDB.(db.BatchApplier)
	if !ok {
		return failWatermarkSync(result, runCtx, errors.New("watermark 目标驱动不支持 ApplyChanges"))
	}

	if request.Cursor != nil {
		if err := validateWatermarkCursor(*request.Cursor, plan); err != nil {
			return failWatermarkSync(result, runCtx, err)
		}
	}

	upperQuery := buildWatermarkUpperBoundQuery(plan)
	upperRows, _, err := querySyncDatabaseContext(runCtx, sourceDB, upperQuery)
	if err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("读取 watermark 固定上界失败: %w", err))
	}
	if len(upperRows) == 0 {
		result.Success = true
		return result
	}
	upperBound, err := watermarkCursorFromRow(plan, upperRows[0])
	if err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("解析 watermark 固定上界失败: %w", err))
	}
	result.UpperBound = cloneWatermarkCursor(&upperBound)
	if request.Cursor != nil {
		comparison, comparable, err := compareWatermarkCursorPositions(*request.Cursor, upperBound)
		if err != nil {
			return failWatermarkSync(result, runCtx, fmt.Errorf("比较 watermark cursor 与固定上界失败: %w", err))
		}
		if comparable && comparison >= 0 {
			result.Success = true
			return result
		}
	}

	durableCursor := cloneWatermarkCursor(request.Cursor)
	for {
		if err := runCtx.Err(); err != nil {
			result.Cursor = cloneWatermarkCursor(durableCursor)
			return failWatermarkSync(result, runCtx, err)
		}
		pageQuery, err := buildWatermarkPageQuery(plan, durableCursor, upperBound)
		if err != nil {
			return failWatermarkSync(result, runCtx, err)
		}
		sourceRows, _, err := querySyncDatabaseContext(runCtx, sourceDB, pageQuery)
		if err != nil {
			return failWatermarkSync(result, runCtx, fmt.Errorf("分页读取 watermark 源表失败: %w", err))
		}
		if len(sourceRows) == 0 {
			result.Success = true
			result.Cursor = cloneWatermarkCursor(durableCursor)
			return result
		}
		result.SourceRowsRead += len(sourceRows)

		candidate, err := watermarkCursorFromRow(plan, sourceRows[len(sourceRows)-1])
		if err != nil {
			return failWatermarkSync(result, runCtx, fmt.Errorf("解析 watermark 批次游标失败: %w", err))
		}
		projectedRows, err := projectSyncRows(plan.projection, sourceRows)
		if err != nil {
			return failWatermarkSync(result, runCtx, fmt.Errorf("watermark 字段投影失败: %w", err))
		}
		changeSet, err := buildWatermarkChangeSet(runCtx, plan, targetDB, projectedRows)
		if err != nil {
			return failWatermarkSync(result, runCtx, err)
		}

		batchInserted := len(changeSet.Inserts)
		batchUpdated := len(changeSet.Updates)
		if batchInserted > 0 || batchUpdated > 0 {
			if err := applySyncChangesByKindContext(runCtx, applier, plan.applyTableName, changeSet, targetNeedsSingleKindBatches(config.TargetConfig)); err != nil {
				result.Cursor = cloneWatermarkCursor(durableCursor)
				result.OutcomeUnknown = db.IsWriteOutcomeUnknown(err)
				return failWatermarkSync(result, runCtx, fmt.Errorf("应用 watermark 目标批次失败: %w", err))
			}
			result.RowsInserted += batchInserted
			result.RowsUpdated += batchUpdated
			result.BatchesApplied++
		}
		if err := runCtx.Err(); err != nil {
			result.Cursor = cloneWatermarkCursor(durableCursor)
			return failWatermarkSync(result, runCtx, err)
		}

		checkpointEvent := WatermarkCheckpoint{
			Cursor:          *cloneWatermarkCursor(&candidate),
			UpperBound:      *cloneWatermarkCursor(&upperBound),
			Batch:           result.BatchesProcessed + 1,
			SourceRows:      len(sourceRows),
			RowsInserted:    batchInserted,
			RowsUpdated:     batchUpdated,
			TotalSourceRows: result.SourceRowsRead,
		}
		if checkpoint != nil {
			if err := checkpoint(runCtx, checkpointEvent); err != nil {
				result.Cursor = cloneWatermarkCursor(durableCursor)
				return failWatermarkSync(result, runCtx, fmt.Errorf("持久化 watermark checkpoint 失败（目标批次可能已提交）: %w", err))
			}
			result.Checkpoints++
		}
		durableCursor = cloneWatermarkCursor(&candidate)
		result.Cursor = cloneWatermarkCursor(durableCursor)
		result.BatchesProcessed++
		comparison, comparable, err := compareWatermarkCursorPositions(candidate, upperBound)
		if err != nil {
			return failWatermarkSync(result, runCtx, fmt.Errorf("比较 watermark 批次游标与固定上界失败: %w", err))
		}
		if comparable && comparison >= 0 {
			result.Success = true
			return result
		}
		if len(sourceRows) < plan.batchSize {
			result.Success = true
			return result
		}
	}
}
