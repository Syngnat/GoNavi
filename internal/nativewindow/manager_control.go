package nativewindow

import (
	"encoding/json"
	"net/http"
	"strings"
)

func (m *Manager) handleControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()

	var request controlRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxDetachedJSONBytes))
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid detached control request", http.StatusBadRequest)
		return
	}
	request.Action = strings.ToLower(strings.TrimSpace(request.Action))
	ownerID := strings.TrimSpace(r.Header.Get(HeaderWindowID))

	var result OperationResult
	switch request.Action {
	case "open":
		if targetID := strings.TrimSpace(request.Request.ID); targetID != "" && !m.canOpenOwned(targetID, ownerID) {
			result = operationFailure("native window id belongs to another owner")
			break
		}
		result = m.open(request.Request, ownerID)
		if result.Success {
			m.emitDetached(Event{
				ID:     result.ID,
				Kind:   normalizeOpenRequest(request.Request).Kind,
				Action: "opened",
				Payload: withOwnerWindowID(
					openEventPayload(request.Request.Payload, result.Bounds),
					ownerID,
				),
			})
		}
	case "focus":
		if !m.canFocusWindow(request.ID, ownerID) {
			result = operationFailure("native window is not owned by this window")
			break
		}
		result = m.Focus(request.ID)
	case "hide":
		if !m.ownsWindow(request.ID, ownerID) {
			result = operationFailure("native window is not owned by this window")
			break
		}
		result = m.Hide(request.ID)
	case "close":
		if !m.ownsWindow(request.ID, ownerID) {
			result = operationFailure("native window is not owned by this window")
			break
		}
		result = m.Close(request.ID)
	case "close-owned":
		result = m.closeOwned(ownerID)
	default:
		http.Error(w, "unsupported detached control action", http.StatusBadRequest)
		return
	}

	status := http.StatusOK
	if !result.Success {
		status = http.StatusBadRequest
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(result)
}

func openEventPayload(payload any, bounds *WindowBounds) any {
	source, ok := payload.(map[string]any)
	if !ok {
		return nil
	}
	result := make(map[string]any, 2)
	for _, key := range []string{"tab", "resultWindow"} {
		if value, exists := source[key]; exists {
			if key == "resultWindow" && bounds != nil {
				if resultWindow, ok := value.(map[string]any); ok {
					corrected := make(map[string]any, len(resultWindow)+4)
					for field, fieldValue := range resultWindow {
						corrected[field] = fieldValue
					}
					corrected["x"] = bounds.X
					corrected["y"] = bounds.Y
					corrected["width"] = bounds.Width
					corrected["height"] = bounds.Height
					value = corrected
				}
			}
			result[key] = value
		}
	}
	return result
}

func (m *Manager) canOpenOwned(id string, ownerID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, exists := m.windows[strings.TrimSpace(id)]
	return !exists || entry.ownerID == strings.TrimSpace(ownerID)
}

func (m *Manager) ownsWindow(id string, ownerID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, exists := m.windows[strings.TrimSpace(id)]
	return exists && entry.ownerID == strings.TrimSpace(ownerID)
}

func (m *Manager) canFocusWindow(id string, ownerID string) bool {
	id = strings.TrimSpace(id)
	ownerID = strings.TrimSpace(ownerID)
	if id == "" || ownerID == "" {
		return false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, exists := m.windows[id]
	return exists && (id == ownerID || entry.ownerID == ownerID)
}

func (m *Manager) closeOwned(ownerID string) OperationResult {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return operationFailure("native owner window is required")
	}
	m.mu.RLock()
	ids := make([]string, 0)
	for id, entry := range m.windows {
		if entry.ownerID == ownerID {
			ids = append(ids, id)
		}
	}
	m.mu.RUnlock()
	for _, id := range ids {
		m.requestClose(id, ExitReasonRequested)
	}
	return OperationResult{Success: true}
}

func withOwnerWindowID(payload any, ownerID string) any {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return payload
	}
	result := make(map[string]any)
	if source, ok := payload.(map[string]any); ok {
		for key, value := range source {
			result[key] = value
		}
	} else if payload != nil {
		result["value"] = payload
	}
	result["ownerWindowId"] = ownerID
	return result
}
