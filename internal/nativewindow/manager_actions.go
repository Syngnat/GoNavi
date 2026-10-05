package nativewindow

import (
	"encoding/json"
	"math"
	"net/http"
	"strings"
)

func (m *Manager) handleAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()
	var request actionRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxDetachedJSONBytes))
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid detached action", http.StatusBadRequest)
		return
	}
	request.Action = strings.ToLower(strings.TrimSpace(request.Action))
	switch request.Action {
	case "ready", "sync", "attach", "close", "hide", "cancel-close", "host-event", "open-ai-settings":
	default:
		http.Error(w, "unsupported detached action", http.StatusBadRequest)
		return
	}

	id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
	revision := positiveActionRevision(request.Payload)
	requestedAISettingsVisibilityRevision := uint64(0)
	m.mu.Lock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.Unlock()
		http.Error(w, "unknown detached window", http.StatusNotFound)
		return
	}
	if request.Action == "open-ai-settings" {
		requestedAISettingsVisibilityRevision = positiveVisibilityRevision(request.Payload)
		if requestedAISettingsVisibilityRevision == 0 ||
			requestedAISettingsVisibilityRevision != entry.visibilityRevision ||
			!entry.info.Hidden {
			visibilityRevision := entry.visibilityRevision
			m.mu.Unlock()
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(OperationResult{
				Success:            true,
				Applied:            operationApplied(false),
				ID:                 id,
				Message:            "open AI settings ignored after a newer visibility action",
				VisibilityRevision: visibilityRevision,
			})
			return
		}
	}
	if request.Action == "cancel-close" && (m.closing || entry.exitReason == ExitReasonParentShutdown) {
		visibilityRevision := entry.visibilityRevision
		m.mu.Unlock()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(OperationResult{
			Success:            true,
			Applied:            operationApplied(false),
			ID:                 id,
			Message:            "detached close cancellation ignored while parent is closing",
			VisibilityRevision: visibilityRevision,
		})
		return
	}
	if actionUsesRevision(request.Action) && revision > 0 {
		if revision <= entry.actionRevision {
			visibilityRevision := entry.visibilityRevision
			m.mu.Unlock()
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(OperationResult{
				Success:            true,
				Applied:            operationApplied(false),
				ID:                 id,
				Message:            staleDetachedActionMessage,
				VisibilityRevision: visibilityRevision,
			})
			return
		}
		entry.actionRevision = revision
	}
	eventAction := request.Action
	visibilityRevision := requestedAISettingsVisibilityRevision
	if request.Action == "ready" {
		entry.info.Ready = true
		entry.readyOnce.Do(func() {
			if entry.ready != nil {
				close(entry.ready)
			}
		})
	} else if request.Action == "attach" {
		if entry.exitReason == "" {
			entry.exitReason = ExitReasonAttached
		}
		entry.pendingFocusRevision = 0
	} else if request.Action == "close" && entry.exitReason == "" {
		entry.exitReason = ExitReasonWindowClosed
		entry.pendingFocusRevision = 0
	} else if request.Action == "hide" {
		requestedVisibilityRevision := positiveVisibilityRevision(request.Payload)
		switch {
		case requestedVisibilityRevision == 0:
			if !entry.info.Hidden {
				entry.visibilityRevision++
				entry.info.Hidden = true
			}
			entry.pendingFocusRevision = 0
			visibilityRevision = entry.visibilityRevision
		case requestedVisibilityRevision < entry.visibilityRevision:
			// Preserve the final child snapshot, but do not let an old hide
			// transition close a window that the host has already focused again.
			visibilityRevision = requestedVisibilityRevision
			eventAction = "sync"
		default:
			entry.visibilityRevision = requestedVisibilityRevision
			entry.info.Hidden = true
			entry.pendingFocusRevision = 0
			visibilityRevision = requestedVisibilityRevision
		}
		request.Payload = withVisibilityRevision(request.Payload, visibilityRevision)
	} else if request.Action == "cancel-close" {
		if !m.cancelCloseActionLocked(entry, rollbackActionFromPayload(request.Payload)) {
			visibilityRevision = entry.visibilityRevision
			m.mu.Unlock()
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(OperationResult{
				Success:            true,
				Applied:            operationApplied(false),
				ID:                 id,
				Message:            "detached close cancellation no longer matches the active close",
				VisibilityRevision: visibilityRevision,
			})
			return
		}
	}
	info := entry.info
	ownerID := entry.ownerID
	m.mu.Unlock()
	if request.Action == "ready" || request.Action == "hide" || request.Action == "cancel-close" {
		publishDetachedDockMenuSnapshot(m)
	}

	if request.Action != "ready" {
		m.emitDetached(Event{
			ID:      info.ID,
			Kind:    info.Kind,
			Action:  eventAction,
			Payload: withOwnerWindowID(request.Payload, ownerID),
		})
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	applied := revisionedActionApplied(request.Action, revision)
	if request.Action == "open-ai-settings" {
		applied = operationApplied(true)
	}
	_ = json.NewEncoder(w).Encode(OperationResult{
		Success:            true,
		Applied:            applied,
		ID:                 id,
		VisibilityRevision: visibilityRevision,
	})
}

func actionUsesRevision(action string) bool {
	return action == "sync" || action == "attach" || action == "close" || action == "hide" || action == "cancel-close"
}

func operationApplied(value bool) *bool {
	return &value
}

func revisionedActionApplied(action string, revision int64) *bool {
	if !actionUsesRevision(action) || revision <= 0 {
		return nil
	}
	return operationApplied(true)
}

func rollbackActionFromPayload(payload any) string {
	record, ok := payload.(map[string]any)
	if !ok {
		return ""
	}
	rollbackAction, _ := record["rollbackAction"].(string)
	return strings.ToLower(strings.TrimSpace(rollbackAction))
}

func positiveVisibilityRevision(payload any) uint64 {
	switch typed := payload.(type) {
	case visibilityCommandPayload:
		return typed.VisibilityRevision
	case *visibilityCommandPayload:
		if typed != nil {
			return typed.VisibilityRevision
		}
	}
	record, ok := payload.(map[string]any)
	if !ok {
		return 0
	}
	return positiveUintRevision(record["visibilityRevision"])
}

func positiveUintRevision(value any) uint64 {
	switch typed := value.(type) {
	case float64:
		if typed > 0 && typed <= 9_007_199_254_740_991 && math.Trunc(typed) == typed {
			return uint64(typed)
		}
	case json.Number:
		revision, err := typed.Int64()
		if err == nil && revision > 0 {
			return uint64(revision)
		}
	case uint64:
		return typed
	case uint:
		return uint64(typed)
	case int64:
		if typed > 0 {
			return uint64(typed)
		}
	case int:
		if typed > 0 {
			return uint64(typed)
		}
	}
	return 0
}

func withVisibilityRevision(payload any, visibilityRevision uint64) any {
	result := make(map[string]any)
	if source, ok := payload.(map[string]any); ok {
		for key, value := range source {
			result[key] = value
		}
	} else if payload != nil {
		result["value"] = payload
	}
	result["visibilityRevision"] = visibilityRevision
	return result
}

func positiveActionRevision(payload any) int64 {
	record, ok := payload.(map[string]any)
	if !ok {
		return 0
	}
	switch value := record["revision"].(type) {
	case float64:
		if value <= 0 || value > 9_007_199_254_740_991 || math.Trunc(value) != value {
			return 0
		}
		return int64(value)
	case json.Number:
		revision, err := value.Int64()
		if err == nil && revision > 0 {
			return revision
		}
	case int64:
		if value > 0 {
			return value
		}
	case int:
		if value > 0 {
			return int64(value)
		}
	}
	return 0
}
