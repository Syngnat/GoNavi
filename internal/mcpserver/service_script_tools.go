package mcpserver

import (
	"context"
	"fmt"
	"strings"
	"time"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/scriptlib"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	defaultScriptLibraryLimit  = 200
	maxScriptLibraryLimit      = 1000
	defaultScriptRunWaitSecond = 15
	maxScriptRunWaitSecond     = 60
	scriptRunPollInterval      = 250 * time.Millisecond
)

func (s *Service) GetScriptLibrary(ctx context.Context, req *mcp.CallToolRequest, args getScriptLibraryArgs) (*mcp.CallToolResult, getScriptLibraryResult, error) {
	_ = req

	snapshot, errResult := s.loadScriptLibrary(ctx)
	if errResult != nil {
		return errResult, getScriptLibraryResult{}, nil
	}

	query := strings.ToLower(strings.TrimSpace(args.Query))
	summaries := make([]scriptSummary, 0, len(snapshot.Scripts))
	for _, script := range snapshot.Scripts {
		summary := summarizeScript(script)
		if query != "" && !scriptSummaryMatches(summary, query) {
			continue
		}
		summaries = append(summaries, summary)
	}

	limit := normalizeScriptLibraryLimit(args.Limit)
	total := len(summaries)
	truncated := total > limit
	if truncated {
		summaries = summaries[:limit]
	}
	folders := snapshot.Folders
	if folders == nil {
		folders = []scriptlib.Folder{}
	}

	return successResult(), getScriptLibraryResult{
		Owner:      snapshot.Owner,
		Scripts:    summaries,
		Folders:    folders,
		CanWrite:   snapshot.CanWrite,
		CanShare:   snapshot.CanShare,
		SharedOnly: snapshot.SharedOnly,
		ReadOnly:   snapshot.ReadOnly,
		Total:      total,
		Truncated:  truncated,
	}, nil
}

func (s *Service) GetScript(ctx context.Context, req *mcp.CallToolRequest, args scriptIDArgs) (*mcp.CallToolResult, scriptlib.Script, error) {
	_ = req

	scriptID := strings.TrimSpace(args.ScriptID)
	if scriptID == "" {
		return toolError("scriptId 不能为空"), scriptlib.Script{}, nil
	}
	snapshot, errResult := s.loadScriptLibrary(ctx)
	if errResult != nil {
		return errResult, scriptlib.Script{}, nil
	}
	for _, script := range snapshot.Scripts {
		if script.ID == scriptID {
			return successResult(), script, nil
		}
	}
	return toolError("脚本 %s 不存在，或当前用户无权访问", scriptID), scriptlib.Script{}, nil
}

func (s *Service) SaveScript(ctx context.Context, req *mcp.CallToolRequest, args saveScriptArgs) (*mcp.CallToolResult, scriptlib.Script, error) {
	_ = req

	result := s.backend.SaveScriptLibraryScript(ctx, scriptlib.SaveScriptInput{
		ID:          strings.TrimSpace(args.ID),
		Name:        strings.TrimSpace(args.Name),
		Description: strings.TrimSpace(args.Description),
		Code:        args.Code,
		Visibility:  scriptlib.Visibility(strings.TrimSpace(args.Visibility)),
		FolderID:    strings.TrimSpace(args.FolderID),
		Connections: toScriptLibraryConnections(args.Connections),
		Inputs:      toScriptLibraryInputs(args.Inputs),
		AllowWrite:  args.AllowWrite,
		BatchSize:   args.BatchSize,
		INListLimit: args.INListLimit,
		RunLimits: scriptlib.RunLimits{
			TimeoutMs:        args.TimeoutMs,
			MaxDBCalls:       args.MaxDBCalls,
			MaxOutputRows:    args.MaxOutputRows,
			MemoryLimitBytes: args.MemoryLimitBytes,
		},
		Revision: args.Revision,
	})
	if !result.Success {
		return scriptToolFailure("保存脚本失败", result), scriptlib.Script{}, nil
	}
	script, ok := scriptFromResult(result.Data)
	if !ok {
		return toolError("保存脚本失败: 返回数据格式无效"), scriptlib.Script{}, nil
	}
	return textResult(fmt.Sprintf(
		"脚本已保存：%s\nscriptId=%s，revision=%d，visibility=%s",
		script.Name,
		script.ID,
		script.Revision,
		script.Visibility,
	)), script, nil
}

func (s *Service) ListScriptInputSheets(ctx context.Context, req *mcp.CallToolRequest, args scriptInputSheetsArgs) (*mcp.CallToolResult, scriptInputSheetsResult, error) {
	_ = req

	result := s.backend.ListScriptInputSheets(ctx, appcore.ScriptWorkbenchInput{
		Path:      strings.TrimSpace(args.Path),
		Reference: strings.TrimSpace(args.Reference),
	})
	if !result.Success {
		return scriptToolFailure("读取输入文件工作表失败", result), scriptInputSheetsResult{}, nil
	}
	sheets, err := scriptInputSheetsFromResult(result.Data)
	if err != nil {
		return toolError("解析输入文件工作表失败: %v", err), scriptInputSheetsResult{}, nil
	}
	return textResult(formatScriptInputSheetsContent(sheets)), scriptInputSheetsResult{
		Sheets: ensureNonNilStrings(sheets),
	}, nil
}

func (s *Service) PrepareScriptWrite(ctx context.Context, req *mcp.CallToolRequest, args prepareScriptWriteArgs) (*mcp.CallToolResult, appcore.ScriptWorkbenchWriteApproval, error) {
	_ = req

	result := s.backend.PrepareScriptWorkbenchWrite(ctx, args.toRequest())
	if !result.Success {
		return scriptToolFailure("准备脚本写入审批失败", result), appcore.ScriptWorkbenchWriteApproval{}, nil
	}
	approval, ok := scriptWriteApprovalFromResult(result.Data)
	if !ok {
		return toolError("准备脚本写入审批失败: 返回数据格式无效"), appcore.ScriptWorkbenchWriteApproval{}, nil
	}
	return textResult(formatScriptWriteApprovalContent(approval)), approval, nil
}

func (s *Service) RunScript(ctx context.Context, req *mcp.CallToolRequest, args runScriptArgs) (*mcp.CallToolResult, appcore.ScriptWorkbenchRunSnapshot, error) {
	_ = req

	if strings.TrimSpace(args.ScriptID) == "" && strings.TrimSpace(args.Script) == "" {
		return toolError("scriptId 和 script 至少传一个"), appcore.ScriptWorkbenchRunSnapshot{}, nil
	}
	result := s.backend.RunScriptWorkbench(ctx, args.toRequest())
	if !result.Success {
		return scriptToolFailure("启动脚本失败", result), appcore.ScriptWorkbenchRunSnapshot{}, nil
	}
	snapshot, ok := scriptRunSnapshotFromResult(result.Data)
	if !ok {
		return toolError("启动脚本失败: 返回数据格式无效"), appcore.ScriptWorkbenchRunSnapshot{}, nil
	}

	waitSeconds := normalizeScriptRunWaitSeconds(args.WaitSeconds)
	snapshot = s.waitForScriptRun(ctx, snapshot, waitSeconds)
	return textResult(formatScriptRunContent(snapshot)), snapshot, nil
}

func (s *Service) GetScriptRun(ctx context.Context, req *mcp.CallToolRequest, args scriptRunIDArgs) (*mcp.CallToolResult, appcore.ScriptWorkbenchRunSnapshot, error) {
	_ = req

	runID := strings.TrimSpace(args.RunID)
	if runID == "" {
		return toolError("runId 不能为空"), appcore.ScriptWorkbenchRunSnapshot{}, nil
	}
	result := s.backend.GetScriptWorkbenchRun(ctx, runID)
	if !result.Success {
		return scriptToolFailure("读取脚本运行状态失败", result), appcore.ScriptWorkbenchRunSnapshot{}, nil
	}
	snapshot, ok := scriptRunSnapshotFromResult(result.Data)
	if !ok {
		return toolError("读取脚本运行状态失败: 返回数据格式无效"), appcore.ScriptWorkbenchRunSnapshot{}, nil
	}
	return textResult(formatScriptRunContent(snapshot)), snapshot, nil
}

func (s *Service) GetScriptOutput(ctx context.Context, req *mcp.CallToolRequest, args scriptOutputArgs) (*mcp.CallToolResult, appcore.ScriptWorkbenchOutputPage, error) {
	_ = req

	runID := strings.TrimSpace(args.RunID)
	if runID == "" {
		return toolError("runId 不能为空"), appcore.ScriptWorkbenchOutputPage{}, nil
	}
	page := args.Page
	if page < 1 {
		page = 1
	}
	pageSize := args.PageSize
	if pageSize <= 0 {
		pageSize = 50
	}
	if pageSize > 200 {
		pageSize = 200
	}
	result := s.backend.GetScriptWorkbenchOutput(ctx, runID, args.OutputIndex, page, pageSize)
	if !result.Success {
		return scriptToolFailure("读取脚本输出失败", result), appcore.ScriptWorkbenchOutputPage{}, nil
	}
	output, ok := scriptOutputPageFromResult(result.Data)
	if !ok {
		return toolError("读取脚本输出失败: 返回数据格式无效"), appcore.ScriptWorkbenchOutputPage{}, nil
	}
	return textResult(formatScriptOutputContent(output)), output, nil
}

func (s *Service) CancelScriptRun(ctx context.Context, req *mcp.CallToolRequest, args scriptRunIDArgs) (*mcp.CallToolResult, appcore.ScriptWorkbenchRunSnapshot, error) {
	_ = req

	runID := strings.TrimSpace(args.RunID)
	if runID == "" {
		return toolError("runId 不能为空"), appcore.ScriptWorkbenchRunSnapshot{}, nil
	}
	result := s.backend.CancelScriptWorkbenchRun(ctx, runID)
	if !result.Success {
		return scriptToolFailure("取消脚本运行失败", result), appcore.ScriptWorkbenchRunSnapshot{}, nil
	}
	snapshot, ok := scriptRunSnapshotFromResult(result.Data)
	if !ok {
		return toolError("取消脚本运行失败: 返回数据格式无效"), appcore.ScriptWorkbenchRunSnapshot{}, nil
	}
	return textResult(formatScriptRunContent(snapshot)), snapshot, nil
}

func (s *Service) loadScriptLibrary(ctx context.Context) (appcore.ScriptWorkbenchLibrarySnapshot, *mcp.CallToolResult) {
	if s == nil || s.backend == nil {
		return appcore.ScriptWorkbenchLibrarySnapshot{}, toolError("脚本工作台不可用")
	}
	result := s.backend.GetScriptLibrarySnapshot(ctx)
	if !result.Success {
		return appcore.ScriptWorkbenchLibrarySnapshot{}, scriptToolFailure("读取脚本库失败", result)
	}
	snapshot, ok := scriptLibrarySnapshotFromResult(result.Data)
	if !ok {
		return appcore.ScriptWorkbenchLibrarySnapshot{}, toolError("读取脚本库失败: 返回数据格式无效")
	}
	return snapshot, nil
}

func (s *Service) waitForScriptRun(ctx context.Context, snapshot appcore.ScriptWorkbenchRunSnapshot, waitSeconds int) appcore.ScriptWorkbenchRunSnapshot {
	if waitSeconds <= 0 || scriptRunTerminal(snapshot.Status) || strings.TrimSpace(snapshot.RunID) == "" {
		return snapshot
	}
	deadline := time.Now().Add(time.Duration(waitSeconds) * time.Second)
	ticker := time.NewTicker(scriptRunPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return snapshot
		case <-ticker.C:
			result := s.backend.GetScriptWorkbenchRun(ctx, snapshot.RunID)
			if !result.Success {
				return snapshot
			}
			next, ok := scriptRunSnapshotFromResult(result.Data)
			if !ok {
				return snapshot
			}
			snapshot = next
			if scriptRunTerminal(snapshot.Status) || !time.Now().Before(deadline) {
				return snapshot
			}
		}
	}
}
