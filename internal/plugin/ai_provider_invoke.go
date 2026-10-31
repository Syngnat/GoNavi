package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// ErrAIProviderCommandReserved rejects ordinary calls to host-managed provider commands.
var ErrAIProviderCommandReserved = errors.New("plugin ai provider command requires host-managed invocation")
var errAIInvocationDeadline = fmt.Errorf("plugin ai runtime invocation deadline exceeded: %w", context.DeadlineExceeded)
var aiRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type aiInvocation struct {
	operation     string
	responseBytes int
}
type aiInvocationLease struct {
	instance *instance
	record   record
	provider AIProvider
}

// InvokeAIProviderGeneration is a trusted-host-only provider transport, never a Wails gateway.
// Admission and completion pin the actual declaration, digest and live owner generation.
// Response credits remain charged after request cancellation until the transport settles them.
func (m *Manager) InvokeAIProviderGeneration(ctx context.Context, id string, generation uint64, providerID, digest string, args json.RawMessage) (json.RawMessage, error) {
	if ctx == nil {
		return nil, fmt.Errorf("ai provider invocation requires context")
	}
	operation, err := decodeAIInvocation(args, providerID)
	if err != nil {
		return nil, err
	}
	request, cancel := context.WithCancel(ctx)
	defer cancel()
	if operation.operation == "cancel" {
		bounded, stop := context.WithTimeout(request, aiCancelTimeout)
		defer stop()
		request = bounded
	}
	lease, err := m.aiInvocationSnapshot(request, id, generation, providerID, digest)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(lease.instance.ctx, cancel)
	defer stop()
	admission, stopAdmission := context.WithTimeout(request, aiAdmissionTimeout)
	credit, err := lease.instance.aiTraffic.acquire(admission, operation.responseBytes, operation.operation == "cancel")
	stopAdmission()
	if err != nil {
		return nil, err
	}
	if err = m.checkAIInvocation(request, lease); err != nil {
		credit.release()
		return nil, err
	}
	if err = m.admitAIInvocation(lease, operation.operation == "cancel"); err != nil {
		credit.release()
		return nil, err
	}
	defer func() { m.mu.Lock(); lease.instance.inflight--; m.mu.Unlock() }()
	// Pending transport owns the dispatch watchdog until actual reply or process failure, even after caller cancellation.
	result, err := lease.instance.process.callBounded(request, "plugin.invoke", struct {
		CommandID string          `json:"commandId"`
		Arguments json.RawMessage `json:"arguments"`
	}{CommandID: lease.provider.Command, Arguments: args}, rpcCallPolicy{maxRequestBytes: maxAIProviderRequestBytes, maxResponseBytes: operation.responseBytes, settled: credit.release, dispatchTimeout: m.opts.InvocationTimeout, timeoutError: errAIInvocationDeadline})

	if err != nil {
		return nil, err
	}
	if err = m.checkAIInvocation(request, lease); err != nil {
		return nil, err
	}
	return result, nil
}

// CheckAIProviderGeneration verifies a frozen host binding without RPC, startup or admission credits.
// It shares the durable dependency/permission and live-owner checks used by invocation.
func (m *Manager) CheckAIProviderGeneration(ctx context.Context, id string, generation uint64, providerID, digest string) error {
	if ctx == nil {
		return fmt.Errorf("ai provider check requires context")
	}
	_, err := m.aiInvocationSnapshot(ctx, id, generation, providerID, digest)
	return err
}

// maxAIProviderRequestBytes is the only host request that may exceed maxRPCBytes:
// provider starts may carry bounded base64 image content parts. Plugin output
// frames keep the ordinary one MiB ceiling.
const maxAIProviderRequestBytes = 32 << 20

func decodeAIInvocation(raw json.RawMessage, providerID string) (aiInvocation, error) {
	var empty aiInvocation
	if len(raw) == 0 || len(raw) > maxAIProviderRequestBytes || !aiProviderIDPattern.MatchString(providerID) {
		return empty, fmt.Errorf("invalid ai provider arguments")
	}
	var header struct {
		ProtocolVersion int             `json:"protocolVersion"`
		Operation       string          `json:"operation"`
		ProviderID      string          `json:"providerId"`
		RequestID       string          `json:"requestId"`
		Config          json.RawMessage `json:"config"`
		Request         json.RawMessage `json:"request"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		return empty, fmt.Errorf("invalid ai provider arguments")
	}
	fields := []string{"protocolVersion", "operation", "providerId", "requestId"}
	limit := aiControlReplyBytes
	switch header.Operation {
	case "start":
		fields = append(fields, "config", "request")
	case "pull":
		limit = aiPullReplyBytes
	case "cancel":
	default:
		return empty, fmt.Errorf("unsupported ai provider operation")
	}
	if err := validateAIObject(raw, fields, nil); err != nil {
		return empty, err
	}
	if header.ProtocolVersion != 1 || header.ProviderID != providerID || !aiRequestIDPattern.MatchString(header.RequestID) {
		return empty, fmt.Errorf("invalid ai provider request binding")
	}
	if header.Operation == "start" {
		for _, value := range []json.RawMessage{header.Config, header.Request} {
			trimmed := bytes.TrimSpace(value)
			if len(trimmed) == 0 || trimmed[0] != '{' {
				return empty, fmt.Errorf("ai provider config and request must be objects")
			}
		}
	}
	return aiInvocation{operation: header.Operation, responseBytes: limit}, nil
}

func aiProviderCommandReserved(manifest Manifest, command string) bool {
	for _, provider := range manifest.Contributes.AIProviders {
		if provider.Command == command {
			return true
		}
	}
	return false
}

func declaredAIProvider(manifest Manifest, id string) (AIProvider, error) {
	if manifest.Backend == nil || !hasAIProviderPermission(manifest) {
		return AIProvider{}, ErrDisabled
	}
	for _, provider := range manifest.Contributes.AIProviders {
		if provider.ID == id {
			for _, command := range manifest.Contributes.Commands {
				if command.ID == provider.Command {
					return provider, nil
				}
			}
			return AIProvider{}, ErrNotFound
		}
	}
	return AIProvider{}, ErrNotFound
}

func (m *Manager) aiInvocationSnapshot(ctx context.Context, id string, generation uint64, providerID, digest string) (aiInvocationLease, error) {
	var empty aiInvocationLease
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	if generation == 0 || m.opts.Disabled || !m.OwnsRuntime() {
		return empty, ErrDisabled
	}
	if !validDigest(digest) {
		return empty, ErrDigestMismatch
	}
	state, err := m.loadState()
	if err != nil {
		return empty, err
	}
	record, ok := state.Records[id]
	if !ok {
		return empty, ErrNotFound
	}
	if !record.DesiredEnabled || record.State != StateRunning || record.Quarantined || record.Removing || record.Generation != generation || dependencyReason(record, state.Records) != "" {
		return empty, ErrDisabled
	}
	if record.Digest != digest {
		return empty, ErrDigestMismatch
	}
	provider, err := declaredAIProvider(record.Manifest, providerID)
	if err != nil {
		return empty, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return empty, ErrClosed
	}
	instance := m.instances[id]
	if !m.started || m.owner == nil || instance == nil || !instance.ready || instance.ctx.Err() != nil || instance.process == nil || instance.record.Generation != generation || instance.record.Digest != digest {
		return empty, ErrDisabled
	}
	return aiInvocationLease{instance: instance, record: record, provider: provider}, nil
}

func (m *Manager) checkAIInvocation(ctx context.Context, lease aiInvocationLease) error {
	current, err := m.aiInvocationSnapshot(ctx, lease.record.Manifest.ID, lease.record.Generation, lease.provider.ID, lease.record.Digest)
	if err != nil {
		return err
	}
	if current.instance != lease.instance || current.record.Manifest.Version != lease.record.Manifest.Version || !sameAIProvider(current.provider, lease.provider) {
		return ErrDisabled
	}
	return nil
}

func (m *Manager) admitAIInvocation(lease aiInvocationLease, control bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	instance := lease.instance
	if m.closed || !m.started || m.owner == nil || m.instances[lease.record.Manifest.ID] != instance || !instance.ready || instance.ctx.Err() != nil {
		return ErrDisabled
	}
	if !control && instance.inflight >= m.opts.MaxConcurrentInvocations {
		return ErrBusy
	}
	instance.inflight++
	return nil
}

func sameAIProvider(left, right AIProvider) bool {
	if left.ID != right.ID || left.Name != right.Name || left.Command != right.Command || left.Icon != right.Icon || left.SupportsTools != right.SupportsTools || left.SupportsImages != right.SupportsImages || len(left.Models) != len(right.Models) {
		return false
	}
	for index, model := range left.Models {
		if model != right.Models[index] {
			return false
		}
	}
	return true
}
