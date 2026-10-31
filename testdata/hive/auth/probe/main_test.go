//go:build gonavi_full_drivers || gonavi_hive_driver

package main

import (
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExpectedRejection(t *testing.T) {
	cases := []struct {
		name, expect string
		err          error
		want         bool
	}{
		{name: "unknown CA", expect: "tls-untrusted", err: fmt.Errorf("TLS: %w", x509.UnknownAuthorityError{}), want: true},
		{name: "hostname", expect: "tls-hostname", err: x509.HostnameError{Certificate: &x509.Certificate{}, Host: "other.test"}, want: true},
		{name: "wrong reason", expect: "tls-untrusted", err: errors.New("connection refused")},
		{name: "preauth", expect: "kdc-preauth-rejected", err: errors.New("KDC_ERR_PREAUTH_FAILED"), want: true},
		{name: "SPN", expect: "service-principal-rejected", err: errors.New("KDC_ERR_S_PRINCIPAL_UNKNOWN"), want: true},
		{name: "HS2 binary", expect: "hs2-auth-rejected", err: errors.New("Hive SASL authentication rejected (status 4)"), want: true},
		{name: "HS2 HTTP", expect: "hs2-auth-rejected", err: errors.New("Hive HTTP server returned status 401"), want: true},
		{name: "HTTP availability is not auth", expect: "hs2-auth-rejected", err: errors.New("Hive HTTP server returned status 503")},
		{name: "unknown expectation", expect: "any failure", err: errors.New("failed")},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := expectedRejection(test.expect, test.err); got != test.want {
				t.Fatalf("matched=%v want=%v", got, test.want)
			}
		})
	}
}

func TestRedactPassword(t *testing.T) {
	if got := redact("before fixture-value after fixture-value", "fixture-value"); strings.Contains(got, "fixture-value") {
		t.Fatal("password was not redacted")
	}
	if got := redact("public error", ""); got != "public error" {
		t.Fatal("empty password changed public error")
	}
}

func TestLoadConfigRejectsInlinePassword(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"connection":{"password":"fixture-not-a-real-credential"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfig(path); err == nil || !strings.Contains(err.Error(), "passwordFile") {
		t.Fatalf("inline credentials accepted: %v", err)
	}
}
