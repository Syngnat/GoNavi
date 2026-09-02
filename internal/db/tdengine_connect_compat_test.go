//go:build gonavi_full_drivers || gonavi_tdengine_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	"github.com/gorilla/websocket"
	"github.com/taosdata/driver-go/v3/taosRestful"
)

func TestTDengineConnectFallsBackToRESTInSSLAttemptOrder(t *testing.T) {
	dbConn, _ := openTDengineRecordingDB(t)
	config := connection.ConnectionConfig{
		Host:     "127.0.0.1",
		Port:     6041,
		User:     "root",
		Password: "secret",
		UseSSL:   true,
		SSLMode:  "preferred",
	}

	var attempts []string
	outcomes := []error{
		errors.New("Version mismatch. The minimum required TDengine version is 3.3.6.0."),
		errors.New("https REST endpoint unavailable"),
		errors.New("Version mismatch. The minimum required TDengine version is 3.3.6.0."),
		nil,
	}
	td := &TDengineDB{
		connectAttempt: func(_ connection.ConnectionConfig, driverName, dsn string) (*sql.DB, error) {
			attempts = append(attempts, driverName+":"+tdengineDSNNetwork(dsn))
			err := outcomes[len(attempts)-1]
			if err != nil {
				return nil, err
			}
			return dbConn, nil
		},
	}

	if err := td.Connect(config); err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}
	t.Cleanup(func() { _ = td.Close() })

	want := []string{
		tdengineWebSocketDriver + ":wss",
		tdengineRestfulDriver + ":https",
		tdengineWebSocketDriver + ":ws",
		tdengineRestfulDriver + ":http",
	}
	if !reflect.DeepEqual(attempts, want) {
		t.Fatalf("attempts = %#v, want %#v", attempts, want)
	}
	if td.driverName != tdengineRestfulDriver {
		t.Fatalf("selected driver = %q, want %q", td.driverName, tdengineRestfulDriver)
	}
}

func TestTDengineConnectFallsBackWhenWebSocketEndpointIsUnsupported(t *testing.T) {
	dbConn, _ := openTDengineRecordingDB(t)
	var drivers []string
	var probeCalls int
	td := &TDengineDB{
		connectAttempt: func(_ connection.ConnectionConfig, driverName, _ string) (*sql.DB, error) {
			drivers = append(drivers, driverName)
			if driverName == tdengineWebSocketDriver {
				return nil, errors.New("websocket: bad handshake")
			}
			return dbConn, nil
		},
		probeWebSocketEndpoint: func(context.Context, connection.ConnectionConfig) (int, error) {
			probeCalls++
			return 404, errors.New("websocket: bad handshake")
		},
	}

	err := td.Connect(connection.ConnectionConfig{Host: "127.0.0.1", Port: 6041})
	if err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}
	t.Cleanup(func() { _ = td.Close() })
	if probeCalls != 1 {
		t.Fatalf("endpoint probe calls = %d, want 1", probeCalls)
	}
	if !reflect.DeepEqual(drivers, []string{tdengineWebSocketDriver, tdengineRestfulDriver}) {
		t.Fatalf("drivers = %#v", drivers)
	}
}

func TestTDengineConnectFallsBackWhenVersionHandshakeActionIsUnsupported(t *testing.T) {
	dbConn, _ := openTDengineRecordingDB(t)
	var drivers []string
	td := &TDengineDB{
		connectAttempt: func(_ connection.ConnectionConfig, driverName, _ string) (*sql.DB, error) {
			drivers = append(drivers, driverName)
			if driverName == tdengineWebSocketDriver {
				return nil, errors.New("unexpected action: conn")
			}
			return dbConn, nil
		},
	}

	err := td.Connect(connection.ConnectionConfig{Host: "127.0.0.1", Port: 6041})
	if err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}
	t.Cleanup(func() { _ = td.Close() })
	if !reflect.DeepEqual(drivers, []string{tdengineWebSocketDriver, tdengineRestfulDriver}) {
		t.Fatalf("drivers = %#v", drivers)
	}
}

func TestTDengineConnectFallsBackWhenDriverCannotParseLegacyVersion(t *testing.T) {
	dbConn, _ := openTDengineRecordingDB(t)
	var drivers []string
	td := &TDengineDB{
		connectAttempt: func(_ connection.ConnectionConfig, driverName, _ string) (*sql.DB, error) {
			drivers = append(drivers, driverName)
			if driverName == tdengineWebSocketDriver {
				return nil, errors.New("Unknown TDengine version: vendor-2.6.")
			}
			return dbConn, nil
		},
	}

	err := td.Connect(connection.ConnectionConfig{Host: "127.0.0.1", Port: 6041})
	if err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}
	t.Cleanup(func() { _ = td.Close() })
	if !reflect.DeepEqual(drivers, []string{tdengineWebSocketDriver, tdengineRestfulDriver}) {
		t.Fatalf("drivers = %#v", drivers)
	}
}

func TestTDengineConnectDoesNotFallbackForAmbiguousOrUnauthorizedHandshakeStatus(t *testing.T) {
	for _, statusCode := range []int{http.StatusOK, http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(strconv.Itoa(statusCode), func(t *testing.T) {
			var drivers []string
			td := &TDengineDB{
				connectAttempt: func(_ connection.ConnectionConfig, driverName, _ string) (*sql.DB, error) {
					drivers = append(drivers, driverName)
					return nil, errors.New("websocket: bad handshake")
				},
				probeWebSocketEndpoint: func(context.Context, connection.ConnectionConfig) (int, error) {
					return statusCode, errors.New("websocket: bad handshake")
				},
			}

			err := td.Connect(connection.ConnectionConfig{Host: "127.0.0.1", Port: 6041})
			if err == nil {
				t.Fatal("expected Connect to fail")
			}
			if !reflect.DeepEqual(drivers, []string{tdengineWebSocketDriver}) {
				t.Fatalf("drivers = %#v; handshake status %d must not use REST", drivers, statusCode)
			}
		})
	}
}

func TestTDengineConnectDoesNotFallbackForUnrelatedWebSocketErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{name: "authentication", err: errors.New("Authentication failure: user or password incorrect")},
		{name: "authorization", err: errors.New("insufficient privilege")},
		{name: "network", err: errors.New("dial tcp 127.0.0.1:6041: connect: connection refused")},
		{name: "dsn", err: errors.New("invalid DSN: missing the slash separating the database name")},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var drivers []string
			td := &TDengineDB{
				connectAttempt: func(_ connection.ConnectionConfig, driverName, _ string) (*sql.DB, error) {
					drivers = append(drivers, driverName)
					return nil, test.err
				},
			}

			if err := td.Connect(connection.ConnectionConfig{Host: "127.0.0.1", Port: 6041}); err == nil {
				t.Fatal("expected Connect to fail")
			}
			if !reflect.DeepEqual(drivers, []string{tdengineWebSocketDriver}) {
				t.Fatalf("drivers = %#v; unrelated failure must not use REST", drivers)
			}
		})
	}
}

func TestTDengineConnectPreservesSSLOrderWithoutRESTForNetworkErrors(t *testing.T) {
	var attempts []string
	td := &TDengineDB{
		connectAttempt: func(_ connection.ConnectionConfig, driverName, dsn string) (*sql.DB, error) {
			attempts = append(attempts, driverName+":"+tdengineDSNNetwork(dsn))
			return nil, errors.New("dial tcp: connect: connection refused")
		},
	}

	err := td.Connect(connection.ConnectionConfig{
		Host:    "127.0.0.1",
		Port:    6041,
		UseSSL:  true,
		SSLMode: "preferred",
	})
	if err == nil {
		t.Fatal("expected Connect to fail")
	}
	want := []string{
		tdengineWebSocketDriver + ":wss",
		tdengineWebSocketDriver + ":ws",
	}
	if !reflect.DeepEqual(attempts, want) {
		t.Fatalf("attempts = %#v, want %#v", attempts, want)
	}
}

func TestTDengineConnectRedactsPasswordFromFailure(t *testing.T) {
	const password = "do-not-leak-this-password"
	td := &TDengineDB{
		connectAttempt: func(config connection.ConnectionConfig, _ string, _ string) (*sql.DB, error) {
			return nil, errors.New("write failed; request password=" + config.Password)
		},
	}

	err := td.Connect(connection.ConnectionConfig{
		Host:     "127.0.0.1",
		Port:     6041,
		Password: password,
	})
	if err == nil {
		t.Fatal("expected Connect to fail")
	}
	if strings.Contains(err.Error(), password) {
		t.Fatalf("Connect error leaked the password: %v", err)
	}
}

func TestTDengineRESTDSNFiltersParamsAndPreservesCredentials(t *testing.T) {
	config := connection.ConnectionConfig{
		Host:     "127.0.0.1",
		Port:     6041,
		User:     "user+%@: name",
		Password: "pass+%41@:/ word",
		Database: "metrics",
		UseSSL:   true,
		SSLMode:  "skip-verify",
		ConnectionParams: strings.Join([]string{
			"interpolateParams=false",
			"disableCompression=false",
			"readBufferSize=8192",
			"timezone=Asia%2FShanghai",
			"token=cloud-token",
			"bearerToken=bearer-value",
			"readTimeout=10s",
			"writeTimeout=10s",
			"enableCompression=true",
			"totpCode=123456",
			"unknown=bad",
		}, "&"),
	}

	dsn := (&TDengineDB{}).getRestDSN(config)
	parsed, err := taosRestful.ParseDSN(dsn)
	if err != nil {
		t.Fatalf("parse REST DSN: %v", err)
	}
	if parsed.User != config.User || parsed.Passwd != config.Password {
		t.Fatalf("REST credentials changed during DSN round trip")
	}
	if parsed.Net != "https" || parsed.Addr != config.Host || parsed.Port != config.Port || parsed.DbName != config.Database {
		t.Fatalf("REST endpoint changed during DSN round trip: net=%q addr=%q port=%d db=%q", parsed.Net, parsed.Addr, parsed.Port, parsed.DbName)
	}
	if parsed.InterpolateParams || parsed.DisableCompression || parsed.ReadBufferSize != 8192 || !parsed.SkipVerify {
		t.Fatalf("REST-specific params were not preserved: %+v", parsed)
	}
	if parsed.Timezone == nil || parsed.Timezone.String() != "Asia/Shanghai" || parsed.Token != "cloud-token" || parsed.BearerToken != "bearer-value" {
		t.Fatalf("REST auth/timezone params were not preserved")
	}
	for _, unsupported := range []string{"readTimeout", "writeTimeout", "enableCompression", "totpCode", "unknown"} {
		if strings.Contains(dsn, unsupported+"=") {
			t.Fatalf("REST DSN contains unsupported param %q", unsupported)
		}
	}
}

func TestTDengineRESTPingExecutesReadOnlyVersionProbe(t *testing.T) {
	dbConn, state := openTDengineRecordingDB(t)
	state.queryResults[tdengineVersionProbeSQL] = tdengineQueryResult{
		columns: []string{"server_version"},
		rows:    [][]driver.Value{{"2.6.0.34"}},
	}
	td := &TDengineDB{
		conn:        dbConn,
		driverName:  tdengineRestfulDriver,
		pingTimeout: 2 * time.Second,
	}

	if err := td.Ping(); err != nil {
		t.Fatalf("REST Ping returned error: %v", err)
	}
	if got := state.snapshotQueries(); !reflect.DeepEqual(got, []string{tdengineVersionProbeSQL}) {
		t.Fatalf("REST Ping queries = %#v", got)
	}
}

func TestTDengineRESTValidationUsesRealHTTPReadOnlyProbe(t *testing.T) {
	type capturedRequest struct {
		method        string
		path          string
		body          string
		authorization string
	}
	requests := make(chan capturedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			http.Error(writer, err.Error(), http.StatusInternalServerError)
			return
		}
		requests <- capturedRequest{
			method:        request.Method,
			path:          request.URL.Path,
			body:          string(body),
			authorization: request.Header.Get("Authorization"),
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"code":0,"column_meta":[["server_version","VARCHAR",64]],"data":[["2.6.0.34"]],"rows":1}`))
	}))
	defer server.Close()

	host, portText, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatalf("parse test server address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse test server port: %v", err)
	}
	config := connection.ConnectionConfig{
		Host:     host,
		Port:     port,
		User:     "probe-user",
		Password: "probe-password",
		Timeout:  2,
	}
	td := &TDengineDB{}
	dbConn, err := openAndValidateTDengineConnection(config, tdengineRestfulDriver, td.getRestDSN(config))
	if err != nil {
		t.Fatalf("validate real REST connection: %v", err)
	}
	defer dbConn.Close()

	request := <-requests
	if request.method != http.MethodPost || request.path != "/rest/sql" || request.body != tdengineVersionProbeSQL {
		t.Fatalf("REST validation request = method %q path %q body %q", request.method, request.path, request.body)
	}
	if !strings.HasPrefix(request.authorization, "Basic ") {
		t.Fatalf("REST validation did not send Basic authentication")
	}
}

func TestTDengineConnectUsesRealDriversToFallbackFromLegacyWebSocketVersion(t *testing.T) {
	restRequests := make(chan string, 1)
	var webSocketRequests atomic.Int32
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/ws":
			webSocketRequests.Add(1)
			conn, err := upgrader.Upgrade(writer, request, nil)
			if err != nil {
				return
			}
			defer conn.Close()
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
			_ = conn.WriteJSON(map[string]interface{}{
				"code":    0,
				"action":  "version",
				"version": "2.6.0.34",
			})
		case "/rest/sql":
			body, err := io.ReadAll(request.Body)
			if err != nil {
				http.Error(writer, err.Error(), http.StatusInternalServerError)
				return
			}
			restRequests <- string(body)
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"code":0,"column_meta":[["server_version","VARCHAR",64]],"data":[["2.6.0.34"]],"rows":1}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	host, portText, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatalf("parse test server address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse test server port: %v", err)
	}
	td := &TDengineDB{}
	err = td.Connect(connection.ConnectionConfig{
		Host:     host,
		Port:     port,
		User:     "root",
		Password: "test-only-password",
		Timeout:  2,
	})
	if err != nil {
		t.Fatalf("Connect with real drivers returned error: %v", err)
	}
	defer td.Close()

	if td.driverName != tdengineRestfulDriver {
		t.Fatalf("selected driver = %q, want %q", td.driverName, tdengineRestfulDriver)
	}
	if webSocketRequests.Load() == 0 {
		t.Fatal("real WebSocket driver was not attempted")
	}
	select {
	case query := <-restRequests:
		if query != tdengineVersionProbeSQL {
			t.Fatalf("REST fallback query = %q, want %q", query, tdengineVersionProbeSQL)
		}
	case <-time.After(time.Second):
		t.Fatal("real RESTful driver did not execute the read-only probe")
	}
}

func TestTDengineConnectUsesRealDriversWhenWebSocketEndpointIsMissing(t *testing.T) {
	restRequests := make(chan string, 1)
	var webSocketRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/ws":
			webSocketRequests.Add(1)
			http.NotFound(writer, request)
		case "/rest/sql":
			body, err := io.ReadAll(request.Body)
			if err != nil {
				http.Error(writer, err.Error(), http.StatusInternalServerError)
				return
			}
			restRequests <- string(body)
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"code":0,"column_meta":[["server_version","VARCHAR",64]],"data":[["2.4.0.0"]],"rows":1}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	host, portText, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatalf("parse test server address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse test server port: %v", err)
	}
	td := &TDengineDB{}
	err = td.Connect(connection.ConnectionConfig{
		Host:     host,
		Port:     port,
		User:     "root",
		Password: "test-only-password",
		Timeout:  2,
	})
	if err != nil {
		t.Fatalf("Connect with missing WS endpoint returned error: %v", err)
	}
	defer td.Close()

	if td.driverName != tdengineRestfulDriver {
		t.Fatalf("selected driver = %q, want %q", td.driverName, tdengineRestfulDriver)
	}
	if webSocketRequests.Load() < 2 {
		t.Fatalf("WebSocket requests = %d, want driver attempt plus endpoint classification probe", webSocketRequests.Load())
	}
	select {
	case query := <-restRequests:
		if query != tdengineVersionProbeSQL {
			t.Fatalf("REST fallback query = %q, want %q", query, tdengineVersionProbeSQL)
		}
	case <-time.After(time.Second):
		t.Fatal("real RESTful driver did not execute the read-only probe")
	}
}

func tdengineDSNNetwork(dsn string) string {
	left := dsn
	if at := strings.LastIndex(left, "@"); at >= 0 {
		left = left[at+1:]
	}
	if open := strings.Index(left, "("); open >= 0 {
		return left[:open]
	}
	return left
}
