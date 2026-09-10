//go:build !windows

package provider

import "os/exec"

func configureLocalCLICommand(_ *exec.Cmd) {}
