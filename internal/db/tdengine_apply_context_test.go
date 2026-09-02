//go:build gonavi_full_drivers || gonavi_tdengine_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

type tdengineContextConnector struct {
	started  chan struct{}
	finished chan struct{}
}

func (c tdengineContextConnector) Connect(context.Context) (driver.Conn, error) {
	return &tdengineContextConn{started: c.started, finished: c.finished}, nil
}

func (tdengineContextConnector) Driver() driver.Driver { return tdengineContextDriver{} }

type tdengineContextDriver struct{}

func (tdengineContextDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("TDengine context test driver requires connector")
}

type tdengineContextConn struct {
	started  chan struct{}
	finished chan struct{}
}

func (*tdengineContextConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not supported")
}
func (*tdengineContextConn) Close() error { return nil }
func (*tdengineContextConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not supported")
}

func (c *tdengineContextConn) ExecContext(ctx context.Context, _ string, _ []driver.NamedValue) (driver.Result, error) {
	close(c.started)
	<-ctx.Done()
	close(c.finished)
	return nil, ctx.Err()
}

var _ driver.ExecerContext = (*tdengineContextConn)(nil)

func TestTDengineApplyChangesContextCancelsInFlightInsert(t *testing.T) {
	requestStarted := make(chan struct{})
	requestFinished := make(chan struct{})
	dbConn := sql.OpenDB(tdengineContextConnector{started: requestStarted, finished: requestFinished})
	t.Cleanup(func() { _ = dbConn.Close() })

	database := &TDengineDB{conn: dbConn}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- database.ApplyChangesContext(ctx, "metrics", connection.ChangeSet{
			Inserts: []map[string]interface{}{{"ts": "2026-03-09 10:00:00", "value": 12.5}},
		})
	}()

	select {
	case <-requestStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("ApplyChangesContext did not reach the blocking TDengine driver")
	}
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("ApplyChangesContext error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ApplyChangesContext did not return after cancellation")
	}
	select {
	case <-requestFinished:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked TDengine driver did not exit after cancellation")
	}
}
