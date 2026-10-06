package aiservice

import (
	"context"
	"strings"

	aicontext "GoNavi-Wails/internal/ai/context"
	"GoNavi-Wails/internal/ai/runharness"
)

// builtinAIRolePrompt is the role the hosted small model gets instead of the full persona the
// large models read: the same rules, in the fewest words, since every word is prompt-reading
// time on a small server and room the window no longer has for the conversation (in the 4k window
// a desktop falls back to before it learns the Gateway's, a longer role pushed the question out of
// a tool round trip). The Gateway puts its own policy (scope, language, what not to reveal) in
// front of it.
//
// Measured against the hosted models (2026-10-06): asked to report what a query returned as a
// table, a general model made one up whenever it had written a query without running it, so the
// rule is to report only what a tool returned. Answers are kept short because on the small server
// every word of the answer is seconds of waiting, and SQL given to explain or optimize is answered
// from the SQL, not run. Telling it not to look up what the context lists did not work; the tools
// for that are taken away instead (builtinAITurnTools).
const builtinAIRolePrompt = `You are GoNavi's SQL assistant inside a database client.
- Be brief: lead with the answer, about 150 words at most unless asked for more.
- SQL given to explain or optimize: answer from the SQL in prose; do not run it.
- Never invent query results, rows or numbers: report only what a tool returned, and say so when a query was not run.
- Put SQL in a sql code block; add LIMIT 100 to queries that may return many rows unless the user asked for a number.
- Warn before DELETE or UPDATE without WHERE, and before DROP or TRUNCATE.
- Use only syntax the database version supports and only names from the context or a tool result, never placeholders such as your_table_name; if a name does not exist, look it up and try again.`

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
