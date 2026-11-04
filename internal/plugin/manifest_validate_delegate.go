package plugin

import (
	"encoding/json"
	"errors"

	sdk "github.com/Syngnat/GoNavi/sdk/go"
)

// ValidateManifest applies the manifest contract, whose single implementation
// lives in the published SDK so the marketplace cannot drift from the host.
//
// The two packages keep separate Manifest types on purpose: the host's
// Contributes is a value (many call sites read it without a nil check) while the
// SDK's is a pointer, and the runtime routes off the host types. Only the rules
// are shared. The conversion below is field by field rather than a JSON round
// trip: encoding/json replaces invalid UTF-8 with U+FFFD, which would let a
// manifest carrying a broken string through the SDK's utf8.ValidString checks.
func ValidateManifest(m Manifest) error {
	err := sdk.ValidateManifest(toSDKManifest(m))
	// Callers branch on the host sentinel (internal/app maps it to a user-facing
	// error code), so translate the SDK's copy instead of letting a second,
	// non-matching sentinel escape.
	if errors.Is(err, sdk.ErrDataSourceWriteEffect) {
		return ErrDataSourceWriteEffect
	}
	return err
}

func toSDKManifest(m Manifest) sdk.Manifest {
	shared := sdk.Manifest{
		SchemaVersion:  m.SchemaVersion,
		APIVersion:     m.APIVersion,
		ID:             m.ID,
		Name:           m.Name,
		Version:        m.Version,
		Description:    m.Description,
		Author:         m.Author,
		License:        m.License,
		Icon:           m.Icon,
		MinHostVersion: m.MinHostVersion,
		Permissions:    m.Permissions,
	}
	if len(m.PermissionNotes) > 0 {
		shared.PermissionNotes = make(map[string]string, len(m.PermissionNotes))
		for key, note := range m.PermissionNotes {
			shared.PermissionNotes[key] = note
		}
	}
	if len(m.Requires) > 0 {
		shared.Requires = make([]sdk.Requirement, 0, len(m.Requires))
		for _, dependency := range m.Requires {
			shared.Requires = append(shared.Requires, sdk.Requirement{
				ID: dependency.ID, MinVersion: dependency.MinVersion, Optional: dependency.Optional,
			})
		}
	}
	if m.Backend != nil {
		shared.Backend = &sdk.Backend{Platforms: make(map[string]sdk.Entry, len(m.Backend.Platforms))}
		if m.Backend.Default != nil {
			entry := toSDKEntry(*m.Backend.Default)
			shared.Backend.Default = &entry
		}
		for platform, entry := range m.Backend.Platforms {
			shared.Backend.Platforms[platform] = toSDKEntry(entry)
		}
	}
	contributions := toSDKContributions(m.Contributes)
	shared.Contributes = &contributions
	if m.Window != nil {
		shared.Window = &sdk.Window{
			Entry: m.Window.Entry, Title: m.Window.Title, Width: m.Window.Width, Height: m.Window.Height,
		}
	}
	return shared
}

func toSDKEntry(entry Entry) sdk.Entry {
	shared := sdk.Entry{Executable: entry.Executable, Runtime: entry.Runtime}
	if len(entry.Args) > 0 {
		shared.Args = append([]string(nil), entry.Args...)
	}
	return shared
}

func toSDKContributions(c Contributions) sdk.Contributions {
	shared := sdk.Contributions{}
	for _, command := range c.Commands {
		shared.Commands = append(shared.Commands, sdk.Command{
			ID: command.ID, Title: command.Title, Description: command.Description,
			InputSchema: command.InputSchema, Effect: command.Effect,
		})
	}
	for _, panel := range c.Panels {
		shared.Panels = append(shared.Panels, sdk.Panel{
			ID: panel.ID, Title: panel.Title, Body: toSDKUINode(panel.Body), HTML: toSDKHTMLPanel(panel.HTML),
		})
	}
	for _, source := range c.DataSources {
		shared.DataSources = append(shared.DataSources, sdk.DataSource{
			ID: source.ID, Name: source.Name, Dialect: source.Dialect,
			Command: source.Command, DefaultPort: source.DefaultPort, ReadOnly: source.ReadOnly,
		})
	}
	for _, skill := range c.Skills {
		shared.Skills = append(shared.Skills, sdk.Skill{
			ID: skill.ID, Name: skill.Name, Description: skill.Description,
			Entry: skill.Entry, Resources: skill.Resources,
		})
	}
	for _, provider := range c.AIProviders {
		converted := sdk.AIProvider{
			ID: provider.ID, Name: provider.Name, Command: provider.Command, Icon: provider.Icon,
			DefaultBaseURL: provider.DefaultBaseURL,
			SupportsTools:  provider.SupportsTools, SupportsImages: provider.SupportsImages,
		}
		for _, model := range provider.Models {
			converted.Models = append(converted.Models, sdk.AIModel{
				ID: model.ID, Name: model.Name,
				ContextWindow: model.ContextWindow, MaxOutputTokens: model.MaxOutputTokens,
			})
		}
		shared.AIProviders = append(shared.AIProviders, converted)
	}
	for _, exporter := range c.Exporters {
		shared.Exporters = append(shared.Exporters, sdk.Exporter{
			ID: exporter.ID, Name: exporter.Name, Command: exporter.Command,
			Extension: exporter.Extension, ContentType: exporter.ContentType, Streaming: exporter.Streaming,
		})
	}
	for _, page := range c.Pages {
		converted := sdk.Page{ID: page.ID, Title: page.Title, HTML: toSDKHTMLPanel(page.HTML)}
		if page.Body != nil {
			body := toSDKUINode(*page.Body)
			converted.Body = &body
		}
		shared.Pages = append(shared.Pages, converted)
	}
	for _, item := range c.Navigation {
		shared.Navigation = append(shared.Navigation, sdk.Navigation{
			ID: item.ID, Title: item.Title, Target: item.Target, Page: item.Page,
			Location: item.Location, Order: item.Order,
		})
	}
	for _, action := range c.ConnectionActions {
		shared.ConnectionActions = append(shared.ConnectionActions, sdk.ConnectionAction{
			ID: action.ID, Title: action.Title, Description: action.Description,
			ConnectionTypes: action.ConnectionTypes, Scopes: action.Scopes,
			Target: sdk.LaunchTarget{Type: action.Target.Type, Page: action.Target.Page},
		})
	}
	for _, group := range c.Sidebar {
		converted := sdk.SidebarGroup{
			ID: group.ID, Title: group.Title, Icon: group.Icon,
			ListCommand: group.ListCommand, EmptyText: group.EmptyText, Order: group.Order,
		}
		if group.Open != nil {
			converted.Open = &sdk.LaunchTarget{Type: group.Open.Type, Page: group.Open.Page, View: group.Open.View}
		}
		shared.Sidebar = append(shared.Sidebar, converted)
	}
	for _, view := range c.Views {
		shared.Views = append(shared.Views, sdk.View{
			ID: view.ID, Title: view.Title, Page: view.Page, Location: view.Location,
			Icon: view.Icon, Order: view.Order,
		})
	}
	return shared
}

func toSDKHTMLPanel(panel *HTMLPanel) *sdk.PageHTML {
	if panel == nil {
		return nil
	}
	return &sdk.PageHTML{Source: panel.Source}
}

func toSDKUINode(node UINode) sdk.UINode {
	shared := sdk.UINode{
		Type: node.Type, Text: node.Text, Title: node.Title,
		Command: node.Command, Arguments: node.Arguments,
	}
	for _, child := range node.Children {
		shared.Children = append(shared.Children, toSDKUINode(child))
	}
	for _, column := range node.Columns {
		shared.Columns = append(shared.Columns, sdk.Column{Key: column.Key, Title: column.Title})
	}
	for _, row := range node.Rows {
		copied := make(map[string]json.RawMessage, len(row))
		for key, value := range row {
			copied[key] = value
		}
		shared.Rows = append(shared.Rows, copied)
	}
	return shared
}
