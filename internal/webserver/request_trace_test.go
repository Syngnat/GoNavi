package webserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
)

func TestWebInvokeTraceInputDoesNotExposeConnectionSecrets(t *testing.T) {
	payload, err := json.Marshal(connection.ConnectionConfig{
		Type:     "postgres",
		Driver:   "custom-pg",
		Password: "must-not-appear",
	})
	if err != nil {
		t.Fatal(err)
	}
	input := webInvokeTraceInput(invokeRequest{Method: "DBGetTables", Args: []json.RawMessage{payload}})
	if input.Entry != "web" || input.DataSourceType != "postgres" || input.DriverMode != "custom-driver" {
		t.Fatalf("unexpected input: %#v", input)
	}
	if input.RequestID != "" || input.Operation != "web.DBGetTables" {
		t.Fatalf("unexpected trace identity: %#v", input)
	}
}

func TestInvokeResponseExposesRequestIDWithoutChangingResultShape(t *testing.T) {
	payload, err := json.Marshal(invokeResponse{
		RequestID: "web-request-1",
		Result:    map[string]any{"success": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"requestId":"web-request-1"`) || !strings.Contains(string(payload), `"result":{"success":true}`) {
		t.Fatalf("unexpected web invoke payload: %s", payload)
	}
}

func TestHandleInvokeReturnsCorrelatableWebRequestID(t *testing.T) {
	application := appcore.NewApp()
	server := &Server{
		app: application,
		invoker: &methodInvoker{targets: map[string]reflect.Value{
			"test.receiver": reflect.ValueOf(webserverTestReceiver{}),
		}},
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, internalRoutePrefix+"/api/invoke", bytes.NewBufferString(`{
		"namespace":"test","receiver":"receiver","method":"Sum","args":[2,5]
	}`))

	server.handleInvoke(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("invoke status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var response invokeResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.RequestID == "" || recorder.Header().Get("X-GoNavi-Request-ID") != response.RequestID {
		t.Fatalf("missing correlated request ID: header=%q payload=%#v", recorder.Header().Get("X-GoNavi-Request-ID"), response)
	}
	trace, found := appcore.RequestTraceStoreForEntryPoint(application).Get(response.RequestID)
	if !found || trace.Entry != "web" || trace.Operation != "web.Sum" || trace.Status != "success" {
		t.Fatalf("unexpected web trace: found=%v trace=%#v", found, trace)
	}
}
