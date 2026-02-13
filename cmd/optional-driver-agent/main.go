package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type agentRequest struct {
	ID        int64                        `json:"id"`
	Method    string                       `json:"method"`
	Config    *connection.ConnectionConfig `json:"config,omitempty"`
	Query     string                       `json:"query,omitempty"`
	DBName    string                       `json:"dbName,omitempty"`
	TableName string                       `json:"tableName,omitempty"`
	Changes   *connection.ChangeSet        `json:"changes,omitempty"`
}

type agentResponse struct {
	ID           int64       `json:"id"`
	Success      bool        `json:"success"`
	Error        string      `json:"error,omitempty"`
	Data         interface{} `json:"data,omitempty"`
	Fields       []string    `json:"fields,omitempty"`
	RowsAffected int64       `json:"rowsAffected,omitempty"`
}

const (
	agentMethodConnect       = "connect"
	agentMethodClose         = "close"
	agentMethodPing          = "ping"
	agentMethodQuery         = "query"
	agentMethodExec          = "exec"
	agentMethodGetDatabases  = "getDatabases"
	agentMethodGetTables     = "getTables"
	agentMethodGetCreateStmt = "getCreateStatement"
	agentMethodGetColumns    = "getColumns"
	agentMethodGetAllColumns = "getAllColumns"
	agentMethodGetIndexes    = "getIndexes"
	agentMethodGetForeignKey = "getForeignKeys"
	agentMethodGetTriggers   = "getTriggers"
	agentMethodApplyChanges  = "applyChanges"
)

var (
	agentDriverType      string
	agentDatabaseFactory func() db.Database
)

func main() {
	if agentDatabaseFactory == nil || strings.TrimSpace(agentDriverType) == "" {
		fmt.Fprintf(os.Stderr, "未配置驱动代理 provider，请使用 gonavi_<driver>_driver 标签构建\n")
		os.Exit(2)
	}

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 16<<10), 8<<20)
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()

	var inst db.Database
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var req agentRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			_ = writeResponse(writer, agentResponse{
				ID:      req.ID,
				Success: false,
				Error:   fmt.Sprintf("解析请求失败：%v", err),
			})
			continue
		}

		resp := handleRequest(&inst, req)
		if err := writeResponse(writer, resp); err != nil {
			fmt.Fprintf(os.Stderr, "写入响应失败：%v\n", err)
			break
		}
	}

	if inst != nil {
		_ = inst.Close()
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "读取请求失败：%v\n", err)
	}
}

func handleRequest(inst *db.Database, req agentRequest) agentResponse {
	resp := agentResponse{ID: req.ID, Success: true}
	method := strings.TrimSpace(req.Method)

	switch method {
	case agentMethodConnect:
		if req.Config == nil {
			return fail(resp, "连接配置为空")
		}
		if *inst != nil {
			_ = (*inst).Close()
		}
		next := agentDatabaseFactory()
		if next == nil {
			return fail(resp, "驱动代理初始化失败")
		}
		if err := next.Connect(*req.Config); err != nil {
			return fail(resp, err.Error())
		}
		*inst = next
		return resp
	case agentMethodClose:
		if *inst != nil {
			if err := (*inst).Close(); err != nil {
				return fail(resp, err.Error())
			}
			*inst = nil
		}
		return resp
	}

	if *inst == nil {
		return fail(resp, "connection not open")
	}

	switch method {
	case agentMethodPing:
		if err := (*inst).Ping(); err != nil {
			return fail(resp, err.Error())
		}
	case agentMethodQuery:
		data, fields, err := (*inst).Query(req.Query)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
		resp.Fields = fields
	case agentMethodExec:
		affected, err := (*inst).Exec(req.Query)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.RowsAffected = affected
	case agentMethodGetDatabases:
		data, err := (*inst).GetDatabases()
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetTables:
		data, err := (*inst).GetTables(req.DBName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetCreateStmt:
		data, err := (*inst).GetCreateStatement(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetColumns:
		data, err := (*inst).GetColumns(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetAllColumns:
		data, err := (*inst).GetAllColumns(req.DBName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetIndexes:
		data, err := (*inst).GetIndexes(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetForeignKey:
		data, err := (*inst).GetForeignKeys(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodGetTriggers:
		data, err := (*inst).GetTriggers(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case agentMethodApplyChanges:
		if req.Changes == nil {
			return fail(resp, "变更集为空")
		}
		applier, ok := (*inst).(interface {
			ApplyChanges(tableName string, changes connection.ChangeSet) error
		})
		if !ok {
			return fail(resp, "当前驱动不支持 ApplyChanges")
		}
		if err := applier.ApplyChanges(req.TableName, *req.Changes); err != nil {
			return fail(resp, err.Error())
		}
	default:
		return fail(resp, "不支持的方法")
	}

	return resp
}

func writeResponse(writer *bufio.Writer, resp agentResponse) error {
	payload, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if _, err := writer.Write(payload); err != nil {
		return err
	}
	return writer.Flush()
}

func fail(resp agentResponse, errText string) agentResponse {
	resp.Success = false
	resp.Error = strings.TrimSpace(errText)
	return resp
}
