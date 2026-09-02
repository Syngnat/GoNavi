//go:build darwin && cgo

package app

import (
	"strings"
	"testing"
)

func TestProxyURLFromDarwinSystemResult(t *testing.T) {
	tests := []struct {
		name       string
		result     darwinSystemProxyResult
		wantURL    string
		wantErr    string
		wantDirect bool
	}{
		{
			name:    "secure web proxy uses HTTP CONNECT proxy URL",
			result:  darwinSystemProxyResult{kind: darwinSystemProxyHTTP, host: "127.0.0.1", port: 7890},
			wantURL: "http://127.0.0.1:7890",
		},
		{
			name:    "SOCKS proxy",
			result:  darwinSystemProxyResult{kind: darwinSystemProxySOCKS, host: "::1", port: 1080},
			wantURL: "socks5://[::1]:1080",
		},
		{
			name:       "direct",
			result:     darwinSystemProxyResult{kind: darwinSystemProxyDirect},
			wantDirect: true,
		},
		{
			name:    "PAC fails closed",
			result:  darwinSystemProxyResult{kind: darwinSystemProxyPAC},
			wantErr: "PAC",
		},
		{
			name:    "missing host",
			result:  darwinSystemProxyResult{kind: darwinSystemProxyHTTP, port: 7890},
			wantErr: "host is empty",
		},
		{
			name:    "invalid port",
			result:  darwinSystemProxyResult{kind: darwinSystemProxySOCKS, host: "127.0.0.1", port: 0},
			wantErr: "port is invalid",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := proxyURLFromDarwinSystemResult(tt.result)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("expected error containing %q, got %v", tt.wantErr, err)
				}
				if got != nil {
					t.Fatalf("expected no proxy URL on error, got %v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("convert system proxy: %v", err)
			}
			if tt.wantDirect {
				if got != nil {
					t.Fatalf("expected direct connection, got %v", got)
				}
				return
			}
			if got == nil || got.String() != tt.wantURL {
				t.Fatalf("expected %q, got %v", tt.wantURL, got)
			}
		})
	}
}
