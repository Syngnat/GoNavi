package aiservice

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	aicontext "GoNavi-Wails/internal/ai/context"
	"GoNavi-Wails/internal/ai/runharness"
)

func instructionsService(prompts ai.UserPromptSettings) *Service {
	return &Service{userPromptSettings: prompts}
}

func rolePromptFor(s *Service, template aicontext.PromptTemplate) string {
	localizer := s.serviceLocalizerForLanguage()
	return aicontext.RolePrompt(template, func(key string) string { return serviceTextFromLocalizer(localizer, key, nil) })
}

func databaseWorkspace() *runharness.WorkspaceSnapshot {
	return &runharness.WorkspaceSnapshot{ActiveContext: map[string]any{"connectionId": "conn-1"}}
}

func jvmWorkspace(kind string) *runharness.WorkspaceSnapshot {
	return &runharness.WorkspaceSnapshot{ActiveTabID: "t2", Tabs: []runharness.WorkspaceTab{{ID: "t1", Kind: "query"}, {ID: "t2", Kind: kind}}}
}

func TestLargeModelsGetGoNavisRolePromptForTheTask(t *testing.T) {
	s := instructionsService(ai.UserPromptSettings{})
	chat := s.agentInstructions(context.Background(), runharness.InstructionsRequest{Provider: "openai-1", TaskKind: runharness.AgentTaskKindChat})
	if want := strings.TrimSpace(rolePromptFor(s, aicontext.PromptGeneralChat)); chat != want || want == "" {
		t.Fatalf("chat turns get the general persona, got:\n%s", chat)
	}
	editor := s.agentInstructions(context.Background(), runharness.InstructionsRequest{Provider: "openai-1", TaskKind: runharness.AgentTaskKindQueryEditorGeneration})
	if want := strings.TrimSpace(rolePromptFor(s, aicontext.PromptSQLGenerate)); editor != want || editor == chat {
		t.Fatalf("the SQL editor's generation gets the SQL prompt, got:\n%s", editor)
	}
}

func TestTheBuiltinAIGetsTheShortRole(t *testing.T) {
	s := instructionsService(ai.UserPromptSettings{})
	got := s.agentInstructions(context.Background(), runharness.InstructionsRequest{Provider: builtinAIProviderID})
	if got != builtinAIRolePrompt {
		t.Fatalf("got:\n%s", got)
	}
	if len(got) > 1024 {
		t.Fatalf("the small model's role must stay short: %d bytes", len(got))
	}
}

func TestTheUsersOwnPromptsFollowTheRole(t *testing.T) {
	s := instructionsService(ai.UserPromptSettings{Global: "Answer in Chinese.", Database: "Prefer CTEs.", JVM: "Mind the heap.", JVMDiagnostic: "Use arthas."})
	cases := []struct {
		name      string
		workspace *runharness.WorkspaceSnapshot
		want      []string
		not       []string
	}{
		{"nothing open", nil, []string{"Answer in Chinese."}, []string{"Prefer CTEs.", "Mind the heap.", "Use arthas."}},
		{"a database", databaseWorkspace(), []string{"Answer in Chinese.", "Prefer CTEs."}, []string{"Mind the heap.", "Use arthas."}},
		{"a JVM page", jvmWorkspace("jvm-overview"), []string{"Answer in Chinese.", "Mind the heap."}, []string{"Prefer CTEs.", "Use arthas."}},
		{"the JVM console", jvmWorkspace("jvm-diagnostic"), []string{"Answer in Chinese.", "Use arthas.", "Mind the heap."}, []string{"Prefer CTEs."}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := s.agentInstructions(context.Background(), runharness.InstructionsRequest{Provider: builtinAIProviderID, Workspace: tc.workspace})
			if !strings.HasPrefix(got, builtinAIRolePrompt+"\n\n## The user's own instructions\nAnswer in Chinese.") {
				t.Fatalf("the role, then the person's general prompt:\n%s", got)
			}
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Errorf("missing %q:\n%s", want, got)
				}
			}
			for _, not := range tc.not {
				if strings.Contains(got, not) {
					t.Errorf("%q is for another kind of work:\n%s", not, got)
				}
			}
		})
	}
}

func TestBlankUserPromptsAddNothing(t *testing.T) {
	s := instructionsService(ai.UserPromptSettings{Global: "  ", Database: "\n"})
	got := s.agentInstructions(context.Background(), runharness.InstructionsRequest{Provider: builtinAIProviderID, Workspace: databaseWorkspace()})
	if got != builtinAIRolePrompt {
		t.Fatalf("got:\n%s", got)
	}
	var nilService *Service
	if nilService.agentInstructions(context.Background(), runharness.InstructionsRequest{}) != "" {
		t.Fatal("no service, no instructions")
	}
}
