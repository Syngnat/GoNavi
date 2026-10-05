package webserver

import (
	"encoding/json"
	"io"
	"reflect"
	"time"
)

const (
	defaultWebServerAddr      = "127.0.0.1:34116"
	internalRoutePrefix       = "/__gonavi"
	detachedWindowIDHeader    = "X-GoNavi-Detached-Window-ID"
	eventSubscriberQueueLimit = 128
	// Reliable events are allowed bounded headroom over the broadcast queue so
	// a critical targeted event can still be delivered after broadcasts fill
	// the soft limit. A subscriber that remains slower than this hard limit is
	// closed and must reconnect instead of retaining an unbounded queue.
	eventSubscriberReliableQueueLimit = eventSubscriberQueueLimit * 2
	eventStreamDataChunkBytes         = 256 << 10
)

// Shutdown deadlines are package variables so tests can shorten them.
var (
	// shutdownGraceTimeout bounds the graceful phase after the listener is
	// closed: in-flight handlers may still finish normally within this window.
	shutdownGraceTimeout = 5 * time.Second
	// shutdownDrainTimeout bounds how long force-cancelled handlers may take
	// to unwind before the deferred App resource teardown starts.
	shutdownDrainTimeout = 5 * time.Second
)

var errorType = reflect.TypeOf((*error)(nil)).Elem()

var desktopOnlyAppMethods = map[string]struct{}{
	"Shutdown":                       {},
	"SetWindowTranslucency":          {},
	"SetMacNativeWindowControls":     {},
	"SetApplicationBrandIcon":        {},
	"PrepareWindowsBrandIconRestart": {},
	"RestartApplication":             {},
	"ResetWebViewZoom":               {},
	"RefreshWebViewBounds":           {},
	"SelectDataRootDirectory":        {},
	"GetDataRootDirectoryInfo":       {},
	"ApplyDataRootDirectory":         {},
	"OpenDataRootDirectory":          {},
	"SelectLogDirectory":             {},
	"ApplyLogDirectory":              {},
	"OpenLogDirectory":               {},
	"SelectSavedQueryDirectory":      {},
	"ApplySavedQueryDirectory":       {},
	"OpenSavedQueryDirectory":        {},
	"RevealSavedQueryInFolder":       {},
	"SelectDriverDownloadDirectory":  {},
	"SelectDriverPackageFile":        {},
	"SelectDriverPackageZipFile":     {},
	"SelectDriverPackageDirectory":   {},
	// 导出走本机保存对话框，Web 运行时没有等价能力。
	"ExportDriverPackage":          {},
	"ExportDriverPackageSelection": {},
	"OpenSQLFile":                  {},
	"SelectSQLFileForExecution":    {},
	"SelectSQLDirectory":           {},
	"ListSQLDirectory":             {},
	"ReadSQLFile":                  {},
	"WriteSQLFile":                 {},
	"CreateSQLFile":                {},
	"CreateSQLDirectory":           {},
	"DeleteSQLFile":                {},
	"DeleteSQLDirectory":           {},
	"RenameSQLFile":                {},
	"RenameSQLDirectory":           {},
	"ExecuteSQLFile":               {},
	"ExportSQLFile":                {},
	"ImportConfigFile":             {},
	"ExportConnectionsPackage":     {},
	"SelectSSHKeyFile":             {},
	"SelectSSHKnownHostsFile":      {},
	"SelectCertificateFile":        {},
	"SelectDatabaseFile":           {},
	"ImportData":                   {},
	"ExportSQLAuditFile":           {},
}

var desktopOnlyCredentialAppMethods = map[string]struct{}{
	"RevealSavedConnectionPrimaryPassword": {},
}

type Options struct {
	Addr string
	// Console 接收启动横幅。程序化调用方（测试、内嵌运行时）保持 nil 即可静默；
	// 只有 CLI 入口 Run() 会把它设为 os.Stderr。日志默认只落文件，没有这行
	// 用户既不知道服务是否起来，也不知道该去哪里看失败原因。
	Console io.Writer
}

type invokeRequest struct {
	Namespace string            `json:"namespace"`
	Receiver  string            `json:"receiver"`
	Method    string            `json:"method"`
	Args      []json.RawMessage `json:"args"`
}

type invokeResponse struct {
	Result    any    `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}
