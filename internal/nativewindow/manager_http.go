package nativewindow

import (
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"strings"
)

func (m *Manager) authenticatedHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(BootstrapPath, m.handleBootstrap)
	mux.HandleFunc(ActionPath, m.handleAction)
	mux.HandleFunc(ControlPath, m.handleControl)
	mux.HandleFunc(HostStatePath, m.handleHostState)
	mux.HandleFunc(CommandStatePath, m.handleCommandState)
	mux.Handle("/", m.shared.Handler())
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRemote(r.RemoteAddr) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		token := r.Header.Get(HeaderToken)
		if subtle.ConstantTimeCompare([]byte(token), []byte(m.token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
		m.mu.RLock()
		_, exists := m.windows[id]
		m.mu.RUnlock()
		if id == "" || !exists {
			http.Error(w, "unknown detached window", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func isLoopbackRemote(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(remoteAddr))
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (m *Manager) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
	m.mu.Lock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.Unlock()
		http.Error(w, "unknown detached window", http.StatusNotFound)
		return
	}
	bootstrap := Bootstrap{
		ID:             entry.info.ID,
		Kind:           entry.info.Kind,
		Title:          entry.info.Title,
		Payload:        entry.payload,
		ActionRevision: entry.actionRevision,
	}
	m.mu.Unlock()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(bootstrap)
}

func (m *Manager) handleHostState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
	m.mu.RLock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.RUnlock()
		http.Error(w, "unknown detached window", http.StatusNotFound)
		return
	}
	hostState := entry.hostState
	m.mu.RUnlock()
	if hostState.Revision <= 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(hostState)
}

func (m *Manager) handleCommandState(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		m.handleCommandStateAck(w, r)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
	m.mu.RLock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.RUnlock()
		http.Error(w, "unknown detached window", http.StatusNotFound)
		return
	}
	closeSent := entry.info.CloseSent
	hidden := entry.info.Hidden
	visibilityRevision := entry.visibilityRevision
	pendingFocusRevision := entry.pendingFocusRevision
	reason := entry.exitReason
	m.mu.RUnlock()
	if !closeSent && !hidden && pendingFocusRevision == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if hidden && !closeSent {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(childCommand{
			ID:      id,
			Action:  "hide",
			Payload: visibilityCommandPayload{VisibilityRevision: visibilityRevision},
		})
		return
	}
	if !closeSent {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(childCommand{
			ID:      id,
			Action:  "focus",
			Payload: visibilityCommandPayload{VisibilityRevision: pendingFocusRevision},
		})
		return
	}
	if strings.TrimSpace(reason) == "" {
		reason = ExitReasonRequested
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(childCommand{
		ID:     id,
		Action: "close",
		Reason: reason,
	})
}

type commandStateRequest struct {
	Action             string `json:"action"`
	VisibilityRevision uint64 `json:"visibilityRevision"`
}

func (m *Manager) handleCommandStateAck(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var request commandStateRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid detached command acknowledgement", http.StatusBadRequest)
		return
	}
	request.Action = strings.ToLower(strings.TrimSpace(request.Action))
	if request.Action != "ack-focus" || request.VisibilityRevision == 0 {
		http.Error(w, "invalid detached command acknowledgement", http.StatusBadRequest)
		return
	}

	id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
	m.mu.Lock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.Unlock()
		http.Error(w, "unknown detached window", http.StatusNotFound)
		return
	}
	message := ""
	if entry.pendingFocusRevision == request.VisibilityRevision {
		entry.pendingFocusRevision = 0
	} else {
		message = "stale focus acknowledgement ignored"
	}
	visibilityRevision := entry.visibilityRevision
	m.mu.Unlock()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(OperationResult{
		Success:            true,
		ID:                 id,
		Message:            message,
		VisibilityRevision: visibilityRevision,
	})
}
