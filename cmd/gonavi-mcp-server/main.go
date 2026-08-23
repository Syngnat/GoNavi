package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"GoNavi-Wails/internal/mcpserver"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil && !isNormalServerExit(err) {
		log.Printf("GoNavi MCP Server 退出: %v", err)
		os.Exit(1)
	}
}

func isNormalServerExit(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, io.EOF)
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return mcpserver.RunAppStdioServer(ctx)
	}

	mode := strings.ToLower(strings.TrimSpace(args[0]))
	switch mode {
	case "stdio", "--stdio":
		return mcpserver.RunAppStdioServer(ctx)
	case "http", "--http", "streamable-http", "--streamable-http":
		options, err := mcpserver.ParseHTTPServerOptions(args[1:])
		if err != nil {
			return err
		}
		log.Printf("GoNavi MCP Streamable HTTP Server 启动：addr=%s path=%s schemaOnly=%v allowNonLoopback=%v", options.Addr, options.Path, options.SchemaOnly, options.AllowNonLoopback)
		return mcpserver.RunAppStreamableHTTPServer(ctx, options)
	case "remote-config", "--remote-config":
		return mcpserver.WriteRemoteMCPClientConfig(os.Stdout, args[1:])
	default:
		return fmt.Errorf("未知 MCP server 模式: %s（支持 stdio/http/remote-config）", args[0])
	}
}
