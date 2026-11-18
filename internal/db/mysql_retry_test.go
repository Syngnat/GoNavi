package db

import (
	"context"
	"errors"
	"testing"
)

func TestShouldRetryMySQLCompatibilityPlan(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "timeout", err: errors.New("dial tcp 10.0.0.8:3306: i/o timeout"), want: false},
		{name: "context deadline", err: context.DeadlineExceeded, want: false},
		{name: "refused", err: errors.New("connect: connection refused"), want: false},
		{name: "no route", err: errors.New("connect: no route to host"), want: false},
		{name: "auth", err: errors.New("Error 1045: Access denied for user"), want: false},
		{name: "unknown database", err: errors.New("Error 1049: Unknown database"), want: false},
		{name: "tls", err: errors.New("tls: failed to verify certificate: x509"), want: false},
		{name: "invalid connection", err: errors.New("invalid connection"), want: false},
		{name: "unexpected eof", err: errors.New("unexpected EOF"), want: false},
		{name: "protocol compatibility", err: errors.New("handshake protocol capability unsupported"), want: true},
		{name: "generic server error", err: errors.New("server rejected connection mode"), want: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldRetryMySQLCompatibilityPlan(test.err); got != test.want {
				t.Fatalf("shouldRetryMySQLCompatibilityPlan(%v) = %v, want %v", test.err, got, test.want)
			}
		})
	}
}
