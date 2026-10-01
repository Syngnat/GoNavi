package ssh

import (
	"errors"
	"time"

	"GoNavi-Wails/internal/logger"

	"golang.org/x/crypto/ssh"
)

// sshClientFreshWindow protects a just-authenticated session from being
// retired. Forwarding policy such as sshd PermitOpen and authorized_keys
// permitopen is read once at login, so a session that authenticated after the
// server changed already reflects the current policy; a rejection on it is a
// real denial and retrying with yet another login cannot help.
const sshClientFreshWindow = 10 * time.Second

var (
	// sshClientBornAt records when each cached client finished authenticating.
	// Guarded by sshClientCacheMu.
	sshClientBornAt = make(map[*ssh.Client]time.Time)
	// retiredSSHClients holds sessions dropped from the cache after the server
	// refused a forward. They are not closed on retirement because other
	// tunnels and database connections may still be running on them; they are
	// released by CloseAllSSHClients. Guarded by sshClientCacheMu.
	retiredSSHClients []*ssh.Client
)

// isChannelRejected reports whether the SSH server refused to open a
// forwarding channel by policy ("administratively prohibited").
func isChannelRejected(err error) bool {
	var openErr *ssh.OpenChannelError
	return errors.As(err, &openErr) && openErr.Reason == ssh.Prohibited
}

// retireIfChannelRejected drops client from the cache when err shows the
// server denied a forward on it, so the next acquisition authenticates again
// and picks up the server's current forwarding policy. It reports whether the
// session was retired.
func retireIfChannelRejected(client *ssh.Client, err error) bool {
	if client == nil || !isChannelRejected(err) {
		return false
	}
	sshClientCacheMu.Lock()
	defer sshClientCacheMu.Unlock()

	if bornAt, ok := sshClientBornAt[client]; ok && time.Since(bornAt) < sshClientFreshWindow {
		return false
	}
	for key, cached := range sshClientCache {
		if cached != client {
			continue
		}
		delete(sshClientCache, key)
		delete(sshClientBornAt, client)
		retiredSSHClients = append(retiredSSHClients, client)
		logger.Warnf("SSH 服务器拒绝转发，已废弃缓存的 SSH 会话，下次连接将重新认证：%s (错误: %v)", formatSSHClientKeyForLog(key), err)
		return true
	}
	return false
}

// retireSessionOnChannelRejection retires the session behind a forwarder whose
// remote dial was refused and closes the forwarder's listener, so that
// AcquireLocalForwarder builds a new forwarder on the fresh session instead of
// handing out one bound to the retired session. Called on the diagnostic owner.
func (f *LocalForwarder) retireSessionOnChannelRejection(err error) {
	if f == nil || !retireIfChannelRejected(f.SSHClient, err) {
		return
	}
	_ = f.closeUnderlying()
}

// resetSSHClientBookkeepingLocked closes retired sessions and clears their
// bookkeeping. The caller must hold sshClientCacheMu for writing.
func resetSSHClientBookkeepingLocked() {
	for _, client := range retiredSSHClients {
		_ = client.Close()
	}
	retiredSSHClients = nil
	sshClientBornAt = make(map[*ssh.Client]time.Time)
}
