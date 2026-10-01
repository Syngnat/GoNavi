package nacos

import (
	"strings"
	"time"

	"GoNavi-Wails/internal/ssh"
)

// remoteDialFailureReporter is implemented by SSH forwarder leases that keep
// the latest failure of the jump host reaching the Nacos endpoint.
type remoteDialFailureReporter interface {
	RemoteDialFailureSince(since time.Time) (ssh.RemoteDialFailure, bool)
}

// RemoteDialFailureSince exposes the underlying forwarder's diagnostics.
func (l *localForwarderLeaseAdapter) RemoteDialFailureSince(since time.Time) (ssh.RemoteDialFailure, bool) {
	if l == nil || l.forwarder == nil {
		return ssh.RemoteDialFailure{}, false
	}
	return l.forwarder.RemoteDialFailureSince(since)
}

// requestFailedError builds the error for an HTTP transport failure. Through an
// SSH tunnel the local listener can only report a connection reset, so when the
// jump host failed to reach Nacos during this request the remote cause is put
// first; otherwise the caller sees an opaque local socket error.
func (c *ClientImpl) requestFailedError(err error, token string, startedAt time.Time) error {
	detail := redactNacosAccessToken(err.Error(), token)

	c.mu.Lock()
	lease := c.sshForwarder
	c.mu.Unlock()
	if reporter, ok := lease.(remoteDialFailureReporter); ok {
		failure, found := reporter.RemoteDialFailureSince(startedAt)
		if found && strings.TrimSpace(failure.RemoteAddr) != "" {
			return localizedNacosBackendError("nacos.backend.error.ssh_tunnel_remote_dial_failed", map[string]any{
				"remoteAddr":  strings.TrimSpace(failure.RemoteAddr),
				"remoteError": redactNacosErrorText(failure.Err.Error()),
				"detail":      detail,
			})
		}
	}
	return localizedNacosBackendError("nacos.backend.error.request_failed", map[string]any{
		"detail": detail,
	})
}
