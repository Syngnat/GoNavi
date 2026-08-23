// Package requesttrace keeps a small, in-memory, privacy-preserving request
// timeline for support and troubleshooting. It deliberately stores summaries
// only: never request bodies, SQL text, result rows, connection URLs, or
// credentials.
package requesttrace

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"

	"GoNavi-Wails/internal/sqlaudit"
	"github.com/google/uuid"
)

var traceURLPattern = regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://[^\s"'<>]+`)

const (
	// DefaultCapacity bounds the lifetime and memory footprint of diagnostics.
	// Records are process-local and disappear when the runtime exits.
	DefaultCapacity = 200
	DefaultLimit    = 50
	MaxLimit        = 200

	// MaxMeasuredResponseBytes prevents trace accounting from serialising a
	// large result set merely to learn its exact size.
	MaxMeasuredResponseBytes int64 = 1 << 20
)

type Input struct {
	RequestID      string
	Entry          string
	Operation      string
	DataSourceType string
	DriverMode     string
	Deadline       time.Time
}

type Completion struct {
	Status             string
	ErrorKind          string
	ErrorMessage       string
	ResponseBytes      int64
	ResponseBytesExact bool
	Pagination         Pagination
}

type Filter struct {
	RequestID string `json:"requestId,omitempty"`
	Entry     string `json:"entry,omitempty"`
	Limit     int    `json:"limit,omitempty"`
}

type Page struct {
	Items []Trace `json:"items"`
	Total int     `json:"total"`
}

type Trace struct {
	RequestID      string       `json:"requestId"`
	Entry          string       `json:"entry"`
	Operation      string       `json:"operation"`
	DataSourceType string       `json:"dataSourceType,omitempty"`
	DriverMode     string       `json:"driverMode,omitempty"`
	StartedAt      int64        `json:"startedAt"`
	FinishedAt     int64        `json:"finishedAt,omitempty"`
	DurationMs     int64        `json:"durationMs,omitempty"`
	DeadlineAt     int64        `json:"deadlineAt,omitempty"`
	Status         string       `json:"status"`
	Cancellation   Cancellation `json:"cancellation"`
	ResponseBytes  int64        `json:"responseBytes,omitempty"`
	ResponseExact  bool         `json:"responseBytesExact"`
	Pagination     Pagination   `json:"pagination"`
	RetryCount     int          `json:"retryCount"`
	Error          *Error       `json:"error,omitempty"`
	Events         []Event      `json:"events"`
}

type Cancellation struct {
	Requested   bool  `json:"requested"`
	RequestedAt int64 `json:"requestedAt,omitempty"`
	// Accepted is nil before a cancellation attempt. A true value only means
	// the runtime forwarded cancellation to the operation; the final Outcome
	// makes clear whether the driver actually observed it.
	Accepted *bool  `json:"accepted,omitempty"`
	Outcome  string `json:"outcome"`
}

type Pagination struct {
	Mode            string `json:"mode,omitempty"`
	ResultSetCount  int    `json:"resultSetCount,omitempty"`
	ReturnedRows    int64  `json:"returnedRows,omitempty"`
	Truncated       bool   `json:"truncated,omitempty"`
	PageSize        int    `json:"pageSize,omitempty"`
	ContinuationKey bool   `json:"continuationKey,omitempty"`
}

type Error struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

type Event struct {
	Timestamp int64             `json:"timestamp"`
	Name      string            `json:"name"`
	Details   map[string]string `json:"details,omitempty"`
}

type Store struct {
	mu       sync.RWMutex
	capacity int
	items    map[string]Trace
	order    []string
}

type Handle struct {
	store     *Store
	requestID string
}

type contextKey struct{}

func NewStore(capacity int) *Store {
	if capacity <= 0 {
		capacity = DefaultCapacity
	}
	return &Store{
		capacity: capacity,
		items:    make(map[string]Trace),
	}
}

func WithContext(ctx context.Context, handle *Handle) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if handle == nil {
		return ctx
	}
	return context.WithValue(ctx, contextKey{}, handle)
}

func FromContext(ctx context.Context) *Handle {
	if ctx == nil {
		return nil
	}
	handle, _ := ctx.Value(contextKey{}).(*Handle)
	return handle
}

func (s *Store) Start(input Input) *Handle {
	if s == nil {
		return nil
	}
	now := time.Now()
	requestID := sanitizeLabel(input.RequestID, 256)
	if requestID == "" {
		requestID = uuid.NewString()
	}
	trace := Trace{
		RequestID:      requestID,
		Entry:          sanitizeLabel(input.Entry, 64),
		Operation:      sanitizeLabel(input.Operation, 160),
		DataSourceType: sanitizeLabel(input.DataSourceType, 64),
		DriverMode:     sanitizeLabel(input.DriverMode, 64),
		StartedAt:      now.UnixMilli(),
		Status:         "running",
		Cancellation:   Cancellation{Outcome: "not_requested"},
		Events: []Event{{
			Timestamp: now.UnixMilli(),
			Name:      "request.started",
		}},
	}
	if !input.Deadline.IsZero() {
		trace.DeadlineAt = input.Deadline.UnixMilli()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.items[requestID]; exists {
		s.removeOrderLocked(requestID)
	}
	s.items[requestID] = trace
	s.order = append(s.order, requestID)
	for len(s.order) > s.capacity {
		oldest := s.order[0]
		s.order = s.order[1:]
		delete(s.items, oldest)
	}
	return &Handle{store: s, requestID: requestID}
}

func (h *Handle) ID() string {
	if h == nil {
		return ""
	}
	return h.requestID
}

func (h *Handle) SetRequestMetadata(dataSourceType string, driverMode string, deadline time.Time) {
	h.update(func(trace *Trace) {
		if value := sanitizeLabel(dataSourceType, 64); value != "" {
			trace.DataSourceType = value
		}
		if value := sanitizeLabel(driverMode, 64); value != "" {
			trace.DriverMode = value
		}
		if !deadline.IsZero() {
			trace.DeadlineAt = deadline.UnixMilli()
		}
	})
}

func (h *Handle) AddEvent(name string, details map[string]string) {
	name = sanitizeLabel(name, 96)
	if name == "" {
		return
	}
	h.update(func(trace *Trace) {
		trace.Events = append(trace.Events, Event{
			Timestamp: time.Now().UnixMilli(),
			Name:      name,
			Details:   sanitizeDetails(details),
		})
	})
}

func (h *Handle) MarkRetry(reason string) {
	h.update(func(trace *Trace) {
		trace.RetryCount++
		trace.Events = append(trace.Events, Event{
			Timestamp: time.Now().UnixMilli(),
			Name:      "retry.scheduled",
			Details:   sanitizeDetails(map[string]string{"reason": reason}),
		})
	})
}

func (h *Handle) MarkCancellation(accepted bool) {
	h.update(func(trace *Trace) {
		now := time.Now().UnixMilli()
		trace.Cancellation.Requested = true
		trace.Cancellation.RequestedAt = now
		trace.Cancellation.Accepted = boolPointer(accepted)
		if accepted {
			trace.Cancellation.Outcome = "forwarded"
		} else {
			trace.Cancellation.Outcome = "not_accepted"
		}
		trace.Events = append(trace.Events, Event{
			Timestamp: now,
			Name:      "cancellation.requested",
			Details: map[string]string{
				"accepted": boolString(accepted),
			},
		})
	})
}

func (h *Handle) Complete(completion Completion) {
	h.update(func(trace *Trace) {
		now := time.Now()
		trace.FinishedAt = now.UnixMilli()
		trace.DurationMs = maxInt64(0, trace.FinishedAt-trace.StartedAt)
		applyCompletion(trace, completion, true)
		if trace.Cancellation.Requested {
			switch {
			case trace.Cancellation.Accepted == nil:
				trace.Cancellation.Outcome = "not_accepted"
			case !*trace.Cancellation.Accepted:
				trace.Cancellation.Outcome = "not_accepted"
			case trace.Status == "cancelled":
				trace.Cancellation.Outcome = "observed"
			default:
				trace.Cancellation.Outcome = "not_observed"
			}
		}
		trace.Events = append(trace.Events, Event{
			Timestamp: now.UnixMilli(),
			Name:      "request.completed",
			Details: map[string]string{
				"status": trace.Status,
			},
		})
	})
}

// RecordOperationOutcome retains the result of a nested operation without
// closing the request. This is needed when an entry point (for example MCP)
// owns the request lifecycle while the database layer owns the useful query
// outcome, including pagination and driver error classification.
func (h *Handle) RecordOperationOutcome(completion Completion) {
	h.update(func(trace *Trace) {
		now := time.Now()
		applyCompletion(trace, completion, false)
		trace.Events = append(trace.Events, Event{
			Timestamp: now.UnixMilli(),
			Name:      "operation.completed",
			Details: map[string]string{
				"status": trace.Status,
			},
		})
	})
}

func (s *Store) Get(requestID string) (Trace, bool) {
	if s == nil {
		return Trace{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	trace, exists := s.items[strings.TrimSpace(requestID)]
	if !exists {
		return Trace{}, false
	}
	return cloneTrace(trace), true
}

// MarkCancellation records the caller-facing result of a cancellation request
// without requiring the original handler to remain in memory.
func (s *Store) MarkCancellation(requestID string, accepted bool) {
	if s == nil || strings.TrimSpace(requestID) == "" {
		return
	}
	(&Handle{store: s, requestID: strings.TrimSpace(requestID)}).MarkCancellation(accepted)
}

func (s *Store) List(filter Filter) Page {
	page := Page{Items: []Trace{}}
	if s == nil {
		return page
	}
	requestID := strings.TrimSpace(filter.RequestID)
	entry := strings.ToLower(strings.TrimSpace(filter.Entry))
	limit := filter.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	if limit > MaxLimit {
		limit = MaxLimit
	}

	s.mu.RLock()
	defer s.mu.RUnlock()
	for index := len(s.order) - 1; index >= 0; index-- {
		trace, exists := s.items[s.order[index]]
		if !exists {
			continue
		}
		if requestID != "" && trace.RequestID != requestID {
			continue
		}
		if entry != "" && strings.ToLower(trace.Entry) != entry {
			continue
		}
		page.Total++
		if len(page.Items) < limit {
			page.Items = append(page.Items, cloneTrace(trace))
		}
	}
	return page
}

func MeasureJSON(value any, limit int64) (int64, bool) {
	if limit <= 0 {
		limit = MaxMeasuredResponseBytes
	}
	writer := &limitedCounter{limit: limit}
	err := json.NewEncoder(writer).Encode(value)
	if errors.Is(err, errMeasurementLimit) {
		return writer.n, false
	}
	if err != nil {
		return 0, false
	}
	return writer.n, true
}

func (h *Handle) update(apply func(*Trace)) {
	if h == nil || h.store == nil || apply == nil {
		return
	}
	h.store.mu.Lock()
	defer h.store.mu.Unlock()
	trace, exists := h.store.items[h.requestID]
	if !exists {
		return
	}
	apply(&trace)
	h.store.items[h.requestID] = trace
}

func applyCompletion(trace *Trace, completion Completion, preserveNestedFailure bool) {
	if trace == nil {
		return
	}
	nextStatus := normalizeStatus(completion.Status)
	preserveFailure := preserveNestedFailure &&
		(trace.Status == "error" || trace.Status == "cancelled") &&
		nextStatus == "success"
	if !preserveFailure {
		trace.Status = nextStatus
		if trace.Status == "error" {
			trace.Error = &Error{
				Kind:    sanitizeLabel(completion.ErrorKind, 64),
				Message: sanitizeTraceErrorMessage(completion.ErrorKind, completion.ErrorMessage),
			}
			if trace.Error.Kind == "" {
				trace.Error.Kind = "execution"
			}
		} else {
			trace.Error = nil
		}
	}
	if completion.ResponseBytes > 0 || trace.ResponseBytes == 0 {
		trace.ResponseBytes = completion.ResponseBytes
		trace.ResponseExact = completion.ResponseBytesExact
	}
	pagination := sanitizePagination(completion.Pagination)
	if hasPagination(pagination) || !hasPagination(trace.Pagination) {
		trace.Pagination = pagination
	}
}

func hasPagination(value Pagination) bool {
	return value.Mode != "" || value.ResultSetCount != 0 || value.ReturnedRows != 0 ||
		value.Truncated || value.PageSize != 0 || value.ContinuationKey
}

func (s *Store) removeOrderLocked(requestID string) {
	for index, value := range s.order {
		if value == requestID {
			s.order = append(s.order[:index], s.order[index+1:]...)
			return
		}
	}
}

func sanitizeDetails(details map[string]string) map[string]string {
	if len(details) == 0 {
		return nil
	}
	sanitized := make(map[string]string, len(details))
	for key, value := range details {
		key = sanitizeLabel(key, 64)
		if isSensitiveTraceDetailKey(key) {
			continue
		}
		value = sanitizeTraceDetailValue(value, 512)
		if key != "" && value != "" {
			sanitized[key] = value
		}
	}
	if len(sanitized) == 0 {
		return nil
	}
	return sanitized
}

func sanitizePagination(value Pagination) Pagination {
	value.Mode = sanitizeLabel(value.Mode, 48)
	if value.ResultSetCount < 0 {
		value.ResultSetCount = 0
	}
	if value.ReturnedRows < 0 {
		value.ReturnedRows = 0
	}
	if value.PageSize < 0 {
		value.PageSize = 0
	}
	return value
}

func sanitizeLabel(value string, maxRunes int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	value = sqlaudit.RedactError(value)
	if maxRunes > 0 {
		value = truncateRunes(value, maxRunes)
	}
	return strings.TrimSpace(value)
}

func sanitizeTraceDetailValue(value string, maxRunes int) string {
	value = sanitizeLabel(value, maxRunes)
	if value == "" {
		return ""
	}
	if traceURLPattern.MatchString(value) || looksLikeSQLPayload(value) {
		return "[redacted]"
	}
	return value
}

func isSensitiveTraceDetailKey(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "sql", "query", "statement", "body", "request", "response", "row", "rows", "url", "uri", "dsn", "password", "credential", "credentials", "secret", "token", "authorization", "connection":
		return true
	default:
		return false
	}
}

func looksLikeSQLPayload(value string) bool {
	lower := strings.ToLower(strings.TrimSpace(value))
	for _, prefix := range []string{
		"select ", "insert ", "update ", "delete ", "merge ", "with ", "create ", "alter ", "drop ", "truncate ", "grant ", "revoke ",
	} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}

func sanitizeTraceErrorMessage(kind string, message string) string {
	if strings.TrimSpace(message) == "" {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "cancelled":
		return "operation cancelled"
	case "policy":
		return "request denied by policy"
	case "connection":
		return "database connection failed"
	case "outcome_unknown":
		return "driver outcome could not be determined"
	case "rpc", "protocol":
		return "request dispatch failed; details redacted"
	case "tool":
		return "tool execution failed; details redacted"
	default:
		return "driver execution failed; details redacted"
	}
}

func cloneTrace(value Trace) Trace {
	clone := value
	clone.Events = make([]Event, len(value.Events))
	for index, event := range value.Events {
		clone.Events[index] = event
		if len(event.Details) > 0 {
			clone.Events[index].Details = make(map[string]string, len(event.Details))
			for key, detail := range event.Details {
				clone.Events[index].Details[key] = detail
			}
		}
	}
	if value.Cancellation.Accepted != nil {
		clone.Cancellation.Accepted = boolPointer(*value.Cancellation.Accepted)
	}
	if value.Error != nil {
		errorClone := *value.Error
		clone.Error = &errorClone
	}
	return clone
}

func normalizeStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "success", "error", "cancelled", "running":
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return "error"
	}
}

func truncateRunes(value string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	count := 0
	for index := range value {
		if count == maxRunes {
			return value[:index]
		}
		count++
	}
	return value
}

func boolPointer(value bool) *bool {
	return &value
}

func boolString(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

var errMeasurementLimit = errors.New("request trace response measurement limit reached")

type limitedCounter struct {
	n     int64
	limit int64
}

func (writer *limitedCounter) Write(data []byte) (int, error) {
	if writer.limit > 0 && writer.n+int64(len(data)) > writer.limit {
		writer.n = writer.limit
		return 0, errMeasurementLimit
	}
	writer.n += int64(len(data))
	return len(data), nil
}
