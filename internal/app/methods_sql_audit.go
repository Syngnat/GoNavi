package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const sqlAuditFingerprintVersion = "sql-audit-connection-v1"

var errSQLAuditTemporarilyUnavailable = errors.New("SQL audit store is temporarily unavailable during data-root switching")

var replaceSQLAuditFile = atomicReplaceSQLAuditFile

var closeSQLAuditStoreHandle = func(store *sqlaudit.Store) error {
	return store.Close()
}

const (
	sqlAuditHealthStatusHealthy  = "healthy"
	sqlAuditHealthStatusDegraded = "degraded"
	webSQLAuditExportMaxRecords  = int64(10_000)
	webSQLAuditExportMaxBytes    = 8 * 1024 * 1024
)

type sqlAuditHealthState struct {
	Status         string `json:"status"`
	DroppedEvents  int64  `json:"droppedEvents"`
	FirstFailureAt int64  `json:"firstFailureAt"`
	LastFailureAt  int64  `json:"lastFailureAt"`
	LastSuccessAt  int64  `json:"lastSuccessAt"`
	LastError      string `json:"lastError"`
	// CaptureEnabled and CaptureMode are populated only for the API response.
	// Pointer + omitempty keeps the durable health sidecar independent from
	// settings while still representing an explicitly disabled capture state.
	CaptureEnabled *bool  `json:"captureEnabled,omitempty"`
	CaptureMode    string `json:"captureMode,omitempty"`
}

type sqlAuditPendingGap struct {
	DroppedEvents  int64
	FirstFailureAt int64
	LastFailureAt  int64
	LastError      string
}

type sqlAuditQueryInput struct {
	Config         connection.ConnectionConfig
	Database       string
	DBType         string
	QueryID        string
	SQL            string
	Source         string
	CommitMode     string
	Duration       time.Duration
	StatementCount int
	Result         connection.QueryResult
}

type sqlAuditTransactionEventInput struct {
	Config         connection.ConnectionConfig
	Database       string
	DBType         string
	QueryID        string
	TransactionID  string
	EventType      string
	Status         string
	Source         string
	CommitMode     string
	BoundaryMode   string
	SQL            string
	StatementIndex int
	StatementCount int
	ExecutedCount  int
	FailedIndex    int
	OutcomeUnknown bool
	Duration       time.Duration
	RowsAffected   int64
	RowsReturned   int64
	Err            error
}

type sqlAuditExportPayload struct {
	FileName string `json:"fileName"`
	MimeType string `json:"mimeType"`
	Content  string `json:"content"`
}

func (a *App) sqlAuditDatabasePath() string {
	return filepath.Join(a.auditRootDir(), "audit", "sql_audit.db")
}

func (a *App) sqlAuditHealthFilePath() string {
	return filepath.Join(a.auditRootDir(), "audit", "sql_audit_health.json")
}

func normalizeSQLAuditHealth(state sqlAuditHealthState) sqlAuditHealthState {
	state.CaptureEnabled = nil
	state.CaptureMode = ""
	if state.Status != sqlAuditHealthStatusDegraded {
		state.Status = sqlAuditHealthStatusHealthy
	}
	if state.DroppedEvents < 0 {
		state.DroppedEvents = 0
	}
	if state.FirstFailureAt < 0 {
		state.FirstFailureAt = 0
	}
	if state.LastFailureAt < 0 {
		state.LastFailureAt = 0
	}
	if state.LastSuccessAt < 0 {
		state.LastSuccessAt = 0
	}
	state.LastError = sqlaudit.RedactError(state.LastError)
	return state
}

func (a *App) loadSQLAuditHealth(path string, pendingGap sqlAuditPendingGap) {
	path = filepath.Clean(path)
	loaded := sqlAuditHealthState{Status: sqlAuditHealthStatusHealthy}
	payload, err := os.ReadFile(path)
	if err == nil {
		if decodeErr := json.Unmarshal(payload, &loaded); decodeErr != nil {
			loaded = sqlAuditHealthState{
				Status:         sqlAuditHealthStatusDegraded,
				DroppedEvents:  1,
				FirstFailureAt: time.Now().UnixMilli(),
				LastFailureAt:  time.Now().UnixMilli(),
				LastError:      "SQL audit health state could not be decoded",
			}
		}
	} else if !os.IsNotExist(err) {
		loaded = sqlAuditHealthState{
			Status:         sqlAuditHealthStatusDegraded,
			DroppedEvents:  1,
			FirstFailureAt: time.Now().UnixMilli(),
			LastFailureAt:  time.Now().UnixMilli(),
			LastError:      "SQL audit health state could not be read",
		}
	}
	loaded = normalizeSQLAuditHealth(loaded)

	// Carry only events actually dropped during the suspension. Historical state
	// belongs to the selected target root (whether migrated or pre-existing) and
	// must not be copied or max-merged from the previous root.
	a.sqlAuditHealthMu.Lock()
	if pendingGap.DroppedEvents > 0 {
		if loaded.Status != sqlAuditHealthStatusDegraded {
			loaded.Status = sqlAuditHealthStatusDegraded
			loaded.DroppedEvents = 0
			loaded.FirstFailureAt = pendingGap.FirstFailureAt
		} else if pendingGap.FirstFailureAt > 0 && (loaded.FirstFailureAt == 0 || pendingGap.FirstFailureAt < loaded.FirstFailureAt) {
			loaded.FirstFailureAt = pendingGap.FirstFailureAt
		}
		loaded.DroppedEvents += pendingGap.DroppedEvents
		if pendingGap.LastFailureAt >= loaded.LastFailureAt {
			loaded.LastFailureAt = pendingGap.LastFailureAt
			loaded.LastError = pendingGap.LastError
		}
	}
	a.sqlAuditHealth = normalizeSQLAuditHealth(loaded)
	a.sqlAuditHealthPath = path
	a.sqlAuditHealthRevision++
	snapshot := a.sqlAuditHealth
	a.sqlAuditHealthMu.Unlock()

	if snapshot.Status == sqlAuditHealthStatusDegraded {
		a.persistSQLAuditHealth(snapshot, path)
	}
}

func (a *App) persistSQLAuditHealth(state sqlAuditHealthState, path string) {
	state = normalizeSQLAuditHealth(state)
	payload, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		logger.Warnf("编码 SQL 审计健康状态失败：%v", err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		logger.Warnf("创建 SQL 审计健康状态目录失败：%v", err)
		return
	}
	if err := writeSQLAuditExportAtomically(path, append(payload, '\n')); err != nil {
		logger.Warnf("持久化 SQL 审计健康状态失败：%v", err)
	}
}

func (a *App) sqlAuditHealthSnapshot() sqlAuditHealthState {
	state, _ := a.sqlAuditHealthSnapshotWithRevision()
	return state
}

func (a *App) sqlAuditHealthSnapshotWithRevision() (sqlAuditHealthState, uint64) {
	a.sqlAuditHealthMu.RLock()
	defer a.sqlAuditHealthMu.RUnlock()
	return normalizeSQLAuditHealth(a.sqlAuditHealth), a.sqlAuditHealthRevision
}

// withSQLAuditStore serializes store lifecycle changes with operations. SQLite
// still owns record-level concurrency; this lock prevents a data-root switch
// from closing the handle between lookup and use.
func (a *App) withSQLAuditStore(requireRuntimeActive bool, operation func(*sqlaudit.Store) error) error {
	for {
		a.sqlAuditMu.RLock()
		if a.sqlAuditSuspended {
			a.sqlAuditMu.RUnlock()
			return errSQLAuditTemporarilyUnavailable
		}
		if requireRuntimeActive && !a.sqlAuditRuntimeActive {
			a.sqlAuditMu.RUnlock()
			return nil
		}
		path := filepath.Clean(a.sqlAuditDatabasePath())
		if a.sqlAuditStore != nil && filepath.Clean(a.sqlAuditStorePath) == path {
			var err error
			if operation != nil {
				err = operation(a.sqlAuditStore)
			}
			a.sqlAuditMu.RUnlock()
			return err
		}
		a.sqlAuditMu.RUnlock()

		a.sqlAuditMu.Lock()
		if a.sqlAuditSuspended {
			a.sqlAuditMu.Unlock()
			return errSQLAuditTemporarilyUnavailable
		}
		if requireRuntimeActive && !a.sqlAuditRuntimeActive {
			a.sqlAuditMu.Unlock()
			return nil
		}
		_, err := a.ensureSQLAuditStoreLocked()
		a.sqlAuditMu.Unlock()
		if err != nil {
			return err
		}
	}
}

func (a *App) ensureSQLAuditStoreLocked() (*sqlaudit.Store, error) {
	path := filepath.Clean(a.sqlAuditDatabasePath())
	if a.sqlAuditStore != nil && filepath.Clean(a.sqlAuditStorePath) == path {
		return a.sqlAuditStore, nil
	}
	if a.sqlAuditStore != nil {
		if err := a.sqlAuditStore.Close(); err != nil {
			logger.Warnf("关闭旧 SQL 审计存储失败：%v", err)
		}
		a.sqlAuditStore = nil
		a.sqlAuditStorePath = ""
	}
	store, err := sqlaudit.Open(path)
	if err != nil {
		return nil, err
	}
	a.sqlAuditStore = store
	a.sqlAuditStorePath = path
	return store, nil
}

func (a *App) activateSQLAudit() {
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	pendingGap := sqlAuditPendingGap{
		DroppedEvents:  a.sqlAuditSuspensionDropped,
		FirstFailureAt: a.sqlAuditSuspensionFirstAt,
		LastFailureAt:  a.sqlAuditSuspensionLastAt,
		LastError:      a.sqlAuditSuspensionLastError,
	}
	a.sqlAuditSuspensionDropped = 0
	a.sqlAuditSuspensionFirstAt = 0
	a.sqlAuditSuspensionLastAt = 0
	a.sqlAuditSuspensionLastError = ""

	a.sqlAuditMu.Lock()
	// Keep all appenders out until both the store and its persisted health state
	// have been restored for the current data root.
	a.sqlAuditRuntimeActive = false
	a.sqlAuditSuspended = true
	_, err := a.ensureSQLAuditStoreLocked()
	a.loadSQLAuditHealth(a.sqlAuditHealthFilePath(), pendingGap)
	if err != nil {
		// SQL execution remains fail-open; users can see the same error when opening
		// the audit center instead of losing the database operation itself.
		a.markSQLAuditFailure(0, err)
	}
	// Keep runtime auditing active even after an open failure so a later write can
	// retry opening the store and close the degraded state with a durable marker.
	a.sqlAuditRuntimeActive = true
	a.sqlAuditSuspended = false
	a.sqlAuditMu.Unlock()
	if err != nil {
		logger.Warnf("初始化 SQL 审计存储失败：%v", err)
	}
}

func (a *App) suspendSQLAudit() (bool, error) {
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	a.sqlAuditSuspensionDropped = 0
	a.sqlAuditSuspensionFirstAt = 0
	a.sqlAuditSuspensionLastAt = 0
	a.sqlAuditSuspensionLastError = ""
	a.sqlAuditMu.Lock()
	wasActive := a.sqlAuditRuntimeActive
	a.sqlAuditRuntimeActive = false
	a.sqlAuditSuspended = true
	var closeErr error
	if a.sqlAuditStore != nil {
		if closeErr = closeSQLAuditStoreHandle(a.sqlAuditStore); closeErr != nil {
			logger.Warnf("暂停 SQL 审计时 checkpoint/关闭存储失败：%v", closeErr)
		}
	}
	a.sqlAuditStore = nil
	a.sqlAuditStorePath = ""
	a.sqlAuditMu.Unlock()
	return wasActive, closeErr
}

func (a *App) resumeSQLAudit(wasActive bool) {
	if wasActive {
		a.activateSQLAudit()
		return
	}
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	a.sqlAuditMu.Lock()
	a.sqlAuditSuspended = false
	a.sqlAuditMu.Unlock()
}

func (a *App) closeSQLAuditStore() {
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	a.sqlAuditMu.Lock()
	defer a.sqlAuditMu.Unlock()
	a.sqlAuditRuntimeActive = false
	a.sqlAuditSuspended = true
	if a.sqlAuditStore == nil {
		return
	}
	if err := closeSQLAuditStoreHandle(a.sqlAuditStore); err != nil {
		logger.Warnf("关闭 SQL 审计存储失败：%v", err)
	}
	a.sqlAuditStore = nil
	a.sqlAuditStorePath = ""
}

func (a *App) recordSQLAuditQuery(input sqlAuditQueryInput) {
	status := sqlAuditStatusFromResult(input.Result)
	statementCount := input.StatementCount
	if statementCount <= 0 {
		statementCount = countSQLAuditStatements(input.DBType, input.SQL)
	}
	event := sqlaudit.Event{
		EventType:             "query",
		Status:                status,
		ConnectionID:          strings.TrimSpace(input.Config.ID),
		ConnectionFingerprint: buildSQLAuditConnectionFingerprint(input.Config, input.Database),
		DBType:                strings.ToLower(strings.TrimSpace(input.DBType)),
		Database:              resolveSQLAuditDatabase(input.Config, input.Database),
		QueryID:               strings.TrimSpace(input.QueryID),
		Source:                normalizeSQLAuditSource(input.Source),
		CommitMode:            normalizeSQLAuditCommitMode(input.CommitMode),
		BoundaryMode:          normalizeSQLAuditBoundaryMode(input.Result.BoundaryMode),
		SQLText:               input.SQL,
		StatementCount:        statementCount,
		ExecutedCount:         input.Result.ExecutedCount,
		FailedIndex:           input.Result.FailedIndex,
		OutcomeUnknown:        input.Result.OutcomeUnknown,
		DurationMs:            durationMilliseconds(input.Duration),
		RowsAffected:          sqlAuditRowsAffected(input.Result),
		RowsReturned:          queryResultRowsReturned(input.Result),
	}
	if status != "success" {
		event.Error = strings.TrimSpace(input.Result.Message)
	}
	a.appendSQLAuditEvent(event)
}

func (a *App) sqlAuditTransactionStatementObserver(
	config connection.ConnectionConfig,
	database string,
	dbType string,
	queryID string,
	transactionID string,
	boundaryMode string,
	events *[]sqlaudit.Event,
) managedSQLStatementObserver {
	return func(observation managedSQLStatementObservation) {
		input := sqlAuditTransactionEventInput{
			Config:         config,
			Database:       database,
			DBType:         dbType,
			QueryID:        queryID,
			TransactionID:  transactionID,
			EventType:      "transaction_statement",
			Status:         sqlAuditStatusFromError(observation.Err),
			Source:         "query_editor",
			CommitMode:     "pending",
			BoundaryMode:   boundaryMode,
			SQL:            observation.Statement,
			StatementIndex: observation.StatementIndex,
			StatementCount: observation.StatementCount,
			Duration:       observation.Duration,
			RowsAffected:   observation.RowsAffected,
			RowsReturned:   observation.RowsReturned,
			Err:            observation.Err,
		}
		event := buildSQLAuditTransactionEvent(input)
		if events == nil {
			a.appendSQLAuditEvent(event)
			return
		}
		*events = append(*events, event)
	}
}

func (a *App) recordSQLAuditTransactionEvent(input sqlAuditTransactionEventInput) {
	a.appendSQLAuditEvent(buildSQLAuditTransactionEvent(input))
}

func buildSQLAuditTransactionEvent(input sqlAuditTransactionEventInput) sqlaudit.Event {
	event := sqlaudit.Event{
		EventType:             strings.TrimSpace(input.EventType),
		Status:                normalizeSQLAuditStatus(input.Status),
		ConnectionID:          strings.TrimSpace(input.Config.ID),
		ConnectionFingerprint: buildSQLAuditConnectionFingerprint(input.Config, input.Database),
		DBType:                strings.ToLower(strings.TrimSpace(input.DBType)),
		Database:              resolveSQLAuditDatabase(input.Config, input.Database),
		QueryID:               strings.TrimSpace(input.QueryID),
		TransactionID:         strings.TrimSpace(input.TransactionID),
		Source:                normalizeSQLAuditSource(input.Source),
		CommitMode:            normalizeSQLAuditCommitMode(input.CommitMode),
		BoundaryMode:          normalizeSQLAuditBoundaryMode(input.BoundaryMode),
		SQLText:               input.SQL,
		StatementIndex:        input.StatementIndex,
		StatementCount:        input.StatementCount,
		ExecutedCount:         input.ExecutedCount,
		FailedIndex:           input.FailedIndex,
		OutcomeUnknown:        input.OutcomeUnknown,
		DurationMs:            durationMilliseconds(input.Duration),
		RowsAffected:          input.RowsAffected,
		RowsReturned:          input.RowsReturned,
	}
	if input.Err != nil {
		event.Error = input.Err.Error()
	}
	return event
}

func (a *App) appendSQLAuditEvent(event sqlaudit.Event) {
	a.appendSQLAuditEvents([]sqlaudit.Event{event})
}

func (a *App) appendSQLAuditEvents(events []sqlaudit.Event) {
	if len(events) == 0 {
		return
	}
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()

	health := a.sqlAuditHealthSnapshot()
	wasDegraded := health.Status == sqlAuditHealthStatusDegraded
	var gapEvent *sqlaudit.Event
	if wasDegraded {
		gap := buildSQLAuditGapEvent(health)
		gapEvent = &gap
	}

	auditDisabled := false
	gapWriteFailed := false
	err := a.withSQLAuditStore(true, func(store *sqlaudit.Store) error {
		if wasDegraded {
			settings, settingsErr := store.GetSettings()
			if settingsErr != nil {
				return settingsErr
			}
			if !settings.Enabled {
				auditDisabled = true
				return nil
			}
		}
		if appendErr := store.AppendBatch(events); appendErr != nil {
			return appendErr
		}
		if gapEvent != nil {
			// Keep the gap marker as the newest record. AppendBatch intentionally
			// retains only the configured tail, so prepending the marker to a large
			// transaction batch could otherwise evict it and falsely report recovery.
			if appendErr := store.Append(*gapEvent); appendErr != nil {
				gapWriteFailed = true
				return appendErr
			}
		}
		return nil
	})
	if err != nil {
		first := events[0]
		logger.Warnf(
			"写入 SQL 审计失败（已按 fail-open 保留数据库操作结果）：count=%d event=%s tx=%s query=%s err=%v",
			len(events),
			first.EventType,
			first.TransactionID,
			first.QueryID,
			err,
		)
		dropped := int64(len(events))
		if gapWriteFailed {
			// The current events were durable; only the marker failed. Preserve the
			// existing unresolved gap count without counting these events as lost.
			dropped = 0
		}
		a.markSQLAuditFailure(dropped, err)
		return
	}
	if auditDisabled {
		return
	}
	a.markSQLAuditSuccess(wasDegraded)
}

func buildSQLAuditGapEvent(health sqlAuditHealthState) sqlaudit.Event {
	message := "SQL audit storage recovered after a writer failure; no dropped-event count was available"
	if health.DroppedEvents > 0 {
		message = fmt.Sprintf(
			"SQL audit storage recovered after a persistence gap; %d event(s) were not persisted",
			health.DroppedEvents,
		)
	}
	return sqlaudit.Event{
		Timestamp: time.Now().UnixMilli(),
		EventType: "audit_gap",
		Status:    "error",
		Source:    "system",
		Error:     message,
	}
}

func (a *App) markSQLAuditFailure(dropped int64, auditErr error) {
	now := time.Now().UnixMilli()
	a.sqlAuditHealthMu.Lock()
	state := normalizeSQLAuditHealth(a.sqlAuditHealth)
	if state.Status != sqlAuditHealthStatusDegraded {
		state.Status = sqlAuditHealthStatusDegraded
		state.DroppedEvents = 0
		state.FirstFailureAt = now
	}
	if dropped > 0 {
		state.DroppedEvents += dropped
	}
	state.LastFailureAt = now
	if auditErr != nil {
		state.LastError = sqlaudit.RedactError(auditErr.Error())
	}
	if errors.Is(auditErr, errSQLAuditTemporarilyUnavailable) && dropped > 0 {
		// appendSQLAuditEvents and lifecycle transitions share sqlAuditAppendMu,
		// so these fields are a linear count of only the events lost while the
		// audit store was suspended for a data-root switch.
		if a.sqlAuditSuspensionDropped == 0 {
			a.sqlAuditSuspensionFirstAt = now
		}
		a.sqlAuditSuspensionDropped += dropped
		a.sqlAuditSuspensionLastAt = now
		a.sqlAuditSuspensionLastError = state.LastError
	}
	path := a.sqlAuditHealthPath
	if strings.TrimSpace(path) == "" {
		path = filepath.Clean(a.sqlAuditHealthFilePath())
	}
	a.sqlAuditHealth = state
	a.sqlAuditHealthPath = path
	a.sqlAuditHealthRevision++
	if !errors.Is(auditErr, errSQLAuditTemporarilyUnavailable) {
		a.persistSQLAuditHealth(state, path)
	}
	a.sqlAuditHealthMu.Unlock()
}

func (a *App) markSQLAuditSuccess(recovered bool) {
	now := time.Now().UnixMilli()
	a.sqlAuditHealthMu.Lock()
	state := normalizeSQLAuditHealth(a.sqlAuditHealth)
	state.LastSuccessAt = now
	if recovered {
		state.Status = sqlAuditHealthStatusHealthy
		state.LastError = ""
	}
	path := a.sqlAuditHealthPath
	if strings.TrimSpace(path) == "" {
		path = filepath.Clean(a.sqlAuditHealthFilePath())
		a.sqlAuditHealthPath = path
	}
	a.sqlAuditHealth = state
	if recovered {
		a.sqlAuditHealthRevision++
	}
	if recovered {
		a.persistSQLAuditHealth(state, path)
	}
	a.sqlAuditHealthMu.Unlock()
}

func buildSQLAuditConnectionFingerprint(config connection.ConnectionConfig, logicalDB string) string {
	database := resolveSQLAuditDatabase(config, logicalDB)
	if connectionID := strings.TrimSpace(config.ID); connectionID != "" {
		// A saved connection keeps the same audit identity when its endpoint,
		// transport or credentials are edited. The logical database remains part
		// of the identity so cross-database filtering does not collapse histories.
		parts := []string{
			sqlAuditFingerprintVersion,
			"saved",
			strings.ToLower(strings.TrimSpace(config.Type)),
			connectionID,
			database,
		}
		hash := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
		return sqlAuditFingerprintVersion + ":" + hex.EncodeToString(hash[:])
	}
	parts := []string{
		sqlAuditFingerprintVersion,
		"temporary",
		strings.ToLower(strings.TrimSpace(config.Type)),
		strings.ToLower(strings.TrimSpace(config.Driver)),
		strings.ToLower(strings.TrimSpace(config.Host)),
		fmt.Sprintf("%d", config.Port),
		strings.Join(normalizeFingerprintHosts(config.Hosts), ","),
		database,
		strings.ToLower(strings.TrimSpace(config.Topology)),
		strings.TrimSpace(config.ReplicaSet),
		strings.TrimSpace(config.RedisSentinelMaster),
		sanitizeSQLAuditEndpointIdentity(config),
	}
	// Deliberately exclude username, password, proxy, SSH and arbitrary custom
	// parameters. URI/DSN endpoints contribute only their authority or an
	// allowlisted key/value location; query parameters never enter the digest.
	hash := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return sqlAuditFingerprintVersion + ":" + hex.EncodeToString(hash[:])
}

func sanitizeSQLAuditEndpointIdentity(config connection.ConnectionConfig) string {
	for _, candidate := range []string{config.URI, config.DSN} {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if strings.Contains(candidate, "://") {
			parsed, err := url.Parse(candidate)
			if err == nil && parsed.Scheme != "" {
				parsed.User = nil
				parsed.Path = ""
				parsed.RawPath = ""
				parsed.RawQuery = ""
				parsed.Fragment = ""
				if parsed.Host != "" {
					return strings.ToLower(parsed.String())
				}
			}
		}
		if at := strings.LastIndex(candidate, "@"); at >= 0 && at+1 < len(candidate) {
			if endpoint := sanitizeSQLAuditEndpointQuery(candidate[at+1:]); endpoint != "" {
				return strings.ToLower(endpoint)
			}
		}
		if endpoint := sanitizeSQLAuditKeyValueEndpoint(candidate); endpoint != "" {
			return strings.ToLower(endpoint)
		}
	}
	return ""
}

func sanitizeSQLAuditEndpointQuery(value string) string {
	base, _, _ := strings.Cut(value, "?")
	return strings.TrimSpace(base)
}

func sanitizeSQLAuditKeyValueEndpoint(value string) string {
	replacer := strings.NewReplacer(";", " ", "\r", " ", "\n", " ", "\t", " ")
	fields := strings.Fields(replacer.Replace(value))
	endpoint := make([]string, 0, len(fields))
	for _, field := range fields {
		key, fieldValue, found := strings.Cut(field, "=")
		if !found {
			continue
		}
		normalizedKey := strings.ToLower(strings.TrimSpace(key))
		switch normalizedKey {
		case "host", "hostname", "server", "address", "addr", "port", "database", "dbname", "db", "network", "protocol", "instance", "sid", "service_name":
			fieldValue = strings.Trim(strings.TrimSpace(fieldValue), "'\"")
			if fieldValue != "" {
				endpoint = append(endpoint, normalizedKey+"="+fieldValue)
			}
		}
	}
	return strings.Join(endpoint, ";")
}

func resolveSQLAuditDatabase(config connection.ConnectionConfig, logicalDB string) string {
	if database := strings.TrimSpace(logicalDB); database != "" {
		return database
	}
	return strings.TrimSpace(config.Database)
}

func sqlAuditStatusFromResult(result connection.QueryResult) string {
	if result.Success {
		return "success"
	}
	if data, ok := result.Data.(map[string]interface{}); ok {
		if cancelled, ok := data["cancelled"].(bool); ok && cancelled {
			return "cancelled"
		}
	}
	message := strings.ToLower(strings.TrimSpace(result.Message))
	if strings.Contains(message, "context canceled") ||
		strings.Contains(message, "context cancelled") ||
		strings.Contains(message, "query cancelled") ||
		strings.Contains(message, "query canceled") {
		return "cancelled"
	}
	return "error"
}

func sqlAuditStatusFromError(err error) string {
	if err == nil {
		return "success"
	}
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return "cancelled"
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "context canceled") || strings.Contains(message, "context cancelled") {
		return "cancelled"
	}
	return "error"
}

func sqlAuditErrorFromResult(result connection.QueryResult) error {
	if result.Success || strings.TrimSpace(result.Message) == "" {
		return nil
	}
	return errors.New(strings.TrimSpace(result.Message))
}

func normalizeSQLAuditStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "success", "cancelled":
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return "error"
	}
}

func normalizeSQLAuditSource(source string) string {
	source = strings.ToLower(strings.TrimSpace(source))
	if source == "" {
		return "query_editor"
	}
	return source
}

func normalizeSQLAuditCommitMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "auto", "manual", "pending":
		return strings.ToLower(strings.TrimSpace(mode))
	default:
		return ""
	}
}

func normalizeSQLAuditBoundaryMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "driver_api", "text_sql", "implicit":
		return strings.ToLower(strings.TrimSpace(mode))
	default:
		return "unknown"
	}
}

func durationMilliseconds(duration time.Duration) int64 {
	if duration <= 0 {
		return 0
	}
	milliseconds := duration.Milliseconds()
	if milliseconds == 0 {
		return 1
	}
	return milliseconds
}

func countSQLAuditStatements(dbType string, sql string) int {
	count := 0
	for _, statement := range splitSQLStatementsForDialect(dbType, sql) {
		if strings.TrimSpace(statement) != "" {
			count++
		}
	}
	return count
}

func sqlAuditRowsAffected(result connection.QueryResult) int64 {
	switch data := result.Data.(type) {
	case map[string]int64:
		return data["affectedRows"]
	case map[string]interface{}:
		for key, value := range data {
			if strings.EqualFold(strings.TrimSpace(key), "affectedRows") {
				return sqlAuditInt64(value)
			}
		}
	case []connection.ResultSetData:
		var total int64
		for _, resultSet := range data {
			affected, _ := summarizeManagedSQLResultSet(resultSet)
			total += affected
		}
		return total
	}
	return 0
}

func sqlAuditInt64(value interface{}) int64 {
	switch typed := value.(type) {
	case int:
		return int64(typed)
	case int32:
		return int64(typed)
	case int64:
		return typed
	case uint:
		return int64(typed)
	case uint32:
		return int64(typed)
	case uint64:
		if typed <= uint64(^uint64(0)>>1) {
			return int64(typed)
		}
	case float64:
		return int64(typed)
	}
	return 0
}

func (a *App) GetSQLAuditHealth() connection.QueryResult {
	health := a.sqlAuditHealthSnapshot()
	var settings sqlaudit.Settings
	a.sqlAuditAppendMu.Lock()
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var settingsErr error
		settings, settingsErr = store.GetSettings()
		return settingsErr
	})
	a.sqlAuditAppendMu.Unlock()
	if err == nil {
		enabled := settings.Enabled
		health.CaptureEnabled = &enabled
		health.CaptureMode = settings.CaptureMode
	}
	return connection.QueryResult{Success: true, Data: health}
}

func (a *App) GetSQLAuditEvents(filter sqlaudit.Filter) connection.QueryResult {
	var page sqlaudit.Page
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var queryErr error
		page, queryErr = store.Query(filter)
		return queryErr
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: page}
}

func (a *App) GetSQLAuditSettings() connection.QueryResult {
	var settings sqlaudit.Settings
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var settingsErr error
		settings, settingsErr = store.GetSettings()
		return settingsErr
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: settings}
}

func (a *App) UpdateSQLAuditSettings(settings sqlaudit.Settings) connection.QueryResult {
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	health := a.sqlAuditHealthSnapshot()
	wasDegraded := health.Status == sqlAuditHealthStatusDegraded
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		if updateErr := store.UpdateSettingsWithControl(settings, sqlaudit.Event{
			Timestamp: time.Now().UnixMilli(),
			EventType: "audit_settings_change",
			Status:    "success",
			QueryID:   generateQueryID(),
			Source:    "audit_control",
		}); updateErr != nil {
			return updateErr
		}
		if wasDegraded {
			return store.AppendControl(buildSQLAuditGapEvent(health))
		}
		return nil
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	a.markSQLAuditSuccess(wasDegraded)
	return a.GetSQLAuditSettings()
}

func (a *App) VerifySQLAuditIntegrity() connection.QueryResult {
	var report sqlaudit.IntegrityReport
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var verifyErr error
		report, verifyErr = store.VerifyIntegrity()
		return verifyErr
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: report}
}

func (a *App) ClearSQLAuditEvents(beforeTimestamp int64) connection.QueryResult {
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()
	health := a.sqlAuditHealthSnapshot()
	wasDegraded := health.Status == sqlAuditHealthStatusDegraded
	var deleted int64
	gapMarkerRetained := false
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var clearErr error
		deleted, clearErr = store.ClearWithControl(beforeTimestamp, sqlaudit.Event{
			Timestamp:      time.Now().UnixMilli(),
			EventType:      "audit_clear",
			Status:         "success",
			QueryID:        generateQueryID(),
			Source:         "audit_control",
			StatementCount: 1,
		})
		if clearErr != nil {
			return clearErr
		}
		if wasDegraded {
			if appendErr := store.AppendControl(buildSQLAuditGapEvent(health)); appendErr != nil {
				return appendErr
			}
		}
		page, queryErr := store.Query(sqlaudit.Filter{EventType: "audit_gap", Page: 1, PageSize: 1})
		if queryErr != nil {
			return queryErr
		}
		gapMarkerRetained = page.Total > 0
		return nil
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if wasDegraded {
		a.markSQLAuditSuccess(true)
	}
	if !gapMarkerRetained {
		a.clearSQLAuditRecoveredGapState()
	}
	return connection.QueryResult{Success: true, Data: map[string]int64{"deleted": deleted}}
}

func (a *App) clearSQLAuditRecoveredGapState() {
	a.sqlAuditHealthMu.Lock()
	defer a.sqlAuditHealthMu.Unlock()
	state := normalizeSQLAuditHealth(a.sqlAuditHealth)
	if state.Status != sqlAuditHealthStatusHealthy || state.DroppedEvents == 0 {
		return
	}
	state.DroppedEvents = 0
	state.FirstFailureAt = 0
	state.LastFailureAt = 0
	state.LastError = ""
	path := a.sqlAuditHealthPath
	if strings.TrimSpace(path) == "" {
		path = filepath.Clean(a.sqlAuditHealthFilePath())
		a.sqlAuditHealthPath = path
	}
	a.sqlAuditHealth = state
	a.sqlAuditHealthRevision++
	a.persistSQLAuditHealth(state, path)
}

func (a *App) BuildSQLAuditExport(filter sqlaudit.Filter, format string) connection.QueryResult {
	content, normalizedFormat, err := a.buildSQLAuditExport(filter, format)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	mimeType := "application/json;charset=utf-8"
	if normalizedFormat == "csv" {
		mimeType = "text/csv;charset=utf-8"
	}
	return connection.QueryResult{Success: true, Data: sqlAuditExportPayload{
		FileName: fmt.Sprintf("gonavi-sql-audit-%s.%s", time.Now().Format("20060102-150405"), normalizedFormat),
		MimeType: mimeType,
		Content:  string(content),
	}}
}

func (a *App) ExportSQLAuditFile(filter sqlaudit.Filter, format string) connection.QueryResult {
	if a.webRuntime {
		return connection.QueryResult{
			Success: false,
			Message: "desktop file export is unavailable in web runtime; use BuildSQLAuditExport",
		}
	}
	content, normalizedFormat, err := a.buildSQLAuditExport(filter, format)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	fileName, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           "Export SQL audit",
		DefaultFilename: fmt.Sprintf("gonavi-sql-audit-%s.%s", time.Now().Format("20060102-150405"), normalizedFormat),
		Filters:         exportFileDialogFilters(normalizedFormat),
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(fileName) == "" {
		return connection.QueryResult{Success: false, Message: "cancelled"}
	}
	fileName, err = a.resolveExportDialogTargetPath(fileName, normalizedFormat)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := a.validateSQLAuditExportTarget(fileName); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := writeSQLAuditExportAtomically(fileName, content); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: map[string]string{"path": fileName}}
}

func (a *App) validateSQLAuditExportTarget(fileName string) error {
	for _, protectedPath := range []string{
		a.sqlAuditDatabasePath(),
		a.sqlAuditDatabasePath() + "-wal",
		a.sqlAuditDatabasePath() + "-shm",
		a.sqlAuditHealthFilePath(),
	} {
		same, err := sameSQLAuditFilePath(fileName, protectedPath)
		if err != nil {
			return err
		}
		if same {
			return errors.New("SQL audit export target cannot replace an internal audit storage file")
		}
	}
	return nil
}

func sameSQLAuditFilePath(left, right string) (bool, error) {
	leftAbs, err := resolveSQLAuditComparisonPath(left)
	if err != nil {
		return false, err
	}
	rightAbs, err := resolveSQLAuditComparisonPath(right)
	if err != nil {
		return false, err
	}
	if filepath.Clean(leftAbs) == filepath.Clean(rightAbs) ||
		strings.EqualFold(filepath.Clean(leftAbs), filepath.Clean(rightAbs)) {
		return true, nil
	}
	leftInfo, leftErr := os.Stat(leftAbs)
	rightInfo, rightErr := os.Stat(rightAbs)
	if leftErr == nil && rightErr == nil && os.SameFile(leftInfo, rightInfo) {
		return true, nil
	}
	return false, nil
}

func resolveSQLAuditComparisonPath(path string) (string, error) {
	absPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	if resolved, resolveErr := filepath.EvalSymlinks(absPath); resolveErr == nil {
		return filepath.Clean(resolved), nil
	}
	// Export targets can be new files. Resolve their existing parent so a
	// symlinked directory cannot bypass protection for a currently absent
	// SQLite WAL/SHM sidecar.
	parent := filepath.Dir(absPath)
	resolvedParent, resolveErr := filepath.EvalSymlinks(parent)
	if resolveErr == nil {
		return filepath.Join(resolvedParent, filepath.Base(absPath)), nil
	}
	return filepath.Clean(absPath), nil
}

func (a *App) buildSQLAuditExport(filter sqlaudit.Filter, format string) ([]byte, string, error) {
	normalizedFormat := strings.ToLower(strings.TrimSpace(format))
	if normalizedFormat != "json" && normalizedFormat != "csv" {
		return nil, "", fmt.Errorf("unsupported SQL audit export format %q", format)
	}
	health, healthRevision := a.sqlAuditHealthSnapshotWithRevision()
	if health.Status == sqlAuditHealthStatusDegraded {
		return nil, "", fmt.Errorf(
			"SQL audit export is unavailable while the writer is degraded (%d known dropped event(s)); retry after recovery records an audit_gap marker",
			health.DroppedEvents,
		)
	}
	var content []byte
	err := a.withSQLAuditStore(false, func(store *sqlaudit.Store) error {
		var exportErr error
		if a.webRuntime {
			content, exportErr = store.BuildExportWithLimits(
				filter,
				normalizedFormat,
				webSQLAuditExportMaxRecords,
				webSQLAuditExportMaxBytes,
			)
		} else {
			content, exportErr = store.BuildExport(filter, normalizedFormat)
		}
		return exportErr
	})
	if err == nil {
		afterHealth, afterRevision := a.sqlAuditHealthSnapshotWithRevision()
		if afterHealth.Status == sqlAuditHealthStatusDegraded || afterRevision != healthRevision {
			return nil, "", errors.New("SQL audit health changed during export; discard this export and retry after the writer is healthy")
		}
	}
	return content, normalizedFormat, err
}

func writeSQLAuditExportAtomically(fileName string, content []byte) error {
	return writeSQLAuditExportAtomicallyWithReplace(fileName, content, true)
}

func writeSQLAuditExportAtomicallyNoReplace(fileName string, content []byte) error {
	return writeSQLAuditExportAtomicallyWithReplace(fileName, content, false)
}

func writeSQLAuditExportAtomicallyWithReplace(fileName string, content []byte, replace bool) error {
	directory := filepath.Dir(filepath.Clean(fileName))
	temporary, err := os.CreateTemp(directory, ".gonavi-sql-audit-*.tmp")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	var publishErr error
	if replace {
		publishErr = replaceSQLAuditFile(temporaryName, fileName)
	} else {
		publishErr = atomicCreateSQLAuditFile(temporaryName, fileName)
	}
	if publishErr != nil {
		return publishErr
	}
	return os.Chmod(fileName, 0o600)
}
