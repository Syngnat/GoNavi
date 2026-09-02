package runharness

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

var (
	// ErrToolDescriptorMismatch is returned when the live executor no longer
	// implements the descriptor that was frozen for a run. Executing in that
	// situation would make approval and schema validation refer to different
	// contracts, so the call is always fenced.
	ErrToolDescriptorMismatch = errors.New("agent tool descriptor mismatch")
	// ErrToolCatalogUnbound identifies legacy/low-level runs that predate a
	// frozen catalog. The worker may choose a compatibility policy, but it must
	// never silently treat a mutable live catalog as the run contract.
	ErrToolCatalogUnbound = errors.New("agent tool catalog is unbound")
	// ErrToolCatalogBindingCorrupt means the encrypted binding and its indexed
	// metadata disagree (or one side is missing).  The descriptor payload is
	// sensitive and encrypted, while hash/revision are intentionally plaintext
	// lookup fields; validating both sides prevents a tampered index from being
	// accepted as the run contract.
	ErrToolCatalogBindingCorrupt = errors.New("agent tool catalog binding is corrupt")
)

func isToolCatalogContractError(err error) bool {
	return errors.Is(err, ErrToolDescriptorMismatch) ||
		errors.Is(err, ErrToolCatalogUnbound) ||
		errors.Is(err, ErrToolCatalogBindingCorrupt) ||
		errors.Is(err, ErrToolNotFound)
}

func toolCatalogErrorCode(err error) string {
	if errors.Is(err, ErrToolDescriptorMismatch) {
		return "tool_contract_mismatch"
	}
	if errors.Is(err, ErrToolCatalogUnbound) {
		return "tool_catalog_unbound"
	}
	if errors.Is(err, ErrToolCatalogBindingCorrupt) {
		return "tool_catalog_corrupt"
	}
	return "tool_catalog"
}

// ToolCatalogRevisioner is an optional extension implemented by catalogs that
// expose a monotonic revision. ToolCatalog itself intentionally remains small
// so existing adapters can be upgraded independently.
type ToolCatalogRevisioner interface {
	Revision(context.Context) (int64, error)
}

// ToolCatalogSnapshotter is an optional atomic catalog extension.  Hosts that
// can produce descriptors and their revision under one read lock should
// implement this interface; FreezeToolCatalog then avoids a List/Revision
// time-of-check gap.  Basic ToolCatalog implementations remain supported and
// are fenced by two revision reads when they expose ToolCatalogRevisioner.
type ToolCatalogSnapshotter interface {
	Snapshot(context.Context) ([]ToolDescriptor, int64, error)
}

// ToolCatalogRevisionerAlt supports catalogs that use the more explicit
// CatalogRevision method. It is kept as a private compatibility seam rather
// than expanding the public ToolCatalog interface.
type toolCatalogRevisionerAlt interface {
	CatalogRevision(context.Context) (int64, error)
}

type toolCatalogSnapshotterAlt interface {
	ListWithRevision(context.Context) ([]ToolDescriptor, int64, error)
}

func readToolCatalogRevision(ctx context.Context, catalog ToolCatalog) (revision int64, supported bool, err error) {
	if revisioner, ok := catalog.(ToolCatalogRevisioner); ok {
		revision, err = revisioner.Revision(ctx)
		supported = true
	} else if revisioner, ok := catalog.(toolCatalogRevisionerAlt); ok {
		revision, err = revisioner.CatalogRevision(ctx)
		supported = true
	}
	if err != nil {
		return 0, supported, err
	}
	if !supported {
		return 0, false, nil
	}
	if revision < 0 {
		return 0, true, errors.New("tool catalog revision cannot be negative")
	}
	// Revision zero is reserved for an unbound run projection.  A catalog that
	// has not materialized a revision yet is treated as revision one, matching
	// the default used by FreezeToolCatalog.
	if revision == 0 {
		revision = 1
	}
	return revision, true, nil
}

// FreezeToolCatalog reads a catalog exactly once and returns a canonical,
// content-addressed binding. Callers must persist the returned binding before
// starting a worker; subsequent catalog changes cannot affect the run.
func FreezeToolCatalog(ctx context.Context, catalog ToolCatalog) (ToolCatalogBinding, error) {
	if ctx == nil {
		return ToolCatalogBinding{}, ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return ToolCatalogBinding{}, err
	}
	if catalog == nil {
		return ToolCatalogBinding{}, ErrToolCatalogUnbound
	}
	if snapshotter, ok := catalog.(ToolCatalogSnapshotter); ok {
		descriptors, revision, err := snapshotter.Snapshot(ctx)
		if err != nil {
			return ToolCatalogBinding{}, err
		}
		if revision < 0 {
			return ToolCatalogBinding{}, errors.New("tool catalog revision cannot be negative")
		}
		if revision == 0 {
			revision = 1
		}
		return NewToolCatalogBinding(descriptors, revision)
	}
	if snapshotter, ok := catalog.(toolCatalogSnapshotterAlt); ok {
		descriptors, revision, err := snapshotter.ListWithRevision(ctx)
		if err != nil {
			return ToolCatalogBinding{}, err
		}
		if revision < 0 {
			return ToolCatalogBinding{}, errors.New("tool catalog revision cannot be negative")
		}
		if revision == 0 {
			revision = 1
		}
		return NewToolCatalogBinding(descriptors, revision)
	}
	// For the small legacy interface, read the revision on both sides of List.
	// If a host reloads while descriptors are being copied, do not persist a
	// mixed descriptor/revision pair; the caller can retry the submission.
	beforeRevision, revisionSupported, err := readToolCatalogRevision(ctx, catalog)
	if err != nil {
		return ToolCatalogBinding{}, err
	}
	descriptors, err := catalog.List(ctx)
	if err != nil {
		return ToolCatalogBinding{}, err
	}
	revision := int64(1)
	if revisionSupported {
		afterRevision, _, revisionErr := readToolCatalogRevision(ctx, catalog)
		if revisionErr != nil {
			return ToolCatalogBinding{}, revisionErr
		}
		if beforeRevision != afterRevision {
			return ToolCatalogBinding{}, fmt.Errorf("%w: catalog revision changed while freezing (%d -> %d)", ErrToolDescriptorMismatch, beforeRevision, afterRevision)
		}
		revision = afterRevision
	}
	return NewToolCatalogBinding(descriptors, revision)
}

// NewToolCatalogBinding canonicalizes descriptors and computes their SHA-256
// hash. It is useful for tests and for hosts that already have a descriptor
// list (FreezeToolCatalog remains the preferred production entry point).
func NewToolCatalogBinding(descriptors []ToolDescriptor, revision int64) (ToolCatalogBinding, error) {
	if revision < 1 {
		return ToolCatalogBinding{}, errors.New("tool catalog revision must be positive")
	}
	canonical, err := canonicalToolDescriptors(descriptors)
	if err != nil {
		return ToolCatalogBinding{}, err
	}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return ToolCatalogBinding{}, fmt.Errorf("encode tool catalog: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return ToolCatalogBinding{
		SchemaVersion: CurrentSchemaVersion,
		Revision:      revision,
		Hash:          hex.EncodeToString(digest[:]),
		Descriptors:   cloneToolDescriptors(canonical),
	}, nil
}

// Validate checks a binding's explicit metadata and recomputes its hash. It
// also returns a canonical copy so callers cannot mutate the persisted
// descriptor slice while executing a run.
func (b ToolCatalogBinding) Validate() (ToolCatalogBinding, error) {
	if b.SchemaVersion == 0 {
		b.SchemaVersion = CurrentSchemaVersion
	}
	if b.SchemaVersion != CurrentSchemaVersion {
		return ToolCatalogBinding{}, fmt.Errorf("unsupported tool catalog schema version %d", b.SchemaVersion)
	}
	if b.Revision < 1 {
		return ToolCatalogBinding{}, errors.New("tool catalog revision must be positive")
	}
	canonical, err := canonicalToolDescriptors(b.Descriptors)
	if err != nil {
		return ToolCatalogBinding{}, err
	}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return ToolCatalogBinding{}, fmt.Errorf("encode tool catalog: %w", err)
	}
	digest := sha256.Sum256(encoded)
	hash := hex.EncodeToString(digest[:])
	if strings.TrimSpace(b.Hash) != "" && !strings.EqualFold(strings.TrimSpace(b.Hash), hash) {
		return ToolCatalogBinding{}, fmt.Errorf("%w: hash does not match descriptors", ErrToolDescriptorMismatch)
	}
	b.Hash = hash
	b.Descriptors = cloneToolDescriptors(canonical)
	return b, nil
}

func canonicalToolDescriptors(descriptors []ToolDescriptor) ([]ToolDescriptor, error) {
	result := make([]ToolDescriptor, 0, len(descriptors))
	seen := make(map[string]struct{}, len(descriptors))
	for index, descriptor := range descriptors {
		descriptor.Name = strings.TrimSpace(descriptor.Name)
		if descriptor.Name == "" {
			return nil, fmt.Errorf("tool descriptor %d has an empty name", index)
		}
		if _, exists := seen[descriptor.Name]; exists {
			return nil, fmt.Errorf("duplicate tool descriptor %q", descriptor.Name)
		}
		seen[descriptor.Name] = struct{}{}
		if !descriptor.Effect.Valid() {
			return nil, fmt.Errorf("tool descriptor %q has invalid effect %q", descriptor.Name, descriptor.Effect)
		}
		if descriptor.DefaultTimeout < 0 {
			return nil, fmt.Errorf("tool descriptor %q has negative timeout", descriptor.Name)
		}
		if descriptor.MaxResultBytes < 0 {
			return nil, fmt.Errorf("tool descriptor %q has negative result limit", descriptor.Name)
		}
		if len(descriptor.InputSchema) > 0 {
			if !json.Valid(descriptor.InputSchema) {
				return nil, fmt.Errorf("tool descriptor %q has invalid input schema", descriptor.Name)
			}
			var schema any
			if err := json.Unmarshal(descriptor.InputSchema, &schema); err != nil {
				return nil, fmt.Errorf("tool descriptor %q has invalid input schema: %w", descriptor.Name, err)
			}
			canonicalSchema, err := json.Marshal(schema)
			if err != nil {
				return nil, fmt.Errorf("tool descriptor %q schema: %w", descriptor.Name, err)
			}
			descriptor.InputSchema = canonicalSchema
		} else {
			descriptor.InputSchema = nil
		}
		capabilities := make([]string, 0, len(descriptor.Capabilities))
		capSeen := make(map[string]struct{}, len(descriptor.Capabilities))
		for _, capability := range descriptor.Capabilities {
			capability = strings.TrimSpace(capability)
			if capability == "" {
				continue
			}
			if _, exists := capSeen[capability]; exists {
				continue
			}
			capSeen[capability] = struct{}{}
			capabilities = append(capabilities, capability)
		}
		sort.Strings(capabilities)
		descriptor.Capabilities = capabilities
		result = append(result, descriptor)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func cloneToolDescriptors(descriptors []ToolDescriptor) []ToolDescriptor {
	if len(descriptors) == 0 {
		return []ToolDescriptor{}
	}
	result := make([]ToolDescriptor, len(descriptors))
	for index, descriptor := range descriptors {
		result[index] = descriptor
		result[index].InputSchema = cloneRaw(descriptor.InputSchema)
		result[index].Capabilities = append([]string(nil), descriptor.Capabilities...)
	}
	return result
}

// ToolDescriptorEqual compares the complete executable contract after
// canonicalization, including effect, limits and capabilities.
func ToolDescriptorEqual(left, right ToolDescriptor) bool {
	leftList, leftErr := canonicalToolDescriptors([]ToolDescriptor{left})
	rightList, rightErr := canonicalToolDescriptors([]ToolDescriptor{right})
	if leftErr != nil || rightErr != nil {
		return false
	}
	leftJSON, _ := json.Marshal(leftList[0])
	rightJSON, _ := json.Marshal(rightList[0])
	return string(leftJSON) == string(rightJSON)
}

func findToolDescriptor(descriptors []ToolDescriptor, name string) (ToolDescriptor, bool) {
	name = strings.TrimSpace(name)
	for _, descriptor := range descriptors {
		if descriptor.Name == name {
			return descriptor, true
		}
	}
	return ToolDescriptor{}, false
}

// refineToolEffect applies an effect discovered from validated arguments to a
// descriptor's conservative baseline. Dynamic resolvers (for example the SQL
// inspector) are allowed to narrow side_effect_unknown when they can prove a
// read-only operation, while an explicitly side-effecting descriptor can never
// be downgraded by an untrusted resolver result. Safe descriptors may be
// strengthened when a resolver detects a mutation.
func refineToolEffect(declared, resolved ToolEffect) ToolEffect {
	if !resolved.Valid() {
		return declared
	}
	if !declared.Valid() {
		return resolved
	}
	switch declared {
	case ToolEffectSideEffectUnknown:
		// Unknown is intentionally conservative, but a validated resolver is the
		// component that owns the argument-dependent classification. Preserve its
		// result so SELECT can avoid an unnecessary approval while INSERT remains
		// side-effecting.
		return resolved
	case ToolEffectSideEffect:
		// Never allow a resolver to bypass approval for a descriptor declared as a
		// definite side effect.
		return ToolEffectSideEffect
	case ToolEffectIdempotent:
		if resolved == ToolEffectSideEffect || resolved == ToolEffectSideEffectUnknown {
			return resolved
		}
		return ToolEffectIdempotent
	case ToolEffectReadOnly:
		if resolved == ToolEffectSideEffect || resolved == ToolEffectSideEffectUnknown {
			return resolved
		}
		return ToolEffectReadOnly
	case ToolEffectPure:
		if resolved == ToolEffectSideEffect || resolved == ToolEffectSideEffectUnknown {
			return resolved
		}
		return ToolEffectPure
	default:
		return declared
	}
}

// toolDescriptorsForRun returns the immutable descriptor projection captured
// when the run was accepted. It intentionally does not call ToolCatalog.List:
// a catalog may be hot-reloaded while a run is in flight, but changing the
// provider contract mid-run would make already generated tool calls and
// approvals ambiguous. Runs created without a catalog (for example a
// text-only harness) continue to receive an empty tool projection; a run that
// claims to have tools while its catalog binding is missing is fenced.
func (h *AgentRunHarness) toolDescriptorsForRun(ctx context.Context, run RunSnapshot) ([]ToolDescriptor, error) {
	if !run.AllowTools || h == nil || h.tools == nil {
		return nil, nil
	}
	binding, err := h.ledger.GetToolCatalogBinding(ctx, run.ID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(run.ToolCatalogHash) != "" &&
		!strings.EqualFold(strings.TrimSpace(run.ToolCatalogHash), binding.Hash) {
		return nil, fmt.Errorf("%w: run hash %q, binding hash %q", ErrToolDescriptorMismatch, run.ToolCatalogHash, binding.Hash)
	}
	if run.ToolCatalogRevision != 0 && run.ToolCatalogRevision != binding.Revision {
		return nil, fmt.Errorf("%w: run revision %d, binding revision %d", ErrToolDescriptorMismatch, run.ToolCatalogRevision, binding.Revision)
	}
	return cloneToolDescriptors(binding.Descriptors), nil
}

// resolveToolForRun resolves only the executable implementation from the live
// catalog, while returning the descriptor frozen for this run. The live
// descriptor is compared before execution so a hot-reloaded schema/effect,
// capability, timeout, or result limit cannot bypass the contract used for
// model projection and approval.
func (h *AgentRunHarness) resolveToolForRun(ctx context.Context, run RunSnapshot, name string) (ToolDescriptor, ToolExecutor, error) {
	descriptors, err := h.toolDescriptorsForRun(ctx, run)
	if err != nil {
		return ToolDescriptor{}, nil, err
	}
	return h.resolveToolForRunWithDescriptors(ctx, run, descriptors, name)
}

// resolveToolForRunWithDescriptors is the execution-side catalog fence. The
// descriptor list is supplied by the worker that loaded the run boundary, so
// this method never re-reads a mutable catalog projection. Resolve is used only
// to obtain the current executable; its descriptor must still match the frozen
// contract byte-for-byte after canonicalization.
func (h *AgentRunHarness) resolveToolForRunWithDescriptors(ctx context.Context, run RunSnapshot, descriptors []ToolDescriptor, name string) (ToolDescriptor, ToolExecutor, error) {
	if h == nil || h.tools == nil {
		return ToolDescriptor{}, nil, ErrToolNotFound
	}
	frozen, ok := findToolDescriptor(descriptors, name)
	if !ok {
		return ToolDescriptor{}, nil, fmt.Errorf("%w: %s", ErrToolNotFound, strings.TrimSpace(name))
	}
	// A revision is stronger than a per-tool descriptor comparison: a catalog
	// may reload an unrelated tool (or swap executor wiring) while leaving this
	// descriptor byte-for-byte identical.  Check before and after Resolve so a
	// non-atomic host cannot hand us an executor from a different catalog epoch.
	expectedRevision := run.ToolCatalogRevision
	beforeRevision, revisionSupported, err := readToolCatalogRevision(ctx, h.tools)
	if err != nil {
		return ToolDescriptor{}, nil, err
	}
	live, executor, err := h.tools.Resolve(ctx, strings.TrimSpace(name))
	if err != nil {
		return ToolDescriptor{}, nil, err
	}
	if executor == nil {
		return ToolDescriptor{}, nil, ErrToolNotFound
	}
	if revisionSupported {
		afterRevision, _, revisionErr := readToolCatalogRevision(ctx, h.tools)
		if revisionErr != nil {
			return ToolDescriptor{}, nil, revisionErr
		}
		if beforeRevision != afterRevision || (expectedRevision > 0 && (beforeRevision != expectedRevision || afterRevision != expectedRevision)) {
			return ToolDescriptor{}, nil, fmt.Errorf("%w: catalog revision changed while resolving (%d -> %d, run revision %d)", ErrToolDescriptorMismatch, beforeRevision, afterRevision, expectedRevision)
		}
	}
	if !ToolDescriptorEqual(frozen, live) {
		return ToolDescriptor{}, nil, fmt.Errorf("%w: %s", ErrToolDescriptorMismatch, frozen.Name)
	}
	return frozen, executor, nil
}

// validateToolForRun performs the same live-contract fence as
// resolveToolForRun without exposing an executor to callers that are only
// preparing an approval. Keeping this check before approval means the user is
// never asked to approve a call whose executable contract has already drifted.
func (h *AgentRunHarness) validateToolForRun(ctx context.Context, run RunSnapshot, name string) (ToolDescriptor, error) {
	descriptor, _, err := h.resolveToolForRun(ctx, run, name)
	return descriptor, err
}

func (h *AgentRunHarness) validateToolForRunWithDescriptors(ctx context.Context, run RunSnapshot, descriptors []ToolDescriptor, name string) (ToolDescriptor, error) {
	descriptor, _, err := h.resolveToolForRunWithDescriptors(ctx, run, descriptors, name)
	return descriptor, err
}
