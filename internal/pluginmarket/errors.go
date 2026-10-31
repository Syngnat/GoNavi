package pluginmarket

import (
	"context"
	"errors"
	"fmt"
)

// ErrNotConfigured means no marketplace endpoint has been configured.
var ErrNotConfigured = errors.New("marketplace is not configured")

// ErrInvalidURL means an endpoint is not HTTPS or an explicit loopback development URL.
var ErrInvalidURL = errors.New("invalid marketplace URL")

// ErrFiltersUnsupported means a source did not acknowledge the requested filter semantics.
var ErrFiltersUnsupported = errors.New("marketplace filters unsupported")

// ErrInvalidRequest means a client argument exceeds the API contract.
var ErrInvalidRequest = errors.New("invalid marketplace request")

// ErrInvalidResponse means a response cannot safely be used or cached.
var ErrInvalidResponse = errors.New("invalid marketplace response")

// ErrResponseTooLarge means the bounded response or artifact limit was exceeded.
var ErrResponseTooLarge = errors.New("marketplace response exceeds size limit")

// ErrRedirect means a redirect was rejected before any credentials could be forwarded.
var ErrRedirect = errors.New("marketplace redirects are not allowed")

// ErrSourceChanged means configuration changed while a request was in flight.
var ErrSourceChanged = errors.New("marketplace source changed")

// ErrSourceMismatch means an installed plugin belongs to another marketplace source.
var ErrSourceMismatch = errors.New("installed plugin belongs to another marketplace source")

// ErrDigestMismatch means reviewed archive bytes differ from the requested transport SHA-256.
var ErrDigestMismatch = errors.New("marketplace artifact digest mismatch")

// ErrBusy means the bounded set of active downloads or retained receipts is full.
var ErrBusy = errors.New("marketplace download limit reached")

// APIError preserves structured service failures without echoing untrusted response text or credentials.
type APIError struct {
	StatusCode int
	Code       string
}

// Error formats the bounded status and code without including remote response messages.
func (e *APIError) Error() string {
	return fmt.Sprintf("marketplace API status %d: %s", e.StatusCode, e.Code)
}

type requestError struct{ cause error }

func (e *requestError) Error() string { return "marketplace request failed" }
func (e *requestError) Unwrap() error { return e.cause }

func errorCode(err error) string {
	var api *APIError
	switch {
	case errors.As(err, &api):
		return api.Code
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, ErrFiltersUnsupported):
		return "filters_unsupported"
	case errors.Is(err, ErrInvalidResponse):
		return "invalid_response"
	case errors.Is(err, ErrResponseTooLarge):
		return "response_too_large"
	case errors.Is(err, ErrRedirect):
		return "redirect_rejected"
	case errors.Is(err, ErrNotConfigured):
		return "not_configured"
	case errors.Is(err, ErrSourceChanged):
		return "source_changed"
	default:
		return "request_failed"
	}
}
