//go:build gonavi_full_drivers || gonavi_gbase8a_driver

package db

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
)

// fakeGBaseConn 记录执行过的文本语句，failOn 中的语句返回错误。
type fakeGBaseConn struct {
	executed []string
	failOn   map[string]error
	valid    bool
}

func (c *fakeGBaseConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("not used") }
func (c *fakeGBaseConn) Close() error                        { return nil }
func (c *fakeGBaseConn) Begin() (driver.Tx, error) {
	return nil, errors.New("START TRANSACTION must not be used")
}
func (c *fakeGBaseConn) IsValid() bool { return c.valid }

func (c *fakeGBaseConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.executed = append(c.executed, query)
	if err := c.failOn[query]; err != nil {
		return nil, err
	}
	return driver.RowsAffected(0), nil
}

func TestGBase8aTransactionsUseAutocommit(t *testing.T) {
	inner := &fakeGBaseConn{valid: true}
	conn := &gbase8aConn{inner: inner}
	tx, err := conn.BeginTx(context.Background(), driver.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	tx, _ = conn.BeginTx(context.Background(), driver.TxOptions{})
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	want := "SET autocommit=0|COMMIT|SET autocommit=1|SET autocommit=0|ROLLBACK|SET autocommit=1"
	if got := strings.Join(inner.executed, "|"); got != want {
		t.Fatalf("executed %s, want %s", got, want)
	}
	if !conn.IsValid() || conn.ResetSession(context.Background()) != nil {
		t.Fatal("a connection with autocommit restored must stay in the pool")
	}
}

func TestGBase8aConnectionWithoutAutocommitLeavesPool(t *testing.T) {
	commitErr := errors.New("commit failed")
	inner := &fakeGBaseConn{valid: true, failOn: map[string]error{"COMMIT": commitErr, "SET autocommit=1": errors.New("broken pipe")}}
	conn := &gbase8aConn{inner: inner}
	tx, _ := conn.BeginTx(context.Background(), driver.TxOptions{})
	if err := tx.Commit(); !errors.Is(err, commitErr) {
		t.Fatalf("commit error must surface, got %v", err)
	}
	if conn.IsValid() || !errors.Is(conn.ResetSession(context.Background()), driver.ErrBadConn) {
		t.Fatal("a connection whose autocommit could not be restored must be discarded")
	}
	inner2 := &fakeGBaseConn{valid: true, failOn: map[string]error{"SET autocommit=0": errors.New("denied")}}
	if _, err := (&gbase8aConn{inner: inner2}).BeginTx(context.Background(), driver.TxOptions{}); err == nil {
		t.Fatal("begin must fail when autocommit cannot be turned off")
	}
}

func TestParseGBase8aVersion(t *testing.T) {
	for banner, want := range map[string]string{
		"8.6.2.43-R7-free.110605": "8.6.2.43",
		"9.5.3.27.126351":         "9.5.3.27.126351",
		" 9.5.2 ":                 "9.5.2",
		"GBase":                   "",
	} {
		if got := parseGBase8aVersion(banner); got != want {
			t.Fatalf("parseGBase8aVersion(%q) = %q, want %q", banner, got, want)
		}
	}
}
