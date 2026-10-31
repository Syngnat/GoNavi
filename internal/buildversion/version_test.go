package buildversion

import "testing"

func TestIsDevelopment(t *testing.T) {
	tests := []struct {
		version string
		want    bool
	}{
		{"", true},
		{"dev", true},
		{"dev-6748d9e", true},
		{"vdev-6748d9e", true},
		{"0.0.0", true},
		{"0.0.1-test", true},
		{"1.1.5-dev.20", true},
		{"1.2.0-test.1", true},
		{"0.7.9-SNAPSHOT", true},
		{"1.1.5", false},
		{"1.1.4", false},
		{"1.2.0-rc.1", false},
		{"banana", false},
		{"1.1", false},
	}
	for _, tt := range tests {
		if got := IsDevelopment(tt.version); got != tt.want {
			t.Errorf("IsDevelopment(%q)=%v, want %v", tt.version, got, tt.want)
		}
	}
}

func TestSatisfiesMinimum(t *testing.T) {
	tests := []struct {
		name    string
		host    string
		minimum string
		want    bool
	}{
		{name: "dev ci build satisfies latest release", host: "dev-6748d9e", minimum: "1.1.5", want: true},
		{name: "local test version satisfies latest release", host: "0.0.1-test", minimum: "1.1.5", want: true},
		{name: "same release", host: "1.1.5", minimum: "1.1.5", want: true},
		{name: "newer release", host: "1.2.0", minimum: "1.1.5", want: true},
		{name: "older release", host: "1.1.4", minimum: "1.1.5", want: false},
		{name: "release candidate is older than release", host: "1.2.0-rc.1", minimum: "1.2.0", want: false},
		{name: "release satisfies its candidate minimum", host: "1.2.0", minimum: "1.2.0-rc.1", want: true},
		{name: "invalid release fails closed", host: "banana", minimum: "1.0.0", want: false},
		{name: "invalid minimum never matches", host: "1.1.5", minimum: "banana", want: false},
		{name: "dev host does not accept invalid minimum", host: "dev-6748d9e", minimum: "banana", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SatisfiesMinimum(tt.host, tt.minimum); got != tt.want {
				t.Fatalf("SatisfiesMinimum(%q, %q)=%v, want %v", tt.host, tt.minimum, got, tt.want)
			}
		})
	}
}
