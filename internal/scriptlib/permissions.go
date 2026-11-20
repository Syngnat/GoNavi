package scriptlib

import "strings"

const (
	desktopOwnerID = "desktop:local"
	webOwnerPrefix = "web:"
)

// DesktopOwner returns the stable principal used by the native desktop app.
func DesktopOwner() string {
	return desktopOwnerID
}

// WebOwner returns the stable principal namespace for an authenticated web user.
func WebOwner(username string) string {
	username = strings.ToLower(strings.TrimSpace(username))
	if username == "" {
		return ""
	}
	if strings.HasPrefix(username, webOwnerPrefix) {
		return username
	}
	return webOwnerPrefix + username
}

func normalizeOwner(owner string) string {
	owner = strings.ToLower(strings.TrimSpace(owner))
	switch {
	case owner == "":
		return ""
	case owner == "local":
		// Legacy desktop scripts used the bare "local" owner.
		return desktopOwnerID
	case strings.HasPrefix(owner, "desktop:"), strings.HasPrefix(owner, webOwnerPrefix):
		return owner
	default:
		// Legacy web scripts used the bare normalized login name.
		return webOwnerPrefix + owner
	}
}

func isDesktopOwner(owner string) bool {
	return normalizeOwner(owner) == desktopOwnerID
}

func displayOwner(owner string) string {
	normalized := normalizeOwner(owner)
	switch {
	case normalized == desktopOwnerID:
		return "local"
	case strings.HasPrefix(normalized, webOwnerPrefix):
		return strings.TrimPrefix(normalized, webOwnerPrefix)
	default:
		return normalized
	}
}

func normalizeStoredVisibility(value Visibility) Visibility {
	if strings.EqualFold(strings.TrimSpace(string(value)), string(VisibilityShared)) {
		return VisibilityShared
	}
	return VisibilityPrivate
}

func canReadScript(script Script, actor Actor) bool {
	if script.Visibility == VisibilityShared {
		return true
	}
	actorOwner := normalizeOwner(actor.Owner)
	return actorOwner != "" && normalizeOwner(script.Owner) == actorOwner
}

func canReadFolder(folder Folder, actor Actor) bool {
	if folder.Visibility == VisibilityShared {
		return true
	}
	actorOwner := normalizeOwner(actor.Owner)
	return actorOwner != "" && normalizeOwner(folder.Owner) == actorOwner
}

func canEditScript(script Script, actor Actor) bool {
	return canEditItem(script.Owner, script.Visibility, actor)
}

func canEditFolder(folder Folder, actor Actor) bool {
	return canEditItem(folder.Owner, folder.Visibility, actor)
}

func canEditItem(owner string, visibility Visibility, actor Actor) bool {
	if actor.ReadOnly {
		return false
	}
	actorOwner := normalizeOwner(actor.Owner)
	if actorOwner == "" {
		return false
	}
	ownerMatches := normalizeOwner(owner) == actorOwner
	if visibility == VisibilityShared {
		return ownerMatches || actor.CanManageShared || isDesktopOwner(actor.Owner)
	}
	return ownerMatches
}

func canCreateVisibility(actor Actor, visibility Visibility) bool {
	if actor.ReadOnly {
		return false
	}
	if normalizeOwner(actor.Owner) == "" {
		return false
	}
	return visibility == VisibilityPrivate || visibility == VisibilityShared
}

func visibleScript(script Script, actor Actor) Script {
	canEdit := canEditScript(script, actor)
	script.CanEdit = canEdit
	script.CanShare = canEdit
	if script.Visibility == VisibilityShared {
		script.Connections = sanitizeConnections(script.Connections)
		script.Inputs = sanitizeInputs(script.Inputs)
	}
	// Public DTOs keep the historical display value so existing clients can
	// compare snapshot.owner with script.owner without seeing internal namespaces.
	script.Owner = displayOwner(script.Owner)
	return script
}

func visibleFolder(folder Folder, actor Actor) Folder {
	canEdit := canEditFolder(folder, actor)
	folder.CanEdit = canEdit
	folder.CanShare = canEdit
	folder.Owner = displayOwner(folder.Owner)
	return folder
}

func sanitizeConnections(items []ConnectionBinding) []ConnectionBinding {
	result := make([]ConnectionBinding, 0, len(items))
	for _, item := range items {
		item.ConnectionID = ""
		result = append(result, item)
	}
	return result
}

func sanitizeInputs(items []InputBinding) []InputBinding {
	result := make([]InputBinding, 0, len(items))
	for _, item := range items {
		item.Path = ""
		item.Reference = ""
		result = append(result, item)
	}
	return result
}
