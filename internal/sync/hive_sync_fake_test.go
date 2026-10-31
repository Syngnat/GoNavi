package sync

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type hiveSyncTestDB struct {
	fakeMigrationDB
	fields          []connection.ColumnDefinition
	rows            []map[string]interface{}
	streamQueries   []string
	queries         []string
	executed        []string
	applied         []connection.ChangeSet
	applyTables     []string
	createColumns   []connection.ColumnDefinition
	capabilities    db.HiveTableWriteCapabilities
	capabilityError error
	capabilityCalls int
	streamError     error
	missingTypes    bool
	applyError      error
	queryFunc       func(string) ([]map[string]interface{}, []string, error)
	streamFunc      func(string) ([]map[string]interface{}, []connection.ColumnDefinition, error)
}

func newHiveSyncTestDB(schema string, fields []connection.ColumnDefinition, rows []map[string]interface{}) *hiveSyncTestDB {
	return &hiveSyncTestDB{
		fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{schema + ".events": fields}},
		fields:          fields, rows: rows,
		capabilities: db.HiveTableWriteCapabilities{Family: "hive", Insert: true, Truncate: true, InsertOnly: true},
	}
}

func (d *hiveSyncTestDB) Query(query string) ([]map[string]interface{}, []string, error) {
	d.queries = append(d.queries, query)
	if d.queryFunc != nil {
		return d.queryFunc(query)
	}
	if strings.Contains(query, "HAVING COUNT(*) > 1") || strings.Contains(query, " IS NULL") {
		return nil, nil, nil
	}
	if strings.Contains(query, "COUNT(*) AS") {
		return []map[string]interface{}{{"n": len(d.rows)}}, []string{"n"}, nil
	}
	return d.rows, hiveTestFieldNames(d.fields), nil
}

func (d *hiveSyncTestDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	return d.Query(query)
}

func (d *hiveSyncTestDB) Exec(query string) (int64, error) {
	d.executed = append(d.executed, query)
	if strings.HasPrefix(query, "CREATE TABLE") {
		d.columns["dst.events"] = append([]connection.ColumnDefinition(nil), d.createColumns...)
		d.fields = append([]connection.ColumnDefinition(nil), d.createColumns...)
	}
	return 0, nil
}

func (d *hiveSyncTestDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	return d.Exec(query)
}

func (d *hiveSyncTestDB) StreamQuery(query string, consumer db.QueryStreamConsumer) error {
	return d.StreamQueryContext(context.Background(), query, consumer)
}

func (d *hiveSyncTestDB) StreamQueryContext(ctx context.Context, query string, consumer db.QueryStreamConsumer) error {
	d.streamQueries = append(d.streamQueries, query)
	if err := ctx.Err(); err != nil {
		return err
	}
	if d.streamError != nil {
		return d.streamError
	}
	rows, fields := d.rows, d.fields
	if d.streamFunc != nil {
		var err error
		rows, fields, err = d.streamFunc(query)
		if err != nil {
			return err
		}
	}
	if err := consumer.SetColumns(hiveTestFieldNames(fields)); err != nil {
		return err
	}
	if typed, ok := consumer.(interface {
		SetColumnDefinitions([]connection.ColumnDefinition) error
	}); ok && !d.missingTypes {
		if err := typed.SetColumnDefinitions(fields); err != nil {
			return err
		}
	}
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
	return nil
}

func (d *hiveSyncTestDB) ApplyChanges(table string, changes connection.ChangeSet) error {
	d.applied = append(d.applied, changes)
	d.applyTables = append(d.applyTables, table)
	return d.applyError
}

func (d *hiveSyncTestDB) ApplyChangesContext(ctx context.Context, table string, changes connection.ChangeSet) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return d.ApplyChanges(table, changes)
}

func (d *hiveSyncTestDB) HiveTableWriteCapabilities(ctx context.Context, _ string) (db.HiveTableWriteCapabilities, error) {
	d.capabilityCalls++
	if err := ctx.Err(); err != nil {
		return db.HiveTableWriteCapabilities{}, err
	}
	return d.capabilities, d.capabilityError
}

func hiveTestFieldNames(fields []connection.ColumnDefinition) []string {
	names := make([]string, len(fields))
	for i, field := range fields {
		names[i] = field.Name
	}
	return names
}

func hiveTestConfig(mode string) SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "hive", Host: "source", Database: "src"},
		TargetConfig: connection.ConnectionConfig{Type: "hive", Host: "target", Database: "dst"},
		Tables:       []string{"events"}, Content: "data", Mode: mode, BatchSize: 2,
	}
}

func useHiveSyncTestDBs(t *testing.T, source, target db.Database) {
	t.Helper()
	useSyncDatabaseFactorySequence(t, syncDatabaseFactoryStep{db: source}, syncDatabaseFactoryStep{db: target})
}

func hiveLogicalKeyMapping() []SyncObjectMapping {
	return []SyncObjectMapping{{Source: SyncObjectRef{Name: "events"}, Target: SyncObjectRef{Name: "events"}, KeyColumns: []string{"id"}}}
}

func assertHiveNoWrites(t *testing.T, target *hiveSyncTestDB) {
	t.Helper()
	if len(target.executed) != 0 || len(target.applied) != 0 {
		t.Fatalf("unexpected writes: exec=%v apply=%v", target.executed, target.applied)
	}
}

var errHiveTestStream = errors.New("test hive source stream failed")
