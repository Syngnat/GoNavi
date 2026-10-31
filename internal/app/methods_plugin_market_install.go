package app

import (
	"context"
	"errors"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/internal/pluginmarket"
)

// PluginMarketInstall consumes a one-use inspection approval, never remote metadata alone.
func (a *App) PluginMarketInstall(id, version, digest string, trusted bool, approvalToken string) connection.QueryResult {
	return a.pluginMarketInstallContext(a.pluginContext(), id, version, digest, trusted, approvalToken)
}

func (a *App) pluginMarketInstallContext(parent context.Context, id, version, digest string, trusted bool, approvalToken string) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	if !trusted {
		return a.pluginFailure("invalid_request")
	}
	approval, err := a.takeMarketApproval(parent, id, version, digest, approvalToken)
	if err != nil {
		return a.pluginFailure("invalid_request")
	}
	defer approval.dispose()
	manager, err := a.pluginManager(parent)
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	return a.marketCall(parent, func(ctx context.Context, s *pluginmarket.Service) (any, error) {
		if approval.service != s {
			scoped, err := s.ForSource(approval.sourceID)
			if err != nil {
				return nil, err
			}
			s = scoped
		}
		a.plugins.mutationMu.Lock()
		defer a.plugins.mutationMu.Unlock()
		if err := marketApprovalSource(s, approval); err != nil {
			return nil, err
		}
		current, err := verifyMarketInstallSource(ctx, s, manager, id)
		if err != nil {
			return nil, err
		}
		if current != approval.previousDigest {
			return nil, errors.New("installation changed after inspection")
		}
		if marketInstallAlreadyCurrent(manager, id, version) {
			return nil, errors.New("plugin already installed at this version")
		}
		request := plugin.InstallRequest{Path: approval.path, Digest: approval.contentDigest, Trusted: true}
		status, err := installMarketPackage(ctx, manager, request, current != "")
		if err != nil {
			return nil, err
		}
		if err = s.RecordInstall(ctx, id, approval.path, approval.contentDigest); err != nil {
			return status, err
		}
		return status, nil
	})
}

// marketInstallAlreadyCurrent rejects re-installing the exact version that is
// already present; updates must use a different version and therefore a new
// inspection approval.
func marketInstallAlreadyCurrent(manager interface{ List() []plugin.Status }, id, version string) bool {
	for _, status := range manager.List() {
		if status.Manifest.ID == id && status.Manifest.Version == version {
			return true
		}
	}
	return false
}

// pluginInstaller is the part of the manager this path needs. Keeping it narrow lets the
// install-or-replace decision be tested without a marketplace fixture.
type pluginInstaller interface {
	Install(context.Context, plugin.InstallRequest) (plugin.Status, error)
	ReplacePackage(context.Context, plugin.InstallRequest) (plugin.Status, error)
}

// installMarketPackage swaps an installed plugin in place, so a market update keeps the current
// enable intent instead of failing with "disable plugin before replacing its package".
func installMarketPackage(ctx context.Context, installer pluginInstaller, request plugin.InstallRequest, installed bool) (plugin.Status, error) {
	if installed {
		return installer.ReplacePackage(ctx, request)
	}
	return installer.Install(ctx, request)
}

func verifyMarketInstallSource(ctx context.Context, s *pluginmarket.Service, manager *plugin.Manager, id string) (string, error) {
	for _, status := range manager.List() {
		if status.Manifest.ID == id {
			return status.Digest, s.VerifyInstallSource(ctx, id, status.Digest)
		}
	}
	return "", s.ForgetInstall(ctx, id)
}

func (a *App) forgetPluginMarketSource(ctx context.Context, id string) {
	service, _, err := a.marketplace(ctx)
	if err == nil {
		if err = service.ForgetInstall(ctx, id); err != nil {
			a.pluginFailure("market_unavailable")
		}
	}
}
