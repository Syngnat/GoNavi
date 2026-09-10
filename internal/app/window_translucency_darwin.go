//go:build darwin && cgo

package app

/*
#cgo CFLAGS: -x objective-c -fblocks
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#import <dispatch/dispatch.h>

static void gonaviTuneWindowTranslucency(NSWindow *window) {
	if (window == nil) {
		return;
	}
	CGFloat cornerRadius = 14.0;

	[window setOpaque:NO];
	[window setBackgroundColor:[NSColor clearColor]];
	[window setHasShadow:YES];
	[window setMovableByWindowBackground:YES];

	NSView *contentView = [window contentView];
	if (contentView == nil) {
		return;
	}

	[contentView setWantsLayer:YES];
	[[contentView layer] setBackgroundColor:[[NSColor clearColor] CGColor]];
	[[contentView layer] setCornerRadius:cornerRadius];
	[[contentView layer] setMasksToBounds:YES];

	NSVisualEffectView *effectView = nil;
	for (NSView *subview in [contentView subviews]) {
		if ([subview isKindOfClass:[NSVisualEffectView class]]) {
			effectView = (NSVisualEffectView *)subview;
			break;
		}
	}

	if (effectView == nil) {
		effectView = [[NSVisualEffectView alloc] initWithFrame:[contentView bounds]];
		[effectView setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
		[contentView addSubview:effectView positioned:NSWindowBelow relativeTo:nil];
		[effectView release];
	}

	if (@available(macOS 10.14, *)) {
		[effectView setMaterial:NSVisualEffectMaterialHUDWindow];
	}
	[effectView setBlendingMode:NSVisualEffectBlendingModeBehindWindow];
	[effectView setState:NSVisualEffectStateActive];
	// 默认 alpha=0（不可见），由前端根据用户外观设置动态启用
	[effectView setAlphaValue:0.0];
	[effectView setWantsLayer:YES];
	[[effectView layer] setCornerRadius:cornerRadius];
	[[effectView layer] setMasksToBounds:YES];
}

static void gonaviApplyWindowTranslucencyFix() {
	// 启动时应用窗口透明度修复，减少重试次数以降低启动期 GPU 负载
	for (int i = 0; i < 8; i++) {
		dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(i * 250 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
			for (NSWindow *window in [NSApp windows]) {
				gonaviTuneWindowTranslucency(window);
			}
		});
	}
}

// 分别设置 NSVisualEffectView 的透明度和窗口不透明标志。
// 无模糊的半透明窗口需要 effect alpha=0 且 windowOpaque=false，二者不能绑定。
static void gonaviSetWindowTranslucency(double effectAlpha, int windowOpaque, int darkAppearance) {
	dispatch_async(dispatch_get_main_queue(), ^{
		for (NSWindow *window in [NSApp windows]) {
			NSView *contentView = [window contentView];
			if (contentView == nil) {
				continue;
			}

			NSAppearance *appearance = nil;
			if (@available(macOS 10.14, *)) {
				appearance = [NSAppearance appearanceNamed:(darkAppearance != 0
					? NSAppearanceNameDarkAqua
					: NSAppearanceNameAqua)];
				[window setAppearance:appearance];
			}

			for (NSView *subview in [contentView subviews]) {
				if ([subview isKindOfClass:[NSVisualEffectView class]]) {
					NSVisualEffectView *effectView = (NSVisualEffectView *)subview;
					if (appearance != nil) {
						[effectView setAppearance:appearance];
					}
					[effectView setAlphaValue:effectAlpha];
					break;
				}
			}

			if (windowOpaque != 0) {
				[window setOpaque:YES];
			} else {
				[window setOpaque:NO];
				[window setBackgroundColor:[NSColor clearColor]];
			}
		}
	});
}
*/
import "C"

func applyMacWindowTranslucencyFix() {
	C.gonaviApplyWindowTranslucencyFix()
}

// setMacWindowTranslucency 根据用户外观设置动态调整 macOS 窗口透明度。
// opacity=1.0 且 blur=0 时关闭 NSVisualEffectView（alpha=0），窗口标记为 opaque，
// GPU 不再持续计算窗口背后的模糊合成，显著降低 CPU/GPU 温度。
func setMacWindowTranslucency(opacity float64, blur float64, darkAppearance bool) {
	policy := resolveMacWindowTranslucencyPolicy(opacity, blur, darkAppearance)
	windowOpaque := C.int(0)
	if policy.windowOpaque {
		windowOpaque = C.int(1)
	}
	darkAppearanceValue := C.int(0)
	if policy.darkAppearance {
		darkAppearanceValue = C.int(1)
	}
	C.gonaviSetWindowTranslucency(C.double(policy.effectAlpha), windowOpaque, darkAppearanceValue)
}
