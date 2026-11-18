//go:build !windows && !wails3

package main

func acquireWindowsMSISingleInstance(_ string, _ func()) (func(), bool, error) {
	return nil, true, nil
}
