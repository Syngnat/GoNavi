package nativewindow

import (
	"encoding/json"
	"net/http"
)

// serveCapability is the plugin-window channel into the host capability
// registry. The window token and generation were authenticated by serveHTTP;
// the App callback re-checks the live generation and permissions. User-visible
// failures are returned as normal JSON envelopes by the callback; this route
// only fails transport, size and lifecycle errors.
func (c *PluginController) serveCapability(w http.ResponseWriter, r *http.Request, entry *pluginWindowEntry) {
	if !pluginMethod(w, r, http.MethodPost) {
		return
	}
	c.mu.Lock()
	if entry.closing || entry.invokeCalls >= pluginMaxCalls {
		c.mu.Unlock()
		pluginHTTPError(w, http.StatusTooManyRequests, "call_limit")
		return
	}
	entry.invokeCalls++
	c.mu.Unlock()
	defer func() { c.mu.Lock(); entry.invokeCalls--; c.mu.Unlock() }()

	c.mu.Lock()
	capability := c.capability
	c.mu.Unlock()
	if capability == nil {
		pluginHTTPError(w, http.StatusServiceUnavailable, "capability_unavailable")
		return
	}
	var request pluginCapabilityRequest
	if err := decodePluginJSON(w, r, &request, pluginMaxJSONBytes); err != nil ||
		!pluginRequestIDPattern.MatchString(request.ID) || request.Method == "" || len(request.Method) > 256 {
		pluginHTTPError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	ctx, release, err := c.beginInvoke(r.Context(), entry, request.ID)
	if err != nil {
		pluginHTTPError(w, http.StatusTooManyRequests, "window_busy_or_revoked")
		return
	}
	defer release()
	result, err := capability(ctx, entry.info.PluginID, entry.info.Generation, request.Method, request.Arguments)
	if err != nil || ctx.Err() != nil {
		pluginHTTPError(w, http.StatusBadGateway, "capability_failed")
		return
	}
	if _, err := c.entryStatus(entry); err != nil {
		pluginHTTPError(w, http.StatusGone, "generation_revoked")
		return
	}
	if len(result) > pluginMaxJSONBytes || !json.Valid(result) {
		pluginHTTPError(w, http.StatusBadGateway, "invalid_response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	writePluginBody(w, result)
}
