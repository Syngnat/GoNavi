package app

import (
	"GoNavi-Wails/internal/pluginmarket"
	"context"
	"errors"
)

func marketFailureCode(err error) string {
	switch {
	case errors.Is(err, pluginmarket.ErrInvalidRequest), errors.Is(err, pluginmarket.ErrInvalidURL):
		return "invalid_request"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, pluginmarket.ErrSourceChanged):
		return "source_changed"
	// A package installed outside the marketplace has no provenance record, so the update
	// guard rejects it. Reporting that as market_unavailable blamed the network for a local
	// state mismatch and hid the only actionable instruction.
	case errors.Is(err, pluginmarket.ErrSourceMismatch):
		return "source_mismatch"
	case errors.Is(err, pluginmarket.ErrInvalidResponse):
		return "invalid_response"
	case errors.Is(err, pluginmarket.ErrResponseTooLarge):
		return "response_too_large"
	case errors.Is(err, pluginmarket.ErrRedirect):
		return "redirect_rejected"
	}
	var api *pluginmarket.APIError
	if errors.As(err, &api) {
		switch api.Code {
		case "artifact_invalid", "forbidden", "conflict", "auth_unavailable", "rate_limited", "server_busy", "not_found", "authentication_required":
			return api.Code
		}
	}
	return "market_unavailable"
}
