package ssh

import "time"

// RemoteDialFailure describes a failed connection from the SSH jump host to
// the configured remote endpoint. The local listener can only report a reset
// to its client, so retaining this detail makes tunnel verification errors
// actionable to database drivers.
type RemoteDialFailure struct {
	RemoteAddr string
	Err        error
	OccurredAt time.Time
}

func (f *LocalForwarder) diagnosticOwner() *LocalForwarder {
	if f == nil {
		return nil
	}
	if f.shared != nil {
		return f.shared
	}
	return f
}

// LastRemoteDialFailure returns the latest failed remote dial in the current
// diagnostic window, if one occurred.
func (f *LocalForwarder) LastRemoteDialFailure() (RemoteDialFailure, bool) {
	return f.RemoteDialFailureSince(time.Time{})
}

// RemoteDialFailureSince returns the latest remote dial failure after since.
// A zero since value returns the latest retained failure.
func (f *LocalForwarder) RemoteDialFailureSince(since time.Time) (RemoteDialFailure, bool) {
	owner := f.diagnosticOwner()
	if owner == nil {
		return RemoteDialFailure{}, false
	}
	owner.remoteDialFailureMu.RLock()
	failure := owner.remoteDialFailure
	owner.remoteDialFailureMu.RUnlock()
	if failure == nil || failure.Err == nil {
		return RemoteDialFailure{}, false
	}
	if !since.IsZero() && !failure.OccurredAt.After(since) {
		return RemoteDialFailure{}, false
	}
	return *failure, true
}

func (f *LocalForwarder) recordRemoteDialFailure(err error) {
	if f == nil || err == nil {
		return
	}
	owner := f.diagnosticOwner()
	if owner == nil {
		return
	}
	owner.remoteDialFailureMu.Lock()
	owner.remoteDialFailure = &RemoteDialFailure{RemoteAddr: owner.RemoteAddr, Err: err, OccurredAt: time.Now()}
	owner.remoteDialFailureMu.Unlock()
	owner.retireSessionOnChannelRejection(err)
}
