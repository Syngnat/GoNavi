//go:build darwin && cgo

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static IMP pluginOriginalConfigurationInit = NULL;

// Wails v2 exposes no data-store option. This child-only guard is installed
// before Wails constructs its first WebView; the host never calls it.
static id pluginConfigurationInit(id instance, SEL selector) {
    id (*original)(id, SEL) = (id (*)(id, SEL))pluginOriginalConfigurationInit;
    WKWebViewConfiguration *configuration = original(instance, selector);
    if (configuration != nil) {
        configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
        configuration.processPool = [[WKProcessPool alloc] init];
    }
    return configuration;
}

int installPluginConfigurationGuard(void) {
    @synchronized ([WKWebViewConfiguration class]) {
        if (pluginOriginalConfigurationInit != NULL) return 1;
        Class cls = [WKWebViewConfiguration class];
        SEL selector = @selector(init);
        Method method = class_getInstanceMethod(cls, selector);
        if (method == NULL) return 0;
        IMP original = method_getImplementation(method);
        // Copy inherited methods onto the class; never replace NSObject.init.
        class_addMethod(cls, selector, original, method_getTypeEncoding(method));
        Method localMethod = class_getInstanceMethod(cls, selector);
        pluginOriginalConfigurationInit = original;
        method_setImplementation(localMethod, (IMP)pluginConfigurationInit);
        return 1;
    }
}
