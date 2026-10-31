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

func TestParseAcceptsTheMarketInstallLink(t *testing.T) {
	for raw, want := range map[string]Link{
		"gonavi://plugin/install?spec=github%3Aowner%2Frepo":      {Action: ActionPluginInstall, Spec: "github:owner/repo"},
		"gonavi://plugin/install?spec=github%3Aowner%2Frepo%40v1": {Action: ActionPluginInstall, Spec: "github:owner/repo@v1"},
		"gonavi://plugin/install?spec=%40scope%2Fpkg%401.2.3":     {Action: ActionPluginInstall, Spec: "@scope/pkg@1.2.3"},
		"gonavi://plugin/install?id=com.gonavi.sql-insights":      {Action: ActionPluginInstall, PluginID: "com.gonavi.sql-insights"},
		"gonavi://plugin/install?spec=github%3Aa%2Fb&id=c.d":      {Action: ActionPluginInstall, Spec: "github:a/b", PluginID: "c.d"},
		"GoNavi://Plugin/install?spec=redis-inspector":            {Action: ActionPluginInstall, Spec: "redis-inspector"},
	} {
		got, ok := Parse(raw)
		if !ok || got != want {
			t.Errorf("Parse(%q) = %+v, %v; want %+v", raw, got, ok, want)
		}
	}
}

func TestParseRefusesBrokenInstallLinks(t *testing.T) {
	for _, raw := range []string{
		"gonavi://plugin",                                          // no path
		"gonavi://plugin/other",                                    // unknown subpath
		"gonavi://plugin/install/extra",                            // deeper path
		"gonavi://plugin/install",                                  // nothing to install
		"gonavi://plugin/install?spec=",                            // empty spec
		"gonavi://plugin/install?spec=%00",                         // NUL
		"gonavi://plugin/install?spec=x%20y",                       // space
		`gonavi://plugin/install?spec=C%3A%5Cevil%2Fx`,             // a local path: backslashes never survive
		"gonavi://plugin/install?spec=<script>",                    // shell/HTML punctuation
		"gonavi://plugin/install?spec=" + strings.Repeat("a", 201), // oversize
		"gonavi://plugin/install?id=a%2Fb",                         // an id has no separators
		"gonavi://evil.example/plugin/install?spec=x",              // a foreign host is not the market
		"gonavi://plugin:8080/install?spec=x",                      // ports are never allowed
	} {
		if link, ok := Parse(raw); ok {
			t.Errorf("Parse(%q) accepted: %+v", raw, link)
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
