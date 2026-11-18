//go:build !windows && (!darwin || !cgo) && !wails3

package app

import "context"

const mainWindowSetPositionIsLocal = false

// Linux 的 WindowGetPosition 返回全局坐标；无显示器列表时保留原回退逻辑。
const mainWindowPositionIsGlobal = true

func mainWindowDisplayAreas(_ context.Context) []mainWindowDisplayArea {
	return nil
}
