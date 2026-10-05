package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/uievents"

	"github.com/google/uuid"
)

// ImportDatabaseSQL restores a database from a SQL file while honoring the
// connection protections that apply to destructive import workflows.
func (a *App) ImportDatabaseSQL(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool) connection.QueryResult {
	return a.importDatabaseSQLWithGTIDMode(config, dbName, filePath, jobID, continueOnError, mysqlGTIDImportModeReject)
}

func (a *App) ImportDatabaseSQLWithOptions(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, mysqlGTIDMode string) connection.QueryResult {
	mode, err := normalizeMySQLGTIDImportMode(mysqlGTIDMode)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_mode_invalid", nil)}
	}
	return a.importDatabaseSQLWithGTIDMode(config, dbName, filePath, jobID, continueOnError, mode)
}

func (a *App) importDatabaseSQLWithGTIDMode(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, mode mysqlGTIDImportMode) (result connection.QueryResult) {
	return a.importDatabaseSQLWithGTIDModeContext(context.Background(), config, dbName, filePath, jobID, continueOnError, mode)
}

func (a *App) importDatabaseSQLContext(ctx context.Context, config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, mysqlGTIDMode string) connection.QueryResult {
	mode := mysqlGTIDImportModeReject
	if strings.TrimSpace(mysqlGTIDMode) != "" {
		var err error
		mode, err = normalizeMySQLGTIDImportMode(mysqlGTIDMode)
		if err != nil {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_mode_invalid", nil)}
		}
	}
	return a.importDatabaseSQLWithGTIDModeContext(ctx, config, dbName, filePath, jobID, continueOnError, mode)
}

func (a *App) importDatabaseSQLWithGTIDModeContext(ctx context.Context, config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, mode mysqlGTIDImportMode) (result connection.QueryResult) {
	if err := a.validateDatabaseSQLImportAccess(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	resolvedPath, err := a.resolveWebUploadReference(filePath, webUploadPurposeSQLExecution)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	filePath = resolvedPath
	if a.webRuntime {
		defer func() { result = sanitizeWebManagedResult(result, filePath) }()
	}
	if !isMySQLGTIDImportConfig(config) {
		mode = ""
	}
	return a.executeSQLFileWithStatementLimitPolicyContextWithPolicy(
		ctx,
		config,
		dbName,
		filePath,
		jobID,
		continueOnError,
		DefaultSQLImportMaxStatementBytes,
		true,
		"sql_file",
		sqlFileExecutionPolicy{
			TransactionMode: sqlFileTransactionModeOff,
			MySQLGTIDMode:   mode,
		},
	)
}

func (a *App) ExecuteSQLFile(config connection.ConnectionConfig, dbName string, filePath string, jobID string) connection.QueryResult {
	return a.executeSQLFileContext(context.Background(), config, dbName, filePath, jobID)
}

func (a *App) executeSQLFileContext(ctx context.Context, config connection.ConnectionConfig, dbName string, filePath string, jobID string) connection.QueryResult {
	// The generic SQL-file runner retains its established compatibility
	// behavior. Database restore calls ImportDatabaseSQL and chooses the policy
	// explicitly, defaulting to fail-fast in the UI.
	if err := ensureConnectionAllowsActionWithText(
		config,
		connectionProtectionScriptExecution,
		"connection.backend.action.import_data",
		a.appText,
	); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return a.executeSQLFileWithStatementLimitPolicyContext(ctx, config, dbName, filePath, jobID, true, DefaultSQLImportMaxStatementBytes, false, "sql_file")
}

func (a *App) executeSQLFile(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool) (result connection.QueryResult) {
	return a.executeSQLFileWithStatementLimit(config, dbName, filePath, jobID, continueOnError, DefaultSQLImportMaxStatementBytes)
}

func (a *App) executeSQLFileWithStatementLimit(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, maxStatementBytes int64) (result connection.QueryResult) {
	return a.executeSQLFileWithStatementLimitPolicy(config, dbName, filePath, jobID, continueOnError, maxStatementBytes, false)
}

func (a *App) executeSQLFileWithStatementLimitPolicy(config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, maxStatementBytes int64, requirePinnedSession bool) (result connection.QueryResult) {
	return a.executeSQLFileWithStatementLimitPolicyContext(
		context.Background(),
		config,
		dbName,
		filePath,
		jobID,
		continueOnError,
		maxStatementBytes,
		requirePinnedSession,
		"sql_file",
	)
}

// executeSQLFileWithStatementLimitPolicyContext is the shared streaming
// runner used by desktop and headless callers. The audit source stays an
// internal argument so an external caller cannot forge a provenance value.
func (a *App) executeSQLFileWithStatementLimitPolicyContext(parent context.Context, config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, maxStatementBytes int64, requirePinnedSession bool, auditSource string) (result connection.QueryResult) {
	return a.executeSQLFileWithStatementLimitPolicyContextWithPolicy(
		parent,
		config,
		dbName,
		filePath,
		jobID,
		continueOnError,
		maxStatementBytes,
		requirePinnedSession,
		auditSource,
		sqlFileExecutionPolicy{TransactionMode: sqlFileTransactionModeOff},
	)
}

func (a *App) executeSQLFileWithStatementLimitPolicyContextWithPolicy(parent context.Context, config connection.ConnectionConfig, dbName string, filePath string, jobID string, continueOnError bool, maxStatementBytes int64, requirePinnedSession bool, auditSource string, policy sqlFileExecutionPolicy) (result connection.QueryResult) {
	if parent == nil {
		parent = context.Background()
	}
	if policy.TransactionMode != sqlFileTransactionModeSingle {
		policy.TransactionMode = sqlFileTransactionModeOff
	}
	if policy.TransactionMode == sqlFileTransactionModeSingle {
		policy.ForceFullPreflight = true
		if continueOnError {
			return connection.QueryResult{Success: false, Message: "single-transaction SQL-file execution does not support continue-on-error"}
		}
		if !isSQLFileSingleTransactionDialectSupported(resolveDDLDBType(config)) {
			return connection.QueryResult{Success: false, Message: "single-transaction SQL-file execution cannot prove atomicity for this database type"}
		}
	}
	containsMySQLGTIDPurged := false
	if policy.MySQLGTIDMode != "" && isMySQLGTIDImportConfig(config) {
		policy.ForceFullPreflight = true
		originalGuard := policy.StatementGuard
		policy.StatementGuard = func(index int, statement string) error {
			if isMySQLGTIDPurgedStatement(statement) {
				containsMySQLGTIDPurged = true
			}
			if originalGuard != nil {
				return originalGuard(index, statement)
			}
			return nil
		}
		if policy.MySQLGTIDMode == mysqlGTIDImportModeSkip {
			policy.SkipStatement = func(_ int, statement string) bool {
				return isMySQLGTIDPurgedStatement(statement)
			}
		}
	}
	if maxStatementBytes <= 0 {
		maxStatementBytes = DefaultSQLImportMaxStatementBytes
	}
	if strings.ToLower(strings.TrimSpace(auditSource)) != "cli" {
		auditSource = "sql_file"
	}
	auditSQL := "EXECUTE SQL FILE"
	auditStatementCount := 0
	auditSafeError := "SQL file task failed before an execution summary was available"
	defer a.beginSQLAuditUserActionWithOptions(config, dbName, auditSource, &auditSQL, &result, sqlAuditUserActionOptions{
		StatementCount: &auditStatementCount,
		SafeError:      &auditSafeError,
	})()
	if strings.TrimSpace(filePath) == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.file_path_empty", nil)}
	}
	if strings.TrimSpace(jobID) == "" {
		jobID = "sqlfile-" + uuid.NewString()
	}

	sourceIdentity, err := captureImportSourceIdentity(filePath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
	}
	logger.Warnf("ExecuteSQLFile 开始：source=%s size=%d db=%s jobID=%s", sourceIdentity.Token, sourceIdentity.Size, dbName, jobID)

	ctx, cancel := context.WithCancel(parent)
	cleanupRegistration, registered := a.registerImportTask(jobID, cancel, importjob.KindSQL)
	if !registered {
		cancel()
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_job_already_running", nil)}
	}
	defer cancel()
	defer cleanupRegistration()

	managedJob, err := a.beginManagedImportJob(managedImportJobStart{
		ID:                  jobID,
		Kind:                importjob.KindSQL,
		SourcePath:          filePath,
		SourceIdentityToken: sourceIdentity.Token,
		SourceBytesTotal:    sourceIdentity.Size,
		ByteProgressKind:    "rawSource",
		TargetFingerprint:   buildImportTargetFingerprint(config, dbName, ""),
		ConnectionID:        config.ID,
		DatabaseName:        dbName,
		OptionsHash:         buildSQLImportOptionsHashWithGTIDMode(continueOnError, maxStatementBytes, policy.TransactionMode, policy.MySQLGTIDMode),
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer func() {
		if finishErr := managedJob.finish(managedImportJobFinishFromResult(result)); finishErr != nil && result.Success {
			result = connection.QueryResult{Success: false, Message: finishErr.Error(), Data: result.Data}
		}
	}()
	mayHaveDatabaseSideEffects := false
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

	var jobPersistErr error
	preflightObserver := &sqlFileRawProgressObserver{report: func(bytesRead int64) error {
		uievents.Emit(a.ctx, "sqlfile:progress", map[string]interface{}{
			"jobId":             jobID,
			"status":            "running",
			"stage":             "preflight",
			"executed":          0,
			"failed":            0,
			"total":             0,
			"percent":           resolveSQLFileExecutionProgressPercent("running", bytesRead, sourceIdentity.Size),
			"bytesRead":         bytesRead,
			"totalBytes":        sourceIdentity.Size,
			"byteProgressKind":  "rawSource",
			"decodedBytes":      nil,
			"decodedTotalBytes": nil,
			"currentSQL":        "",
			"error":             "",
		})
		if managedJob == nil || jobPersistErr != nil {
			return jobPersistErr
		}
		jobPersistErr = managedJob.update(managedImportJobProgress{
			Stage:            "preflight",
			BytesRead:        bytesRead,
			SourceBytesTotal: sourceIdentity.Size,
			ByteProgressKind: "rawSource",
			Checkpoint:       importjob.Checkpoint{Safe: false, ByteOffset: bytesRead},
		})
		if jobPersistErr != nil {
			cancel()
		}
		return jobPersistErr
	}}
	fileDigest := sha256.New()
	preparedSource, err := prepareSQLFileExecutionSourceWithPolicyContext(ctx, filePath, resolveDDLDBType(config), maxStatementBytes, fileDigest, preflightObserver, policy)
	if err != nil {
		if jobPersistErr != nil {
			return connection.QueryResult{
				Success: false,
				Data:    buildSQLFileExecutionPayload(0, 0, "failed"),
				Message: a.appText("file.backend.error.import_job_persist", map[string]any{"detail": jobPersistErr.Error()}),
			}
		}
		if errors.Is(err, context.Canceled) {
			return connection.QueryResult{
				Success: false,
				Data:    buildSQLFileExecutionPayload(0, 0, "cancelled"),
				Message: a.appText("file.backend.message.execution_cancelled", map[string]any{"executed": 0, "failed": 0, "duration": 0}),
			}
		}
		if isSQLFilePreExecutionValidationError(err) {
			var preflightErr *sqlFilePreflightRejectedError
			data := buildSQLFileExecutionPayload(0, 0, "failed")
			if errors.As(err, &preflightErr) {
				data = buildSQLFilePreflightFailurePayload(preflightErr)
			}
			var policyErr *HeadlessSQLPolicyError
			if errors.As(err, &policyErr) {
				data["errorKind"] = headlessResultErrorKindPolicy
			}
			return connection.QueryResult{
				Success: false,
				Data:    data,
				Message: a.appText("file.backend.error.sql_file_execution_failed_summary", map[string]any{"detail": err.Error(), "count": 0}),
			}
		}
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
	}
	defer preparedSource.Close()
	if err := validateImportSourceIdentity(filePath, sourceIdentity); err != nil {
		return connection.QueryResult{
			Success: false,
			Data: map[string]interface{}{
				"sourceChanged":  true,
				"outcomeUnknown": false,
			},
			Message: a.appText("file.backend.error.import_source_changed", nil),
		}
	}
	preamble := preparedSource.preamble
	backupPreamble := goNaviMySQLDatabaseBackupPreamble{}
	isGoNaviMySQLDatabaseBackup := false
	if strings.EqualFold(strings.TrimSpace(config.Type), "mysql") {
		backupPreamble, isGoNaviMySQLDatabaseBackup = parseGoNaviMySQLDatabaseBackupPreamble(preamble)
	}

	// GoNavi 的 MySQL 整库备份会在脚本中创建并 USE 源库，因此不能先连接到该库。
	runConfig := resolveSQLFileExecutionRunConfig(config, dbName, preamble)

	dbInst, err := a.getDatabaseWithContext(ctx, runConfig, false)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return connection.QueryResult{
				Success: false,
				Data:    buildSQLFileExecutionPayload(0, 0, "cancelled"),
				Message: a.appText("file.backend.message.execution_cancelled", map[string]any{"executed": 0, "failed": 0, "duration": 0}),
			}
		}
		logger.Errorf("ExecuteSQLFile 获取连接失败：%s err=%s", formatConnSummary(runConfig), sanitizeSQLFileExecutionErr(err))
		result := connection.QueryResult{Success: false, Message: sanitizeSQLFileExecutionErr(err)}
		if strings.EqualFold(strings.TrimSpace(auditSource), "cli") {
			result.Data = map[string]interface{}{"errorKind": headlessResultErrorKindConnection}
		}
		return result
	}
	if err := ctx.Err(); err != nil {
		return connection.QueryResult{
			Success: false,
			Data:    buildSQLFileExecutionPayload(0, 0, "cancelled"),
			Message: a.appText("file.backend.message.execution_cancelled", map[string]any{"executed": 0, "failed": 0, "duration": 0}),
		}
	}
	if requirePinnedSession {
		if !runtimeSupportsSessionExecer(dbInst) {
			return connection.QueryResult{
				Success: false,
				Data:    buildSQLFileExecutionPayload(0, 0, "failed"),
				Message: a.appText("data_import.capability.reason.pinned_session_unavailable", nil),
			}
		}
	}
	if containsMySQLGTIDPurged {
		switch policy.MySQLGTIDMode {
		case mysqlGTIDImportModeReject:
			state, stateErr := queryMySQLGTIDTargetState(dbInst)
			if stateErr != nil {
				return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_preflight_failed", map[string]any{"detail": sanitizeSQLFileExecutionErr(stateErr)})}
			}
			if strings.TrimSpace(state.GTIDExecuted) != "" {
				return connection.QueryResult{
					Success: false,
					Data:    buildMySQLGTIDPreflightPayload(true, state),
					Message: a.appText("file.backend.error.mysql_gtid_decision_required", nil),
				}
			}
		case mysqlGTIDImportModeReset:
			state, stateErr := queryMySQLGTIDTargetState(dbInst)
			if stateErr != nil {
				return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_preflight_failed", map[string]any{"detail": sanitizeSQLFileExecutionErr(stateErr)})}
			}
			resetStatement, resetErr := mysqlGTIDResetStatement(state.ServerVersion)
			if resetErr != nil {
				return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_preflight_failed", map[string]any{"detail": sanitizeSQLFileExecutionErr(resetErr)})}
			}
			mayHaveDatabaseSideEffects = true
			if _, resetErr = execSQLFileStatement(ctx, dbInst, resetStatement); resetErr != nil {
				return connection.QueryResult{
					Success: false,
					Data: map[string]interface{}{
						"gtidResetAttempted": true,
						"outcomeUnknown":     db.IsWriteOutcomeUnknown(resetErr) || db.IsAmbiguousWriteResponse(resetErr),
					},
					Message: a.appText("file.backend.error.mysql_gtid_reset_failed", map[string]any{"detail": sanitizeSQLFileExecutionErr(resetErr)}),
				}
			}
		}
	}

	totalSize := preparedSource.rawSize
	totalSizeKnown := true

	if bootstrapSQL := buildGoNaviMySQLDatabaseBackupBootstrapSQL(backupPreamble); isGoNaviMySQLDatabaseBackup && bootstrapSQL != "" {
		mayHaveDatabaseSideEffects = true
		if _, err := execSQLFileStatement(ctx, dbInst, bootstrapSQL); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
				return connection.QueryResult{
					Success: false,
					Data:    buildSQLFileExecutionPayload(0, 0, "cancelled"),
					Message: a.appText("file.backend.message.execution_cancelled", map[string]any{"executed": 0, "failed": 0, "duration": 0}),
				}
			}
			data := buildSQLFileExecutionPayload(0, 1, "failed")
			data["outcomeUnknown"] = true
			data["bootstrapAttempted"] = true
			return connection.QueryResult{Success: false, Data: data, Message: sanitizeSQLFileExecutionErr(err)}
		}
	}

	// 发送进度事件的辅助函数
	emitProgress := func(status string, executed, failed, total int, bytesRead int64, currentSQL string, errMsg string) {
		percent := resolveSQLFileExecutionProgressPercent(status, bytesRead, totalSize)
		uievents.Emit(a.ctx, "sqlfile:progress", map[string]interface{}{
			"jobId":             jobID,
			"status":            status,
			"stage":             "write",
			"executed":          executed,
			"failed":            failed,
			"total":             total,
			"percent":           percent,
			"bytesRead":         bytesRead,
			"totalBytes":        totalSize,
			"byteProgressKind":  "rawSource",
			"decodedBytes":      nil,
			"decodedTotalBytes": nil,
			"currentSQL":        currentSQL,
			"error":             errMsg,
		})
		if managedJob != nil && jobPersistErr == nil {
			jobPersistErr = managedJob.update(managedImportJobProgress{
				Stage:            "write",
				Current:          int64(total),
				Total:            int64(total),
				Succeeded:        int64(executed),
				Failed:           int64(failed),
				BytesRead:        bytesRead,
				SourceBytesTotal: totalSize,
				ByteProgressKind: "rawSource",
				Checkpoint: importjob.Checkpoint{
					Safe:           false,
					StatementIndex: int64(total),
					ByteOffset:     bytesRead,
				},
				ForcePersist: status != "running",
			})
			if jobPersistErr != nil {
				cancel()
			}
		}
	}

	emitProgress("running", 0, 0, 0, 0, "", "")

	startTime := time.Now()
	execResult, streamErr := executeSQLFileStream(ctx, dbInst, preparedSource.reader, sqlFileExecutionOptions{
		DBType:            resolveDDLDBType(runConfig),
		MaxStatementBytes: maxStatementBytes,
		ContinueOnError:   continueOnError,
		TransactionMode:   policy.TransactionMode,
		StatementGuard:    policy.StatementGuard,
		SkipStatement:     policy.SkipStatement,
		// Keep the callback guard even after a full small-file preflight so a
		// source replacement between the two opens cannot send client commands
		// to the database.
		PreflightEachStatement: true,
		Text:                   a.appText,
		OnProgress: func(progress sqlFileExecutionProgress) {
			emitProgress(
				progress.Status,
				progress.Executed,
				progress.Failed,
				progress.Total,
				progress.BytesRead,
				progress.CurrentSQL,
				progress.Error,
			)
		},
	}, func() int64 {
		return preparedSource.source.RawBytesRead()
	})

	duration := time.Since(startTime)
	executedCount := execResult.Executed
	failedCount := execResult.Failed
	errorLogs := execResult.Errors
	auditStatementCount = executedCount + failedCount
	auditSQL = fmt.Sprintf("EXECUTE SQL FILE EXECUTED_%d FAILED_%d", executedCount, failedCount)
	auditSafeError = fmt.Sprintf("SQL file task failed after executing %d statement(s); %d statement(s) failed", executedCount, failedCount)
	rawBytesRead := preparedSource.source.RawBytesRead()
	mayHaveDatabaseSideEffects = mayHaveDatabaseSideEffects || executedCount > 0 || failedCount > 0 || execResult.OutcomeUnknown
	contentSHA256 := ""
	if totalSizeKnown && rawBytesRead == totalSize {
		contentSHA256 = hex.EncodeToString(fileDigest.Sum(nil))
		auditSQL += " SHA256_" + contentSHA256
	}
	if managedJob != nil && jobPersistErr == nil {
		jobPersistErr = managedJob.update(managedImportJobProgress{
			Stage:               "write",
			Current:             int64(executedCount + failedCount),
			Total:               int64(executedCount + failedCount),
			Succeeded:           int64(executedCount),
			Failed:              int64(failedCount),
			BytesRead:           rawBytesRead,
			SourceBytesTotal:    totalSize,
			ByteProgressKind:    "rawSource",
			SourceContentSHA256: contentSHA256,
			Checkpoint: importjob.Checkpoint{
				Safe:           false,
				StatementIndex: int64(executedCount + failedCount),
				ByteOffset:     rawBytesRead,
			},
			OutcomeUnknown: execResult.OutcomeUnknown,
			ForcePersist:   true,
		})
	}
	if jobPersistErr != nil {
		data := buildSQLFileExecutionPayload(executedCount, failedCount, "failed")
		data["outcomeUnknown"] = mayHaveDatabaseSideEffects
		return connection.QueryResult{
			Success: false,
			Data:    data,
			Message: a.appText("file.backend.error.import_job_persist", map[string]any{"detail": jobPersistErr.Error()}),
		}
	}

	if errors.Is(streamErr, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		emitProgress("cancelled", executedCount, failedCount, executedCount+failedCount, rawBytesRead, "", a.appText("file.backend.message.user_cancelled", nil))
		logger.Warnf("ExecuteSQLFile 已取消：executed=%d failed=%d duration=%v", executedCount, failedCount, duration)
		data := buildSQLFileExecutionPayload(executedCount, failedCount, "cancelled")
		data["outcomeUnknown"] = execResult.OutcomeUnknown
		return connection.QueryResult{
			Success: false,
			Data:    data,
			Message: a.appText("file.backend.message.execution_cancelled", map[string]any{
				"executed": executedCount,
				"failed":   failedCount,
				"duration": duration.Round(time.Millisecond),
			}),
		}
	}
	safeStreamError := sanitizeSQLFileExecutionErr(streamErr)

	if errors.Is(streamErr, errSQLFileStoppedOnError) {
		emitProgress("error", executedCount, failedCount, executedCount+failedCount, rawBytesRead, "", safeStreamError)
		data := buildSQLFileExecutionPayload(executedCount, failedCount, "stopped")
		if execResult.OutcomeUnknown {
			data["outcomeUnknown"] = true
		}
		return connection.QueryResult{
			Success: false,
			Data:    data,
			Message: a.appText("file.backend.error.sql_file_stopped_on_error_summary", map[string]any{
				"detail":  safeStreamError,
				"success": executedCount,
				"failed":  failedCount,
			}),
		}
	}

	if streamErr != nil {
		emitProgress("error", executedCount, failedCount, executedCount+failedCount, rawBytesRead, "", safeStreamError)
		data := buildSQLFileExecutionPayload(executedCount, failedCount, "failed")
		var preflightErr *sqlFilePreflightRejectedError
		if errors.As(streamErr, &preflightErr) {
			preflightErr.possibleSideEffects = preflightErr.possibleSideEffects || mayHaveDatabaseSideEffects
			preflightErr.outcomeUnknown = preflightErr.outcomeUnknown || failedCount > 0
			data = buildSQLFilePreflightFailurePayload(preflightErr)
		} else if execResult.OutcomeUnknown || failedCount > 0 {
			data["outcomeUnknown"] = true
		}
		var policyErr *HeadlessSQLPolicyError
		if errors.As(streamErr, &policyErr) {
			data["errorKind"] = headlessResultErrorKindPolicy
		}
		return connection.QueryResult{
			Success: false,
			Data:    data,
			Message: a.appText("file.backend.error.sql_file_execution_failed_summary", map[string]any{
				"detail": safeStreamError,
				"count":  executedCount,
			}),
		}
	}

	emitProgress("done", executedCount, failedCount, executedCount+failedCount, totalSize, "", "")

	summary := a.appText("file.backend.message.execution_completed", map[string]any{
		"success":  executedCount,
		"failed":   failedCount,
		"duration": duration.Round(time.Millisecond),
	})
	if len(errorLogs) > 0 {
		maxShow := len(errorLogs)
		summary += "\n\n" + a.appText("file.backend.message.execution_error_detail_header", map[string]any{"count": maxShow}) + "\n" + strings.Join(errorLogs[:maxShow], "\n")
		if omitted := failedCount - maxShow; omitted > 0 {
			summary += "\n" + a.appText("file.backend.message.execution_more_errors", map[string]any{"count": omitted})
		}
	}

	logger.Warnf("ExecuteSQLFile 完成：executed=%d failed=%d duration=%v", executedCount, failedCount, duration)
	data := buildSQLFileExecutionPayload(executedCount, failedCount, func() string {
		if failedCount > 0 {
			return "partial"
		}
		return "completed"
	}())
	if execResult.OutcomeUnknown {
		data["outcomeUnknown"] = true
	}
	return connection.QueryResult{
		Success: failedCount == 0,
		Data:    data,
		Message: summary,
	}
}

// CancelSQLFileExecution 取消正在执行的 SQL 文件任务。
func (a *App) CancelSQLFileExecution(jobID string) connection.QueryResult {
	return a.cancelImportTaskByKind(jobID, importjob.KindSQL)
}
