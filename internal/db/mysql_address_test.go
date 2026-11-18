package db

import "testing"

func TestParseMySQLHostPort(t *testing.T) {
	tests := []struct {
		raw      string
		wantHost string
		wantPort int
		wantOK   bool
	}{
		{raw: "db.local:13306", wantHost: "db.local", wantPort: 13306, wantOK: true},
		{raw: "[2001:db8::1]:13306", wantHost: "2001:db8::1", wantPort: 13306, wantOK: true},
		{raw: "2001:db8::1", wantHost: "2001:db8::1", wantPort: 3306, wantOK: true},
		{raw: "db.local:BAD", wantOK: false},
		{raw: "db.local:70000", wantOK: false},
		{raw: "[2001:db8::1]:BAD", wantOK: false},
	}
	for _, test := range tests {
		t.Run(test.raw, func(t *testing.T) {
			host, port, ok := parseMySQLHostPort(test.raw, 3306)
			if ok != test.wantOK || host != test.wantHost || port != test.wantPort {
				t.Fatalf("parseMySQLHostPort(%q) = (%q,%d,%v), want (%q,%d,%v)",
					test.raw, host, port, ok, test.wantHost, test.wantPort, test.wantOK)
			}
		})
	}
}

func TestNormalizeMySQLAddressBracketsIPv6(t *testing.T) {
	if got := normalizeMySQLAddress("2001:db8::1", 3306); got != "[2001:db8::1]:3306" {
		t.Fatalf("IPv6 address = %q, want bracketed address", got)
	}
	if got := normalizeMySQLAddress("[2001:db8::1]", 3306); got != "[2001:db8::1]:3306" {
		t.Fatalf("bracketed IPv6 address = %q", got)
	}
}
