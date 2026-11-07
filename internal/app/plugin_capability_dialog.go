package app

import (
	"context"
	"strings"
	"unicode/utf8"

	wailsRuntime "GoNavi-Wails/internal/desktop"
)

// pluginConfirmDialog stays replaceable so tests never open a native dialog.
var pluginConfirmDialog = wailsRuntime.MessageDialog

const (
	pluginDialogPermission = "ui.dialog"
	pluginDialogMaxTitle   = 128
	pluginDialogMaxMessage = 1024
	pluginDialogMaxLabel   = 32
)

type pluginDialogConfirmArguments struct {
	Title       string `json:"title,omitempty"`
	Message     string `json:"message"`
	ConfirmText string `json:"confirmText,omitempty"`
	CancelText  string `json:"cancelText,omitempty"`
}

// pluginCapabilityDialogConfirm shows the host's native question dialog. The
// plugin only learns whether the user confirmed; the dialog never renders
// plugin HTML and never runs anything by itself.
func pluginCapabilityDialogConfirm(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginDialogConfirmArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if a == nil || a.webRuntime || a.headlessRuntime || a.ctx == nil {
		return nil, "unsupported"
	}
	message := strings.TrimSpace(arguments.Message)
	if message == "" || len(message) > pluginDialogMaxMessage || !utf8.ValidString(message) {
		return nil, "invalid_arguments"
	}
	title := strings.TrimSpace(arguments.Title)
	if len(title) > pluginDialogMaxTitle || !utf8.ValidString(title) {
		return nil, "invalid_arguments"
	}
	confirmText := strings.TrimSpace(arguments.ConfirmText)
	if confirmText == "" {
		confirmText = "OK"
	}
	cancelText := strings.TrimSpace(arguments.CancelText)
	if cancelText == "" {
		cancelText = "Cancel"
	}
	if len(confirmText) > pluginDialogMaxLabel || len(cancelText) > pluginDialogMaxLabel {
		return nil, "invalid_arguments"
	}
	answer, err := pluginConfirmDialog(a.ctx, wailsRuntime.MessageDialogOptions{
		Type:          wailsRuntime.QuestionDialog,
		Title:         title,
		Message:       message,
		Buttons:       []string{cancelText, confirmText},
		DefaultButton: cancelText,
		CancelButton:  cancelText,
	})
	if err != nil {
		return nil, "internal"
	}
	return map[string]any{"confirmed": answer == confirmText}, ""
}
