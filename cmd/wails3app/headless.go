//go:build wails3

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	frontendbundle "GoNavi-Wails/frontend"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/cli"
	"GoNavi-Wails/internal/mcpserver"
	"GoNavi-Wails/internal/nativewindow"
	"GoNavi-Wails/internal/scriptengine"
	"GoNavi-Wails/internal/webserver"
)

// runHeadlessMode keeps CLI child processes out of the GUI. The MCP HTTP
// server and scheduled sync workers re-execute this binary; without this
// dispatch each child would start another Wails application (and another MCP
// child), so the process tree grows without bound.
func runHeadlessMode(args []string) (bool, int) {
	if len(args) == 0 {
		return false, 0
	}
	first := strings.TrimSpace(args[0])
	// `--data-root ... plugin ...` is the plugin CLI's data-root prefix, not a
	// GUI launch.
	if first == "--data-root" || strings.HasPrefix(first, "--data-root=") {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		cli.Version = appcore.CurrentVersion()
		code := cli.Run(ctx, args, os.Stdout, os.Stderr)
		if code != cli.ExitSuccess {
			log.Printf("plugin CLI exited with code %d", code)
		}
		return true, code
	}
	mode := strings.ToLower(first)
	switch mode {
	case "mcp-server", "--mcp-server":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := runMCPServerMode(ctx, args[1:]); err != nil {
			log.Printf("mcp server exited: %v", err)
			return true, 1
		}
		return true, 0
	case "sync-worker":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := appcore.RunSyncWorker(ctx, args[1:]); err != nil {
			log.Printf("sync worker exited: %v", err)
			return true, 1
		}
		return true, 0
	case "run-sync-job":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := appcore.RunScheduledJobOnce(ctx, args[1:]); err != nil {
			log.Printf("scheduled job exited: %v", err)
			return true, 1
		}
		return true, 0
	case scriptengine.WorkerModeArg:
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := scriptengine.RunWorker(ctx, os.Stdin, os.Stdout); err != nil {
			log.Printf("script worker exited: %v", err)
			return true, 1
		}
		return true, 0
	case "plugin-window", "--plugin-window":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := nativewindow.RunPluginChild(ctx, args[1:]); err != nil {
			log.Printf("plugin window exited: %v", err)
			return true, 1
		}
		return true, 0
	case "web-server", "--web-server":
		// Documented fallback when WebView2 is unavailable: serve the browser
		// build instead of opening a GUI.
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := webserver.Run(ctx, frontendbundle.Assets, args[1:]); err != nil {
			log.Printf("web server exited: %v", err)
			return true, 1
		}
		return true, 0
	case "plugin":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		cli.Version = appcore.CurrentVersion()
		code := cli.Run(ctx, args, os.Stdout, os.Stderr)
		if code != cli.ExitSuccess {
			log.Printf("plugin CLI exited with code %d", code)
		}
		return true, code
	default:
		return false, 0
	}
}

func runMCPServerMode(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return mcpserver.RunAppStdioServer(ctx)
	}
	switch strings.ToLower(strings.TrimSpace(args[0])) {
	case "help", "--help", "-h":
		mcpserver.WriteAppMCPServerUsage(os.Stdout)
		return nil
	case "stdio", "--stdio":
		return mcpserver.RunAppStdioServer(ctx)
	case "http", "--http", "streamable-http", "--streamable-http":
		options, err := mcpserver.ParseHTTPServerOptions(args[1:])
		if err != nil {
			if errors.Is(err, flag.ErrHelp) {
				mcpserver.WriteHTTPServerUsage(os.Stdout)
				return nil
			}
			return err
		}
		return mcpserver.RunAppStreamableHTTPServer(ctx, options)
	case "remote-config", "--remote-config":
		return mcpserver.WriteRemoteMCPClientConfig(os.Stdout, args[1:])
	default:
		return fmt.Errorf("unknown MCP server mode: %s", args[0])
	}
}
