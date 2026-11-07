//go:build !wails3

package desktop

import (
	"context"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// The v2 implementation keeps the exact runtime types and semantics, so the
// shipping desktop build behaves identically while call sites move off the
// framework import.
type (
	FileFilter           = wailsRuntime.FileFilter
	DialogType           = wailsRuntime.DialogType
	OpenDialogOptions    = wailsRuntime.OpenDialogOptions
	SaveDialogOptions    = wailsRuntime.SaveDialogOptions
	MessageDialogOptions = wailsRuntime.MessageDialogOptions
)

const (
	InfoDialog     = wailsRuntime.InfoDialog
	WarningDialog  = wailsRuntime.WarningDialog
	ErrorDialog    = wailsRuntime.ErrorDialog
	QuestionDialog = wailsRuntime.QuestionDialog
)

func OpenFileDialog(ctx context.Context, options OpenDialogOptions) (string, error) {
	return wailsRuntime.OpenFileDialog(ctx, options)
}

func OpenDirectoryDialog(ctx context.Context, options OpenDialogOptions) (string, error) {
	return wailsRuntime.OpenDirectoryDialog(ctx, options)
}

func SaveFileDialog(ctx context.Context, options SaveDialogOptions) (string, error) {
	return wailsRuntime.SaveFileDialog(ctx, options)
}

func MessageDialog(ctx context.Context, options MessageDialogOptions) (string, error) {
	return wailsRuntime.MessageDialog(ctx, options)
}

func EventsOn(ctx context.Context, eventName string, callback func(optionalData ...interface{})) func() {
	return wailsRuntime.EventsOn(ctx, eventName, callback)
}

func EventsEmit(ctx context.Context, eventName string, optionalData ...interface{}) {
	wailsRuntime.EventsEmit(ctx, eventName, optionalData...)
}

func MenuUpdateApplicationMenu(ctx context.Context) {
	wailsRuntime.MenuUpdateApplicationMenu(ctx)
}

func WindowShow(ctx context.Context) {
	wailsRuntime.WindowShow(ctx)
}

func WindowHide(ctx context.Context) {
	wailsRuntime.WindowHide(ctx)
}

func WindowSetTitle(ctx context.Context, title string) {
	wailsRuntime.WindowSetTitle(ctx, title)
}

func WindowSetSize(ctx context.Context, width int, height int) {
	wailsRuntime.WindowSetSize(ctx, width, height)
}

func WindowSetPosition(ctx context.Context, x int, y int) {
	wailsRuntime.WindowSetPosition(ctx, x, y)
}

func WindowUnminimise(ctx context.Context) {
	wailsRuntime.WindowUnminimise(ctx)
}

func Show(ctx context.Context) {
	wailsRuntime.Show(ctx)
}

func Quit(ctx context.Context) {
	wailsRuntime.Quit(ctx)
}

func ClipboardGetText(ctx context.Context) (string, error) {
	return wailsRuntime.ClipboardGetText(ctx)
}

func ClipboardSetText(ctx context.Context, text string) error {
	return wailsRuntime.ClipboardSetText(ctx, text)
}

func BrowserOpenURL(ctx context.Context, url string) {
	wailsRuntime.BrowserOpenURL(ctx, url)
}
