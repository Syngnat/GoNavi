package plugin

import "GoNavi-Wails/internal/buildversion"

// hostCompatibilityReason reports why this host cannot run a manifest, or the
// empty string when it can. Install and replace refuse a mismatched package up
// front; the runtime reconcile path uses the same rule so a record can never
// reach "blocked" for a reason installation would have accepted.
func (m *Manager) hostCompatibilityReason(manifest Manifest) string {
	if manifest.MinHostVersion == "" {
		return ""
	}
	if buildversion.SatisfiesMinimum(m.opts.HostVersion, manifest.MinHostVersion) {
		return ""
	}
	return "plugin requires a newer compatible host version"
}
