//go:build !wails3

package nativewindow

import (
	"os"
	"os/exec"
	"strings"
)

var detachedChildFilteredEnvironment = map[string]struct{}{
	"assetdir":             {},
	"devserver":            {},
	"frontenddevserverurl": {},
}

type processSpec struct {
	Executable string
	Env        []string
}

type childProcess interface {
	PID() int
	Wait() error
	Kill() error
}

type processStarter interface {
	Start(processSpec) (childProcess, error)
}

type execProcessStarter struct{}

func (execProcessStarter) Start(spec processSpec) (childProcess, error) {
	command := exec.Command(spec.Executable, detachedWindowProcessArgument())
	command.Env = spec.Env
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return nil, err
	}
	return &execChildProcess{command: command}, nil
}

func detachedWindowProcessArgument() string {
	return strings.TrimLeft(DetachedWindowArgument, "-")
}

func filterDetachedChildEnvironment(environment []string) []string {
	filtered := make([]string, 0, len(environment))
	for _, item := range environment {
		name, _, _ := strings.Cut(item, "=")
		if _, blocked := detachedChildFilteredEnvironment[strings.ToLower(strings.TrimSpace(name))]; blocked {
			continue
		}
		filtered = append(filtered, item)
	}
	return filtered
}

type execChildProcess struct {
	command *exec.Cmd
}

func (p *execChildProcess) PID() int {
	if p == nil || p.command == nil || p.command.Process == nil {
		return 0
	}
	return p.command.Process.Pid
}

func (p *execChildProcess) Wait() error {
	if p == nil || p.command == nil {
		return nil
	}
	return p.command.Wait()
}

func (p *execChildProcess) Kill() error {
	if p == nil || p.command == nil || p.command.Process == nil {
		return nil
	}
	return p.command.Process.Kill()
}
