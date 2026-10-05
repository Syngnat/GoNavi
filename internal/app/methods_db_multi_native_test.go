package app

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

func TestDBQueryMultiRunsSQLServerStatisticsBatchNatively(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SET STATISTICS IO, TIME ON;\nSELECT 1 AS value;"
	baseDB := &fakeBatchWriteDB{
		multiResult: map[string][]connection.ResultSetData{
			query: {
				{
					Rows:     []map[string]interface{}{},
					Columns:  []string{},
					Messages: []string{"SQL Server parse and compile time: CPU time = 0 ms."},
				},
				{
					Rows:     []map[string]interface{}{{"value": 1}},
					Columns:  []string{"value"},
					Messages: []string{"Table 'users'. Scan count 1, logical reads 3."},
				},
			},
		},
		messageMap: map[string][]string{
			query: {"Table 'users'. Scan count 1, logical reads 3."},
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sqlserver-statistics-native-batch-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if strings.Contains(result.Message, "逐条执行") {
		t.Fatalf("expected SQL Server statistics batch to avoid sequential fallback warning, got %q", result.Message)
	}
	if fakeDB.multiCalls != 1 {
		t.Fatalf("expected one native multi-result batch call, got %d", fakeDB.multiCalls)
	}
	if baseDB.session != nil {
		t.Fatal("expected native SQL Server batch to avoid sequential session fallback")
	}
	if baseDB.queryCalls != 0 || baseDB.execCalls != 0 {
		t.Fatalf("expected native batch to avoid per-statement query/exec calls, queryCalls=%d execCalls=%d", baseDB.queryCalls, baseDB.execCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected two native result sets, got %#v", resultSets)
	}
	if got := resultSets[1].Rows[0]["value"]; got != 1 {
		t.Fatalf("expected SELECT result value=1, got %#v", got)
	}
	if len(result.Messages) != 1 || !strings.Contains(result.Messages[0], "logical reads") {
		t.Fatalf("expected SQL Server statistics message to be returned, got %#v", result.Messages)
	}
}

func TestDBQueryMultiFallsBackWhenNativeReadOnlyBatchReturnsEmptyResults(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT 1 AS value"
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"value": 1},
			},
		},
		fieldMap: map[string][]string{
			query: {"value"},
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeEmptyNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sqlserver-empty-native-read-fallback-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 1 {
		t.Fatalf("expected one native multi-result attempt, got %d", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected empty native result to fall back to pinned session query")
	}
	if baseDB.session.queryCalls != 1 {
		t.Fatalf("expected fallback to query through pinned session once, got %d", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one fallback result set, got %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["value"]; got != 1 {
		t.Fatalf("expected fallback SELECT result value=1, got %#v", got)
	}
}

func TestDBQueryMultiFallsBackWhenNativeReadOnlyBatchReturnsBlankResultSet(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT * FROM mes_work_order"
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"id": 1, "code": "MO-1"},
			},
		},
		fieldMap: map[string][]string{
			query: {"id", "code"},
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeEmptyNativeMultiResultDB{
		fakeBatchWriteDB: baseDB,
		results: []connection.ResultSetData{{
			Rows:     []map[string]interface{}{},
			Columns:  []string{},
			Messages: []string{"driver returned an empty native result set"},
		}},
		messages: []string{"driver returned an empty native result set"},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMulti(config, "main", query, "blank-native-read-fallback-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 1 {
		t.Fatalf("expected one native multi-result attempt, got %d", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected blank native result set to fall back to pinned session query")
	}
	if baseDB.session.queryCalls != 1 {
		t.Fatalf("expected fallback to query through pinned session once, got %d", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one fallback result set, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"id", "code"}) {
		t.Fatalf("expected fallback columns, got %#v", resultSets[0].Columns)
	}
	if got := resultSets[0].Rows[0]["code"]; got != "MO-1" {
		t.Fatalf("expected fallback SELECT result code=MO-1, got %#v", got)
	}
}

func TestDBQueryMultiFallsBackWhenSQLServerReadReturnsOnlyAffectedRowsStatus(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT name FROM sys.databases"
	statusOnlyResult := []connection.ResultSetData{{
		Rows:    []map[string]interface{}{{"affectedRows": int64(1)}},
		Columns: []string{"affectedRows"},
	}}
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"name": "master"}},
		},
		fieldMap: map[string][]string{
			query: {"name"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: statusOnlyResult,
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeEmptyNativeMultiResultDB{
		fakeBatchWriteDB: baseDB,
		results:          statusOnlyResult,
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "custom", Driver: "mssql", Host: "127.0.0.1", Port: 1433, User: "sa"}
	result := app.DBQueryMulti(config, "master", query, "sqlserver-affected-only-read-fallback-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 1 {
		t.Fatalf("expected one top-level native multi-result attempt, got %d", fakeDB.multiCalls)
	}
	if baseDB.session == nil || baseDB.session.queryCalls != 2 {
		t.Fatalf("expected status-only result to retry session multi then plain query, session=%#v", baseDB.session)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok || len(resultSets) != 1 {
		t.Fatalf("expected one fallback result set, got %#v", result.Data)
	}
	if got := resultSets[0].Rows[0]["name"]; got != "master" {
		t.Fatalf("expected fallback SQL Server row name=master, got %#v", got)
	}
	if got := queryResultRowsReturned(result); got != 1 {
		t.Fatalf("expected SQL audit rows returned = 1, got %d", got)
	}
}

func TestDBQueryMultiFallsBackToPlainQueryWhenSequentialMultiStillReturnsBlankResultSet(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT * FROM ldf_server.mes_work_order"
	blankNativeResult := []connection.ResultSetData{{
		Rows:    []map[string]interface{}{},
		Columns: []string{},
	}}
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"work_order": "MO-20260629"},
			},
		},
		fieldMap: map[string][]string{
			query: {"work_order"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: blankNativeResult,
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMulti(config, "ldf_server_dbs_dev", query, "sequential-blank-native-read-fallback-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 1 {
		t.Fatalf("expected one top-level native multi-result attempt, got %d", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected DBQueryMulti to open a pinned session for sequential fallback")
	}
	if baseDB.session.queryCalls != 2 {
		t.Fatalf("expected sequential multi-result attempt plus plain query fallback, got %d calls", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one plain query fallback result set, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"work_order"}) {
		t.Fatalf("expected fallback columns, got %#v", resultSets[0].Columns)
	}
	if got := resultSets[0].Rows[0]["work_order"]; got != "MO-20260629" {
		t.Fatalf("expected fallback SELECT result work_order=MO-20260629, got %#v", got)
	}
}

func TestDBQueryMultiPrefersPlainQueryForKingbaseReadResults(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT * FROM ldf_server.mes_work_order"
	nativeEmptyRowsResult := []connection.ResultSetData{{
		Rows:    []map[string]interface{}{},
		Columns: []string{"id", "work_order"},
	}}
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"id": 1001, "work_order": "MO-20260629"},
			},
		},
		fieldMap: map[string][]string{
			query: {"id", "work_order"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: nativeEmptyRowsResult,
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "kingbase", Host: "127.0.0.1", Port: 54321, User: "system"}

	result := app.DBQueryMulti(config, "ldf_server_dbs_dev", query, "kingbase-plain-query-result-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 0 {
		t.Fatalf("expected kingbase read query to skip top-level native multi-result path, got %d calls", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected DBQueryMulti to open a pinned session for kingbase read query")
	}
	if baseDB.session.queryCalls != 1 {
		t.Fatalf("expected kingbase read query to use plain session query once, got %d calls", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one result set, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"id", "work_order"}) {
		t.Fatalf("expected plain query columns, got %#v", resultSets[0].Columns)
	}
	if got := resultSets[0].Rows[0]["work_order"]; got != "MO-20260629" {
		t.Fatalf("expected plain query SELECT result work_order=MO-20260629, got %#v", got)
	}
}

func TestDBQueryMultiSuccessfulKingbaseQueryRefreshesCachedHealthTimestamp(t *testing.T) {
	installFakeOptionalDriverRuntime(t)

	query := "SELECT * FROM ldf_server.andon_dash_events LIMIT 101 OFFSET 0"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"id": 1},
			},
		},
		fieldMap: map[string][]string{
			query: {"id"},
		},
		queryErr: map[string]error{},
	}
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type:     "kingbase",
		Host:     "127.0.0.1",
		Port:     54321,
		User:     "system",
		Database: "ldf_server_dbs_dev",
	}
	key := getCacheKey(config)
	previousHealthyAt := time.Now().Add(-10 * time.Second)
	app.dbCache[key] = cachedDatabase{
		inst:     fakeDB,
		lastPing: previousHealthyAt,
		config:   normalizeCacheKeyConfig(config),
	}

	result := app.DBQueryMulti(config, config.Database, query, "kingbase-refresh-cache-health-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.pingCalls != 0 {
		t.Fatalf("expected a recently healthy cached connection to skip foreground Ping, got %d calls", fakeDB.pingCalls)
	}
	if got := app.dbCache[key].lastPing; !got.After(previousHealthyAt) {
		t.Fatalf("expected successful query to refresh cached health timestamp, before=%s after=%s", previousHealthyAt, got)
	}
}

func TestDBQueryMultiPrefersPlainQueryForDamengReadResults(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT * FROM PUB_TIMER"
	nativeEmptyRowsResult := []connection.ResultSetData{{
		Rows:    []map[string]interface{}{},
		Columns: []string{"ID", "NAME"},
	}}
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"ID": 1, "NAME": "timer_a"},
			},
		},
		fieldMap: map[string][]string{
			query: {"ID", "NAME"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: nativeEmptyRowsResult,
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "custom", Driver: "dm8", Host: "127.0.0.1", Port: 5236, User: "SYSDBA"}

	result := app.DBQueryMulti(config, "SYSDBA", query, "dameng-plain-query-result-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 0 {
		t.Fatalf("expected dameng read query to skip top-level native multi-result path, got %d calls", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected DBQueryMulti to open a pinned session for dameng read query")
	}
	if baseDB.session.queryCalls != 1 {
		t.Fatalf("expected dameng read query to use plain session query once, got %d calls", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one result set, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"ID", "NAME"}) {
		t.Fatalf("expected plain query columns, got %#v", resultSets[0].Columns)
	}
	if got := resultSets[0].Rows[0]["NAME"]; got != "timer_a" {
		t.Fatalf("expected plain query SELECT result NAME=timer_a, got %#v", got)
	}
}

func TestDBQueryMultiPrefersPlainQueryForOceanBaseOracleReadResults(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT * FROM EINP_BASICINFO.AC01"
	nativeEmptyRowsResult := []connection.ResultSetData{{
		Rows:    []map[string]interface{}{},
		Columns: []string{"AAC001", "AAC003"},
	}}
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"AAC001": 1001, "AAC003": "张三"},
			},
		},
		fieldMap: map[string][]string{
			query: {"AAC001", "AAC003"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: nativeEmptyRowsResult,
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type:              "oceanbase",
		Host:              "127.0.0.1",
		Port:              2881,
		User:              "SBDEVREAD",
		OceanBaseProtocol: "oracle",
	}

	result := app.DBQueryMulti(config, "SBDEV", query, "oceanbase-oracle-plain-query-result-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 0 {
		t.Fatalf("expected OceanBase Oracle read query to skip top-level native multi-result path, got %d calls", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected DBQueryMulti to open a pinned session for OceanBase Oracle read query")
	}
	if baseDB.session.queryCalls != 1 {
		t.Fatalf("expected OceanBase Oracle read query to use plain session query once, got %d calls", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one result set, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"AAC001", "AAC003"}) {
		t.Fatalf("expected plain query columns, got %#v", resultSets[0].Columns)
	}
	if got := resultSets[0].Rows[0]["AAC003"]; got != "张三" {
		t.Fatalf("expected plain query SELECT result AAC003=张三, got %#v", got)
	}
}

func TestDBQueryMultiUsesPinnedSessionForSequentialFallback(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			"SELECT 1 AS value": {
				{"value": 1},
			},
		},
		fieldMap: map[string][]string{
			"SELECT 1 AS value": {"value"},
		},
		messageMap: map[string][]string{
			"SET NOCOUNT ON": {"NOCOUNT 已开启"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", "SET NOCOUNT ON;\nSELECT 1 AS value;", "session-fallback-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.session == nil {
		t.Fatal("expected DBQueryMulti to open a pinned session for sequential fallback")
	}
	if !fakeDB.session.closed {
		t.Fatal("expected DBQueryMulti to close the pinned session")
	}
	if fakeDB.session.execCalls != 0 {
		t.Fatalf("expected SQL Server SET statement to avoid exec-only path, got execCalls=%d", fakeDB.session.execCalls)
	}
	if fakeDB.session.queryCalls != 2 {
		t.Fatalf("expected both statements to query through pinned session, got queryCalls=%d", fakeDB.session.queryCalls)
	}
	if fakeDB.queryCalls != 2 {
		t.Fatalf("expected exactly two underlying query calls, got %d", fakeDB.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected two result sets, got %#v", resultSets)
	}
	if len(resultSets[0].Messages) != 1 || resultSets[0].Messages[0] != "NOCOUNT 已开启" {
		t.Fatalf("expected first result set to keep session message, got %#v", resultSets[0].Messages)
	}
	if got := resultSets[1].Rows[0]["value"]; got != 1 {
		t.Fatalf("expected second result set value=1, got %#v", got)
	}
}

func TestDBQueryMultiKeepsAllResultSetsFromSingleSQLServerStatement(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "EXEC sp_helpdb"
	fakeDB := &fakeBatchWriteDB{
		multiResult: map[string][]connection.ResultSetData{
			query: {
				{
					Rows:    []map[string]interface{}{{"name": "master"}},
					Columns: []string{"name"},
				},
				{
					Rows:    []map[string]interface{}{{"owner": "sa"}},
					Columns: []string{"owner"},
				},
			},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sp-helpdb-multi-result-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected two result sets, got %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["name"]; got != "master" {
		t.Fatalf("expected first result set to keep master row, got %#v", got)
	}
	if got := resultSets[1].Rows[0]["owner"]; got != "sa" {
		t.Fatalf("expected second result set to keep owner row, got %#v", got)
	}
	if resultSets[0].StatementIndex != 1 || resultSets[1].StatementIndex != 1 {
		t.Fatalf("expected both result sets to map to the first statement, got %#v", resultSets)
	}
	if fakeDB.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.execCalls)
	}
}

func TestDBQueryMultiNormalizesSingleSQLServerSelectAffectedRowsStatementIndex(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "select * from c_dddw"
	fakeDB := &fakeBatchWriteDB{
		multiResult: map[string][]connection.ResultSetData{
			query: {
				{
					Rows:    []map[string]interface{}{{"dddwno": "001", "dddwlist": "demo"}},
					Columns: []string{"dddwno", "dddwlist"},
				},
				{
					Rows:    []map[string]interface{}{{"affectedRows": int64(846)}},
					Columns: []string{"affectedRows"},
				},
			},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "hydee", query, "sqlserver-select-affectedrows-index-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected two result sets, got %#v", resultSets)
	}
	if resultSets[0].StatementIndex != 1 || resultSets[1].StatementIndex != 1 {
		t.Fatalf("expected select result and trailing affectedRows result to share statementIndex=1, got %#v", resultSets)
	}
}

func TestDBQueryMultiNormalizesSQLServerSelectAffectedRowsPairsByStatement(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT 1;\nSELECT 2;"
	baseDB := &fakeBatchWriteDB{
		multiResult: map[string][]connection.ResultSetData{
			query: {
				{
					Rows:    []map[string]interface{}{{"value": int64(1)}},
					Columns: []string{"value"},
				},
				{
					Rows:    []map[string]interface{}{{"affectedRows": int64(1)}},
					Columns: []string{"affectedRows"},
				},
				{
					Rows:    []map[string]interface{}{{"value": int64(2)}},
					Columns: []string{"value"},
				},
				{
					Rows:    []map[string]interface{}{{"affectedRows": int64(1)}},
					Columns: []string{"affectedRows"},
				},
			},
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sqlserver-select-pairs-index-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 4 {
		t.Fatalf("expected four raw SQL Server result sets, got %#v", resultSets)
	}
	wantStatementIndexes := []int{1, 1, 2, 2}
	for idx, want := range wantStatementIndexes {
		if got := resultSets[idx].StatementIndex; got != want {
			t.Fatalf("result set %d statementIndex = %d, want %d; all results: %#v", idx, got, want, resultSets)
		}
	}
}
