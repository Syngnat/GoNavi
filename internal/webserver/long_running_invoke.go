package webserver

import (
	"net/http"
	"time"

	httpserverlimits "GoNavi-Wails/internal/httpserver"
	"GoNavi-Wails/internal/rpctimeout"
)

// wrapInvokeRoute lets SQL and other long App methods idle past
// http.Server's one-minute WriteTimeout, while still bounding actual writes.
func wrapInvokeRoute(next http.Handler) http.Handler {
	// Limit runs first so a compressed body is bounded on the wire before the
	// decoder inflates it under its own decoded-size cap.
	return httpserverlimits.StreamingWriteTimeout(
		httpserverlimits.LimitInvokeRequestBody(httpserverlimits.DecompressRequestBody(next)),
	)
}

func clearLongRunningInvokeWriteDeadline(w http.ResponseWriter, method string) {
	if w == nil || !rpctimeout.IsLongRunningAppMethod(method) {
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
}
