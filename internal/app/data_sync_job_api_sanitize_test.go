package app

import (
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/syncjob"
)

func TestPublicDataSyncRunStripsBackendApprovalAndFingerprints(t *testing.T) {
	definition := approvalTestDefinition()
	definition.Source.Fingerprint = "source-secret-derived-proof"
	definition.Target.Fingerprint = "target-secret-derived-proof"
	definition.Approval = &syncjob.ExecutionApproval{
		DefinitionHash: "approval-hash", TargetFingerprint: "target-secret-derived-proof", ApprovedAt: 1, ApprovedByRuntime: "desktop",
	}
	snapshot, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	public := publicDataSyncRun(syncjob.RunRecord{
		DefinitionSnapshot: snapshot,
		SourceFingerprint:  definition.Source.Fingerprint,
		TargetFingerprint:  definition.Target.Fingerprint,
	})
	encoded, err := json.Marshal(public)
	if err != nil {
		t.Fatalf("marshal public run: %v", err)
	}
	text := string(encoded)
	for _, forbidden := range []string{"source-secret-derived-proof", "target-secret-derived-proof", "approval-hash", "approvedByRuntime"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("public run leaked %q: %s", forbidden, text)
		}
	}
}

func TestPublicDataSyncRunEventScrubsLegacyErrorPayload(t *testing.T) {
	event := publicDataSyncRunEvent(syncjob.RunEvent{
		Type:    syncjob.RunEventErrorRow,
		Payload: json.RawMessage(`{"id":"error-1","sourceKey":{"email":"private@example.com"},"payload":{"secret":"raw"},"payloadHash":"safe"}`),
	})
	text := string(event.Payload)
	if strings.Contains(text, "private@example.com") || strings.Contains(text, "\"secret\"") || !strings.Contains(text, "payloadHash") {
		t.Fatalf("sanitized legacy error event = %s", text)
	}
}
