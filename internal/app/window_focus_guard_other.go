//go:build !windows

package app

import "context"

func suspendWailsWebViewFocus(context.Context) (func() error, error) {
	return func() error { return nil }, nil
}
