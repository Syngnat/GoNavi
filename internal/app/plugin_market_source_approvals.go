package app

import "GoNavi-Wails/internal/pluginmarket"

func (a *App) cancelDisabledMarketApprovals(sources []pluginmarket.Source) {
	enabled := make(map[string]bool, len(sources))
	for _, source := range sources {
		if source.Enabled {
			enabled[source.SourceID] = true
		}
	}
	var discarded []*marketInstallApproval
	state := &a.pluginMarket
	state.mu.Lock()
	for token, approval := range state.approvals {
		if !enabled[approval.sourceID] {
			delete(state.approvals, token)
			discarded = append(discarded, approval)
		}
	}
	state.mu.Unlock()
	for _, approval := range discarded {
		approval.dispose()
	}
}
