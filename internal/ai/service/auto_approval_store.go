package aiservice

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	autoApprovalFileName = "ai_auto_approval.json"
	// maxAutoApprovalSessions bounds the file: the oldest grants fall off first.
	maxAutoApprovalSessions = 500
)

// AutoApprovalSettings is the "always approve" choice a person made for tool
// calls that change data or external state. Global covers every session;
// SessionIDs covers only the listed ones.
type AutoApprovalSettings struct {
	Global     bool     `json:"global"`
	SessionIDs []string `json:"sessionIds"`
}

func normalizeAutoApprovalSettings(settings AutoApprovalSettings) AutoApprovalSettings {
	seen := make(map[string]struct{}, len(settings.SessionIDs))
	ids := make([]string, 0, len(settings.SessionIDs))
	for _, raw := range settings.SessionIDs {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) > maxAutoApprovalSessions {
		ids = ids[len(ids)-maxAutoApprovalSessions:]
	}
	return AutoApprovalSettings{Global: settings.Global, SessionIDs: ids}
}

// autoApprovalState keeps the settings in their own small file instead of
// ai_config.json: they are read on the hot path of every approval, and the
// file is re-read when another process (desktop, CLI, MCP server) rewrites it.
type autoApprovalState struct {
	mu       sync.Mutex
	settings AutoApprovalSettings
	loaded   bool
	modTime  time.Time
	size     int64
}

func autoApprovalPath(configDir string) string {
	return filepath.Join(configDir, autoApprovalFileName)
}

// refreshLocked reloads the file when it changed on disk. A missing or
// unreadable file means "nothing is auto-approved": a broken file must never
// widen what runs without asking.
func (s *autoApprovalState) refreshLocked(configDir string) {
	info, err := os.Stat(autoApprovalPath(configDir))
	if err != nil {
		s.settings, s.loaded, s.modTime, s.size = AutoApprovalSettings{SessionIDs: []string{}}, true, time.Time{}, 0
		return
	}
	if s.loaded && info.ModTime().Equal(s.modTime) && info.Size() == s.size {
		return
	}
	s.loaded, s.modTime, s.size = true, info.ModTime(), info.Size()
	s.settings = AutoApprovalSettings{SessionIDs: []string{}}
	data, err := os.ReadFile(autoApprovalPath(configDir))
	if err != nil {
		return
	}
	var stored AutoApprovalSettings
	if json.Unmarshal(data, &stored) == nil {
		s.settings = normalizeAutoApprovalSettings(stored)
	}
}

func (s *autoApprovalState) snapshot(configDir string) AutoApprovalSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshLocked(configDir)
	return AutoApprovalSettings{Global: s.settings.Global, SessionIDs: append([]string{}, s.settings.SessionIDs...)}
}

func (s *autoApprovalState) allows(configDir, sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshLocked(configDir)
	if s.settings.Global {
		return true
	}
	id := strings.TrimSpace(sessionID)
	for _, granted := range s.settings.SessionIDs {
		if id != "" && granted == id {
			return true
		}
	}
	return false
}

// update applies a change and persists it; the in-memory copy is only replaced
// once the file is written.
func (s *autoApprovalState) update(configDir string, mutate func(*AutoApprovalSettings)) (AutoApprovalSettings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshLocked(configDir)
	next := AutoApprovalSettings{Global: s.settings.Global, SessionIDs: append([]string{}, s.settings.SessionIDs...)}
	mutate(&next)
	next = normalizeAutoApprovalSettings(next)
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return AutoApprovalSettings{}, err
	}
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return AutoApprovalSettings{}, err
	}
	path := autoApprovalPath(configDir)
	temp, err := os.CreateTemp(configDir, autoApprovalFileName+".*.tmp")
	if err != nil {
		return AutoApprovalSettings{}, err
	}
	tempPath := temp.Name()
	_, writeErr := temp.Write(data)
	closeErr := temp.Close()
	if err := errors.Join(writeErr, closeErr, os.Chmod(tempPath, 0o600)); err != nil {
		_ = os.Remove(tempPath)
		return AutoApprovalSettings{}, err
	}
	if err := os.Rename(tempPath, path); err != nil {
		_ = os.Remove(tempPath)
		return AutoApprovalSettings{}, err
	}
	if info, statErr := os.Stat(path); statErr == nil {
		s.modTime, s.size = info.ModTime(), info.Size()
	}
	s.settings, s.loaded = next, true
	return AutoApprovalSettings{Global: next.Global, SessionIDs: append([]string{}, next.SessionIDs...)}, nil
}
