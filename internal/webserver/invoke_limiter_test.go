package webserver

import "testing"

func newTestInvokeLimiter(global int, perUser int) *invokeLimiter {
	return &invokeLimiter{
		limit:        global,
		perUserLimit: perUser,
		perUser:      make(map[string]int),
	}
}

func TestInvokeLimiterEnforcesGlobalLimit(t *testing.T) {
	limiter := newTestInvokeLimiter(2, 10)
	releaseA, ok := limiter.acquire("alice")
	if !ok {
		t.Fatal("first acquire failed")
	}
	releaseB, ok := limiter.acquire("bob")
	if !ok {
		t.Fatal("second acquire failed")
	}
	if _, ok := limiter.acquire("carol"); ok {
		t.Fatal("expected global limit to reject the third request")
	}
	releaseA()
	if _, ok := limiter.acquire("carol"); !ok {
		t.Fatal("expected released slot to admit a new request")
	}
	releaseB()
}

func TestInvokeLimiterEnforcesPerUserLimit(t *testing.T) {
	limiter := newTestInvokeLimiter(10, 1)
	release, ok := limiter.acquire("alice")
	if !ok {
		t.Fatal("first user acquire failed")
	}
	if _, ok := limiter.acquire("alice"); ok {
		t.Fatal("expected per-user limit to reject the second request")
	}
	other, ok := limiter.acquire("bob")
	if !ok {
		t.Fatal("expected another user to get a slot")
	}
	other()
	release()
	if _, ok := limiter.acquire("alice"); !ok {
		t.Fatal("expected release to restore the user slot")
	}
}

func TestInvokeLimiterReleaseIsIdempotent(t *testing.T) {
	limiter := newTestInvokeLimiter(1, 1)
	release, ok := limiter.acquire("alice")
	if !ok {
		t.Fatal("acquire failed")
	}
	release()
	release()
	release, ok = limiter.acquire("alice")
	if !ok {
		t.Fatal("expected double release not to corrupt the counters")
	}
	release()
}
