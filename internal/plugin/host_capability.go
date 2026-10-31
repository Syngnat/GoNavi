package plugin

import (
	"encoding/json"
	"errors"
)

// acceptHostCapability forwards one caller-bound capability request to the
// embedding application. The app owns permissions, argument limits and result
// limits; this layer only proves the instance is still live and the callback
// was installed, so a stopped generation cannot keep calling host methods.
func (m *Manager) acceptHostCapability(inst *instance, process *rpcProcess, params json.RawMessage) (json.RawMessage, error) {
	m.mu.Lock()
	current := m.instances[inst.record.Manifest.ID]
	live := current == inst && inst.process == process && inst.ctx.Err() == nil
	callback := m.opts.HostCapability
	pluginID := inst.record.Manifest.ID
	generation := inst.record.Generation
	ctx := inst.ctx
	m.mu.Unlock()
	if !live || callback == nil {
		return nil, errHostLogDenied
	}
	if len(params) == 0 || len(params) > maxRPCBytes || !json.Valid(params) {
		return nil, errHostLogParams
	}
	result, err := callback(ctx, pluginID, generation, params)
	if err != nil {
		return nil, err
	}
	if len(result) == 0 || len(result) > maxRPCBytes || !json.Valid(result) {
		return nil, errors.New("host capability response is invalid or oversized")
	}
	return result, nil
}
