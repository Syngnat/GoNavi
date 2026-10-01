package aiservice

import (
	"context"
	"errors"
	"strings"

	"GoNavi-Wails/internal/ai/runharness"
)

// AIGetAutoApprovalSettings returns the current "always approve" choices.
func (s *Service) AIGetAutoApprovalSettings() AutoApprovalSettings {
	return s.autoApproval.snapshot(s.autoApprovalDir())
}

// AISetGlobalAutoApproval turns "always approve" on or off for every session.
func (s *Service) AISetGlobalAutoApproval(enabled bool) (AutoApprovalSettings, error) {
	return s.autoApproval.update(s.autoApprovalDir(), func(settings *AutoApprovalSettings) {
		settings.Global = enabled
	})
}

// AISetSessionAutoApproval turns "always approve" on or off for one session.
func (s *Service) AISetSessionAutoApproval(sessionID string, enabled bool) (AutoApprovalSettings, error) {
	id := strings.TrimSpace(sessionID)
	if id == "" {
		return AutoApprovalSettings{}, errors.New("session id is required")
	}
	return s.autoApproval.update(s.autoApprovalDir(), func(settings *AutoApprovalSettings) {
		kept := make([]string, 0, len(settings.SessionIDs)+1)
		for _, granted := range settings.SessionIDs {
			if granted != id {
				kept = append(kept, granted)
			}
		}
		if enabled {
			kept = append(kept, id)
		}
		settings.SessionIDs = kept
	})
}

// AIClearSessionAutoApprovals revokes the per-session grants; the global
// switch is left as it is.
func (s *Service) AIClearSessionAutoApprovals() (AutoApprovalSettings, error) {
	return s.autoApproval.update(s.autoApprovalDir(), func(settings *AutoApprovalSettings) {
		settings.SessionIDs = nil
	})
}

func (s *Service) autoApprovalDir() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.configDir
}

// serviceAutoApprovalPolicy adapts the stored choices to the run harness.
type serviceAutoApprovalPolicy struct{ service *Service }

func (p serviceAutoApprovalPolicy) AutoApprove(_ context.Context, request runharness.AutoApprovalRequest) bool {
	return p.service.autoApproval.allows(p.service.autoApprovalDir(), request.SessionID)
}
