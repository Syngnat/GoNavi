//go:build gonavi_full_drivers || gonavi_iotdb_driver

package db

import (
	"context"
	"errors"
	"io"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	iotdbclient "github.com/apache/iotdb-client-go/client"
)

type fakeIoTDBSession struct {
	queryResults  map[string][]map[string]interface{}
	execs         []string
	queryTimeouts []int64
	getObjectErrs map[string]error
	isNullErrs    map[string]error
	nextErr       error
}

func (f *fakeIoTDBSession) Close() error { return nil }

func (f *fakeIoTDBSession) Query(_ context.Context, sql string, timeoutMs *int64) (iotdbDataSet, error) {
	timeout := int64(-1)
	if timeoutMs != nil {
		timeout = *timeoutMs
	}
	f.queryTimeouts = append(f.queryTimeouts, timeout)
	rows := f.queryResults[sql]
	return &fakeIoTDBDataSet{
		rows:          rows,
		columns:       fakeIoTDBColumns(rows),
		getObjectErrs: f.getObjectErrs,
		isNullErrs:    f.isNullErrs,
		nextErr:       f.nextErr,
	}, nil
}

func (f *fakeIoTDBSession) Exec(_ context.Context, sql string) error {
	f.execs = append(f.execs, sql)
	return nil
}

type fakeIoTDBDataSet struct {
	rows          []map[string]interface{}
	columns       []string
	index         int
	getObjectErrs map[string]error
	isNullErrs    map[string]error
	nextErr       error
}

func (f *fakeIoTDBDataSet) Next() (bool, error) {
	if f.nextErr != nil {
		return false, f.nextErr
	}
	if f.index >= len(f.rows) {
		return false, nil
	}
	f.index++
	return true, nil
}

func (f *fakeIoTDBDataSet) Close() error { return nil }

func (f *fakeIoTDBDataSet) IsNull(columnName string) (bool, error) {
	if err := f.isNullErrs[columnName]; err != nil {
		return false, err
	}
	value, ok := f.currentRow()[columnName]
	return !ok || value == nil, nil
}

func (f *fakeIoTDBDataSet) GetObject(columnName string) (interface{}, error) {
	if err := f.getObjectErrs[columnName]; err != nil {
		return nil, err
	}
	return f.currentRow()[columnName], nil
}

func (f *fakeIoTDBDataSet) GetColumnNames() []string { return append([]string(nil), f.columns...) }

func (f *fakeIoTDBDataSet) currentRow() map[string]interface{} {
	if f.index <= 0 || f.index > len(f.rows) {
		return map[string]interface{}{}
	}
	return f.rows[f.index-1]
}

func fakeIoTDBColumns(rows []map[string]interface{}) []string {
	seen := map[string]struct{}{}
	columns := []string{}
	for _, row := range rows {
		for key := range row {
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			columns = append(columns, key)
		}
	}
	return columns
}

func TestIoTDBMetadataMapsStorageGroupsDevicesAndTimeseries(t *testing.T) {
	session := &fakeIoTDBSession{queryResults: map[string][]map[string]interface{}{
		"SHOW DATABASES": {
			{"Database": "root.zeta"},
			{"Database": "root.sg"},
		},
		"SHOW DEVICES root.sg.**": {
			{"Device": "root.sg.d2"},
			{"Device": "root.sg.d1"},
		},
		"SHOW TIMESERIES root.sg.d1.*": {
			{
				"Timeseries":  "root.sg.d1.temperature",
				"DataType":    "DOUBLE",
				"Encoding":    "GORILLA",
				"Compression": "SNAPPY",
			},
			{
				"Timeseries":  "root.sg.d1.status",
				"DataType":    "TEXT",
				"Encoding":    "PLAIN",
				"Compression": "SNAPPY",
			},
		},
	}}
	client := &IoTDBDB{session: session}

	databases, err := client.GetDatabases()
	if err != nil {
		t.Fatalf("GetDatabases: %v", err)
	}
	if !reflect.DeepEqual(databases, []string{"root.sg", "root.zeta"}) {
		t.Fatalf("unexpected databases: %#v", databases)
	}

	tables, err := client.GetTables("root.sg")
	if err != nil {
		t.Fatalf("GetTables: %v", err)
	}
	if !reflect.DeepEqual(tables, []string{"root.sg.d1", "root.sg.d2"}) {
		t.Fatalf("unexpected tables: %#v", tables)
	}

	columns, err := client.GetColumns("root.sg", "root.sg.d1")
	if err != nil {
		t.Fatalf("GetColumns: %v", err)
	}
	if len(columns) != 3 {
		t.Fatalf("unexpected columns: %#v", columns)
	}
	if columns[0].Name != "Time" || columns[0].Type != "TIMESTAMP" || columns[0].Key != "PRI" {
		t.Fatalf("unexpected time column: %#v", columns[0])
	}
	if columns[1].Name != "temperature" || columns[1].Type != "DOUBLE" || !strings.Contains(columns[1].Comment, "encoding=GORILLA") {
		t.Fatalf("unexpected measurement column: %#v", columns[1])
	}

	ddl, err := client.GetCreateStatement("root.sg", "root.sg.d1")
	if err != nil {
		t.Fatalf("GetCreateStatement: %v", err)
	}
	if !strings.Contains(ddl, "CREATE TIMESERIES root.sg.d1.temperature WITH DATATYPE=DOUBLE, ENCODING=GORILLA, COMPRESSION=SNAPPY;") {
		t.Fatalf("unexpected DDL: %s", ddl)
	}
}

func TestIoTDBApplyChangesBuildsInsertAndRejectsMutatingDiffs(t *testing.T) {
	session := &fakeIoTDBSession{}
	client := &IoTDBDB{session: session}

	err := client.ApplyChanges("root.sg.d1", connection.ChangeSet{
		Inserts: []map[string]interface{}{
			{
				"Time":        int64(1700000000000),
				"temperature": 23.5,
				"status":      "ok",
				"active":      true,
			},
		},
	})
	if err != nil {
		t.Fatalf("ApplyChanges insert: %v", err)
	}
	expected := "INSERT INTO root.sg.d1(timestamp, active, status, temperature) VALUES(1700000000000, true, 'ok', 23.5)"
	if !reflect.DeepEqual(session.execs, []string{expected}) {
		t.Fatalf("unexpected execs: %#v", session.execs)
	}

	err = client.ApplyChanges("root.sg.d1", connection.ChangeSet{
		Updates: []connection.UpdateRow{{}},
	})
	if err == nil || !strings.Contains(err.Error(), "仅支持 INSERT") {
		t.Fatalf("expected update rejection, got %v", err)
	}

	err = client.ApplyChanges("root.sg.d1", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"Time": int64(1700000000000)}},
	})
	if err == nil || !strings.Contains(err.Error(), "仅支持 INSERT") {
		t.Fatalf("expected delete rejection, got %v", err)
	}
}

func TestIoTDBConfigParsesURIAndConnectionParams(t *testing.T) {
	config := normalizeIoTDBConfig(connection.ConnectionConfig{
		URI: "iotdb://alice:secret@iotdb.local:16667/root.sg?fetchSize=2048&timeZone=Asia%2FShanghai",
	})
	if config.Host != "iotdb.local" || config.Port != 16667 || config.User != "alice" || config.Password != "secret" || config.Database != "root.sg" {
		t.Fatalf("unexpected config: %#v", config)
	}

	params := iotdbConnectionParams(connection.ConnectionConfig{
		URI:              config.URI,
		ConnectionParams: "connectRetryMax=3&rpcCompression=true",
	})
	if params.Get("fetchSize") != "2048" || params.Get("timeZone") != "Asia/Shanghai" || params.Get("connectRetryMax") != "3" || params.Get("rpcCompression") != "true" {
		t.Fatalf("unexpected params: %#v", params)
	}
}

func TestNormalizeIoTDBValueConvertsBinaryText(t *testing.T) {
	if got := normalizeIoTDBValue(iotdbclient.NewBinary([]byte("ok"))); got != "ok" {
		t.Fatalf("expected binary text to become string, got %#v", got)
	}
}

func TestIoTDBQueryContextOnlySendsExplicitDeadlineToServer(t *testing.T) {
	session := &fakeIoTDBSession{queryResults: map[string][]map[string]interface{}{
		"SELECT * FROM root.sg.d1": {},
	}}
	client := &IoTDBDB{session: session, pingTimeout: time.Second}

	if _, _, err := client.QueryContext(context.Background(), "SELECT * FROM root.sg.d1"); err != nil {
		t.Fatalf("QueryContext without deadline: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := client.QueryContext(ctx, "SELECT * FROM root.sg.d1"); err != nil {
		t.Fatalf("QueryContext with deadline: %v", err)
	}

	if len(session.queryTimeouts) != 2 {
		t.Fatalf("query timeout calls = %v", session.queryTimeouts)
	}
	if session.queryTimeouts[0] != -1 {
		t.Fatalf("connection timeout leaked into IoTDB query timeout: %dms", session.queryTimeouts[0])
	}
	if session.queryTimeouts[1] <= 0 || session.queryTimeouts[1] > 2000 {
		t.Fatalf("explicit context deadline was not propagated: %dms", session.queryTimeouts[1])
	}
}

func TestIoTDBConnectExplainsRPCHandshakeEOF(t *testing.T) {
	originalFactory := newIoTDBSessionRunner
	t.Cleanup(func() { newIoTDBSessionRunner = originalFactory })
	newIoTDBSessionRunner = func(connection.ConnectionConfig) (iotdbSessionRunner, error) {
		return nil, io.EOF
	}

	client := &IoTDBDB{}
	err := client.Connect(connection.ConnectionConfig{
		Type: "iotdb",
		Host: "iotdb.local",
		Port: 6667,
	})
	if err == nil {
		t.Fatal("expected RPC handshake failure")
	}
	if !errors.Is(err, io.EOF) {
		t.Fatalf("Connect error lost EOF cause: %v", err)
	}
	for _, fragment := range []string{
		"IoTDB RPC 握手未收到有效响应",
		"iotdb.local:6667",
		"dn_rpc_address",
		"rpcCompression",
	} {
		if !strings.Contains(err.Error(), fragment) {
			t.Fatalf("Connect error %q missing diagnostic %q", err, fragment)
		}
	}
}

func TestIoTDBLiveSmoke(t *testing.T) {
	addr := strings.TrimSpace(os.Getenv("GONAVI_IOTDB_TEST_ADDR"))
	if addr == "" {
		t.Skip("set GONAVI_IOTDB_TEST_ADDR=host:port to run live IoTDB smoke test")
	}
	host, portText, ok := strings.Cut(addr, ":")
	if !ok || strings.TrimSpace(host) == "" || strings.TrimSpace(portText) == "" {
		t.Fatalf("invalid GONAVI_IOTDB_TEST_ADDR: %q", addr)
	}
	port, err := strconv.Atoi(strings.TrimSpace(portText))
	if err != nil {
		t.Fatalf("invalid IoTDB port: %v", err)
	}

	client := &IoTDBDB{}
	if err := client.Connect(connection.ConnectionConfig{
		Type:     "iotdb",
		Host:     strings.TrimSpace(host),
		Port:     port,
		User:     "root",
		Password: "root",
		Timeout:  15,
	}); err != nil {
		t.Fatalf("connect iotdb: %v", err)
	}
	defer client.Close()

	_, _ = client.ExecContext(context.Background(), "DELETE DATABASE root.gonavi_smoke")
	_, _ = client.ExecContext(context.Background(), "DROP DATABASE root.gonavi_smoke")

	if _, err := client.Exec("CREATE DATABASE root.gonavi_smoke"); err != nil {
		t.Fatalf("create database: %v", err)
	}
	defer func() {
		_, _ = client.Exec("DELETE DATABASE root.gonavi_smoke")
		_, _ = client.Exec("DROP DATABASE root.gonavi_smoke")
	}()

	statements := []string{
		"CREATE TIMESERIES root.gonavi_smoke.d1.temperature WITH DATATYPE=DOUBLE, ENCODING=GORILLA, COMPRESSION=SNAPPY",
		"CREATE TIMESERIES root.gonavi_smoke.d1.status WITH DATATYPE=TEXT, ENCODING=PLAIN, COMPRESSION=SNAPPY",
		"INSERT INTO root.gonavi_smoke.d1(timestamp, temperature, status) VALUES(1700000000000, 21.5, 'ok')",
	}
	for _, stmt := range statements {
		if _, err := client.Exec(stmt); err != nil {
			t.Fatalf("exec %q: %v", stmt, err)
		}
	}

	rows, columns, err := client.Query("SELECT temperature, status FROM root.gonavi_smoke.d1 LIMIT 10")
	if err != nil {
		t.Fatalf("query smoke data: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected one row, got rows=%#v columns=%#v", rows, columns)
	}
	if got := rows[0]["root.gonavi_smoke.d1.status"]; got != "ok" {
		t.Fatalf("unexpected status value: %#v rows=%#v columns=%#v", got, rows, columns)
	}
}

func TestIoTDBQueryFailsWhenGetObjectReturnsError(t *testing.T) {
	decodeErr := errors.New("decode failed")
	session := &fakeIoTDBSession{
		queryResults: map[string][]map[string]interface{}{
			"SELECT temperature, status FROM root.sg.d1": {
				{"temperature": 21.5, "status": "ok"},
			},
		},
		getObjectErrs: map[string]error{
			"status": decodeErr,
		},
	}
	client := &IoTDBDB{session: session}

	rows, columns, err := client.Query("SELECT temperature, status FROM root.sg.d1")
	if err == nil {
		t.Fatalf("expected GetObject error to fail the query, got rows=%#v columns=%#v", rows, columns)
	}
	if !errors.Is(err, decodeErr) {
		t.Fatalf("query error lost GetObject cause: %v", err)
	}
	if !strings.Contains(err.Error(), `列 "status"`) {
		t.Fatalf("query error missing column context: %v", err)
	}
	if rows != nil || columns != nil {
		t.Fatalf("failed query should not return partial rows: rows=%#v columns=%#v", rows, columns)
	}
}

func TestIoTDBQueryReturnsRealNullWhenIsNullSucceeds(t *testing.T) {
	session := &fakeIoTDBSession{
		queryResults: map[string][]map[string]interface{}{
			"SELECT temperature, status FROM root.sg.d1": {
				{"temperature": 21.5, "status": nil},
			},
		},
		getObjectErrs: map[string]error{
			"status": errors.New("should not read null column"),
		},
	}
	client := &IoTDBDB{session: session}

	rows, columns, err := client.Query("SELECT temperature, status FROM root.sg.d1")
	if err != nil {
		t.Fatalf("real NULL should not fail the query: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected one row, got rows=%#v columns=%#v", rows, columns)
	}
	if rows[0]["temperature"] != 21.5 {
		t.Fatalf("unexpected temperature: %#v", rows[0]["temperature"])
	}
	if _, exists := rows[0]["status"]; !exists {
		t.Fatalf("missing status column: %#v", rows[0])
	}
	if rows[0]["status"] != nil {
		t.Fatalf("expected real NULL status, got %#v", rows[0]["status"])
	}
}

func TestScanIoTDBDataSetNilDataset(t *testing.T) {
	rows, columns, err := scanIoTDBDataSet(nil)
	if err != nil {
		t.Fatalf("nil dataset should not error: %v", err)
	}
	if rows != nil || columns != nil {
		t.Fatalf("nil dataset should return nil results, got rows=%#v columns=%#v", rows, columns)
	}
}

func TestScanIoTDBDataSetNextError(t *testing.T) {
	nextErr := errors.New("next failed")
	_, _, err := scanIoTDBDataSet(&fakeIoTDBDataSet{
		columns: []string{"status"},
		rows:    []map[string]interface{}{{"status": "ok"}},
		nextErr: nextErr,
	})
	if !errors.Is(err, nextErr) {
		t.Fatalf("expected Next error, got %v", err)
	}
}

func TestScanIoTDBDataSetIsNullErrorFallsBackToGetObject(t *testing.T) {
	rows, columns, err := scanIoTDBDataSet(&fakeIoTDBDataSet{
		columns: []string{"status"},
		rows:    []map[string]interface{}{{"status": "ok"}},
		isNullErrs: map[string]error{
			"status": errors.New("isnull failed"),
		},
	})
	if err != nil {
		t.Fatalf("IsNull error should fall back to GetObject: %v", err)
	}
	if len(rows) != 1 || rows[0]["status"] != "ok" {
		t.Fatalf("unexpected scan result: rows=%#v columns=%#v", rows, columns)
	}
}
