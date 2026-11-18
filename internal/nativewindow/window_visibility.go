//go:build !wails3

package nativewindow

const (
	detachedWindowDragRegionHeight = 36
	detachedWindowMinVisibleWidth  = 96
	detachedWindowMinVisibleHeight = 24
)

func normalizeDetachedWindowBounds(bounds WindowBounds) WindowBounds {
	return normalizeDetachedWindowBoundsForDisplays(bounds, activeDetachedDisplayBounds())
}

func normalizeDetachedWindowBoundsForDisplays(
	bounds WindowBounds,
	displays []WindowBounds,
) WindowBounds {
	validDisplays := make([]WindowBounds, 0, len(displays))
	for _, display := range displays {
		if display.Width > 0 && display.Height > 0 {
			validDisplays = append(validDisplays, display)
		}
	}
	if len(validDisplays) == 0 || bounds.Width <= 0 || bounds.Height <= 0 {
		return bounds
	}

	dragRegion := bounds
	if dragRegion.Height > detachedWindowDragRegionHeight {
		dragRegion.Height = detachedWindowDragRegionHeight
	}
	minVisibleWidth := minInt(detachedWindowMinVisibleWidth, dragRegion.Width)
	minVisibleHeight := minInt(detachedWindowMinVisibleHeight, dragRegion.Height)
	dragRegionVisible := false
	targetIndex := 0
	maxIntersectionArea := int64(-1)
	for index, display := range validDisplays {
		intersection := intersectWindowBounds(dragRegion, display)
		if intersection.Width >= minVisibleWidth && intersection.Height >= minVisibleHeight {
			dragRegionVisible = true
		}
		windowIntersection := intersectWindowBounds(bounds, display)
		area := int64(windowIntersection.Width) * int64(windowIntersection.Height)
		if area > maxIntersectionArea {
			maxIntersectionArea = area
			targetIndex = index
		}
	}
	target := validDisplays[targetIndex]
	if dragRegionVisible && bounds.Width <= target.Width && bounds.Height <= target.Height {
		return bounds
	}
	if maxIntersectionArea == 0 {
		closestDistance := windowBoundsDistanceSquared(bounds, validDisplays[0])
		for index := 1; index < len(validDisplays); index++ {
			distance := windowBoundsDistanceSquared(bounds, validDisplays[index])
			if distance < closestDistance {
				closestDistance = distance
				targetIndex = index
			}
		}
	}

	target = validDisplays[targetIndex]
	next := bounds
	next.Width = minInt(next.Width, target.Width)
	next.Height = minInt(next.Height, target.Height)
	if maxIntersectionArea == 0 {
		next.X = target.X + (target.Width-next.Width)/2
		next.Y = target.Y + (target.Height-next.Height)/2
		return next
	}
	next.X = clampInt(next.X, target.X, target.X+target.Width-next.Width)
	next.Y = clampInt(next.Y, target.Y, target.Y+target.Height-next.Height)
	return next
}

func intersectWindowBounds(left, right WindowBounds) WindowBounds {
	x1 := maxInt(left.X, right.X)
	y1 := maxInt(left.Y, right.Y)
	x2 := minInt(left.X+left.Width, right.X+right.Width)
	y2 := minInt(left.Y+left.Height, right.Y+right.Height)
	if x2 <= x1 || y2 <= y1 {
		return WindowBounds{}
	}
	return WindowBounds{X: x1, Y: y1, Width: x2 - x1, Height: y2 - y1}
}

func windowBoundsDistanceSquared(window, display WindowBounds) int64 {
	dx := 0
	if window.X+window.Width < display.X {
		dx = display.X - (window.X + window.Width)
	} else if display.X+display.Width < window.X {
		dx = window.X - (display.X + display.Width)
	}
	dy := 0
	if window.Y+window.Height < display.Y {
		dy = display.Y - (window.Y + window.Height)
	} else if display.Y+display.Height < window.Y {
		dy = window.Y - (display.Y + display.Height)
	}
	return int64(dx)*int64(dx) + int64(dy)*int64(dy)
}

func clampInt(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
