//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveHTTPSSHAuthorityPreservesHostCookiesAndSNI(t *testing.T) {
	const originalHost = "hive.virtual.invalid"
	var mu sync.Mutex
	requests := 0
	var names []string
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		mu.Lock()
		defer mu.Unlock()
		requests++
		if r.Host != originalHost+":8443" {
			t.Errorf("forwarded authority escaped into HTTP Host: %q", r.Host)
		}
		if requests == 1 {
			http.SetCookie(w, &http.Cookie{Name: "hive.server2.auth", Value: "accepted", Domain: originalHost, Path: "/", Secure: true})
		} else if cookie, err := r.Cookie("hive.server2.auth"); err != nil || cookie.Value != "accepted" {
			t.Errorf("original-domain auth cookie was lost: %v", err)
		}
		w.Write([]byte("reply"))
	}))
	server.TLS = &tls.Config{GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		mu.Lock()
		names = append(names, hello.ServerName)
		mu.Unlock()
		return nil, nil
	}}
	server.StartTLS()
	defer server.Close()
	cfg, err := normalizeHiveConfig(connection.ConnectionConfig{Host: originalHost, Port: 8443, UseSSL: true, SSLMode: "skip-verify", ConnectionParams: "transportMode=http&authMode=NONE"})
	if err != nil {
		t.Fatal(err)
	}
	forwardedHost, forwardedPort, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	cfg.Host = forwardedHost
	cfg.Port, err = strconv.Atoi(forwardedPort)
	if err != nil {
		t.Fatal(err)
	}
	cfg.dialAddress = server.Listener.Addr().String()
	transport, pool, err := newHiveHTTPTransport(cfg, originalHost, &tls.Config{InsecureSkipVerify: true, ServerName: originalHost}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.CloseIdleConnections()
	defer transport.Close()
	for i := 0; i < 2; i++ {
		if _, err = transport.Write([]byte("request")); err != nil {
			t.Fatal(err)
		}
		if err = transport.Flush(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if requests != 2 || len(names) == 0 {
		t.Fatalf("HTTP requests=%d TLS names=%v", requests, names)
	}
	for _, name := range names {
		if name != originalHost {
			t.Fatalf("original TLS name lost: %q", name)
		}
	}
}
