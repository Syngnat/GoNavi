package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// ErrContextLimit means the required workspace context or newest durable
// message cannot fit in the configured provider projection. Callers must not
// submit a request known to omit that newest message.
var ErrContextLimit = errors.New("agent context exceeds configured limit")

// ContextBuilder produces the provider-facing projection of a durable agent
// transcript. It never changes the ledger transcript: any trimming is limited
// to the request sent to a model provider.
type ContextBuilder interface {
	Build(context.Context, ContextBuildRequest) (ContextBuildResult, error)
}

// ContextBuildRequest contains all durable inputs needed to build one model
// turn. WorkspaceSnapshot and WorkspaceReference are intentionally separate:
// the former is prompt context, while the latter is the auditable identity of
// the snapshot actually supplied to the builder.
type ContextBuildRequest struct {
	Run                RunSnapshot
	Messages           []Message
	Tools              []ToolDescriptor
	WorkspaceSnapshot  *WorkspaceSnapshot
	WorkspaceReference *WorkspaceSnapshotReference
	ConversationCursor string
	ProviderState      json.RawMessage
}

// ContextBuildResult contains both the full immutable transcript and the
// potentially smaller provider projection. Consumers must keep Transcript for
// ledger/audit use; only Request.Messages is allowed to omit earlier messages.
type ContextBuildResult struct {
	Request     ModelTurnRequest           `json:"request"`
	Transcript  []Message                  `json:"transcript"`
	Compression ContextCompressionMetadata `json:"compression"`
}

// ContextCompressionMetadata explains exactly how a provider projection was
// derived. It deliberately records durable message IDs/sequences instead of
// model-generated summaries, so a later summary/checkpoint implementation can
// retain a trustworthy source cursor.
type ContextCompressionMetadata struct {
	Applied bool `json:"applied"`

	// Limits are zero when no corresponding limit is configured.
	MaxBytes  int `json:"maxBytes,omitempty"`
	MaxTokens int `json:"maxTokens,omitempty"`

	// ProviderBytes and ProviderTokens include the synthetic workspace system
	// message when one is present. TranscriptBytes/Tokens describe only durable
	// ledger messages.
	ProviderBytes     int                         `json:"providerBytes"`
	ProviderTokens    int                         `json:"providerTokens"`
	TranscriptBytes   int                         `json:"transcriptBytes"`
	TranscriptTokens  int                         `json:"transcriptTokens"`
	WorkspaceIncluded bool                        `json:"workspaceIncluded"`
	Workspace         *WorkspaceSnapshotReference `json:"workspace,omitempty"`

	// Omitted bounds describe durable transcript entries that were omitted from
	// the provider request. Retained bounds cover the durable part of the
	// request and do not include the synthetic workspace message.
	OmittedMessageCount      int    `json:"omittedMessageCount"`
	OmittedFromMessageID     string `json:"omittedFromMessageId,omitempty"`
	OmittedFromSequence      int64  `json:"omittedFromSequence,omitempty"`
	OmittedThroughMessageID  string `json:"omittedThroughMessageId,omitempty"`
	OmittedThroughSequence   int64  `json:"omittedThroughSequence,omitempty"`
	RetainedFromMessageID    string `json:"retainedFromMessageId,omitempty"`
	RetainedFromSequence     int64  `json:"retainedFromSequence,omitempty"`
	RetainedThroughMessageID string `json:"retainedThroughMessageId,omitempty"`
	RetainedThroughSequence  int64  `json:"retainedThroughSequence,omitempty"`
}

// TokenEstimator estimates provider token use for a message. The builder does
// not require a provider-specific tokenizer: callers may inject one once the
// selected model is known. A nil estimator deterministically uses bytes.
type TokenEstimator func(Message) int

// DeterministicContextBuilder is the default context builder. It preserves the
// newest whole messages that fit both configured limits. A limit of zero is
// disabled. Messages are never partially cut because partial assistant/tool
// turns can violate provider protocol invariants.
type DeterministicContextBuilder struct {
	MaxBytes       int
	MaxTokens      int
	EstimateTokens TokenEstimator
}

// NewDeterministicContextBuilder returns the default, unbounded projection
// builder. Limits can be supplied directly on the returned value.
func NewDeterministicContextBuilder() *DeterministicContextBuilder {
	return &DeterministicContextBuilder{}
}

// Build creates a deterministic model request. It only validates the inputs
// it needs to safely serialize: nil contexts and negative limits are rejected,
// while an absent workspace remains a valid no-context turn.
func (b *DeterministicContextBuilder) Build(ctx context.Context, input ContextBuildRequest) (ContextBuildResult, error) {
	if ctx == nil {
		return ContextBuildResult{}, ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return ContextBuildResult{}, err
	}
	if b == nil {
		b = NewDeterministicContextBuilder()
	}
	if b.MaxBytes < 0 {
		return ContextBuildResult{}, errors.New("context max bytes cannot be negative")
	}
	if b.MaxTokens < 0 {
		return ContextBuildResult{}, errors.New("context max tokens cannot be negative")
	}

	transcript := cloneContextMessages(input.Messages)
	tools := cloneContextTools(input.Tools)
	workspaceReference := cloneWorkspaceSnapshotReference(input.WorkspaceReference)
	if input.WorkspaceSnapshot != nil {
		derivedReference := workspaceSnapshotReference(*input.WorkspaceSnapshot)
		if workspaceReference == nil {
			workspaceReference = derivedReference
		} else if derivedReference != nil && !sameWorkspaceSnapshotReference(workspaceReference, derivedReference) {
			return ContextBuildResult{}, errors.New("workspace snapshot reference does not match snapshot")
		}
	}

	projection := make([]Message, 0, len(transcript)+1)
	workspaceMessage, hasWorkspace, err := workspaceContextMessage(input.WorkspaceSnapshot, workspaceReference)
	if err != nil {
		return ContextBuildResult{}, err
	}
	if hasWorkspace {
		projection = append(projection, workspaceMessage)
	}

	estimate := b.EstimateTokens
	if estimate == nil {
		estimate = defaultContextTokenEstimate
	}
	transcriptSizes := make([]contextMessageSizeResult, len(transcript))
	transcriptBytes, transcriptTokens := 0, 0
	for index, message := range transcript {
		transcriptSizes[index] = measureContextMessage(message, estimate)
		transcriptBytes += transcriptSizes[index].bytes
		transcriptTokens += transcriptSizes[index].tokens
	}
	baseBytes, baseTokens := 0, 0
	if hasWorkspace {
		workspaceSize := measureContextMessage(workspaceMessage, estimate)
		baseBytes, baseTokens = workspaceSize.bytes, workspaceSize.tokens
	}
	if contextLimitExceeded(baseBytes, baseTokens, b.MaxBytes, b.MaxTokens) {
		return ContextBuildResult{}, fmt.Errorf("%w: workspace context", ErrContextLimit)
	}
	selectedStart := len(transcript)
	projectedBytes, projectedTokens := baseBytes, baseTokens
	for index := len(transcript) - 1; index >= 0; index-- {
		if err := ctx.Err(); err != nil {
			return ContextBuildResult{}, err
		}
		messageBytes := transcriptSizes[index].bytes
		messageTokens := transcriptSizes[index].tokens
		if contextLimitExceeded(projectedBytes+messageBytes, projectedTokens+messageTokens, b.MaxBytes, b.MaxTokens) {
			break
		}
		selectedStart = index
		projectedBytes += messageBytes
		projectedTokens += messageTokens
	}
	if len(transcript) > 0 && selectedStart == len(transcript) {
		return ContextBuildResult{}, fmt.Errorf("%w: newest durable message", ErrContextLimit)
	}
	projection = append(projection, cloneContextMessages(transcript[selectedStart:])...)

	metadata := ContextCompressionMetadata{
		Applied:           selectedStart > 0,
		MaxBytes:          b.MaxBytes,
		MaxTokens:         b.MaxTokens,
		ProviderBytes:     projectedBytes,
		ProviderTokens:    projectedTokens,
		TranscriptBytes:   transcriptBytes,
		TranscriptTokens:  transcriptTokens,
		WorkspaceIncluded: hasWorkspace,
		Workspace:         cloneWorkspaceSnapshotReference(workspaceReference),
	}
	populateContextCursor(&metadata, transcript, selectedStart)

	request := ModelTurnRequest{
		RunID:              input.Run.ID,
		SessionID:          input.Run.SessionID,
		Messages:           projection,
		Tools:              tools,
		ConversationCursor: input.ConversationCursor,
		Provider:           input.Run.Provider,
		Model:              input.Run.Model,
		Thinking:           input.Run.Thinking,
		Temperature:        cloneContextFloat(input.Run.Temperature),
		MaxTokens:          cloneContextInt(input.Run.MaxTokens),
		ProviderState:      cloneContextRaw(input.ProviderState),
		Policy:             input.Run.Policy,
	}
	return ContextBuildResult{Request: request, Transcript: transcript, Compression: metadata}, nil
}

func contextLimitExceeded(bytes, tokens, maxBytes, maxTokens int) bool {
	return (maxBytes > 0 && bytes > maxBytes) || (maxTokens > 0 && tokens > maxTokens)
}

func defaultContextTokenEstimate(message Message) int {
	bytes, _ := contextMessageSize(message, nil)
	return bytes
}

func contextMessagesSize(messages []Message, estimate TokenEstimator) (int, int) {
	var bytes, tokens int
	for _, message := range messages {
		size := measureContextMessage(message, estimate)
		bytes += size.bytes
		tokens += size.tokens
	}
	return bytes, tokens
}

type contextMessageSizeResult struct {
	bytes  int
	tokens int
}

func measureContextMessage(message Message, estimate TokenEstimator) contextMessageSizeResult {
	encoded, err := json.Marshal(message)
	if err != nil {
		// Message contains only JSON-serializable fields today. Keep the
		// fallback deterministic in case future fields make that assumption
		// false, rather than silently omitting a limit check.
		encoded = []byte(fmt.Sprintf("%s\x00%s\x00%s", message.Role, message.ToolCallID, message.Content))
	}
	if estimate == nil {
		return contextMessageSizeResult{bytes: len(encoded), tokens: len(encoded)}
	}
	// Estimators are extension points supplied by a provider adapter. Give
	// them an isolated value so an accidental mutation cannot alter the
	// returned transcript or the next projection calculation.
	isolated := cloneContextMessages([]Message{message})[0]
	tokens := estimate(isolated)
	if tokens < 0 {
		tokens = 0
	}
	return contextMessageSizeResult{bytes: len(encoded), tokens: tokens}
}

func contextMessageSize(message Message, estimate TokenEstimator) (int, int) {
	size := measureContextMessage(message, estimate)
	return size.bytes, size.tokens
}

func workspaceContextMessage(snapshot *WorkspaceSnapshot, reference *WorkspaceSnapshotReference) (Message, bool, error) {
	if snapshot == nil {
		return Message{}, false, nil
	}
	// A ContextBuilder must not call Normalize: that method fills clock-based
	// fields and would make the projection non-deterministic. Marshal is stable
	// for structs and encoding/json sorts map keys.
	content, err := json.Marshal(struct {
		Kind      string                      `json:"kind"`
		Snapshot  *WorkspaceSnapshot          `json:"snapshot"`
		Reference *WorkspaceSnapshotReference `json:"reference,omitempty"`
	}{
		Kind: "workspace_snapshot", Snapshot: snapshot,
		Reference: cloneWorkspaceSnapshotReference(reference),
	})
	if err != nil {
		return Message{}, false, fmt.Errorf("marshal workspace context: %w", err)
	}
	metadata, err := json.Marshal(struct {
		Kind      string                      `json:"kind"`
		Reference *WorkspaceSnapshotReference `json:"reference,omitempty"`
	}{Kind: "workspace_snapshot", Reference: cloneWorkspaceSnapshotReference(reference)})
	if err != nil {
		return Message{}, false, fmt.Errorf("marshal workspace context metadata: %w", err)
	}
	return Message{Role: "system", Content: string(content), Metadata: metadata}, true, nil
}

func populateContextCursor(metadata *ContextCompressionMetadata, transcript []Message, selectedStart int) {
	if metadata == nil || len(transcript) == 0 {
		return
	}
	if selectedStart > 0 {
		metadata.OmittedMessageCount = selectedStart
		metadata.OmittedFromMessageID = transcript[0].ID
		metadata.OmittedFromSequence = transcript[0].Sequence
		lastOmitted := transcript[selectedStart-1]
		metadata.OmittedThroughMessageID = lastOmitted.ID
		metadata.OmittedThroughSequence = lastOmitted.Sequence
	}
	if selectedStart < len(transcript) {
		firstRetained := transcript[selectedStart]
		lastRetained := transcript[len(transcript)-1]
		metadata.RetainedFromMessageID = firstRetained.ID
		metadata.RetainedFromSequence = firstRetained.Sequence
		metadata.RetainedThroughMessageID = lastRetained.ID
		metadata.RetainedThroughSequence = lastRetained.Sequence
	}
}

func cloneContextMessages(messages []Message) []Message {
	if len(messages) == 0 {
		return nil
	}
	result := make([]Message, len(messages))
	for index, message := range messages {
		result[index] = message
		result[index].Images = append([]string(nil), message.Images...)
		if len(message.Attachments) > 0 {
			result[index].Attachments = append([]Attachment(nil), message.Attachments...)
		}
		result[index].ToolCalls = cloneContextRaw(message.ToolCalls)
		result[index].Metadata = cloneContextRaw(message.Metadata)
	}
	return result
}

func cloneContextTools(tools []ToolDescriptor) []ToolDescriptor {
	if len(tools) == 0 {
		return nil
	}
	result := make([]ToolDescriptor, len(tools))
	for index, tool := range tools {
		result[index] = tool
		result[index].InputSchema = cloneContextRaw(tool.InputSchema)
		result[index].Capabilities = append([]string(nil), tool.Capabilities...)
	}
	return result
}

func cloneContextRaw(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	return append(json.RawMessage(nil), raw...)
}

func cloneContextFloat(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneContextInt(value *int) *int {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
