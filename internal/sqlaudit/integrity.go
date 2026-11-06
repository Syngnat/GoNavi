package sqlaudit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

const (
	chainVersion       = "sqlaudit-chain-v1"
	integrityAlgorithm = "sha256-canonical-v1"
)

func (s *Store) VerifyIntegrity() (IntegrityReport, error) {
	return s.VerifyIntegrityContext(context.Background())
}

// VerifyIntegrityContext verifies the local hash chain while honoring the
// caller context so a canceled Web request can stop a long-running scan.
func (s *Store) VerifyIntegrityContext(ctx context.Context) (IntegrityReport, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	report := newIntegrityReport()
	if err := s.ensureOpen(); err != nil {
		return report, err
	}
	rows, err := s.db.QueryContext(ctx, selectEventColumns+` ORDER BY sequence ASC`)
	if err != nil {
		return report, fmt.Errorf("read sql audit chain: %w", err)
	}
	defer rows.Close()
	return verifyIntegrityRows(ctx, rows, report)
}

type integrityRows interface {
	rowScanner
	Next() bool
	Err() error
	Close() error
}

func verifyIntegrityRows(ctx context.Context, rows integrityRows, report IntegrityReport) (IntegrityReport, error) {
	previousHash := ""
	var previousSequence int64
	firstRecord := true
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return report, fmt.Errorf("verify SQL audit chain: %w", err)
		}
		event, err := scanEvent(rows)
		if err != nil {
			return report, err
		}
		if err := ctx.Err(); err != nil {
			return report, fmt.Errorf("verify SQL audit chain: %w", err)
		}
		report.CheckedRecords++
		if firstRecord {
			report.FirstSequence = event.Sequence
		}
		report.LastSequence = event.Sequence
		if event.Sequence <= 0 {
			return invalidIntegrityReport(report, event.Sequence, "sequence must be positive"), nil
		}
		isFirst := firstRecord
		if isFirst {
			report.PartialChain = event.Sequence > 1 || event.PrevHash != ""
			report.TruncatedPrefix = report.PartialChain
			if report.PartialChain {
				report.Message = "ok (partial chain after prefix retention; unkeyed weak validation)"
			}
		} else if event.Sequence <= previousSequence {
			return invalidIntegrityReport(report, event.Sequence, "sequence order is invalid"), nil
		}
		if !isFirst && event.PrevHash != previousHash {
			return invalidIntegrityReport(report, event.Sequence, "previous hash does not match"), nil
		}
		expected, err := calculateEventHash(event)
		if err != nil {
			return report, err
		}
		if event.Hash != expected {
			return invalidIntegrityReport(report, event.Sequence, "record hash does not match"), nil
		}
		previousSequence = event.Sequence
		previousHash = event.Hash
		firstRecord = false
	}
	if err := rows.Err(); err != nil {
		return report, fmt.Errorf("iterate sql audit chain: %w", err)
	}
	return report, nil
}

func newIntegrityReport() IntegrityReport {
	return IntegrityReport{
		Valid:          true,
		WeakValidation: true,
		Algorithm:      integrityAlgorithm,
		Message:        "ok (unkeyed local hash chain; weak validation)",
	}
}

// 新增上下文字段省略空值，保证升级前记录的规范 JSON 和哈希不变。
type canonicalEvent struct {
	Version               string `json:"version"`
	ID                    string `json:"id"`
	Sequence              int64  `json:"sequence"`
	Timestamp             int64  `json:"timestamp"`
	EventType             string `json:"eventType"`
	Status                string `json:"status"`
	ConnectionID          string `json:"connectionId"`
	ConnectionFingerprint string `json:"connectionFingerprint"`
	DBType                string `json:"dbType"`
	Database              string `json:"database"`
	QueryID               string `json:"queryId"`
	TransactionID         string `json:"transactionId"`
	Source                string `json:"source"`
	UserName              string `json:"userName,omitempty"`
	MCPRequestID          string `json:"mcpRequestId,omitempty"`
	MCPClient             string `json:"mcpClient,omitempty"`
	BoundaryMode          string `json:"boundaryMode"`
	CommitMode            string `json:"commitMode"`
	SQLText               string `json:"sqlText"`
	SQLRedacted           bool   `json:"sqlRedacted"`
	SQLFingerprint        string `json:"sqlFingerprint"`
	StatementIndex        int    `json:"statementIndex"`
	StatementCount        int    `json:"statementCount"`
	ExecutedCount         int    `json:"executedCount,omitempty"`
	FailedIndex           int    `json:"failedIndex,omitempty"`
	OutcomeUnknown        bool   `json:"outcomeUnknown,omitempty"`
	DurationMs            int64  `json:"durationMs"`
	RowsAffected          int64  `json:"rowsAffected"`
	RowsReturned          int64  `json:"rowsReturned"`
	Error                 string `json:"error"`
	PrevHash              string `json:"prevHash"`
}

func calculateEventHash(event Event) (string, error) {
	payload, err := json.Marshal(canonicalEvent{
		Version:               chainVersion,
		ID:                    event.ID,
		Sequence:              event.Sequence,
		Timestamp:             event.Timestamp,
		EventType:             event.EventType,
		Status:                event.Status,
		ConnectionID:          event.ConnectionID,
		ConnectionFingerprint: event.ConnectionFingerprint,
		DBType:                event.DBType,
		Database:              event.Database,
		QueryID:               event.QueryID,
		TransactionID:         event.TransactionID,
		Source:                event.Source,
		UserName:              event.UserName,
		MCPRequestID:          event.MCPRequestID,
		MCPClient:             event.MCPClient,
		BoundaryMode:          event.BoundaryMode,
		CommitMode:            event.CommitMode,
		SQLText:               event.SQLText,
		SQLRedacted:           event.SQLRedacted,
		SQLFingerprint:        event.SQLFingerprint,
		StatementIndex:        event.StatementIndex,
		StatementCount:        event.StatementCount,
		ExecutedCount:         event.ExecutedCount,
		FailedIndex:           event.FailedIndex,
		OutcomeUnknown:        event.OutcomeUnknown,
		DurationMs:            event.DurationMs,
		RowsAffected:          event.RowsAffected,
		RowsReturned:          event.RowsReturned,
		Error:                 event.Error,
		PrevHash:              event.PrevHash,
	})
	if err != nil {
		return "", fmt.Errorf("encode canonical SQL audit event: %w", err)
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), nil
}

func invalidIntegrityReport(report IntegrityReport, sequence int64, message string) IntegrityReport {
	report.Valid = false
	report.InvalidSequence = sequence
	report.Message = message + " (unkeyed local hash chain; weak validation)"
	return report
}

const selectEventColumns = `SELECT sequence, id, timestamp, event_type, status,
	connection_id, connection_fingerprint, db_type, database_name, query_id,
	transaction_id, source, boundary_mode, commit_mode, sql_text, sql_redacted,
	sql_fingerprint, statement_index, statement_count, executed_count, failed_index,
	outcome_unknown, duration_ms, rows_affected, rows_returned, error_text, prev_hash, record_hash, mcp_request_id, mcp_client, user_name FROM sql_audit_events`

type rowScanner interface {
	Scan(...any) error
}

func scanEvent(scanner rowScanner) (Event, error) {
	var event Event
	var sqlRedacted, outcomeUnknown int
	if err := scanner.Scan(
		&event.Sequence, &event.ID, &event.Timestamp, &event.EventType, &event.Status,
		&event.ConnectionID, &event.ConnectionFingerprint, &event.DBType, &event.Database,
		&event.QueryID, &event.TransactionID, &event.Source, &event.BoundaryMode,
		&event.CommitMode, &event.SQLText, &sqlRedacted, &event.SQLFingerprint,
		&event.StatementIndex, &event.StatementCount, &event.ExecutedCount, &event.FailedIndex, &outcomeUnknown, &event.DurationMs,
		&event.RowsAffected, &event.RowsReturned, &event.Error, &event.PrevHash, &event.Hash, &event.MCPRequestID, &event.MCPClient, &event.UserName,
	); err != nil {
		return Event{}, fmt.Errorf("scan SQL audit event: %w", err)
	}
	event.SQLRedacted = sqlRedacted != 0
	event.OutcomeUnknown = outcomeUnknown != 0
	return event, nil
}
