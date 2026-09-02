package db

import (
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/ssh"
)

// wrapDatabaseConnectionVerifyErrorWithForwarder preserves the normal
// localized verification prefix while replacing an opaque local connection
// reset with the remote endpoint that the SSH jump host actually failed to
// reach. The original ping error remains wrapped for callers that inspect it.
func wrapDatabaseConnectionVerifyErrorWithForwarder(err error, forwarder *ssh.LocalForwarder, since time.Time) error {
	if err == nil {
		return nil
	}
	if forwarder == nil {
		return wrapDatabaseConnectionVerifyError(err)
	}
	failure, ok := forwarder.RemoteDialFailureSince(since)
	if ok && strings.TrimSpace(failure.RemoteAddr) != "" {
		return wrapDatabaseConnectionVerifyErrorWithRemoteDialFailure(err, forwarder.LocalAddr, failure)
	}
	// A successful SSH dial can still be followed by a database handshake
	// failure. In that case there is no RemoteDialFailure to report, but the
	// configured remote endpoint is still more useful than the local ephemeral
	// client/listener pair emitted by database/sql.
	if remoteAddr := strings.TrimSpace(forwarder.RemoteAddr); remoteAddr != "" {
		return wrapDatabaseConnectionVerifyErrorWithRemoteTarget(err, forwarder.LocalAddr, remoteAddr)
	}
	return wrapDatabaseConnectionVerifyError(err)
}

func wrapDatabaseConnectionVerifyErrorWithRemoteTarget(err error, localAddr, remoteAddr string) error {
	if err == nil {
		return nil
	}
	remoteAddr = strings.TrimSpace(remoteAddr)
	if remoteAddr == "" {
		return wrapDatabaseConnectionVerifyError(err)
	}
	prefix := localizedDriverRuntimeText("db.backend.error.connection_verify_failed_prefix", nil)
	localAddr = strings.TrimSpace(localAddr)
	if localAddr == "" {
		localAddr = "SSH local listener"
	}
	message := localizedDriverRuntimeText("db.backend.error.ssh_tunnel_remote_target_verify_failed", map[string]any{
		"localAddr":  localAddr,
		"remoteAddr": remoteAddr,
	})
	return fmt.Errorf("%s%s%w", prefix, message, err)
}

func wrapDatabaseConnectionVerifyErrorWithRemoteDialFailure(err error, localAddr string, failure ssh.RemoteDialFailure) error {
	if err == nil {
		return nil
	}
	if strings.TrimSpace(failure.RemoteAddr) == "" {
		return wrapDatabaseConnectionVerifyError(err)
	}
	prefix := localizedDriverRuntimeText("db.backend.error.connection_verify_failed_prefix", nil)
	localAddr = strings.TrimSpace(localAddr)
	if localAddr == "" {
		localAddr = "SSH local listener"
	}
	message := localizedDriverRuntimeText("db.backend.error.ssh_tunnel_remote_dial_failed", map[string]any{
		"localAddr":   localAddr,
		"remoteAddr":  strings.TrimSpace(failure.RemoteAddr),
		"remoteError": failure.Err,
	})
	return fmt.Errorf("%s%s%w", prefix, message, err)
}
