package deeplink

import (
	"strings"
	"testing"
)

func TestParseAcceptsOnlyTheSignInLinkTheGatewayPageSends(t *testing.T) {
	for raw, want := range map[string]Link{
		"gonavi://ai-login?status=authorized":          {Action: ActionAILogin, Status: "authorized"},
		"gonavi://ai-login?status=invalid_credentials": {Action: ActionAILogin, Status: "invalid_credentials"},
		"GoNavi://AI-Login/?status=rate_limited":       {Action: ActionAILogin, Status: "rate_limited"},
		"  gonavi://ai-login  ":                        {Action: ActionAILogin},
		"gonavi://ai-login?status=":                    {Action: ActionAILogin},
	} {
		got, ok := Parse(raw)
		if !ok || got != want {
			t.Errorf("Parse(%q) = %+v, %v; want %+v", raw, got, ok, want)
		}
	}
}

func TestParseRefusesEverythingElse(t *testing.T) {
	for _, raw := range []string{
		"", "gonavi:", "gonavi://", "gonavi://other-action", "gonavi://ai-login/extra", "gonavi://ai-login/../x",
		"gonavi://user:pass@ai-login", "gonavi://ai-login:8080", "gonavi://evil.example/ai-login",
		"http://ai-login", "https://gonavi://ai-login", "javascript:alert(1)", "file:///c:/windows/system32/calc.exe",
		"gonavi-ai://ai-login", "%00gonavi://ai-login", "gonavi://ai-login%0d%0a",
	} {
		if link, ok := Parse(raw); ok {
			t.Errorf("Parse(%q) accepted: %+v", raw, link)
		}
	}
}

func TestAStatusThatIsNotAPlainWordIsDroppedNotPassedOn(t *testing.T) {
	for _, status := range []string{"Authorized", "1", "a-b", "x y", "<script>", "../../etc", strings.Repeat("a", 33), "%00", "ok;calc"} {
		link, ok := Parse("gonavi://ai-login?status=" + status)
		if !ok || link.Status != "" {
			t.Errorf("status %q: %+v ok=%v (the link is still a knock, the status must be empty)", status, link, ok)
		}
	}
}

func TestFindURLArgFindsTheLinkAmongOtherArguments(t *testing.T) {
	if raw, ok := FindURLArg([]string{"--flag", "GONAVI://ai-login?status=authorized", "x"}); !ok || raw != "GONAVI://ai-login?status=authorized" {
		t.Fatalf("got %q %v", raw, ok)
	}
	// An unrecognized link is still a link: the process it started must hand over and exit.
	if raw, ok := FindURLArg([]string{"gonavi://something-else"}); !ok || raw == "" {
		t.Fatal("an unknown gonavi:// link must be found")
	}
	for _, args := range [][]string{nil, {}, {"--restart"}, {"https://gonavi.example"}, {"gonavi"}, {"xgonavi://ai-login"}} {
		if raw, ok := FindURLArg(args); ok {
			t.Errorf("FindURLArg(%v) = %q, want none", args, raw)
		}
	}
}

// ---- registration (against a fake registry: the real one is never touched) -----------------

type fakeRegistry struct {
	values map[string]string
	writes int
	failOn string
}

func newFakeRegistry() *fakeRegistry { return &fakeRegistry{values: map[string]string{}} }

func (f *fakeRegistry) key(path, name string) string { return path + "|" + name }
func (f *fakeRegistry) Get(path, name string) (string, bool) {
	value, ok := f.values[f.key(path, name)]
	return value, ok
}
func (f *fakeRegistry) Set(path, name, value string) error {
	if f.failOn != "" && strings.HasSuffix(path, f.failOn) {
		return errFake
	}
	f.writes++
	f.values[f.key(path, name)] = value
	return nil
}

var errFake = &fakeError{}

type fakeError struct{}

func (*fakeError) Error() string { return "access denied" }

func TestRegisterWritesTheHandlerForTheCurrentUserAndOnlyWhenItDiffers(t *testing.T) {
	reg := newFakeRegistry()
	exe := `D:\Apps\GoNavi\GoNavi.exe`
	changed, err := register(reg, exe)
	if err != nil || !changed {
		t.Fatalf("first registration: %v %v", changed, err)
	}
	if got, _ := reg.Get(`Software\Classes\gonavi\shell\open\command`, ""); got != `"D:\Apps\GoNavi\GoNavi.exe" "%1"` {
		t.Fatalf("command = %q", got)
	}
	if got, ok := reg.Get(`Software\Classes\gonavi`, "URL Protocol"); !ok || got != "" {
		t.Fatalf("URL Protocol marker missing: %q %v", got, ok)
	}
	// Doing it again is a no-op (it must not rewrite the registry on every sign-in).
	writes := reg.writes
	if changed, err := register(reg, exe); err != nil || changed || reg.writes != writes {
		t.Fatalf("second registration changed things: %v %v writes %d->%d", changed, err, writes, reg.writes)
	}
	// Another build takes over: the link must open the one that asked.
	other := `D:\Dev\build\bin\GoNavi-dev.exe`
	if changed, err := register(reg, other); err != nil || !changed {
		t.Fatalf("handover: %v %v", changed, err)
	}
	if got, _ := reg.Get(`Software\Classes\gonavi\shell\open\command`, ""); !strings.Contains(got, "GoNavi-dev.exe") {
		t.Fatalf("command after handover = %q", got)
	}
}

func TestRegisterRefusesAPathItCannotQuoteSafely(t *testing.T) {
	for _, exe := range []string{"", "  ", `C:\a"b\GoNavi.exe`, "C:\\a\nb.exe"} {
		reg := newFakeRegistry()
		if _, err := register(reg, exe); err == nil || reg.writes != 0 {
			t.Errorf("%q: err=%v writes=%d", exe, err, reg.writes)
		}
	}
}

func TestRegisterReportsAFailureInsteadOfPretendingItWorked(t *testing.T) {
	reg := newFakeRegistry()
	reg.failOn = `shell\open\command`
	if _, err := register(reg, `D:\Apps\GoNavi.exe`); err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("err = %v", err)
	}
}
