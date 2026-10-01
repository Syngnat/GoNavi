package aiservice

import (
	"os"
	"strconv"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
)

func TestAutoApprovalDefaultsToAskingEveryTime(t *testing.T) {
	var state autoApprovalState
	dir := t.TempDir()

	if state.allows(dir, "session-1") {
		t.Fatal("nothing is granted by default")
	}
	if settings := state.snapshot(dir); settings.Global || len(settings.SessionIDs) != 0 || settings.SessionIDs == nil {
		t.Fatalf("default settings = %+v, want empty non-nil session list", settings)
	}
}

func TestAutoApprovalSessionGrantCoversOnlyThatSession(t *testing.T) {
	var state autoApprovalState
	dir := t.TempDir()

	if _, err := state.update(dir, func(settings *AutoApprovalSettings) {
		settings.SessionIDs = append(settings.SessionIDs, " session-1 ")
	}); err != nil {
		t.Fatal(err)
	}

	if !state.allows(dir, "session-1") {
		t.Fatal("granted session must be auto-approved")
	}
	if state.allows(dir, "session-2") || state.allows(dir, "") {
		t.Fatal("other or unknown sessions must still ask")
	}
}

func TestAutoApprovalGlobalGrantCoversEverySession(t *testing.T) {
	var state autoApprovalState
	dir := t.TempDir()

	if _, err := state.update(dir, func(settings *AutoApprovalSettings) { settings.Global = true }); err != nil {
		t.Fatal(err)
	}
	if !state.allows(dir, "any-session") || !state.allows(dir, "") {
		t.Fatal("global grant must cover every session")
	}
}

func TestAutoApprovalSurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	var first autoApprovalState
	if _, err := first.update(dir, func(settings *AutoApprovalSettings) {
		settings.Global = true
		settings.SessionIDs = []string{"session-1"}
	}); err != nil {
		t.Fatal(err)
	}

	var restarted autoApprovalState
	settings := restarted.snapshot(dir)
	if !settings.Global || len(settings.SessionIDs) != 1 || settings.SessionIDs[0] != "session-1" {
		t.Fatalf("restored settings = %+v", settings)
	}
	info, err := os.Stat(autoApprovalPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("settings file mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestAutoApprovalPicksUpChangesMadeByAnotherProcess(t *testing.T) {
	dir := t.TempDir()
	var state autoApprovalState
	if state.allows(dir, "session-1") {
		t.Fatal("precondition: nothing granted")
	}

	if err := os.WriteFile(autoApprovalPath(dir), []byte(`{"global":false,"sessionIds":["session-1"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(autoApprovalPath(dir), future, future); err != nil {
		t.Fatal(err)
	}

	if !state.allows(dir, "session-1") {
		t.Fatal("a grant written by another process must be honoured")
	}
}

func TestAutoApprovalTreatsAnUnreadableFileAsNoGrant(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(autoApprovalPath(dir), []byte(`{not json`), 0o600); err != nil {
		t.Fatal(err)
	}
	var state autoApprovalState

	if state.allows(dir, "session-1") {
		t.Fatal("a corrupt file must never widen what runs without asking")
	}
	if _, err := state.update(dir, func(settings *AutoApprovalSettings) { settings.Global = true }); err != nil {
		t.Fatalf("a corrupt file must be replaceable: %v", err)
	}
	if !state.allows(dir, "session-1") {
		t.Fatal("grant written over the corrupt file must apply")
	}
}

func TestAutoApprovalKeepsTheNewestSessionsWithinTheCap(t *testing.T) {
	dir := t.TempDir()
	var state autoApprovalState
	ids := make([]string, 0, maxAutoApprovalSessions+5)
	for i := 0; i < maxAutoApprovalSessions+5; i++ {
		ids = append(ids, "session-"+strconv.Itoa(i))
	}
	ids = append(ids, "session-0", " ")

	settings, err := state.update(dir, func(next *AutoApprovalSettings) { next.SessionIDs = ids })
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.SessionIDs) != maxAutoApprovalSessions {
		t.Fatalf("kept %d sessions, want %d", len(settings.SessionIDs), maxAutoApprovalSessions)
	}
	// session-0 was listed twice; the duplicate collapses and the oldest
	// entries fall off first once the cap is exceeded.
	if state.allows(dir, "session-0") {
		t.Fatal("the oldest grant should have fallen off once the cap was exceeded")
	}
	if !state.allows(dir, "session-"+strconv.Itoa(maxAutoApprovalSessions+4)) {
		t.Fatal("the newest grant must be kept")
	}
}

func TestServiceAutoApprovalMethodsRoundTrip(t *testing.T) {
	svc := &Service{configDir: t.TempDir()}

	if _, err := svc.AISetSessionAutoApproval("  ", true); err == nil {
		t.Fatal("an empty session id must be rejected")
	}
	settings, err := svc.AISetSessionAutoApproval("session-1", true)
	if err != nil || len(settings.SessionIDs) != 1 {
		t.Fatalf("grant session: %+v, %v", settings, err)
	}
	if settings, err = svc.AISetSessionAutoApproval("session-1", true); err != nil || len(settings.SessionIDs) != 1 {
		t.Fatalf("granting twice must stay idempotent: %+v, %v", settings, err)
	}
	if settings, err = svc.AISetGlobalAutoApproval(true); err != nil || !settings.Global {
		t.Fatalf("global grant: %+v, %v", settings, err)
	}
	if settings, err = svc.AIClearSessionAutoApprovals(); err != nil || len(settings.SessionIDs) != 0 || !settings.Global {
		t.Fatalf("clearing sessions must keep the global switch: %+v, %v", settings, err)
	}
	if settings, err = svc.AISetGlobalAutoApproval(false); err != nil || settings.Global {
		t.Fatalf("global revoke: %+v, %v", settings, err)
	}

	policy := serviceAutoApprovalPolicy{service: svc}
	if policy.AutoApprove(nil, runharnessRequest("session-1")) {
		t.Fatal("nothing is granted any more")
	}
}

func runharnessRequest(sessionID string) runharness.AutoApprovalRequest {
	return runharness.AutoApprovalRequest{SessionID: sessionID, ToolName: "execute_sql", Effect: runharness.ToolEffectSideEffect}
}
