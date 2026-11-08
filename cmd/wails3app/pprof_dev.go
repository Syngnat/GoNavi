//go:build gonavi_dev_pprof

package main

import (
	"log"
	"net/http"
	_ "net/http/pprof"
)

// Started only for profiling builds (`-tags gonavi_dev_pprof`) so release
// binaries never open a debug port.
func init() {
	go func() {
		if err := http.ListenAndServe("127.0.0.1:6060", nil); err != nil {
			log.Printf("pprof server stopped: %v", err)
		}
	}()
}
