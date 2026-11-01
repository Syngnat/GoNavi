package plugin

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/logger"
)

var errHostLogDenied = errors.New("host method is not permitted")
var errHostLogParams = errors.New("invalid host log parameters")
var errHostLogBusy = errors.New("host log rate exceeded")

// writeHostLog is the production diagnostic sink. Tests replace it.
var writeHostLog = func(id, level, message string) {
	if level == "warn" {
		logger.Warnf("plugin %s: %s", id, message)
		return
	}
	logger.Infof("plugin %s: %s", id, message)
}

func (m *Manager) bindHostLog(inst *instance, process *rpcProcess) {
	process.bindHostHandlers(
		func(params json.RawMessage) (json.RawMessage, error) {
			return m.acceptHostLog(inst, process, params)
		},
		func(params json.RawMessage) (json.RawMessage, error) {
			return m.acceptHostDescribe(inst, process, params)
		},
		func(params json.RawMessage) (json.RawMessage, error) {
			return m.acceptHostCapability(inst, process, params)
		},
	)
}

// bindHostHandlers installs the callback set under the same lock the protocol reader uses,
// so a plugin that emits host.* immediately after exec cannot race the binding.
func (p *rpcProcess) bindHostHandlers(log, describe, capability func(json.RawMessage) (json.RawMessage, error)) {
	p.mu.Lock()
	p.hostLog, p.hostDescribe, p.hostCapability = log, describe, capability
	p.mu.Unlock()
}

func (m *Manager) acceptHostLog(inst *instance, process *rpcProcess, params json.RawMessage) (json.RawMessage, error) {
	if !process.allowHostLog() {
		return nil, errHostLogBusy
	}
	m.mu.Lock()
	current := m.instances[inst.record.Manifest.ID]
	live := current == inst && inst.process == process && inst.ctx.Err() == nil
	id := inst.record.Manifest.ID
	permitted := hasHostLogPermission(inst.record.Manifest)
	m.mu.Unlock()
	if !live || !permitted {
		return nil, errHostLogDenied
	}
	level, message, err := parseHostLog(params)
	if err != nil {
		return nil, err
	}
	writeHostLog(id, level, message)
	return json.RawMessage("{}"), nil
}

func hasHostLogPermission(manifest Manifest) bool {
	for _, permission := range manifest.Permissions {
		if permission == "host.log" {
			return true
		}
	}
	return false
}

func parseHostLog(params json.RawMessage) (string, string, error) {
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.DisallowUnknownFields()
	var body struct {
		Level   string `json:"level"`
		Message string `json:"message"`
	}
	if err := decoder.Decode(&body); err != nil {
		return "", "", errHostLogParams
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return "", "", errHostLogParams
	}
	if body.Level != "info" && body.Level != "warn" {
		return "", "", errHostLogParams
	}
	if body.Message == "" || len(body.Message) > 1024 || !utf8.ValidString(body.Message) || strings.ContainsRune(body.Message, 0) {
		return "", "", errHostLogParams
	}
	return body.Level, body.Message, nil
}

func (p *rpcProcess) allowHostLog() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	if now.Sub(p.hostLogWindow) >= time.Second {
		p.hostLogWindow = now
		p.hostLogCount = 0
	}
	if p.hostLogCount >= 8 {
		return false
	}
	p.hostLogCount++
	return true
}
