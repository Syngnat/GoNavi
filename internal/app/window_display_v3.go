//go:build wails3

package app

import (
	"context"

	"GoNavi-Wails/internal/desktop"
)

// Wails v3 reports window positions and screen work areas in one global DIP
// coordinate space on every platform.
const mainWindowPositionIsGlobal = true
const mainWindowSetPositionIsLocal = false

func mainWindowDisplayAreas(_ context.Context) []mainWindowDisplayArea {
	areas, ok := desktop.ScreenAreas()
	if !ok {
		return nil
	}
	result := make([]mainWindowDisplayArea, 0, len(areas))
	for _, area := range areas {
		result = append(result, mainWindowDisplayArea{
			X:       area.X,
			Y:       area.Y,
			Width:   area.Width,
			Height:  area.Height,
			Primary: area.Primary,
			Current: area.Current,
		})
	}
	return result
}
