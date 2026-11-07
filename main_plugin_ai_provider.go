//go:build !bindings && !wails3

package main

import (
	"errors"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/app"
)

func configureDesktopPluginAIProvider(application *app.App, service *aiservice.Service) error {
	if application == nil {
		return errors.New("plugin provider application is required")
	}
	return aiservice.ConfigurePluginProviderFactory(service, app.PluginAIProviderFactoryForIntegration(application))
}
