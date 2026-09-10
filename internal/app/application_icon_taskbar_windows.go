//go:build windows

package app

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	windowsRPCChangedMode                 = uintptr(0x80010106)
	windowsVariantTypeUnicodeString       = uint16(31)
	windowsApplicationUserModelID         = "Syngnat.GoNavi"
	windowsApplicationDisplayName         = "GoNavi"
	windowsRelaunchCommandPropertyID      = uint32(2)
	windowsRelaunchIconPropertyID         = uint32(3)
	windowsRelaunchDisplayNamePropertyID  = uint32(4)
	windowsApplicationUserModelPropertyID = uint32(5)
)

var (
	windowsAppUserModelFormatID = windows.GUID{
		Data1: 0x9f4c2855,
		Data2: 0x9f79,
		Data3: 0x4b39,
		Data4: [8]byte{0xa8, 0xd0, 0xe1, 0xd4, 0x2d, 0xe1, 0xd5, 0xf3},
	}
	windowsPropertyStoreInterfaceID = windows.GUID{
		Data1: 0x886d8eeb,
		Data2: 0x8cf2,
		Data3: 0x4446,
		Data4: [8]byte{0x8d, 0x02, 0xcd, 0xba, 0x1d, 0xbd, 0xcf, 0x99},
	}
	windowsAppUserModelRelaunchCommandKey = windowsPropertyKey{
		formatID:   windowsAppUserModelFormatID,
		propertyID: windowsRelaunchCommandPropertyID,
	}
	windowsAppUserModelRelaunchIconKey = windowsPropertyKey{
		formatID:   windowsAppUserModelFormatID,
		propertyID: windowsRelaunchIconPropertyID,
	}
	windowsAppUserModelRelaunchDisplayNameKey = windowsPropertyKey{
		formatID:   windowsAppUserModelFormatID,
		propertyID: windowsRelaunchDisplayNamePropertyID,
	}
	windowsAppUserModelIDKey = windowsPropertyKey{
		formatID:   windowsAppUserModelFormatID,
		propertyID: windowsApplicationUserModelPropertyID,
	}

	windowsTaskbarShell32                     = windows.NewLazySystemDLL("shell32.dll")
	windowsTaskbarSHGetPropertyStoreForWindow = windowsTaskbarShell32.NewProc("SHGetPropertyStoreForWindow")
	windowsOpenWindowPropertyStore            = openWindowsWindowPropertyStore
	windowsApplicationExecutable              = os.Executable
)

type windowsPropertyKey struct {
	formatID   windows.GUID
	propertyID uint32
}

type windowsPropVariant struct {
	valueType uint16
	reserved1 uint16
	reserved2 uint16
	reserved3 uint16
	value     [2]uintptr
}

type windowsWindowProperty struct {
	key   windowsPropertyKey
	value string
}

type windowsWindowPropertyStore interface {
	setString(key windowsPropertyKey, value string) error
	commit() error
	release()
}

type nativeWindowsWindowPropertyStore struct {
	vtable *nativeWindowsWindowPropertyStoreVTable
}

type nativeWindowsWindowPropertyStoreVTable struct {
	queryInterface uintptr
	addRef         uintptr
	release        uintptr
	getCount       uintptr
	getAt          uintptr
	getValue       uintptr
	setValue       uintptr
	commit         uintptr
}

// setWindowsTaskbarProperties updates the Shell-owned identity and icon for the
// live taskbar group. AppUserModel.ID must be written last because that write is
// the documented notification that makes Explorer re-read the relaunch values.
func setWindowsTaskbarProperties(hwnd uintptr, iconPath string) error {
	if hwnd == 0 {
		return errors.New("set Windows taskbar properties: window handle is zero")
	}
	iconPath = strings.TrimSpace(iconPath)
	if iconPath == "" {
		return errors.New("set Windows taskbar properties: icon path is empty")
	}
	executablePath, err := windowsApplicationExecutable()
	if err != nil {
		return fmt.Errorf("resolve Windows relaunch executable: %w", err)
	}
	relaunchCommand := `"` + executablePath + `"`

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	shouldUninitialize, err := initializeWindowsCOMForTaskbar()
	if err != nil {
		return err
	}
	if shouldUninitialize {
		defer windows.CoUninitialize()
	}

	store, err := windowsOpenWindowPropertyStore(hwnd)
	if err != nil {
		return err
	}
	defer store.release()

	properties := []windowsWindowProperty{
		{key: windowsAppUserModelRelaunchCommandKey, value: relaunchCommand},
		{key: windowsAppUserModelRelaunchDisplayNameKey, value: windowsApplicationDisplayName},
		{key: windowsAppUserModelRelaunchIconKey, value: iconPath + ",0"},
		{key: windowsAppUserModelIDKey, value: windowsApplicationUserModelID},
	}
	for _, property := range properties {
		if err := store.setString(property.key, property.value); err != nil {
			return fmt.Errorf("set Windows taskbar property %d: %w", property.key.propertyID, err)
		}
	}
	if err := store.commit(); err != nil {
		return fmt.Errorf("commit Windows taskbar properties: %w", err)
	}
	return nil
}

func initializeWindowsCOMForTaskbar() (bool, error) {
	err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED|windows.COINIT_DISABLE_OLE1DDE)
	if err == nil {
		return true, nil
	}
	if code, ok := err.(syscall.Errno); ok && uintptr(code) == 1 {
		// S_FALSE still requires a matching CoUninitialize call.
		return true, nil
	}
	if isWindowsHRESULT(err, windowsRPCChangedMode) {
		// The current Wails thread already uses a different COM apartment.
		return false, nil
	}
	return false, fmt.Errorf("initialise COM for Windows taskbar properties: %w", err)
}

func openWindowsWindowPropertyStore(hwnd uintptr) (windowsWindowPropertyStore, error) {
	var store *nativeWindowsWindowPropertyStore
	result, _, _ := windowsTaskbarSHGetPropertyStoreForWindow.Call(
		hwnd,
		uintptr(unsafe.Pointer(&windowsPropertyStoreInterfaceID)),
		uintptr(unsafe.Pointer(&store)),
	)
	if windowsHRESULTFailed(result) || store == nil || store.vtable == nil {
		return nil, fmt.Errorf("open Windows taskbar property store: HRESULT %#x", uint32(result))
	}
	return store, nil
}

func (store *nativeWindowsWindowPropertyStore) setString(key windowsPropertyKey, value string) error {
	encoded, err := windows.UTF16FromString(value)
	if err != nil {
		return fmt.Errorf("encode Windows taskbar property: %w", err)
	}
	variant := windowsPropVariant{
		valueType: windowsVariantTypeUnicodeString,
		value:     [2]uintptr{uintptr(unsafe.Pointer(&encoded[0])), 0},
	}
	result, _, _ := syscall.SyscallN(
		store.vtable.setValue,
		uintptr(unsafe.Pointer(store)),
		uintptr(unsafe.Pointer(&key)),
		uintptr(unsafe.Pointer(&variant)),
	)
	runtime.KeepAlive(encoded)
	if windowsHRESULTFailed(result) {
		return fmt.Errorf("IPropertyStore.SetValue HRESULT %#x", uint32(result))
	}
	return nil
}

func (store *nativeWindowsWindowPropertyStore) commit() error {
	result, _, _ := syscall.SyscallN(store.vtable.commit, uintptr(unsafe.Pointer(store)))
	if windowsHRESULTFailed(result) {
		return fmt.Errorf("IPropertyStore.Commit HRESULT %#x", uint32(result))
	}
	return nil
}

func (store *nativeWindowsWindowPropertyStore) release() {
	if store != nil && store.vtable != nil {
		syscall.SyscallN(store.vtable.release, uintptr(unsafe.Pointer(store)))
	}
}

func windowsHRESULTFailed(result uintptr) bool {
	return int32(uint32(result)) < 0
}

func isWindowsHRESULT(err error, want uintptr) bool {
	code, ok := err.(syscall.Errno)
	return ok && uint32(code) == uint32(want)
}
