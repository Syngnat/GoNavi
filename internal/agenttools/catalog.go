// Package agenttools builds the desktop AI Agent tool catalog shared by the
// Wails v2 and v3 entry points.
package agenttools

import (
	"context"

	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/mcpserver"
	"GoNavi-Wails/internal/plugin"
)

// NewDesktopToolCatalog returns the complete host tool catalog: database/MCP
// tools, snapshot-bound workspace inspection, app plugins and plugin skills.
// The catalog owns no desktop lifecycle; it borrows the already-created backend.
func NewDesktopToolCatalog(application *appcore.App, aiService *aiservice.Service) (*mcpserver.CompositeToolCatalog, error) {
	backend, err := mcpserver.NewAppBackendFromApp(application)
	if err != nil {
		return nil, err
	}
	ordinary := mcpserver.NewCompositeToolCatalog(
		mcpserver.NewAgentToolCatalogWithDynamicSource(backend, mcpserver.NewServiceMCPSource(aiService)),
		mcpserver.NewWorkspaceSnapshotToolCatalog(),
		mcpserver.NewAppPluginToolCatalog(func(ctx context.Context) (*plugin.Manager, error) {
			return appcore.PluginManagerForIntegration(ctx, application)
		}),
	)
	skills := mcpserver.NewAppPluginSkillCatalog(func(ctx context.Context) (*plugin.Manager, error) {
		return appcore.PluginSkillManagerForIntegration(ctx, application)
	})
	return mcpserver.NewCompositeToolCatalog(mcpserver.NewPluginSkillAugmentedCatalog(ordinary, skills)), nil
}
