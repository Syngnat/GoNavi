package aiservice

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/logger"
)

const (
	defaultMCPHTTPAddr = "127.0.0.1:8765"
	defaultMCPHTTPPath = "/mcp"
)

type mcpHTTPServerRuntime struct {
	process  mcpHTTPProcess
	status   ai.MCPHTTPServerStatus
	stopping bool
}

// mcpHTTPStartAttempt 表示尚未发布为运行态的启动过程。
// Stop/Shutdown 可以先取消它，再等待 mcpHTTPOpMu，避免健康检查完成后又重新发布进程。
type mcpHTTPStartAttempt struct {
	ctx    context.Context
	cancel context.CancelFunc
}

type mcpHTTPProcessStartOptions struct {
	Addr       string
	Path       string
	Token      string
	SchemaOnly bool
}

type mcpHTTPProcess interface {
	Done() <-chan struct{}
	Stop(context.Context) error
	Wait() error
}

type mcpHTTPTextLookup func(key string, params map[string]any) string

var (
	startMCPHTTPProcess = startMCPHTTPCommandProcess
	waitMCPHTTPHealth   = waitMCPHTTPHealthEndpoint
)

// AIGetMCPHTTPServerStatus 返回客户端内置 HTTP MCP 服务状态。
func (s *Service) AIGetMCPHTTPServerStatus() ai.MCPHTTPServerStatus {
	config := s.currentMCPHTTPServerConfig()
	s.mcpHTTPMu.Lock()
	if s.mcpHTTP != nil {
		status := s.mcpHTTP.status
		status.Running = true
		status.Enabled = config.Enabled
		s.mcpHTTPMu.Unlock()
		return status
	}
	last := s.mcpHTTPLast
	s.mcpHTTPMu.Unlock()

	message := strings.TrimSpace(last.Message)
	if message == "" {
		message = s.serviceText("ai_settings.mcp_http.status.not_running", nil)
	}
	return mcpHTTPStatusFromConfig(config, message)
}

// AIStartMCPHTTPServer 从客户端内启动 GoNavi Streamable HTTP MCP 服务。
func (s *Service) AIStartMCPHTTPServer(options ai.MCPHTTPServerOptions) (ai.MCPHTTPServerStatus, error) {
	return s.startMCPHTTPServer(options)
}

func (s *Service) startMCPHTTPServer(options ai.MCPHTTPServerOptions) (ai.MCPHTTPServerStatus, error) {
	s.mcpHTTPOpMu.Lock()
	defer s.mcpHTTPOpMu.Unlock()

	s.mcpHTTPMu.Lock()
	if s.mcpHTTP != nil {
		status := s.mcpHTTP.status
		status.Running = true
		s.mcpHTTPMu.Unlock()
		if err := s.persistMCPHTTPServerConfig(mcpHTTPServerConfigFromStatus(status, true)); err != nil {
			err = localizeMCPHTTPError(s.serviceText, "ai_service.backend.error.mcp_http_start_failed", nil, err)
			status.Message = err.Error()
			return status, err
		}
		status.Enabled = true
		return status, nil
	}
	s.mcpHTTPMu.Unlock()

	textLookup := s.serviceText
	startOptions, token, err := normalizeInAppMCPHTTPOptions(options, textLookup)
	if err != nil {
		err = localizeMCPHTTPError(textLookup, "ai_service.backend.error.mcp_http_start_failed", nil, err)
		status := mcpHTTPStatusFromConfig(s.currentMCPHTTPServerConfig(), err.Error())
		s.setMCPHTTPLastStatus(status)
		return status, err
	}

	ctx := s.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	attempt := s.beginMCPHTTPStart(ctx)
	published := false
	defer func() {
		s.clearMCPHTTPStart(attempt)
		if !published && attempt.cancel != nil {
			attempt.cancel()
		}
	}()

	if err := s.persistMCPHTTPServerConfig(mcpHTTPServerConfigFromStartOptions(startOptions)); err != nil {
		err = localizeMCPHTTPError(textLookup, "ai_service.backend.error.mcp_http_start_failed", nil, err)
		status := mcpHTTPStatusFromConfig(s.currentMCPHTTPServerConfig(), err.Error())
		s.setMCPHTTPLastStatus(status)
		return status, err
	}

	if err := attempt.ctx.Err(); err != nil {
		err = localizeMCPHTTPError(textLookup, "ai_service.backend.error.mcp_http_start_failed", nil, err)
		status := stoppedMCPHTTPStatus(statusFromMCPHTTPOptions(startOptions, token, textLookup), err.Error())
		s.setMCPHTTPLastStatus(status)
		return status, err
	}
	process, err := startMCPHTTPProcess(attempt.ctx, startOptions, textLookup)
	if err != nil {
		err = localizeMCPHTTPError(textLookup, "ai_service.backend.error.mcp_http_start_failed", nil, err)
		status := stoppedMCPHTTPStatus(statusFromMCPHTTPOptions(startOptions, token, textLookup), err.Error())
		s.setMCPHTTPLastStatus(status)
		return status, err
	}

	status := statusFromMCPHTTPOptions(startOptions, token, textLookup)
	if err := waitForMCPHTTPReady(attempt.ctx, process, status, textLookup); err != nil {
		_ = process.Stop(context.Background())
		err = localizeMCPHTTPError(textLookup, "ai_service.backend.error.mcp_http_start_failed", nil, err)
		stopped := stoppedMCPHTTPStatus(status, err.Error())
		s.setMCPHTTPLastStatus(stopped)
		return stopped, err
	}
	if err := attempt.ctx.Err(); err != nil {
		_ = process.Stop(context.Background())
		err = localizeMCPHTTPError(textLookup, "ai_service.backend.error.mcp_http_start_failed", nil, err)
		stopped := stoppedMCPHTTPStatus(status, err.Error())
		s.setMCPHTTPLastStatus(stopped)
		return stopped, err
	}

	runtime := &mcpHTTPServerRuntime{process: process, status: status}
	if !s.claimMCPHTTPStart(attempt) {
		_ = process.Stop(context.Background())
		err := localizeMCPHTTPError(textLookup, "ai_service.backend.error.mcp_http_start_failed", nil, context.Canceled)
		stopped := stoppedMCPHTTPStatus(status, err.Error())
		s.setMCPHTTPLastStatus(stopped)
		return stopped, err
	}

	s.mcpHTTPMu.Lock()
	if s.mcpHTTP != nil {
		existing := s.mcpHTTP.status
		existing.Running = true
		s.mcpHTTPMu.Unlock()
		_ = process.Stop(context.Background())
		return existing, nil
	}
	s.mcpHTTP = runtime
	s.mcpHTTPLast = status
	s.mcpHTTPMu.Unlock()
	published = true

	logger.Infof("客户端启动 GoNavi MCP HTTP 服务：addr=%s path=%s schemaOnly=%v", status.Addr, status.Path, status.SchemaOnly)
	go s.watchMCPHTTPServer(runtime)
	return status, nil
}

// AIStopMCPHTTPServer 停止客户端内启动的 GoNavi Streamable HTTP MCP 服务。
func (s *Service) AIStopMCPHTTPServer() (ai.MCPHTTPServerStatus, error) {
	s.cancelMCPHTTPStart()
	s.mcpHTTPOpMu.Lock()
	defer s.mcpHTTPOpMu.Unlock()

	status := s.AIGetMCPHTTPServerStatus()
	if err := s.persistMCPHTTPServerConfig(mcpHTTPServerConfigFromStatus(status, false)); err != nil {
		err = localizeMCPHTTPError(s.serviceText, "ai_service.backend.error.mcp_http_stop_failed", nil, err)
		status.Message = err.Error()
		return status, err
	}

	stopped, err := s.stopMCPHTTPServer(context.Background(), s.serviceText("ai_settings.mcp_http.message.stopped", nil))
	stopped.Enabled = false
	s.setMCPHTTPLastStatus(stopped)
	return stopped, err
}

func (s *Service) stopMCPHTTPServer(ctx context.Context, message string) (ai.MCPHTTPServerStatus, error) {
	textLookup := s.serviceText
	s.mcpHTTPMu.Lock()
	runtime := s.mcpHTTP
	if runtime == nil {
		status := s.mcpHTTPLast
		if strings.TrimSpace(status.Addr) == "" {
			status = defaultMCPHTTPServerStatus(textLookup)
		}
		status.Running = false
		if strings.TrimSpace(status.Token) != "" {
			status.AuthorizationHeader = "Bearer " + strings.TrimSpace(status.Token)
		}
		status.Message = localizeMCPHTTPText(textLookup, "ai_settings.mcp_http.status.not_running", nil)
		s.mcpHTTPLast = status
		s.mcpHTTPMu.Unlock()
		return status, nil
	}
	runtime.stopping = true
	s.mcpHTTPMu.Unlock()

	if ctx == nil {
		ctx = context.Background()
	}
	err := runtime.process.Stop(ctx)
	status := stoppedMCPHTTPStatus(runtime.status, message)
	if err != nil {
		err = localizeMCPHTTPError(textLookup, "ai_service.backend.error.mcp_http_stop_failed", nil, err)
		status.Message = err.Error()
	}

	s.mcpHTTPMu.Lock()
	if s.mcpHTTP == runtime {
		s.mcpHTTP = nil
		s.mcpHTTPLast = status
	}
	s.mcpHTTPMu.Unlock()

	if err == nil {
		logger.Infof("客户端停止 GoNavi MCP HTTP 服务：addr=%s path=%s", status.Addr, status.Path)
	}
	return status, err
}

// Shutdown 释放 AI Service 中的运行时资源。
func (s *Service) Shutdown() {
	s.cancelMCPHTTPStart()
	s.mcpHTTPOpMu.Lock()
	defer s.mcpHTTPOpMu.Unlock()

	ctx := context.Background()
	_, _ = s.stopMCPHTTPServer(ctx, s.serviceText("ai_settings.mcp_http.message.stopped", nil))
}

func (s *Service) beginMCPHTTPStart(ctx context.Context) *mcpHTTPStartAttempt {
	if ctx == nil {
		ctx = context.Background()
	}
	startCtx, cancel := context.WithCancel(ctx)
	attempt := &mcpHTTPStartAttempt{ctx: startCtx, cancel: cancel}

	s.mcpHTTPStartMu.Lock()
	s.mcpHTTPStart = attempt
	s.mcpHTTPStartMu.Unlock()
	return attempt
}

func (s *Service) clearMCPHTTPStart(attempt *mcpHTTPStartAttempt) {
	if attempt == nil {
		return
	}
	s.mcpHTTPStartMu.Lock()
	if s.mcpHTTPStart == attempt {
		s.mcpHTTPStart = nil
	}
	s.mcpHTTPStartMu.Unlock()
}

// claimMCPHTTPStart 原子地结束待发布的启动过程，并确认它未被 Stop/Shutdown 取消。
func (s *Service) claimMCPHTTPStart(attempt *mcpHTTPStartAttempt) bool {
	if attempt == nil {
		return false
	}
	s.mcpHTTPStartMu.Lock()
	isCurrent := s.mcpHTTPStart == attempt
	if isCurrent {
		s.mcpHTTPStart = nil
	}
	s.mcpHTTPStartMu.Unlock()
	return isCurrent && attempt.ctx.Err() == nil
}

func (s *Service) cancelMCPHTTPStart() {
	s.mcpHTTPStartMu.Lock()
	attempt := s.mcpHTTPStart
	if attempt != nil && attempt.cancel != nil {
		attempt.cancel()
	}
	s.mcpHTTPStartMu.Unlock()
}

func (s *Service) restoreMCPHTTPServer() {
	config := s.currentMCPHTTPServerConfig()
	if !config.Enabled {
		return
	}

	if _, err := s.startMCPHTTPServer(mcpHTTPServerOptionsFromConfig(config)); err != nil {
		logger.Warnf("恢复 GoNavi MCP HTTP 服务失败：addr=%s path=%s reason=%v", config.Addr, config.Path, err)
	}
}

func (s *Service) watchMCPHTTPServer(runtime *mcpHTTPServerRuntime) {
	err := runtime.process.Wait()

	s.mcpHTTPMu.Lock()
	defer s.mcpHTTPMu.Unlock()
	if s.mcpHTTP != runtime {
		return
	}

	message := localizeMCPHTTPText(s.serviceText, "ai_settings.mcp_http.message.stopped", nil)
	if err != nil && !runtime.stopping {
		message = localizeMCPHTTPText(s.serviceText, "ai_service.backend.error.mcp_http_process_exited", map[string]any{
			"detail": err.Error(),
		})
		logger.Error(err, "GoNavi MCP HTTP 服务异常退出：addr=%s path=%s", runtime.status.Addr, runtime.status.Path)
	}
	s.mcpHTTP = nil
	s.mcpHTTPLast = stoppedMCPHTTPStatus(runtime.status, message)
}

func (s *Service) currentMCPHTTPServerConfig() ai.MCPHTTPServerConfig {
	s.mu.RLock()
	config := s.mcpHTTPConfig
	s.mu.RUnlock()
	return normalizeMCPHTTPServerConfig(config)
}

func (s *Service) persistMCPHTTPServerConfig(config ai.MCPHTTPServerConfig) error {
	config = normalizeMCPHTTPServerConfig(config)

	s.mu.Lock()
	previous := s.mcpHTTPConfig
	s.mcpHTTPConfig = config
	if err := s.saveConfig(); err != nil {
		s.mcpHTTPConfig = previous
		s.mu.Unlock()
		return err
	}
	s.mu.Unlock()
	return nil
}

func (s *Service) setMCPHTTPLastStatus(status ai.MCPHTTPServerStatus) {
	s.mcpHTTPMu.Lock()
	if s.mcpHTTP == nil {
		s.mcpHTTPLast = status
	}
	s.mcpHTTPMu.Unlock()
}

func mcpHTTPServerOptionsFromConfig(config ai.MCPHTTPServerConfig) ai.MCPHTTPServerOptions {
	config = normalizeMCPHTTPServerConfig(config)
	return ai.MCPHTTPServerOptions{
		Addr:       config.Addr,
		Path:       config.Path,
		Token:      config.Token,
		SchemaOnly: config.SchemaOnly,
	}
}

func mcpHTTPServerConfigFromStartOptions(options mcpHTTPProcessStartOptions) ai.MCPHTTPServerConfig {
	return normalizeMCPHTTPServerConfig(ai.MCPHTTPServerConfig{
		Enabled:    true,
		Addr:       options.Addr,
		Path:       options.Path,
		SchemaOnly: options.SchemaOnly,
		Token:      options.Token,
	})
}

func mcpHTTPServerConfigFromStatus(status ai.MCPHTTPServerStatus, enabled bool) ai.MCPHTTPServerConfig {
	return normalizeMCPHTTPServerConfig(ai.MCPHTTPServerConfig{
		Enabled:    enabled,
		Addr:       status.Addr,
		Path:       status.Path,
		SchemaOnly: status.SchemaOnly,
		Token:      status.Token,
	})
}

func normalizeMCPHTTPServerConfig(config ai.MCPHTTPServerConfig) ai.MCPHTTPServerConfig {
	config.Addr = strings.TrimSpace(config.Addr)
	if config.Addr == "" {
		config.Addr = defaultMCPHTTPAddr
	}
	config.Path = strings.TrimSpace(config.Path)
	if config.Path == "" {
		config.Path = defaultMCPHTTPPath
	}
	if !strings.HasPrefix(config.Path, "/") {
		config.Path = "/" + config.Path
	}
	config.Token = strings.TrimSpace(config.Token)
	return config
}

func mcpHTTPStatusFromConfig(config ai.MCPHTTPServerConfig, message string) ai.MCPHTTPServerStatus {
	config = normalizeMCPHTTPServerConfig(config)
	status := ai.MCPHTTPServerStatus{
		Enabled:    config.Enabled,
		Running:    false,
		Addr:       config.Addr,
		Path:       config.Path,
		URL:        buildMCPHTTPURL(config.Addr, config.Path),
		SchemaOnly: config.SchemaOnly,
		Token:      config.Token,
		Message:    message,
	}
	if config.Token != "" {
		status.AuthorizationHeader = "Bearer " + config.Token
	}
	return status
}

func normalizeInAppMCPHTTPOptions(options ai.MCPHTTPServerOptions, textLookup mcpHTTPTextLookup) (mcpHTTPProcessStartOptions, string, error) {
	addr := strings.TrimSpace(options.Addr)
	if addr == "" {
		addr = defaultMCPHTTPAddr
	}
	path := strings.TrimSpace(options.Path)
	if path == "" {
		path = defaultMCPHTTPPath
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	token := strings.TrimSpace(options.Token)
	if token == "" {
		generated, err := generateMCPHTTPToken(textLookup)
		if err != nil {
			return mcpHTTPProcessStartOptions{}, "", err
		}
		token = generated
	}

	return mcpHTTPProcessStartOptions{
		Addr:  addr,
		Path:  path,
		Token: token,
		// 尊重调用方配置：false 时注册 execute_sql，用于查少量样例数据（仍受 AI 安全控制与行数上限约束）。
		SchemaOnly: options.SchemaOnly,
	}, token, nil
}

func startMCPHTTPCommandProcess(ctx context.Context, options mcpHTTPProcessStartOptions, textLookup mcpHTTPTextLookup) (mcpHTTPProcess, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, localizeMCPHTTPError(textLookup, "ai_service.backend.error.mcp_http_executable_resolve_failed", nil, err)
	}
	command, args, err := resolveMCPHTTPCommand(executable, options, textLookup)
	if err != nil {
		return nil, localizeMCPHTTPError(textLookup, "ai_service.backend.error.mcp_http_executable_resolve_failed", nil, err)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	processCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(processCtx, command, args...)
	cmd.Env = append(os.Environ(), "GONAVI_MCP_HTTP_TOKEN="+options.Token)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}

	process := &mcpHTTPCommandProcess{
		cancel: cancel,
		cmd:    cmd,
		done:   make(chan struct{}),
	}
	go process.wait()
	return process, nil
}

// resolveMCPHTTPCommand keeps the production command as
// "<GoNavi> mcp-server http ..." while redirecting a Wails development build
// to its independent MCP server binary. The latter is deliberately not
// GoNavi-dev.exe because Wails must replace that file on every backend reload.
func resolveMCPHTTPCommand(executablePath string, options mcpHTTPProcessStartOptions, textLookup mcpHTTPTextLookup) (string, []string, error) {
	command, prefixArgs, err := resolveLocalMCPCommand(executablePath, mcpClientInstallTextFunc(textLookup))
	if err != nil {
		return "", nil, err
	}

	args := make([]string, 0, len(prefixArgs)+6)
	args = append(args, prefixArgs...)
	args = append(args, "http", "--addr", options.Addr, "--path", options.Path)
	if options.SchemaOnly {
		args = append(args, "--schema-only")
	}
	return command, args, nil
}

type mcpHTTPCommandProcess struct {
	cancel context.CancelFunc
	cmd    *exec.Cmd
	done   chan struct{}
	mu     sync.Mutex
	err    error
}

func (p *mcpHTTPCommandProcess) Done() <-chan struct{} {
	return p.done
}

func (p *mcpHTTPCommandProcess) Stop(ctx context.Context) error {
	if p == nil {
		return nil
	}
	select {
	case <-p.done:
		return p.waitErr()
	default:
	}
	if p.cancel != nil {
		p.cancel()
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-p.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *mcpHTTPCommandProcess) Wait() error {
	if p == nil {
		return nil
	}
	<-p.done
	return p.waitErr()
}

func (p *mcpHTTPCommandProcess) wait() {
	err := p.cmd.Wait()
	p.mu.Lock()
	p.err = err
	p.mu.Unlock()
	close(p.done)
}

func (p *mcpHTTPCommandProcess) waitErr() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.err
}

func waitForMCPHTTPReady(ctx context.Context, process mcpHTTPProcess, status ai.MCPHTTPServerStatus, textLookup mcpHTTPTextLookup) error {
	readyCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	healthErrCh := make(chan error, 1)
	go func() {
		healthErrCh <- waitMCPHTTPHealth(readyCtx, buildMCPHTTPURL(status.Addr, "/healthz"), textLookup)
	}()

	select {
	case err := <-healthErrCh:
		return err
	case <-process.Done():
		if err := process.Wait(); err != nil {
			return err
		}
		return fmt.Errorf("%s", localizeMCPHTTPText(textLookup, "ai_service.backend.error.mcp_http_subprocess_exited", nil))
	case <-readyCtx.Done():
		return readyCtx.Err()
	}
}

func waitMCPHTTPHealthEndpoint(ctx context.Context, healthURL string, textLookup mcpHTTPTextLookup) error {
	client := http.Client{Timeout: 300 * time.Millisecond}
	var lastErr error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			lastErr = fmt.Errorf("%s", localizeMCPHTTPText(textLookup, "ai_service.backend.error.mcp_http_health_status_failed", map[string]any{
				"statusCode": resp.StatusCode,
			}))
		} else {
			lastErr = err
		}

		select {
		case <-ctx.Done():
			if lastErr != nil {
				return lastErr
			}
			return ctx.Err()
		case <-time.After(120 * time.Millisecond):
		}
	}
}

func statusFromMCPHTTPOptions(options mcpHTTPProcessStartOptions, token string, textLookup mcpHTTPTextLookup) ai.MCPHTTPServerStatus {
	return ai.MCPHTTPServerStatus{
		Enabled:             true,
		Running:             true,
		Addr:                options.Addr,
		Path:                options.Path,
		URL:                 buildMCPHTTPURL(options.Addr, options.Path),
		SchemaOnly:          options.SchemaOnly,
		Token:               token,
		AuthorizationHeader: "Bearer " + token,
		StartedAt:           time.Now().UnixMilli(),
		Message:             localizeMCPHTTPText(textLookup, "ai_settings.mcp_http.message.started", nil),
	}
}

func generateMCPHTTPToken(textLookup mcpHTTPTextLookup) (string, error) {
	var bytes [24]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", localizeMCPHTTPError(textLookup, "ai_service.backend.error.mcp_http_token_generate_failed", nil, err)
	}
	return "gnv_" + base64.RawURLEncoding.EncodeToString(bytes[:]), nil
}

func defaultMCPHTTPServerStatus(textLookup mcpHTTPTextLookup) ai.MCPHTTPServerStatus {
	return ai.MCPHTTPServerStatus{
		Enabled: false,
		Running: false,
		Addr:    defaultMCPHTTPAddr,
		Path:    defaultMCPHTTPPath,
		URL:     buildMCPHTTPURL(defaultMCPHTTPAddr, defaultMCPHTTPPath),
		// 默认允许只读 execute_sql 查少量数据；仍可在启动时显式传 schemaOnly=true 关闭。
		SchemaOnly: false,
		Message:    localizeMCPHTTPText(textLookup, "ai_settings.mcp_http.status.not_running", nil),
	}
}

func stoppedMCPHTTPStatus(status ai.MCPHTTPServerStatus, message string) ai.MCPHTTPServerStatus {
	status.Running = false
	if strings.TrimSpace(status.Token) != "" {
		status.AuthorizationHeader = "Bearer " + strings.TrimSpace(status.Token)
	}
	status.Message = message
	return status
}

func buildMCPHTTPURL(addr string, path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		path = defaultMCPHTTPPath
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	host, port, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return "http://" + strings.TrimSpace(addr) + path
	}
	host = strings.Trim(host, "[]")
	if host == "" || host == "::" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + path
}

func localizeMCPHTTPText(textLookup mcpHTTPTextLookup, key string, params map[string]any) string {
	if textLookup == nil {
		return key
	}
	return textLookup(key, params)
}

func localizeMCPHTTPError(textLookup mcpHTTPTextLookup, key string, params map[string]any, cause error) error {
	return serviceErrorFromText(key, localizeMCPHTTPText(textLookup, key, serviceTextWithDetail(params, cause)), cause)
}
