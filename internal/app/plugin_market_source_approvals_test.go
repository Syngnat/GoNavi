package app

import (
	"testing"

	"GoNavi-Wails/internal/pluginmarket"
)

func TestMarketSourceDisableDisposesOnlyInactiveApprovals(t *testing.T) {
	app := &App{}
	removed := 0
	kept := 0
	app.pluginMarket.approvals = map[string]*marketInstallApproval{
		"removed": {sourceID: "removed", cleanup: func() { removed++ }},
		"kept":    {sourceID: "kept", cleanup: func() { kept++ }},
	}
	app.cancelDisabledMarketApprovals([]pluginmarket.Source{{SourceID: "removed", Enabled: false}, {SourceID: "kept", Enabled: true}})
	if removed != 1 || kept != 0 || len(app.pluginMarket.approvals) != 1 || app.pluginMarket.approvals["kept"] == nil {
		t.Fatalf("removed=%d kept=%d approvals=%d", removed, kept, len(app.pluginMarket.approvals))
	}
}
