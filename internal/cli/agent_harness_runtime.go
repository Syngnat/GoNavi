package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/internal/ai/runharness"
	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/mcpserver"
)

// cliProviderResolver owns only the current configuration lookup used while an
// input is accepted. The immutable, secret-bearing result is persisted in the
// Ledger's provider binding; model attempts never reload this configuration.
type cliProviderResolver struct {
	root string
}

// newCLIProviderInstance is a narrow test seam. Production code always uses
// provider.NewProvider; tests can inspect the exact frozen config without
// reaching into provider implementations' private fields.
var newCLIProviderInstance = provider.NewProvider

func newCLIProviderResolver(root string) runharness.ProviderResolver {
	return newCLIProviderResolverState(root).resolve
}

func newCLIProviderResolverState(root string) *cliProviderResolver {
	return &cliProviderResolver{root: strings.TrimSpace(root)}
}

// bindInput resolves and freezes the selected provider before the Ledger
// accepts a run. LoadRuntime returns the provider's secret-bearing runtime
// configuration, while the Ledger encrypts the resulting binding at rest.
func (r *cliProviderResolver) bindInput(request *runharness.AgentInputRequest) error {
	if r == nil {
		return errors.New("AI provider resolver is unavailable")
	}
	if request == nil {
		return errors.New("agent input is required")
	}
	store := aiservice.NewProviderConfigStore(r.root, nil)
	snapshot, err := store.LoadRuntime()
	if err != nil {
		return fmt.Errorf("load AI provider configuration: %w", err)
	}
	selected, err := selectCLIProvider(snapshot, request.Provider)
	if err != nil {
		return err
	}
	if value := strings.TrimSpace(request.Model); value != "" {
		selected.Model = value
	}
	if value := strings.TrimSpace(request.Thinking); value != "" {
		selected.ThinkingIntensity = value
	}
	if request.Temperature != nil {
		selected.Temperature = *request.Temperature
	}
	if request.MaxTokens != nil {
		selected.MaxTokens = *request.MaxTokens
	}
	selected = cloneCLIProviderConfig(selected)
	binding, err := runharness.NewProviderBinding(selected.ID, selected)
	if err != nil {
		return fmt.Errorf("bind agent provider: %w", err)
	}
	if err := request.SetProviderBinding(binding); err != nil {
		return fmt.Errorf("attach agent provider binding: %w", err)
	}
	return nil
}

func (r *cliProviderResolver) resolve(ctx context.Context, request runharness.ModelTurnRequest) (provider.Provider, error) {
	if r == nil {
		return nil, errors.New("AI provider resolver is unavailable")
	}
	if ctx == nil {
		return nil, runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if request.ProviderBinding == nil {
		return nil, runharness.ErrProviderBindingUnbound
	}
	binding, err := request.ProviderBinding.Validate()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", runharness.ErrProviderBindingCorrupt, err)
	}
	if requestedID := strings.TrimSpace(request.Provider); requestedID == "" || !strings.EqualFold(requestedID, binding.ProviderID) {
		return nil, fmt.Errorf("%w: model request provider %q does not match binding %q", runharness.ErrProviderBindingCorrupt, request.Provider, binding.ProviderID)
	}
	var selected ai.ProviderConfig
	if err := json.Unmarshal(binding.Config, &selected); err != nil {
		return nil, fmt.Errorf("%w: decode provider config: %v", runharness.ErrProviderBindingCorrupt, err)
	}
	selected.ID = strings.TrimSpace(selected.ID)
	if selected.ID == "" || selected.ID != binding.ProviderID {
		return nil, fmt.Errorf("%w: provider config ID %q does not match binding %q", runharness.ErrProviderBindingCorrupt, selected.ID, binding.ProviderID)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	instance, err := newCLIProviderInstance(selected)
	if err != nil {
		return nil, fmt.Errorf("initialize AI provider %q: %w", selected.ID, err)
	}
	return instance, nil
}

func cloneCLIProviderConfig(config ai.ProviderConfig) ai.ProviderConfig {
	clone := config
	clone.Models = append([]string(nil), config.Models...)
	clone.DisabledModels = append([]string(nil), config.DisabledModels...)
	clone.CustomModels = append([]string(nil), config.CustomModels...)
	if config.Headers != nil {
		clone.Headers = make(map[string]string, len(config.Headers))
		for key, value := range config.Headers {
			clone.Headers[key] = value
		}
	}
	return clone
}

func selectCLIProvider(snapshot aiservice.ProviderConfigStoreSnapshot, requested string) (ai.ProviderConfig, error) {
	requested = strings.TrimSpace(requested)
	if len(snapshot.Providers) == 0 {
		if requested != "" {
			return ai.ProviderConfig{}, fmt.Errorf("AI provider %q is not configured", requested)
		}
		return ai.ProviderConfig{}, errors.New("no AI provider is configured")
	}
	if requested != "" {
		for _, candidate := range snapshot.Providers {
			if candidate.ID == requested || strings.EqualFold(candidate.ID, requested) || strings.EqualFold(strings.TrimSpace(candidate.Name), requested) {
				return candidate, nil
			}
		}
		return ai.ProviderConfig{}, fmt.Errorf("AI provider %q is not configured", requested)
	}
	active := strings.TrimSpace(snapshot.ActiveProvider)
	if active != "" {
		for _, candidate := range snapshot.Providers {
			if candidate.ID == active || strings.EqualFold(candidate.ID, active) || strings.EqualFold(strings.TrimSpace(candidate.Name), active) {
				return candidate, nil
			}
		}
	}
	return snapshot.Providers[0], nil
}

// newCLIAgentToolCatalog returns the same complete audited catalog used by the
// desktop harness. Tool calls carry only saved connection IDs; the catalog
// resolves credentials inside the Go backend, while workspace inspection only
// reads the snapshot bound to the current run.
func newCLIAgentToolCatalog(backend mcpserver.Backend, mcpService *aiservice.Service) runharness.ToolCatalog {
	return mcpserver.NewCompositeToolCatalog(
		mcpserver.NewAgentToolCatalogWithDynamicSource(
			backend,
			mcpserver.NewServiceMCPSource(mcpService),
		),
		mcpserver.NewWorkspaceSnapshotToolCatalog(),
	)
}

// cliAgentApprovalHandler is intentionally non-interactive when stdin is not
// a character device. In that mode the harness persists an approval and the
// caller can use `gonavi agent approve` from a separate invocation.
type cliAgentApprovalHandler struct {
	openTTY func() (io.ReadWriteCloser, error)
	stdin   func() io.Reader
	stderr  io.Writer
	tty     func(io.Reader) bool
}

func newCLIAgentApprovalHandler() runharness.ApprovalHandler {
	return &cliAgentApprovalHandler{
		openTTY: openCLIAgentTTY,
		stdin:   currentAgentStdin,
		stderr:  os.Stderr,
		tty:     readerIsTTY,
	}
}

func (h *cliAgentApprovalHandler) Request(ctx context.Context, request runharness.ApprovalRequest) (runharness.ApprovalDecision, error) {
	if h == nil {
		return runharness.ApprovalDecision{}, runharness.ErrApprovalPending
	}
	if ctx == nil {
		return runharness.ApprovalDecision{}, runharness.ErrRootContextRequired
	}
	// A canceled worker must not turn into a pending approval merely because
	// it is running without a TTY. Return the lifecycle error before checking
	// interactivity so shutdown/SIGINT can complete the durable cancellation.
	if err := ctx.Err(); err != nil {
		return runharness.ApprovalDecision{}, err
	}
	input := io.Reader(nil)
	if h.stdin != nil {
		input = h.stdin()
	}
	if h.tty == nil || !h.tty(input) {
		return runharness.ApprovalDecision{}, runharness.ErrApprovalPending
	}
	if h.openTTY == nil {
		return runharness.ApprovalDecision{}, runharness.ErrApprovalPending
	}
	tty, err := h.openTTY()
	if err != nil || tty == nil {
		return runharness.ApprovalDecision{}, runharness.ErrApprovalPending
	}
	defer tty.Close()
	output := h.stderr
	if output == nil {
		output = io.Discard
	}
	fmt.Fprintf(output, "Agent approval required\nrun: %s\ncall: %s\napproval: %s\ntool: %s\neffect: %s\nargs-hash: %s\nApprove? [y/N] ", request.RunID, request.CallID, request.ApprovalID, request.ToolName, request.Effect, request.ArgsHash)

	reader := bufio.NewReader(tty)
	for {
		lineCh := make(chan string, 1)
		errCh := make(chan error, 1)
		go func() {
			line, readErr := reader.ReadString('\n')
			if readErr != nil && len(line) == 0 {
				errCh <- readErr
				return
			}
			lineCh <- line
		}()
		select {
		case <-ctx.Done():
			return runharness.ApprovalDecision{}, ctx.Err()
		case err := <-errCh:
			if errors.Is(err, io.EOF) {
				return runharness.ApprovalDecision{}, runharness.ErrApprovalPending
			}
			return runharness.ApprovalDecision{}, err
		case line := <-lineCh:
			switch strings.ToLower(strings.TrimSpace(line)) {
			case "y", "yes":
				return runharness.ApprovalDecision{ApprovalID: request.ApprovalID, Decision: "approved"}, nil
			case "", "n", "no":
				return runharness.ApprovalDecision{ApprovalID: request.ApprovalID, Decision: "denied"}, nil
			default:
				fmt.Fprint(output, "Please answer y or n: ")
			}
		}
	}
}

func openCLIAgentTTY() (io.ReadWriteCloser, error) {
	return os.OpenFile("/dev/tty", os.O_RDWR, 0)
}

func readerIsTTY(reader io.Reader) bool {
	file, ok := reader.(*os.File)
	if !ok || file == nil {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

var _ runharness.ProviderResolver = newCLIProviderResolver("")
var _ runharness.ToolCatalog = newCLIAgentToolCatalog(nil, nil)
var _ runharness.ApprovalHandler = (*cliAgentApprovalHandler)(nil)
