// Package desktop is the desktop-runtime boundary for GoNavi.
//
// Business packages call this package instead of importing a Wails runtime
// directly. The !wails3 build delegates to Wails v2; the wails3 build delegates
// to Wails v3. Keeping the surface here means the v2 shipping build and the v3
// migration build compile from the same call sites while the framework switch
// is in progress.
package desktop
