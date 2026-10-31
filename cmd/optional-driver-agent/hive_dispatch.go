package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func decodeAgentRequestJSON(raw []byte, req *agentRequest) error {
	if agentDriverType != "hive" {
		return json.Unmarshal(raw, req)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decoder.Decode(req)
}

func handleHiveAgentRequest(parent context.Context, state *agentRuntime, req agentRequest, resp agentResponse) (agentResponse, bool) {
	method := strings.TrimSpace(req.Method)
	_, nativeHive := state.inst.(db.HiveViewProvider)
	if method != "hiveTableWriteCapabilities" && method != "hiveViews" && !(agentDriverType == "hive" && nativeHive && isHiveMetadataMethod(method)) {
		return resp, false
	}
	ctx := parent
	cancel := func() {}
	if req.TimeoutMs > 0 {
		ctx, cancel = context.WithTimeout(parent, time.Duration(req.TimeoutMs)*time.Millisecond)
	}
	defer cancel()
	db.BindMetadataContext(state.inst, ctx)
	defer db.ClearMetadataContext(state.inst)
	var err error
	switch method {
	case "hiveTableWriteCapabilities":
		provider, ok := state.inst.(db.HiveTableWriteCapabilityProvider)
		if !ok {
			return fail(resp, "Hive table write capabilities are not supported"), true
		}
		resp.Data, err = provider.HiveTableWriteCapabilities(ctx, req.TableName)
	case "hiveViews":
		provider, ok := state.inst.(db.HiveViewProvider)
		if !ok {
			return fail(resp, "Hive view metadata is not supported"), true
		}
		resp.Data, err = provider.HiveViews(ctx, req.DBName)
	case agentMethodPreviewChanges:
		return handlePreviewChanges(state.inst, req, resp), true
	case agentMethodGetDatabases:
		resp.Data, err = state.inst.GetDatabases()
	case agentMethodGetTables:
		resp.Data, err = state.inst.GetTables(req.DBName)
	case agentMethodGetCreateStmt:
		resp.Data, err = state.inst.GetCreateStatement(req.DBName, req.TableName)
	case agentMethodGetColumns:
		resp.Data, err = state.inst.GetColumns(req.DBName, req.TableName)
	case agentMethodGetAllColumns:
		resp.Data, err = state.inst.GetAllColumns(req.DBName)
	case agentMethodGetIndexes:
		resp.Data, err = state.inst.GetIndexes(req.DBName, req.TableName)
	case agentMethodGetForeignKey:
		resp.Data, err = state.inst.GetForeignKeys(req.DBName, req.TableName)
	case agentMethodGetTriggers:
		resp.Data, err = state.inst.GetTriggers(req.DBName, req.TableName)
	case agentMethodPing:
		if p, ok := state.inst.(interface{ PingContext(context.Context) error }); ok {
			err = p.PingContext(ctx)
		} else {
			err = state.inst.Ping()
		}
	case agentMethodTableExists:
		if p, ok := state.inst.(db.TableExistsChecker); ok {
			resp.Data, err = p.TableExists(req.DBName, req.TableName)
		} else {
			err = fmt.Errorf("Hive table existence check is not supported")
		}
	}
	if err != nil {
		return fail(resp, err.Error()), true
	}
	return resp, true
}
func isHiveMetadataMethod(method string) bool {
	switch method {
	case agentMethodPreviewChanges, agentMethodGetDatabases, agentMethodGetTables, agentMethodGetCreateStmt, agentMethodGetColumns, agentMethodGetAllColumns, agentMethodGetIndexes, agentMethodGetForeignKey, agentMethodGetTriggers, agentMethodPing, agentMethodTableExists:
		return true
	}
	return false
}

func handleAgentApplyChanges(ctx context.Context, inst db.Database, req agentRequest, resp agentResponse) agentResponse {
	if req.Changes == nil {
		return fail(resp, "change set is empty")
	}
	var err error
	if applier, ok := inst.(db.BatchApplierContext); ok {
		err = applier.ApplyChangesContext(ctx, req.TableName, *req.Changes)
	} else if applier, ok := inst.(db.BatchApplier); ok {
		err = applier.ApplyChanges(req.TableName, *req.Changes)
	} else {
		return fail(resp, "driver does not support ApplyChanges")
	}
	if err != nil {
		resp = fail(resp, err.Error())
		resp.OutcomeUnknown = db.IsWriteOutcomeUnknown(err)
	}
	return resp
}

func connectAgentDatabase(ctx context.Context, inst db.Database, config connection.ConnectionConfig) error {
	if connector, ok := inst.(interface {
		ConnectContext(context.Context, connection.ConnectionConfig) error
	}); ok {
		return connector.ConnectContext(ctx, config)
	}
	return inst.Connect(config)
}
