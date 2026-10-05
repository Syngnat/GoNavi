package webserver

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

type loginAttemptState struct {
	Failures     []time.Time
	BlockedUntil time.Time
}

type loginAttemptTracker struct {
	mu       sync.Mutex
	attempts map[string]loginAttemptState
}

func newLoginAttemptTracker() *loginAttemptTracker {
	return &loginAttemptTracker{attempts: make(map[string]loginAttemptState)}
}

func (t *loginAttemptTracker) allow(ip string, now time.Time) (time.Duration, bool) {
	normalized := strings.TrimSpace(ip)
	if normalized == "" {
		return 0, true
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	state := t.attempts[normalized]
	if state.BlockedUntil.After(now) {
		return state.BlockedUntil.Sub(now), false
	}
	if len(state.Failures) == 0 {
		delete(t.attempts, normalized)
		return 0, true
	}
	kept := state.Failures[:0]
	for _, failureAt := range state.Failures {
		if now.Sub(failureAt) <= webLoginFailureWindow {
			kept = append(kept, failureAt)
		}
	}
	state.Failures = append([]time.Time(nil), kept...)
	if len(state.Failures) == 0 {
		delete(t.attempts, normalized)
		return 0, true
	}
	t.attempts[normalized] = state
	return 0, true
}

func (t *loginAttemptTracker) recordFailure(ip string, now time.Time) time.Duration {
	normalized := strings.TrimSpace(ip)
	if normalized == "" {
		return 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	state := t.attempts[normalized]
	kept := state.Failures[:0]
	for _, failureAt := range state.Failures {
		if now.Sub(failureAt) <= webLoginFailureWindow {
			kept = append(kept, failureAt)
		}
	}
	kept = append(kept, now)
	state.Failures = append([]time.Time(nil), kept...)
	if len(state.Failures) >= webLoginFailureLimit {
		state.Failures = nil
		state.BlockedUntil = now.Add(webLoginBlockDuration)
		t.attempts[normalized] = state
		t.sweepExpiredLocked(now)
		return webLoginBlockDuration
	}
	t.attempts[normalized] = state
	t.sweepExpiredLocked(now)
	return 0
}

// sweepExpiredLocked 在条目数超过上限时清理已失效的记录。
// 条目仅在登录成功或同一 key 再次进入 allow() 时才会被删除，
// 分布式来源（僵尸网络）下 map 会单向增长，故补一道容量触发的清扫。
// 调用方必须已持有 t.mu。
func (t *loginAttemptTracker) sweepExpiredLocked(now time.Time) {
	if len(t.attempts) <= webLoginAttemptTrackerMaxEntries {
		return
	}
	for key, state := range t.attempts {
		if state.BlockedUntil.After(now) {
			continue
		}
		fresh := false
		for _, failureAt := range state.Failures {
			if now.Sub(failureAt) <= webLoginFailureWindow {
				fresh = true
				break
			}
		}
		if !fresh {
			delete(t.attempts, key)
		}
	}
}

func (t *loginAttemptTracker) recordSuccess(ip string) {
	normalized := strings.TrimSpace(ip)
	if normalized == "" {
		return
	}
	t.mu.Lock()
	delete(t.attempts, normalized)
	t.mu.Unlock()
}

type webSession struct {
	ID               string
	CreatedAt        time.Time
	LastSeenAt       time.Time
	AbsoluteDeadline time.Time
}

type webSessionManager struct {
	mu       sync.Mutex
	sessions map[string]webSession
}

func newWebSessionManager() *webSessionManager {
	return &webSessionManager{sessions: make(map[string]webSession)}
}

func (m *webSessionManager) Create(cfg webAuthConfig, now time.Time) (string, error) {
	if m == nil {
		return "", fmt.Errorf("web session manager is unavailable")
	}
	sessionID, err := generateRandomToken(32)
	if err != nil {
		return "", err
	}
	session := webSession{
		ID:               sessionID,
		CreatedAt:        now,
		LastSeenAt:       now,
		AbsoluteDeadline: now.Add(cfg.AbsoluteTimeout()),
	}
	m.mu.Lock()
	m.sessions[sessionID] = session
	m.mu.Unlock()
	return sessionID, nil
}

func (m *webSessionManager) Authenticate(sessionID string, cfg webAuthConfig, now time.Time) bool {
	normalized := strings.TrimSpace(sessionID)
	if m == nil || normalized == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, session := range m.sessions {
		if now.After(session.AbsoluteDeadline) || now.Sub(session.LastSeenAt) > cfg.IdleTimeout() {
			delete(m.sessions, key)
		}
	}
	session, ok := m.sessions[normalized]
	if !ok {
		return false
	}
	session.LastSeenAt = now
	m.sessions[normalized] = session
	return true
}

func (m *webSessionManager) Destroy(sessionID string) {
	normalized := strings.TrimSpace(sessionID)
	if m == nil || normalized == "" {
		return
	}
	m.mu.Lock()
	delete(m.sessions, normalized)
	m.mu.Unlock()
}

func (m *webSessionManager) DestroyAll() {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.sessions = make(map[string]webSession)
	m.mu.Unlock()
}
