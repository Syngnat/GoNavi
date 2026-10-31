package nativewindow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/plugin"
)

// Open starts one child per running plugin generation. The native child boot is
// asynchronous; a missing event-loop heartbeat causes bounded termination.
// locale and theme mirror the host appearance; they are forwarded to the child
// and injected into the entry HTML as window.gonaviHostPrefs. An already open
// window receives newer safe snapshots through its event-loop heartbeat.
func (c *PluginController) Open(ctx context.Context, id, windowKey string, launchContext json.RawMessage, locale, theme string) (PluginWindowInfo, error) {
	if err := ctx.Err(); err != nil {
		return PluginWindowInfo{}, err
	}
	windowKey = strings.TrimSpace(windowKey)
	if windowKey == "" {
		windowKey = id
	}
	if len(windowKey) > 1024 {
		return PluginWindowInfo{}, errors.New("plugin window key is too long")
	}
	if len(launchContext) > 0 && !json.Valid(launchContext) {
		return PluginWindowInfo{}, errors.New("plugin launch context is invalid JSON")
	}
	locale, theme = sanitizeHostPref(locale), sanitizeHostPref(theme)
	c.mu.Lock()
	admission := c.admissionEpochs[id]
	c.mu.Unlock()
	status, err := c.runningStatus(id, 0)
	if err != nil {
		return PluginWindowInfo{}, err
	}
	c.mu.Lock()
	c.knownGenerations[id] = pluginStatusStamp(status)
	c.mu.Unlock()
	if status.Manifest.Window == nil {
		return PluginWindowInfo{}, errors.New("plugin has no native window")
	}
	entryPath := status.Manifest.Window.Entry
	if !validPluginAssetName(entryPath) || !strings.EqualFold(filepath.Ext(entryPath), ".html") {
		return PluginWindowInfo{}, errors.New("plugin window entry must be a package HTML file")
	}
	if _, err := c.manager.AssetPath(id, entryPath); err != nil {
		return PluginWindowInfo{}, err
	}
	token, err := newBridgeToken()
	if err != nil {
		return PluginWindowInfo{}, err
	}
	windowID, err := newBridgeToken()
	if err != nil {
		return PluginWindowInfo{}, err
	}
	profile, err := os.MkdirTemp("", "gonavi-plugin-window-")
	if err != nil {
		return PluginWindowInfo{}, fmt.Errorf("create plugin webview profile: %w", err)
	}
	if err := preparePluginProfile(profile); err != nil {
		removePluginProfile(profile)
		return PluginWindowInfo{}, err
	}
	entry, existing, err := c.register(status, windowID, windowKey, token, profile, admission, launchContext, locale, theme)
	if err != nil || existing.ID != "" {
		removePluginProfile(profile)
		return existing, err
	}
	process, err := c.startProcess(c.processSpec(entry, status))
	if err != nil {
		c.finish(entry)
		c.wg.Done()
		return PluginWindowInfo{}, fmt.Errorf("start plugin window: %w", err)
	}
	c.mu.Lock()
	entry.process = process
	entry.info.PID = process.PID()
	info := entry.info
	c.mu.Unlock()
	go c.supervise(entry, process)
	if ctx.Err() != nil {
		c.revokeEntry(entry)
		return PluginWindowInfo{}, ctx.Err()
	}
	return info, nil
}

func (c *PluginController) register(status plugin.Status, windowID, windowKey, token, profile string, admission uint64, launchContext json.RawMessage, locale, theme string) (*pluginWindowEntry, PluginWindowInfo, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.life == nil || c.life.Err() != nil {
		return nil, PluginWindowInfo{}, errors.New("plugin window controller is not running")
	}
	if admission != c.admissionEpochs[status.Manifest.ID] {
		return nil, PluginWindowInfo{}, errors.New("plugin window admission was revoked")
	}
	if revoked, exists := c.revokedGenerations[status.Manifest.ID]; exists && pluginStatusStamp(status) == revoked {
		return nil, PluginWindowInfo{}, errors.New("plugin window generation was revoked")
	}
	if existing := c.windows[windowKey]; existing != nil {
		if existing.info.PluginID != status.Manifest.ID || existing.closing || existing.stamp != pluginStatusStamp(status) {
			return nil, PluginWindowInfo{}, errors.New("plugin window is closing or belongs to another generation")
		}
		return nil, existing.info, nil
	}
	for _, existing := range c.windows {
		if existing.info.PluginID == status.Manifest.ID && existing.closing {
			return nil, PluginWindowInfo{}, errors.New("plugin window is closing")
		}
	}
	if len(c.windows) >= pluginMaxWindows {
		return nil, PluginWindowInfo{}, errors.New("plugin window limit reached")
	}
	life, cancel := context.WithCancel(c.life)
	title := status.Manifest.Window.Title
	if title == "" {
		title = status.Manifest.Name
	}
	entry := &pluginWindowEntry{info: PluginWindowInfo{ID: windowID, PluginID: status.Manifest.ID, Generation: status.Generation}, key: windowKey,
		stamp: pluginStatusStamp(status), title: title, entry: status.Manifest.Window.Entry, token: token, profile: profile, context: append(json.RawMessage(nil), launchContext...), life: life, cancel: cancel,
		stop: make(chan struct{}), done: make(chan struct{}), opened: time.Now(), requests: make(map[string]context.CancelFunc), canceledRequests: make(map[string]time.Time),
		locale: locale, theme: theme}
	c.windows[windowKey] = entry
	c.windowIDs[windowID] = entry
	// Registration before spawn prevents Close racing a late WaitGroup.Add.
	c.wg.Add(1)
	return entry, PluginWindowInfo{}, nil
}

// sanitizeHostPref 只保留安全的语言/主题标记字符（防注入子进程环境与 HTML）。
func sanitizeHostPref(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		}
		if b.Len() >= 32 {
			break
		}
	}
	return b.String()
}

func (c *PluginController) runningStatus(id string, generation uint64) (plugin.Status, error) {
	for _, status := range c.manager.List() {
		if status.Manifest.ID != id {
			continue
		}
		if !status.DesiredEnabled || status.State != "running" || (generation != 0 && status.Generation != generation) {
			return plugin.Status{}, errors.New("plugin window generation is no longer active")
		}
		return status, nil
	}
	return plugin.Status{}, errors.New("plugin is not installed")
}

func (c *PluginController) monitor(ctx context.Context) {
	defer c.wg.Done()
	ticker := time.NewTicker(c.checkInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			c.revokeAll()
			if err := c.server.Close(); err != nil && !errors.Is(err, context.Canceled) {
				logger.Error(err, "close plugin window bridge")
			}
			return
		case now := <-ticker.C:
			c.mu.Lock()
			entries := make([]*pluginWindowEntry, 0, len(c.windows))
			for _, entry := range c.windows {
				if !entry.closing {
					entries = append(entries, entry)
				}
			}
			c.mu.Unlock()
			for _, entry := range entries {
				c.checkHealth(entry, now)
			}
		}
	}
}

func (c *PluginController) checkHealth(entry *pluginWindowEntry, now time.Time) {
	_, err := c.entryStatus(entry)
	c.mu.Lock()
	defer c.mu.Unlock()
	expired := entry.heartbeat.IsZero() && now.Sub(entry.opened) > c.startupTimeout
	if !entry.heartbeat.IsZero() {
		expired = now.Sub(entry.heartbeat) > c.heartbeatTimeout
	}
	if err != nil || expired {
		c.revokeLocked(entry)
	}
}

func (c *PluginController) supervise(entry *pluginWindowEntry, process pluginProcess) {
	defer c.wg.Done()
	// Wait must run concurrently with the bounded stop timer, and is always joined.
	waited := make(chan struct{})
	go func() {
		if err := process.Wait(); err != nil {
			logger.Error(err, "plugin window process exited: %s", entry.info.PluginID)
		}
		close(waited)
	}()
	select {
	case <-waited:
	case <-entry.stop:
		c.mu.Lock()
		remaining := time.Until(entry.revokedAt.Add(c.stopTimeout))
		c.mu.Unlock()
		timer := time.NewTimer(remaining)
		select {
		case <-waited:
			timer.Stop()
		case <-timer.C:
			if err := process.Kill(); err != nil {
				logger.Error(err, "kill plugin window process tree: %s", entry.info.PluginID)
			}
			<-waited
		}
	}
	c.finish(entry)
}

func (c *PluginController) finish(entry *pluginWindowEntry) {
	c.mu.Lock()
	c.revokeLocked(entry)
	onClosed, info, life := c.onWindowClosed, entry.info, c.life
	c.mu.Unlock()
	removePluginProfile(entry.profile)
	// 保留 closing entry，直到旧会话清理完成；回调由现有 supervisor 跟踪。
	if onClosed != nil {
		ctx, cancel := context.WithTimeout(life, pluginTeardownTimeout)
		onClosed(ctx, info)
		cancel()
	}
	c.mu.Lock()
	delete(c.windows, entry.key)
	delete(c.windowIDs, entry.info.ID)
	close(entry.done)
	c.mu.Unlock()
}

func removePluginProfile(profile string) {
	// Only controller-created absolute temporary directories can be removed.
	if !filepath.IsAbs(profile) || !strings.HasPrefix(filepath.Base(profile), "gonavi-plugin-window-") {
		return
	}
	if err := os.RemoveAll(profile); err != nil {
		logger.Error(err, "remove isolated plugin window profile")
	}
}
