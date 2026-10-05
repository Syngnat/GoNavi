package aiservice

import (
	"context"
	"strings"

	aicontext "GoNavi-Wails/internal/ai/context"
	"GoNavi-Wails/internal/ai/runharness"
)

// builtinAIRolePrompt is the role the hosted small model gets instead of the full persona the
// large models read: the same rules, in the fewest words, since every word is prompt-reading
// time on a small server. The Gateway puts its own policy (scope, language, what not to reveal)
// in front of it.
const builtinAIRolePrompt = `You are GoNavi's SQL assistant inside a database client.
- Put SQL in a fenced code block with the right language tag (sql).
- Add LIMIT 100 to queries that may return many rows.
- Warn clearly before any DELETE or UPDATE without a WHERE clause, and before DROP or TRUNCATE.
- Use only syntax the connected database and its version support.
- Use only connection ids, table and column names you have seen in the context or in a tool result; never invent one and never write placeholders such as your_table_name. To see more, call the tools with the connection id and database given in the context.
- If a query fails because a table or column does not exist, look the names up with a tool and try again.
- After a query, answer with what it returned: how many rows, and a few of them as a markdown table.`

// agentInstructions is what every agent turn starts with: GoNavi's role prompt for the kind of
// task, then what the person wrote under "custom prompts" in the AI settings (the general one,
// and the one for the kind of connection in front of them).
func (s *Service) agentInstructions(_ context.Context, request runharness.InstructionsRequest) string {
	if s == nil {
		return ""
	}
	var role string
	if strings.EqualFold(strings.TrimSpace(request.Provider), builtinAIProviderID) {
		role = builtinAIRolePrompt
	} else {
		template := aicontext.PromptGeneralChat
		if request.TaskKind.Normalize() == runharness.AgentTaskKindQueryEditorGeneration {
			template = aicontext.PromptSQLGenerate
		}
		localizer := s.serviceLocalizerForLanguage()
		role = aicontext.RolePrompt(template, func(key string) string { return serviceTextFromLocalizer(localizer, key, nil) })
	}

	s.mu.RLock()
	prompts := s.userPromptSettings
	s.mu.RUnlock()
	var own []string
	if text := strings.TrimSpace(prompts.Global); text != "" {
		own = append(own, text)
	}
	switch workspaceContextKind(request.Workspace) {
	case "jvm-diagnostic":
		if text := strings.TrimSpace(prompts.JVMDiagnostic); text != "" {
			own = append(own, text)
		}
		fallthrough
	case "jvm":
		if text := strings.TrimSpace(prompts.JVM); text != "" {
			own = append(own, text)
		}
	case "database":
		if text := strings.TrimSpace(prompts.Database); text != "" {
			own = append(own, text)
		}
	}

	parts := []string{strings.TrimSpace(role)}
	if len(own) > 0 {
		parts = append(parts, "## The user's own instructions\n"+strings.Join(own, "\n\n"))
	}
	return strings.Join(parts, "\n\n")
}

// workspaceContextKind says what the person is working on: a JVM (its diagnostic console, or
// the rest), a database connection, or nothing in particular.
func workspaceContextKind(snapshot *runharness.WorkspaceSnapshot) string {
	if snapshot == nil {
		return ""
	}
	for _, tab := range snapshot.Tabs {
		if tab.ID != snapshot.ActiveTabID {
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(tab.Kind))
		switch {
		case kind == "jvm-diagnostic":
			return "jvm-diagnostic"
		case strings.HasPrefix(kind, "jvm"):
			return "jvm"
		}
	}
	if id, _ := snapshot.ActiveContext["connectionId"].(string); strings.TrimSpace(id) != "" {
		return "database"
	}
	return ""
}
