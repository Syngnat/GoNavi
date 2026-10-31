//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"

	krbconfig "github.com/jcmturner/gokrb5/v8/config"
)

func TestHiveKerberosExplicitServiceRealmAndForwardedHost(t *testing.T) {
	cfg, err := normalizeHiveConfig(connection.ConnectionConfig{Host: "127.0.0.1", Port: 1234, ConnectionParams: "transportMode=http&authMode=KERBEROS&principal=HTTP%2F_HOST%40B.EXAMPLE"})
	if err != nil {
		t.Fatal(err)
	}
	conf := krbconfig.New()
	if err := hiveKerberosPrincipalRealm(conf, cfg.principal, "Original.Example"); err != nil {
		t.Fatal(err)
	}
	if got := conf.ResolveRealm("original.example"); got != "B.EXAMPLE" {
		t.Fatalf("explicit service realm ignored: %q", got)
	}
	if got := hiveServicePrincipal(cfg, "Original.Example", true); got != "HTTP/original.example" {
		t.Fatalf("forwarded SPN=%q", got)
	}
	transport, underlying, err := newHiveHTTPTransport(cfg, "Original.Example", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer underlying.CloseIdleConnections()
	httpTransport := transport.(*hiveHTTPTransport)
	if httpTransport.serverName != "Original.Example" || strings.Contains(httpTransport.spn, "127.0.0.1") {
		t.Fatalf("original service hostname lost: server=%q spn=%q", httpTransport.serverName, httpTransport.spn)
	}
	if err = hiveKerberosPrincipalRealm(conf, "hive/host@", "unused"); err == nil {
		t.Fatal("empty service realm accepted")
	}
}

func TestHiveComplexBinaryReadBoundary(t *testing.T) {
	payloads := []string{"{\"bytes\":\x00\ufffd}", "{\"payload\":\x00\",}\ufffd}", "[\x00\"]\ufffd]"}
	for i, kind := range []string{"MAP", "STRUCT", "ARRAY"} {
		if value, err := hiveNormalizeResultCell(payloads[i], kind); err == nil || value != nil {
			t.Fatalf("lossy server display accepted: %s = %v, %v", kind, value, err)
		}
	}
	if value, err := hiveNormalizeResultCell(nil, "MAP<STRING,BINARY>"); err != nil || value != nil {
		t.Fatalf("NULL must remain lossless: %v %v", value, err)
	}
	if _, err := hiveNormalizeResultCell("{\"bytes\":123}", "MAP<STRING,BINARY>"); err == nil {
		t.Fatal("JSON-looking binary bytes bypassed type preflight")
	}
	if value, err := hiveNormalizeResultCell("{\"amount\":12345678901234567890.1234}", "MAP<STRING,DECIMAL(38,4)>"); err != nil || value == nil {
		t.Fatalf("ordinary complex value rejected: %v", err)
	}
}
