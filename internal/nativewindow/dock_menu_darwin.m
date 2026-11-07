//go:build darwin && cgo && !wails3

#import <Cocoa/Cocoa.h>
#import <dispatch/dispatch.h>
#import <objc/runtime.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

extern void gonaviFocusDetachedDockMenuWindow(char *windowID);

@interface GoNaviDockMenuTarget : NSObject {
	BOOL focusesMainWindow;
	NSString *detachedWindowID;
}
- (instancetype)initForMainWindow;
- (instancetype)initWithDetachedWindowID:(NSString *)windowID;
- (void)focusWindow:(id)sender;
@end

static NSMutableArray *gonaviDockMenuActionTargets = nil;
static NSArray *gonaviDockMenuSnapshot = nil;
static uint64_t gonaviDockMenuSnapshotRevision = 0;

typedef struct {
	char *json;
	uint64_t revision;
} GoNaviDockMenuSnapshotUpdate;

static NSWindow *gonaviMainWindow(void) {
	id delegate = [NSApp delegate];
	SEL mainWindowSelector = NSSelectorFromString(@"mainWindow");
	if (delegate != nil && [delegate respondsToSelector:mainWindowSelector]) {
		id candidate = [delegate performSelector:mainWindowSelector];
		if ([candidate isKindOfClass:[NSWindow class]]) {
			return (NSWindow *)candidate;
		}
	}
	NSWindow *window = [NSApp mainWindow];
	if (window != nil) {
		return window;
	}
	for (NSWindow *candidate in [NSApp windows]) {
		if ([NSStringFromClass([candidate class]) isEqualToString:@"WailsWindow"]) {
			return candidate;
		}
	}
	return nil;
}

@implementation GoNaviDockMenuTarget

- (instancetype)initForMainWindow {
	self = [super init];
	if (self != nil) {
		focusesMainWindow = YES;
	}
	return self;
}

- (instancetype)initWithDetachedWindowID:(NSString *)windowID {
	self = [super init];
	if (self != nil) {
		detachedWindowID = [windowID copy];
	}
	return self;
}

- (void)focusWindow:(id)sender {
	(void)sender;
	if (focusesMainWindow) {
		NSWindow *window = gonaviMainWindow();
		if (window == nil) {
			return;
		}
		[NSApp unhide:nil];
		if ([window isMiniaturized]) {
			[window deminiaturize:nil];
		}
		[window makeKeyAndOrderFront:nil];
		[NSApp activateIgnoringOtherApps:YES];
		return;
	}
	const char *windowID = [detachedWindowID UTF8String];
	if (windowID != NULL) {
		gonaviFocusDetachedDockMenuWindow((char *)windowID);
	}
}

- (void)dealloc {
	[detachedWindowID release];
	[super dealloc];
}

@end

static void gonaviMarkDockMenuItemForPID(NSMenuItem *item, pid_t itemPID, pid_t frontmostPID) {
	if (item != nil && itemPID > 0 && itemPID == frontmostPID) {
		[item setState:NSControlStateValueOn];
	}
}

static NSMenu *gonaviApplicationDockMenu(id self, SEL command, NSApplication *sender) {
	(void)self;
	(void)command;
	(void)sender;
	[gonaviDockMenuActionTargets release];
	gonaviDockMenuActionTargets = [[NSMutableArray alloc] init];

	NSMenu *menu = [[[NSMenu alloc] initWithTitle:@"GoNavi"] autorelease];
	pid_t frontmostPID = [[[NSWorkspace sharedWorkspace] frontmostApplication] processIdentifier];
	NSWindow *mainWindow = gonaviMainWindow();
	NSString *mainTitle = [[mainWindow title]
		stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	if ([mainTitle length] == 0) {
		mainTitle = @"GoNavi";
	}
	GoNaviDockMenuTarget *mainTarget = [[[GoNaviDockMenuTarget alloc] initForMainWindow] autorelease];
	[gonaviDockMenuActionTargets addObject:mainTarget];
	NSMenuItem *mainItem = [[[NSMenuItem alloc]
		initWithTitle:mainTitle
		action:@selector(focusWindow:)
		keyEquivalent:@""] autorelease];
	[mainItem setTarget:mainTarget];
	gonaviMarkDockMenuItemForPID(
		mainItem,
		[[NSProcessInfo processInfo] processIdentifier],
		frontmostPID
	);
	[menu addItem:mainItem];

	for (id record in gonaviDockMenuSnapshot ?: @[]) {
		if (![record isKindOfClass:[NSDictionary class]]) {
			continue;
		}
		id rawID = [(NSDictionary *)record objectForKey:@"id"];
		id rawTitle = [(NSDictionary *)record objectForKey:@"title"];
		if (![rawID isKindOfClass:[NSString class]] || ![rawTitle isKindOfClass:[NSString class]] ||
			[(NSString *)rawID length] == 0 || [(NSString *)rawTitle length] == 0) {
			continue;
		}
		GoNaviDockMenuTarget *target = [[[GoNaviDockMenuTarget alloc]
			initWithDetachedWindowID:(NSString *)rawID] autorelease];
		[gonaviDockMenuActionTargets addObject:target];
		NSMenuItem *item = [[[NSMenuItem alloc]
			initWithTitle:(NSString *)rawTitle
			action:@selector(focusWindow:)
			keyEquivalent:@""] autorelease];
		[item setTarget:target];
		id rawPID = [(NSDictionary *)record objectForKey:@"pid"];
		if ([rawPID isKindOfClass:[NSNumber class]]) {
			gonaviMarkDockMenuItemForPID(item, [(NSNumber *)rawPID intValue], frontmostPID);
		}
		[menu addItem:item];
	}
	return menu;
}

static void gonaviApplyDetachedDockMenuSnapshot(void *rawUpdate) {
	GoNaviDockMenuSnapshotUpdate *update = (GoNaviDockMenuSnapshotUpdate *)rawUpdate;
	if (update == NULL) {
		return;
	}
	@autoreleasepool {
		if (update->revision > gonaviDockMenuSnapshotRevision && update->json != NULL) {
			NSString *json = [NSString stringWithUTF8String:update->json];
			NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
			id decoded = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
			if ([decoded isKindOfClass:[NSArray class]]) {
				NSArray *snapshot = [(NSArray *)decoded copy];
				[gonaviDockMenuSnapshot release];
				gonaviDockMenuSnapshot = snapshot;
				gonaviDockMenuSnapshotRevision = update->revision;
			}
		}
	}
	free(update->json);
	free(update);
}

void gonaviPublishDetachedDockMenuSnapshot(const char *snapshotJSON, unsigned long long revision) {
	if (snapshotJSON == NULL) {
		return;
	}
	GoNaviDockMenuSnapshotUpdate *update = calloc(1, sizeof(GoNaviDockMenuSnapshotUpdate));
	if (update == NULL) {
		return;
	}
	update->json = strdup(snapshotJSON);
	update->revision = (uint64_t)revision;
	if (update->json == NULL) {
		free(update);
		return;
	}
	if ([NSThread isMainThread]) {
		gonaviApplyDetachedDockMenuSnapshot(update);
		return;
	}
	dispatch_async_f(dispatch_get_main_queue(), update, gonaviApplyDetachedDockMenuSnapshot);
}

void gonaviInstallDetachedDockMenu(void) {
	Class delegateClass = objc_getClass("AppDelegate");
	if (delegateClass == Nil) {
		return;
	}
	SEL selector = @selector(applicationDockMenu:);
	if (class_getInstanceMethod(delegateClass, selector) != NULL) {
		return;
	}
	if (!class_addMethod(
		delegateClass,
		selector,
		(IMP)gonaviApplicationDockMenu,
		"@@:@"
	)) {
		return;
	}
}
