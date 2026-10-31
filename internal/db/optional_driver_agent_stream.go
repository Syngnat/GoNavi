package db

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
)

const (
	optionalAgentChunkColumns = "columns"
	optionalAgentChunkRows    = "rows"
	optionalAgentChunkDone    = "done"
)

// callStreamQueryGCInterval 控制 callStreamQuery 每接收多少行 driver-agent 数据触发一次 runtime.GC。
//
// 该路径不走 sql.Rows（scan_rows.go 的周期 GC 覆盖不到），但每个 chunk 解码
// [][]interface{} + normalizeQueryValue 转换会产生大量临时字符串，需要主动回收。
// 取 50000 与 scan_rows.go 的 streamRowsPeriodicGCInterval 保持一致，
// 让两端在相近节奏下分别 GC，避免内存峰值叠加。
const callStreamQueryGCInterval = 50000

func (c *optionalDriverAgentClient) callStreamQuery(req optionalAgentRequest, consumer QueryStreamConsumer) error {
	return c.runWithContext(context.Background(), req.Method, func(requestID int64) error {
		return c.callStreamQueryLocked(requestID, req, consumer)
	})
}

// callStreamQueryLocked 在串行传输上执行 streamQuery 并逐帧消费响应。
//
// 传输是行分帧的单向管道：客户端中途放弃消费（列设置、行消费、行解码失败）时，
// agent 仍会把该请求剩余分片写完。剩余帧必须就地排空，否则下一个请求会把它们
// 当作自己的响应，形成跨请求结果串线。排空不可行时强制终止 transport。
func (c *optionalDriverAgentClient) callStreamQueryLocked(requestID int64, req optionalAgentRequest, consumer QueryStreamConsumer) error {
	if consumer == nil {
		return fmt.Errorf("query stream consumer required")
	}

	if err := c.stoppedError(); err != nil {
		return fmt.Errorf("%s 驱动代理传输不可用：%w", driverDisplayName(c.driver), err)
	}

	req.ID = requestID

	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if len(payload) > OptionalDriverAgentMaxJSONLineBytes {
		_ = c.forceTerminate(ErrOptionalDriverAgentJSONLineTooLarge)
		return fmt.Errorf("发送 %s 驱动代理请求失败：%w", driverDisplayName(c.driver), ErrOptionalDriverAgentJSONLineTooLarge)
	}
	if err := c.writeRequestFrame(payload); err != nil {
		stderrText := c.stderrText()
		if stderrText == "" {
			return fmt.Errorf("调用 %s 驱动代理失败：%w", driverDisplayName(c.driver), err)
		}
		return fmt.Errorf("调用 %s 驱动代理失败：%w（stderr: %s）", driverDisplayName(c.driver), err, stderrText)
	}

	var columns []string
	valueConsumer, useValueConsumer := consumer.(QueryStreamValueConsumer)

	// processedRows 用于周期性触发 GC。
	// 该路径不走 sql.Rows，scan_rows.go 的周期 GC 覆盖不到。
	// 每个 chunk 解码会分配 [][]interface{} + normalizeQueryValue 转换副本，
	// 88W 行场景下不主动 GC 会让主进程 RSS 单调爬升。
	var processedRows int64

	for {
		resp, err := c.readOptionalAgentStreamFrame(req.ID)
		if err != nil {
			return err
		}
		if !resp.Success {
			// 失败响应是 agent 为该请求写入的最后一帧，读取到它即代表流已自然终止：
			// 帧边界仍然可信，同一个 transport 可以继续服务下一个请求。
			errText := strings.TrimSpace(resp.Error)
			if errText == "" {
				errText = fmt.Sprintf("%s 驱动代理返回失败", driverDisplayName(c.driver))
			}
			// 单帧超限只代表「这一批数据发不出去」，agent 已就此结束该请求。
			// 若在这里终止 transport，一条超大消息会让整个连接永久不可用。
			if isOptionalAgentOversizeFailure(errText) {
				return ErrOptionalDriverAgentJSONLineTooLarge
			}
			return errors.New(errText)
		}

		switch resp.ChunkType {
		case optionalAgentChunkColumns:
			columns = append(columns[:0], resp.Fields...)
			if err := consumer.SetColumns(columns); err != nil {
				return c.drainAbandonedStream(req.ID, err)
			}
			if err := consumeHiveStreamDefinitions(resp.Data, consumer); err != nil {
				return c.drainAbandonedStream(req.ID, err)
			}
		case optionalAgentChunkRows:
			if len(columns) == 0 {
				return c.drainAbandonedStream(req.ID, fmt.Errorf("%s 驱动代理流式响应缺少列信息", driverDisplayName(c.driver)))
			}
			rows, err := decodeOptionalAgentRowValueBatch(resp.Data)
			if err != nil {
				return c.drainAbandonedStream(req.ID, fmt.Errorf("解析 %s 驱动代理流式数据失败：%w", driverDisplayName(c.driver), err))
			}
			for _, row := range rows {
				if useValueConsumer {
					if err := valueConsumer.ConsumeRowValues(row); err != nil {
						return c.drainAbandonedStream(req.ID, err)
					}
					continue
				}
				entry := make(map[string]interface{}, len(columns))
				for i, column := range columns {
					if i < len(row) {
						entry[column] = row[i]
					} else {
						entry[column] = nil
					}
				}
				if err := consumer.ConsumeRow(entry); err != nil {
					return c.drainAbandonedStream(req.ID, err)
				}
			}
			processedRows += int64(len(rows))
			if processedRows >= callStreamQueryGCInterval {
				runtime.GC()
				processedRows = 0
			}
		case optionalAgentChunkDone:
			return nil
		default:
			return c.drainAbandonedStream(req.ID, fmt.Errorf("%s 驱动代理返回未知流式分片类型：%s", driverDisplayName(c.driver), strings.TrimSpace(resp.ChunkType)))
		}
	}
}

// readOptionalAgentStreamFrame 读取并解析一帧流式响应，强制校验其请求 ID。
//
// 终止帧之前发生读取失败（含流未结束的 EOF 与超限行）或帧解码失败时，无法继续
// 确认帧边界，ID 不匹配则说明串行管道里已经出现别的请求的帧：三种情况都直接
// 终止并标记 transport，由后续连接重建，绝不让可疑帧流入下一个请求。
func (c *optionalDriverAgentClient) readOptionalAgentStreamFrame(requestID int64) (optionalAgentResponse, error) {
	line, err := ReadOptionalDriverAgentJSONLine(c.reader)
	if err != nil {
		_ = c.forceTerminate(err)
		stderrText := c.stderrText()
		if stderrText == "" {
			return optionalAgentResponse{}, fmt.Errorf("读取 %s 驱动代理响应失败：%w", driverDisplayName(c.driver), err)
		}
		return optionalAgentResponse{}, fmt.Errorf("读取 %s 驱动代理响应失败：%w（stderr: %s）", driverDisplayName(c.driver), err, stderrText)
	}

	var resp optionalAgentResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		terminateErr := fmt.Errorf("解析 %s 驱动代理响应失败：%w", driverDisplayName(c.driver), err)
		_ = c.forceTerminate(terminateErr)
		return optionalAgentResponse{}, terminateErr
	}
	if resp.ID != requestID {
		idErr := fmt.Errorf("%s 驱动代理流式响应 ID 不匹配：收到 %d，期望 %d", driverDisplayName(c.driver), resp.ID, requestID)
		_ = c.forceTerminate(idErr)
		return optionalAgentResponse{}, idErr
	}
	return resp, nil
}

// drainAbandonedStream 在消费端中途放弃当前流式请求后，继续读取并丢弃该请求剩余
// 分片，直到出现终止帧（done 或失败响应），保证串行传输上的下一个请求不会读到
// 残留帧。排空过程中由 readOptionalAgentStreamFrame 统一执行终止判定，读取失败、
// 帧解码失败或 ID 不匹配都会终止 transport。始终返回 cause，不掩盖消费端原始错误。
func (c *optionalDriverAgentClient) drainAbandonedStream(requestID int64, cause error) error {
	for {
		resp, err := c.readOptionalAgentStreamFrame(requestID)
		if err != nil {
			return cause
		}
		if !resp.Success || resp.ChunkType == optionalAgentChunkDone {
			return cause
		}
		// columns / rows / 未知分片对放弃消费的请求已无意义，丢弃后继续等待终止帧。
	}
}

// isOptionalAgentOversizeFailure 判断失败帧是否是 agent 主动报告的「单帧超限」。
//
// agent 在写出前检查帧大小，超限时不写任何半帧，而是另写一条小的失败帧：帧边界仍然可信，
// 同一个 transport 可以继续使用。用文案前缀而不是整串相等：上限调整后 MiB 数字会变，
// 前缀才能匹配新旧版本的 agent。
func isOptionalAgentOversizeFailure(errText string) bool {
	return strings.HasPrefix(strings.TrimSpace(errText), "驱动代理 JSON Lines 单帧超过")
}

func decodeOptionalAgentRowValueBatch(data []byte) ([][]interface{}, error) {
	if len(data) == 0 {
		return nil, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var rows [][]interface{}
	if err := decoder.Decode(&rows); err != nil {
		return nil, err
	}
	for rowIdx := range rows {
		for colIdx := range rows[rowIdx] {
			rows[rowIdx][colIdx] = normalizeQueryValue(rows[rowIdx][colIdx])
		}
	}
	return rows, nil
}

func (c *optionalDriverAgentClient) callStreamQueryContext(ctx context.Context, req optionalAgentRequest, consumer QueryStreamConsumer) error {
	return c.runWithContext(ctx, req.Method, func(requestID int64) error {
		return c.callStreamQueryLocked(requestID, req, consumer)
	})
}
