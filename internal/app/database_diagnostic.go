package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sort"
	"strings"
	"time"
	"unicode"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/requesttrace"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	databaseDiagnosticSchemaVersion = "gonavi-database-diagnostic-v1"
	databaseDiagnosticMaxTraces     = requesttrace.MaxLimit
)

// databaseDiagnosticExportPayload is intentionally text-only so the same
// privacy-reviewed package can be saved through the desktop dialog or downloaded
// by a browser/web runtime without a separate binary transport.
type databaseDiagnosticExportPayload struct {
	FileName string `json:"fileName"`
	MimeType string `json:"mimeType"`
	Content  string `json:"content"`
}

type databaseDiagnosticPackage struct {
	SchemaVersion        string                               `json:"schemaVersion"`
	GeneratedAt          int64                                `json:"generatedAt"`
	ReadOnly             bool                                 `json:"readOnly"`
	CollectionDurationMs int64                                `json:"collectionDurationMs"`
	Scope                databaseDiagnosticScope              `json:"scope"`
	Application          databaseDiagnosticApplication        `json:"application"`
	Connections          []databaseDiagnosticConnection       `json:"connections"`
	RequestTraces        []databaseDiagnosticRequestTrace     `json:"requestTraces"`
	RunningQueries       []databaseDiagnosticRunningQuery     `json:"runningQueries"`
	Transactions         []databaseDiagnosticTransaction      `json:"transactions"`
	SlowQuerySummaries   []databaseDiagnosticSlowQuerySummary `json:"slowQuerySummaries"`
	Sources              databaseDiagnosticSourceAvailability `json:"sources"`
}

type databaseDiagnosticPreview struct {
	ReadOnly                bool                                 `json:"readOnly"`
	Format                  string                               `json:"format"`
	Scope                   databaseDiagnosticScope              `json:"scope"`
	Redaction               databaseDiagnosticRedaction          `json:"redaction"`
	ConnectionCount         int                                  `json:"connectionCount"`
	RequestTraceCount       int                                  `json:"requestTraceCount"`
	RunningQueryCount       int                                  `json:"runningQueryCount"`
	PendingTransactionCount int                                  `json:"pendingTransactionCount"`
	SlowQuerySummaryCount   int                                  `json:"slowQuerySummaryCount"`
	Sources                 databaseDiagnosticSourceAvailability `json:"sources"`
}

type databaseDiagnosticScope struct {
	Included  []string                    `json:"included"`
	Excluded  []string                    `json:"excluded"`
	Redaction databaseDiagnosticRedaction `json:"redaction"`
}

type databaseDiagnosticRedaction struct {
	Credentials    string `json:"credentials"`
	DSN            string `json:"dsn"`
	SQLLiterals    string `json:"sqlLiterals"`
	BusinessValues string `json:"businessValues"`
	SensitivePaths string `json:"sensitivePaths"`
}

type databaseDiagnosticApplication struct {
	Version   string `json:"version"`
	BuildTime string `json:"buildTime,omitempty"`
	GOOS      string `json:"goos"`
	GOARCH    string `json:"goarch"`
}

type databaseDiagnosticConnection struct {
	DataSourceType           string                      `json:"dataSourceType"`
	DriverMode               string                      `json:"driverMode"`
	DriverVersion            string                      `json:"driverVersion"`
	State                    string                      `json:"state"`
	LastPingAt               int64                       `json:"lastPingAt,omitempty"`
	ConnectionTimeoutSeconds int                         `json:"connectionTimeoutSeconds"`
	QueryTimeoutSeconds      int                         `json:"queryTimeoutSeconds"`
	Transport                databaseDiagnosticTransport `json:"transport"`
	Pool                     databaseDiagnosticPool      `json:"pool"`
}

type databaseDiagnosticTransport struct {
	SSH        bool `json:"ssh"`
	Proxy      bool `json:"proxy"`
	HTTPTunnel bool `json:"httpTunnel"`
	TLS        bool `json:"tls"`
}

type databaseDiagnosticPool struct {
	State string                  `json:"state"`
	Stats *db.DiagnosticPoolStats `json:"stats,omitempty"`
}

type databaseDiagnosticRequestTrace struct {
	QueryID             string `json:"queryId"`
	DataSourceType      string `json:"dataSourceType"`
	DriverMode          string `json:"driverMode"`
	Status              string `json:"status"`
	ErrorKind           string `json:"errorKind,omitempty"`
	CancellationOutcome string `json:"cancellationOutcome"`
	StartedAt           int64  `json:"startedAt"`
	FinishedAt          int64  `json:"finishedAt,omitempty"`
	DeadlineAt          int64  `json:"deadlineAt,omitempty"`
	DurationMs          int64  `json:"durationMs,omitempty"`
	RetryCount          int    `json:"retryCount"`
	ResponseBytes       int64  `json:"responseBytes,omitempty"`
	ResponseExact       bool   `json:"responseBytesExact"`
	ResultSetCount      int    `json:"resultSetCount,omitempty"`
	ReturnedRows        int64  `json:"returnedRows,omitempty"`
	Truncated           bool   `json:"truncated,omitempty"`
}

type databaseDiagnosticRunningQuery struct {
	QueryID           string `json:"queryId"`
	State             string `json:"state"`
	StartedAt         int64  `json:"startedAt"`
	AgeMs             int64  `json:"ageMs"`
	CancellationState string `json:"cancellationState"`
}

type databaseDiagnosticTransaction struct {
	TransactionID  string `json:"transactionId"`
	State          string `json:"state"`
	DataSourceType string `json:"dataSourceType"`
	BoundaryMode   string `json:"boundaryMode"`
	StartedAt      int64  `json:"startedAt"`
	AgeMs          int64  `json:"ageMs"`
}

type databaseDiagnosticSlowQuerySummary struct {
	DataSourceType    string `json:"dataSourceType"`
	RecordCount       int    `json:"recordCount"`
	LongestDurationMs int64  `json:"longestDurationMs"`
	MaxRowsRead       int64  `json:"maxRowsRead"`
	MaxRowsReturned   int64  `json:"maxRowsReturned"`
	LatestAt          int64  `json:"latestAt,omitempty"`
}

type databaseDiagnosticSourceAvailability struct {
	ConnectionState  string                        `json:"connectionState"`
	DriverTypes      []string                      `json:"driverTypes"`
	RequestTraces    string                        `json:"requestTraces"`
	SlowQueryHistory string                        `json:"slowQueryHistory"`
	SQLAudit         databaseDiagnosticAuditStatus `json:"sqlAudit"`
	Logs             string                        `json:"logs"`
	AISnapshot       string                        `json:"aiSnapshot"`
	MetadataTiming   string                        `json:"metadataTiming"`
}

type databaseDiagnosticAuditStatus struct {
	State         string `json:"state"`
	DroppedEvents int64  `json:"droppedEvents"`
	LastSuccessAt int64  `json:"lastSuccessAt,omitempty"`
	LastFailureAt int64  `json:"lastFailureAt,omitempty"`
}

type databaseDiagnosticCachedConnection struct {
	config   connection.ConnectionConfig
	instance db.Database
	lastPing time.Time
}

// GetDatabaseDiagnosticPackagePreview describes the exact safe collection scope
// before an export is generated. It does not open a database connection or
// create any history/audit storage.
func (a *App) GetDatabaseDiagnosticPackagePreview() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is unavailable"}
	}
	snapshot := a.databaseDiagnosticSnapshot()
	return connection.QueryResult{
		Success: true,
		Data: databaseDiagnosticPreview{
			ReadOnly:                true,
			Format:                  "json",
			Scope:                   snapshot.Scope,
			Redaction:               snapshot.Scope.Redaction,
			ConnectionCount:         len(snapshot.Connections),
			RequestTraceCount:       len(snapshot.RequestTraces),
			RunningQueryCount:       len(snapshot.RunningQueries),
			PendingTransactionCount: len(snapshot.Transactions),
			SlowQuerySummaryCount:   len(snapshot.SlowQuerySummaries),
			Sources:                 snapshot.Sources,
		},
	}
}

// BuildDatabaseDiagnosticPackage builds a self-describing, privacy-preserving
// JSON package. The operation is read-only: it snapshots existing in-memory
// state and reads slow-query files without opening a connection, creating a
// lock, or modifying the source files.
func (a *App) BuildDatabaseDiagnosticPackage() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is unavailable"}
	}
	snapshot := a.databaseDiagnosticSnapshot()
	content, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Data: databaseDiagnosticExportPayload{
			FileName: fmt.Sprintf("gonavi-database-diagnostics-%s.json", time.Now().Format("20060102-150405")),
			MimeType: "application/json;charset=utf-8",
			Content:  string(content),
		},
	}
}

// ExportDatabaseDiagnosticPackage writes the same package through the desktop
// save dialog. Web callers should use BuildDatabaseDiagnosticPackage and
// download its text payload in the browser.
func (a *App) ExportDatabaseDiagnosticPackage() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is unavailable"}
	}
	if a.webRuntime {
		return connection.QueryResult{
			Success: false,
			Message: "desktop file export is unavailable in web runtime; use BuildDatabaseDiagnosticPackage",
		}
	}
	built := a.BuildDatabaseDiagnosticPackage()
	if !built.Success {
		return built
	}
	payload, ok := built.Data.(databaseDiagnosticExportPayload)
	if !ok {
		return connection.QueryResult{Success: false, Message: "database diagnostic export payload is unavailable"}
	}
	target, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           "Export database diagnostics",
		DefaultFilename: payload.FileName,
		Filters: []runtime.FileFilter{{
			DisplayName: "JSON",
			Pattern:     "*.json",
		}},
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(target) == "" {
		return connection.QueryResult{Success: false, Message: "cancelled"}
	}
	target, err = a.resolveExportDialogTargetPath(target, "json")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := a.validateDatabaseDiagnosticExportTarget(target); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := writeDatabaseDiagnosticPackageAtomically(target, []byte(payload.Content)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: map[string]string{"path": target}}
}

func (a *App) databaseDiagnosticSnapshot() databaseDiagnosticPackage {
	startedAt := time.Now()
	connections := a.databaseDiagnosticCachedConnections()
	requestTraces := databaseDiagnosticTraceSummaries(a.requestDiagnostics().List(requesttrace.Filter{
		Limit: databaseDiagnosticMaxTraces,
	}).Items)
	runningQueries := a.databaseDiagnosticRunningQueries(startedAt)
	transactions := a.databaseDiagnosticTransactions(startedAt)
	slowQueries := a.databaseDiagnosticSlowQuerySummaries(connections)
	auditHealth := a.sqlAuditHealthSnapshot()

	result := databaseDiagnosticPackage{
		SchemaVersion: databaseDiagnosticSchemaVersion,
		GeneratedAt:   startedAt.UnixMilli(),
		ReadOnly:      true,
		Scope:         defaultDatabaseDiagnosticScope(),
		Application: databaseDiagnosticApplication{
			Version:   getCurrentVersion(),
			BuildTime: strings.TrimSpace(AppBuildTime),
			GOOS:      goruntime.GOOS,
			GOARCH:    goruntime.GOARCH,
		},
		Connections:        databaseDiagnosticConnectionSummaries(connections),
		RequestTraces:      requestTraces,
		RunningQueries:     runningQueries,
		Transactions:       transactions,
		SlowQuerySummaries: slowQueries,
		Sources: databaseDiagnosticSourceAvailability{
			ConnectionState:  databaseDiagnosticConnectionState(connections),
			DriverTypes:      databaseDiagnosticDriverTypes(connections),
			RequestTraces:    "included_redacted_summary",
			SlowQueryHistory: databaseDiagnosticSlowQuerySourceState(slowQueries),
			SQLAudit: databaseDiagnosticAuditStatus{
				State:         databaseDiagnosticAuditState(auditHealth.Status),
				DroppedEvents: maxDiagnosticInt64(0, auditHealth.DroppedEvents),
				LastSuccessAt: maxDiagnosticInt64(0, auditHealth.LastSuccessAt),
				LastFailureAt: maxDiagnosticInt64(0, auditHealth.LastFailureAt),
			},
			Logs:           "excluded_privacy_boundary",
			AISnapshot:     "excluded_privacy_boundary",
			MetadataTiming: "not_collected_no_database_operation",
		},
	}
	result.CollectionDurationMs = maxDiagnosticInt64(0, time.Since(startedAt).Milliseconds())
	return result
}

func defaultDatabaseDiagnosticScope() databaseDiagnosticScope {
	return databaseDiagnosticScope{
		Included: []string{
			"application version and runtime",
			"active connection summaries and database/sql pool counters when available",
			"bounded request trace summaries with query IDs, cancellation outcome, and error class",
			"running-query and pending-transaction state",
			"slow-query aggregate metrics without SQL text",
			"SQL audit health counters without audit events",
		},
		Excluded: []string{
			"credentials, tokens, and authorization headers",
			"DSN, URI, host, port, username, database name, and connection identifiers",
			"SQL text, SQL literals, result rows, and business values",
			"local paths and raw log/error payloads",
			"AI provider configuration and snapshots",
		},
		Redaction: databaseDiagnosticRedaction{
			Credentials:    "excluded",
			DSN:            "excluded",
			SQLLiterals:    "excluded",
			BusinessValues: "excluded",
			SensitivePaths: "excluded",
		},
	}
}

func (a *App) databaseDiagnosticCachedConnections() []databaseDiagnosticCachedConnection {
	if a == nil {
		return nil
	}
	a.mu.RLock()
	items := make([]databaseDiagnosticCachedConnection, 0, len(a.dbCache))
	for _, entry := range a.dbCache {
		items = append(items, databaseDiagnosticCachedConnection{
			config:   entry.config,
			instance: entry.inst,
			lastPing: entry.lastPing,
		})
	}
	a.mu.RUnlock()
	sort.Slice(items, func(left, right int) bool {
		return databaseDiagnosticDataSourceType(items[left].config.Type) < databaseDiagnosticDataSourceType(items[right].config.Type)
	})
	return items
}

func databaseDiagnosticConnectionSummaries(items []databaseDiagnosticCachedConnection) []databaseDiagnosticConnection {
	summaries := make([]databaseDiagnosticConnection, 0, len(items))
	for _, item := range items {
		pool := databaseDiagnosticPool{State: "unavailable"}
		if stats, available := db.DatabasePoolStats(item.instance); available {
			pool.State = "available"
			pool.Stats = &stats
		}
		lastPingAt := int64(0)
		if !item.lastPing.IsZero() {
			lastPingAt = item.lastPing.UnixMilli()
		}
		summaries = append(summaries, databaseDiagnosticConnection{
			DataSourceType:           databaseDiagnosticDataSourceType(item.config.Type),
			DriverMode:               databaseDiagnosticDriverMode(requestTraceDriverMode(item.config)),
			DriverVersion:            "not_collected",
			State:                    "cached",
			LastPingAt:               lastPingAt,
			ConnectionTimeoutSeconds: maxDiagnosticInt(item.config.Timeout),
			QueryTimeoutSeconds:      maxDiagnosticInt(item.config.QueryTimeout),
			Transport: databaseDiagnosticTransport{
				SSH:        item.config.UseSSH,
				Proxy:      item.config.UseProxy,
				HTTPTunnel: item.config.UseHTTPTunnel,
				TLS:        item.config.UseSSL || strings.EqualFold(strings.TrimSpace(item.config.SSLMode), "required"),
			},
			Pool: pool,
		})
	}
	return summaries
}

func databaseDiagnosticTraceSummaries(traces []requesttrace.Trace) []databaseDiagnosticRequestTrace {
	summaries := make([]databaseDiagnosticRequestTrace, 0, len(traces))
	for _, trace := range traces {
		errorKind := ""
		if trace.Error != nil {
			errorKind = databaseDiagnosticErrorKind(trace.Error.Kind)
		}
		summaries = append(summaries, databaseDiagnosticRequestTrace{
			QueryID:             databaseDiagnosticIdentifier(trace.RequestID),
			DataSourceType:      databaseDiagnosticDataSourceType(trace.DataSourceType),
			DriverMode:          databaseDiagnosticDriverMode(trace.DriverMode),
			Status:              databaseDiagnosticTraceStatus(trace.Status),
			ErrorKind:           errorKind,
			CancellationOutcome: databaseDiagnosticCancellationOutcome(trace.Cancellation.Outcome),
			StartedAt:           maxDiagnosticInt64(0, trace.StartedAt),
			FinishedAt:          maxDiagnosticInt64(0, trace.FinishedAt),
			DeadlineAt:          maxDiagnosticInt64(0, trace.DeadlineAt),
			DurationMs:          maxDiagnosticInt64(0, trace.DurationMs),
			RetryCount:          maxDiagnosticInt(trace.RetryCount),
			ResponseBytes:       maxDiagnosticInt64(0, trace.ResponseBytes),
			ResponseExact:       trace.ResponseExact,
			ResultSetCount:      maxDiagnosticInt(trace.Pagination.ResultSetCount),
			ReturnedRows:        maxDiagnosticInt64(0, trace.Pagination.ReturnedRows),
			Truncated:           trace.Pagination.Truncated,
		})
	}
	return summaries
}

func (a *App) databaseDiagnosticRunningQueries(now time.Time) []databaseDiagnosticRunningQuery {
	a.queryMu.Lock()
	items := make([]databaseDiagnosticRunningQuery, 0, len(a.runningQueries))
	for queryID, query := range a.runningQueries {
		startedAt := int64(0)
		age := int64(0)
		if !query.started.IsZero() {
			startedAt = query.started.UnixMilli()
			age = maxDiagnosticInt64(0, now.Sub(query.started).Milliseconds())
		}
		cancellationState := "supported"
		if query.cancellationUnsupported {
			cancellationState = "unsupported"
		}
		items = append(items, databaseDiagnosticRunningQuery{
			QueryID:           databaseDiagnosticIdentifier(queryID),
			State:             "running",
			StartedAt:         startedAt,
			AgeMs:             age,
			CancellationState: cancellationState,
		})
	}
	a.queryMu.Unlock()
	sort.Slice(items, func(left, right int) bool { return items[left].QueryID < items[right].QueryID })
	return items
}

func (a *App) databaseDiagnosticTransactions(now time.Time) []databaseDiagnosticTransaction {
	a.sqlTransactionMu.Lock()
	transactions := make([]*managedSQLTransaction, 0, len(a.sqlTransactions))
	for _, transaction := range a.sqlTransactions {
		transactions = append(transactions, transaction)
	}
	a.sqlTransactionMu.Unlock()

	items := make([]databaseDiagnosticTransaction, 0, len(transactions))
	for _, transaction := range transactions {
		if transaction == nil {
			continue
		}
		transaction.mu.Lock()
		id := transaction.id
		dbType := transaction.dbType
		boundaryMode := transaction.boundaryMode
		createdAt := transaction.createdAt
		finished := transaction.finished
		transaction.mu.Unlock()

		startedAt := int64(0)
		age := int64(0)
		if !createdAt.IsZero() {
			startedAt = createdAt.UnixMilli()
			age = maxDiagnosticInt64(0, now.Sub(createdAt).Milliseconds())
		}
		state := "pending"
		if finished {
			state = "finished"
		}
		items = append(items, databaseDiagnosticTransaction{
			TransactionID:  databaseDiagnosticIdentifier(id),
			State:          state,
			DataSourceType: databaseDiagnosticDataSourceType(dbType),
			BoundaryMode:   databaseDiagnosticBoundaryMode(boundaryMode),
			StartedAt:      startedAt,
			AgeMs:          age,
		})
	}
	sort.Slice(items, func(left, right int) bool { return items[left].TransactionID < items[right].TransactionID })
	return items
}

func (a *App) databaseDiagnosticSlowQuerySummaries(items []databaseDiagnosticCachedConnection) []databaseDiagnosticSlowQuerySummary {
	type aggregate struct {
		recordCount   int
		longest       int64
		maxRowsRead   int64
		maxRowsReturn int64
		latestAt      int64
	}
	byType := make(map[string]*aggregate)
	for _, item := range items {
		dataSourceType := databaseDiagnosticDataSourceType(item.config.Type)
		records := a.databaseDiagnosticReadQueryHistory(item.config)
		if len(records) == 0 {
			continue
		}
		current := byType[dataSourceType]
		if current == nil {
			current = &aggregate{}
			byType[dataSourceType] = current
		}
		for _, record := range records {
			current.recordCount++
			current.longest = maxDiagnosticInt64(current.longest, maxDiagnosticInt64(record.DurationMs, record.MaxDurationMs))
			current.maxRowsRead = maxDiagnosticInt64(current.maxRowsRead, record.RowsRead)
			current.maxRowsReturn = maxDiagnosticInt64(current.maxRowsReturn, record.RowsReturned)
			if record.ExecutedAt.UnixMilli() > current.latestAt {
				current.latestAt = record.ExecutedAt.UnixMilli()
			}
		}
	}
	result := make([]databaseDiagnosticSlowQuerySummary, 0, len(byType))
	for dataSourceType, current := range byType {
		result = append(result, databaseDiagnosticSlowQuerySummary{
			DataSourceType:    dataSourceType,
			RecordCount:       current.recordCount,
			LongestDurationMs: current.longest,
			MaxRowsRead:       current.maxRowsRead,
			MaxRowsReturned:   current.maxRowsReturn,
			LatestAt:          current.latestAt,
		})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].DataSourceType < result[right].DataSourceType })
	return result
}

// databaseDiagnosticReadQueryHistory intentionally avoids queryHistoryStore.LoadAll:
// LoadAll creates a directory and lock file. Package generation must remain
// side-effect free even when a connection has no history yet.
func (a *App) databaseDiagnosticReadQueryHistory(config connection.ConnectionConfig) []connection.QueryExecutionRecord {
	if a == nil {
		return nil
	}
	fingerprints, ok := queryHistoryConnectionFingerprints(config, config.Database)
	if !ok {
		return nil
	}
	seenPaths := make(map[string]struct{}, len(fingerprints))
	records := make([]connection.QueryExecutionRecord, 0)
	for _, fingerprint := range fingerprints {
		store := newQueryHistoryStore(a.configDir, fingerprint)
		if _, exists := seenPaths[store.filePath]; exists {
			continue
		}
		seenPaths[store.filePath] = struct{}{}
		records = append(records, decodeQueryHistorySnapshots(databaseDiagnosticReadHistoryFiles(store))...)
	}
	return dedupeRawQueryHistoryRecords(records)
}

func databaseDiagnosticReadHistoryFiles(store *queryHistoryStore) [][]byte {
	if store == nil {
		return nil
	}
	snapshots := make([][]byte, 0, 2)
	for _, path := range []string{store.filePath + ".1", store.filePath} {
		payload, err := os.ReadFile(path)
		if err == nil {
			snapshots = append(snapshots, payload)
		}
	}
	return snapshots
}

func databaseDiagnosticSlowQuerySourceState(items []databaseDiagnosticSlowQuerySummary) string {
	if len(items) == 0 {
		return "not_available"
	}
	return "included_aggregate_only"
}

func databaseDiagnosticConnectionState(items []databaseDiagnosticCachedConnection) string {
	switch len(items) {
	case 0:
		return "no_connection"
	case 1:
		return "connected"
	default:
		if len(databaseDiagnosticDriverTypes(items)) > 1 {
			return "multiple_drivers"
		}
		return "multiple_connections"
	}
}

func databaseDiagnosticDriverTypes(items []databaseDiagnosticCachedConnection) []string {
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		seen[databaseDiagnosticDataSourceType(item.config.Type)] = struct{}{}
	}
	result := make([]string, 0, len(seen))
	for driverType := range seen {
		result = append(result, driverType)
	}
	sort.Strings(result)
	return result
}

func databaseDiagnosticAuditState(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), sqlAuditHealthStatusDegraded) {
		return sqlAuditHealthStatusDegraded
	}
	return sqlAuditHealthStatusHealthy
}

func databaseDiagnosticDataSourceType(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || len(value) > 64 || databaseDiagnosticHasSensitiveHint(value) {
		return "unknown"
	}
	for _, character := range value {
		if !(unicode.IsLetter(character) || unicode.IsDigit(character) || character == '-' || character == '_' || character == '.') {
			return "unknown"
		}
	}
	return value
}

func databaseDiagnosticDriverMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "builtin", "builtin-over-ssh", "builtin-over-http-tunnel", "builtin-over-proxy", "custom-driver":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "unknown"
	}
}

func databaseDiagnosticTraceStatus(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "running", "success", "error", "cancelled":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "unknown"
	}
}

func databaseDiagnosticErrorKind(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "cancelled", "execution", "connection", "outcome_unknown", "policy", "rpc", "protocol", "tool":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "other"
	}
}

func databaseDiagnosticCancellationOutcome(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "not_requested", "forwarded", "observed", "not_observed", "not_accepted":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "unknown"
	}
}

func databaseDiagnosticBoundaryMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "driver_api", "text_sql", "implicit":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "unknown"
	}
}

func databaseDiagnosticIdentifier(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if databaseDiagnosticSafeGeneratedID(value) {
		return value
	}
	digest := sha256.Sum256([]byte(value))
	return "redacted-" + hex.EncodeToString(digest[:8])
}

func databaseDiagnosticSafeGeneratedID(value string) bool {
	lower := strings.ToLower(value)
	validPrefix := false
	for _, prefix := range []string{"query-", "request-", "transaction-", "tx-"} {
		if strings.HasPrefix(lower, prefix) {
			value = value[len(prefix):]
			validPrefix = true
			break
		}
	}
	if !validPrefix || len(value) != 36 {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return false
			}
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
}

func databaseDiagnosticHasSensitiveHint(value string) bool {
	for _, hint := range []string{"password", "secret", "token", "credential", "authorization", "dsn", "uri", "url"} {
		if strings.Contains(value, hint) {
			return true
		}
	}
	return false
}

func maxDiagnosticInt(value int) int {
	if value < 0 {
		return 0
	}
	return value
}

func maxDiagnosticInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func (a *App) validateDatabaseDiagnosticExportTarget(target string) error {
	if a == nil || strings.TrimSpace(a.configDir) == "" {
		return nil
	}
	targetPath, err := resolveSQLAuditComparisonPath(target)
	if err != nil {
		return err
	}
	configPath, err := resolveSQLAuditComparisonPath(a.configDir)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(configPath, targetPath)
	if err != nil {
		return err
	}
	if relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
		return fmt.Errorf("database diagnostic export target cannot be inside application storage")
	}
	return nil
}

func writeDatabaseDiagnosticPackageAtomically(target string, content []byte) error {
	return writeSQLAuditExportAtomically(target, content)
}
