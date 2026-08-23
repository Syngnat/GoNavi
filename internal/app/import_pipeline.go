package app

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/sqlaudit"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

const (
	defaultImportPreviewLimit   = 5
	defaultImportApplyBatchSize = 1000
	maxImportErrorDetails       = 20
	maxImportCellBytes          = 16 * 1024 * 1024
	maxImportRowBytes           = 64 * 1024 * 1024
	maxImportBatchBytes         = 64 * 1024 * 1024
	importProgressRowInterval   = 100
	importProgressTimeInterval  = 250 * time.Millisecond
)

var errImportStoppedOnError = errors.New("import stopped on error")
var errImportPreviewLimitReached = errors.New("import preview limit reached")

type importStoppedOnError struct {
	detail string
	cause  error
}

func (e *importStoppedOnError) Error() string {
	if e == nil {
		return errImportStoppedOnError.Error()
	}
	return e.detail
}

func (e *importStoppedOnError) Unwrap() error {
	if e != nil && e.cause != nil {
		return errors.Join(errImportStoppedOnError, e.cause)
	}
	return errImportStoppedOnError
}

type importFileConsumer interface {
	SetColumns(columns []string) error
	ConsumeRow(row map[string]interface{}) error
}

type importSourceProgressConsumer interface {
	SetImportSourceProgress(bytesRead int64, totalBytes int64, stage string)
}

type importByteCountingReader struct {
	reader    io.Reader
	bytesRead int64
}

func (r *importByteCountingReader) Read(buffer []byte) (int, error) {
	read, err := r.reader.Read(buffer)
	r.bytesRead += int64(read)
	return read, err
}

func reportImportSourceProgress(consumer importFileConsumer, bytesRead int64, totalBytes int64) {
	if progressConsumer, ok := consumer.(importSourceProgressConsumer); ok {
		progressConsumer.SetImportSourceProgress(bytesRead, totalBytes, "parse")
	}
}

type importPreviewData struct {
	Columns        []string
	TotalRows      int
	TotalRowsKnown bool
	PreviewRows    []map[string]interface{}
}

// ImportFileOptions controls how a selected import file is applied to the target table.
// A nil ColumnMappings value preserves the legacy behavior where file headers are used
// directly as database column names. A non-nil map enables explicit source-to-target
// mapping; entries with an empty target are skipped.
type ImportFileOptions struct {
	ColumnMappings      map[string]string `json:"columnMappings,omitempty"`
	JobID               string            `json:"jobId,omitempty"`
	ContinueOnError     *bool             `json:"continueOnError,omitempty"`
	Encoding            string            `json:"encoding,omitempty"`
	Delimiter           string            `json:"delimiter,omitempty"`
	HeaderRow           int               `json:"headerRow,omitempty"`
	NullToken           *string           `json:"nullToken,omitempty"`
	EmptyStringAsNull   bool              `json:"emptyStringAsNull,omitempty"`
	SheetName           string            `json:"sheetName,omitempty"`
	SourceIdentityToken string            `json:"sourceIdentityToken,omitempty"`
	ConflictPolicy      string            `json:"conflictPolicy,omitempty"`
	ConflictKeyColumns  []string          `json:"conflictKeyColumns,omitempty"`
	ResumeJobID         string            `json:"resumeJobId,omitempty"`
}

func resolveImportContinueOnError(options ImportFileOptions) bool {
	// Keep the public compatibility entrypoint's historical continue behavior
	// when the field is omitted. The workbench always sends an explicit value
	// and defaults to fail-fast.
	return options.ContinueOnError == nil || *options.ContinueOnError
}

type importProgressState struct {
	JobID          string `json:"jobId,omitempty"`
	Current        int    `json:"current"`
	Total          int    `json:"total,omitempty"`
	Success        int    `json:"success"`
	Skipped        int    `json:"skipped,omitempty"`
	Errors         int    `json:"errors"`
	TotalRowsKnown bool   `json:"totalRowsKnown,omitempty"`
	BytesRead      int64  `json:"bytesRead,omitempty"`
	TotalBytes     int64  `json:"totalBytes,omitempty"`
	Stage          string `json:"stage,omitempty"`
	CheckpointSafe bool   `json:"checkpointSafe,omitempty"`
}

type importExecutionResult struct {
	Success            int
	Skipped            int
	Failed             int
	Total              int
	ErrorLogs          []string
	ErrorArtifactID    string
	ErrorArtifactCount int64
	StoppedOnError     bool
	OutcomeUnknown     bool
}

type importPreviewCollector struct {
	columns      []string
	totalRows    int
	previewRows  []map[string]interface{}
	previewLimit int
}

func newImportPreviewCollector(limit int) *importPreviewCollector {
	if limit <= 0 {
		limit = defaultImportPreviewLimit
	}
	return &importPreviewCollector{previewLimit: limit}
}

func (c *importPreviewCollector) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	return nil
}

func (c *importPreviewCollector) ConsumeRow(row map[string]interface{}) error {
	c.totalRows++
	if len(c.previewRows) < c.previewLimit {
		c.previewRows = append(c.previewRows, cloneImportRow(row))
	}
	if len(c.previewRows) >= c.previewLimit {
		return errImportPreviewLimitReached
	}
	return nil
}

func (c *importPreviewCollector) Result() importPreviewData {
	return importPreviewData{
		Columns:     append([]string(nil), c.columns...),
		TotalRows:   c.totalRows,
		PreviewRows: cloneImportRows(c.previewRows),
	}
}

type importCollectConsumer struct {
	columns []string
	rows    []map[string]interface{}
}

func (c *importCollectConsumer) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	return nil
}

func (c *importCollectConsumer) ConsumeRow(row map[string]interface{}) error {
	c.rows = append(c.rows, cloneImportRow(row))
	return nil
}

type importResolvedColumnMapping struct {
	source string
	target string
}

type importColumnMappingConsumer struct {
	downstream       importFileConsumer
	targetBySource   map[string]string
	selectedSources  []string
	resolvedMappings []importResolvedColumnMapping
	requiredTargets  map[string]string
}

func newImportColumnMappingConsumer(
	downstream importFileConsumer,
	columnMappings map[string]string,
	targetColumns []connection.ColumnDefinition,
) (importFileConsumer, error) {
	if columnMappings == nil {
		return downstream, nil
	}
	if downstream == nil {
		return nil, fmt.Errorf("导入字段映射缺少下游处理器")
	}

	targetColumnsByExactName := make(map[string]string, len(targetColumns))
	targetColumnsByFoldedName := make(map[string][]string, len(targetColumns))
	for _, column := range targetColumns {
		name := column.Name
		if strings.TrimSpace(name) == "" {
			continue
		}
		targetColumnsByExactName[name] = name
		foldedName := normalizeColumnName(name)
		targetColumnsByFoldedName[foldedName] = append(targetColumnsByFoldedName[foldedName], name)
	}

	sources := make([]string, 0, len(columnMappings))
	for source := range columnMappings {
		sources = append(sources, source)
	}
	sort.Strings(sources)

	targetBySource := make(map[string]string, len(columnMappings))
	selectedSources := make([]string, 0, len(columnMappings))
	usedTargets := make(map[string]string, len(columnMappings))
	requiredTargets := make(map[string]string)
	for _, column := range targetColumns {
		if strings.EqualFold(strings.TrimSpace(column.Nullable), "NO") &&
			!column.HasDefault && column.Default == nil &&
			!strings.Contains(strings.ToLower(column.Extra), "auto_increment") &&
			!strings.Contains(strings.ToLower(column.Extra), "identity") &&
			!strings.Contains(strings.ToLower(column.Extra), "generated") {
			requiredTargets[normalizeColumnName(column.Name)] = column.Name
		}
	}
	for _, source := range sources {
		if strings.TrimSpace(source) == "" {
			return nil, fmt.Errorf("导入字段映射源字段不能为空")
		}
		requestedTarget := columnMappings[source]
		if strings.TrimSpace(requestedTarget) == "" {
			continue
		}

		actualTarget, exactMatch := targetColumnsByExactName[requestedTarget]
		if !exactMatch {
			foldedMatches := targetColumnsByFoldedName[normalizeColumnName(requestedTarget)]
			switch len(foldedMatches) {
			case 0:
				return nil, fmt.Errorf("导入字段映射目标字段 %q 不存在", requestedTarget)
			case 1:
				actualTarget = foldedMatches[0]
			default:
				return nil, fmt.Errorf("导入字段映射目标字段 %q 的大小写匹配不明确", requestedTarget)
			}
		}
		if previousSource, exists := usedTargets[actualTarget]; exists {
			return nil, fmt.Errorf("导入字段映射目标字段 %q 被源字段 %q 和 %q 重复使用", actualTarget, previousSource, source)
		}
		usedTargets[actualTarget] = source
		targetBySource[source] = actualTarget
		selectedSources = append(selectedSources, source)
	}
	if len(selectedSources) == 0 {
		return nil, fmt.Errorf("导入字段映射至少需要选择一个目标字段")
	}

	return &importColumnMappingConsumer{
		downstream:      downstream,
		targetBySource:  targetBySource,
		selectedSources: selectedSources,
		requiredTargets: requiredTargets,
	}, nil
}

func (c *importColumnMappingConsumer) SetColumns(columns []string) error {
	if c == nil || c.downstream == nil {
		return fmt.Errorf("导入字段映射缺少下游处理器")
	}

	foundSources := make(map[string]struct{}, len(c.selectedSources))
	resolved := make([]importResolvedColumnMapping, 0, len(c.selectedSources))
	targets := make([]string, 0, len(c.selectedSources))
	for _, source := range columns {
		target, selected := c.targetBySource[source]
		if !selected {
			continue
		}
		if _, duplicate := foundSources[source]; duplicate {
			return fmt.Errorf("导入字段映射源字段 %q 在文件表头中重复", source)
		}
		foundSources[source] = struct{}{}
		resolved = append(resolved, importResolvedColumnMapping{source: source, target: target})
		targets = append(targets, target)
	}
	for _, source := range c.selectedSources {
		if _, ok := foundSources[source]; !ok {
			return fmt.Errorf("导入字段映射源字段 %q 不存在", source)
		}
	}
	selectedTargets := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		selectedTargets[normalizeColumnName(target)] = struct{}{}
	}
	missingRequired := make([]string, 0)
	for normalized, target := range c.requiredTargets {
		if _, ok := selectedTargets[normalized]; !ok {
			missingRequired = append(missingRequired, target)
		}
	}
	if len(missingRequired) > 0 {
		sort.Strings(missingRequired)
		return fmt.Errorf("导入字段映射缺少非空字段: %s", strings.Join(missingRequired, ", "))
	}

	c.resolvedMappings = resolved
	return c.downstream.SetColumns(targets)
}

func (c *importColumnMappingConsumer) ConsumeRow(row map[string]interface{}) error {
	if c == nil || c.downstream == nil {
		return fmt.Errorf("导入字段映射缺少下游处理器")
	}
	if len(c.resolvedMappings) == 0 {
		return fmt.Errorf("导入字段映射尚未解析文件表头")
	}

	mappedRow := make(map[string]interface{}, len(c.resolvedMappings))
	for _, mapping := range c.resolvedMappings {
		mappedRow[mapping.target] = row[mapping.source]
	}
	return c.downstream.ConsumeRow(mappedRow)
}

func (c *importColumnMappingConsumer) SetImportSourceProgress(bytesRead int64, totalBytes int64, stage string) {
	if c == nil {
		return
	}
	if progressConsumer, ok := c.downstream.(importSourceProgressConsumer); ok {
		progressConsumer.SetImportSourceProgress(bytesRead, totalBytes, stage)
	}
}

type importRowWriter interface {
	SetColumns(columns []string)
	ApplyBatch(rows []map[string]interface{}) error
	ApplyOne(row map[string]interface{}) error
	BatchEnabled() bool
}

// importBatchContextWriter is the optional cancellation-aware batch extension.
// Keep it separate from the single-row extension so a writer can support one
// operation safely without having to implement an unrelated method.
type importBatchContextWriter interface {
	ApplyBatchContext(ctx context.Context, rows []map[string]interface{}) error
}

type importRowContextWriter interface {
	ApplyOneContext(ctx context.Context, row map[string]interface{}) error
}

type importRowApplyOutcome string

const (
	importRowApplySucceeded importRowApplyOutcome = "succeeded"
	importRowApplySkipped   importRowApplyOutcome = "skipped"
)

type importRowOutcomeWriter interface {
	ApplyOneWithOutcome(row map[string]interface{}) (importRowApplyOutcome, error)
}

type importRowContextOutcomeWriter interface {
	ApplyOneWithOutcomeContext(ctx context.Context, row map[string]interface{}) (importRowApplyOutcome, error)
}

type importRowColumnValidator interface {
	ValidateColumns(columns []string) error
}

type importColumnTypeLookup struct {
	byExactName  map[string]string
	byFoldedName map[string][]string
}

func newImportColumnTypeLookup(columns []connection.ColumnDefinition) importColumnTypeLookup {
	lookup := importColumnTypeLookup{
		byExactName:  make(map[string]string, len(columns)),
		byFoldedName: make(map[string][]string, len(columns)),
	}
	for _, column := range columns {
		name := column.Name
		if strings.TrimSpace(name) == "" {
			continue
		}
		if _, exists := lookup.byExactName[name]; !exists {
			foldedName := normalizeColumnName(name)
			lookup.byFoldedName[foldedName] = append(lookup.byFoldedName[foldedName], name)
		}
		lookup.byExactName[name] = strings.TrimSpace(column.Type)
	}
	return lookup
}

func (l importColumnTypeLookup) Resolve(columnName string) string {
	if columnType, ok := l.byExactName[columnName]; ok {
		return columnType
	}
	foldedMatches := l.byFoldedName[normalizeColumnName(columnName)]
	if len(foldedMatches) != 1 {
		return ""
	}
	return l.byExactName[foldedMatches[0]]
}

type importDatabaseRowWriter struct {
	dbInst             db.Database
	applier            db.BatchApplier
	dbType             string
	tableName          string
	columns            []string
	columnTypes        importColumnTypeLookup
	conflictPolicy     string
	conflictKeyColumns []string
}

func newImportDatabaseRowWriter(dbInst db.Database, dbType, tableName string, columnTypes importColumnTypeLookup) *importDatabaseRowWriter {
	return newImportDatabaseRowWriterWithOptions(dbInst, dbType, tableName, columnTypes, ImportFileOptions{})
}

func newImportDatabaseRowWriterWithOptions(dbInst db.Database, dbType, tableName string, columnTypes importColumnTypeLookup, options ImportFileOptions) *importDatabaseRowWriter {
	writer := &importDatabaseRowWriter{
		dbInst:             dbInst,
		dbType:             dbType,
		tableName:          tableName,
		columnTypes:        columnTypes,
		conflictPolicy:     normalizeImportConflictPolicy(options.ConflictPolicy),
		conflictKeyColumns: append([]string(nil), options.ConflictKeyColumns...),
	}
	if applier, ok := dbInst.(db.BatchApplier); ok {
		writer.applier = applier
	}
	return writer
}

func (w *importDatabaseRowWriter) SetColumns(columns []string) {
	w.columns = append([]string(nil), columns...)
}

func (w *importDatabaseRowWriter) BatchEnabled() bool {
	return w.applier != nil && w.conflictPolicy == importConflictPolicyStop
}

func (w *importDatabaseRowWriter) ApplyBatch(rows []map[string]interface{}) error {
	return w.ApplyBatchContext(context.Background(), rows)
}

func (w *importDatabaseRowWriter) ApplyBatchContext(ctx context.Context, rows []map[string]interface{}) error {
	if w.applier == nil {
		return fmt.Errorf("当前数据库类型不支持批量提交")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	changes := connection.ChangeSet{Inserts: cloneImportRows(rows)}
	if contextApplier, ok := w.applier.(db.BatchApplierContext); ok {
		return contextApplier.ApplyChangesContext(ctx, w.tableName, changes)
	}
	return w.applier.ApplyChanges(w.tableName, changes)
}

func (w *importDatabaseRowWriter) ApplyOne(row map[string]interface{}) error {
	_, err := w.ApplyOneWithOutcomeContext(context.Background(), row)
	return err
}

func (w *importDatabaseRowWriter) ApplyOneContext(ctx context.Context, row map[string]interface{}) error {
	_, err := w.ApplyOneWithOutcomeContext(ctx, row)
	return err
}

func (w *importDatabaseRowWriter) ApplyOneWithOutcome(row map[string]interface{}) (importRowApplyOutcome, error) {
	return w.ApplyOneWithOutcomeContext(context.Background(), row)
}

func (w *importDatabaseRowWriter) ApplyOneWithOutcomeContext(ctx context.Context, row map[string]interface{}) (importRowApplyOutcome, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return importRowApplySucceeded, err
	}
	if w.applier != nil && w.conflictPolicy == importConflictPolicyStop {
		changes := connection.ChangeSet{Inserts: []map[string]interface{}{cloneImportRow(row)}}
		var err error
		if contextApplier, ok := w.applier.(db.BatchApplierContext); ok {
			err = contextApplier.ApplyChangesContext(ctx, w.tableName, changes)
		} else {
			err = w.applier.ApplyChanges(w.tableName, changes)
		}
		return importRowApplySucceeded, err
	}
	query, err := buildImportInsertQueryWithConflict(
		w.dbType,
		w.tableName,
		w.columns,
		row,
		w.columnTypes,
		w.conflictPolicy,
		w.conflictKeyColumns,
	)
	if err != nil {
		return importRowApplySucceeded, err
	}
	var affected int64
	if contextExecer, ok := w.dbInst.(interface {
		ExecContext(context.Context, string) (int64, error)
	}); ok {
		affected, err = contextExecer.ExecContext(ctx, query)
	} else {
		affected, err = w.dbInst.Exec(query)
	}
	if err != nil {
		if w.conflictPolicy == importConflictPolicySkipDuplicates && isMySQLConflictDialect(w.dbType) && isMySQLDuplicateKeyError(err) {
			return importRowApplySkipped, nil
		}
		if db.IsAmbiguousWriteResponse(err) || ctx.Err() != nil {
			return importRowApplySucceeded, db.MarkWriteOutcomeUnknown(err)
		}
		return importRowApplySucceeded, err
	}
	if w.conflictPolicy == importConflictPolicySkipDuplicates && (isPostgresConflictDialect(w.dbType) || resolveDDLDBType(connection.ConnectionConfig{Type: w.dbType}) == "sqlite") && affected == 0 {
		return importRowApplySkipped, nil
	}
	return importRowApplySucceeded, nil
}

func (w *importDatabaseRowWriter) ValidateColumns(columns []string) error {
	if w == nil || w.conflictPolicy != importConflictPolicyUpsert {
		return nil
	}
	available := make(map[string]int, len(columns))
	for _, column := range columns {
		available[normalizeColumnName(column)]++
	}
	for _, key := range w.conflictKeyColumns {
		matches := available[normalizeColumnName(key)]
		if matches == 0 {
			return fmt.Errorf("import conflict key column %q is not present in the selected import columns", key)
		}
		if matches > 1 {
			return fmt.Errorf("import conflict key column %q is ambiguous in the selected import columns", key)
		}
	}
	return nil
}

func isMySQLDuplicateKeyError(err error) bool {
	var mysqlError *mysqlDriver.MySQLError
	return errors.As(err, &mysqlError) && (mysqlError.Number == 1062 || mysqlError.Number == 1586)
}

type importBatchConsumer struct {
	writer          importRowWriter
	ctx             context.Context
	jobID           string
	batchSize       int
	totalRows       int
	totalRowsKnown  bool
	continueOnError bool
	onRowError      func(ImportRowError) error
	report          func(importProgressState)
	bytesRead       int64
	totalBytes      int64
	sourceStage     string
	batch           []map[string]interface{}
	batchBytes      int
	batchStartRow   int
	currentRow      int
	successCount    int
	skippedCount    int
	failedCount     int
	errorLogs       []string
	stoppedOnError  bool
	outcomeUnknown  bool
	lastProgressRow int
	lastProgressAt  time.Time
}

func (c *importBatchConsumer) SetRowErrorHandler(handler func(ImportRowError) error) {
	c.onRowError = handler
}

func (c *importBatchConsumer) SetImportSourceProgress(bytesRead int64, totalBytes int64, stage string) {
	if bytesRead >= 0 {
		c.bytesRead = bytesRead
	}
	if totalBytes >= 0 {
		c.totalBytes = totalBytes
	}
	c.sourceStage = strings.TrimSpace(stage)
}

func newImportBatchConsumer(writer importRowWriter, batchSize int, totalRows int, totalRowsKnown bool, continueOnError bool, report func(importProgressState)) *importBatchConsumer {
	if batchSize <= 0 {
		batchSize = defaultImportApplyBatchSize
	}
	return &importBatchConsumer{
		writer:          writer,
		ctx:             context.Background(),
		batchSize:       batchSize,
		totalRows:       totalRows,
		totalRowsKnown:  totalRowsKnown,
		continueOnError: continueOnError,
		report:          report,
	}
}

func (c *importBatchConsumer) SetContext(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	c.ctx = ctx
}

// SetInitialProgress continues a source stream after a durably committed
// source-row checkpoint. The parser still reads the skipped prefix to retain
// format validation and source-identity guarantees, while progress remains in
// the original source-row coordinate system.
func (c *importBatchConsumer) SetInitialProgress(current, succeeded, skipped, failed int) {
	if c == nil {
		return
	}
	c.currentRow = max(0, current)
	c.successCount = max(0, succeeded)
	c.skippedCount = max(0, skipped)
	c.failedCount = max(0, failed)
	c.lastProgressRow = c.currentRow
}

func (c *importBatchConsumer) contextError() error {
	if c == nil || c.ctx == nil {
		return nil
	}
	return c.ctx.Err()
}

func (c *importBatchConsumer) SetColumns(columns []string) error {
	if err := c.contextError(); err != nil {
		return err
	}
	if c.writer != nil {
		c.writer.SetColumns(columns)
		if validator, ok := c.writer.(importRowColumnValidator); ok {
			return validator.ValidateColumns(columns)
		}
	}
	return nil
}

func (c *importBatchConsumer) ConsumeRow(row map[string]interface{}) error {
	if err := c.contextError(); err != nil {
		return err
	}
	rowBytes, err := validateImportMapRowBytes("Import", c.currentRow+1, row)
	if err != nil {
		return err
	}
	if len(c.batch) > 0 && c.batchBytes > maxImportBatchBytes-rowBytes {
		if err := c.flush(); err != nil {
			return err
		}
	}
	c.currentRow++
	if len(c.batch) == 0 {
		c.batchStartRow = c.currentRow
	}
	c.batch = append(c.batch, cloneImportRow(row))
	c.batchBytes += rowBytes
	if len(c.batch) >= c.batchSize || c.batchBytes >= maxImportBatchBytes {
		return c.flush()
	}
	return nil
}

func (c *importBatchConsumer) Flush() error {
	return c.flush()
}

func (c *importBatchConsumer) Result() importExecutionResult {
	return importExecutionResult{
		Success:        c.successCount,
		Skipped:        c.skippedCount,
		Failed:         c.failedCount,
		Total:          c.currentRow,
		ErrorLogs:      append([]string(nil), c.errorLogs...),
		StoppedOnError: c.stoppedOnError,
		OutcomeUnknown: c.outcomeUnknown,
	}
}

func (c *importBatchConsumer) recordError(detail string) {
	c.failedCount++
	if len(c.errorLogs) < maxImportErrorDetails {
		c.errorLogs = append(c.errorLogs, detail)
	}
}

func (c *importBatchConsumer) flush() error {
	if err := c.contextError(); err != nil {
		return err
	}
	if len(c.batch) == 0 {
		return nil
	}
	rows := c.batch
	startRow := c.batchStartRow
	c.batch = nil
	c.batchBytes = 0
	c.batchStartRow = 0

	if c.writer != nil && c.writer.BatchEnabled() && !c.continueOnError {
		var batchErr error
		if contextWriter, ok := c.writer.(importBatchContextWriter); ok {
			batchErr = contextWriter.ApplyBatchContext(c.ctx, rows)
		} else {
			batchErr = c.writer.ApplyBatch(rows)
		}
		if batchErr == nil {
			c.successCount += len(rows)
			c.emitProgress(startRow+len(rows)-1, true)
			return c.contextError()
		}
		if errors.Is(batchErr, context.Canceled) {
			c.outcomeUnknown = true
			return batchErr
		}
		if err := c.contextError(); err != nil {
			c.outcomeUnknown = true
			return err
		}
		detail := fmt.Sprintf("Rows %d-%d: %s", startRow, startRow+len(rows)-1, sqlaudit.RedactError(batchErr.Error()))
		c.recordError(detail)
		c.stoppedOnError = true
		c.outcomeUnknown = true
		c.emitProgress(startRow+len(rows)-1, true)
		return &importStoppedOnError{detail: detail}
	}

	for idx, row := range rows {
		if err := c.contextError(); err != nil {
			return err
		}
		if c.writer != nil {
			outcome := importRowApplySucceeded
			var err error
			if contextOutcomeWriter, ok := c.writer.(importRowContextOutcomeWriter); ok {
				outcome, err = contextOutcomeWriter.ApplyOneWithOutcomeContext(c.ctx, row)
			} else if outcomeWriter, ok := c.writer.(importRowOutcomeWriter); ok {
				outcome, err = outcomeWriter.ApplyOneWithOutcome(row)
			} else if contextWriter, ok := c.writer.(importRowContextWriter); ok {
				err = contextWriter.ApplyOneContext(c.ctx, row)
			} else {
				err = c.writer.ApplyOne(row)
			}
			if err != nil {
				if db.IsWriteOutcomeUnknown(err) {
					sourceRow := startRow + idx
					sanitizedMessage := sqlaudit.RedactError(err.Error())
					detail := fmt.Sprintf("Row %d: %s", sourceRow, sanitizedMessage)
					c.recordError(detail)
					c.stoppedOnError = true
					c.outcomeUnknown = true
					// Only rows through the uncertain write were submitted. Rows later in
					// this parser buffer must not inflate the processed/unknown total.
					c.currentRow = sourceRow
					c.emitProgress(sourceRow, true)
					return &importStoppedOnError{detail: detail, cause: err}
				}
				if errors.Is(err, context.Canceled) {
					c.outcomeUnknown = true
					return err
				}
				if contextErr := c.contextError(); contextErr != nil {
					c.outcomeUnknown = true
					return contextErr
				}
				sourceRow := startRow + idx
				sanitizedMessage := sqlaudit.RedactError(err.Error())
				detail := fmt.Sprintf("Row %d: %s", sourceRow, sanitizedMessage)
				c.recordError(detail)
				if c.onRowError != nil {
					if persistErr := c.onRowError(ImportRowError{
						SourceRow: int64(sourceRow),
						Category:  "database",
						Message:   sanitizedMessage,
						Values:    cloneImportRow(row),
					}); persistErr != nil {
						c.stoppedOnError = true
						c.emitProgress(startRow+idx, true)
						return persistErr
					}
				}
				if !c.continueOnError {
					c.stoppedOnError = true
					c.emitProgress(startRow+idx, true)
					return &importStoppedOnError{detail: detail}
				}
			} else if outcome == importRowApplySkipped {
				c.skippedCount++
			} else {
				c.successCount++
			}
		}
		c.emitProgress(startRow + idx)
		if err := c.contextError(); err != nil {
			c.emitProgress(startRow+idx, true)
			return err
		}
	}
	c.emitProgress(startRow+len(rows)-1, true)
	return nil
}

func (c *importBatchConsumer) emitProgress(current int, force ...bool) {
	if c.report == nil {
		return
	}
	forced := len(force) > 0 && force[0]
	if !forced && current > 10 && current-c.lastProgressRow < importProgressRowInterval &&
		!c.lastProgressAt.IsZero() && time.Since(c.lastProgressAt) < importProgressTimeInterval {
		return
	}
	c.lastProgressRow = current
	c.lastProgressAt = time.Now()
	// A bulk writer has an uncommitted parser buffer until Flush succeeds. Its
	// checkpoint is therefore safe only at an explicit flush boundary. The
	// per-row path has no pending database write after ApplyOne returns, so it
	// can safely advance the durable cursor after every accepted row.
	checkpointSafe := !c.outcomeUnknown && (c.writer == nil || !c.writer.BatchEnabled() || c.continueOnError || forced)
	c.report(importProgressState{
		JobID:          c.jobID,
		Current:        current,
		Total:          c.totalRows,
		Success:        c.successCount,
		Skipped:        c.skippedCount,
		Errors:         c.failedCount,
		TotalRowsKnown: c.totalRowsKnown,
		BytesRead:      c.bytesRead,
		TotalBytes:     c.totalBytes,
		Stage:          "write",
		CheckpointSafe: checkpointSafe,
	})
}

func buildImportPreview(filePath string, previewLimit int) (importPreviewData, error) {
	return buildImportPreviewWithOptions(filePath, previewLimit, ImportFileOptions{})
}

func buildImportPreviewWithOptions(filePath string, previewLimit int, options ImportFileOptions) (importPreviewData, error) {
	collector := newImportPreviewCollector(previewLimit)
	if err := streamImportFileWithOptions(filePath, collector, options); err != nil && !errors.Is(err, errImportPreviewLimitReached) {
		return importPreviewData{}, err
	} else if err == nil {
		collectorResult := collector.Result()
		collectorResult.TotalRowsKnown = true
		return collectorResult, nil
	}
	return collector.Result(), nil
}

func parseImportFile(filePath string) ([]map[string]interface{}, []string, error) {
	collector := &importCollectConsumer{}
	if err := streamImportFile(filePath, collector); err != nil {
		return nil, nil, err
	}
	return collector.rows, collector.columns, nil
}

func streamImportFile(filePath string, consumer importFileConsumer) error {
	return streamImportFileWithOptions(filePath, consumer, ImportFileOptions{})
}

func streamImportFileWithOptions(filePath string, consumer importFileConsumer, options ImportFileOptions) error {
	if consumer == nil {
		return fmt.Errorf("import file consumer is required")
	}
	if err := validateImportFileOptions(options); err != nil {
		return err
	}
	lower := strings.ToLower(filePath)
	switch {
	case strings.HasSuffix(lower, ".json"):
		return streamJSONImportFileWithOptions(filePath, consumer, options)
	case strings.HasSuffix(lower, ".csv"):
		return streamCSVImportFileWithOptions(filePath, consumer, options)
	case strings.HasSuffix(lower, ".xlsx"):
		return streamXLSXImportFileWithOptions(filePath, consumer, options)
	case strings.HasSuffix(lower, ".xls"):
		return fmt.Errorf("legacy binary .xls workbooks are not supported; convert the file to .xlsx or CSV")
	default:
		return fmt.Errorf("Unsupported file format")
	}
}

const (
	importConflictPolicyStop           = "stop"
	importConflictPolicySkipDuplicates = "skip_duplicates"
	importConflictPolicyUpsert         = "upsert"
	maxImportNullTokenRunes            = 64
	maxImportSheetNameRunes            = 255
)

func normalizeImportConflictPolicy(value string) string {
	policy := strings.ToLower(strings.TrimSpace(value))
	if policy == "" {
		return importConflictPolicyStop
	}
	return policy
}

func isMySQLConflictDialect(dbType string) bool {
	switch resolveDDLDBType(connection.ConnectionConfig{Type: dbType}) {
	case "mysql", "mariadb", "oceanbase":
		return true
	default:
		return false
	}
}

func isPostgresConflictDialect(dbType string) bool {
	return resolveDDLDBType(connection.ConnectionConfig{Type: dbType}) == "postgres"
}

func validateImportConflictPolicyForDB(dbType string, options ImportFileOptions) error {
	policy := normalizeImportConflictPolicy(options.ConflictPolicy)
	if policy == importConflictPolicyStop {
		return nil
	}
	if !isMySQLConflictDialect(dbType) && !isPostgresConflictDialect(dbType) && resolveDDLDBType(connection.ConnectionConfig{Type: dbType}) != "sqlite" {
		return fmt.Errorf("import conflict policy %q is not supported for database type %q", policy, dbType)
	}
	if policy == importConflictPolicyUpsert && isMySQLConflictDialect(dbType) {
		return fmt.Errorf("import upsert cannot safely target selected conflict keys for database type %q", dbType)
	}
	if policy == importConflictPolicyUpsert && len(options.ConflictKeyColumns) == 0 {
		return fmt.Errorf("import upsert requires at least one conflict key column")
	}
	return nil
}

func validateImportFileOptions(options ImportFileOptions) error {
	if _, err := normalizeImportTextEncoding(options.Encoding); err != nil {
		return fmt.Errorf("invalid import encoding: %w", err)
	}
	if _, _, err := resolveImportDelimiter(options.Delimiter); err != nil {
		return fmt.Errorf("invalid import delimiter: %w", err)
	}
	if _, err := resolveImportHeaderRow(options.HeaderRow); err != nil {
		return err
	}
	switch normalizeImportConflictPolicy(options.ConflictPolicy) {
	case importConflictPolicyStop, importConflictPolicySkipDuplicates, importConflictPolicyUpsert:
	default:
		return fmt.Errorf("unsupported import conflictPolicy %q", options.ConflictPolicy)
	}
	if options.NullToken != nil {
		if !utf8.ValidString(*options.NullToken) {
			return fmt.Errorf("import nullToken must be valid UTF-8")
		}
		if utf8.RuneCountInString(*options.NullToken) > maxImportNullTokenRunes {
			return fmt.Errorf("import nullToken exceeds %d-character limit", maxImportNullTokenRunes)
		}
	}
	if !utf8.ValidString(options.SheetName) {
		return fmt.Errorf("import sheetName must be valid UTF-8")
	}
	if utf8.RuneCountInString(options.SheetName) > maxImportSheetNameRunes {
		return fmt.Errorf("import sheetName exceeds %d-character limit", maxImportSheetNameRunes)
	}
	seenConflictKeys := make(map[string]struct{}, len(options.ConflictKeyColumns))
	for _, column := range options.ConflictKeyColumns {
		if strings.TrimSpace(column) == "" {
			return fmt.Errorf("import conflictKeyColumns must not contain empty names")
		}
		normalizedColumn := normalizeColumnName(column)
		if _, duplicate := seenConflictKeys[normalizedColumn]; duplicate {
			return fmt.Errorf("import conflictKeyColumns contains duplicate column %q", column)
		}
		seenConflictKeys[normalizedColumn] = struct{}{}
	}
	return nil
}

func streamJSONImportFile(filePath string, consumer importFileConsumer) error {
	return streamJSONImportFileWithOptions(filePath, consumer, ImportFileOptions{})
}

func streamJSONImportFileWithOptions(filePath string, consumer importFileConsumer, options ImportFileOptions) error {
	source, err := openImportTextSource(filePath, options.Encoding)
	if err != nil {
		return err
	}
	defer source.Close()

	decoder := newImportJSONDecoderWithLimits(source, importLexicalLimits{})
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("JSON Parse Error: %w", err)
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '[' {
		return fmt.Errorf("JSON Parse Error: root array expected")
	}

	var columns []string
	var columnSet map[string]struct{}
	rowNumber := 0
	for decoder.More() {
		rowNumber++
		var raw map[string]interface{}
		if err := decoder.Decode(&raw); err != nil {
			return fmt.Errorf("JSON Parse Error: %w", err)
		}
		if _, err := validateImportMapRowBytes("JSON", rowNumber, raw); err != nil {
			return err
		}
		if columns == nil {
			columns = importJSONColumns(raw)
			columnSet = make(map[string]struct{}, len(columns))
			for _, column := range columns {
				columnSet[column] = struct{}{}
			}
			if err := consumer.SetColumns(columns); err != nil {
				return err
			}
		} else {
			unknown := make([]string, 0)
			for key := range raw {
				if _, ok := columnSet[key]; !ok {
					unknown = append(unknown, key)
				}
			}
			if len(unknown) > 0 {
				sort.Strings(unknown)
				return fmt.Errorf("JSON Structure Drift at row %d: unknown fields %q", rowNumber, unknown)
			}
		}
		reportImportSourceProgress(consumer, source.RawBytesRead(), source.TotalBytes())
		if err := consumer.ConsumeRow(normalizeImportMapRowWithOptions(columns, raw, options)); err != nil {
			return err
		}
	}
	closing, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("JSON Parse Error: %w", err)
	}
	closingDelim, ok := closing.(json.Delim)
	if !ok || closingDelim != ']' {
		return fmt.Errorf("JSON Parse Error: root array is not closed")
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); err == nil {
		return fmt.Errorf("JSON Parse Error: trailing content after root array")
	} else if !errors.Is(err, io.EOF) {
		return fmt.Errorf("JSON Parse Error: trailing content after root array: %w", err)
	}
	reportImportSourceProgress(consumer, source.RawBytesRead(), source.TotalBytes())
	return nil
}

func streamCSVImportFile(filePath string, consumer importFileConsumer) error {
	return streamCSVImportFileWithOptions(filePath, consumer, ImportFileOptions{})
}

func streamCSVImportFileWithOptions(filePath string, consumer importFileConsumer, options ImportFileOptions) error {
	source, err := openImportTextSource(filePath, options.Encoding)
	if err != nil {
		return err
	}
	defer source.Close()

	reader, err := newImportCSVReader(source, options.Delimiter)
	if err != nil {
		return err
	}
	reader.ReuseRecord = true
	reader.FieldsPerRecord = -1

	headerRow, err := resolveImportHeaderRow(options.HeaderRow)
	if err != nil {
		return err
	}
	var header []string
	for sourceRow := 1; sourceRow <= headerRow; sourceRow++ {
		record, err := reader.Read()
		if err != nil {
			if err == io.EOF {
				return fmt.Errorf("CSV header row %d is missing", headerRow)
			}
			return fmt.Errorf("CSV Parse Error: %w", err)
		}
		if err := validateImportStringCells("CSV", sourceRow, record); err != nil {
			return err
		}
		if sourceRow == headerRow {
			header = cloneImportColumns(record)
		}
	}
	if len(header) > 0 {
		header[0] = strings.TrimPrefix(header[0], "\uFEFF")
	}
	columns := cloneImportColumns(header)
	if !hasImportUsableColumns(columns) {
		return fmt.Errorf("CSV empty or missing header")
	}
	if err := validateImportUniqueColumns("CSV", columns); err != nil {
		return err
	}
	if err := consumer.SetColumns(columns); err != nil {
		return err
	}
	reader.FieldsPerRecord = len(columns)
	reportImportSourceProgress(consumer, source.RawBytesRead(), source.TotalBytes())

	rowNumber := headerRow
	for {
		record, err := reader.Read()
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("CSV Parse Error: %w", err)
		}
		rowNumber++
		if err := validateImportStringCells("CSV", rowNumber, record); err != nil {
			return err
		}
		reportImportSourceProgress(consumer, source.RawBytesRead(), source.TotalBytes())
		if err := consumer.ConsumeRow(buildImportRowFromValuesWithOptions(columns, record, options)); err != nil {
			return err
		}
	}
}

const maxImportHeaderRow = 1_000_000

func resolveImportHeaderRow(value int) (int, error) {
	if value == 0 {
		return 1, nil
	}
	if value < 1 || value > maxImportHeaderRow {
		return 0, fmt.Errorf("import headerRow must be between 1 and %d", maxImportHeaderRow)
	}
	return value, nil
}

const (
	importDelimiterAuto      = "auto"
	importDelimiterComma     = "comma"
	importDelimiterTab       = "tab"
	importDelimiterSemicolon = "semicolon"
	importDelimiterPipe      = "pipe"
	importDelimiterProbeSize = 256 * 1024
)

var importDelimiterCandidates = []rune{',', '\t', ';', '|'}

func newImportCSVReader(source io.Reader, delimiterName string) (*csv.Reader, error) {
	return newImportCSVReaderWithLimits(source, delimiterName, importLexicalLimits{})
}

func resolveImportDelimiter(value string) (delimiter rune, explicit bool, err error) {
	if value == "" || value == importDelimiterAuto {
		return 0, false, nil
	}
	switch value {
	case importDelimiterComma:
		return ',', true, nil
	case importDelimiterTab:
		return '\t', true, nil
	case importDelimiterSemicolon:
		return ';', true, nil
	case importDelimiterPipe:
		return '|', true, nil
	default:
		return 0, false, fmt.Errorf("unsupported import delimiter %q", value)
	}
}

type importDelimiterProbeScore struct {
	delimiter      rune
	records        int
	consistentRows int
	fieldCount     int
}

func detectImportCSVDelimiter(prefix []byte) (rune, error) {
	best := importDelimiterProbeScore{delimiter: ','}
	tied := false
	for _, delimiter := range importDelimiterCandidates {
		score := scoreImportCSVDelimiter(prefix, delimiter)
		if compareImportDelimiterScores(score, best) > 0 {
			best = score
			tied = false
		} else if delimiter != best.delimiter && compareImportDelimiterScores(score, best) == 0 && score.consistentRows > 0 {
			tied = true
		}
	}
	if tied {
		return 0, fmt.Errorf("CSV delimiter probe is ambiguous; specify delimiter explicitly")
	}
	if best.consistentRows == 0 {
		// Preserve single-column CSV compatibility when no supported delimiter
		// appears outside quoted fields.
		return ',', nil
	}
	return best.delimiter, nil
}

func scoreImportCSVDelimiter(prefix []byte, delimiter rune) importDelimiterProbeScore {
	reader := csv.NewReader(bytes.NewReader(prefix))
	reader.Comma = delimiter
	reader.FieldsPerRecord = -1
	widthCounts := make(map[int]int)
	score := importDelimiterProbeScore{delimiter: delimiter}
	for score.records < 32 {
		record, err := reader.Read()
		if err != nil {
			break
		}
		score.records++
		if len(record) > 1 {
			widthCounts[len(record)]++
		}
	}
	for width, count := range widthCounts {
		if count > score.consistentRows || (count == score.consistentRows && width < score.fieldCount) {
			score.consistentRows = count
			score.fieldCount = width
		}
	}
	return score
}

func compareImportDelimiterScores(left, right importDelimiterProbeScore) int {
	if left.consistentRows != right.consistentRows {
		return left.consistentRows - right.consistentRows
	}
	if left.records != right.records {
		return left.records - right.records
	}
	return 0
}

func validateImportStringCells(format string, rowNumber int, values []string) error {
	totalBytes := 0
	for idx, value := range values {
		if len(value) > maxImportCellBytes {
			return &ImportFileLimitError{
				Format: format,
				Kind:   ImportFileCellByteLimit,
				Row:    rowNumber,
				Cell:   idx + 1,
				Limit:  maxImportCellBytes,
			}
		}
		if totalBytes > maxImportRowBytes-len(value) {
			return &ImportFileLimitError{
				Format: format,
				Kind:   ImportFileRowByteLimit,
				Row:    rowNumber,
				Limit:  maxImportRowBytes,
			}
		}
		totalBytes += len(value)
	}
	return nil
}

func validateImportMapRowBytes(format string, rowNumber int, row map[string]interface{}) (int, error) {
	totalBytes := 0
	for column, value := range row {
		valueBytes := importValueByteSize(value)
		if valueBytes > maxImportCellBytes {
			return 0, &ImportFileLimitError{
				Format: format,
				Kind:   ImportFileCellByteLimit,
				Row:    rowNumber,
				Column: column,
				Limit:  maxImportCellBytes,
			}
		}
		if totalBytes > maxImportRowBytes-valueBytes {
			return 0, &ImportFileLimitError{
				Format: format,
				Kind:   ImportFileRowByteLimit,
				Row:    rowNumber,
				Limit:  maxImportRowBytes,
			}
		}
		totalBytes += valueBytes
	}
	return totalBytes, nil
}

func importValueByteSize(value interface{}) int {
	switch typed := value.(type) {
	case nil:
		return 0
	case string:
		return len(typed)
	case []byte:
		return len(typed)
	case json.Number:
		return len(typed.String())
	case bool:
		if typed {
			return len("true")
		}
		return len("false")
	case []interface{}:
		total := 0
		for _, item := range typed {
			total += importValueByteSize(item)
		}
		return total
	case map[string]interface{}:
		total := 0
		for key, item := range typed {
			total += len(key) + importValueByteSize(item)
		}
		return total
	default:
		return len(fmt.Sprintf("%v", typed))
	}
}

func buildImportInsertQuery(dbType, tableName string, columns []string, row map[string]interface{}, columnTypes importColumnTypeLookup) (string, error) {
	return buildImportInsertQueryWithConflict(
		dbType,
		tableName,
		columns,
		row,
		columnTypes,
		importConflictPolicyStop,
		nil,
	)
}

func buildImportInsertQueryWithConflict(
	dbType string,
	tableName string,
	columns []string,
	row map[string]interface{},
	columnTypes importColumnTypeLookup,
	conflictPolicy string,
	conflictKeyColumns []string,
) (string, error) {
	conflictPolicy = normalizeImportConflictPolicy(conflictPolicy)
	if err := validateImportConflictPolicyForDB(dbType, ImportFileOptions{
		ConflictPolicy:     conflictPolicy,
		ConflictKeyColumns: conflictKeyColumns,
	}); err != nil {
		return "", err
	}
	quotedCols := make([]string, 0, len(columns))
	values := make([]string, 0, len(columns))
	usableColumns := make([]string, 0, len(columns))
	for _, column := range columns {
		if strings.TrimSpace(column) == "" {
			continue
		}
		usableColumns = append(usableColumns, column)
		quotedCols = append(quotedCols, quoteIdentByType(dbType, column))
		colType := columnTypes.Resolve(column)
		values = append(values, formatImportSQLValue(dbType, colType, row[column]))
	}
	if len(quotedCols) == 0 {
		return "", fmt.Errorf("导入文件缺少有效列头")
	}
	query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
		quoteQualifiedIdentByType(dbType, tableName),
		strings.Join(quotedCols, ", "),
		strings.Join(values, ", "))
	if conflictPolicy == importConflictPolicyStop {
		return query, nil
	}
	if conflictPolicy == importConflictPolicySkipDuplicates {
		if isMySQLConflictDialect(dbType) {
			// MySQL duplicates are classified by their typed error code after a
			// normal INSERT. INSERT IGNORE would also hide truncation and NOT NULL
			// errors, so it is deliberately not used here.
			return query, nil
		}
		return query + " ON CONFLICT DO NOTHING", nil
	}

	keySet := make(map[string]struct{}, len(conflictKeyColumns))
	availableColumns := make(map[string][]string, len(usableColumns))
	for _, column := range usableColumns {
		normalizedColumn := normalizeColumnName(column)
		availableColumns[normalizedColumn] = append(availableColumns[normalizedColumn], column)
	}
	quotedKeys := make([]string, 0, len(conflictKeyColumns))
	for _, key := range conflictKeyColumns {
		normalizedKey := normalizeColumnName(key)
		matches := availableColumns[normalizedKey]
		if len(matches) == 0 {
			return "", fmt.Errorf("import conflict key column %q is not present in the selected import columns", key)
		}
		if len(matches) > 1 {
			return "", fmt.Errorf("import conflict key column %q is ambiguous in the selected import columns", key)
		}
		keySet[normalizedKey] = struct{}{}
		quotedKeys = append(quotedKeys, quoteIdentByType(dbType, matches[0]))
	}
	assignments := make([]string, 0, len(usableColumns))
	for _, column := range usableColumns {
		if _, key := keySet[normalizeColumnName(column)]; key {
			continue
		}
		quoted := quoteIdentByType(dbType, column)
		if isMySQLConflictDialect(dbType) {
			assignments = append(assignments, quoted+"=VALUES("+quoted+")")
		} else {
			assignments = append(assignments, quoted+"=EXCLUDED."+quoted)
		}
	}
	if isMySQLConflictDialect(dbType) {
		if len(assignments) == 0 {
			quoted := quotedKeys[0]
			assignments = append(assignments, quoted+"=VALUES("+quoted+")")
		}
		return query + " ON DUPLICATE KEY UPDATE " + strings.Join(assignments, ", "), nil
	}
	if len(assignments) == 0 {
		return query + " ON CONFLICT (" + strings.Join(quotedKeys, ", ") + ") DO NOTHING", nil
	}
	return query + " ON CONFLICT (" + strings.Join(quotedKeys, ", ") + ") DO UPDATE SET " + strings.Join(assignments, ", "), nil
}

func importJSONColumns(row map[string]interface{}) []string {
	columns := make([]string, 0, len(row))
	for key := range row {
		if strings.TrimSpace(key) == "" {
			continue
		}
		columns = append(columns, key)
	}
	sort.Strings(columns)
	return columns
}

func cloneImportColumns(raw []string) []string {
	return append([]string(nil), raw...)
}

func hasImportUsableColumns(columns []string) bool {
	for _, column := range columns {
		if strings.TrimSpace(column) != "" {
			return true
		}
	}
	return false
}

func validateImportUniqueColumns(format string, columns []string) error {
	seen := make(map[string]string, len(columns))
	for _, column := range columns {
		normalized := normalizeColumnName(column)
		if normalized == "" {
			continue
		}
		if previous, exists := seen[normalized]; exists {
			return fmt.Errorf("%s duplicate header columns %q and %q", format, previous, column)
		}
		seen[normalized] = column
	}
	return nil
}

func buildImportRowFromValues(columns []string, values []string) map[string]interface{} {
	return buildImportRowFromValuesWithOptions(columns, values, ImportFileOptions{})
}

func buildImportRowFromValuesWithOptions(columns []string, values []string, options ImportFileOptions) map[string]interface{} {
	row := make(map[string]interface{}, len(columns))
	for idx, column := range columns {
		if strings.TrimSpace(column) == "" {
			continue
		}
		if idx >= len(values) {
			row[column] = nil
			continue
		}
		row[column] = normalizeImportStringValue(values[idx], options)
	}
	return row
}

func normalizeImportStringValue(value string, options ImportFileOptions) interface{} {
	if options.NullToken != nil {
		if value == *options.NullToken {
			return nil
		}
	} else if value == "NULL" {
		// Preserve the legacy import wrapper's historical NULL convention when
		// no explicit token was supplied.
		return nil
	}
	if options.EmptyStringAsNull && value == "" {
		return nil
	}
	return value
}

func normalizeImportMapRow(columns []string, raw map[string]interface{}) map[string]interface{} {
	return normalizeImportMapRowWithOptions(columns, raw, ImportFileOptions{})
}

func normalizeImportMapRowWithOptions(columns []string, raw map[string]interface{}, options ImportFileOptions) map[string]interface{} {
	row := make(map[string]interface{}, len(columns))
	for _, column := range columns {
		if value, ok := raw[column]; ok {
			if text, isText := value.(string); isText {
				row[column] = normalizeImportStringValue(text, options)
			} else {
				row[column] = value
			}
			continue
		}
		row[column] = nil
	}
	return row
}

func cloneImportRow(row map[string]interface{}) map[string]interface{} {
	if row == nil {
		return nil
	}
	cloned := make(map[string]interface{}, len(row))
	for key, value := range row {
		cloned[key] = value
	}
	return cloned
}

func cloneImportRows(rows []map[string]interface{}) []map[string]interface{} {
	if len(rows) == 0 {
		return nil
	}
	cloned := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		cloned = append(cloned, cloneImportRow(row))
	}
	return cloned
}
