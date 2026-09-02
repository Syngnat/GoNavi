//go:build windows

package app

import (
	"errors"
	"fmt"
	"net/url"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type winHTTPCurrentUserIEProxyConfig struct {
	AutoDetect    int32
	AutoConfigURL *uint16
	Proxy         *uint16
	ProxyBypass   *uint16
}

var (
	winHTTPDLL                            = windows.NewLazySystemDLL("winhttp.dll")
	winHTTPGetIEProxyConfigForCurrentUser = winHTTPDLL.NewProc("WinHttpGetIEProxyConfigForCurrentUser")
	kernel32SystemProxyDLL                = windows.NewLazySystemDLL("kernel32.dll")
	globalFreeSystemProxy                 = kernel32SystemProxyDLL.NewProc("GlobalFree")
)

func resolvePlatformSystemProxy(target *url.URL) (*url.URL, error) {
	settings, err := readWindowsCurrentUserProxySettings()
	if err != nil {
		return nil, err
	}
	return resolveWindowsSystemProxySettings(target, settings)
}

func readWindowsCurrentUserProxySettings() (windowsSystemProxySettings, error) {
	var native winHTTPCurrentUserIEProxyConfig
	result, _, callErr := winHTTPGetIEProxyConfigForCurrentUser.Call(uintptr(unsafe.Pointer(&native)))
	if result == 0 {
		if callErr == nil || errors.Is(callErr, syscall.Errno(0)) {
			callErr = errors.New("unknown WinHTTP error")
		}
		return windowsSystemProxySettings{}, fmt.Errorf("failed to read the current Windows system proxy: %w", callErr)
	}
	defer freeWindowsSystemProxyString(native.AutoConfigURL)
	defer freeWindowsSystemProxyString(native.Proxy)
	defer freeWindowsSystemProxyString(native.ProxyBypass)

	return windowsSystemProxySettings{
		AutoDetect:    native.AutoDetect != 0,
		AutoConfigURL: windows.UTF16PtrToString(native.AutoConfigURL),
		Proxy:         windows.UTF16PtrToString(native.Proxy),
		ProxyBypass:   windows.UTF16PtrToString(native.ProxyBypass),
	}, nil
}

func freeWindowsSystemProxyString(value *uint16) {
	if value != nil {
		_, _, _ = globalFreeSystemProxy.Call(uintptr(unsafe.Pointer(value)))
	}
}
