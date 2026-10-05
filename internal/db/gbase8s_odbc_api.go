//go:build gonavi_full_drivers || gonavi_gbase8s_driver

package db

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// GBase 8s（Informix 内核）的 SQLI 协议没有纯 Go 实现，驱动直接调用用户安装的 CSDK 里的 ODBC 驱动库
// （ANSI 接口，客户端字符集固定为 UTF-8）。这里只封装用到的 ODBC 3 函数。

const (
	sqlHandleEnv  = 1
	sqlHandleDbc  = 2
	sqlHandleStmt = 3

	sqlSuccess         = 0
	sqlSuccessWithInfo = 1
	sqlNoData          = 100
	sqlNeedData        = 99

	sqlNTS      = -3
	sqlNullData = -1
	sqlNoTotal  = -4

	sqlAttrODBCVersion = 200
	sqlOVODBC3         = 3
	sqlAttrAutocommit  = 102
	sqlAutocommitOff   = 0
	sqlAutocommitOn    = 1
	sqlCommit          = 0
	sqlRollback        = 1
	sqlDriverNoPrompt  = 0
	sqlClose           = 0
	sqlResetParams     = 3
	sqlParamInput      = 1

	sqlCChar    = 1
	sqlCDouble  = 8
	sqlCBinary  = -2
	sqlCSBigint = -25

	sqlTypeChar          = 1
	sqlTypeNumeric       = 2
	sqlTypeDecimal       = 3
	sqlTypeInteger       = 4
	sqlTypeSmallint      = 5
	sqlTypeFloat         = 6
	sqlTypeReal          = 7
	sqlTypeDouble        = 8
	sqlTypeVarchar       = 12
	sqlTypeLongVarchar   = -1
	sqlTypeBinary        = -2
	sqlTypeVarBinary     = -3
	sqlTypeLongVarBinary = -4
	sqlTypeBigint        = -5
	sqlTypeTinyint       = -6
	sqlTypeBit           = -7
)

// odbcAPI 是一个已加载的 ODBC 驱动库与它的环境句柄。
type odbcAPI struct {
	env uintptr

	allocHandle, freeHandle, setEnvAttr, setConnectAttr, driverConnect, disconnect uintptr
	execDirect, prepare, execute, bindParameter, numResultCols, describeCol        uintptr
	fetch, getData, rowCount, moreResults, freeStmt, endTran, getDiagRec, cancel   uintptr
}

var (
	odbcAPIMu    sync.Mutex
	odbcAPICache = map[string]*odbcAPI{}
)

// gbase8sODBCLibraryCandidates 是 CSDK 目录下 ODBC 驱动库的相对路径（各平台 CSDK 的目录结构不同）。
func gbase8sODBCLibraryCandidates() []string {
	switch runtime.GOOS {
	case "windows":
		return []string{filepath.Join("bin", "iclit09b.dll")}
	case "darwin":
		return []string{filepath.Join("lib", "cli", "iclit09b.dylib"), filepath.Join("lib", "cli", "libifcli.dylib")}
	default:
		return []string{filepath.Join("lib", "cli", "iclit09b.so"), filepath.Join("lib", "cli", "libifcli.so")}
	}
}

// resolveGBase8sODBCLibrary 在 CSDK 目录里找 ODBC 驱动库；library 非空时直接使用（相对路径按 CSDK 目录解析）。
func resolveGBase8sODBCLibrary(home, library string) (string, error) {
	if library = strings.TrimSpace(library); library != "" {
		if !filepath.IsAbs(library) && home != "" {
			library = filepath.Join(home, library)
		}
		return library, nil
	}
	if home == "" {
		return "", localizedDatabaseRuntimeError("db.backend.error.gbase8s_client_missing", nil)
	}
	for _, candidate := range gbase8sODBCLibraryCandidates() {
		path := filepath.Join(home, candidate)
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.gbase8s_client_library_missing", map[string]any{"dir": home})
}

// loadODBCAPI 加载（并缓存）ODBC 驱动库，分配 ODBC 3 环境句柄。
func loadODBCAPI(path string) (*odbcAPI, error) {
	odbcAPIMu.Lock()
	defer odbcAPIMu.Unlock()
	if api := odbcAPICache[path]; api != nil {
		return api, nil
	}
	lib, err := loadNativeLibrary(path)
	if err != nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.gbase8s_client_load_failed", map[string]any{"path": path, "detail": err.Error()})
	}
	api := &odbcAPI{}
	symbols := []struct {
		name   string
		target *uintptr
	}{
		{"SQLAllocHandle", &api.allocHandle}, {"SQLFreeHandle", &api.freeHandle}, {"SQLSetEnvAttr", &api.setEnvAttr},
		{"SQLSetConnectAttr", &api.setConnectAttr}, {"SQLDriverConnect", &api.driverConnect}, {"SQLDisconnect", &api.disconnect},
		{"SQLExecDirect", &api.execDirect}, {"SQLPrepare", &api.prepare}, {"SQLExecute", &api.execute},
		{"SQLBindParameter", &api.bindParameter}, {"SQLNumResultCols", &api.numResultCols}, {"SQLDescribeCol", &api.describeCol},
		{"SQLFetch", &api.fetch}, {"SQLGetData", &api.getData}, {"SQLRowCount", &api.rowCount},
		{"SQLMoreResults", &api.moreResults}, {"SQLFreeStmt", &api.freeStmt}, {"SQLEndTran", &api.endTran},
		{"SQLGetDiagRec", &api.getDiagRec}, {"SQLCancel", &api.cancel},
	}
	for _, symbol := range symbols {
		if *symbol.target, err = lib.symbol(symbol.name); err != nil {
			return nil, localizedDatabaseRuntimeError("db.backend.error.gbase8s_client_load_failed", map[string]any{"path": path, "detail": symbol.name + ": " + err.Error()})
		}
	}
	if rc := odbcCall(api.allocHandle, sqlHandleEnv, 0, ptr(&api.env)); !odbcOK(rc) {
		return nil, fmt.Errorf("SQLAllocHandle(ENV) failed: %d", rc)
	}
	if rc := odbcCall(api.setEnvAttr, api.env, sqlAttrODBCVersion, sqlOVODBC3, 0); !odbcOK(rc) {
		return nil, api.diagError(sqlHandleEnv, api.env, rc)
	}
	odbcAPICache[path] = api
	return api, nil
}

// odbcCall 调用 ODBC 函数并取 SQLRETURN（16 位有符号）。负数参数按补码传入，被调用方只取低位。
func odbcCall(fn uintptr, args ...uintptr) int16 {
	r1, _, _ := purego.SyscallN(fn, args...)
	return int16(r1)
}

func odbcOK(rc int16) bool {
	return rc == sqlSuccess || rc == sqlSuccessWithInfo
}

// sqlInt 把可能为负的 ODBC 整型参数转成 uintptr。
func sqlInt(value int) uintptr {
	return uintptr(int64(value))
}

func ptr[T any](value *T) uintptr {
	return uintptr(unsafe.Pointer(value))
}

// unsafePointer 返回非空字节切片首元素的指针，用来按原生类型写入参数缓冲区。
func unsafePointer(buffer []byte) unsafe.Pointer {
	return unsafe.Pointer(&buffer[0])
}

// odbcError 是 ODBC 诊断记录：SQLSTATE、驱动原生错误码（Informix 的负数错误号）与消息。
type odbcError struct {
	State   string
	Native  int32
	Message string
}

func (e *odbcError) Error() string {
	if e.Native != 0 {
		return fmt.Sprintf("[%s] %d: %s", e.State, e.Native, e.Message)
	}
	return fmt.Sprintf("[%s] %s", e.State, e.Message)
}

// odbcGenericNative 是 ODBC 驱动的通用错误号（General error），具体原因在后续诊断记录里。
const odbcGenericNative = -11060

// diagError 读取句柄上的全部诊断记录：驱动常把 -11060 General error 放在第一条，服务端的具体错误（如 -201 语法错误）
// 在后面，所以错误号取第一条非通用的记录，消息按顺序去重拼接。驱动没给出记录时返回带返回码的通用错误。
func (a *odbcAPI) diagError(handleType int, handle uintptr, rc int16) error {
	state := make([]byte, 6)
	message := make([]byte, 2048)
	var result *odbcError
	var messages []string
	for record := 1; record <= 8; record++ {
		var native int32
		var length int16
		res := odbcCall(a.getDiagRec, uintptr(handleType), handle, uintptr(record), ptr(&state[0]), ptr(&native), ptr(&message[0]), uintptr(len(message)), ptr(&length))
		if !odbcOK(res) {
			break
		}
		if int(length) > len(message)-1 {
			length = int16(len(message) - 1)
		}
		text := strings.TrimSpace(strings.TrimRight(string(message[:max(length, 0)]), "\x00"))
		current := &odbcError{State: strings.TrimRight(string(state[:5]), "\x00"), Native: native, Message: text}
		if result == nil || (result.Native == odbcGenericNative && native != odbcGenericNative && native != 0) {
			result = current
		}
		if text != "" && !slices.Contains(messages, text) {
			messages = append(messages, text)
		}
	}
	if result == nil {
		return fmt.Errorf("ODBC call failed with return code %d", rc)
	}
	result.Message = strings.Join(messages, "; ")
	return result
}

// cString 返回以 NUL 结尾的字节切片；调用方在 ODBC 调用期间持有返回值。
func cString(text string) []byte {
	buffer := make([]byte, len(text)+1)
	copy(buffer, text)
	return buffer
}
