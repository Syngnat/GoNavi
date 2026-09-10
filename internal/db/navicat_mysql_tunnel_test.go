package db

import (
	"bytes"
	"context"
	"database/sql/driver"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
	mysql "github.com/go-sql-driver/mysql"
)

func navicatTunnelBool(value bool) *bool { return &value }

type navicatTunnelTestField struct {
	name   string
	table  string
	typeID uint32
	flags  uint32
	length uint32
}

type navicatTunnelRoundTripper func(*http.Request) (*http.Response, error)

func (fn navicatTunnelRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func writeNavicatTunnelUint32(buf *bytes.Buffer, value uint32) {
	_ = binary.Write(buf, binary.BigEndian, value)
}

func writeNavicatTunnelBlock(buf *bytes.Buffer, value []byte) {
	if len(value) < 254 {
		buf.WriteByte(byte(len(value)))
	} else {
		buf.WriteByte(0xfe)
		writeNavicatTunnelUint32(buf, uint32(len(value)))
	}
	buf.Write(value)
}

func navicatTunnelTestHeader(errno uint32, message string) []byte {
	buf := &bytes.Buffer{}
	writeNavicatTunnelUint32(buf, 1111)
	_ = binary.Write(buf, binary.BigEndian, uint16(206))
	writeNavicatTunnelUint32(buf, errno)
	buf.Write(make([]byte, 6))
	if errno > 0 {
		writeNavicatTunnelBlock(buf, []byte(message))
	}
	return buf.Bytes()
}

func navicatTunnelTestConnectResponse() []byte {
	buf := bytes.NewBuffer(navicatTunnelTestHeader(0, ""))
	writeNavicatTunnelBlock(buf, []byte("db.internal via TCP/IP"))
	writeNavicatTunnelBlock(buf, []byte("10"))
	writeNavicatTunnelBlock(buf, []byte("8.0.39"))
	return buf.Bytes()
}

func navicatTunnelTestQueryResponse(fields []navicatTunnelTestField, rows [][][]byte, nulls map[[2]int]bool, affected, insertID uint32) []byte {
	buf := bytes.NewBuffer(navicatTunnelTestHeader(0, ""))
	writeNavicatTunnelUint32(buf, 0)
	writeNavicatTunnelUint32(buf, affected)
	writeNavicatTunnelUint32(buf, insertID)
	writeNavicatTunnelUint32(buf, uint32(len(fields)))
	writeNavicatTunnelUint32(buf, uint32(len(rows)))
	buf.Write(make([]byte, 12))
	for _, field := range fields {
		writeNavicatTunnelBlock(buf, []byte(field.name))
		writeNavicatTunnelBlock(buf, []byte(field.table))
		writeNavicatTunnelUint32(buf, field.typeID)
		writeNavicatTunnelUint32(buf, field.flags)
		writeNavicatTunnelUint32(buf, field.length)
	}
	for rowIndex, row := range rows {
		for columnIndex, value := range row {
			if nulls[[2]int{rowIndex, columnIndex}] {
				buf.WriteByte(0xff)
				continue
			}
			writeNavicatTunnelBlock(buf, value)
		}
	}
	if len(fields) == 0 {
		writeNavicatTunnelBlock(buf, nil)
	}
	buf.WriteByte(0)
	return buf.Bytes()
}

func navicatTunnelTestBatchResponse(responses ...[]byte) []byte {
	buf := bytes.NewBuffer(navicatTunnelTestHeader(0, ""))
	for index, response := range responses {
		const commonHeaderBytes = 16
		if len(response) <= commonHeaderBytes {
			panic("invalid Navicat tunnel test response")
		}
		buf.Write(response[commonHeaderBytes : len(response)-1])
		if index == len(responses)-1 {
			buf.WriteByte(0)
		} else {
			buf.WriteByte(1)
		}
	}
	return buf.Bytes()
}

func TestMySQLDBNavicatHTTPTunnelConnectQueryAndExec(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	requests := make([]string, 0, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/private/ntunnel_mysql.php" || r.URL.RawQuery != "token=kept" {
			t.Errorf("tunnel request URL = %q?%s", r.URL.Path, r.URL.RawQuery)
		}
		if user, password, ok := r.BasicAuth(); !ok || user != "web-user" || password != "web-password" {
			t.Errorf("Basic Auth = %q/%q/%v", user, password, ok)
		}
		if got := r.Header.Get("Accept-Encoding"); got != "identity" {
			t.Errorf("Accept-Encoding = %q, want identity", got)
		}
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
			return
		}
		for key, want := range map[string]string{
			"host": "db.internal", "port": "3307", "login": "db-user", "password": "db-password", "db": "inventory",
		} {
			if got := r.PostForm.Get(key); got != want {
				t.Errorf("form %s = %q, want %q", key, got, want)
			}
		}

		action := r.PostForm.Get("actn")
		mu.Lock()
		requests = append(requests, action)
		mu.Unlock()
		switch action {
		case "C":
			_, _ = w.Write(navicatTunnelTestConnectResponse())
		case "Q":
			encodedSQL := r.PostForm.Get("q[]")
			if r.PostForm.Get("encodeBase64") != "1" {
				t.Errorf("encodeBase64 = %q, want 1", r.PostForm.Get("encodeBase64"))
			}
			sqlBytes, err := base64.StdEncoding.DecodeString(encodedSQL)
			if err != nil {
				t.Errorf("decode q[]: %v", err)
				return
			}
			switch string(sqlBytes) {
			case "SELECT id, name, payload, note FROM items":
				_, _ = w.Write(navicatTunnelTestQueryResponse(
					[]navicatTunnelTestField{
						{name: "id", table: "items", typeID: 3, length: 11},
						{name: "name", table: "items", typeID: 253, length: 255},
						{name: "payload", table: "items", typeID: 252, flags: 128, length: 65535},
						{name: "note", table: "items", typeID: 253, length: 255},
					},
					[][][]byte{{[]byte("7"), []byte("Alice"), {0x00, 0x01, 0x02}, nil}},
					map[[2]int]bool{{0, 3}: true},
					1,
					0,
				))
			case "UPDATE items SET name = 'Bob' WHERE id = 7":
				_, _ = w.Write(navicatTunnelTestQueryResponse(nil, nil, nil, 2, 0))
			default:
				t.Errorf("unexpected tunneled SQL %q", sqlBytes)
			}
		default:
			t.Errorf("unexpected action %q", action)
		}
	}))
	defer server.Close()

	database := &MySQLDB{}
	err := database.Connect(connection.ConnectionConfig{
		Type:          "mysql",
		Host:          "db.internal",
		Port:          3307,
		User:          "db-user",
		Password:      "db-password",
		Database:      "inventory",
		Timeout:       2,
		UseHTTPTunnel: true,
		HTTPTunnel: connection.HTTPTunnelConfig{
			Host:     server.URL + "/private/ntunnel_mysql.php?token=kept",
			User:     "web-user",
			Password: "web-password",
		},
	})
	if err != nil {
		t.Fatalf("Connect through Navicat HTTP tunnel: %v", err)
	}
	defer database.Close()

	data, columns, err := database.Query("SELECT id, name, payload, note FROM items")
	if err != nil {
		t.Fatalf("Query through Navicat HTTP tunnel: %v", err)
	}
	if !reflect.DeepEqual(columns, []string{"id", "name", "payload", "note"}) {
		t.Fatalf("columns = %#v", columns)
	}
	if len(data) != 1 || data[0]["id"] != "7" || data[0]["name"] != "Alice" || data[0]["payload"] != "0x000102" || data[0]["note"] != nil {
		t.Fatalf("data = %#v", data)
	}

	affected, err := database.Exec("UPDATE items SET name = 'Bob' WHERE id = 7")
	if err != nil {
		t.Fatalf("Exec through Navicat HTTP tunnel: %v", err)
	}
	if affected != 2 {
		t.Fatalf("affected rows = %d, want 2", affected)
	}

	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(requests, []string{"C", "Q", "Q"}) {
		t.Fatalf("actions = %#v", requests)
	}
}

func TestMySQLDBNavicatHTTPTunnelBatchesStatementsInOneRequest(t *testing.T) {
	t.Parallel()

	var queryRequestCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
			return
		}
		switch r.PostForm.Get("actn") {
		case "C":
			_, _ = w.Write(navicatTunnelTestConnectResponse())
		case "Q":
			queryRequestCount++
			encodedQueries := r.PostForm["q[]"]
			queries := make([]string, 0, len(encodedQueries))
			for _, encoded := range encodedQueries {
				decoded, err := base64.StdEncoding.DecodeString(encoded)
				if err != nil {
					t.Errorf("decode q[]: %v", err)
					return
				}
				queries = append(queries, string(decoded))
			}
			if !reflect.DeepEqual(queries, []string{"SET @gonavi_value = 7", "SELECT @gonavi_value AS value"}) {
				t.Errorf("q[] = %#v", queries)
			}
			_, _ = w.Write(navicatTunnelTestBatchResponse(
				navicatTunnelTestQueryResponse(nil, nil, nil, 0, 0),
				navicatTunnelTestQueryResponse(
					[]navicatTunnelTestField{{name: "value", typeID: 8, length: 20}},
					[][][]byte{{[]byte("7")}}, nil, 1, 0,
				),
			))
		default:
			t.Errorf("unexpected action %q", r.PostForm.Get("actn"))
		}
	}))
	defer server.Close()

	database := &MySQLDB{}
	if err := database.Connect(connection.ConnectionConfig{
		Type: "mysql", Host: "db.internal", Port: 3306, User: "root", Timeout: 2,
		UseHTTPTunnel: true,
		HTTPTunnel:    connection.HTTPTunnelConfig{Host: server.URL + "/ntunnel_mysql.php"},
	}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer database.Close()
	if database.SupportsSessionExecer() {
		t.Fatal("Navicat tunnel must not advertise a pinned cross-request session")
	}
	if database.SupportsBatchApply() {
		t.Fatal("Navicat tunnel must not advertise atomic data-grid batch apply")
	}

	results, err := database.QueryStatementsMultiContext(context.Background(), []string{
		"SET @gonavi_value = 7",
		"SELECT @gonavi_value AS value",
	})
	if err != nil {
		t.Fatalf("QueryStatementsMultiContext: %v", err)
	}
	if queryRequestCount != 1 {
		t.Fatalf("query HTTP requests = %d, want 1", queryRequestCount)
	}
	if len(results) != 2 || results[0].StatementIndex != 1 || results[1].StatementIndex != 2 {
		t.Fatalf("results = %#v", results)
	}
	if len(results[1].Rows) != 1 || results[1].Rows[0]["value"] != "7" {
		t.Fatalf("SELECT result = %#v", results[1])
	}
}

func TestMySQLDBNavicatHTTPTunnelRejectsHTMLResponse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprint(w, "<html><body>login required</body></html>")
	}))
	defer server.Close()

	database := &MySQLDB{}
	err := database.Connect(connection.ConnectionConfig{
		Type: "mysql", Host: "db.internal", Port: 3306, User: "root", Timeout: 2,
		UseHTTPTunnel: true,
		HTTPTunnel:    connection.HTTPTunnelConfig{Host: server.URL + "/ntunnel_mysql.php"},
	})
	if err == nil {
		t.Fatal("expected non-protocol response to fail")
	}
	if got := err.Error(); !bytes.Contains([]byte(got), []byte("Navicat")) || !bytes.Contains([]byte(got), []byte("login required")) {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestNavicatMySQLTunnelTransportErrorRedactsEndpointQuery(t *testing.T) {
	t.Parallel()

	const secret = "super-secret-token"
	client := &navicatMySQLTunnelClient{
		endpoint: "https://gateway.example/ntunnel_mysql.php?token=" + secret,
		httpClient: &http.Client{Transport: navicatTunnelRoundTripper(func(request *http.Request) (*http.Response, error) {
			return nil, &url.Error{Op: request.Method, URL: request.URL.String(), Err: errors.New("dial failed")}
		})},
	}
	_, err := client.post(context.Background(), "C", nil)
	if err == nil {
		t.Fatal("expected transport error")
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "gateway.example") {
		t.Fatalf("transport error leaked endpoint: %v", err)
	}
}

func TestMySQLDBNavicatHTTPTunnelCanDisableBase64(t *testing.T) {
	t.Parallel()

	const query = "SELECT '中文' AS label"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
			return
		}
		switch r.PostForm.Get("actn") {
		case "C":
			_, _ = w.Write(navicatTunnelTestConnectResponse())
		case "Q":
			if got := r.PostForm.Get("encodeBase64"); got != "" {
				t.Errorf("encodeBase64 = %q, want omitted", got)
			}
			if got := r.PostForm.Get("q[]"); got != query {
				t.Errorf("q[] = %q, want %q", got, query)
			}
			_, _ = w.Write(navicatTunnelTestQueryResponse(
				[]navicatTunnelTestField{{name: "label", typeID: 253, length: 255}},
				[][][]byte{{[]byte("中文")}}, nil, 1, 0,
			))
		}
	}))
	defer server.Close()

	database := &MySQLDB{}
	if err := database.Connect(connection.ConnectionConfig{
		Type: "mysql", Host: "db.internal", Port: 3306, User: "root", Timeout: 2,
		UseHTTPTunnel: true,
		HTTPTunnel: connection.HTTPTunnelConfig{
			Host: server.URL + "/ntunnel_mysql.php", EncodeBase64: navicatTunnelBool(false),
		},
	}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer database.Close()

	data, _, err := database.Query(query)
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(data) != 1 || data[0]["label"] != "中文" {
		t.Fatalf("data = %#v", data)
	}
}

func TestMySQLDBNavicatHTTPTunnelSurfacesScriptError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(navicatTunnelTestHeader(1045, "Access denied for user"))
	}))
	defer server.Close()

	database := &MySQLDB{}
	err := database.Connect(connection.ConnectionConfig{
		Type: "mysql", Host: "db.internal", Port: 3306, User: "wrong", Timeout: 2,
		UseHTTPTunnel: true,
		HTTPTunnel:    connection.HTTPTunnelConfig{Host: server.URL + "/ntunnel_mysql.php"},
	})
	if err == nil || !strings.Contains(err.Error(), "1045") || !strings.Contains(err.Error(), "Access denied") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMySQLDBNavicatHTTPTunnelRejectsTruncatedResult(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
			return
		}
		if r.PostForm.Get("actn") == "C" {
			_, _ = w.Write(navicatTunnelTestConnectResponse())
			return
		}
		response := navicatTunnelTestQueryResponse(
			[]navicatTunnelTestField{{name: "id", typeID: 3, length: 11}},
			[][][]byte{{[]byte("7")}}, nil, 1, 0,
		)
		_, _ = w.Write(response[:len(response)-2])
	}))
	defer server.Close()

	database := &MySQLDB{}
	if err := database.Connect(connection.ConnectionConfig{
		Type: "mysql", Host: "db.internal", Port: 3306, User: "root", Timeout: 2,
		UseHTTPTunnel: true,
		HTTPTunnel:    connection.HTTPTunnelConfig{Host: server.URL + "/ntunnel_mysql.php"},
	}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer database.Close()

	_, _, err := database.Query("SELECT id FROM items")
	if err == nil || !strings.Contains(err.Error(), "不完整") {
		t.Fatalf("expected truncated response error, got %v", err)
	}
}

func TestNavicatMySQLTunnelKeepsEmptyValuesDistinctFromNULL(t *testing.T) {
	t.Parallel()

	parser := &navicatMySQLTunnelParser{body: []byte{0x00}}
	value, err := parser.parseBlock()
	if err != nil {
		t.Fatalf("parse empty block: %v", err)
	}
	if value == nil || len(value) != 0 {
		t.Fatalf("empty block = %#v, want non-nil empty slice", value)
	}
}

func TestNavicatMySQLTunnelRejectsExcessiveCellAllocation(t *testing.T) {
	t.Parallel()

	body := bytes.NewBuffer(navicatTunnelTestHeader(0, ""))
	writeNavicatTunnelUint32(body, 0)
	writeNavicatTunnelUint32(body, 0)
	writeNavicatTunnelUint32(body, 0)
	writeNavicatTunnelUint32(body, 4096)
	writeNavicatTunnelUint32(body, 512)
	body.Write(make([]byte, 12))
	for index := 0; index < 4096; index++ {
		writeNavicatTunnelBlock(body, nil)
		writeNavicatTunnelBlock(body, nil)
		writeNavicatTunnelUint32(body, 253)
		writeNavicatTunnelUint32(body, 0)
		writeNavicatTunnelUint32(body, 255)
	}

	parser := &navicatMySQLTunnelParser{body: body.Bytes()}
	if _, err := parser.parseCommonHeader(); err != nil {
		t.Fatalf("parse common header: %v", err)
	}
	_, err := parser.parseResult()
	if err == nil || !strings.Contains(err.Error(), "分配") {
		t.Fatalf("expected decoded-allocation rejection, got %v", err)
	}
}

func TestNavicatMySQLTransactionControlDetection(t *testing.T) {
	t.Parallel()

	for _, query := range []string{
		"/* comment */ START TRANSACTION",
		"-- comment\nBEGIN",
		"# comment\r\nSET autocommit=0",
		"XA START 'gonavi'",
		"XA END 'gonavi'",
		"XA PREPARE 'gonavi'",
		"XA COMMIT 'gonavi'",
		"XA ROLLBACK 'gonavi'",
		"/*!40101 SET AUTOCOMMIT=0 */",
		"SET @@SESSION.autocommit = 0",
	} {
		if !isNavicatMySQLTransactionControl(query) {
			t.Errorf("expected transaction control detection for %q", query)
		}
	}
	for _, query := range []string{
		"SELECT 'BEGIN'",
		"/* START TRANSACTION */ SELECT 1",
		"SET sql_mode = 'STRICT_ALL_TABLES'",
	} {
		if isNavicatMySQLTransactionControl(query) {
			t.Errorf("unexpected transaction control detection for %q", query)
		}
	}
}

func TestNavicatMySQLTransactionBatchMustCloseWithinRequest(t *testing.T) {
	t.Parallel()

	if err := validateNavicatMySQLTransactionBatch([]string{"START TRANSACTION", "UPDATE items SET active = 1", "COMMIT"}); err != nil {
		t.Fatalf("valid same-request transaction: %v", err)
	}
	for _, queries := range [][]string{
		{"START TRANSACTION", "UPDATE items SET active = 1"},
		{"COMMIT"},
		{"SET autocommit=0", "UPDATE items SET active = 1", "COMMIT"},
		{"XA START 'gonavi'", "XA END 'gonavi'"},
	} {
		if err := validateNavicatMySQLTransactionBatch(queries); err == nil {
			t.Errorf("expected unsafe transaction batch rejection for %#v", queries)
		}
	}
}

func TestNavicatMySQLTunnelProtocolErrorUnwrapsMySQLError(t *testing.T) {
	t.Parallel()

	err := error(&navicatMySQLTunnelProtocolError{code: 1062, message: "Duplicate entry"})
	var mysqlErr *mysql.MySQLError
	if !errors.As(err, &mysqlErr) {
		t.Fatalf("expected errors.As to expose *mysql.MySQLError, got %T", err)
	}
	if mysqlErr.Number != 1062 || mysqlErr.Message != "Duplicate entry" {
		t.Fatalf("unexpected MySQL error: %#v", mysqlErr)
	}
}

func TestNavicatMySQLTunnelInterpolationSkipsQuotedAndCommentQuestionMarks(t *testing.T) {
	t.Parallel()

	query := "SELECT '?', `?`, col FROM items WHERE name = ? AND payload = ? /* ? */ -- ?\nAND active = ?"
	got, err := interpolateNavicatMySQLQuery(query, []driver.NamedValue{
		{Ordinal: 1, Value: "O'Reilly"},
		{Ordinal: 2, Value: []byte{0x00, 0xff}},
		{Ordinal: 3, Value: true},
	})
	if err != nil {
		t.Fatalf("interpolateNavicatMySQLQuery: %v", err)
	}
	want := "SELECT '?', `?`, col FROM items WHERE name = CONVERT(X'4f275265696c6c79' USING utf8mb4) AND payload = X'00ff' /* ? */ -- ?\nAND active = 1"
	if got != want {
		t.Fatalf("interpolated SQL:\n got: %s\nwant: %s", got, want)
	}
}

func TestNavicatMySQLTunnelRejectsTransactionControlWithoutHTTPRoundTrip(t *testing.T) {
	t.Parallel()

	client := &navicatMySQLTunnelClient{}
	conn := &navicatMySQLTunnelConn{client: client}
	if _, err := conn.BeginTx(context.Background(), driver.TxOptions{}); err == nil || !strings.Contains(err.Error(), "不支持跨请求事务") {
		t.Fatalf("BeginTx error = %v", err)
	}
	if _, err := conn.ExecContext(context.Background(), "BEGIN", nil); err == nil || !strings.Contains(err.Error(), "不支持跨请求事务") {
		t.Fatalf("BEGIN error = %v", err)
	}
}
