//go:build gonavi_full_drivers || gonavi_yashandb_driver

package db

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// 崖山没有纯 Go 的协议实现（官方 Go 驱动是 CGO 包装），这里用 purego 直接调用用户安装的崖山客户端库
// （libyascli / yascli.dll，与官方驱动加载的是同一套 yacli C 接口），驱动进程不需要 CGO。

const (
	yacHandleEnv  = 1
	yacHandleDbc  = 2
	yacHandleStmt = 3

	yacSuccess         = 0
	yacSuccessWithInfo = 1

	yacNullData = -1

	yacAttrAutocommit      = 3
	yacAttrMaxCharsetRatio = 12
	yacAttrSSLRootCert     = 24
	yacAttrCharsetCode     = 62
	yacAttrClientDriver    = 66
	yacAttrRowsAffected    = 103
	yacCharsetUTF8         = 2
	yacParamInput          = 1

	yacTypeBool         = 1
	yacTypeTinyint      = 2
	yacTypeSmallint     = 3
	yacTypeInteger      = 4
	yacTypeBigint       = 5
	yacTypeUTinyint     = 6
	yacTypeUSmallint    = 7
	yacTypeUInteger     = 8
	yacTypeUBigint      = 9
	yacTypeFloat        = 10
	yacTypeDouble       = 11
	yacTypeNumber       = 12
	yacTypeDate         = 13
	yacTypeShortDate    = 14
	yacTypeShortTime    = 15
	yacTypeTimestamp    = 16
	yacTypeTimestampLTZ = 17
	yacTypeTimestampTZ  = 18
	yacTypeYMInterval   = 19
	yacTypeDSInterval   = 20
	yacTypeChar         = 24
	yacTypeNChar        = 25
	yacTypeVarchar      = 26
	yacTypeNVarchar     = 27
	yacTypeBinary       = 28
	yacTypeClob         = 29
	yacTypeBlob         = 30
	yacTypeBit          = 31
	yacTypeRowID        = 32
	yacTypeNClob        = 33
	yacTypeCursor       = 34
	yacTypeJSON         = 35
	yacTypeXML          = 39
	yacTypeNumberFloat  = 40
	yacTypeVector       = 42

	yashanClientDriverName = "GoNavi"
)

// yacliAPI 是已加载的 yacli 客户端库的函数表。ping 只在 23.4.4 起的客户端里有（老客户端为 0，改用查询探活）。
type yacliAPI struct {
	allocHandle, freeHandle, setEnvAttr, connect, disconnect, cancel, ping                  uintptr
	directExecute, prepare, execute, fetch, commit, rollback, numResultCols, describeCol2   uintptr
	bindColumn, bindParameter, setConnAttr, getConnAttr, getStmtAttr, getLastError          uintptr
	lobDescAlloc, lobDescFree, lobGetLength, lobRead, lobCreateTemporary, lobWrite, lobFree uintptr
}

var (
	yacliAPIMu    sync.Mutex
	yacliAPICache = map[string]*yacliAPI{}
)

// yashanClientLibraryCandidates 是客户端目录下 yacli 库的相对路径（Windows 客户端包里也可能放在 bin 下）。
func yashanClientLibraryCandidates() []string {
	switch runtime.GOOS {
	case "windows":
		return []string{filepath.Join("lib", "yascli.dll"), filepath.Join("bin", "yascli.dll"), "yascli.dll"}
	case "darwin":
		return []string{filepath.Join("lib", "libyascli.dylib"), "libyascli.dylib"}
	default:
		return []string{filepath.Join("lib", "libyascli.so"), filepath.Join("lib", "libyascli.so.0"), "libyascli.so"}
	}
}

// yashanClientHomes 是查找客户端的目录：连接参数里的客户端目录优先，其次 YASDB_HOME，最后是官方驱动默认的
// ~/.yashandb/client。
func yashanClientHomes(clientDir string) []string {
	if clientDir = strings.TrimSpace(clientDir); clientDir != "" {
		return []string{clientDir}
	}
	var homes []string
	if home := strings.TrimSpace(os.Getenv("YASDB_HOME")); home != "" {
		homes = append(homes, home)
	}
	if userHome, err := os.UserHomeDir(); err == nil {
		homes = append(homes, filepath.Join(userHome, ".yashandb", "client"))
	}
	return homes
}

// resolveYashanClientLibrary 在客户端目录里找 yacli 库；library 非空时直接使用（相对路径按客户端目录解析）。
func resolveYashanClientLibrary(clientDir, library string) (string, error) {
	homes := yashanClientHomes(clientDir)
	if library = strings.TrimSpace(library); library != "" {
		if !filepath.IsAbs(library) && len(homes) > 0 {
			library = filepath.Join(homes[0], library)
		}
		return library, nil
	}
	for _, home := range homes {
		for _, candidate := range yashanClientLibraryCandidates() {
			path := filepath.Join(home, candidate)
			if _, err := os.Stat(path); err == nil {
				return path, nil
			}
		}
	}
	if strings.TrimSpace(clientDir) == "" {
		return "", localizedDatabaseRuntimeError("db.backend.error.yashandb_client_missing", nil)
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.yashandb_client_library_missing", map[string]any{"dir": clientDir})
}

// yashanPreloadPrefixes 是 yacli 依赖、需要先按绝对路径加载的客户端自带库（按顺序：OpenSSL 在前，libyas_infra 依赖它）。
// 它们带 SONAME，预先加载后 dlopen 就不依赖 LD_LIBRARY_PATH，也不会误用系统里缺少国密算法的 OpenSSL（23.1 客户端
// 自带 libcrypto.so.1.1）。Windows 由 LoadLibraryEx 按 DLL 所在目录解析依赖。
var yashanPreloadPrefixes = []string{"libcrypto", "libssl", "libyas_infra"}

// yashanPreloadLibraries 列出客户端 lib 目录里需要预加载的库的完整路径。
func yashanPreloadLibraries(dir string) []string {
	if runtime.GOOS == "windows" {
		return nil
	}
	suffix := ".so"
	if runtime.GOOS == "darwin" {
		suffix = ".dylib"
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var libraries []string
	for _, prefix := range yashanPreloadPrefixes {
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, prefix) && strings.Contains(name, suffix) {
				libraries = append(libraries, filepath.Join(dir, name))
			}
		}
	}
	return libraries
}

// loadYacliAPI 加载（并缓存）yacli 客户端库并解析用到的函数。
func loadYacliAPI(path string) (*yacliAPI, error) {
	yacliAPIMu.Lock()
	defer yacliAPIMu.Unlock()
	if api := yacliAPICache[path]; api != nil {
		return api, nil
	}
	for _, dependency := range yashanPreloadLibraries(filepath.Dir(path)) {
		_, _ = loadNativeLibrary(dependency)
	}
	lib, err := loadNativeLibrary(path)
	if err != nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.yashandb_client_load_failed", map[string]any{"path": path, "detail": err.Error()})
	}
	api := &yacliAPI{}
	symbols := []struct {
		name   string
		target *uintptr
	}{
		{"yacAllocHandle", &api.allocHandle}, {"yacFreeHandle", &api.freeHandle}, {"yacSetEnvAttr", &api.setEnvAttr},
		{"yacConnect", &api.connect}, {"yacDisconnect", &api.disconnect}, {"yacCancel", &api.cancel},
		{"yacDirectExecute", &api.directExecute}, {"yacPrepare", &api.prepare}, {"yacExecute", &api.execute},
		{"yacFetch", &api.fetch}, {"yacCommit", &api.commit}, {"yacRollback", &api.rollback},
		{"yacNumResultCols", &api.numResultCols}, {"yacDescribeCol2", &api.describeCol2}, {"yacBindColumn", &api.bindColumn},
		{"yacBindParameter", &api.bindParameter}, {"yacSetConnAttr", &api.setConnAttr}, {"yacGetConnAttr", &api.getConnAttr},
		{"yacGetStmtAttr", &api.getStmtAttr}, {"yacGetLastError", &api.getLastError},
		{"yacLobDescAlloc", &api.lobDescAlloc}, {"yacLobDescFree", &api.lobDescFree}, {"yacLobGetLength", &api.lobGetLength},
		{"yacLobRead", &api.lobRead}, {"yacLobCreateTemporary", &api.lobCreateTemporary}, {"yacLobWrite", &api.lobWrite},
		{"yacLobFreeTemporary", &api.lobFree},
	}
	for _, symbol := range symbols {
		if *symbol.target, err = lib.symbol(symbol.name); err != nil {
			return nil, localizedDatabaseRuntimeError("db.backend.error.yashandb_client_load_failed", map[string]any{"path": path, "detail": symbol.name + ": " + err.Error()})
		}
	}
	api.ping, _ = lib.symbol("yacPingWithTimeout")
	yacliAPICache[path] = api
	return api, nil
}

// call 调用 yacli 函数；失败时在同一个系统线程上取回错误（yacli 的错误信息是线程局部的）。
func (a *yacliAPI) call(fn uintptr, args ...uintptr) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	r1, _, _ := purego.SyscallN(fn, args...)
	if result := int32(r1); result == yacSuccess || result == yacSuccessWithInfo {
		return nil
	}
	return a.lastError()
}

// lastError 读取当前线程上最近一次 yacli 调用的错误；调用方必须已锁定系统线程。
func (a *yacliAPI) lastError() error {
	var (
		code           int32
		message, state uintptr
		position       [2]int32
	)
	purego.SyscallN(a.getLastError, yacliPtr(&code), yacliPtr(&message), yacliPtr(&state), yacliPtr(&position))
	err := &yacliError{Code: code, State: goCString(state), Message: strings.TrimSpace(goCString(message))}
	if position[0] > 0 {
		err.Line, err.Column = position[0], position[1]
	}
	return err
}

// yacliError 是 yacli 报告的错误：YAS 错误号、SQLSTATE、消息与 SQL 文本中的出错位置（有的话）。
type yacliError struct {
	Code         int32
	State        string
	Message      string
	Line, Column int32
}

func (e *yacliError) Error() string {
	text := fmt.Sprintf("YAS-%05d %s", e.Code, e.Message)
	if e.Line > 0 {
		text += fmt.Sprintf(" [%d:%d]", e.Line, e.Column)
	}
	return text
}

// goCString 复制 C 端以 NUL 结尾的字符串（指针为 0 时返回空串）。
func goCString(pointer uintptr) string {
	if pointer == 0 {
		return ""
	}
	// 指针指向 C 端内存（不受 Go 垃圾回收管理），按位重解释成 unsafe.Pointer。
	start := *(*unsafe.Pointer)(unsafe.Pointer(&pointer))
	length := 0
	for *(*byte)(unsafe.Add(start, length)) != 0 {
		length++
	}
	return string(unsafe.Slice((*byte)(start), length))
}

// yacliText 返回以 NUL 结尾的字节切片，供需要 C 字符串的参数使用。
func yacliText(text string) []byte {
	buffer := make([]byte, len(text)+1)
	copy(buffer, text)
	return buffer
}

// yacliInt 把可能为负的整型参数按补码转成 uintptr（被调用方只取低位）。
func yacliInt(value int) uintptr {
	return uintptr(int64(value))
}

func yacliPtr[T any](value *T) uintptr {
	return uintptr(unsafe.Pointer(value))
}
