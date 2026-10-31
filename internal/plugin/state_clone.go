package plugin

import "encoding/json"

// cloneDiskState returns a state that callers may mutate freely. The cache keeps the
// validated original, and List/Status snapshots escape to UI code that is allowed to edit
// nested slices (the permission list is the historical example), so every read gets its own
// copy of the manifest tree.
func cloneDiskState(state diskState) diskState {
	clone := state
	clone.Records = make(map[string]record, len(state.Records))
	for id, value := range state.Records {
		value.Manifest = cloneManifest(value.Manifest)
		clone.Records[id] = value
	}
	return clone
}

func cloneManifest(m Manifest) Manifest {
	clone := m
	clone.Permissions = append([]string(nil), m.Permissions...)
	if m.PermissionNotes != nil {
		clone.PermissionNotes = make(map[string]string, len(m.PermissionNotes))
		for key, value := range m.PermissionNotes {
			clone.PermissionNotes[key] = value
		}
	}
	clone.Requires = append([]Dependency(nil), m.Requires...)
	if m.Backend != nil {
		backend := *m.Backend
		if backend.Default != nil {
			entry := *backend.Default
			entry.Args = append([]string(nil), backend.Default.Args...)
			backend.Default = &entry
		}
		if backend.Platforms != nil {
			platforms := make(map[string]Entry, len(backend.Platforms))
			for key, entry := range backend.Platforms {
				entry.Args = append([]string(nil), entry.Args...)
				platforms[key] = entry
			}
			backend.Platforms = platforms
		}
		clone.Backend = &backend
	}
	if m.Window != nil {
		window := *m.Window
		clone.Window = &window
	}
	clone.ConfigSchema = append(json.RawMessage(nil), m.ConfigSchema...)
	clone.Contributes = cloneContributions(m.Contributes)
	return clone
}

func cloneContributions(c Contributions) Contributions {
	clone := c
	clone.Commands = make([]Command, len(c.Commands))
	for i, command := range c.Commands {
		command.InputSchema = append(json.RawMessage(nil), command.InputSchema...)
		clone.Commands[i] = command
	}
	clone.Panels = make([]Panel, len(c.Panels))
	for i, panel := range c.Panels {
		panel.Body = cloneUINode(panel.Body)
		if panel.HTML != nil {
			html := *panel.HTML
			panel.HTML = &html
		}
		clone.Panels[i] = panel
	}
	clone.DataSources = append([]DataSource(nil), c.DataSources...)
	clone.Skills = make([]Skill, len(c.Skills))
	for i, skill := range c.Skills {
		skill.Resources = append([]string(nil), skill.Resources...)
		clone.Skills[i] = skill
	}
	clone.AIProviders = make([]AIProvider, len(c.AIProviders))
	for i, provider := range c.AIProviders {
		provider.Models = append([]AIModel(nil), provider.Models...)
		clone.AIProviders[i] = provider
	}
	clone.Exporters = append([]Exporter(nil), c.Exporters...)
	clone.Pages = make([]Page, len(c.Pages))
	for i, page := range c.Pages {
		if page.Body != nil {
			body := cloneUINode(*page.Body)
			page.Body = &body
		}
		if page.HTML != nil {
			html := *page.HTML
			page.HTML = &html
		}
		clone.Pages[i] = page
	}
	clone.Navigation = append([]Navigation(nil), c.Navigation...)
	clone.ConnectionActions = make([]ConnectionAction, len(c.ConnectionActions))
	for i, action := range c.ConnectionActions {
		action.ConnectionTypes = append([]string(nil), action.ConnectionTypes...)
		action.Scopes = append([]string(nil), action.Scopes...)
		clone.ConnectionActions[i] = action
	}
	return clone
}

func cloneUINode(node UINode) UINode {
	clone := node
	clone.Arguments = append(json.RawMessage(nil), node.Arguments...)
	clone.Columns = append([]Column(nil), node.Columns...)
	clone.Children = make([]UINode, len(node.Children))
	for i, child := range node.Children {
		clone.Children[i] = cloneUINode(child)
	}
	clone.Rows = make([]map[string]json.RawMessage, len(node.Rows))
	for i, row := range node.Rows {
		cells := make(map[string]json.RawMessage, len(row))
		for key, value := range row {
			cells[key] = append(json.RawMessage(nil), value...)
		}
		clone.Rows[i] = cells
	}
	return clone
}
