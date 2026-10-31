package nativewindow

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

func (c *PluginController) serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	// No CORS: the credential stays in the child Go proxy, never in plugin JS.
	entry := c.authorize(r)
	if entry == nil {
		pluginHTTPError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if r.URL.Path == pluginBridgePrefix+"state" && r.Method == http.MethodGet {
		c.mu.Lock()
		closing := entry.closing
		c.mu.Unlock()
		writePluginJSON(w, map[string]bool{"closing": closing})
		return
	}
	if _, err := c.entryStatus(entry); err != nil {
		c.revokeEntry(entry)
		pluginHTTPError(w, http.StatusGone, "generation_revoked")
		return
	}
	if entry.life.Err() != nil {
		pluginHTTPError(w, http.StatusGone, "window_revoked")
		return
	}
	if strings.HasPrefix(r.URL.Path, pluginBridgePrefix+"ui/") {
		c.serveUIAsset(w, r)
		return
	}
	switch r.URL.Path {
	case pluginBridgePrefix + "bootstrap":
		if !pluginMethod(w, r, http.MethodGet) {
			return
		}
		// A document reload starts a fresh JavaScript sequence, not a new process.
		c.mu.Lock()
		entry.heartbeatSequence = 0
		preferences, revision := c.preferencesLocked(entry)
		c.mu.Unlock()
		writePluginJSON(w, pluginBootstrap{PluginID: entry.info.PluginID, Generation: entry.info.Generation, Title: entry.title, Context: entry.context, Preferences: preferences, PreferencesRevision: revision})
	case pluginBridgePrefix + "runtime.js":
		if !pluginMethod(w, r, http.MethodGet) {
			return
		}
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		writePluginBody(w, c.bundle)
	case pluginBridgePrefix + "heartbeat":
		c.serveHeartbeat(w, r, entry)
	case pluginBridgePrefix + "invoke":
		c.serveInvoke(w, r, entry)
	case pluginBridgePrefix + "capability":
		c.serveCapability(w, r, entry)
	case pluginBridgePrefix + "cancel":
		c.serveCancel(w, r, entry)
	case pluginBridgePrefix + "close":
		if !pluginMethod(w, r, http.MethodPost) {
			return
		}
		c.revokeEntry(entry)
		w.WriteHeader(http.StatusNoContent)
	case "/":
		if !pluginMethod(w, r, http.MethodGet) {
			return
		}
		http.Redirect(w, r, pluginAssetPrefix+entry.entry, http.StatusTemporaryRedirect)
	default:
		if !strings.HasPrefix(r.URL.Path, pluginAssetPrefix) {
			http.NotFound(w, r)
			return
		}
		c.serveAsset(w, r, entry)
	}
}

func (c *PluginController) authorize(r *http.Request) *pluginWindowEntry {
	// Host matching also rejects DNS-rebinding requests to the loopback listener.
	if r.Host != strings.TrimPrefix(c.endpoint, "http://") {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.windowIDs[r.Header.Get(pluginWindowHeader)]
	if entry == nil || subtle.ConstantTimeCompare([]byte(entry.token), []byte(r.Header.Get(pluginTokenHeader))) != 1 {
		return nil
	}
	return entry
}

func (c *PluginController) serveHeartbeat(w http.ResponseWriter, r *http.Request, entry *pluginWindowEntry) {
	if !pluginMethod(w, r, http.MethodPost) {
		return
	}
	var heartbeat struct {
		Sequence uint64 `json:"sequence"`
	}
	if err := decodePluginJSON(w, r, &heartbeat, 256); err != nil || heartbeat.Sequence == 0 {
		pluginHTTPError(w, http.StatusBadRequest, "invalid_heartbeat")
		return
	}
	c.mu.Lock()
	accepted := !entry.closing && heartbeat.Sequence > entry.heartbeatSequence
	if accepted {
		entry.heartbeat = time.Now()
		entry.heartbeatSequence = heartbeat.Sequence
	}
	preferences, revision := c.preferencesLocked(entry)
	c.mu.Unlock()
	if !accepted {
		pluginHTTPError(w, http.StatusConflict, "stale_heartbeat")
		return
	}
	writePluginJSON(w, pluginBootstrap{PluginID: entry.info.PluginID, Generation: entry.info.Generation, Title: entry.title, Preferences: preferences, PreferencesRevision: revision})
}

func pluginMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	pluginHTTPError(w, http.StatusMethodNotAllowed, "method_not_allowed")
	return false
}

func decodePluginJSON(w http.ResponseWriter, r *http.Request, target any, limit int64) error {
	if r.Header.Get("Content-Type") != "application/json" {
		return errors.New("expected application/json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func pluginHTTPError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	writePluginJSON(w, map[string]string{"code": code})
}

func writePluginJSON(w http.ResponseWriter, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	writePluginBody(w, payload)
}

func writePluginBody(w http.ResponseWriter, payload []byte) {
	// A disconnected renderer is expected during cancellation/shutdown.
	if _, err := w.Write(payload); err != nil {
		return
	}
}
