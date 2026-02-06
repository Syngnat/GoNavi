//go:build darwin

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

	[effectView setMaterial:NSVisualEffectMaterialHUDWindow];
	[effectView setBlendingMode:NSVisualEffectBlendingModeBehindWindow];
	[effectView setState:NSVisualEffectStateActive];
	[effectView setAlphaValue:0.72];
	[effectView setWantsLayer:YES];
	[[effectView layer] setCornerRadius:cornerRadius];
	[[effectView layer] setMasksToBounds:YES];
}

static void gonaviApplyWindowTranslucencyFix() {
	for (int i = 0; i < 24; i++) {
		dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(i * 250 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
			for (NSWindow *window in [NSApp windows]) {
				gonaviTuneWindowTranslucency(window);
			}
		});
	}
}
*/
import "C"

func applyMacWindowTranslucencyFix() {
	C.gonaviApplyWindowTranslucencyFix()
}
