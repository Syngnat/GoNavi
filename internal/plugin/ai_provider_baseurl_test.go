package plugin

import (
	"strings"
	"testing"
)

// The declared endpoint prefills the provider form, so the host must reject anything it would
// not itself dial: a non-http(s) scheme, embedded credentials, a fragment or a query string.
func TestAIProviderDefaultBaseURLValidation(t *testing.T) {
	invalid := []string{
		"ftp://example.com/v1",
		"javascript:alert(1)",
		"file:///etc/passwd",
		"//example.com/v1",
		"example.com/v1",
		"http://user:secret@example.com/v1",
		"https://example.com/v1#fragment",
		"https://example.com/v1?key=value",
		" https://example.com/v1",
		"https://example.com/v1 ",
		"https://" + strings.Repeat("a", 2050),
	}
	for _, value := range invalid {
		t.Run("reject/"+value, func(t *testing.T) {
			m := aiProviderManifest()
			m.Contributes.AIProviders[0].DefaultBaseURL = value
			if ValidateManifest(m) == nil {
				t.Fatalf("invalid default base url accepted: %q", value)
			}
		})
	}
	for _, value := range []string{"", "https://api.example.com", "http://127.0.0.1:8080/v1", "https://example.com:8443/a/b"} {
		m := aiProviderManifest()
		m.Contributes.AIProviders[0].DefaultBaseURL = value
		if err := ValidateManifest(m); err != nil {
			t.Fatalf("valid default base url rejected %q: %v", value, err)
		}
	}
}
