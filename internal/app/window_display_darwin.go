//go:build darwin && cgo && !wails3

package app

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#include <Cocoa/Cocoa.h>
#import <dispatch/dispatch.h>
#include <math.h>

typedef struct {
    int x;
    int y;
    int width;
    int height;
    int primary;
    int current;
} GoNaviDisplayArea;

typedef struct {
    GoNaviDisplayArea *items;
    int capacity;
    int count;
} GoNaviDisplayAreaRequest;

// 主窗口必须是 Wails 自己创建的窗口：Wails 的 SetPosition/GetPosition 以该窗口
// 所在显示器的 visibleFrame 为原点。若这里认错窗口，坐标基准就和 Wails 不一致。
static NSWindow *gonaviResolveMainWindow(void) {
    NSWindow *window = [NSApp mainWindow];
    if (window != nil) {
        return window;
    }
    Class wailsWindowClass = NSClassFromString(@"WailsWindow");
    for (NSWindow *candidate in [NSApp windows]) {
        if (wailsWindowClass != Nil && [candidate isKindOfClass:wailsWindowClass]) {
            return candidate;
        }
    }
    return [NSApp keyWindow];
}

static int gonaviScreenNumber(NSScreen *screen) {
    if (screen == nil) {
        return -1;
    }
    NSNumber *number = [[screen deviceDescription] objectForKey:@"NSScreenNumber"];
    return number != nil ? [number intValue] : -1;
}

static void gonaviCopyDisplayAreas(void *rawRequest) {
    GoNaviDisplayAreaRequest *request = (GoNaviDisplayAreaRequest *)rawRequest;
    NSArray<NSScreen *> *screens = [NSScreen screens];
    if ([screens count] == 0 || request->items == NULL || request->capacity <= 0) {
        request->count = 0;
        return;
    }

    // 浏览器全局坐标以主显示器左上角为原点，Cocoa 以主显示器左下角为原点，
    // 因此只用主显示器顶边翻转 Y，X 不需要翻转。
    NSRect primaryFrame = [[screens objectAtIndex:0] frame];
    int currentNumber = gonaviScreenNumber([gonaviResolveMainWindow() screen]);
    int count = MIN((int)[screens count], request->capacity);
    for (int index = 0; index < count; index++) {
        NSScreen *screen = [screens objectAtIndex:index];
        NSRect visible = [screen visibleFrame];
        request->items[index] = (GoNaviDisplayArea) {
            .x = (int)llround(NSMinX(visible)),
            .y = (int)llround(NSMaxY(primaryFrame) - NSMaxY(visible)),
            .width = (int)llround(NSWidth(visible)),
            .height = (int)llround(NSHeight(visible)),
            .primary = index == 0 ? 1 : 0,
            .current = gonaviScreenNumber(screen) == currentNumber ? 1 : 0,
        };
    }
    request->count = count;
}

static int gonaviGetDisplayAreas(GoNaviDisplayArea *items, int capacity) {
    GoNaviDisplayAreaRequest request = { items, capacity, 0 };
    if (items == NULL || capacity <= 0) {
        return 0;
    }
    // Go 测试二进制没有 AppKit 事件循环来消费主队列，此时直接返回空列表，
    // 避免 dispatch_sync 永久阻塞；Wails 只会在 NSApplication 起来后调用。
    if (![NSThread isMainThread] && (NSApp == nil || ![NSApp isRunning])) {
        return 0;
    }
    if ([NSThread isMainThread]) {
        gonaviCopyDisplayAreas(&request);
    } else {
        dispatch_sync_f(dispatch_get_main_queue(), &request, gonaviCopyDisplayAreas);
    }
    return request.count;
}
*/
import "C"

import "context"

// macOS 的 WindowGetPosition 返回的是相对当前显示器可见区的局部坐标，
// 必须由前端按 Current 工作区原点换算成全局坐标。
const mainWindowPositionIsGlobal = false
const mainWindowSetPositionIsLocal = true

func mainWindowDisplayAreas(_ context.Context) []mainWindowDisplayArea {
	const maximumDisplays = 32
	rawAreas := make([]C.GoNaviDisplayArea, maximumDisplays)
	count := int(C.gonaviGetDisplayAreas(&rawAreas[0], C.int(len(rawAreas))))
	if count <= 0 {
		return nil
	}
	areas := make([]mainWindowDisplayArea, 0, count)
	for index := 0; index < count; index++ {
		raw := rawAreas[index]
		areas = append(areas, mainWindowDisplayArea{
			X:       int(raw.x),
			Y:       int(raw.y),
			Width:   int(raw.width),
			Height:  int(raw.height),
			Primary: raw.primary == 1,
			Current: raw.current == 1,
		})
	}
	return areas
}
