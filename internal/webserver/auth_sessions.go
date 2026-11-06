package webserver

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/logger"
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
	Username         string
	Role             string
	CreatedAt        time.Time
	LastSeenAt       time.Time
	AbsoluteDeadline time.Time
}

type webSessionManager struct {
	mu          sync.Mutex
	sessions    map[string]webSession
	store       *webSessionStore
	lastPersist time.Time
	lastReload  time.Time
	dirtyIDs    map[string]struct{}
	deletedIDs  map[string]struct{}
}

func newWebSessionManager() *webSessionManager {
	return &webSessionManager{
		sessions:   make(map[string]webSession),
		dirtyIDs:   make(map[string]struct{}),
		deletedIDs: make(map[string]struct{}),
	}
}

// newWebSessionManagerWithStore 恢复上次进程留下的会话，让服务重启后
// 已登录的浏览器不必全部重新登录。恢复失败时退化为纯内存会话。
func newWebSessionManagerWithStore(root string) *webSessionManager {
	manager := newWebSessionManager()
	manager.store = newWebSessionStore(root)
	loaded, err := manager.store.Load()
	if err != nil {
		logger.Warnf("读取 Web 会话存储失败，回退为内存会话：%v", err)
		return manager
	}
	for _, session := range loaded {
		manager.sessions[session.ID] = session
	}
	return manager
}

// reloadLocked 从共享文件拉取其他副本创建/删除的会话。
//
// 多副本部署时每个进程各有一份内存表；没有这个同步，A 副本登录的会话在
// B 副本上会被当作未认证。5 秒的刷新窗口让删除/停用也能在副本间传播。
func (m *webSessionManager) reloadLocked(now time.Time, force bool) {
	if m == nil || m.store == nil {
		return
	}
	if !force && now.Sub(m.lastReload) < 5*time.Second {
		return
	}
	persisted, err := m.store.Load()
	if err != nil {
		logger.Warnf("读取共享 Web 会话失败：%v", err)
		return
	}
	fileSessions := make(map[string]webSession, len(persisted))
	for _, session := range persisted {
		fileSessions[session.ID] = session
	}
	for id := range m.sessions {
		if _, dirty := m.dirtyIDs[id]; dirty {
			continue
		}
		if _, exists := fileSessions[id]; !exists {
			delete(m.sessions, id)
		}
	}
	for id, session := range fileSessions {
		if _, exists := m.sessions[id]; !exists {
			m.sessions[id] = session
		}
	}
	m.lastReload = now
}

// persistLocked 把本副本改动过的会话合并回共享文件。
// force=false 时最多每分钟落盘一次，避免每个请求都因 lastSeenAt 更新而写盘。
func (m *webSessionManager) persistLocked(force bool, now time.Time) {
	if m == nil || m.store == nil {
		return
	}
	if !force && now.Sub(m.lastPersist) < time.Minute {
		return
	}
	if len(m.dirtyIDs) == 0 && len(m.deletedIDs) == 0 {
		return
	}
	dirty := make([]string, 0, len(m.dirtyIDs))
	for id := range m.dirtyIDs {
		dirty = append(dirty, id)
	}
	deleted := make([]string, 0, len(m.deletedIDs))
	for id := range m.deletedIDs {
		deleted = append(deleted, id)
	}
	err := m.store.Update(func(current []webSession) ([]webSession, error) {
		merged := make(map[string]webSession, len(current)+len(dirty))
		for _, session := range current {
			merged[session.ID] = session
		}
		for _, id := range deleted {
			delete(merged, id)
		}
		for _, id := range dirty {
			if session, ok := m.sessions[id]; ok {
				merged[session.ID] = session
			}
		}
		sessions := make([]webSession, 0, len(merged))
		for _, session := range merged {
			sessions = append(sessions, session)
		}
		sort.Slice(sessions, func(left, right int) bool {
			return sessions[left].LastSeenAt.After(sessions[right].LastSeenAt)
		})
		return sessions, nil
	})
	if err != nil {
		logger.Warnf("写入共享 Web 会话失败：%v", err)
		return
	}
	m.lastPersist = now
	m.dirtyIDs = make(map[string]struct{})
	m.deletedIDs = make(map[string]struct{})
}

func (m *webSessionManager) Create(cfg webAuthConfig, username string, role string, now time.Time) (string, error) {
	if m == nil {
		return "", fmt.Errorf("web session manager is unavailable")
	}
	sessionID, err := generateRandomToken(32)
	if err != nil {
		return "", err
	}
	session := webSession{
		ID:               sessionID,
		Username:         username,
		Role:             role,
		CreatedAt:        now,
		LastSeenAt:       now,
		AbsoluteDeadline: now.Add(cfg.AbsoluteTimeout()),
	}
	m.mu.Lock()
	m.sessions[sessionID] = session
	m.dirtyIDs[sessionID] = struct{}{}
	m.persistLocked(true, now)
	m.mu.Unlock()
	return sessionID, nil
}

func (m *webSessionManager) Authenticate(sessionID string, cfg webAuthConfig, now time.Time) (webSession, bool) {
	normalized := strings.TrimSpace(sessionID)
	if m == nil || normalized == "" {
		return webSession{}, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reloadLocked(now, false)
	for key, session := range m.sessions {
		if now.After(session.AbsoluteDeadline) || now.Sub(session.LastSeenAt) > cfg.IdleTimeout() {
			delete(m.sessions, key)
			m.deletedIDs[key] = struct{}{}
			delete(m.dirtyIDs, key)
		}
	}
	session, ok := m.sessions[normalized]
	if !ok {
		m.reloadLocked(now, true)
		session, ok = m.sessions[normalized]
	}
	if !ok {
		return webSession{}, false
	}
	session.LastSeenAt = now
	m.sessions[normalized] = session
	m.dirtyIDs[normalized] = struct{}{}
	m.persistLocked(false, now)
	return session, true
}

func (m *webSessionManager) Destroy(sessionID string) {
	normalized := strings.TrimSpace(sessionID)
	if m == nil || normalized == "" {
		return
	}
	m.mu.Lock()
	delete(m.sessions, normalized)
	delete(m.dirtyIDs, normalized)
	m.deletedIDs[normalized] = struct{}{}
	m.persistLocked(true, time.Now())
	m.mu.Unlock()
}

// DestroyUser 注销某个账号的全部会话，用于改密、停用或删除账号。
func (m *webSessionManager) DestroyUser(username string) {
	normalized := strings.TrimSpace(username)
	if m == nil || normalized == "" {
		return
	}
	m.mu.Lock()
	for key, session := range m.sessions {
		if session.Username == normalized {
			delete(m.sessions, key)
			delete(m.dirtyIDs, key)
			m.deletedIDs[key] = struct{}{}
		}
	}
	m.persistLocked(true, time.Now())
	m.mu.Unlock()
}

func (m *webSessionManager) DestroyAll() {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.sessions = make(map[string]webSession)
	m.dirtyIDs = make(map[string]struct{})
	m.deletedIDs = make(map[string]struct{})
	// 全局注销（改密）必须同时清空共享文件，其他副本会在下一次刷新时跟进。
	if m.store != nil {
		if err := m.store.Update(func([]webSession) ([]webSession, error) { return nil, nil }); err != nil {
			logger.Warnf("清空共享 Web 会话失败：%v", err)
		}
	}
	m.lastPersist = time.Now()
	m.mu.Unlock()
}
