//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
	"GoNavi-Wails/internal/ssh"

	hs "github.com/beltran/gohive/hiveserver"
)

// HiveDB implements the HiveServer2 protocol without native SASL libraries.
// The configured family is an explicit SQL/storage capability boundary.
type HiveDB struct {
	mu               sync.Mutex
	config           hiveConfig
	serverName       string
	main             *hiveSession
	metadata         *hiveSession
	sessions         map[*hiveSession]struct{}
	forwarder        *ssh.LocalForwarder
	version          string
	variant          string
	mainRecovery     *hiveRecovery
	metadataRecovery *hiveRecovery
}

var (
	_ Database                         = (*HiveDB)(nil)
	_ QueryContexter                   = (*HiveDB)(nil)
	_ ExecContexter                    = (*HiveDB)(nil)
	_ QueryArgsContexter               = (*HiveDB)(nil)
	_ ExecArgsContexter                = (*HiveDB)(nil)
	_ ColumnDefinitionContexter        = (*HiveDB)(nil)
	_ StreamQueryExecer                = (*HiveDB)(nil)
	_ BatchApplierContext              = (*HiveDB)(nil)
	_ HiveTableWriteCapabilityProvider = (*HiveDB)(nil)
	_ SessionExecerProvider            = (*HiveDB)(nil)
	_ DriverVariantReporter            = (*HiveDB)(nil)
)

// Connect opens independent user and metadata sessions, preserving USE/SET isolation.
func (h *HiveDB) Connect(config connection.ConnectionConfig) error {
	return h.ConnectContext(context.Background(), config)
}

// ConnectContext propagates connect cancellation independently of query timeouts.
func (h *HiveDB) ConnectContext(parent context.Context, config connection.ConnectionConfig) (resultErr error) {
	if err := h.Close(); err != nil {
		return err
	}
	cfg, err := normalizeHiveConfig(config)
	if err != nil {
		return err
	}
	serverName := cfg.Host
	if cfg.UseSSH {
		forwarded, forwarder, err := forwardRegistryHTTPThroughSSH(cfg.ConnectionConfig, "HiveServer2")
		if err != nil {
			return err
		}
		cfg.ConnectionConfig = forwarded
		cfg.dialAddress = net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
		cfg.UseProxy = false
		h.forwarder = forwarder
	}
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, h.Close())
		}
	}()
	h.mu.Lock()
	h.config = cfg
	h.serverName = serverName
	h.sessions = make(map[*hiveSession]struct{})
	h.mu.Unlock()
	ctx, cancel := context.WithTimeout(parent, getConnectTimeout(cfg.ConnectionConfig))
	defer cancel()
	main, err := newHiveSession(ctx, cfg, serverName)
	if err != nil {
		return err
	}
	h.mu.Lock()
	h.main = main
	h.sessions[main] = struct{}{}
	h.mu.Unlock()
	var version string
	err = main.run(ctx, func(ctx context.Context) error {
		response, err := main.wire.api.GetInfo(ctx, &hs.TGetInfoReq{SessionHandle: main.handle, InfoType: hs.TGetInfoType_CLI_DBMS_VER})
		if err != nil {
			main.broken = true
			return err
		}
		if err = hiveCheckStatus(response.GetStatus()); err != nil {
			return err
		}
		version = response.GetInfoValue().GetStringValue()
		return nil
	})
	if err != nil {
		return fmt.Errorf("read HiveServer2 version: %w", err)
	}
	meta, err := newHiveSession(ctx, cfg, serverName)
	if err != nil {
		return err
	}
	variant := hiveVariantForServer(config.DriverVariant, cfg.family, version, main.protocol)
	h.mu.Lock()
	h.metadata = meta
	h.sessions[meta] = struct{}{}
	h.version = version
	h.variant = variant
	h.mu.Unlock()
	return h.attachHiveSourceMetadata(ctx, main)
}

// Close cancels in-flight work and closes every session before releasing SSH.
func (h *HiveDB) Close() error {
	h.mu.Lock()
	sessions := h.sessions
	forwarder := h.forwarder
	recoveries := []*hiveRecovery{h.mainRecovery, h.metadataRecovery}
	h.mainRecovery = nil
	h.metadataRecovery = nil
	h.sessions = nil
	h.main = nil
	h.metadata = nil
	h.forwarder = nil
	h.mu.Unlock()
	var result error
	for _, recovery := range recoveries {
		if recovery != nil {
			recovery.cancel()
		}
	}
	for session := range sessions {
		session.cancel()
	}
	for session := range sessions {
		result = errors.Join(result, session.Close())
	}
	if forwarder != nil {
		result = errors.Join(result, forwarder.Release())
	}
	return result
}

// DriverVariantInfo reports negotiated protocol compatibility, not a false SQL family alias.
func (h *HiveDB) DriverVariantInfo() (string, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.variant, h.version
}

func (h *HiveDB) session(metadata bool) (*hiveSession, error) {
	return h.sessionContext(metadataContextFor(h), metadata)
}

// Ping checks the live server using session-aware GetInfo rather than opening a new session.
func (h *HiveDB) Ping() error {
	h.mu.Lock()
	timeout := getConnectTimeout(h.config.ConnectionConfig)
	h.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return h.PingContext(ctx)
}

// PingContext tests liveness with caller cancellation.
func (h *HiveDB) PingContext(ctx context.Context) error {
	session, err := h.sessionContext(ctx, false)
	if err != nil {
		return err
	}
	return session.run(ctx, func(ctx context.Context) error {
		response, err := session.wire.api.GetInfo(ctx, &hs.TGetInfoReq{SessionHandle: session.handle, InfoType: hs.TGetInfoType_CLI_DBMS_NAME})
		if err != nil {
			session.broken = true
			return err
		}
		return hiveCheckStatus(response.GetStatus())
	})
}

// Query executes on the user session; QueryContext is preferred for cancellation.
func (h *HiveDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return h.QueryContext(metadataContextFor(h), query)
}

// QueryContext materializes bounded results. StreamQueryContext avoids accumulation.
func (h *HiveDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	session, err := h.sessionContext(ctx, false)
	if err != nil {
		return nil, nil, err
	}
	return session.QueryContext(ctx, query)
}

// Exec executes one statement; it never invents transaction semantics or affected rows.
func (h *HiveDB) Exec(query string) (int64, error) {
	return h.ExecContext(metadataContextFor(h), query)
}

// ExecContext executes one statement; -1 means the server did not report a row count.
func (h *HiveDB) ExecContext(ctx context.Context, query string) (int64, error) {
	session, err := h.sessionContext(ctx, false)
	if err != nil {
		return 0, err
	}
	return session.ExecContext(ctx, query)
}

// StreamQuery incrementally consumes a result set without retaining prior pages.
func (h *HiveDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return h.StreamQueryContext(metadataContextFor(h), query, consumer)
}

// StreamQueryContext propagates cancellation into transport and CancelOperation.
func (h *HiveDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	session, err := h.sessionContext(ctx, false)
	if err != nil {
		return err
	}
	return session.StreamQueryContext(ctx, query, consumer)
}

// OpenSessionExecer creates a real independent HS2 session for SQL imports.
func (h *HiveDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	h.mu.Lock()
	cfg, serverName, open := h.config, h.serverName, h.main != nil
	h.mu.Unlock()
	if !open {
		return nil, fmt.Errorf("HiveServer2 connection is closed")
	}
	session, err := newHiveSession(ctx, cfg, serverName)
	if err != nil {
		return nil, err
	}
	if err = h.attachHiveSourceMetadata(ctx, session); err != nil {
		return nil, errors.Join(err, session.Close())
	}
	h.mu.Lock()
	if h.main == nil {
		h.mu.Unlock()
		closeErr := session.Close()
		return nil, errors.Join(fmt.Errorf("HiveServer2 connection closed while opening session"), closeErr)
	}
	h.sessions[session] = struct{}{}
	h.mu.Unlock()
	return &hivePinnedSession{hiveSession: session, owner: h}, nil
}

// SupportsSessionExecer reports native server-side sessions, including HTTP mode.
func (h *HiveDB) SupportsSessionExecer() bool { return true }

// SupportsBatchApply reports batch submission, not a multi-statement transaction.
func (h *HiveDB) SupportsBatchApply() bool { return true }

type hivePinnedSession struct {
	*hiveSession
	owner *HiveDB
}

func (s *hivePinnedSession) Close() error {
	err := s.hiveSession.Close()
	s.owner.mu.Lock()
	delete(s.owner.sessions, s.hiveSession)
	s.owner.mu.Unlock()
	return err
}
func (s *hivePinnedSession) Discard() error { return s.Close() }

func hiveQualifiedName(database, table string) string {
	if database == "" {
		return hivesql.QuoteIdentifier(table)
	}
	return hivesql.QuoteIdentifier(database) + "." + hivesql.QuoteIdentifier(table)
}

// hiveStatusError retains SQLState/code without echoing credentials or SQL text.
type hiveStatusError struct {
	state   string
	code    int32
	message string
}

// SQLState returns the server diagnostic code for typed error classification.
func (e *hiveStatusError) SQLState() string { return e.state }

// Code returns the server-specific numeric diagnostic.
func (e *hiveStatusError) Code() int32 { return e.code }

func (e *hiveStatusError) Error() string {
	return fmt.Sprintf("HiveServer2 [%s/%d]: %s", e.state, e.code, e.message)
}
func hiveCheckStatus(status *hs.TStatus) error {
	if status == nil {
		return fmt.Errorf("HiveServer2 returned no status")
	}
	if status.StatusCode == hs.TStatusCode_SUCCESS_STATUS || status.StatusCode == hs.TStatusCode_SUCCESS_WITH_INFO_STATUS {
		return nil
	}
	return &hiveStatusError{state: status.GetSqlState(), code: status.GetErrorCode(), message: status.GetErrorMessage()}
}

const hiveCleanupTimeout = 5 * time.Second
