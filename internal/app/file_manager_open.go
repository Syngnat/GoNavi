package app

import "GoNavi-Wails/internal/desktop"

// openDirectoryNatively uses the v3 environment service; v2 falls through to
// the existing explorer/open/xdg-open commands.
func openDirectoryNatively(directory string) bool {
	return desktop.OpenFileManager(directory, false) == nil
}

// revealFileNatively selects a file in the platform file manager on v3.
func revealFileNatively(filePath string) bool {
	return desktop.OpenFileManager(filePath, true) == nil
}
