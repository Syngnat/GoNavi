package sqlaudit

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

var ErrUnsupportedExportFormat = errors.New("unsupported SQL audit export format")

var (
	ErrExportRecordLimit = errors.New("SQL audit export record limit exceeded")
	ErrExportSizeLimit   = errors.New("SQL audit export size limit exceeded")
)

const (
	maxExportRecords int64 = 100_000
	maxExportBytes         = 64 * 1024 * 1024
)

// BuildExport returns every event matching filter. Pagination fields are
// intentionally ignored so exporting from a paged workbench does not silently
// export only the visible page.
func (s *Store) BuildExport(filter Filter, format string) ([]byte, error) {
	return s.buildExportWithLimits(filter, format, maxExportRecords, maxExportBytes)
}

// BuildExportWithLimits applies caller-specific resource caps. It is used by
// the browser server, whose RPC envelope creates additional copies of content.
func (s *Store) BuildExportWithLimits(filter Filter, format string, recordLimit int64, byteLimit int) ([]byte, error) {
	if recordLimit <= 0 || recordLimit > maxExportRecords {
		recordLimit = maxExportRecords
	}
	if byteLimit <= 0 || byteLimit > maxExportBytes {
		byteLimit = maxExportBytes
	}
	return s.buildExportWithLimits(filter, format, recordLimit, byteLimit)
}

func (s *Store) buildExportWithLimits(filter Filter, format string, recordLimit int64, byteLimit int) ([]byte, error) {
	if err := s.ensureOpen(); err != nil {
		return nil, err
	}
	format = strings.ToLower(strings.TrimSpace(format))
	if format != "json" && format != "csv" {
		return nil, fmt.Errorf("%w: %s", ErrUnsupportedExportFormat, format)
	}
	filter = normalizeFilter(filter)
	filter.Page = 0
	filter.PageSize = 0
	events, err := s.loadExportEvents(filter, recordLimit, byteLimit)
	if err != nil {
		return nil, err
	}

	switch format {
	case "json":
		output := newBoundedBuffer(byteLimit)
		if _, err := output.Write([]byte{'['}); err != nil {
			return nil, err
		}
		for index, event := range events {
			payload, marshalErr := json.Marshal(event)
			if marshalErr != nil {
				return nil, fmt.Errorf("encode SQL audit JSON export: %w", marshalErr)
			}
			if index > 0 {
				if _, err := output.Write([]byte{','}); err != nil {
					return nil, err
				}
			}
			if _, err := output.Write(payload); err != nil {
				return nil, err
			}
		}
		if _, err := output.Write([]byte("]\n")); err != nil {
			return nil, err
		}
		return output.Bytes(), nil

	case "csv":
		output := newBoundedBuffer(byteLimit)
		writer := csv.NewWriter(output)
		if err := writer.Write(exportCSVHeader); err != nil {
			return nil, fmt.Errorf("write SQL audit CSV header: %w", err)
		}
		for _, event := range events {
			if err := writer.Write(eventCSVRecord(event)); err != nil {
				return nil, fmt.Errorf("write SQL audit CSV event: %w", err)
			}
		}
		writer.Flush()
		if err := writer.Error(); err != nil {
			return nil, fmt.Errorf("flush SQL audit CSV export: %w", err)
		}
		return output.Bytes(), nil
	}
	return nil, fmt.Errorf("%w: %s", ErrUnsupportedExportFormat, format)
}

func (s *Store) loadExportEvents(filter Filter, recordLimit int64, byteLimit int) ([]Event, error) {
	where, args := buildFilterWhere(filter)
	var total int64
	if err := s.db.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM sql_audit_events`+where, args...,
	).Scan(&total); err != nil {
		return nil, fmt.Errorf("count SQL audit export events: %w", err)
	}
	if recordLimit > 0 && total > recordLimit {
		return nil, fmt.Errorf("%w: total=%d limit=%d", ErrExportRecordLimit, total, recordLimit)
	}
	rows, err := s.db.QueryContext(context.Background(), selectEventColumns+where+
		` ORDER BY timestamp DESC, sequence DESC`, args...)
	if err != nil {
		return nil, fmt.Errorf("query SQL audit export: %w", err)
	}
	events := make([]Event, 0, int(total))
	retainedStringBytes := 0
	for rows.Next() {
		if recordLimit > 0 && int64(len(events)) >= recordLimit {
			_ = rows.Close()
			return nil, fmt.Errorf("%w: limit=%d", ErrExportRecordLimit, recordLimit)
		}
		event, scanErr := scanEvent(rows)
		if scanErr != nil {
			_ = rows.Close()
			return nil, scanErr
		}
		retainedStringBytes += eventStringBytes(event)
		if byteLimit > 0 && retainedStringBytes > byteLimit {
			_ = rows.Close()
			return nil, fmt.Errorf("%w: limit=%d", ErrExportSizeLimit, byteLimit)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("iterate SQL audit export: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close SQL audit export rows: %w", err)
	}
	return events, nil
}

func eventStringBytes(event Event) int {
	return len(event.ID) + len(event.EventType) + len(event.Status) + len(event.ConnectionID) +
		len(event.ConnectionFingerprint) + len(event.DBType) + len(event.Database) + len(event.QueryID) +
		len(event.MCPRequestID) + len(event.MCPClient) + len(event.TransactionID) + len(event.Source) + len(event.UserName) + len(event.BoundaryMode) + len(event.CommitMode) +
		len(event.SQLText) + len(event.SQLFingerprint) + len(event.Error) + len(event.PrevHash) + len(event.Hash)
}

type boundedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func newBoundedBuffer(limit int) *boundedBuffer {
	return &boundedBuffer{limit: limit}
}

func (b *boundedBuffer) Write(payload []byte) (int, error) {
	if b.limit > 0 && b.buffer.Len()+len(payload) > b.limit {
		return 0, fmt.Errorf("%w: limit=%d", ErrExportSizeLimit, b.limit)
	}
	return b.buffer.Write(payload)
}

func (b *boundedBuffer) Bytes() []byte {
	return b.buffer.Bytes()
}

var exportCSVHeader = []string{
	"id", "sequence", "timestamp", "eventType", "status", "connectionId",
	"connectionFingerprint", "dbType", "database", "queryId", "transactionId",
	"source", "userName", "boundaryMode", "commitMode", "sqlText", "sqlRedacted",
	"sqlFingerprint", "statementIndex", "statementCount", "durationMs",
	"rowsAffected", "rowsReturned", "error", "prevHash", "hash", "mcpRequestId", "mcpClient",
}

func eventCSVRecord(event Event) []string {
	return protectCSVRecord([]string{
		event.ID,
		strconv.FormatInt(event.Sequence, 10),
		strconv.FormatInt(event.Timestamp, 10),
		event.EventType,
		event.Status,
		event.ConnectionID,
		event.ConnectionFingerprint,
		event.DBType,
		event.Database,
		event.QueryID,
		event.TransactionID,
		event.Source,
		event.UserName,
		event.BoundaryMode,
		event.CommitMode,
		event.SQLText,
		strconv.FormatBool(event.SQLRedacted),
		event.SQLFingerprint,
		strconv.Itoa(event.StatementIndex),
		strconv.Itoa(event.StatementCount),
		strconv.FormatInt(event.DurationMs, 10),
		strconv.FormatInt(event.RowsAffected, 10),
		strconv.FormatInt(event.RowsReturned, 10),
		event.Error,
		event.PrevHash,
		event.Hash,
		event.MCPRequestID,
		event.MCPClient,
	})
}

func protectCSVRecord(record []string) []string {
	protected := make([]string, len(record))
	for index, cell := range record {
		protected[index] = protectCSVFormula(cell)
	}
	return protected
}

func protectCSVFormula(value string) string {
	trimmed := strings.TrimLeft(value, " \t\r\n")
	if trimmed == "" {
		return value
	}
	switch trimmed[0] {
	case '=', '+', '-', '@':
		return "'" + value
	default:
		return value
	}
}
