package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/uievents"

	"github.com/google/uuid"
)

const importJobRecoveryActionRetryFailedRows = "retry_failed_rows"

var (
	errImportJobRecoveryUnavailable    = errors.New("import job recovery is unavailable")
	errImportJobRecoverySourceChanged  = errors.New("import job recovery source changed")
	errImportJobRecoveryTargetChanged  = errors.New("import job recovery target changed")
	errImportJobRecoveryOptionsChanged = errors.New("import job recovery options changed")
	errImportJobRetryUnavailable       = errors.New("import job failed-row retry is unavailable")
)

type tableImportRecoveryPlan struct {
	ParentJob importjob.Job
	claimed   bool
}

// ResumeImportJob starts a replacement table-import task from an interrupted
// task's latest safe source-row checkpoint. The effective connection is loaded
// server-side by saved ID so task metadata never needs to persist credentials.
func (a *App) ResumeImportJob(jobID string) connection.QueryResult {
	store, err := a.ensureImportJobStore()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	job, err := store.Get(jobID)
	if err != nil {
		return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, err)}
	}
	if job.Kind != importjob.KindTable || job.TableImportOptions == nil {
		return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, errImportJobRecoveryUnavailable)}
	}
	config, err := a.resolveImportJobSavedConnection(job)
	if err != nil {
		return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, err)}
	}
	options := importFileOptionsFromImportJobTableOptions(job.TableImportOptions)
	options.JobID = newImportJobRecoveryID("resume")
	options.ResumeJobID = job.ID
	options.SourceIdentityToken = job.SourceIdentityToken
	return a.importDataWithProgressOptions(
		config,
		job.DatabaseName,
		job.TableName,
		job.SourcePath,
		options,
		&tableImportRecoveryPlan{ParentJob: job},
	)
}

func (a *App) validateTableImportRecovery(
	recovery *tableImportRecoveryPlan,
	config connection.ConnectionConfig,
	dbName, tableName string,
	options ImportFileOptions,
	sourceIdentity ImportSourceIdentity,
) error {
	if recovery == nil {
		return nil
	}
	job := recovery.ParentJob
	if job.Kind != importjob.KindTable || job.TableImportOptions == nil {
		return errImportJobRecoveryUnavailable
	}
	if strings.TrimSpace(sourceIdentity.Token) == "" || sourceIdentity.Token != job.SourceIdentityToken {
		return errImportJobRecoverySourceChanged
	}
	targetFingerprint := buildImportTargetFingerprint(config, dbName, tableName)
	if strings.TrimSpace(targetFingerprint) == "" || targetFingerprint != job.TargetFingerprint {
		return errImportJobRecoveryTargetChanged
	}
	optionsHash := buildImportFileOptionsHash(options)
	if strings.TrimSpace(optionsHash) == "" || optionsHash != job.OptionsHash {
		return errImportJobRecoveryOptionsChanged
	}
	if importjob.ValidateResume(job, sourceIdentity.Token, targetFingerprint, optionsHash) != nil {
		return errImportJobRecoveryUnavailable
	}
	return nil
}

func (a *App) claimTableImportRecovery(
	recovery *tableImportRecoveryPlan,
	sourceIdentityToken, targetFingerprint, optionsHash string,
) error {
	if recovery == nil {
		return nil
	}
	store, err := a.ensureImportJobStore()
	if err != nil {
		return err
	}
	claimed, err := store.ClaimResume(recovery.ParentJob.ID, sourceIdentityToken, targetFingerprint, optionsHash)
	if err != nil {
		if errors.Is(err, importjob.ErrRecoveryUnavailable) {
			return errImportJobRecoveryUnavailable
		}
		return err
	}
	recovery.ParentJob = claimed
	recovery.claimed = true
	return nil
}

func (a *App) releaseTableImportRecovery(recovery *tableImportRecoveryPlan) error {
	if recovery == nil || !recovery.claimed {
		return nil
	}
	store, err := a.ensureImportJobStore()
	if err != nil {
		return err
	}
	recovery.claimed = false
	return store.ReleaseResumeClaim(recovery.ParentJob.ID)
}

func (a *App) resolveImportJobSavedConnection(job importjob.Job) (connection.ConnectionConfig, error) {
	connectionID := strings.TrimSpace(job.ConnectionID)
	if connectionID == "" {
		return connection.ConnectionConfig{}, errImportJobRecoveryUnavailable
	}
	config, err := a.resolveConnectionSecrets(connection.ConnectionConfig{ID: connectionID})
	if err != nil {
		return connection.ConnectionConfig{}, err
	}
	config.ID = connectionID
	return config, nil
}

func newImportJobRecoveryID(action string) string {
	action = strings.ToLower(strings.TrimSpace(action))
	if action != "resume" && action != "retry" {
		action = "recovery"
	}
	return "import-" + action + "-" + uuid.NewString()
}

func cloneImportJobTableOptions(options *importjob.TableImportOptions) *importjob.TableImportOptions {
	if options == nil {
		return nil
	}
	cloned := *options
	if options.ColumnMappings != nil {
		cloned.ColumnMappings = make(map[string]string, len(options.ColumnMappings))
		for source, target := range options.ColumnMappings {
			cloned.ColumnMappings[source] = target
		}
	}
	cloned.ConflictKeyColumns = append([]string(nil), options.ConflictKeyColumns...)
	if options.ContinueOnError != nil {
		value := *options.ContinueOnError
		cloned.ContinueOnError = &value
	}
	if options.NullToken != nil {
		value := *options.NullToken
		cloned.NullToken = &value
	}
	return &cloned
}

func importJobTableOptionsFromImportFileOptions(options ImportFileOptions) *importjob.TableImportOptions {
	return cloneImportJobTableOptions(&importjob.TableImportOptions{
		ColumnMappings:     options.ColumnMappings,
		ContinueOnError:    options.ContinueOnError,
		Encoding:           options.Encoding,
		Delimiter:          options.Delimiter,
		HeaderRow:          options.HeaderRow,
		NullToken:          options.NullToken,
		EmptyStringAsNull:  options.EmptyStringAsNull,
		SheetName:          options.SheetName,
		ConflictPolicy:     options.ConflictPolicy,
		ConflictKeyColumns: options.ConflictKeyColumns,
	})
}

func importFileOptionsFromImportJobTableOptions(options *importjob.TableImportOptions) ImportFileOptions {
	cloned := cloneImportJobTableOptions(options)
	if cloned == nil {
		return ImportFileOptions{}
	}
	return ImportFileOptions{
		ColumnMappings:     cloned.ColumnMappings,
		ContinueOnError:    cloned.ContinueOnError,
		Encoding:           cloned.Encoding,
		Delimiter:          cloned.Delimiter,
		HeaderRow:          cloned.HeaderRow,
		NullToken:          cloned.NullToken,
		EmptyStringAsNull:  cloned.EmptyStringAsNull,
		SheetName:          cloned.SheetName,
		ConflictPolicy:     cloned.ConflictPolicy,
		ConflictKeyColumns: cloned.ConflictKeyColumns,
	}
}

func importJobRecoveryErrorMessage(a *App, err error) string {
	switch {
	case errors.Is(err, errImportJobRecoverySourceChanged):
		return a.appText("file.backend.error.import_source_changed", nil)
	case errors.Is(err, errImportJobRecoveryTargetChanged):
		return a.appText("file.backend.error.import_recovery_target_changed", nil)
	case errors.Is(err, errImportJobRecoveryOptionsChanged):
		return a.appText("file.backend.error.import_recovery_options_changed", nil)
	case errors.Is(err, errImportJobRetryUnavailable):
		return a.appText("file.backend.error.import_retry_unavailable", nil)
	case errors.Is(err, errImportJobRecoveryUnavailable), errors.Is(err, importjob.ErrRecoveryUnavailable), errors.Is(err, importjob.ErrNotFound):
		return a.appText("file.backend.error.import_resume_unavailable", nil)
	default:
		return err.Error()
	}
}

// importResumeSkippingConsumer preserves parser validation for the already
// committed prefix but never forwards it to the database writer.
type importResumeSkippingConsumer struct {
	downstream importFileConsumer
	skipRows   int64
	seenRows   int64
}

func newImportResumeSkippingConsumer(downstream importFileConsumer, skipRows int64) *importResumeSkippingConsumer {
	return &importResumeSkippingConsumer{downstream: downstream, skipRows: max(0, skipRows)}
}

func (c *importResumeSkippingConsumer) SetColumns(columns []string) error {
	if c == nil || c.downstream == nil {
		return errors.New("import resume consumer is unavailable")
	}
	return c.downstream.SetColumns(columns)
}

func (c *importResumeSkippingConsumer) ConsumeRow(row map[string]interface{}) error {
	if c == nil || c.downstream == nil {
		return errors.New("import resume consumer is unavailable")
	}
	c.seenRows++
	if c.seenRows <= c.skipRows {
		return nil
	}
	return c.downstream.ConsumeRow(row)
}

func (c *importResumeSkippingConsumer) SetImportSourceProgress(bytesRead int64, totalBytes int64, stage string) {
	if progressConsumer, ok := c.downstream.(importSourceProgressConsumer); ok {
		progressConsumer.SetImportSourceProgress(bytesRead, totalBytes, stage)
	}
}

// RetryImportJobFailedRows replays only persisted database-row failures. It
// never reparses the original source and therefore cannot resubmit a row that
// was already successful in the parent task.
func (a *App) RetryImportJobFailedRows(jobID string) (result connection.QueryResult) {
	store, err := a.ensureImportJobStore()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	job, err := store.Get(jobID)
	if err != nil {
		return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, err)}
	}
	if job.Kind != importjob.KindTable ||
		(job.Status != importjob.StatusPartial && job.Status != importjob.StatusFailed) ||
		job.OutcomeUnknown || strings.TrimSpace(job.ErrorArtifactID) == "" || job.TableImportOptions == nil {
		return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, errImportJobRetryUnavailable)}
	}
	config, err := a.resolveImportJobSavedConnection(job)
	if err != nil {
		return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, err)}
	}
	options := importFileOptionsFromImportJobTableOptions(job.TableImportOptions)
	if targetFingerprint := buildImportTargetFingerprint(config, job.DatabaseName, job.TableName); targetFingerprint != job.TargetFingerprint {
		return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, errImportJobRecoveryTargetChanged)}
	}
	if optionsHash := buildImportFileOptionsHash(options); optionsHash != job.OptionsHash {
		return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, errImportJobRecoveryOptionsChanged)}
	}
	rows, err := a.loadRetryableImportErrorRows(job.ErrorArtifactID)
	if err != nil {
		return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, err)}
	}
	if len(rows) == 0 {
		return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, errImportJobRetryUnavailable)}
	}
	return a.retryImportJobFailedRows(job, config, options, rows)
}

func (a *App) loadRetryableImportErrorRows(artifactID string) ([]ImportRowError, error) {
	store, err := a.ensureImportErrorArtifactStore()
	if err != nil {
		return nil, err
	}
	file, err := store.Open(artifactID)
	if err != nil {
		return nil, errImportJobRetryUnavailable
	}
	defer file.Close()

	decoder := json.NewDecoder(file)
	rows := make([]ImportRowError, 0)
	for {
		var row ImportRowError
		if err := decoder.Decode(&row); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, errImportJobRetryUnavailable
		}
		if !strings.EqualFold(strings.TrimSpace(row.Category), "database") || len(row.Values) == 0 {
			continue
		}
		rows = append(rows, ImportRowError{
			SourceRow: row.SourceRow,
			Values:    cloneImportRow(row.Values),
		})
	}
	return rows, nil
}

func retryImportColumns(rows []ImportRowError) []string {
	columns := make(map[string]struct{})
	for _, row := range rows {
		for column := range row.Values {
			trimmed := strings.TrimSpace(column)
			if trimmed != "" {
				columns[trimmed] = struct{}{}
			}
		}
	}
	result := make([]string, 0, len(columns))
	for column := range columns {
		result = append(result, column)
	}
	sort.Strings(result)
	return result
}

func (a *App) retryImportJobFailedRows(
	parent importjob.Job,
	config connection.ConnectionConfig,
	options ImportFileOptions,
	rows []ImportRowError,
) (result connection.QueryResult) {
	dbType := resolveDDLDBType(config)
	if err := ensureConnectionAllowsDataImport(config, "connection.backend.action.import_data"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := validateImportFileOptions(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := validateImportConflictPolicyForDB(dbType, options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	columns := retryImportColumns(rows)
	if len(columns) == 0 {
		return connection.QueryResult{Success: false, Message: importJobRecoveryErrorMessage(a, errImportJobRetryUnavailable)}
	}

	auditSQL := "RETRY IMPORT FAILED ROWS INTO " + quoteTableIdentByType(dbType, parent.DatabaseName, parent.TableName)
	auditSafeError := "failed-row import retry failed"
	defer a.beginSQLAuditUserActionWithOptions(config, parent.DatabaseName, "data_import", &auditSQL, &result, sqlAuditUserActionOptions{
		SafeError: &auditSafeError,
	})()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	jobID := newImportJobRecoveryID("retry")
	cleanupRegistration, registered := a.registerImportTask(jobID, cancel, importjob.KindTable)
	if !registered {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_job_already_running", nil)}
	}
	defer cleanupRegistration()

	managedJob, err := a.beginManagedImportJob(managedImportJobStart{
		ID:                  jobID,
		Kind:                importjob.KindTable,
		Stage:               "retry_failed_rows",
		SourcePath:          parent.SourcePath,
		SourceIdentityToken: parent.SourceIdentityToken,
		SourceBytesTotal:    parent.SourceBytesTotal,
		ByteProgressKind:    "failedRows",
		TargetFingerprint:   parent.TargetFingerprint,
		ConnectionID:        parent.ConnectionID,
		DatabaseName:        parent.DatabaseName,
		TableName:           parent.TableName,
		OptionsHash:         parent.OptionsHash,
		TableImportOptions:  importJobTableOptionsFromImportFileOptions(options),
		ParentJobID:         parent.ID,
		RecoveryAction:      importJobRecoveryActionRetryFailedRows,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer func() {
		if finishErr := managedJob.finish(managedImportJobFinishFromResult(result)); finishErr != nil && result.Success {
			result = connection.QueryResult{Success: false, Message: finishErr.Error(), Data: result.Data}
		}
	}()

	managedArtifact, err := a.beginManagedImportErrorArtifact(jobID)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer managedArtifact.abort()

	runConfig := normalizeRunConfig(config, parent.DatabaseName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return a.cancelledImportResult(importExecutionResult{})
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := ctx.Err(); err != nil {
		return a.cancelledImportResult(importExecutionResult{})
	}
	tableCapability := ResolveDataImportCapability(runConfig, dbInst).TableImport
	if !tableCapability.Supported {
		reason := strings.TrimSpace(tableCapability.Reason)
		if reason == "" {
			reason = DataImportReasonTableRuntimeUnavailable
		}
		return connection.QueryResult{Success: false, Message: a.appText("data_import.capability.reason."+reason, nil)}
	}

	metadataSchemaName, metadataTableName := normalizeMetadataSchemaAndTable(config, parent.DatabaseName, parent.TableName)
	targetColumns, colErr := getColumnsWithMetadataFallback(dbInst, config, metadataSchemaName, metadataTableName, a.appText)
	if colErr != nil && options.ColumnMappings != nil {
		return connection.QueryResult{Success: false, Message: colErr.Error()}
	}
	writer := newImportDatabaseRowWriterWithOptions(dbInst, dbType, parent.TableName, newImportColumnTypeLookup(targetColumns), options)
	var jobPersistErr error
	batchConsumer := newImportBatchConsumer(writer, defaultImportApplyBatchSize, len(rows), true, true, func(state importProgressState) {
		uievents.Emit(a.ctx, "import:progress", state)
		if jobPersistErr != nil {
			return
		}
		jobPersistErr = managedJob.update(managedImportJobProgress{
			Stage:            importJobRecoveryActionRetryFailedRows,
			Current:          int64(state.Current),
			Total:            int64(state.Total),
			Succeeded:        int64(state.Success),
			Skipped:          int64(state.Skipped),
			Failed:           int64(state.Errors),
			ByteProgressKind: "failedRows",
			Checkpoint:       importjob.Checkpoint{Safe: false, SourceRow: int64(state.Current)},
			ForcePersist:     state.CheckpointSafe,
		})
		if jobPersistErr != nil {
			cancel()
		}
	})
	batchConsumer.SetContext(ctx)
	batchConsumer.jobID = jobID
	batchConsumer.SetRowErrorHandler(managedArtifact.append)
	if err := batchConsumer.SetColumns(columns); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	finishArtifact := func(resultData *importExecutionResult) error {
		return managedArtifact.finish(resultData)
	}
	for _, row := range rows {
		if err := batchConsumer.ConsumeRow(row.Values); err != nil {
			return a.finishImportErrorArtifactRecovery(resultDataFromConsumer(batchConsumer), err, jobPersistErr, finishArtifact)
		}
	}
	if err := batchConsumer.Flush(); err != nil {
		return a.finishImportErrorArtifactRecovery(resultDataFromConsumer(batchConsumer), err, jobPersistErr, finishArtifact)
	}
	resultData := batchConsumer.Result()
	if jobPersistErr != nil {
		if artifactErr := finishArtifact(&resultData); artifactErr != nil {
			jobPersistErr = errors.Join(jobPersistErr, artifactErr)
		}
		message := a.appText("file.backend.error.import_job_persist", map[string]any{"detail": jobPersistErr.Error()})
		return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, message, false), Message: message}
	}
	if err := finishArtifact(&resultData); err != nil {
		return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(resultData, err.Error(), false), Message: err.Error()}
	}
	summary := a.appText("file.backend.message.import_summary", map[string]any{
		"imported": resultData.Success,
		"skipped":  resultData.Skipped,
		"failed":   resultData.Failed,
	})
	return connection.QueryResult{Success: resultData.Failed == 0, Data: buildImportExecutionPayload(resultData, summary, false), Message: summary}
}

func resultDataFromConsumer(consumer *importBatchConsumer) *importExecutionResult {
	result := importExecutionResult{}
	if consumer != nil {
		result = consumer.Result()
	}
	return &result
}

func (a *App) finishImportErrorArtifactRecovery(
	resultData *importExecutionResult,
	runErr, persistErr error,
	finishArtifact func(*importExecutionResult) error,
) connection.QueryResult {
	if resultData == nil {
		resultData = &importExecutionResult{}
	}
	if persistErr != nil {
		if artifactErr := finishArtifact(resultData); artifactErr != nil {
			persistErr = errors.Join(persistErr, artifactErr)
		}
		message := a.appText("file.backend.error.import_job_persist", map[string]any{"detail": persistErr.Error()})
		return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(*resultData, message, false), Message: message}
	}
	if artifactErr := finishArtifact(resultData); artifactErr != nil {
		return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(*resultData, artifactErr.Error(), false), Message: artifactErr.Error()}
	}
	if errors.Is(runErr, context.Canceled) {
		return a.cancelledImportResult(*resultData)
	}
	if errors.Is(runErr, errImportStoppedOnError) {
		return a.stoppedImportResult(*resultData, runErr.Error())
	}
	return connection.QueryResult{Success: false, Data: buildImportExecutionPayload(*resultData, runErr.Error(), false), Message: runErr.Error()}
}
