//go:build gonavi_full_drivers || gonavi_trino_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"testing"
)

var trinoPartialMetadataDriverID atomic.Uint64

type trinoPartialMetadataResult struct {
	values   []string
	queryErr error
}

type trinoPartialMetadataDriver struct {
	results map[string]trinoPartialMetadataResult
}

func (d trinoPartialMetadataDriver) Open(string) (driver.Conn, error) {
	return &trinoPartialMetadataConn{results: d.results}, nil
}

type trinoPartialMetadataConn struct {
	results map[string]trinoPartialMetadataResult
}

func (c *trinoPartialMetadataConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (*trinoPartialMetadataConn) Close() error { return nil }

func (*trinoPartialMetadataConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (c *trinoPartialMetadataConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	result, ok := c.results[query]
	if !ok {
		return nil, fmt.Errorf("unexpected Trino metadata query: %s", query)
	}
	if result.queryErr != nil {
		return nil, result.queryErr
	}
	return &trinoPartialMetadataRows{values: result.values}, nil
}

type trinoPartialMetadataRows struct {
	values []string
	index  int
}

func (*trinoPartialMetadataRows) Columns() []string { return []string{"name"} }
func (*trinoPartialMetadataRows) Close() error      { return nil }

func (r *trinoPartialMetadataRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	dest[0] = r.values[r.index]
	r.index++
	return nil
}

func newTrinoPartialMetadataDB(t *testing.T, results map[string]trinoPartialMetadataResult) *TrinoDB {
	t.Helper()
	driverName := fmt.Sprintf("gonavi_trino_partial_metadata_%d", trinoPartialMetadataDriverID.Add(1))
	sql.Register(driverName, trinoPartialMetadataDriver{results: results})
	conn, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatalf("open Trino metadata test database: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &TrinoDB{conn: conn}
}

func TestTrinoGetDatabasesReturnsUsableNamespacesWithPartialCatalogFailure(t *testing.T) {
	underlyingErr := errors.New("permission denied: secret-token")
	trino := newTrinoPartialMetadataDB(t, map[string]trinoPartialMetadataResult{
		"SHOW CATALOGS":                  {values: []string{"hive", "restricted"}},
		`SHOW SCHEMAS FROM "hive"`:       {values: []string{"default", "analytics"}},
		`SHOW SCHEMAS FROM "restricted"`: {queryErr: underlyingErr},
	})

	databases, err := trino.GetDatabases()
	if got, want := fmt.Sprint(databases), "[hive.analytics hive.default]"; got != want {
		t.Fatalf("GetDatabases() = %s, want %s", got, want)
	}
	var partialErr *PartialMetadataError
	if !errors.As(err, &partialErr) {
		t.Fatalf("GetDatabases() error = %v, want PartialMetadataError", err)
	}
	if len(partialErr.Warnings()) != 1 || !strings.Contains(partialErr.Warnings()[0], "restricted") {
		t.Fatalf("partial metadata warnings = %v, want restricted catalog warning", partialErr.Warnings())
	}
}

func TestTrinoGetDatabasesReturnsAllNamespacesWhenCatalogReadsSucceed(t *testing.T) {
	trino := newTrinoPartialMetadataDB(t, map[string]trinoPartialMetadataResult{
		"SHOW CATALOGS":               {values: []string{"hive", "iceberg"}},
		`SHOW SCHEMAS FROM "hive"`:    {values: []string{"default"}},
		`SHOW SCHEMAS FROM "iceberg"`: {values: []string{"analytics"}},
	})

	databases, err := trino.GetDatabases()
	if err != nil {
		t.Fatalf("GetDatabases() error = %v", err)
	}
	if got, want := fmt.Sprint(databases), "[hive.default iceberg.analytics]"; got != want {
		t.Fatalf("GetDatabases() = %s, want %s", got, want)
	}
}
