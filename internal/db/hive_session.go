//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"

	hs "github.com/beltran/gohive/hiveserver"
)

type hiveSessionJob struct {
	ctx     context.Context
	execute func(context.Context) error
	done    chan error
}

// A dedicated worker owns each protocol instance. The channel is a request queue,
// not a mutex: no network operation holds a state lock, and close cancels its owner.
type hiveSession struct {
	config        hiveConfig
	serverName    string
	wire          *hiveWire
	handle        *hs.TSessionHandle
	protocol      hs.TProtocolVersion
	jobs          chan hiveSessionJob
	lifetime      context.Context
	cancel        context.CancelFunc
	done          chan struct{}
	closeErr      error
	broken        bool
	database      string
	enrichColumns func(context.Context, string, string, []connection.ColumnDefinition) ([]connection.ColumnDefinition, error)
}

func newHiveSession(ctx context.Context, cfg hiveConfig, serverName string) (session *hiveSession, resultErr error) {
	wire, err := openHiveWire(ctx, cfg, serverName)
	if err != nil {
		return nil, err
	}
	lifetime, cancel := context.WithCancel(context.Background())
	session = &hiveSession{config: cfg, serverName: serverName, database: cfg.Database, wire: wire, jobs: make(chan hiveSessionJob), lifetime: lifetime, cancel: cancel, done: make(chan struct{})}
	opened := session
	defer func() {
		if resultErr != nil {
			cancel()
			opened.closeErr = opened.closeHandle()
			resultErr = errors.Join(resultErr, opened.closeErr)
		}
	}()
	stop := func() {}
	if wire.conn != nil {
		stop = watchHiveDeadline(ctx, wire.conn)
	}
	defer stop()
	protocol := hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V10
	switch cfg.DriverVariant {
	case "hive1":
		protocol = hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V6
	case "hive2":
		protocol = hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V8
	case "", "auto", "hive3":
	default:
		return nil, fmt.Errorf("unsupported Hive driver variant")
	}
	username, password := cfg.User, cfg.Password
	request := &hs.TOpenSessionReq{ClientProtocol: protocol, Username: &username, Configuration: cfg.session}
	if cfg.auth != "KERBEROS" && cfg.auth != "NOSASL" {
		request.Password = &password
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	response, err := wire.api.OpenSession(ctx, request)
	if err != nil {
		session.broken = true
		return nil, fmt.Errorf("open HiveServer2 session: %w", err)
	}
	if err = hiveCheckStatus(response.GetStatus()); err != nil {
		return nil, err
	}
	if response.SessionHandle == nil {
		return nil, fmt.Errorf("HiveServer2 returned no session handle")
	}
	session.handle = response.SessionHandle
	session.protocol = response.ServerProtocolVersion
	if cfg.Database != "" {
		if _, err = session.execute(ctx, "USE "+hivesql.QuoteIdentifier(cfg.Database), nil); err != nil {
			return nil, fmt.Errorf("select Hive database: %w", err)
		}
	}
	go session.loop()
	return session, nil
}

func (s *hiveSession) loop() {
	defer close(s.done)
	defer func() { s.closeErr = s.closeHandle() }()
	for {
		select {
		case <-s.lifetime.Done():
			return
		case job := <-s.jobs:
			job.done <- s.executeJob(job)
		}
	}
}

func (s *hiveSession) executeJob(job hiveSessionJob) error {
	if err := job.ctx.Err(); err != nil {
		return err
	}
	if err := s.lifetime.Err(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(job.ctx)
	stopLifetime := context.AfterFunc(s.lifetime, cancel)
	defer func() { stopLifetime(); cancel() }()
	if s.wire == nil {
		wire, err := openHiveWire(ctx, s.config, s.serverName)
		if err != nil {
			return err
		}
		s.wire = wire
	}
	wire := s.wire
	stopDeadline := func() {}
	if wire.conn != nil {
		stopDeadline = watchHiveDeadline(ctx, wire.conn)
	}
	err := job.execute(ctx)
	stopDeadline()
	if s.broken {
		if wire.conn != nil {
			// A partial binary frame cannot be reused. CloseSession on a control
			// transport before closing the owning socket (Hive closes on disconnect).
			s.cancel()
		} else {
			err = errors.Join(err, wire.close())
			s.wire = nil
			s.broken = false
		}
	}
	if ctx.Err() != nil {
		return errors.Join(ctx.Err(), err)
	}
	return err
}

func (s *hiveSession) run(ctx context.Context, execute func(context.Context) error) error {
	if ctx == nil {
		return fmt.Errorf("Hive request context is nil")
	}
	if s.config.QueryTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(s.config.QueryTimeout)*time.Second)
		defer cancel()
	}
	// One buffered completion permits the worker to finish after a waiting caller cancels.
	job := hiveSessionJob{ctx: ctx, execute: execute, done: make(chan error, 1)}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		return fmt.Errorf("HiveServer2 session is closed")
	case <-s.lifetime.Done():
		return fmt.Errorf("HiveServer2 session is closing")
	case s.jobs <- job:
	}
	// Waiting for ownership to return prevents rows/consumer callbacks outliving a request.
	return <-job.done
}

func (s *hiveSession) Close() error { s.cancel(); <-s.done; return s.closeErr }

func (s *hiveSession) closeHandle() error {
	var result error
	var previous *hiveWire
	ctx, cancel := context.WithTimeout(context.Background(), hiveCleanupTimeout)
	defer cancel()
	if s.handle != nil {
		if s.wire == nil || s.broken {
			previous = s.wire
			s.wire = nil
			wire, err := openHiveWire(ctx, s.config, s.serverName)
			if err != nil {
				result = errors.Join(result, err)
			} else {
				s.wire = wire
			}
		}
		if s.wire != nil {
			stop := func() {}
			if s.wire.conn != nil {
				stop = watchHiveDeadline(ctx, s.wire.conn)
			}
			response, err := s.wire.api.CloseSession(ctx, &hs.TCloseSessionReq{SessionHandle: s.handle})
			stop()
			if err == nil {
				err = hiveCheckStatus(response.GetStatus())
			}
			result = errors.Join(result, err)
		}
	}
	s.handle = nil
	if previous != nil {
		result = errors.Join(result, previous.close())
	}
	if s.wire != nil {
		result = errors.Join(result, s.wire.close())
		s.wire = nil
	}
	return result
}
