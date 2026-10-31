package app

var pluginContextMethodNames = append([]string{
	"PluginInspect", "PluginInstall", "PluginSetEnabled", "PluginRemove", "PluginInvoke",
	"PluginSkills", "PluginSkillRead", "PluginSkillResourceRead", "PluginAIProviders", "PluginExporters",
	"PluginMarketConfigure", "PluginMarketCatalog", "PluginMarketDetail", "PluginMarketRatings",
	"PluginMarketInstall", "PluginMarketInspect",
}, marketSourceContextMethodNames...)

func withPluginContextHandlers(a *App, handlers map[string]any) map[string]any {
	handlers["PluginInspect"] = a.pluginInspectContext
	handlers["PluginInstall"] = a.pluginInstallContext
	handlers["PluginSetEnabled"] = a.pluginSetEnabledContext
	handlers["PluginRemove"] = a.pluginRemoveContext
	handlers["PluginInvoke"] = a.pluginInvokeContext
	handlers["PluginSkills"] = a.pluginSkillsContext
	handlers["PluginSkillRead"] = a.pluginSkillReadContext
	handlers["PluginSkillResourceRead"] = a.pluginSkillResourceReadContext
	handlers["PluginAIProviders"] = a.pluginAIProvidersContext
	handlers["PluginExporters"] = a.pluginExportersContext
	handlers["PluginMarketConfigure"] = a.pluginMarketConfigureContext
	handlers["PluginMarketCatalog"] = a.pluginMarketCatalogContext
	handlers["PluginMarketDetail"] = a.pluginMarketDetailContext
	handlers["PluginMarketRatings"] = a.pluginMarketRatingsContext
	handlers["PluginMarketInstall"] = a.pluginMarketInstallContext
	handlers["PluginMarketInspect"] = a.pluginMarketInspectContext
	return withMarketSourceContextHandlers(a, handlers)
}
