package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// CallCapability invokes one host capability registered by the embedding
// application. The host binds the caller to this plugin process and generation;
// the returned envelope is the application's JSON result, including a stable
// error code when the capability was denied or failed.
func (h *Host) CallCapability(ctx context.Context, method string, arguments any) (json.RawMessage, error) {
	method = strings.TrimSpace(method)
	if method == "" || len(method) > 256 {
		return nil, errors.New("host capability method is invalid")
	}
	if h == nil || h.session == nil {
		return nil, errors.New("host capability is unavailable")
	}
	return h.callHost(ctx, "host.capability", map[string]any{
		"method":    method,
		"arguments": arguments,
	})
}
