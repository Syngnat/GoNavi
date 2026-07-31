package app

import (
	"errors"
	"os/exec"
)

func startBackgroundCommand(cmd *exec.Cmd, onExit func(error)) error {
	if cmd == nil {
		return errors.New("background command is nil")
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		err := cmd.Wait()
		if onExit != nil {
			onExit(err)
		}
	}()
	return nil
}
