package jvm

import (
	"errors"
	"strings"
	"testing"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)




func TestConnectionErrorMessageCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"jvm.backend.connection_error.generic",
		"jvm.backend.connection_error.suggestion",
		"jvm.backend.connection_error.technical_detail",
		"jvm.backend.connection_error.endpoint.base_url_required",
		"jvm.backend.connection_error.endpoint.base_url_invalid.summary",
		"jvm.backend.connection_error.endpoint.base_url_invalid.help",
		"jvm.backend.connection_error.endpoint.scheme_unsupported.summary",
		"jvm.backend.connection_error.endpoint.scheme_unsupported.help",
		"jvm.backend.connection_error.endpoint.not_found.summary",
		"jvm.backend.connection_error.endpoint.not_found.help",
		"jvm.backend.connection_error.endpoint.connection_refused.summary",
		"jvm.backend.connection_error.endpoint.connection_refused.help",
		"jvm.backend.connection_error.endpoint.unauthorized.summary",
		"jvm.backend.connection_error.endpoint.unauthorized.help",
		"jvm.backend.connection_error.endpoint.forbidden.summary",
		"jvm.backend.connection_error.endpoint.forbidden.help",
		"jvm.backend.connection_error.endpoint.timeout.summary",
		"jvm.backend.connection_error.endpoint.timeout.help",
		"jvm.backend.connection_error.agent.base_url_required",
		"jvm.backend.connection_error.agent.base_url_invalid.summary",
		"jvm.backend.connection_error.agent.base_url_invalid.help",
		"jvm.backend.connection_error.agent.scheme_unsupported.summary",
		"jvm.backend.connection_error.agent.scheme_unsupported.help",
		"jvm.backend.connection_error.agent.connection_refused.summary",
		"jvm.backend.connection_error.agent.connection_refused.help",
		"jvm.backend.connection_error.agent.unauthorized.summary",
		"jvm.backend.connection_error.agent.unauthorized.help",
		"jvm.backend.connection_error.agent.forbidden.summary",
		"jvm.backend.connection_error.agent.forbidden.help",
		"jvm.backend.connection_error.agent.timeout.summary",
		"jvm.backend.connection_error.agent.timeout.help",
		"jvm.backend.connection_error.jmx.host_required",
		"jvm.backend.connection_error.jmx.port_invalid",
		"jvm.backend.connection_error.jmx.java_missing.summary",
		"jvm.backend.connection_error.jmx.java_missing.help",
		"jvm.backend.connection_error.jmx.non_jrmp.summary",
		"jvm.backend.connection_error.jmx.non_jrmp.help",
		"jvm.backend.connection_error.jmx.no_such_object.summary",
		"jvm.backend.connection_error.jmx.no_such_object.help",
		"jvm.backend.connection_error.jmx.connection_reset.summary",
		"jvm.backend.connection_error.jmx.connection_reset.help",
		"jvm.backend.connection_error.jmx.connection_refused.summary",
		"jvm.backend.connection_error.jmx.connection_refused.help",
		"jvm.backend.connection_error.jmx.auth.summary",
		"jvm.backend.connection_error.jmx.auth.help",
		"jvm.backend.connection_error.jmx.timeout.summary",
		"jvm.backend.connection_error.jmx.timeout.help",
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing jvm connection error key %q", language, key)
			}
		}
	}
}

func TestDescribeConnectionTestErrorLocalizesAgentMessagesInEnglish(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cfg := connection.ConnectionConfig{
		Type: "jvm",
		JVM: connection.JVMConfig{
			PreferredMode: ModeAgent,
			AllowedModes:  []string{ModeAgent},
		},
	}

	raw := `agent baseurl is invalid: parse ":bad-url": missing protocol scheme`
	got := DescribeConnectionTestError(cfg, errors.New(raw))
	want := strings.Join([]string{
		"Agent connection failed: Agent Base URL is invalid.",
		"Suggestion: Enter a full http:// or https:// URL, for example http://127.0.0.1:19090/gonavi/agent/jvm.",
		`Technical detail: agent baseurl is invalid: parse ":bad-url": missing protocol scheme`,
	}, "\n")
	if got != want {
		t.Fatalf("expected English agent message %q, got %q", want, got)
	}
}

func TestDescribeConnectionTestErrorLocalizesGenericAndEndpointMessagesInEnglish(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cfg := connection.ConnectionConfig{
		Type: "jvm",
		JVM: connection.JVMConfig{
			PreferredMode: ModeEndpoint,
			AllowedModes:  []string{ModeEndpoint},
		},
	}

	if got := DescribeConnectionTestError(cfg, errors.New("   ")); got != "JVM connection failed" {
		t.Fatalf("expected English generic message, got %q", got)
	}

	raw := `endpoint baseurl is invalid: parse ":bad-url": missing protocol scheme`
	got := DescribeConnectionTestError(cfg, errors.New(raw))
	want := strings.Join([]string{
		"Endpoint connection failed: Endpoint Base URL is invalid.",
		"Suggestion: Enter a full http:// or https:// URL that points to the management API root implementing the GoNavi JVM HTTP contract, for example http://127.0.0.1:19090/manage/jvm.",
		`Technical detail: endpoint baseurl is invalid: parse ":bad-url": missing protocol scheme`,
	}, "\n")
	if got != want {
		t.Fatalf("expected English endpoint message %q, got %q", want, got)
	}
}

func TestDescribeConnectionTestErrorLocalizesJMXMessagesInEnglish(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cfg := connection.ConnectionConfig{
		Type: "jvm",
		Host: "localhost",
		Port: 18080,
		JVM: connection.JVMConfig{
			PreferredMode: ModeJMX,
			AllowedModes:  []string{ModeJMX},
		},
	}

	raw := `jmx helper ping failed for localhost:18080: JMX command ping failed for localhost:18080: Failed to retrieve RMIServer stub: javax.naming.CommunicationException [Root exception is java.rmi.ConnectIOException: non-JRMP server at remote endpoint]; details={"exception":"java.lang.IllegalStateException"}`
	got := DescribeConnectionTestError(cfg, errors.New(raw))
	want := strings.Join([]string{
		"JMX connection failed: localhost:18080 is not a standard JMX remote management port; it looks like a business or HTTP port.",
		"Suggestion: Use the actual JMX port exposed by the application, not the business `server.port`. If the service only enables `-Dcom.sun.management.jmxremote` without `jmxremote.port`, it cannot be connected remotely.",
		`Technical detail: jmx helper ping failed for localhost:18080: JMX command ping failed for localhost:18080: Failed to retrieve RMIServer stub: javax.naming.CommunicationException [Root exception is java.rmi.ConnectIOException: non-JRMP server at remote endpoint]; details={"exception":"java.lang.IllegalStateException"}`,
	}, "\n")
	if got != want {
		t.Fatalf("expected English JMX message %q, got %q", want, got)
	}
}
