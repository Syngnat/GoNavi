package cli

import (
	"errors"
	"flag"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai/runharness"

	"github.com/google/uuid"
)

func requestID() string { return uuid.NewString() }

func normalizedAgentRequestID(value string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return requestID()
}

// parseAgentFlags keeps the standard flag package while accepting the usual
// CLI form where a positional RUN_ID or prompt appears before options. Go's
// flag parser stops at the first positional argument, so move positional
// values behind the flags before parsing. Values belonging to non-boolean
// flags are kept with their flag and are never mistaken for positionals.
func parseAgentFlags(fs *flag.FlagSet, args []string) error {
	if fs == nil {
		return errors.New("agent flag set is nil")
	}
	flags := make([]string, 0, len(args))
	positionals := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			positionals = append(positionals, args[index+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			positionals = append(positionals, arg)
			continue
		}
		flags = append(flags, arg)
		if strings.Contains(arg, "=") {
			continue
		}
		name := strings.TrimLeft(arg, "-")
		definition := fs.Lookup(name)
		if definition == nil {
			continue
		}
		if boolean, ok := definition.Value.(interface{ IsBoolFlag() bool }); ok && boolean.IsBoolFlag() {
			continue
		}
		if index+1 < len(args) {
			index++
			flags = append(flags, args[index])
		}
	}
	ordered := append(flags, positionals...)
	return fs.Parse(ordered)
}

// agentPollInterval resolves the wait-loop cadence from the command flag and
// then the shared runtime configuration. A positive explicit value wins; a
// zero value is the sentinel used by CLI flags whose default comes from
// agent_run_policy.json.
func agentPollInterval(fs *flag.FlagSet, explicit time.Duration, runtimeConfig runharness.RunRuntimeConfig) time.Duration {
	if explicit > 0 && (fs == nil || visitedFlags(fs)["poll"]) {
		return explicit
	}
	return runtimeConfig.Normalize().ControlPollInterval
}

func agentPollFlagInvalid(fs *flag.FlagSet, explicit time.Duration) bool {
	return visitedFlags(fs)["poll"] && explicit <= 0
}
