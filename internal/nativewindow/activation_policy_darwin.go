//go:build darwin && cgo && !wails3

package nativewindow

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>
#import <dispatch/dispatch.h>
#import <objc/runtime.h>

static IMP detachedOriginalSetActivationPolicy = NULL;
static BOOL detachedAccessoryActivationPolicyGuardActive = NO;

// Wails v2 requests Regular during applicationWillFinishLaunching. Intercept
// the setter so the detached child never enters a Dock-visible policy. The
// child owns this process, so the guard intentionally remains for its lifetime.
static BOOL setDetachedGuardedActivationPolicy(
    NSApplication *application,
    SEL selector,
    NSApplicationActivationPolicy requestedPolicy
) {
    (void)requestedPolicy;
    if (detachedOriginalSetActivationPolicy == NULL) {
        return NO;
    }
    BOOL (*originalImplementation)(id, SEL, NSApplicationActivationPolicy) =
        (BOOL (*)(id, SEL, NSApplicationActivationPolicy))detachedOriginalSetActivationPolicy;
    return originalImplementation(
        application,
        selector,
        NSApplicationActivationPolicyAccessory
    );
}

static void installDetachedAccessoryActivationPolicyGuard(void) {
    @synchronized ([NSApplication class]) {
        if (detachedAccessoryActivationPolicyGuardActive) {
            return;
        }
        Method setter = class_getInstanceMethod(
            [NSApplication class],
            @selector(setActivationPolicy:)
        );
        if (setter == NULL) {
            return;
        }
        detachedOriginalSetActivationPolicy = method_setImplementation(
            setter,
            (IMP)setDetachedGuardedActivationPolicy
        );
        detachedAccessoryActivationPolicyGuardActive =
            detachedOriginalSetActivationPolicy != NULL;
    }
}

static void prepareDetachedAccessoryActivationPolicy(void) {
    installDetachedAccessoryActivationPolicyGuard();
    if ([NSThread isMainThread]) {
        [[NSApplication sharedApplication]
            setActivationPolicy:NSApplicationActivationPolicyAccessory];
    }
}

// Cocoa BOOL maps to different cgo types on Intel and Apple Silicon. Normalise
// the bridge result to int so the Go side remains portable across both targets.
static int isDetachedAccessoryActivationPolicyGuardInstalled(void) {
    @synchronized ([NSApplication class]) {
        return detachedAccessoryActivationPolicyGuardActive ? 1 : 0;
    }
}

static void applyDetachedAccessoryActivationPolicy(void *unused) {
    (void)unused;
    NSApplication *application = [NSApplication sharedApplication];
    [application setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [application activateIgnoringOtherApps:YES];
}

static void setDetachedAccessoryActivationPolicy(void) {
    if ([NSThread isMainThread]) {
        applyDetachedAccessoryActivationPolicy(NULL);
        return;
    }
	dispatch_sync_f(dispatch_get_main_queue(), NULL, applyDetachedAccessoryActivationPolicy);
}
*/
import "C"

func prepareDetachedAccessoryActivationPolicy() {
	C.prepareDetachedAccessoryActivationPolicy()
}

func detachedAccessoryActivationPolicyGuardInstalled() bool {
	return C.isDetachedAccessoryActivationPolicyGuardInstalled() != 0
}

func setDetachedAccessoryActivationPolicy() {
	C.setDetachedAccessoryActivationPolicy()
}
