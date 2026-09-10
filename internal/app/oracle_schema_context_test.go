package app

import (
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type oracleSchemaQueryState struct {
	mu        sync.Mutex
	connected []string
}

func (s *oracleSchemaQueryState) recordConnected(schema string) {
	s.mu.Lock()
	s.connected = append(s.connected, schema)
	s.mu.Unlock()
}

func (s *oracleSchemaQueryState) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.connected...)
}

type oracleSchemaQueryDB struct {
	state  *oracleSchemaQueryState
	user   string
	schema string
}

func (d *oracleSchemaQueryDB) Connect(config connection.ConnectionConfig) error {
	d.user = config.User
	d.schema = config.RuntimeOracleCurrentSchema()
	d.state.recordConnected(d.schema)
	return nil
}

func (d *oracleSchemaQueryDB) Close() error {
	return nil
}

func (*oracleSchemaQueryDB) Ping() error { return nil }

func (d *oracleSchemaQueryDB) Query(string) ([]map[string]interface{}, []string, error) {
	return []map[string]interface{}{{
		"USER_NAME":      d.user,
		"CURRENT_SCHEMA": d.schema,
	}}, []string{"USER_NAME", "CURRENT_SCHEMA"}, nil
}

func (*oracleSchemaQueryDB) Exec(string) (int64, error) { return 0, nil }
func (*oracleSchemaQueryDB) GetDatabases() ([]string, error) {
	return nil, nil
}
func (*oracleSchemaQueryDB) GetTables(string) ([]string, error) { return nil, nil }
func (*oracleSchemaQueryDB) GetCreateStatement(string, string) (string, error) {
	return "", nil
}
func (*oracleSchemaQueryDB) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (*oracleSchemaQueryDB) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (*oracleSchemaQueryDB) GetIndexes(string, string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (*oracleSchemaQueryDB) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (*oracleSchemaQueryDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func oracleSchemaMultiResultValue(t *testing.T, result connection.QueryResult, key string) string {
	t.Helper()
	if !result.Success {
		t.Fatalf("Oracle query failed: %s", result.Message)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok || len(resultSets) != 1 || len(resultSets[0].Rows) != 1 {
		t.Fatalf("unexpected Oracle query data: %#v", result.Data)
	}
	return resultSets[0].Rows[0][key].(string)
}

func TestDBQueryMultiOracleUsesSelectedSchemaWithoutChangingLoginUser(t *testing.T) {
	installDatabaseCacheConcurrencyTestHooks(t)
	state := &oracleSchemaQueryState{}
	newDatabaseFunc = func(string) (db.Database, error) {
		return &oracleSchemaQueryDB{state: state}, nil
	}

	app := newDatabaseCacheConcurrencyTestApp()
	t.Cleanup(app.closeCachedDatabasesForShutdown)
	config := connection.ConnectionConfig{
		Type:     "oracle",
		Host:     "oracle.local",
		Port:     1521,
		User:     "TEST",
		Password: "secret",
		Database: "ORCLPDB1",
	}
	query := "select user, sys_context('userenv','current_schema') from dual"

	pro := app.DBQueryMulti(config, "PRO", query, "oracle-pro")
	if got := oracleSchemaMultiResultValue(t, pro, "USER_NAME"); got != "TEST" {
		t.Fatalf("Oracle login user = %q, want TEST", got)
	}
	if got := oracleSchemaMultiResultValue(t, pro, "CURRENT_SCHEMA"); got != "PRO" {
		t.Fatalf("selected Oracle schema = %q, want PRO", got)
	}

	testSchema := app.DBQueryMulti(config, "TEST", query, "oracle-test")
	if got := oracleSchemaMultiResultValue(t, testSchema, "CURRENT_SCHEMA"); got != "TEST" {
		t.Fatalf("selected Oracle schema = %q, want TEST", got)
	}

	proAgain := app.DBQueryMulti(config, "PRO", query, "oracle-pro-again")
	if got := oracleSchemaMultiResultValue(t, proAgain, "CURRENT_SCHEMA"); got != "PRO" {
		t.Fatalf("reused Oracle schema = %q, want PRO", got)
	}

	connected := state.snapshot()
	if len(connected) != 2 || connected[0] != "PRO" || connected[1] != "TEST" {
		t.Fatalf("Oracle schema-specific connections = %#v, want [PRO TEST]", connected)
	}
}

var _ db.Database = (*oracleSchemaQueryDB)(nil)
