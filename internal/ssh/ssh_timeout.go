package ssh

import (
	"time"

	"GoNavi-Wails/internal/connection"
)

func resolveSSHConnectTimeout(config connection.SSHConfig) time.Duration {
	if config.ConnectTimeout > 0 {
		return time.Duration(config.ConnectTimeout) * time.Second
	}
	return 5 * time.Second
}
