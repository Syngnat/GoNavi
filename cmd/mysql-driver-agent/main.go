//go:build gonavi_mysql_driver

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

type mysqlAgentRequest struct {
	ID        int64                        `json:"id"`
	Method    string                       `json:"method"`
	Config    *connection.ConnectionConfig `json:"config,omitempty"`
	Query     string                       `json:"query,omitempty"`
	DBName    string                       `json:"dbName,omitempty"`
	TableName string                       `json:"tableName,omitempty"`
	Changes   *connection.ChangeSet        `json:"changes,omitempty"`
}

type mysqlAgentResponse struct {
	ID           int64       `json:"id"`
	Success      bool        `json:"success"`
	Error        string      `json:"error,omitempty"`
	Data         interface{} `json:"data,omitempty"`
	Fields       []string    `json:"fields,omitempty"`
	RowsAffected int64       `json:"rowsAffected,omitempty"`
}

const (
	mysqlAgentMethodConnect       = "connect"
	mysqlAgentMethodClose         = "close"
	mysqlAgentMethodPing          = "ping"
	mysqlAgentMethodQuery         = "query"
	mysqlAgentMethodExec          = "exec"
	mysqlAgentMethodGetDatabases  = "getDatabases"
	mysqlAgentMethodGetTables     = "getTables"
	mysqlAgentMethodGetCreateStmt = "getCreateStatement"
	mysqlAgentMethodGetColumns    = "getColumns"
	mysqlAgentMethodGetAllColumns = "getAllColumns"
	mysqlAgentMethodGetIndexes    = "getIndexes"
	mysqlAgentMethodGetForeignKey = "getForeignKeys"
	mysqlAgentMethodGetTriggers   = "getTriggers"
	mysqlAgentMethodApplyChanges  = "applyChanges"
)

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 16<<10), 8<<20)
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()

	var inst *db.MySQLDB
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var req mysqlAgentRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			_ = writeResponse(writer, mysqlAgentResponse{
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

func handleRequest(inst **db.MySQLDB, req mysqlAgentRequest) mysqlAgentResponse {
	resp := mysqlAgentResponse{
		ID:      req.ID,
		Success: true,
	}

	switch strings.TrimSpace(req.Method) {
	case mysqlAgentMethodConnect:
		if req.Config == nil {
			return fail(resp, "连接配置为空")
		}
		if *inst != nil {
			_ = (*inst).Close()
		}
		next := &db.MySQLDB{}
		if err := next.Connect(*req.Config); err != nil {
			return fail(resp, err.Error())
		}
		*inst = next
		return resp
	case mysqlAgentMethodClose:
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

	switch strings.TrimSpace(req.Method) {
	case mysqlAgentMethodPing:
		if err := (*inst).Ping(); err != nil {
			return fail(resp, err.Error())
		}
	case mysqlAgentMethodQuery:
		data, fields, err := (*inst).Query(req.Query)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
		resp.Fields = fields
	case mysqlAgentMethodExec:
		affected, err := (*inst).Exec(req.Query)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.RowsAffected = affected
	case mysqlAgentMethodGetDatabases:
		data, err := (*inst).GetDatabases()
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case mysqlAgentMethodGetTables:
		data, err := (*inst).GetTables(req.DBName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case mysqlAgentMethodGetCreateStmt:
		data, err := (*inst).GetCreateStatement(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case mysqlAgentMethodGetColumns:
		data, err := (*inst).GetColumns(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case mysqlAgentMethodGetAllColumns:
		data, err := (*inst).GetAllColumns(req.DBName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case mysqlAgentMethodGetIndexes:
		data, err := (*inst).GetIndexes(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case mysqlAgentMethodGetForeignKey:
		data, err := (*inst).GetForeignKeys(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case mysqlAgentMethodGetTriggers:
		data, err := (*inst).GetTriggers(req.DBName, req.TableName)
		if err != nil {
			return fail(resp, err.Error())
		}
		resp.Data = data
	case mysqlAgentMethodApplyChanges:
		if req.Changes == nil {
			return fail(resp, "变更集为空")
		}
		applier, ok := interface{}(*inst).(interface {
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

func writeResponse(writer *bufio.Writer, resp mysqlAgentResponse) error {
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

func fail(resp mysqlAgentResponse, errText string) mysqlAgentResponse {
	resp.Success = false
	resp.Error = strings.TrimSpace(errText)
	return resp
}
