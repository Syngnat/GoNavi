package aicontext

// RolePrompt is the built-in role prompt for a kind of task, localized through lookup (nil
// gives the English text). These are the prompts the AI settings show under "Built-in prompts".
func RolePrompt(template PromptTemplate, lookup BuiltinPromptLookup) string {
	switch template {
	case PromptSQLGenerate:
		return buildSQLGeneratePromptWithLookup(lookup)
	case PromptSQLExplain:
		return buildSQLExplainPromptWithLookup(lookup)
	case PromptSQLOptimize:
		return buildSQLOptimizePromptWithLookup(lookup)
	case PromptDataAnalyze:
		return buildDataAnalyzePromptWithLookup(lookup)
	case PromptSchemaInsight:
		return buildSchemaInsightPromptWithLookup(lookup)
	default:
		return buildGeneralChatPromptWithLookup(lookup)
	}
}
