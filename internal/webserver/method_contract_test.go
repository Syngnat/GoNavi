package webserver

import (
	"reflect"
	"strings"
	"testing"

	appcore "GoNavi-Wails/internal/app"
)

// 以下前缀的方法只对桌面本机有意义，或会读取/写入服务器本地文件。
// 新增这类方法时必须在 desktopOnlyAppMethods 里显式登记，否则 Web 运行时会
// 默认放行——此测试就是防止这条名单随 App 方法增长而漂移。
var desktopOnlyRequiredPrefixes = []string{
	"Open", "Select", "ReadSQL", "WriteSQL", "CreateSQL", "DeleteSQL", "RenameSQL",
	"SessionAgent", "FontGallery", "BackgroundGallery", "Reveal", "Shutdown", "Restart",
	"ForceQuit", "OpenDataRoot", "OpenLog", "OpenSavedQuery", "ExportDriverPackage",
}

// 只读角色不能调用的变更动词。viewer 使用正白名单，这里只做交叉校验：
// 任何新增的变更方法不应意外落进白名单前缀。
var viewerForbiddenPrefixes = []string{
	"Save", "Delete", "Create", "Update", "Rename", "Move", "Import", "Execute",
	"Run", "Start", "Stop", "Apply", "Set", "Add", "Remove", "Install", "Uninstall",
	"Download", "Write", "Restart", "Shutdown", "Clear", "Reset", "Retry", "Resume",
	"Commit", "Rollback", "ForceQuit",
}

func exportedAppMethodNames() []string {
	appType := reflect.TypeOf((*appcore.App)(nil))
	names := make([]string, 0, appType.NumMethod())
	for index := 0; index < appType.NumMethod(); index++ {
		method := appType.Method(index)
		if method.PkgPath != "" {
			continue
		}
		names = append(names, method.Name)
	}
	return names
}

func TestDesktopOnlyMethodListCoversLocalFileAndLifecycleMethods(t *testing.T) {
	for _, name := range exportedAppMethodNames() {
		if !matchesAnyPrefix(name, desktopOnlyRequiredPrefixes) {
			continue
		}
		if !isDesktopOnlyAppMethod(name) {
			t.Errorf("App method %s looks desktop-only but is reachable from the web runtime; add it to desktopOnlyAppMethods", name)
		}
	}
}

func TestViewerAllowlistNeverContainsMutatingMethods(t *testing.T) {
	for _, name := range exportedAppMethodNames() {
		if !matchesAnyPrefix(name, viewerForbiddenPrefixes) {
			continue
		}
		if viewerAllowedInvoke("app", name) {
			t.Errorf("mutating App method %s is allowed for the viewer role", name)
		}
	}
}

func matchesAnyPrefix(name string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}
