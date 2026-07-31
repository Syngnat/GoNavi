//go:build !windows

package provider

import "os/exec"

func configureClaudeCLICommand(_ *exec.Cmd) {}
