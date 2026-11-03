package provider

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/logger"
)

// scanCodeBuddyCLIStream 处理 JSON 事件；terminal 为 true 时进程已回收，
// 错误已通过回调交付，返回的 error 仅供请求日志记录。
func scanCodeBuddyCLIStream(stdout io.Reader, cmd *exec.Cmd, resumeSessionID string, requestID string, callback func(ai.StreamChunk)) (string, bool, error) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	currentSessionID := strings.TrimSpace(resumeSessionID)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		var event cliStreamEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			logger.Warnf("CodeBuddyCLI 忽略非 JSON 输出：requestId=%s line=%s", requestID, RedactAIUpstreamLogText(line))
			continue
		}
		if strings.TrimSpace(event.SessionID) != "" {
			currentSessionID = strings.TrimSpace(event.SessionID)
		}
		switch event.Type {
		case "system":
			if isCodeBuddyCLISystemRetryEvent(event) {
				if errMsg, hasError := extractCodeBuddyCLISystemRetryError(event); hasError {
					callback(ai.StreamChunk{Error: errMsg, Done: true})
					if cmd.Process != nil {
						_ = cmd.Process.Kill()
					}
					_ = cmd.Wait()
					return "", true, fmt.Errorf("CodeBuddy CLI authentication failed: %s", errMsg)
				}
			}
		case "assistant":
			if errMsg, hasError := extractCodeBuddyCLIEventError(event); hasError {
				callback(ai.StreamChunk{Error: errMsg, Done: true})
				_ = cmd.Wait()
				return "", true, fmt.Errorf("CodeBuddy CLI returned an error: %s", errMsg)
			}
			for _, block := range event.Message.Content {
				if block.Type == "thinking" && block.Thinking != "" {
					callback(ai.StreamChunk{Thinking: block.Thinking})
				} else if block.Type == "text" && block.Text != "" {
					callback(ai.StreamChunk{Content: block.Text})
				}
			}
		case "content_block_delta":
			if event.Delta.Type == "thinking_delta" && event.Delta.Thinking != "" {
				callback(ai.StreamChunk{Thinking: event.Delta.Thinking})
			} else if event.Delta.Text != "" {
				callback(ai.StreamChunk{Content: event.Delta.Text})
			}
		case "result":
			if errMsg, hasError := extractCodeBuddyCLIEventError(event); hasError {
				callback(ai.StreamChunk{Error: errMsg, Done: true})
				_ = cmd.Wait()
				return "", true, fmt.Errorf("CodeBuddy CLI returned an error: %s", errMsg)
			}
			var usage *ai.TokenUsage
			if event.Usage != nil {
				normalized := normalizeClaudeCLIUsage(event.Usage)
				usage = &normalized
			}
			callback(ai.StreamChunk{Done: true, Usage: usage})
			_ = cmd.Wait()
			return currentSessionID, true, nil
		case "error":
			errMsg, _ := extractCodeBuddyCLIEventError(event)
			callback(ai.StreamChunk{Error: errMsg, Done: true})
			_ = cmd.Wait()
			return "", true, fmt.Errorf("CodeBuddy CLI returned an error: %s", errMsg)
		}
	}
	return currentSessionID, false, nil
}
