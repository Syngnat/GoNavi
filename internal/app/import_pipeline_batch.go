package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/sqlaudit"
)

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
						Retryable: true,
						Values:    row,
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
