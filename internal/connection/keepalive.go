package connection

import "time"

const (
	defaultKeepAliveIntervalMinutes = 240
	minKeepAliveIntervalMinutes     = 1
	maxKeepAliveIntervalMinutes     = 1440
)

// ResolveKeepAliveInterval 把用户配置的保活间隔（分钟）夹紧到合法区间并换算成时长。
// 小于等于 0 视为未配置，回落到默认值。后台保活探活与连接池保活保留窗口必须共用
// 同一份夹紧结果，否则两边对「间隔」的理解会不一致。
func ResolveKeepAliveInterval(minutes int) time.Duration {
	switch {
	case minutes <= 0:
		minutes = defaultKeepAliveIntervalMinutes
	case minutes < minKeepAliveIntervalMinutes:
		minutes = minKeepAliveIntervalMinutes
	case minutes > maxKeepAliveIntervalMinutes:
		minutes = maxKeepAliveIntervalMinutes
	}
	return time.Duration(minutes) * time.Minute
}
