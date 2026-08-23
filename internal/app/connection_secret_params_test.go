package app

import "testing"

func TestHasSensitiveConnectionParamsFailsClosed(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want bool
	}{
		{name: "public parameters", raw: "application_name=gonavi&connect_timeout=10", want: false},
		{name: "password", raw: "application_name=gonavi&password=secret", want: true},
		{name: "access token", raw: "access_token=secret", want: true},
		{name: "malformed", raw: "token=secret;broken", want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := HasSensitiveConnectionParams(test.raw); got != test.want {
				t.Fatalf("HasSensitiveConnectionParams(%q) = %t, want %t", test.raw, got, test.want)
			}
		})
	}
}
