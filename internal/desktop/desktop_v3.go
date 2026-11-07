//go:build wails3

package desktop

import (
	"context"
	"errors"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// FileFilter mirrors the v2 filter shape used by every call site.
type FileFilter struct {
	DisplayName string
	Pattern     string
}

type DialogType string

const (
	InfoDialog     DialogType = "info"
	WarningDialog  DialogType = "warning"
	ErrorDialog    DialogType = "error"
	QuestionDialog DialogType = "question"
)

// OpenDialogOptions mirrors the v2 open-dialog options. DefaultFilename has no
// v3 counterpart for file picking and is intentionally ignored.
type OpenDialogOptions struct {
	DefaultDirectory           string
	DefaultFilename            string
	Title                      string
	Filters                    []FileFilter
	ShowHiddenFiles            bool
	CanCreateDirectories       bool
	ResolvesAliases            bool
	TreatPackagesAsDirectories bool
}

type SaveDialogOptions struct {
	DefaultDirectory           string
	DefaultFilename            string
	Title                      string
	Filters                    []FileFilter
	ShowHiddenFiles            bool
	CanCreateDirectories       bool
	TreatPackagesAsDirectories bool
}

type MessageDialogOptions struct {
	Type          DialogType
	Title         string
	Message       string
	Buttons       []string
	DefaultButton string
	CancelButton  string
	Icon          []byte
}

var (
	bindMu sync.RWMutex
	bound  *application.App
	main   *application.WebviewWindow
)

// Bind records the v3 application and main window after they are created.
func Bind(app *application.App, window *application.WebviewWindow) {
	bindMu.Lock()
	defer bindMu.Unlock()
	bound = app
	main = window
}

func current() (*application.App, *application.WebviewWindow, error) {
	bindMu.RLock()
	defer bindMu.RUnlock()
	if bound == nil {
		return nil, nil, errors.New("desktop runtime is not bound")
	}
	return bound, main, nil
}

func toApplicationFilters(filters []FileFilter) []application.FileFilter {
	if len(filters) == 0 {
		return nil
	}
	result := make([]application.FileFilter, len(filters))
	for i, filter := range filters {
		result[i] = application.FileFilter{DisplayName: filter.DisplayName, Pattern: filter.Pattern}
	}
	return result
}

func OpenFileDialog(_ context.Context, options OpenDialogOptions) (string, error) {
	app, window, err := current()
	if err != nil {
		return "", err
	}
	dialog := app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		CanChooseFiles:                  true,
		CanChooseDirectories:            false,
		CanCreateDirectories:            options.CanCreateDirectories,
		ShowHiddenFiles:                 options.ShowHiddenFiles,
		ResolvesAliases:                 options.ResolvesAliases,
		TreatsFilePackagesAsDirectories: options.TreatPackagesAsDirectories,
		Filters:                         toApplicationFilters(options.Filters),
		Title:                           options.Title,
		Directory:                       options.DefaultDirectory,
		Window:                          window,
	})
	return dialog.PromptForSingleSelection()
}

func OpenDirectoryDialog(_ context.Context, options OpenDialogOptions) (string, error) {
	app, window, err := current()
	if err != nil {
		return "", err
	}
	dialog := app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		CanChooseFiles:                  false,
		CanChooseDirectories:            true,
		CanCreateDirectories:            options.CanCreateDirectories,
		ShowHiddenFiles:                 options.ShowHiddenFiles,
		ResolvesAliases:                 options.ResolvesAliases,
		TreatsFilePackagesAsDirectories: options.TreatPackagesAsDirectories,
		Title:                           options.Title,
		Directory:                       options.DefaultDirectory,
		Window:                          window,
	})
	return dialog.PromptForSingleSelection()
}

func SaveFileDialog(_ context.Context, options SaveDialogOptions) (string, error) {
	app, window, err := current()
	if err != nil {
		return "", err
	}
	dialog := app.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		CanCreateDirectories:            options.CanCreateDirectories,
		ShowHiddenFiles:                 options.ShowHiddenFiles,
		TreatsFilePackagesAsDirectories: options.TreatPackagesAsDirectories,
		Title:                           options.Title,
		Directory:                       options.DefaultDirectory,
		Filename:                        options.DefaultFilename,
		Filters:                         toApplicationFilters(options.Filters),
		Window:                          window,
	})
	return dialog.PromptForSingleSelection()
}

func newMessageDialog(app *application.App, dialogType DialogType) *application.MessageDialog {
	switch dialogType {
	case WarningDialog:
		return app.Dialog.Warning()
	case ErrorDialog:
		return app.Dialog.Error()
	case QuestionDialog:
		return app.Dialog.Question()
	default:
		return app.Dialog.Info()
	}
}

// MessageDialog keeps the v2 contract: it blocks until a button is clicked and
// returns that button's label. v3 buttons report through callbacks, so the
// facade bridges them back to the caller through a one-slot channel.
func MessageDialog(ctx context.Context, options MessageDialogOptions) (string, error) {
	app, window, err := current()
	if err != nil {
		return "", err
	}
	dialog := newMessageDialog(app, options.Type)
	dialog.SetTitle(options.Title).SetMessage(options.Message)
	if window != nil {
		dialog.AttachToWindow(window)
	}
	if len(options.Icon) > 0 {
		dialog.SetIcon(options.Icon)
	}

	buttons := options.Buttons
	if len(buttons) == 0 {
		buttons = []string{"OK"}
	}
	result := make(chan string, 1)
	var defaultButton, cancelButton *application.Button
	for _, label := range buttons {
		label := label
		button := dialog.AddButton(label)
		button.OnClick(func() {
			select {
			case result <- label:
			default:
			}
		})
		if label == options.DefaultButton {
			defaultButton = button
		}
		if label == options.CancelButton {
			cancelButton = button
		}
	}
	if defaultButton != nil {
		dialog.SetDefaultButton(defaultButton)
	}
	if cancelButton != nil {
		dialog.SetCancelButton(cancelButton)
	}

	dialog.Show()
	select {
	case label := <-result:
		return label, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func EventsOn(_ context.Context, eventName string, callback func(optionalData ...interface{})) func() {
	app, _, err := current()
	if err != nil {
		return func() {}
	}
	return app.Event.On(eventName, func(event *application.CustomEvent) {
		switch data := event.Data.(type) {
		case nil:
			callback()
		case []interface{}:
			callback(data...)
		default:
			callback(data)
		}
	})
}

func EventsEmit(_ context.Context, eventName string, optionalData ...interface{}) {
	app, _, err := current()
	if err != nil {
		return
	}
	app.Event.Emit(eventName, optionalData...)
}

func MenuUpdateApplicationMenu(_ context.Context) {
	app, _, err := current()
	if err != nil {
		return
	}
	if menu := app.Menu.GetApplicationMenu(); menu != nil {
		menu.Update()
	}
}

func WindowShow(_ context.Context) {
	if _, window, err := current(); err == nil && window != nil {
		window.Show()
	}
}

func WindowHide(_ context.Context) {
	if _, window, err := current(); err == nil && window != nil {
		window.Hide()
	}
}

func WindowSetTitle(_ context.Context, title string) {
	if _, window, err := current(); err == nil && window != nil {
		window.SetTitle(title)
	}
}

func WindowSetSize(_ context.Context, width int, height int) {
	if _, window, err := current(); err == nil && window != nil {
		window.SetSize(width, height)
	}
}

func WindowSetPosition(_ context.Context, x int, y int) {
	if _, window, err := current(); err == nil && window != nil {
		window.SetPosition(x, y)
	}
}

func WindowUnminimise(_ context.Context) {
	if _, window, err := current(); err == nil && window != nil {
		window.UnMinimise()
	}
}

func Show(_ context.Context) {
	if _, window, err := current(); err == nil && window != nil {
		window.Show()
		window.Focus()
	}
}

func Quit(_ context.Context) {
	if app, _, err := current(); err == nil {
		app.Quit()
	}
}

func ClipboardGetText(_ context.Context) (string, error) {
	app, _, err := current()
	if err != nil {
		return "", err
	}
	text, ok := app.Clipboard.Text()
	if !ok {
		return "", errors.New("clipboard is unavailable")
	}
	return text, nil
}

func ClipboardSetText(_ context.Context, text string) error {
	app, _, err := current()
	if err != nil {
		return err
	}
	if !app.Clipboard.SetText(text) {
		return errors.New("clipboard is unavailable")
	}
	return nil
}

func BrowserOpenURL(_ context.Context, url string) {
	if app, _, err := current(); err == nil {
		_ = app.Browser.OpenURL(url)
	}
}
