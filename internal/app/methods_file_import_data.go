package app

import (
	"context"
	"errors"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/uievents"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// PreviewImportFile 解析导入文件，返回字段列表、总行数、前 5 行预览数据
func (a *App) PreviewImportFile(filePath string) connection.QueryResult {
	return a.previewImportFileContext(context.Background(), filePath, ImportFileOptions{})
}

// PreviewImportFileWithOptions previews a file with the same parser settings
// that will be used by ImportDataWithProgressOptions.
func (a *App) PreviewImportFileWithOptions(filePath string, options ImportFileOptions) (queryResult connection.QueryResult) {
	return a.previewImportFileContext(context.Background(), filePath, options)
}

func (a *App) previewImportFileContext(ctx context.Context, filePath string, options ImportFileOptions) (queryResult connection.QueryResult) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(filePath) == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_file_empty", nil)}
	}
	fileReference := filePath
	resolvedPath, err := a.resolveWebUploadReference(filePath, webUploadPurposeDataImport)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	filePath = resolvedPath
	if a.webRuntime {
		defer func() { queryResult = sanitizeWebManagedResult(queryResult, filePath) }()
	}
	if err := validateImportFileOptions(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	sourceIdentity, err := captureImportSourceIdentity(filePath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	preview, err := buildImportPreviewWithOptionsContext(ctx, filePath, defaultImportPreviewLimit, options)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	result := map[string]interface{}{
		"columns":        preview.Columns,
		"totalRows":      preview.TotalRows,
		"totalRowsKnown": preview.TotalRowsKnown,
		"previewRows":    preview.PreviewRows,
		"filePath":       filePath,
		"fileSize":       sourceIdentity.Size,
		"sourceIdentity": sourceIdentity,
	}
	if a.webRuntime {
		result["filePath"] = fileReference
	}

	return connection.QueryResult{Success: true, Data: result}
}

func (a *App) ImportData(config connection.ConnectionConfig, dbName, tableName string) connection.QueryResult {
	if err := ensureConnectionAllowsDataImport(config, "connection.backend.action.import_data"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: a.appText("file.backend.dialog.import_data", map[string]any{"table": tableName}),
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.data_files", nil),
				Pattern:     "*.csv;*.json;*.xlsx",
			},
		},
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	// 返回文件路径供前端预览
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": selection}}
}

// ImportDataWithProgress 执行导入并发送进度事件
func (a *App) ImportDataWithProgress(config connection.ConnectionConfig, dbName, tableName, filePath string) (result connection.QueryResult) {
	return a.ImportDataWithProgressOptions(config, dbName, tableName, filePath, ImportFileOptions{})
}

func buildImportExecutionPayload(resultData importExecutionResult, summary string, cancelled bool) map[string]interface{} {
	total := resultData.Total
	if cancelled || (resultData.StoppedOnError && !resultData.OutcomeUnknown) {
		// Rows parsed into a buffer but never attempted are not processed rows.
		// A failed batch remains unknown because the batch API may have written a
		// subset before returning its error.
		total = resultData.Success + resultData.Skipped + resultData.Failed
	}
	return map[string]interface{}{
		"success":                       resultData.Success,
		"skipped":                       resultData.Skipped,
		"failed":                        resultData.Failed,
		"total":                         total,
		"affectedRows":                  int64(resultData.Success),
		"errorLogs":                     resultData.ErrorLogs,
		"errorLogsOmitted":              max(0, resultData.Failed-len(resultData.ErrorLogs)),
		"errorArtifactId":               resultData.ErrorArtifactID,
		"errorArtifactCount":            resultData.ErrorArtifactCount,
		"errorArtifactBytes":            resultData.ErrorArtifactBytes,
		"errorArtifactOmittedCount":     resultData.ErrorArtifactOmittedCount,
		"errorArtifactTruncated":        resultData.ErrorArtifactTruncated,
		"errorArtifactRetryableCount":   resultData.ErrorArtifactRetryableCount,
		"errorArtifactUnretryableCount": resultData.ErrorArtifactUnretryableCount,
		"errorArtifactScopeKnown":       resultData.ErrorArtifactScopeKnown,
		"errorArtifactMaxRows":          resultData.ErrorArtifactMaxRows,
		"errorArtifactMaxBytes":         resultData.ErrorArtifactMaxBytes,
		"errorSummary":                  summary,
		"cancelled":                     cancelled,
		"stoppedOnError":                resultData.StoppedOnError,
		"outcomeUnknown":                resultData.OutcomeUnknown,
	}
}

func (a *App) cancelledImportResult(resultData importExecutionResult) connection.QueryResult {
	summary := a.appText("file.backend.message.import_cancelled", map[string]any{
		"imported": resultData.Success,
		"skipped":  resultData.Skipped,
		"failed":   resultData.Failed,
	})
	return connection.QueryResult{
		Success: false,
		Data:    buildImportExecutionPayload(resultData, summary, true),
		Message: summary,
	}
}

func (a *App) stoppedImportResult(resultData importExecutionResult, detail string) connection.QueryResult {
	summary := a.appText("file.backend.error.import_stopped_on_error", map[string]any{
		"imported": resultData.Success,
		"skipped":  resultData.Skipped,
		"failed":   resultData.Failed,
		"detail":   detail,
	})
	return connection.QueryResult{
		Success: false,
		Data:    buildImportExecutionPayload(resultData, summary, false),
		Message: summary,
	}
}

// ImportDataWithProgressOptions executes a streamed import with optional source-header
// to database-column mappings. ImportDataWithProgress remains the compatibility entrypoint.
func (a *App) ImportDataWithProgressOptions(config connection.ConnectionConfig, dbName, tableName, filePath string, options ImportFileOptions) (result connection.QueryResult) {
	return a.importDataWithProgressContext(context.Background(), config, dbName, tableName, filePath, options)
}

func (a *App) importDataWithProgressContext(parent context.Context, config connection.ConnectionConfig, dbName, tableName, filePath string, options ImportFileOptions) (result connection.QueryResult) {
	resolvedPath, err := a.resolveWebUploadReference(filePath, webUploadPurposeDataImport)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	filePath = resolvedPath
	if a.webRuntime {
		defer func() { result = sanitizeWebManagedResult(result, filePath) }()
	}
	return a.importDataWithProgressOptionsContext(parent, config, dbName, tableName, filePath, options, nil)
}

func (a *App) importDataWithProgressOptions(
	config connection.ConnectionConfig,
	dbName, tableName, filePath string,
	options ImportFileOptions,
	recovery *tableImportRecoveryPlan,
) (result connection.QueryResult) {
	return a.importDataWithProgressOptionsContext(context.Background(), config, dbName, tableName, filePath, options, recovery)
}

func (a *App) importDataWithProgressOptionsContext(
	parent context.Context,
	config connection.ConnectionConfig,
	dbName, tableName, filePath string,
	options ImportFileOptions,
	recovery *tableImportRecoveryPlan,
) (result connection.QueryResult) {
	if parent == nil {
		parent = context.Background()
	}
	if strings.TrimSpace(filePath) == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_file_empty", nil)}
	}
	dbType := resolveDDLDBType(config)
	schemaName, pureTableName := normalizeSchemaAndTableByType(dbType, dbName, tableName)
	auditTarget := strings.TrimSpace(tableName)
	if pureTableName != "" {
		auditTarget = quoteTableIdentByType(dbType, schemaName, pureTableName)
	}
	if auditTarget == "" {
		auditTarget = "TARGET_TABLE"
	}
	auditSQL := "IMPORT DATA INTO " + auditTarget
	auditSafeError := "data import task failed"
	defer a.beginSQLAuditUserActionWithOptions(config, dbName, "data_import", &auditSQL, &result, sqlAuditUserActionOptions{
		SafeError: &auditSafeError,
	})()
	if err := ensureConnectionAllowsDataImport(config, "connection.backend.action.import_data"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := validateImportFileOptions(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := validateImportConflictPolicyForDB(dbType, options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(options.ResumeJobID) != "" && recovery == nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_resume_unavailable", nil)}
	}
	sourceIdentity, err := captureImportSourceIdentity(filePath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if expected := strings.TrimSpace(options.SourceIdentityToken); expected != "" && expected != sourceIdentity.Token {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_source_changed", nil)}
	}
	if recovery != nil {
		if err := a.validateTableImportRecovery(recovery, config, dbName, tableName, options, sourceIdentity); err != nil {
			return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, err)}
		}
	}
	importCtx, importCancel := context.WithCancel(parent)
	defer importCancel()
	jobID := strings.TrimSpace(options.JobID)
	if recovery != nil && jobID == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_resume_unavailable", nil)}
	}
	var managedJob *managedImportJob
	var managedArtifact *managedImportErrorArtifact
	mayHaveDatabaseSideEffects := false
	if jobID != "" {
		cleanupRegistration, registered := a.registerImportTask(jobID, importCancel, importjob.KindTable)
		if !registered {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_job_already_running", nil)}
		}
		defer cleanupRegistration()
		if recovery != nil {
			if err := a.claimTableImportRecovery(recovery, sourceIdentity.Token, buildImportTargetFingerprint(config, dbName, tableName), buildImportFileOptionsHash(options)); err != nil {
				return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, err)}
			}
		}
		start := managedImportJobStart{
			ID:                  jobID,
			Kind:                importjob.KindTable,
			SourcePath:          filePath,
			SourceIdentityToken: sourceIdentity.Token,
			SourceBytesTotal:    sourceIdentity.Size,
			ByteProgressKind:    "rawSource",
			TargetFingerprint:   buildImportTargetFingerprint(config, dbName, tableName),
			ConnectionID:        config.ID,
			DatabaseName:        dbName,
			TableName:           tableName,
			OptionsHash:         buildImportFileOptionsHash(options),
			TableImportOptions:  importJobTableOptionsFromImportFileOptions(options),
		}
		if recovery != nil {
			start.Stage = "resuming"
			start.ParentJobID = recovery.ParentJob.ID
			start.RecoveryAction = "resume"
			start.Current = recovery.ParentJob.Checkpoint.SourceRow
			start.Succeeded = recovery.ParentJob.Succeeded
			start.Skipped = recovery.ParentJob.Skipped
			start.Failed = recovery.ParentJob.Failed
			start.BytesRead = recovery.ParentJob.Checkpoint.ByteOffset
			start.Checkpoint = recovery.ParentJob.Checkpoint
		}
		managedJob, err = a.beginManagedImportJob(start)
		if err != nil {
			if recovery != nil {
				_ = a.releaseTableImportRecovery(recovery)
			}
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		defer func() {
			if finishErr := managedJob.finish(managedImportJobFinishFromResult(result)); finishErr != nil && result.Success {
				result = connection.QueryResult{Success: false, Message: finishErr.Error(), Data: result.Data}
			}
		}()
		managedArtifact, err = a.beginManagedImportErrorArtifact(jobID)
		if err != nil {
			if recovery != nil {
				_ = a.releaseTableImportRecovery(recovery)
			}
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		defer managedArtifact.abort()
	}
	defer func() {
		if identityErr := validateImportSourceIdentity(filePath, sourceIdentity); identityErr != nil {
			payload, _ := result.Data.(map[string]interface{})
			if payload == nil {
				payload = map[string]interface{}{}
			}
			payload["sourceChanged"] = true
			payload["outcomeUnknown"] = mayHaveDatabaseSideEffects
			result = connection.QueryResult{
				Success: false,
				Message: a.appText("file.backend.error.import_source_changed", nil),
				Data:    payload,
			}
		}
	}()
	if err := importCtx.Err(); err != nil {
		return a.cancelledImportResult(importExecutionResult{})
	}
	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabaseSynchronouslyWithContext(importCtx, runConfig, false)
	if err != nil {
		if errors.Is(importCtx.Err(), context.Canceled) {
			return a.cancelledImportResult(importExecutionResult{})
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := importCtx.Err(); err != nil {
		return a.cancelledImportResult(importExecutionResult{})
	}
	tableCapability := ResolveDataImportCapability(runConfig, dbInst).TableImport
	if !tableCapability.Supported {
		reason := strings.TrimSpace(tableCapability.Reason)
		if reason == "" {
			reason = DataImportReasonTableRuntimeUnavailable
		}
		return connection.QueryResult{
			Success: false,
			Message: a.appText("data_import.capability.reason."+reason, nil),
		}
	}

	targetColumns, colErr := a.importTargetColumnsContext(importCtx, dbInst, config, dbName, tableName)
	if errors.Is(importCtx.Err(), context.Canceled) {
		return a.cancelledImportResult(importExecutionResult{})
	}
	if colErr != nil && options.ColumnMappings != nil {
		return connection.QueryResult{Success: false, Message: colErr.Error()}
	}

	writer := newImportDatabaseRowWriterWithOptions(dbInst, dbType, tableName, newImportColumnTypeLookup(targetColumns), options)
	var jobPersistErr error
	batchConsumer := newImportBatchConsumer(writer, defaultImportApplyBatchSize, 0, false, resolveImportContinueOnError(options), func(state importProgressState) {
		if state.Success+state.Skipped+state.Errors > 0 {
			mayHaveDatabaseSideEffects = true
		}
		uievents.Emit(a.ctx, "import:progress", state)
		if managedJob == nil || jobPersistErr != nil {
			return
		}
		jobPersistErr = managedJob.update(managedImportJobProgress{
			Stage:            state.Stage,
			Current:          int64(state.Current),
			Total:            int64(state.Total),
			Succeeded:        int64(state.Success),
			Skipped:          int64(state.Skipped),
			Failed:           int64(state.Errors),
			BytesRead:        state.BytesRead,
			SourceBytesTotal: state.TotalBytes,
			ByteProgressKind: "rawSource",
			Checkpoint: importjob.Checkpoint{
				Safe:       state.CheckpointSafe,
				SourceRow:  int64(state.Current),
				ByteOffset: state.BytesRead,
			},
			ForcePersist: state.CheckpointSafe,
		})
		if jobPersistErr != nil {
			importCancel()
		}
	})
	batchConsumer.SetContext(importCtx)
	batchConsumer.jobID = jobID
	if recovery != nil {
		batchConsumer.SetInitialProgress(
			int(recovery.ParentJob.Checkpoint.SourceRow),
			int(recovery.ParentJob.Succeeded),
			int(recovery.ParentJob.Skipped),
			int(recovery.ParentJob.Failed),
		)
	}
	if managedArtifact != nil {
		batchConsumer.SetRowErrorHandler(managedArtifact.append)
	}
	mappedConsumer, err := newImportColumnMappingConsumer(batchConsumer, options.ColumnMappings, targetColumns)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	var consumer importFileConsumer = mappedConsumer
	if recovery != nil {
		consumer = newImportResumeSkippingConsumer(consumer, recovery.ParentJob.Checkpoint.SourceRow)
	}
	finishArtifact := func(resultData *importExecutionResult) error {
		if managedArtifact == nil {
			return nil
		}
		return managedArtifact.finish(resultData)
	}
	if err := streamImportFileWithOptionsContext(importCtx, filePath, consumer, options); err != nil {
		resultData := batchConsumer.Result()
		if jobPersistErr != nil {
			if artifactErr := finishArtifact(&resultData); artifactErr != nil {
				jobPersistErr = errors.Join(jobPersistErr, artifactErr)
			}
			message := a.appText("file.backend.error.import_job_persist", map[string]any{"detail": jobPersistErr.Error()})
			return connection.QueryResult{
				Success: false,
				Data:    buildImportExecutionPayload(resultData, message, false),
				Message: message,
			}
		}
		if errors.Is(err, context.Canceled) {
			if artifactErr := finishArtifact(&resultData); artifactErr != nil {
				return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, artifactErr.Error(), false), Message: artifactErr.Error()}
			}
			maybeReleaseFileTransferMemory("import-cancelled", int64(resultData.Success+resultData.Failed), filePath)
			return a.cancelledImportResult(resultData)
		}
		if !errors.Is(err, errImportStoppedOnError) && managedArtifact != nil {
			managedArtifact.append(ImportRowError{
				SourceRow: int64(resultData.Total + 1),
				Category:  "parse",
				Message:   err.Error(),
			})
		}
		if artifactErr := finishArtifact(&resultData); artifactErr != nil {
			return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, artifactErr.Error(), false), Message: artifactErr.Error()}
		}
		maybeReleaseFileTransferMemory("import-stream-error", int64(resultData.Total), filePath)
		if errors.Is(err, errImportStoppedOnError) {
			return a.stoppedImportResult(resultData, err.Error())
		}
		return connection.QueryResult{
			Success: false,
			Data:    buildImportExecutionPayload(resultData, err.Error(), false),
			Message: err.Error(),
		}
	}
	if err := batchConsumer.Flush(); err != nil {
		resultData := batchConsumer.Result()
		if jobPersistErr != nil {
			if artifactErr := finishArtifact(&resultData); artifactErr != nil {
				jobPersistErr = errors.Join(jobPersistErr, artifactErr)
			}
			message := a.appText("file.backend.error.import_job_persist", map[string]any{"detail": jobPersistErr.Error()})
			return connection.QueryResult{
				Success: false,
				Data:    buildImportExecutionPayload(resultData, message, false),
				Message: message,
			}
		}
		if errors.Is(err, context.Canceled) {
			if artifactErr := finishArtifact(&resultData); artifactErr != nil {
				return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, artifactErr.Error(), false), Message: artifactErr.Error()}
			}
			maybeReleaseFileTransferMemory("import-cancelled", int64(resultData.Success+resultData.Failed), filePath)
			return a.cancelledImportResult(resultData)
		}
		if artifactErr := finishArtifact(&resultData); artifactErr != nil {
			return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, artifactErr.Error(), false), Message: artifactErr.Error()}
		}
		maybeReleaseFileTransferMemory("import-flush-error", int64(resultData.Total), filePath)
		if errors.Is(err, errImportStoppedOnError) {
			return a.stoppedImportResult(resultData, err.Error())
		}
		return connection.QueryResult{
			Success: false,
			Data:    buildImportExecutionPayload(resultData, err.Error(), false),
			Message: err.Error(),
		}
	}

	resultData := batchConsumer.Result()
	if artifactErr := finishArtifact(&resultData); artifactErr != nil {
		return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, artifactErr.Error(), false), Message: artifactErr.Error()}
	}
	if resultData.Total == 0 {
		maybeReleaseFileTransferMemory("import-empty", 0, filePath)
		return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.import_no_data", nil)}
	}

	summary := a.appText("file.backend.message.import_summary", map[string]any{
		"imported": resultData.Success,
		"skipped":  resultData.Skipped,
		"failed":   resultData.Failed,
	})
	resultPayload := buildImportExecutionPayload(resultData, summary, false)

	maybeReleaseFileTransferMemory("import-finished", int64(resultData.Total), filePath)
	return connection.QueryResult{Success: true, Data: resultPayload, Message: summary}
}

func (a *App) importTargetColumnsContext(
	ctx context.Context,
	dbInst db.Database,
	config connection.ConnectionConfig,
	dbName, tableName string,
) ([]connection.ColumnDefinition, error) {
	// A second connection to :memory: is a different SQLite or DuckDB database.
	// Prefer a same-instance Context API for file-local engines so cancellation
	// does not regress their in-memory import path. Other databases retain the
	// isolated metadata session, which avoids binding request Context to a shared
	// cached driver instance.
	dbType := resolveDDLDBType(config)
	if dbType == "sqlite" || dbType == "duckdb" {
		if getter, ok := dbInst.(db.ColumnDefinitionContexter); ok {
			schemaName, pureTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
			return getter.GetColumnsContext(ctx, schemaName, pureTableName)
		}
	}
	metadataResult := a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
		return session.DBGetColumns(config, dbName, tableName)
	})
	if !metadataResult.Success {
		return nil, errors.New(metadataResult.Message)
	}
	targetColumns, _ := metadataResult.Data.([]connection.ColumnDefinition)
	return targetColumns, nil
}
