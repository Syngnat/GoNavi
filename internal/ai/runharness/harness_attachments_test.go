package runharness

import (
	"context"
	"strings"
	"testing"
)

// submitWithAttachments runs one input through the whole Harness and returns the
// request the provider actually received, which is where an attachment that is not
// forwarded goes missing. A nil binding runs without a provider contract.
func submitWithAttachments(t *testing.T, binding map[string]any, content string, attachments []Attachment) (ModelTurnRequest, *Ledger, string) {
	t.Helper()
	model := &contextHarnessModel{result: ModelTurnResult{Text: "ok", Completed: true}}
	harness, ledger := newContextBuilderHarness(t, model, nil, nil)
	input := AgentInputRequest{RequestID: "attachments-request", Content: content, Attachments: attachments}
	if binding != nil {
		bound, err := NewProviderBinding("provider-a", binding)
		if err != nil {
			t.Fatal(err)
		}
		if err := input.SetProviderBinding(bound); err != nil {
			t.Fatal(err)
		}
	}
	receipt, err := harness.SubmitInput(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() }); read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s", read.Run.State)
	}
	request, ok := model.latestRequest()
	if !ok || len(request.Messages) == 0 {
		t.Fatal("the provider was not called")
	}
	return request, ledger, receipt.SessionID
}

func TestAttachedFilesAndRecognizedTextReachTheProviderThroughTheWholeRun(t *testing.T) {
	request, ledger, sessionID := submitWithAttachments(t, nil, "what does this error mean?", []Attachment{
		{Name: "schema.md", MediaType: "text/markdown", Data: "orders(id, customer_id, created_at)"},
		{Name: "error.png", MediaType: OCRTextMediaType, Data: "ERROR 1146: Table 'shop.order' doesn't exist"},
	})
	content := request.Messages[len(request.Messages)-1].Content
	for _, want := range []string{"what does this error mean?", "orders(id, customer_id, created_at)", "ERROR 1146", "schema.md"} {
		if !strings.Contains(content, want) {
			t.Errorf("the provider's message lacks %q:\n%s", want, content)
		}
	}
	// What is stored stays what the person typed, with its attachments next to it.
	session, err := ledger.GetSession(context.Background(), sessionID, true)
	if err != nil {
		t.Fatal(err)
	}
	var stored Message
	for _, message := range session.Messages {
		if message.Role == "user" {
			stored = message
		}
	}
	if stored.Content != "what does this error mean?" || len(stored.Attachments) != 2 {
		t.Fatalf("stored message = %q with %d attachments", stored.Content, len(stored.Attachments))
	}
}

func TestAProviderThatDeclaresNoImageSupportGetsRecognizedTextInstead(t *testing.T) {
	request, _, _ := submitWithAttachments(t, map[string]any{"id": "provider-a", "supportsImages": false}, "explain", []Attachment{
		{Name: "shot.png", MediaType: "image/png", Data: pixel},
		{Name: "shot.png", MediaType: OCRTextMediaType, Data: "SELECT COUNT(*) FROM orders"},
	})
	last := request.Messages[len(request.Messages)-1]
	if len(last.Images) != 0 {
		t.Fatalf("an image reached a model that cannot see it: %d", len(last.Images))
	}
	if !strings.Contains(last.Content, "SELECT COUNT(*) FROM orders") || strings.Contains(last.Content, "cannot see images") {
		t.Fatalf("content:\n%s", last.Content)
	}
}

func TestAProviderThatCanSeeImagesGetsThem(t *testing.T) {
	for name, binding := range map[string]map[string]any{
		"no declaration":   {"id": "provider-a"},
		"declared support": {"id": "provider-a", "supportsImages": true},
	} {
		request, _, _ := submitWithAttachments(t, binding, "what is in this picture?", []Attachment{{Name: "shot.png", MediaType: "image/png", Data: pixel}})
		last := request.Messages[len(request.Messages)-1]
		if len(last.Images) != 1 || last.Images[0] != pixel {
			t.Errorf("%s: images = %v", name, last.Images)
		}
	}
}

func TestProviderOmitsImagesReadsOnlyAnExplicitNo(t *testing.T) {
	for name, tc := range map[string]struct {
		config string
		want   bool
	}{
		"explicit no":  {`{"supportsImages":false}`, true},
		"explicit yes": {`{"supportsImages":true}`, false},
		"not declared": {`{"id":"p"}`, false},
		"wrong type":   {`{"supportsImages":"no"}`, false},
		"other fields": {`{"contextWindow":8,"maxTokens":2}`, false},
	} {
		binding := ProviderBinding{ProviderID: "p", Config: []byte(tc.config)}
		if got := providerOmitsImages(binding); got != tc.want {
			t.Errorf("%s: providerOmitsImages = %v, want %v", name, got, tc.want)
		}
	}
	if providerOmitsImages(ProviderBinding{}) {
		t.Error("an invalid binding must not change how images are sent")
	}
}
