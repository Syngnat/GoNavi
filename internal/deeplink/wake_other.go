//go:build !windows

package deeplink

// Outside Windows the operating system itself hands a gonavi:// link to the running
// application (macOS: the URL scheme in Info.plist and Wails' OnUrlOpen), so there is no
// second process to wake the first, and nothing GoNavi has to register at run time.

// SignalRunning is never needed here: no process is started by a link.
func SignalRunning(string) (bool, error) { return false, nil }

// Listen does nothing here.
func Listen(string, func()) (func(), error) { return func() {}, nil }

// Register does nothing here; macOS reads the scheme from the application bundle.
func Register(string) (bool, error) { return false, nil }
