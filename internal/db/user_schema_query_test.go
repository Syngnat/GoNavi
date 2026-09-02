package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
)

const fakeUserSchemaDriverName = "gonavi-fake-user-schema"

var (
	registerFakeUserSchemaDriverOnce sync.Once
	errFakeUserSchemaIteration       = errors.New("simulated user schema iteration error")
)

type fakeUserSchemaDriver struct{}

func (fakeUserSchemaDriver) Open(scenario string) (driver.Conn, error) {
	return fakeUserSchemaConn{scenario: scenario}, nil
}

type fakeUserSchemaConn struct {
	scenario string
}

func (fakeUserSchemaConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (fakeUserSchemaConn) Close() error                        { return nil }
func (fakeUserSchemaConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func (c fakeUserSchemaConn) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	return &fakeUserSchemaRows{scenario: c.scenario}, nil
}

type fakeUserSchemaRows struct {
	scenario string
	index    int
}

func (fakeUserSchemaRows) Columns() []string { return []string{"nspname"} }
func (fakeUserSchemaRows) Close() error      { return nil }

func (r *fakeUserSchemaRows) Next(dest []driver.Value) error {
	r.index++
	switch r.index {
	case 1:
		dest[0] = "first_schema"
		return nil
	case 2:
		if r.scenario == "scan" {
			dest[0] = nil
			return nil
		}
		if r.scenario == "iteration" {
			return errFakeUserSchemaIteration
		}
	}
	return io.EOF
}

func openFakeUserSchemaDB(t *testing.T, scenario string) *sql.DB {
	t.Helper()
	registerFakeUserSchemaDriverOnce.Do(func() {
		sql.Register(fakeUserSchemaDriverName, fakeUserSchemaDriver{})
	})

	db, err := sql.Open(fakeUserSchemaDriverName, scenario)
	if err != nil {
		t.Fatalf("open fake user schema db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestPostgresQueryUserSchemasPropagatesRowErrors(t *testing.T) {
	tests := []struct {
		name      string
		scenario  string
		wantStage string
		wantErr   error
	}{
		{name: "second row scan error", scenario: "scan", wantStage: "扫描用户 schema"},
		{name: "second row iteration error", scenario: "iteration", wantStage: "遍历用户 schema", wantErr: errFakeUserSchemaIteration},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &PostgresDB{conn: openFakeUserSchemaDB(t, tt.scenario)}
			schemas, err := client.queryUserSchemas()
			if err == nil {
				t.Fatalf("expected %s error, got schemas=%v", tt.wantStage, schemas)
			}
			if schemas != nil {
				t.Fatalf("partial schemas must not be used, got %v", schemas)
			}
			if !strings.Contains(err.Error(), tt.wantStage) {
				t.Fatalf("error %q does not identify stage %q", err, tt.wantStage)
			}
			if tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
				t.Fatalf("error %q does not wrap %v", err, tt.wantErr)
			}
		})
	}
}
