package app

type macWindowTranslucencyPolicy struct {
	effectAlpha    float64
	windowOpaque   bool
	darkAppearance bool
}

// Keep the native material as a subtle backdrop tint only. The actual window
// opacity is painted by the web UI theme; using (1-opacity) here makes a low
// opacity setting turn the NSVisualEffectView into an almost opaque gray veil.
const macNativeMaterialAlpha = 0.58

func resolveMacWindowTranslucencyPolicy(opacity float64, blur float64, darkAppearance bool) macWindowTranslucencyPolicy {
	if opacity >= 0.999 && blur <= 0 {
		return macWindowTranslucencyPolicy{windowOpaque: true, darkAppearance: darkAppearance}
	}

	// Opacity and native material are separate layers. With blur disabled the
	// material must stay hidden, otherwise lowering the WebView opacity merely
	// reveals an increasingly opaque NSVisualEffectView instead of the desktop.
	if blur <= 0 {
		return macWindowTranslucencyPolicy{windowOpaque: false, darkAppearance: darkAppearance}
	}

	return macWindowTranslucencyPolicy{
		effectAlpha:    macNativeMaterialAlpha,
		windowOpaque:   false,
		darkAppearance: darkAppearance,
	}
}
