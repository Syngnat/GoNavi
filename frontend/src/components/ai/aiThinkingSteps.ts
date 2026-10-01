/** One step of a model's reasoning summary; `title` is absent for plain reasoning text. */
export interface ThinkingStep {
  title?: string;
  body: string;
}

const TITLE_LINE = /^\*\*([^*\n][^\n]*?)\*\*\s*$/;
const TITLE_PREFIX = /^\*\*([^*\n][^\n]*?)\*\*[ \t]*\n+([\s\S]*)$/;
const UNCLOSED_TITLE = /^\*\*([^*\n][^\n]*)$/;

/**
 * Reasoning summaries (OpenAI Responses and compatible relays) arrive as
 * markdown: a `**Title**` line followed by optional paragraphs, one block per
 * summary part. Parts can be glued together without a blank line while they
 * stream, so `**A****B**` is split back into two titles first.
 */
export const parseThinkingSteps = (text: string): ThinkingStep[] => {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\S)\*\*\*\*(\S)/g, '$1**\n\n**$2')
    .trim();
  if (!normalized) return [];

  const steps: ThinkingStep[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const titleOnly = TITLE_LINE.exec(trimmed) || UNCLOSED_TITLE.exec(trimmed);
    if (titleOnly) {
      steps.push({ title: titleOnly[1].trim(), body: '' });
      continue;
    }
    const titled = TITLE_PREFIX.exec(trimmed);
    if (titled) {
      steps.push({ title: titled[1].trim(), body: titled[2].trim() });
      continue;
    }
    const current = steps[steps.length - 1];
    if (current) current.body = current.body ? `${current.body}\n\n${trimmed}` : trimmed;
    else steps.push({ body: trimmed });
  }
  return steps;
};

/** Visible length of a reasoning text once the markdown title markers are gone. */
export const countThinkingChars = (text: string): number => parseThinkingSteps(text)
  .reduce((total, step) => total + (step.title?.length || 0) + step.body.length, 0);
