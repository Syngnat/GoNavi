package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/scriptengine"
)

func (p *scriptWorkbenchPrepared) ensureWorkerScript() error {
	if p == nil {
		return errScriptWorkbenchUnavailable
	}
	if strings.TrimSpace(p.code) == "" {
		return errors.New("script source is required")
	}
	p.workerRequest.Script = p.code
	return nil
}

func (a *App) executeScriptWorkbenchRun(run *scriptWorkbenchRun, prepared *scriptWorkbenchPrepared) {
	host := newScriptWorkbenchHost(a, run, prepared)
	run.mu.Lock()
	run.host = host
	run.status = scriptWorkbenchStatusRunning
	run.stage = "starting"
	run.mu.Unlock()
	run.emit("progress", map[string]any{"stage": "starting"})

	request := prepared.workerRequest
	request.RunID = run.id
	runner := scriptengine.Runner{}
	result := runner.Run(run.ctx, request, host, func(event scriptengine.Event) error {
		return a.handleScriptWorkbenchEvent(run, event)
	})

	status := scriptWorkbenchStatusSucceeded
	var runErr error
	switch {
	case result.TimedOut || errors.Is(run.ctx.Err(), context.DeadlineExceeded):
		status = scriptWorkbenchStatusTimedOut
		runErr = errors.New("script timed out")
	case result.Cancelled || errors.Is(run.ctx.Err(), context.Canceled):
		status = scriptWorkbenchStatusCancelled
		runErr = errors.New("script cancelled")
	case !result.Success:
		status = scriptWorkbenchStatusFailed
		run.mu.Lock()
		run.memoryExceeded = result.MemoryExceeded
		run.mu.Unlock()
		if strings.TrimSpace(result.Message) != "" {
			runErr = errors.New(truncateUTF8Bytes(result.Message, scriptengine.MaxErrorMessageBytes))
		} else {
			runErr = errors.New("script failed")
		}
	}
	a.scriptWorkbench.finish(run, status, runErr)
}

func (a *App) handleScriptWorkbenchEvent(run *scriptWorkbenchRun, event scriptengine.Event) error {
	if run == nil {
		return errors.New("script run is unavailable")
	}
	switch event.Type {
	case "log":
		level := normalizeScriptLogLevel(event.Level)
		message := truncateUTF8Bytes(event.Message, scriptengine.MaxLogMessageBytes)
		run.appendLog(level, message)
		run.emit("log", map[string]any{
			"level":   level,
			"message": message,
		})
	case "progress":
		if len(event.Payload) > scriptengine.MaxProgressBytes {
			return errors.New("script progress payload exceeds the size limit")
		}
		var payload map[string]any
		if len(event.Payload) > 0 {
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				return errors.New("script progress payload must be a JSON object")
			}
		}
		if payload == nil {
			return errors.New("script progress payload must be a JSON object")
		}
		run.setProgress(payload)
		run.emit("progress", payload)
	case "output":
		if len(event.Payload) > scriptengine.MaxOutputChunkBytes {
			return errors.New("script output chunk exceeds the size limit")
		}
		var payload struct {
			Name string           `json:"name"`
			Rows []map[string]any `json:"rows"`
		}
		if len(event.Payload) == 0 || json.Unmarshal(event.Payload, &payload) != nil {
			return errors.New("script output payload is invalid")
		}
		if strings.TrimSpace(payload.Name) == "" || len(payload.Name) > scriptengine.MaxOutputNameBytes {
			return errors.New("script output name is invalid")
		}
		if len(payload.Rows) > scriptengine.MaxOutputRows {
			return errors.New("script output chunk contains too many rows")
		}
		run.appendOutput(payload.Name, payload.Rows)
		run.emit("output", map[string]any{
			"name": payload.Name,
			"rows": len(payload.Rows),
		})
	default:
		return fmt.Errorf("unsupported script event type %q", event.Type)
	}
	return nil
}
