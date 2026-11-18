//go:build darwin && cgo && !wails3

package nativewindow

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>
#import <dispatch/dispatch.h>
#include <math.h>

typedef struct {
    int x;
    int y;
    int width;
    int height;
} DetachedWindowBounds;

typedef struct {
    DetachedWindowBounds *items;
    int capacity;
    int count;
} DetachedScreenBoundsRequest;

static void copyDetachedScreenBounds(void *rawRequest) {
    DetachedScreenBoundsRequest *request = (DetachedScreenBoundsRequest *)rawRequest;
    NSArray<NSScreen *> *screens = [NSScreen screens];
    if ([screens count] == 0 || request->capacity <= 0 || request->items == NULL) {
        request->count = 0;
        return;
    }

    NSRect primaryFrame = [[screens objectAtIndex:0] frame];
    int count = MIN((int)[screens count], request->capacity);
    for (int index = 0; index < count; index++) {
        NSRect visible = [[screens objectAtIndex:index] visibleFrame];
        request->items[index] = (DetachedWindowBounds) {
            .x = (int)llround(NSMinX(visible)),
            .y = (int)llround(NSMaxY(primaryFrame) - NSMaxY(visible)),
            .width = (int)llround(NSWidth(visible)),
            .height = (int)llround(NSHeight(visible)),
        };
    }
    request->count = count;
}

static int getDetachedScreenBounds(DetachedWindowBounds *items, int capacity) {
    DetachedScreenBoundsRequest request = { items, capacity, 0 };
    if ([NSThread isMainThread]) {
        copyDetachedScreenBounds(&request);
        return request.count;
    }

    // A Go test binary has no AppKit run loop to drain the main dispatch queue.
    // Returning no displays preserves the requested bounds and avoids blocking
    // forever; Wails calls this only after NSApplication is running.
    if (NSApp == nil || ![NSApp isRunning]) {
        return 0;
    }
    dispatch_sync_f(dispatch_get_main_queue(), &request, copyDetachedScreenBounds);
    return request.count;
}

static NSWindow *resolveDetachedWindow(void) {
    NSApplication *application = [NSApplication sharedApplication];
    NSWindow *window = [application mainWindow];
    if (window == nil) {
        window = [application keyWindow];
    }
    if (window == nil && [[application windows] count] > 0) {
        window = [[application windows] objectAtIndex:0];
    }
    return window;
}

static void applyDetachedWindowBounds(void *rawBounds) {
    DetachedWindowBounds *bounds = (DetachedWindowBounds *)rawBounds;
    NSWindow *window = resolveDetachedWindow();
    NSArray<NSScreen *> *screens = [NSScreen screens];
    if (window == nil || [screens count] == 0) {
        return;
    }

    // Browser screenX/screenY use the primary display's top-left as the global
    // origin. Cocoa uses the primary display's bottom-left, so only Y needs to
    // be flipped around the primary screen's top edge.
    NSRect primaryFrame = [[screens objectAtIndex:0] frame];
    NSRect frame = [window frame];
    frame.origin.x = (CGFloat)bounds->x;
    frame.origin.y = NSMaxY(primaryFrame) - (CGFloat)bounds->y - (CGFloat)bounds->height;
    frame.size.width = (CGFloat)bounds->width;
    frame.size.height = (CGFloat)bounds->height;
    [window setFrame:frame display:NO animate:NO];
}

static void setDetachedWindowBounds(int x, int y, int width, int height) {
    DetachedWindowBounds bounds = { x, y, width, height };
    if ([NSThread isMainThread]) {
        applyDetachedWindowBounds(&bounds);
        return;
    }
    dispatch_sync_f(dispatch_get_main_queue(), &bounds, applyDetachedWindowBounds);
}
*/
import "C"

import "context"

func applyDetachedWindowBounds(_ context.Context, x, y, width, height int) {
	bounds := normalizeDetachedWindowBounds(WindowBounds{
		X: x, Y: y, Width: width, Height: height,
	})
	C.setDetachedWindowBounds(
		C.int(bounds.X),
		C.int(bounds.Y),
		C.int(bounds.Width),
		C.int(bounds.Height),
	)
}

func activeDetachedDisplayBounds() []WindowBounds {
	const maximumDisplays = 32
	rawBounds := make([]C.DetachedWindowBounds, maximumDisplays)
	count := int(C.getDetachedScreenBounds(&rawBounds[0], C.int(len(rawBounds))))
	if count <= 0 {
		return nil
	}
	result := make([]WindowBounds, 0, count)
	for index := 0; index < count; index++ {
		raw := rawBounds[index]
		result = append(result, WindowBounds{
			X:      int(raw.x),
			Y:      int(raw.y),
			Width:  int(raw.width),
			Height: int(raw.height),
		})
	}
	return result
}
