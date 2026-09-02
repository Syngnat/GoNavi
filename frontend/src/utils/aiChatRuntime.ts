/**
 * Provider-facing context compression is owned by the Go Agent Harness.
 * The UI only keeps this display hint for model-specific input affordances.
 */
export const getDynamicMaxContextChars = (modelName?: string): number => {
  if (!modelName) return 258000;
  const lower = modelName.toLowerCase();

  if (lower.includes('gemini-1.5-pro') || lower.includes('gemini-2') || lower.includes('gemini-3')) {
    return 5000000;
  }
  if (lower.includes('glm-5') || lower.includes('claude-4') || lower.includes('claude-3.7') || lower.includes('gpt-5') || lower.includes('qwen3') || lower.includes('deepseek-v4')) {
    return 1000000;
  }
  if (lower.includes('claude-3-opus') || lower.includes('claude-3.5') || lower.includes('glm-4-long') || lower.includes('qwen-long')) {
    return 1000000;
  }
  if (lower.includes('claude') || lower.includes('deepseek') || lower.includes('gpt-4.5') || lower.includes('qwen2.5')) {
    return 258000;
  }
  if (lower.includes('gpt-4') || lower.includes('gpt-4o') || lower.includes('glm') || lower.includes('z-ai')) {
    return 128000;
  }
  if (lower.includes('qwen')) {
    return 128000;
  }
  return 258000;
};
