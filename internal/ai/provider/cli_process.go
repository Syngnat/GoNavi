package provider

import (
	"context"
	"os/exec"
)

// newLocalCLICommand is the only process-construction boundary for local AI
// CLIs. Windows GUI builds must not allocate a transient console for a child
// command; other platforms retain the default os/exec behaviour.
func newLocalCLICommand(
	commandContext func(context.Context, string, ...string) *exec.Cmd,
	ctx context.Context,
	name string,
	args ...string,
) *exec.Cmd {
	cmd := commandContext(ctx, name, args...)
	configureLocalCLICommand(cmd)
	return cmd
}
