package app

import (
	"context"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/pluginmarket"
)

// PluginMarketInspect downloads and inspects exact artifact bytes before user trust.
func (a *App) PluginMarketInspect(id, version, digest, sourceID string) connection.QueryResult {
	return a.pluginMarketInspectContext(a.pluginContext(), id, version, digest, sourceID)
}

func (a *App) pluginMarketInspectContext(parent context.Context, id, version, digest, sourceID string) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	if sourceID == "" {
		return a.pluginFailure("invalid_request")
	}
	manager, err := a.pluginManager(parent)
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	return a.marketSourceCall(parent, sourceID, func(ctx context.Context, s *pluginmarket.Service) (any, error) {
		currentSource, err := s.CurrentSourceID()
		if err != nil {
			return nil, err
		}
		if currentSource != sourceID {
			return nil, pluginmarket.ErrSourceChanged
		}
		a.plugins.mutationMu.Lock()
		previous, err := verifyMarketInstallSource(ctx, s, manager, id)
		a.plugins.mutationMu.Unlock()
		if err != nil {
			return nil, err
		}
		path, cleanup, err := s.Download(ctx, id, version, digest)
		if err != nil {
			return nil, err
		}
		retained := false
		defer func() {
			if !retained {
				cleanup()
			}
		}()
		inspection, err := manager.Inspect(ctx, path)
		if err != nil {
			return nil, err
		}
		if inspection.Manifest.ID != id || inspection.Manifest.Version != version {
			return nil, pluginmarket.ErrInvalidResponse
		}
		approval := &marketInstallApproval{id: id, version: version, artifactDigest: digest, sourceID: sourceID, path: path, contentDigest: inspection.Digest, previousDigest: previous, service: s, cleanup: cleanup}
		if err = marketApprovalSource(s, approval); err != nil {
			return nil, err
		}
		token, err := a.registerMarketApproval(ctx, approval)
		if err != nil {
			return nil, err
		}
		retained = true
		inspection.SourcePath = "market:" + id
		return PluginMarketInspection{Inspection: inspection, SourceID: sourceID, ArtifactDigest: digest, ApprovalToken: token, ExpiresAt: approval.expires}, nil
	})
}

// PluginMarketCancelInspection releases a discarded preview without affecting installed plugins.
func (a *App) PluginMarketCancelInspection(token string) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	a.cancelMarketApproval(token)
	return connection.QueryResult{Success: true}
}
