package logger

import (
	"os"

	wailslogger "github.com/wailsapp/wails/v2/pkg/logger"
)

type wailsAdapter struct{}

var _ wailslogger.Logger = wailsAdapter{}

// NewWailsAdapter routes Wails runtime and frontend logs into GoNavi's log file.
func NewWailsAdapter() wailslogger.Logger {
	return wailsAdapter{}
}

func (wailsAdapter) Print(message string) {
	printf("INFO", "[Wails] %s", message)
}

func (wailsAdapter) Trace(message string) {
	printf("TRACE", "[Wails] %s", message)
}

func (wailsAdapter) Debug(message string) {
	printf("DEBUG", "[Wails] %s", message)
}

func (wailsAdapter) Info(message string) {
	printf("INFO", "[Wails] %s", message)
}

func (wailsAdapter) Warning(message string) {
	printf("WARN", "[Wails] %s", message)
}

func (wailsAdapter) Error(message string) {
	printf("ERROR", "[Wails] %s", message)
}

func (wailsAdapter) Fatal(message string) {
	printf("FATAL", "[Wails] %s", message)
	Close()
	os.Exit(1)
}
