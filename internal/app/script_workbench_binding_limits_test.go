package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"GoNavi-Wails/internal/scriptlib"
)

func TestScriptWorkbenchRejectsOversizedRequestBindings(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	ctx := context.Background()
	actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)

	connections := make([]ScriptWorkbenchConnection, scriptlib.MaxBindings+1)
	for index := range connections {
		connections[index].Alias = fmt.Sprintf("connection_%d", index)
	}
	inputs := make([]ScriptWorkbenchInput, scriptlib.MaxBindings+1)
	for index := range inputs {
		inputs[index].Alias = fmt.Sprintf("input_%d", index)
	}

	tests := []struct {
		name    string
		request ScriptWorkbenchRunRequest
	}{
		{
			name: "connections",
			request: ScriptWorkbenchRunRequest{
				Script:      "1 + 1",
				Connections: connections,
			},
		},
		{
			name: "inputs",
			request: ScriptWorkbenchRunRequest{
				Script: "1 + 1",
				Inputs: inputs,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := application.buildScriptWorkbenchPreparedRun(ctx, test.request, actor, webActor)
			if err == nil || !errors.Is(err, scriptlib.ErrInvalid) || !strings.Contains(err.Error(), "too many") {
				t.Fatalf("oversized %s error = %v, want ErrInvalid too many", test.name, err)
			}
		})
	}
}

func TestScriptWorkbenchRejectsOversizedMergedBindings(t *testing.T) {
	tests := []struct {
		name    string
		request func(scriptID string) ScriptWorkbenchRunRequest
	}{
		{
			name: "connections",
			request: func(scriptID string) ScriptWorkbenchRunRequest {
				return ScriptWorkbenchRunRequest{
					ScriptID: scriptID,
					Connections: []ScriptWorkbenchConnection{{
						Alias:        "request_extra",
						ConnectionID: "connection-extra",
					}},
				}
			},
		},
		{
			name: "inputs",
			request: func(scriptID string) ScriptWorkbenchRunRequest {
				return ScriptWorkbenchRunRequest{
					ScriptID: scriptID,
					Inputs: []ScriptWorkbenchInput{{
						Alias:     "request_extra",
						Reference: "input-extra",
					}},
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			application := newScriptWorkbenchTestApp(t, false)
			ctx := context.Background()
			actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)
			input := scriptlib.SaveScriptInput{Name: "binding limit", Code: "1 + 1"}
			for index := 0; index < scriptlib.MaxBindings; index++ {
				if test.name == "connections" {
					input.Connections = append(input.Connections, scriptlib.ConnectionBinding{
						Alias: fmt.Sprintf("library_connection_%d", index),
					})
				} else {
					input.Inputs = append(input.Inputs, scriptlib.InputBinding{
						Alias: fmt.Sprintf("library_input_%d", index),
					})
				}
			}
			saved, err := application.scriptLibraryStore().SaveScript(ctx, actor, input)
			if err != nil {
				t.Fatalf("save library script: %v", err)
			}
			_, err = application.buildScriptWorkbenchPreparedRun(ctx, test.request(saved.ID), actor, webActor)
			if err == nil || !errors.Is(err, scriptlib.ErrInvalid) || !strings.Contains(err.Error(), "after merging") {
				t.Fatalf("oversized merged %s error = %v, want ErrInvalid after merging", test.name, err)
			}
		})
	}
}
