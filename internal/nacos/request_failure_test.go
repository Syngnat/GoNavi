package nacos

import (
	"errors"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ssh"
)

// diagnosingForwarderLease is a forwarder lease that also reports the jump
// host's last failure to reach the remote endpoint.
type diagnosingForwarderLease struct {
	fakeNacosForwarderLease
	failure    ssh.RemoteDialFailure
	hasFailure bool
}

func (l *diagnosingForwarderLease) RemoteDialFailureSince(since time.Time) (ssh.RemoteDialFailure, bool) {
	if !l.hasFailure || !l.failure.OccurredAt.After(since) {
		return ssh.RemoteDialFailure{}, false
	}
	return l.failure, true
}

func TestRequestFailedErrorReportsJumpHostFailure(t *testing.T) {
	startedAt := time.Now().Add(-time.Second)
	localReset := errors.New(`Get "http://127.0.0.1:57132/nacos/v1/console/health/readiness": wsarecv: connection forcibly closed`)

	tests := []struct {
		name         string
		lease        nacosForwarderLease
		wantRemote   bool
		wantContains []string
	}{
		{
			name: "jump host refused the forward during this request",
			lease: &diagnosingForwarderLease{
				failure: ssh.RemoteDialFailure{
					RemoteAddr: "127.0.0.1:18848",
					Err:        errors.New("ssh: rejected: administratively prohibited (open failed)"),
					OccurredAt: time.Now(),
				},
				hasFailure: true,
			},
			wantRemote:   true,
			wantContains: []string{"127.0.0.1:18848", "administratively prohibited", "wsarecv"},
		},
		{
			name: "failure predating the request belongs to an earlier attempt",
			lease: &diagnosingForwarderLease{
				failure: ssh.RemoteDialFailure{
					RemoteAddr: "127.0.0.1:18848",
					Err:        errors.New("administratively prohibited"),
					OccurredAt: startedAt.Add(-time.Minute),
				},
				hasFailure: true,
			},
			wantContains: []string{"wsarecv"},
		},
		{
			name:         "lease without diagnostics keeps the plain request error",
			lease:        &fakeNacosForwarderLease{},
			wantContains: []string{"wsarecv"},
		},
		{
			name:         "direct connection without a tunnel",
			lease:        nil,
			wantContains: []string{"wsarecv"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &ClientImpl{sshForwarder: tt.lease}

			got := client.requestFailedError(localReset, "", startedAt).Error()

			for _, want := range tt.wantContains {
				if !strings.Contains(got, want) {
					t.Fatalf("error %q does not contain %q", got, want)
				}
			}
			plain := localizedNacosBackendText("nacos.backend.error.request_failed", map[string]any{"detail": localReset.Error()})
			if !tt.wantRemote && got != plain {
				t.Fatalf("error = %q, want the plain request failure %q", got, plain)
			}
			if tt.wantRemote && got == plain {
				t.Fatalf("error = %q, want the jump host failure reported", got)
			}
		})
	}
}

func TestRequestFailedErrorRedactsSecrets(t *testing.T) {
	client := &ClientImpl{sshForwarder: &diagnosingForwarderLease{
		failure: ssh.RemoteDialFailure{
			RemoteAddr: "127.0.0.1:18848",
			Err:        errors.New("dial failed password=remote-secret"),
			OccurredAt: time.Now(),
		},
		hasFailure: true,
	}}

	got := client.requestFailedError(errors.New("request accessToken=local-secret failed"), "local-secret", time.Now().Add(-time.Second)).Error()

	for _, secret := range []string{"remote-secret", "local-secret"} {
		if strings.Contains(got, secret) {
			t.Fatalf("error %q leaks %q", got, secret)
		}
	}
}
