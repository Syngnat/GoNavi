package app

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func writeNavicatTunnelIntegrationBlock(buf *bytes.Buffer, value string) {
	buf.WriteByte(byte(len(value)))
	buf.WriteString(value)
}

func navicatTunnelIntegrationQueryResponse(column, value string) []byte {
	buf := &bytes.Buffer{}
	_ = binary.Write(buf, binary.BigEndian, uint32(1111))
	_ = binary.Write(buf, binary.BigEndian, uint16(206))
	_ = binary.Write(buf, binary.BigEndian, uint32(0))
	buf.Write(make([]byte, 6))
	_ = binary.Write(buf, binary.BigEndian, uint32(0))
	_ = binary.Write(buf, binary.BigEndian, uint32(1))
	_ = binary.Write(buf, binary.BigEndian, uint32(0))
	_ = binary.Write(buf, binary.BigEndian, uint32(1))
	_ = binary.Write(buf, binary.BigEndian, uint32(1))
	buf.Write(make([]byte, 12))
	writeNavicatTunnelIntegrationBlock(buf, column)
	writeNavicatTunnelIntegrationBlock(buf, "")
	_ = binary.Write(buf, binary.BigEndian, uint32(253))
	_ = binary.Write(buf, binary.BigEndian, uint32(0))
	_ = binary.Write(buf, binary.BigEndian, uint32(255))
	writeNavicatTunnelIntegrationBlock(buf, value)
	buf.WriteByte(0)
	return buf.Bytes()
}

func TestOpenDatabaseIsolatedUsesNavicatHTTPProtocolWithoutLocalForwarder(t *testing.T) {
	t.Parallel()

	requests := make(chan *http.Request, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
			return
		}
		requests <- r.Clone(r.Context())
		buf := &bytes.Buffer{}
		_ = binary.Write(buf, binary.BigEndian, uint32(1111))
		_ = binary.Write(buf, binary.BigEndian, uint16(206))
		_ = binary.Write(buf, binary.BigEndian, uint32(0))
		buf.Write(make([]byte, 6))
		writeNavicatTunnelIntegrationBlock(buf, "db.internal via TCP/IP")
		writeNavicatTunnelIntegrationBlock(buf, "10")
		writeNavicatTunnelIntegrationBlock(buf, "8.0.39")
		_, _ = w.Write(buf.Bytes())
	}))
	defer server.Close()

	app := NewApp()
	database, err := app.openDatabaseIsolated(connection.ConnectionConfig{
		Type:          "mysql",
		Host:          "db.internal",
		Port:          3307,
		User:          "db-user",
		Password:      "db-password",
		Database:      "inventory",
		Timeout:       2,
		UseHTTPTunnel: true,
		HTTPTunnel: connection.HTTPTunnelConfig{
			Host: server.URL + "/private/ntunnel_mysql.php?token=kept",
		},
	})
	if err != nil {
		t.Fatalf("openDatabaseIsolated: %v", err)
	}
	defer database.Close()

	select {
	case request := <-requests:
		if request.URL.Path != "/private/ntunnel_mysql.php" || request.URL.RawQuery != "token=kept" {
			t.Fatalf("request URL = %q?%s", request.URL.Path, request.URL.RawQuery)
		}
		if request.PostForm.Get("actn") != "C" || request.PostForm.Get("host") != "db.internal" || request.PostForm.Get("port") != "3307" {
			t.Fatalf("unexpected Navicat connection form: %#v", request.PostForm)
		}
	default:
		t.Fatal("Navicat HTTP tunnel endpoint was not called")
	}
}

func TestDBQueryMultiExecutesCallThroughNavicatHTTPTunnel(t *testing.T) {
	t.Parallel()

	queries := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
			return
		}
		switch r.PostForm.Get("actn") {
		case "C":
			buf := &bytes.Buffer{}
			_ = binary.Write(buf, binary.BigEndian, uint32(1111))
			_ = binary.Write(buf, binary.BigEndian, uint16(206))
			_ = binary.Write(buf, binary.BigEndian, uint32(0))
			buf.Write(make([]byte, 6))
			writeNavicatTunnelIntegrationBlock(buf, "db.internal via TCP/IP")
			writeNavicatTunnelIntegrationBlock(buf, "10")
			writeNavicatTunnelIntegrationBlock(buf, "8.0.39")
			_, _ = w.Write(buf.Bytes())
		case "Q":
			encoded := r.PostForm.Get("q[]")
			decoded, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				t.Errorf("decode q[]: %v", err)
				return
			}
			queries <- string(decoded)
			_, _ = w.Write(navicatTunnelIntegrationQueryResponse("status", "executed"))
		default:
			t.Errorf("unexpected action %q", r.PostForm.Get("actn"))
		}
	}))
	defer server.Close()

	app := NewApp()
	result := app.DBQueryMulti(connection.ConnectionConfig{
		Type: "mysql", Host: "db.internal", Port: 3306, User: "root", Timeout: 2,
		UseHTTPTunnel: true,
		HTTPTunnel:    connection.HTTPTunnelConfig{Host: server.URL + "/ntunnel_mysql.php"},
	}, "inventory", "CALL refresh_inventory()", "navicat-call")
	if !result.Success {
		t.Fatalf("DBQueryMulti: %#v", result)
	}
	select {
	case query := <-queries:
		if query != "CALL refresh_inventory()" {
			t.Fatalf("tunneled query = %q", query)
		}
	default:
		t.Fatal("CALL was reported successful without an HTTP query request")
	}
}

func TestNavicatHTTPTunnelImportCapabilitiesDoNotPromiseCrossRequestSession(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
			return
		}
		if r.PostForm.Get("actn") != "C" {
			t.Errorf("unexpected action %q", r.PostForm.Get("actn"))
			return
		}
		buf := &bytes.Buffer{}
		_ = binary.Write(buf, binary.BigEndian, uint32(1111))
		_ = binary.Write(buf, binary.BigEndian, uint16(206))
		_ = binary.Write(buf, binary.BigEndian, uint32(0))
		buf.Write(make([]byte, 6))
		writeNavicatTunnelIntegrationBlock(buf, "db.internal via TCP/IP")
		writeNavicatTunnelIntegrationBlock(buf, "10")
		writeNavicatTunnelIntegrationBlock(buf, "8.0.39")
		_, _ = w.Write(buf.Bytes())
	}))
	defer server.Close()

	app := NewApp()
	capability := app.DataImportCapability(connection.ConnectionConfig{
		Type: "mysql", Host: "db.internal", Port: 3306, User: "root", Timeout: 2,
		UseHTTPTunnel: true,
		HTTPTunnel:    connection.HTTPTunnelConfig{Host: server.URL + "/ntunnel_mysql.php"},
	})
	if !capability.TableImport.Supported || capability.TableImport.SupportsTransactionalBatch {
		t.Fatalf("table import capability = %#v", capability.TableImport)
	}
	if capability.SQLFileImport.Supported || capability.SQLFileImport.Reason != DataImportReasonPinnedSessionUnavailable {
		t.Fatalf("SQL file capability = %#v", capability.SQLFileImport)
	}
}
