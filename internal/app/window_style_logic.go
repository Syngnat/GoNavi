package app

import "strings"

type macNativeWindowControlState struct {
	ShowNativeButtons     bool
	UseTitledWindow       bool
	UseFullSizeContent    bool
	HideWindowTitle       bool
	TransparentTitlebar   bool
	AllowNativeFullscreen bool
}

func resolveMacNativeWindowControlState(bool) macNativeWindowControlState {
	return macNativeWindowControlState{
		ShowNativeButtons:     true,
		UseTitledWindow:       true,
		UseFullSizeContent:    true,
		HideWindowTitle:       true,
		TransparentTitlebar:   true,
		AllowNativeFullscreen: true,
	}
}

type macWindowIdentity struct {
	ClassName         string
	DelegateClassName string
	Title             string
}

// shouldApplyMacNativeWindowStyle 只允许对主 WailsWindow 应用原生标题栏/全屏能力，
// 避免误伤输入法候选窗、全屏过渡窗等系统辅助窗口。
func shouldApplyMacNativeWindowStyle(identity macWindowIdentity) bool {
	className := strings.TrimSpace(identity.ClassName)
	delegateClassName := strings.TrimSpace(identity.DelegateClassName)
	title := strings.TrimSpace(identity.Title)

	if className == "WailsWindow" || delegateClassName == "WindowDelegate" {
		return true
	}

	// 兜底只接受明确命名的主应用窗口，避免把无标题系统辅助窗口纳入样式改写范围。
	return title == "GoNavi"
}
