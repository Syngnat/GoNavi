package ssh

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	cryptossh "golang.org/x/crypto/ssh"
)

func TestGetOrCreateSSHClientCoalescesConcurrentColdStarts(t *testing.T) {
	config := connection.SSHConfig{
		Host:     "jump.example.test",
		Port:     22,
		User:     "tester",
		Password: "test-password",
	}
	key := newSSHClientCacheKey(config)
	fakeClient := &cryptossh.Client{}

	sshClientCacheMu.Lock()
	previousCache := sshClientCache
	sshClientCache = make(map[sshClientCacheKey]*cryptossh.Client)
	sshClientCacheMu.Unlock()
	previousConnect := connectSSHClient
	t.Cleanup(func() {
		connectSSHClient = previousConnect
		sshClientCacheMu.Lock()
		delete(sshClientCache, key)
		sshClientCache = previousCache
		sshClientCacheMu.Unlock()
	})

	connectStarted := make(chan struct{})
	releaseConnect := make(chan struct{})
	var connectOnce sync.Once
	var connectCalls atomic.Int32
	connectSSHClient = func(connection.SSHConfig) (*cryptossh.Client, error) {
		connectCalls.Add(1)
		connectOnce.Do(func() {
			close(connectStarted)
		})
		<-releaseConnect
		return fakeClient, nil
	}

	const callers = 32
	start := make(chan struct{})
	var ready sync.WaitGroup
	var done sync.WaitGroup
	ready.Add(callers)
	done.Add(callers)
	results := make(chan *cryptossh.Client, callers)
	errorsFound := make(chan error, callers)
	for range callers {
		go func() {
			defer done.Done()
			ready.Done()
			<-start
			client, err := GetOrCreateSSHClient(config)
			if err != nil {
				errorsFound <- err
				return
			}
			results <- client
		}()
	}
	ready.Wait()
	close(start)
	select {
	case <-connectStarted:
	case <-time.After(time.Second):
		t.Fatal("cold SSH client creation did not start")
	}
	// Keep the leader blocked long enough for every released caller to join
	// the same singleflight instead of observing the synthetic cached client.
	time.Sleep(100 * time.Millisecond)
	close(releaseConnect)
	done.Wait()
	close(results)
	close(errorsFound)

	for err := range errorsFound {
		t.Fatalf("GetOrCreateSSHClient returned error: %v", err)
	}
	for client := range results {
		if client != fakeClient {
			t.Fatalf("caller received unexpected SSH client %p, want %p", client, fakeClient)
		}
	}
	if got := connectCalls.Load(); got != 1 {
		t.Fatalf("connectSSH called %d times for one cold cache key, want 1", got)
	}
}
