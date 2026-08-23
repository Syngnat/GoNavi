package db

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

const scanRowsDuplicateDriverName = "gonavi-scan-rows-duplicate"
const scanRowsOracleBlobTestBytes = 16*1024 + 17

var registerScanRowsDuplicateDriverOnce sync.Once

type scanRowsDuplicateDriver struct{}

func (scanRowsDuplicateDriver) Open(name string) (driver.Conn, error) {
	return scanRowsDuplicateConn{}, nil
}

type scanRowsDuplicateConn struct{}

func (scanRowsDuplicateConn) Prepare(query string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (scanRowsDuplicateConn) Close() error                              { return nil }
func (scanRowsDuplicateConn) Begin() (driver.Tx, error)                 { return nil, driver.ErrSkip }

func (scanRowsDuplicateConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if query == "SELECT blob_columns" {
		return &scanRowsDuplicateRows{
			columns:     []string{"payload"},
			columnTypes: []string{"OCIBlobLocator"},
			rows: [][]driver.Value{
				{bytes.Repeat([]byte{0xff}, scanRowsOracleBlobTestBytes)},
			},
		}, nil
	}
	if query == "SELECT clob_columns" {
		return &scanRowsDuplicateRows{
			columns:     []string{"content"},
			columnTypes: []string{"OCIClobLocator"},
			rows: [][]driver.Value{
				{strings.Repeat("数", 6*1024)},
			},
		}, nil
	}
	if query == "SELECT date_columns" {
		return &scanRowsDuplicateRows{
			columns:     []string{"ship_date", "created_at"},
			columnTypes: []string{"DATE", "DATETIME"},
			rows: [][]driver.Value{
				{
					time.Date(2025, 10, 1, 0, 0, 0, 0, time.UTC),
					time.Date(2025, 10, 1, 13, 14, 15, 0, time.UTC),
				},
			},
		}, nil
	}
	if query == "SELECT timestamp_columns" {
		raw := buildOracleBinaryTimestamp(time.Date(2026, 6, 16, 12, 34, 56, 123456000, time.UTC))
		return &scanRowsDuplicateRows{
			columns:     []string{"created_at"},
			columnTypes: []string{"TYPE_CA"},
			rows: [][]driver.Value{
				{
					string(raw),
				},
			},
		}, nil
	}
	if query == "SELECT timestamp_precision_columns" {
		raw := buildOracleBinaryTimestamp(time.Date(2026, 6, 16, 12, 34, 56, 123456000, time.UTC))
		return &scanRowsDuplicateRows{
			columns:     []string{"created_at"},
			columnTypes: []string{"TIMESTAMP(6)"},
			rows: [][]driver.Value{
				{
					string(raw),
				},
			},
		}, nil
	}
	if query == "SELECT timestamp_generic_carrier_columns" {
		raw := buildOracleBinaryTimestamp(time.Date(2026, 6, 16, 12, 34, 56, 123456000, time.UTC))
		return &scanRowsDuplicateRows{
			columns:     []string{"created_at"},
			columnTypes: []string{"VARCHAR2"},
			rows: [][]driver.Value{
				{
					string(raw),
				},
			},
		}, nil
	}
	if query == "SELECT timestamp_unknown_type_columns" {
		raw := buildOracleBinaryTimestamp(time.Date(2026, 6, 16, 12, 34, 56, 123456000, time.UTC))
		return &scanRowsDuplicateRows{
			columns:     []string{"created_at"},
			columnTypes: []string{""},
			rows: [][]driver.Value{
				{
					string(raw),
				},
			},
		}, nil
	}
	if query == "SELECT timestamp_mysql_encoded_columns" {
		raw := buildMySQLBinaryTimestamp(time.Date(2026, 6, 16, 12, 34, 56, 123456000, time.UTC))
		return &scanRowsDuplicateRows{
			columns:     []string{"created_at"},
			columnTypes: []string{"TYPE_CA"},
			rows: [][]driver.Value{
				{
					string(raw),
				},
			},
		}, nil
	}
	if query == "SELECT timestamp_type_ca_live_columns" {
		raw := []byte{20, 26, 6, 16, 16, 46, 23, 96, 196, 119, 9, 6}
		return &scanRowsDuplicateRows{
			columns:     []string{"created_at"},
			columnTypes: []string{"TYPE_CA"},
			rows: [][]driver.Value{
				{
					string(raw),
				},
			},
		}, nil
	}
	if query == "SELECT scan_error_rows" {
		return &scanRowsDuplicateRows{
			columns: []string{"id"},
			rows: [][]driver.Value{
				{int64(1)},
				{int64(2)},
				{int64(3)},
			},
		}, nil
	}
	return &scanRowsDuplicateRows{
		columns: []string{"id", "id", "name"},
		rows: [][]driver.Value{
			{int64(1), int64(2), "alice"},
		},
	}, nil
}

type scanRowsValueConsumer struct {
	columns []string
	rows    [][]interface{}
}

func (c *scanRowsValueConsumer) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	return nil
}

func (c *scanRowsValueConsumer) ConsumeRow(row map[string]interface{}) error {
	values := make([]interface{}, len(c.columns))
	for index, column := range c.columns {
		values[index] = row[column]
	}
	c.rows = append(c.rows, values)
	return nil
}

func (c *scanRowsValueConsumer) ConsumeRowValues(values []interface{}) error {
	c.rows = append(c.rows, append([]interface{}(nil), values...))
	return nil
}

type scanRowsMapConsumer struct {
	columns []string
	rows    []map[string]interface{}
}

func (c *scanRowsMapConsumer) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	return nil
}

func (c *scanRowsMapConsumer) ConsumeRow(row map[string]interface{}) error {
	c.rows = append(c.rows, row)
	return nil
}

var errScanRowsTest = errors.New("simulated scan error")

type scanRowsErrorScanner struct {
	failAt    int
	scanCount int
}

func (s *scanRowsErrorScanner) scanCurrentPreviewRow(rows *sql.Rows) (map[string]interface{}, error) {
	return s.scanCurrentRow(rows)
}

func (s *scanRowsErrorScanner) scanCurrentRow(_ *sql.Rows) (map[string]interface{}, error) {
	s.scanCount++
	if s.scanCount == s.failAt {
		return nil, errScanRowsTest
	}
	return map[string]interface{}{"id": int64(s.scanCount)}, nil
}

func (s *scanRowsErrorScanner) scanCurrentRowValues(_ *sql.Rows) ([]interface{}, error) {
	s.scanCount++
	if s.scanCount == s.failAt {
		return nil, errScanRowsTest
	}
	return []interface{}{int64(s.scanCount)}, nil
}

func openScanRowsErrorRows(t *testing.T) *sql.Rows {
	t.Helper()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open scan error db failed: %v", err)
	}
	t.Cleanup(func() {
		_ = dbConn.Close()
	})

	rows, err := dbConn.QueryContext(context.Background(), "SELECT scan_error_rows")
	if err != nil {
		t.Fatalf("query scan error db failed: %v", err)
	}
	t.Cleanup(func() {
		_ = rows.Close()
	})
	return rows
}

func TestScanRowsBoundsOracleBlobPreview(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open blob scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT blob_columns")
	if err != nil {
		t.Fatalf("query blob scan rows db failed: %v", err)
	}
	defer rows.Close()

	// Production OracleDB leaves scanDialect empty; go-ora's column type is the
	// reliable signal for applying the interactive BLOB guard.
	data, columns, err := scanRowsForDialect(rows, "")
	if err != nil {
		t.Fatalf("scanRowsForDialect returned error: %v", err)
	}
	if !reflect.DeepEqual(columns, []string{"payload"}) || len(data) != 1 {
		t.Fatalf("unexpected blob result: columns=%v rows=%d", columns, len(data))
	}

	preview, ok := data[0]["payload"].(string)
	if !ok {
		t.Fatalf("Oracle BLOB preview type = %T, want string", data[0]["payload"])
	}
	wantPrefix := fmt.Sprintf("[BLOB preview: 4096/%d bytes] 0x", scanRowsOracleBlobTestBytes)
	if !strings.HasPrefix(preview, wantPrefix+strings.Repeat("ff", 4*1024)) {
		t.Fatalf("Oracle BLOB preview is missing bounded data or visible metadata: length=%d", len(preview))
	}
	fullHexLength := len("0x") + scanRowsOracleBlobTestBytes*2
	if len(preview) >= fullHexLength {
		t.Fatalf("Oracle BLOB preview length = %d, want less than full hex length %d", len(preview), fullHexLength)
	}
}

func TestStreamRowsKeepsCompleteOracleBlobValue(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open streaming blob rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT blob_columns")
	if err != nil {
		t.Fatalf("query streaming blob rows db failed: %v", err)
	}
	defer rows.Close()

	consumer := &scanRowsValueConsumer{}
	if err := streamRowsForDialect(rows, "", consumer); err != nil {
		t.Fatalf("streamRowsForDialect returned error: %v", err)
	}
	if len(consumer.rows) != 1 || len(consumer.rows[0]) != 1 {
		t.Fatalf("unexpected streamed blob rows: %#v", consumer.rows)
	}
	want := "0x" + strings.Repeat("ff", scanRowsOracleBlobTestBytes)
	if got := consumer.rows[0][0]; got != want {
		t.Fatalf("streamed Oracle BLOB was truncated: got length=%d want length=%d", len(got.(string)), len(want))
	}
}

func TestScanRowsBoundsOracleClobPreviewAtUTF8Boundary(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open clob scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT clob_columns")
	if err != nil {
		t.Fatalf("query clob scan rows db failed: %v", err)
	}
	defer rows.Close()

	data, _, err := scanRowsForDialect(rows, "")
	if err != nil {
		t.Fatalf("scanRowsForDialect returned error: %v", err)
	}
	preview, ok := data[0]["content"].(string)
	if !ok {
		t.Fatalf("Oracle CLOB preview type = %T, want string", data[0]["content"])
	}
	wantContentPrefix := strings.Repeat("数", (4*1024)/len("数"))
	wantPrefix := fmt.Sprintf(
		"[CLOB preview: %d/%d bytes] ",
		len(wantContentPrefix),
		len(strings.Repeat("数", 6*1024)),
	)
	if !strings.HasPrefix(preview, wantPrefix+wantContentPrefix) {
		t.Fatalf("Oracle CLOB preview does not preserve the UTF-8 prefix: length=%d", len(preview))
	}
	if !utf8.ValidString(preview) {
		t.Fatalf("Oracle CLOB preview split a UTF-8 character: %q", preview[:min(len(preview), 32)])
	}
}

func TestStreamRowsKeepsCompleteOracleClobValue(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open streaming clob rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT clob_columns")
	if err != nil {
		t.Fatalf("query streaming clob rows db failed: %v", err)
	}
	defer rows.Close()

	consumer := &scanRowsValueConsumer{}
	if err := streamRowsForDialect(rows, "", consumer); err != nil {
		t.Fatalf("streamRowsForDialect returned error: %v", err)
	}
	want := strings.Repeat("数", 6*1024)
	if len(consumer.rows) != 1 || len(consumer.rows[0]) != 1 || consumer.rows[0][0] != want {
		t.Fatalf("streamed Oracle CLOB was truncated: rows=%d", len(consumer.rows))
	}
}

var _ driver.QueryerContext = (*scanRowsDuplicateConn)(nil)

type scanRowsDuplicateRows struct {
	columns     []string
	columnTypes []string
	rows        [][]driver.Value
	index       int
}

func (r *scanRowsDuplicateRows) Columns() []string { return append([]string(nil), r.columns...) }
func (r *scanRowsDuplicateRows) Close() error      { return nil }
func (r *scanRowsDuplicateRows) ColumnTypeDatabaseTypeName(index int) string {
	if index < 0 || index >= len(r.columnTypes) {
		return ""
	}
	return r.columnTypes[index]
}

func (r *scanRowsDuplicateRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	row := r.rows[r.index]
	for idx := range dest {
		if idx < len(row) {
			dest[idx] = row[idx]
		}
	}
	r.index++
	return nil
}

func TestScanRowsReturnsSecondRowScanErrorWithPartialResults(t *testing.T) {
	rows := openScanRowsErrorRows(t)

	data, columns, err := scanRowsWithScanner(rows, []string{"id"}, &scanRowsErrorScanner{failAt: 2}, false)
	if !errors.Is(err, errScanRowsTest) {
		t.Fatalf("scanRows error = %v, want wrapped scan error", err)
	}
	if !reflect.DeepEqual(columns, []string{"id"}) || len(data) != 1 || data[0]["id"] != int64(1) {
		t.Fatalf("unexpected partial result: columns=%v rows=%#v", columns, data)
	}
	if !strings.Contains(err.Error(), "scan query row 2 (columns: id)") {
		t.Fatalf("scan error lacks row and column context: %v", err)
	}
}

func TestStreamRowsValueConsumerReturnsSecondRowScanError(t *testing.T) {
	rows := openScanRowsErrorRows(t)
	consumer := &scanRowsValueConsumer{}

	err := streamRowsWithScanner(rows, []string{"id"}, consumer, &scanRowsErrorScanner{failAt: 2})
	if !errors.Is(err, errScanRowsTest) {
		t.Fatalf("streamRows error = %v, want wrapped scan error", err)
	}
	if !reflect.DeepEqual(consumer.rows, [][]interface{}{{int64(1)}}) {
		t.Fatalf("unexpected streamed rows: %#v", consumer.rows)
	}
	if !strings.Contains(err.Error(), "scan query row 2 (columns: id)") {
		t.Fatalf("stream scan error lacks row and column context: %v", err)
	}
}

func TestStreamRowsMapConsumerReturnsSecondRowScanError(t *testing.T) {
	rows := openScanRowsErrorRows(t)
	consumer := &scanRowsMapConsumer{}

	err := streamRowsWithScanner(rows, []string{"id"}, consumer, &scanRowsErrorScanner{failAt: 2})
	if !errors.Is(err, errScanRowsTest) {
		t.Fatalf("streamRows error = %v, want wrapped scan error", err)
	}
	if len(consumer.rows) != 1 || consumer.rows[0]["id"] != int64(1) {
		t.Fatalf("unexpected streamed rows: %#v", consumer.rows)
	}
	if !strings.Contains(err.Error(), "scan query row 2 (columns: id)") {
		t.Fatalf("map consumer stream scan error lacks row and column context: %v", err)
	}
}

func TestScanRowsRenamesDuplicateColumns(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open duplicate scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT 1")
	if err != nil {
		t.Fatalf("query duplicate scan rows db failed: %v", err)
	}
	defer rows.Close()

	data, columns, err := scanRows(rows)
	if err != nil {
		t.Fatalf("scanRows returned error: %v", err)
	}

	wantColumns := []string{"id", "id_2", "name"}
	if !reflect.DeepEqual(columns, wantColumns) {
		t.Fatalf("unexpected columns: got=%v want=%v", columns, wantColumns)
	}
	if len(data) != 1 {
		t.Fatalf("expected one row, got=%d", len(data))
	}
	if data[0]["id"] != int64(1) || data[0]["id_2"] != int64(2) || data[0]["name"] != "alice" {
		t.Fatalf("unexpected row data: %#v", data[0])
	}
}

func TestScanRowsForMySQLDialectFormatsDateOnly(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open date scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT date_columns")
	if err != nil {
		t.Fatalf("query date scan rows db failed: %v", err)
	}
	defer rows.Close()

	data, columns, err := scanRowsForDialect(rows, "mysql")
	if err != nil {
		t.Fatalf("scanRowsForDialect returned error: %v", err)
	}

	if !reflect.DeepEqual(columns, []string{"ship_date", "created_at"}) {
		t.Fatalf("unexpected columns: %v", columns)
	}
	if len(data) != 1 {
		t.Fatalf("expected one row, got=%d", len(data))
	}
	if data[0]["ship_date"] != "2025-10-01" {
		t.Fatalf("MySQL DATE 应展示为日期，实际=%v(%T)", data[0]["ship_date"], data[0]["ship_date"])
	}
	if data[0]["created_at"] != "2025-10-01T13:14:15Z" {
		t.Fatalf("MySQL DATETIME 应保留时间，实际=%v(%T)", data[0]["created_at"], data[0]["created_at"])
	}
}

func TestScanRowsForOracleDialectKeepsDateTime(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open date scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT date_columns")
	if err != nil {
		t.Fatalf("query date scan rows db failed: %v", err)
	}
	defer rows.Close()

	data, _, err := scanRowsForDialect(rows, "oracle")
	if err != nil {
		t.Fatalf("scanRowsForDialect returned error: %v", err)
	}
	if len(data) != 1 {
		t.Fatalf("expected one row, got=%d", len(data))
	}
	if data[0]["ship_date"] != "2025-10-01T00:00:00Z" {
		t.Fatalf("Oracle DATE 应保留 datetime 语义，实际=%v(%T)", data[0]["ship_date"], data[0]["ship_date"])
	}
}

func TestScanRowsForOceanBaseOracleDialectFormatsMidnightDateOnly(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open date scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT date_columns")
	if err != nil {
		t.Fatalf("query date scan rows db failed: %v", err)
	}
	defer rows.Close()

	data, _, err := scanRowsForDialect(rows, oceanBaseOracleScanDialect)
	if err != nil {
		t.Fatalf("scanRowsForDialect returned error: %v", err)
	}
	if len(data) != 1 {
		t.Fatalf("expected one row, got=%d", len(data))
	}
	if data[0]["ship_date"] != "2025-10-01" {
		t.Fatalf("OceanBase Oracle DATE 的午夜值应展示为日期，实际=%v(%T)", data[0]["ship_date"], data[0]["ship_date"])
	}
	if data[0]["created_at"] != "2025-10-01T13:14:15Z" {
		t.Fatalf("OceanBase Oracle DATETIME 应保留时间，实际=%v(%T)", data[0]["created_at"], data[0]["created_at"])
	}
}

func TestOracleDBQueryUsesCustomScanDialect(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open date scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	oracleDB := &OracleDB{conn: dbConn, scanDialect: oceanBaseOracleScanDialect}
	data, _, err := oracleDB.Query("SELECT date_columns")
	if err != nil {
		t.Fatalf("OracleDB.Query returned error: %v", err)
	}
	if len(data) != 1 {
		t.Fatalf("expected one row, got=%d", len(data))
	}
	if data[0]["ship_date"] != "2025-10-01" {
		t.Fatalf("OracleDB 自定义扫描方言未生效，实际=%v(%T)", data[0]["ship_date"], data[0]["ship_date"])
	}
}

func TestScanRowsForOceanBaseOracleDialectDecodesBinaryTimestampString(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open timestamp scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT timestamp_columns")
	if err != nil {
		t.Fatalf("query timestamp scan rows db failed: %v", err)
	}
	defer rows.Close()

	data, columns, err := scanRowsForDialect(rows, oceanBaseOracleScanDialect)
	if err != nil {
		t.Fatalf("scanRowsForDialect returned error: %v", err)
	}
	if !reflect.DeepEqual(columns, []string{"created_at"}) {
		t.Fatalf("unexpected columns: %v", columns)
	}
	if len(data) != 1 {
		t.Fatalf("expected one row, got=%d", len(data))
	}
	if data[0]["created_at"] != "2026-06-16T12:34:56.123456Z" {
		t.Fatalf("OceanBase Oracle 二进制 TIMESTAMP 应解码为 RFC3339，实际=%v(%T)", data[0]["created_at"], data[0]["created_at"])
	}
}

func TestScanRowsForOceanBaseOracleDialectDecodesBinaryTimestampStringWithPrecisionType(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open timestamp precision scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT timestamp_precision_columns")
	if err != nil {
		t.Fatalf("query timestamp precision scan rows db failed: %v", err)
	}
	defer rows.Close()

	data, columns, err := scanRowsForDialect(rows, oceanBaseOracleScanDialect)
	if err != nil {
		t.Fatalf("scanRowsForDialect returned error: %v", err)
	}
	if !reflect.DeepEqual(columns, []string{"created_at"}) {
		t.Fatalf("unexpected columns: %v", columns)
	}
	if len(data) != 1 {
		t.Fatalf("expected one row, got=%d", len(data))
	}
	if data[0]["created_at"] != "2026-06-16T12:34:56.123456Z" {
		t.Fatalf("OceanBase Oracle TIMESTAMP(6) 应解码为 RFC3339，实际=%v(%T)", data[0]["created_at"], data[0]["created_at"])
	}
}

func TestScanRowsForOceanBaseOracleDialectDecodesBinaryTimestampStringWithGenericCarrierType(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open timestamp generic-carrier scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT timestamp_generic_carrier_columns")
	if err != nil {
		t.Fatalf("query timestamp generic-carrier scan rows db failed: %v", err)
	}
	defer rows.Close()

	data, columns, err := scanRowsForDialect(rows, oceanBaseOracleScanDialect)
	if err != nil {
		t.Fatalf("scanRowsForDialect returned error: %v", err)
	}
	if !reflect.DeepEqual(columns, []string{"created_at"}) {
		t.Fatalf("unexpected columns: %v", columns)
	}
	if len(data) != 1 {
		t.Fatalf("expected one row, got=%d", len(data))
	}
	if data[0]["created_at"] != "2026-06-16T12:34:56.123456Z" {
		t.Fatalf("OceanBase Oracle 泛型载体类型的 TIMESTAMP 应解码为 RFC3339，实际=%v(%T)", data[0]["created_at"], data[0]["created_at"])
	}
}

func TestScanRowsForOceanBaseOracleDialectDecodesBinaryTimestampStringWithoutTypeName(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open timestamp unknown-type scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT timestamp_unknown_type_columns")
	if err != nil {
		t.Fatalf("query timestamp unknown-type scan rows db failed: %v", err)
	}
	defer rows.Close()

	data, columns, err := scanRowsForDialect(rows, oceanBaseOracleScanDialect)
	if err != nil {
		t.Fatalf("scanRowsForDialect returned error: %v", err)
	}
	if !reflect.DeepEqual(columns, []string{"created_at"}) {
		t.Fatalf("unexpected columns: %v", columns)
	}
	if len(data) != 1 {
		t.Fatalf("expected one row, got=%d", len(data))
	}
	if data[0]["created_at"] != "2026-06-16T12:34:56.123456Z" {
		t.Fatalf("OceanBase Oracle 空类型名的 TIMESTAMP 应解码为 RFC3339，实际=%v(%T)", data[0]["created_at"], data[0]["created_at"])
	}
}

func TestScanRowsForOceanBaseOracleDialectDecodesMySQLLengthEncodedTimestampString(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open mysql-encoded timestamp scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT timestamp_mysql_encoded_columns")
	if err != nil {
		t.Fatalf("query mysql-encoded timestamp scan rows db failed: %v", err)
	}
	defer rows.Close()

	data, columns, err := scanRowsForDialect(rows, oceanBaseOracleScanDialect)
	if err != nil {
		t.Fatalf("scanRowsForDialect returned error: %v", err)
	}
	if !reflect.DeepEqual(columns, []string{"created_at"}) {
		t.Fatalf("unexpected columns: %v", columns)
	}
	if len(data) != 1 {
		t.Fatalf("expected one row, got=%d", len(data))
	}
	if data[0]["created_at"] != "2026-06-16T12:34:56.123456Z" {
		t.Fatalf("OceanBase Oracle length-encoded TIMESTAMP 应解码为 RFC3339，实际=%v(%T)", data[0]["created_at"], data[0]["created_at"])
	}
}

func TestScanRowsForOceanBaseOracleDialectDecodesTypeCALiveTimestampString(t *testing.T) {
	t.Parallel()

	registerScanRowsDuplicateDriverOnce.Do(func() {
		sql.Register(scanRowsDuplicateDriverName, scanRowsDuplicateDriver{})
	})

	dbConn, err := sql.Open(scanRowsDuplicateDriverName, "")
	if err != nil {
		t.Fatalf("open timestamp scan rows db failed: %v", err)
	}
	defer dbConn.Close()

	rows, err := dbConn.QueryContext(context.Background(), "SELECT timestamp_type_ca_live_columns")
	if err != nil {
		t.Fatalf("query timestamp scan rows db failed: %v", err)
	}
	defer rows.Close()

	data, columns, err := scanRowsForDialect(rows, oceanBaseOracleScanDialect)
	if err != nil {
		t.Fatalf("scanRowsForDialect returned error: %v", err)
	}
	if !reflect.DeepEqual(columns, []string{"created_at"}) {
		t.Fatalf("unexpected columns: %v", columns)
	}
	if len(data) != 1 {
		t.Fatalf("expected one row, got=%d", len(data))
	}
	if data[0]["created_at"] != "2026-06-16T16:46:23.158844Z" {
		t.Fatalf("OceanBase Oracle TYPE_CA live TIMESTAMP 应解码为 RFC3339，实际=%v(%T)", data[0]["created_at"], data[0]["created_at"])
	}
}
