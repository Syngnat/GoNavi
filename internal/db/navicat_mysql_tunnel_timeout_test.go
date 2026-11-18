package db

import (
	"testing"
	"time"
)

func TestNavicatMySQLTunnelTransportBoundsHandshakeAndHeaders(t *testing.T) {
	transport := newNavicatMySQLTunnelTransport(7 * time.Second)
	if transport.TLSHandshakeTimeout != 7*time.Second || transport.ResponseHeaderTimeout != 7*time.Second {
		t.Fatalf("tunnel transport timeouts = tls:%s headers:%s, want 7s",
			transport.TLSHandshakeTimeout, transport.ResponseHeaderTimeout)
	}
}
