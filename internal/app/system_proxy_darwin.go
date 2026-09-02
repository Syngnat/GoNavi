//go:build darwin && cgo

package app

/*
#cgo LDFLAGS: -framework CoreFoundation -framework CFNetwork

#include <CoreFoundation/CoreFoundation.h>
#include <CFNetwork/CFNetwork.h>
#include <stdlib.h>

enum {
	GoNaviSystemProxyError = -1,
	GoNaviSystemProxyDirect = 0,
	GoNaviSystemProxyHTTP = 1,
	GoNaviSystemProxySOCKS = 2,
	GoNaviSystemProxyPAC = 3,
	GoNaviSystemProxyUnsupported = 4
};

typedef struct {
	int kind;
	char *host;
	int port;
} GoNaviSystemProxyResult;

static char *copyCFStringUTF8(CFStringRef value) {
	if (value == NULL) {
		return NULL;
	}
	CFIndex length = CFStringGetLength(value);
	CFIndex capacity = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
	char *buffer = (char *)malloc((size_t)capacity);
	if (buffer == NULL) {
		return NULL;
	}
	if (!CFStringGetCString(value, buffer, capacity, kCFStringEncodingUTF8)) {
		free(buffer);
		return NULL;
	}
	return buffer;
}

static GoNaviSystemProxyResult resolveDarwinSystemProxy(const char *rawURL) {
	GoNaviSystemProxyResult result = { GoNaviSystemProxyError, NULL, 0 };
	if (rawURL == NULL) {
		return result;
	}

	CFStringRef urlString = CFStringCreateWithCString(
		kCFAllocatorDefault,
		rawURL,
		kCFStringEncodingUTF8
	);
	if (urlString == NULL) {
		return result;
	}
	CFURLRef targetURL = CFURLCreateWithString(kCFAllocatorDefault, urlString, NULL);
	CFRelease(urlString);
	if (targetURL == NULL) {
		return result;
	}

	CFDictionaryRef settings = CFNetworkCopySystemProxySettings();
	if (settings == NULL) {
		CFRelease(targetURL);
		result.kind = GoNaviSystemProxyDirect;
		return result;
	}
	CFArrayRef proxies = CFNetworkCopyProxiesForURL(targetURL, settings);
	CFRelease(settings);
	CFRelease(targetURL);
	if (proxies == NULL || CFArrayGetCount(proxies) == 0) {
		if (proxies != NULL) {
			CFRelease(proxies);
		}
		return result;
	}

	CFDictionaryRef proxy = (CFDictionaryRef)CFArrayGetValueAtIndex(proxies, 0);
	CFStringRef proxyType = (CFStringRef)CFDictionaryGetValue(proxy, kCFProxyTypeKey);
	if (proxyType == NULL) {
		CFRelease(proxies);
		return result;
	}
	if (CFEqual(proxyType, kCFProxyTypeNone)) {
		result.kind = GoNaviSystemProxyDirect;
		CFRelease(proxies);
		return result;
	}
	if (CFEqual(proxyType, kCFProxyTypeAutoConfigurationURL) ||
		CFEqual(proxyType, kCFProxyTypeAutoConfigurationJavaScript)) {
		result.kind = GoNaviSystemProxyPAC;
		CFRelease(proxies);
		return result;
	}
	if (CFEqual(proxyType, kCFProxyTypeHTTP) || CFEqual(proxyType, kCFProxyTypeHTTPS)) {
		result.kind = GoNaviSystemProxyHTTP;
	} else if (CFEqual(proxyType, kCFProxyTypeSOCKS)) {
		result.kind = GoNaviSystemProxySOCKS;
	} else {
		result.kind = GoNaviSystemProxyUnsupported;
		CFRelease(proxies);
		return result;
	}

	CFStringRef host = (CFStringRef)CFDictionaryGetValue(proxy, kCFProxyHostNameKey);
	CFNumberRef port = (CFNumberRef)CFDictionaryGetValue(proxy, kCFProxyPortNumberKey);
	result.host = copyCFStringUTF8(host);
	if (result.host == NULL || port == NULL || !CFNumberGetValue(port, kCFNumberIntType, &result.port)) {
		if (result.host != NULL) {
			free(result.host);
			result.host = NULL;
		}
		result.kind = GoNaviSystemProxyError;
		result.port = 0;
	}
	CFRelease(proxies);
	return result;
}
*/
import "C"

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"unsafe"
)

type darwinSystemProxyKind int

const (
	darwinSystemProxyError       darwinSystemProxyKind = C.GoNaviSystemProxyError
	darwinSystemProxyDirect      darwinSystemProxyKind = C.GoNaviSystemProxyDirect
	darwinSystemProxyHTTP        darwinSystemProxyKind = C.GoNaviSystemProxyHTTP
	darwinSystemProxySOCKS       darwinSystemProxyKind = C.GoNaviSystemProxySOCKS
	darwinSystemProxyPAC         darwinSystemProxyKind = C.GoNaviSystemProxyPAC
	darwinSystemProxyUnsupported darwinSystemProxyKind = C.GoNaviSystemProxyUnsupported
)

type darwinSystemProxyResult struct {
	kind darwinSystemProxyKind
	host string
	port int
}

func resolvePlatformSystemProxy(target *url.URL) (*url.URL, error) {
	if target == nil {
		return nil, nil
	}
	rawURL := C.CString(target.String())
	defer C.free(unsafe.Pointer(rawURL))

	rawResult := C.resolveDarwinSystemProxy(rawURL)
	if rawResult.host != nil {
		defer C.free(unsafe.Pointer(rawResult.host))
	}
	result := darwinSystemProxyResult{
		kind: darwinSystemProxyKind(rawResult.kind),
		port: int(rawResult.port),
	}
	if rawResult.host != nil {
		result.host = C.GoString(rawResult.host)
	}
	return proxyURLFromDarwinSystemResult(result)
}

func proxyURLFromDarwinSystemResult(result darwinSystemProxyResult) (*url.URL, error) {
	switch result.kind {
	case darwinSystemProxyDirect:
		return nil, nil
	case darwinSystemProxyPAC:
		return nil, fmt.Errorf("macOS automatic proxy configuration (PAC) is not supported; configure an explicit proxy in GoNavi")
	case darwinSystemProxyUnsupported:
		return nil, fmt.Errorf("macOS selected an unsupported system proxy type")
	case darwinSystemProxyError:
		return nil, fmt.Errorf("failed to resolve the macOS system proxy")
	case darwinSystemProxyHTTP, darwinSystemProxySOCKS:
	default:
		return nil, fmt.Errorf("macOS returned an unknown system proxy type: %d", result.kind)
	}

	host := strings.TrimSpace(result.host)
	if host == "" {
		return nil, fmt.Errorf("macOS system proxy host is empty")
	}
	if result.port <= 0 || result.port > 65535 {
		return nil, fmt.Errorf("macOS system proxy port is invalid: %d", result.port)
	}
	scheme := "http"
	if result.kind == darwinSystemProxySOCKS {
		scheme = "socks5"
	}
	return &url.URL{
		Scheme: scheme,
		Host:   net.JoinHostPort(host, strconv.Itoa(result.port)),
	}, nil
}
