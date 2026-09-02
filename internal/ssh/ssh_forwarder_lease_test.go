package ssh

import (
	"errors"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestLocalForwarderRemoteDialFailureCanBeReadByLeaseAndWindow(t *testing.T) {
	shared := &LocalForwarder{RemoteAddr: "127.0.0.1:21433"}
	lease := &LocalForwarder{LocalAddr: "127.0.0.1:58228", RemoteAddr: shared.RemoteAddr, shared: shared}
	failure := errors.New("connection refused")
	startedAt := time.Now()

	lease.recordRemoteDialFailure(failure)
	got, ok := lease.LastRemoteDialFailure()
	if !ok {
		t.Fatal("LastRemoteDialFailure() did not report the recorded failure")
	}
	if got.RemoteAddr != shared.RemoteAddr || !errors.Is(got.Err, failure) {
		t.Fatalf("unexpected remote dial failure: got=%+v", got)
	}
	if got.OccurredAt.Before(startedAt) {
		t.Fatalf("failure timestamp %v precedes diagnostic window %v", got.OccurredAt, startedAt)
	}
	if gotSince, ok := lease.RemoteDialFailureSince(startedAt); !ok || !errors.Is(gotSince.Err, failure) {
		t.Fatalf("RemoteDialFailureSince() did not report the failure in-window: got=%+v ok=%t", gotSince, ok)
	}
	if _, ok := lease.RemoteDialFailureSince(got.OccurredAt); ok {
		t.Fatal("RemoteDialFailureSince() returned an event at the window boundary")
	}

}

func TestSharedLocalForwarderStaysOpenUntilLastLeaseCloses(t *testing.T) {
	sshConfig := connection.SSHConfig{
		Host:     "jump.example.test",
		Port:     22,
		User:     "tester",
		Password: "test-password",
	}
	const (
		remoteHost = "database.internal.test"
		remotePort = 5432
	)

	shared := installCachedLocalForwarderForTest(t, sshConfig, remoteHost, remotePort)

	first, err := AcquireLocalForwarder(sshConfig, remoteHost, remotePort)
	if err != nil {
		t.Fatalf("first AcquireLocalForwarder() error = %v", err)
	}
	second, err := AcquireLocalForwarder(sshConfig, remoteHost, remotePort)
	if err != nil {
		t.Fatalf("second AcquireLocalForwarder() error = %v", err)
	}
	if first == second {
		t.Fatal("separate acquisitions returned the same lease object")
	}
	if first.LocalAddr != second.LocalAddr {
		t.Fatalf("leases did not share one listener: first=%s second=%s", first.LocalAddr, second.LocalAddr)
	}

	if err := first.Release(); err != nil {
		t.Fatalf("first Release() error = %v", err)
	}
	if second.IsClosed() {
		t.Fatal("closing one lease closed the shared forwarder while another lease was active")
	}
	assertTCPListenerAcceptsConnections(t, second.LocalAddr)

	if err := second.Release(); err != nil {
		t.Fatalf("second Release() error = %v", err)
	}
	if !shared.IsClosed() {
		t.Fatal("last lease did not close the shared forwarder")
	}
	assertTCPListenerClosed(t, shared.LocalAddr)
	assertForwarderEvicted(t, sshConfig, remoteHost, remotePort)
}

func TestCloseAllForwardersForceClosesActiveLeases(t *testing.T) {
	sshConfig := connection.SSHConfig{
		Host:     "jump.example.test",
		Port:     22,
		User:     "tester",
		Password: "test-password",
	}
	const (
		remoteHost = "database.internal.test"
		remotePort = 5432
	)

	shared := installCachedLocalForwarderForTest(t, sshConfig, remoteHost, remotePort)
	first, err := AcquireLocalForwarder(sshConfig, remoteHost, remotePort)
	if err != nil {
		t.Fatalf("first AcquireLocalForwarder() error = %v", err)
	}
	second, err := AcquireLocalForwarder(sshConfig, remoteHost, remotePort)
	if err != nil {
		t.Fatalf("second AcquireLocalForwarder() error = %v", err)
	}

	CloseAllForwarders()

	if !shared.IsClosed() || !first.IsClosed() || !second.IsClosed() {
		t.Fatal("CloseAllForwarders() did not force-close the shared forwarder")
	}
	assertTCPListenerClosed(t, shared.LocalAddr)
	assertForwarderEvicted(t, sshConfig, remoteHost, remotePort)

	if err := first.Release(); err != nil {
		t.Fatalf("releasing first lease after CloseAllForwarders() error = %v", err)
	}
	if err := second.Release(); err != nil {
		t.Fatalf("releasing second lease after CloseAllForwarders() error = %v", err)
	}
}

func TestLocalForwarderLeaseReferenceCountIsThreadSafe(t *testing.T) {
	sshConfig := connection.SSHConfig{
		Host:     "jump.example.test",
		Port:     22,
		User:     "tester",
		Password: "test-password",
	}
	const (
		remoteHost = "database.internal.test"
		remotePort = 5432
		leaseCount = 32
	)

	shared := installCachedLocalForwarderForTest(t, sshConfig, remoteHost, remotePort)
	keeper, err := AcquireLocalForwarder(sshConfig, remoteHost, remotePort)
	if err != nil {
		t.Fatalf("keeper AcquireLocalForwarder() error = %v", err)
	}

	leases := make(chan *LocalForwarder, leaseCount)
	errs := make(chan error, leaseCount)
	var acquireWG sync.WaitGroup
	for range leaseCount {
		acquireWG.Add(1)
		go func() {
			defer acquireWG.Done()
			lease, acquireErr := AcquireLocalForwarder(sshConfig, remoteHost, remotePort)
			if acquireErr != nil {
				errs <- acquireErr
				return
			}
			leases <- lease
		}()
	}
	acquireWG.Wait()
	close(leases)
	close(errs)
	for acquireErr := range errs {
		t.Fatalf("AcquireLocalForwarder() error = %v", acquireErr)
	}

	var releaseWG sync.WaitGroup
	releaseErrs := make(chan error, leaseCount*2)
	for lease := range leases {
		lease := lease
		for range 2 {
			releaseWG.Add(1)
			go func() {
				defer releaseWG.Done()
				if releaseErr := lease.Release(); releaseErr != nil {
					releaseErrs <- releaseErr
				}
			}()
		}
	}
	releaseWG.Wait()
	close(releaseErrs)
	for releaseErr := range releaseErrs {
		t.Fatalf("Release() error = %v", releaseErr)
	}

	if shared.IsClosed() {
		t.Fatal("concurrent release closed the forwarder while the keeper lease was active")
	}
	assertTCPListenerAcceptsConnections(t, keeper.LocalAddr)

	if err := keeper.Release(); err != nil {
		t.Fatalf("keeper Release() error = %v", err)
	}
	if !shared.IsClosed() {
		t.Fatal("releasing the final keeper lease did not close the shared forwarder")
	}
	assertForwarderEvicted(t, sshConfig, remoteHost, remotePort)
}

func installCachedLocalForwarderForTest(
	t *testing.T,
	sshConfig connection.SSHConfig,
	remoteHost string,
	remotePort int,
) *LocalForwarder {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	forwarder := &LocalForwarder{
		LocalAddr:  listener.Addr().String(),
		RemoteAddr: net.JoinHostPort(remoteHost, strconv.Itoa(remotePort)),
		listener:   listener,
		closeChan:  make(chan struct{}),
	}
	key := forwarderCacheKey{
		ssh:        newSSHClientCacheKey(sshConfig),
		remoteHost: remoteHost,
		remotePort: remotePort,
	}

	forwarderMu.Lock()
	previous := localForwarders
	localForwarders = map[forwarderCacheKey]*LocalForwarder{key: forwarder}
	forwarderMu.Unlock()

	t.Cleanup(func() {
		CloseAllForwarders()
		forwarderMu.Lock()
		localForwarders = previous
		forwarderMu.Unlock()
	})
	return forwarder
}

func assertTCPListenerAcceptsConnections(t *testing.T, address string) {
	t.Helper()

	conn, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatalf("expected active lease to keep %s reachable: %v", address, err)
	}
	_ = conn.Close()
}

func assertTCPListenerClosed(t *testing.T, address string) {
	t.Helper()

	conn, err := net.DialTimeout("tcp", address, 100*time.Millisecond)
	if err != nil {
		return
	}
	_ = conn.Close()
	t.Fatalf("expected closed forwarder listener at %s to reject connections", address)
}

func assertForwarderEvicted(
	t *testing.T,
	sshConfig connection.SSHConfig,
	remoteHost string,
	remotePort int,
) {
	t.Helper()

	key := forwarderCacheKey{
		ssh:        newSSHClientCacheKey(sshConfig),
		remoteHost: remoteHost,
		remotePort: remotePort,
	}
	forwarderMu.RLock()
	_, exists := localForwarders[key]
	forwarderMu.RUnlock()
	if exists {
		t.Fatal("closed shared forwarder remained in cache")
	}
}
