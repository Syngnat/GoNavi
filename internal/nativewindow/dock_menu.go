//go:build !wails3

package nativewindow

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
)

type dockMenuWindow struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	PID   int    `json:"pid,omitempty"`
}

var detachedDockMenuManager struct {
	sync.RWMutex
	manager *Manager
}

var detachedDockMenuPublisher struct {
	sync.Mutex
	revision uint64
}

func registerDetachedDockMenuManager(manager *Manager) {
	if manager == nil || !supportsDetachedDockMenu() {
		return
	}
	detachedDockMenuManager.Lock()
	detachedDockMenuManager.manager = manager
	detachedDockMenuManager.Unlock()
	installDetachedDockMenu()
	publishDetachedDockMenuSnapshot(manager)
}

func unregisterDetachedDockMenuManager(manager *Manager) {
	if !supportsDetachedDockMenu() {
		return
	}
	detachedDockMenuManager.Lock()
	if detachedDockMenuManager.manager == manager {
		detachedDockMenuManager.manager = nil
		detachedDockMenuManager.Unlock()
		publishDetachedDockMenuSnapshot(nil)
		return
	}
	detachedDockMenuManager.Unlock()
}

func currentDetachedDockMenuManager() *Manager {
	detachedDockMenuManager.RLock()
	manager := detachedDockMenuManager.manager
	detachedDockMenuManager.RUnlock()
	return manager
}

func publishDetachedDockMenuSnapshot(manager *Manager) {
	if !supportsDetachedDockMenu() {
		return
	}
	detachedDockMenuPublisher.Lock()
	defer detachedDockMenuPublisher.Unlock()

	var windows []WindowInfo
	if manager == nil {
		if currentDetachedDockMenuManager() != nil {
			return
		}
	} else {
		if currentDetachedDockMenuManager() != manager {
			return
		}
		manager.mu.RLock()
		if manager.started && !manager.closing {
			windows = make([]WindowInfo, 0, len(manager.windows))
			for _, entry := range manager.windows {
				windows = append(windows, entry.info)
			}
		}
		manager.mu.RUnlock()
	}
	payload, err := json.Marshal(buildDockMenuSnapshot(windows))
	if err != nil {
		return
	}
	detachedDockMenuPublisher.revision++
	publishDetachedDockMenuSnapshotToPlatform(payload, detachedDockMenuPublisher.revision)
}

func buildDockMenuSnapshot(windows []WindowInfo) []dockMenuWindow {
	current := make([]WindowInfo, 0, len(windows))
	for _, window := range windows {
		window.ID = strings.TrimSpace(window.ID)
		if window.ID == "" || !window.Ready || window.CloseSent || window.Hidden {
			continue
		}
		current = append(current, window)
	}
	sort.Slice(current, func(i int, j int) bool {
		if current[i].OpenedAt != current[j].OpenedAt {
			return current[i].OpenedAt < current[j].OpenedAt
		}
		return current[i].ID < current[j].ID
	})

	result := make([]dockMenuWindow, 0, len(current))
	for _, window := range current {
		title := strings.TrimSpace(window.Title)
		if title == "" {
			title = "GoNavi"
		}
		result = append(result, dockMenuWindow{
			ID:    window.ID,
			Title: title,
			PID:   window.PID,
		})
	}
	return result
}

func focusDetachedDockMenuWindow(id string) {
	manager := currentDetachedDockMenuManager()
	if manager == nil {
		return
	}
	manager.Focus(strings.TrimSpace(id))
}
