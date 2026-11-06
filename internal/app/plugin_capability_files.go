package app

import (
	"context"
	"regexp"
	"strings"
	"unicode/utf8"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Native dialogs stay replaceable so tests observe the exact options without
// opening a real window.
var (
	openPluginFileDialog   = wailsRuntime.OpenFileDialog
	openPluginFolderDialog = wailsRuntime.OpenDirectoryDialog
	savePluginFileDialog   = wailsRuntime.SaveFileDialog
)

// pluginFilesPermission gates the native picker capabilities. It stays in this
// package because the protocol contract test treats every "host.*" literal in
// internal/plugin as a JSON-RPC method name, and this is a capability permission.
const pluginFilesPermission = "host.files"

const (
	pluginFilesMaxTitleBytes  = 256
	pluginFilesMaxExtensions  = 16
	pluginFilesMaxExtension   = 64
	pluginFilesMaxDefaultName = 255
)

var pluginFileExtensionPattern = regexp.MustCompile(`^[A-Za-z0-9*?._-]{1,64}$`)

type pluginFilesPickArguments struct {
	Mode       string   `json:"mode"`
	Title      string   `json:"title,omitempty"`
	Extensions []string `json:"extensions,omitempty"`
}

type pluginFilesSaveArguments struct {
	Title       string   `json:"title,omitempty"`
	DefaultName string   `json:"defaultName,omitempty"`
	Extensions  []string `json:"extensions,omitempty"`
}

type pluginFilesTarget struct {
	Path string `json:"path"`
}

// pluginCapabilityFilesPick shows the host's native file or folder picker and
// returns the chosen path. The plugin owns the actual transfer, so SFTP-style
// uploads never need to stream bytes through the page bridge.
func pluginCapabilityFilesPick(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginFilesPickArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if a == nil || a.webRuntime || a.headlessRuntime || a.ctx == nil {
		return nil, "unsupported"
	}
	if !pluginFilesOptionsValid(arguments.Title, arguments.Extensions) {
		return nil, "invalid_arguments"
	}
	filters := pluginFilesFilters(arguments.Extensions)
	switch arguments.Mode {
	case "", "file":
		path, err := openPluginFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{Title: arguments.Title, Filters: filters})
		if err != nil {
			return nil, "internal"
		}
		return pluginFilesTarget{Path: path}, ""
	case "folder":
		path, err := openPluginFolderDialog(a.ctx, wailsRuntime.OpenDialogOptions{Title: arguments.Title})
		if err != nil {
			return nil, "internal"
		}
		return pluginFilesTarget{Path: path}, ""
	default:
		return nil, "invalid_arguments"
	}
}

// pluginCapabilityFilesSave shows the native save dialog. The plugin writes the
// file itself; the host never touches the chosen path.
func pluginCapabilityFilesSave(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginFilesSaveArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if a == nil || a.webRuntime || a.headlessRuntime || a.ctx == nil {
		return nil, "unsupported"
	}
	if !pluginFilesOptionsValid(arguments.Title, arguments.Extensions) || !pluginFilesDefaultNameValid(arguments.DefaultName) {
		return nil, "invalid_arguments"
	}
	path, err := savePluginFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title: arguments.Title, DefaultFilename: arguments.DefaultName, Filters: pluginFilesFilters(arguments.Extensions),
	})
	if err != nil {
		return nil, "internal"
	}
	return pluginFilesTarget{Path: path}, ""
}

func pluginFilesOptionsValid(title string, extensions []string) bool {
	if len(title) > pluginFilesMaxTitleBytes || !utf8.ValidString(title) || strings.ContainsRune(title, 0) {
		return false
	}
	if len(extensions) > pluginFilesMaxExtensions {
		return false
	}
	for _, value := range extensions {
		if !pluginFileExtensionPattern.MatchString(value) {
			return false
		}
	}
	return true
}

// pluginFilesDefaultName rejects path separators so a page cannot steer the
// dialog into another directory through the suggested file name.
func pluginFilesDefaultNameValid(name string) bool {
	if name == "" {
		return true
	}
	if len(name) > pluginFilesMaxDefaultName || !utf8.ValidString(name) || strings.ContainsRune(name, 0) {
		return false
	}
	return !strings.ContainsAny(name, `/\`)
}

func pluginFilesFilters(extensions []string) []wailsRuntime.FileFilter {
	if len(extensions) == 0 {
		return nil
	}
	return []wailsRuntime.FileFilter{{DisplayName: "Files", Pattern: strings.Join(extensions, ";")}}
}
