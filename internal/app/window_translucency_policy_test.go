package app

import "testing"

func TestResolveMacWindowTranslucencyPolicy(t *testing.T) {
	tests := []struct {
		name           string
		opacity        float64
		blur           float64
		effectAlpha    float64
		windowOpaque   bool
		darkAppearance bool
	}{
		{
			name:         "fully opaque without blur uses the cheap opaque window path",
			opacity:      1,
			blur:         0,
			effectAlpha:  0,
			windowOpaque: true,
		},
		{
			name:         "low opacity without blur exposes the desktop directly",
			opacity:      0.3,
			blur:         0,
			effectAlpha:  0,
			windowOpaque: false,
		},
		{
			name:           "blurred translucent mode keeps native material available",
			opacity:        0.5,
			blur:           6,
			effectAlpha:    macNativeMaterialAlpha,
			windowOpaque:   false,
			darkAppearance: true,
		},
		{
			name:           "low opacity never turns native material into a gray veil",
			opacity:        0.35,
			blur:           3,
			effectAlpha:    macNativeMaterialAlpha,
			windowOpaque:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			policy := resolveMacWindowTranslucencyPolicy(tt.opacity, tt.blur, tt.darkAppearance)
			if policy.effectAlpha != tt.effectAlpha {
				t.Fatalf("effect alpha = %v, want %v", policy.effectAlpha, tt.effectAlpha)
			}
			if policy.windowOpaque != tt.windowOpaque {
				t.Fatalf("window opaque = %v, want %v", policy.windowOpaque, tt.windowOpaque)
			}
			if policy.darkAppearance != tt.darkAppearance {
				t.Fatalf("dark appearance = %v, want %v", policy.darkAppearance, tt.darkAppearance)
			}
		})
	}
}
