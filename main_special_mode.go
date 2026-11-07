//go:build !bindings && !wails3

package main

import (
	"errors"
	"os"

	"GoNavi-Wails/internal/logger"
)

func configurePluginProcessArgs() bool {
	args, err := preparePluginSafeMode(os.Args[1:])
	if err != nil {
		logger.Error(err, "Configure plugin safe mode")
		return false
	}
	os.Args = append(os.Args[:1], args...)
	return true
}

func finishSpecialMode(args []string) bool {
	handled, err := runSpecialMode(args)
	if !handled {
		return false
	}
	var cliExit *desktopCLIExit
	if errors.As(err, &cliExit) {
		os.Exit(cliExit.code)
	}
	if err != nil && !isNormalSpecialModeExit(err) {
		reportFatalError(err, "GoNavi 特殊模式退出")
		os.Exit(1)
	}
	return true
}
