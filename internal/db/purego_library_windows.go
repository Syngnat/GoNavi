//go:build (gonavi_full_drivers || gonavi_gbase8s_driver || gonavi_yashandb_driver) && windows

package db

import "golang.org/x/sys/windows"

// nativeLibrary 是厂商客户端的 DLL；按 DLL 所在目录解析它依赖的其他客户端 DLL。
type nativeLibrary struct {
	handle windows.Handle
}

func loadNativeLibrary(path string) (nativeLibrary, error) {
	handle, err := windows.LoadLibraryEx(path, 0, windows.LOAD_WITH_ALTERED_SEARCH_PATH)
	if err != nil {
		return nativeLibrary{}, err
	}
	return nativeLibrary{handle: handle}, nil
}

func (l nativeLibrary) symbol(name string) (uintptr, error) {
	return windows.GetProcAddress(l.handle, name)
}
