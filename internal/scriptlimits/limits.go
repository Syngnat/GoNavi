// Package scriptlimits centralizes script workbench limit defaults and bounds.
package scriptlimits

const (
	DefaultDesktopTimeoutMs int64 = 30 * 60 * 1_000
	DefaultWebTimeoutMs     int64 = 10 * 60 * 1_000
	MinTimeoutMs            int64 = 60 * 1_000
	MaxDesktopTimeoutMs     int64 = 2 * 60 * 60 * 1_000
	MaxWebTimeoutMs         int64 = 30 * 60 * 1_000

	DefaultMaxDBCalls = 10_000
	MaxDBCalls        = 100_000

	DefaultMaxOutputRows = 50_000
	MaxOutputRows        = 200_000
	DefaultQueryRows     = 10_000
	MaxQueryRows         = MaxOutputRows

	DefaultMemoryLimitBytes    int64 = 512 << 20
	MinMemoryLimitBytes        int64 = 64 << 20
	MaxDesktopMemoryLimitBytes int64 = 2 << 30
	MaxWebMemoryLimitBytes     int64 = 1 << 30
)
