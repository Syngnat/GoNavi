//go:build (gonavi_full_drivers || gonavi_gbase8s_driver || gonavi_yashandb_driver) && !windows

package db

import "github.com/ebitengine/purego"

// nativeLibrary 是用 dlopen 打开的厂商客户端动态库（GBase 8s 的 CSDK、崖山的 yacli），CGO_ENABLED=0 也能用。
type nativeLibrary struct {
	handle uintptr
}

func loadNativeLibrary(path string) (nativeLibrary, error) {
	handle, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nativeLibrary{}, err
	}
	return nativeLibrary{handle: handle}, nil
}

func (l nativeLibrary) symbol(name string) (uintptr, error) {
	return purego.Dlsym(l.handle, name)
}
