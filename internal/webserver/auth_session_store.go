package webserver

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/appdata"
)

const (
	webSessionStoreFileName = "web_sessions.json"
	webSessionStoreLimit    = 512
)

// persistedWebSession 是会话落盘形态。
//
// 这里保存的是会话令牌原文：服务端需要用它匹配浏览器 Cookie，无法只存哈希。
// 文件因此与 web_auth.json 同权限（0600、目录 0700），只允许数据目录属主读取。
type persistedWebSession struct {
	ID               string `json:"id"`
	Username         string `json:"username"`
	Role             string `json:"role"`
	CreatedAt        int64  `json:"createdAt"`
	LastSeenAt       int64  `json:"lastSeenAt"`
	AbsoluteDeadline int64  `json:"absoluteDeadline"`
}

type persistedWebSessionFile struct {
	SchemaVersion int                   `json:"schemaVersion"`
	Sessions      []persistedWebSession `json:"sessions"`
}

type webSessionStore struct {
	path string
}

func newWebSessionStore(root string) *webSessionStore {
	trimmed := strings.TrimSpace(root)
	if trimmed == "" {
		trimmed = appdata.MustResolveActiveRoot()
	}
	return &webSessionStore{path: filepath.Join(trimmed, webSessionStoreFileName)}
}

func (s *webSessionStore) Load() ([]webSession, error) {
	if s == nil || strings.TrimSpace(s.path) == "" {
		return nil, nil
	}
	lock, err := appdata.AcquireFileLock(s.path + ".lock")
	if err != nil {
		return nil, err
	}
	defer func() { _ = lock.Close() }()
	return s.loadUnlocked()
}

// Update 在跨进程文件锁内完成「读取 → 修改 → 写回」，供多副本共享会话使用。
func (s *webSessionStore) Update(mutate func([]webSession) ([]webSession, error)) error {
	if s == nil || strings.TrimSpace(s.path) == "" {
		return nil
	}
	lock, err := appdata.AcquireFileLock(s.path + ".lock")
	if err != nil {
		return err
	}
	defer func() { _ = lock.Close() }()
	current, err := s.loadUnlocked()
	if err != nil {
		return err
	}
	next, err := mutate(current)
	if err != nil {
		return err
	}
	return s.saveUnlocked(next)
}

func (s *webSessionStore) loadUnlocked() ([]webSession, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var file persistedWebSessionFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("decode web session store: %w", err)
	}
	sessions := make([]webSession, 0, len(file.Sessions))
	for _, item := range file.Sessions {
		if strings.TrimSpace(item.ID) == "" || strings.TrimSpace(item.Username) == "" {
			continue
		}
		sessions = append(sessions, webSession{
			ID:               item.ID,
			Username:         item.Username,
			Role:             item.Role,
			CreatedAt:        time.UnixMilli(item.CreatedAt),
			LastSeenAt:       time.UnixMilli(item.LastSeenAt),
			AbsoluteDeadline: time.UnixMilli(item.AbsoluteDeadline),
		})
	}
	return sessions, nil
}

func (s *webSessionStore) Save(sessions []webSession) error {
	if s == nil || strings.TrimSpace(s.path) == "" {
		return nil
	}
	lock, err := appdata.AcquireFileLock(s.path + ".lock")
	if err != nil {
		return err
	}
	defer func() { _ = lock.Close() }()
	return s.saveUnlocked(sessions)
}

func (s *webSessionStore) saveUnlocked(sessions []webSession) error {
	if len(sessions) > webSessionStoreLimit {
		sessions = sessions[:webSessionStoreLimit]
	}
	file := persistedWebSessionFile{SchemaVersion: 1, Sessions: make([]persistedWebSession, 0, len(sessions))}
	for _, session := range sessions {
		file.Sessions = append(file.Sessions, persistedWebSession{
			ID:               session.ID,
			Username:         session.Username,
			Role:             session.Role,
			CreatedAt:        session.CreatedAt.UnixMilli(),
			LastSeenAt:       session.LastSeenAt.UnixMilli(),
			AbsoluteDeadline: session.AbsoluteDeadline.UnixMilli(),
		})
	}
	payload, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, ".web-sessions-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temporary.Name()
	defer func() {
		_ = os.Remove(tempPath)
	}()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, s.path)
}
