package plugin

// Appearance permissions gate the host-window capabilities a plugin page uses to
// drive the app background and the built-in gallery. The Go gateway still lists
// the methods for introspection, but the frontend page bridge executes them in the
// host window where the background store lives.
const (
	AppearanceReadPermission  = "host.appearance.read"
	AppearanceWritePermission = "host.appearance.write"
)

// AppearanceSettingsSlot is the host-owned settings position kept in place even
// when no plugin provides the page.
const AppearanceSettingsSlot = "appearance.background"
