import type {
  ScriptConnectionBinding,
  ScriptInputBinding,
} from './scriptWorkbenchTypes';

const SCRIPT_ALIAS_PATTERN = /^[A-Za-z_.-][A-Za-z0-9_.-]*$/;
export const MAX_SCRIPT_ALIAS_LENGTH = 64;

export const normalizeScriptAlias = (
  value: unknown,
  fallback = 'item',
): string => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/^([0-9])/, '_$1')
    .slice(0, MAX_SCRIPT_ALIAS_LENGTH);
  return normalized || fallback;
};

export const uniqueScriptAlias = (
  baseValue: string,
  usedAliases: Iterable<string>,
): string => {
  const used = new Set(Array.from(usedAliases, (alias) => String(alias || '').toLowerCase()));
  const base = normalizeScriptAlias(baseValue);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (true) {
    const suffixText = String(suffix);
    const candidate = `${base.slice(0, MAX_SCRIPT_ALIAS_LENGTH - suffixText.length)}${suffixText}`;
    if (!used.has(candidate)) return candidate;
    suffix += 1;
  }
};

const aliasErrorKeyForValues = (aliases: readonly string[]): string | null => {
  const seen = new Set<string>();
  for (const alias of aliases) {
    const normalized = String(alias || '').trim();
    if (!normalized) return 'script_workbench.settings.alias_required';
    if (normalized.length > MAX_SCRIPT_ALIAS_LENGTH || !SCRIPT_ALIAS_PATTERN.test(normalized)) {
      return 'script_workbench.settings.alias_invalid';
    }
    const comparisonKey = normalized.toLowerCase();
    if (seen.has(comparisonKey)) return 'script_workbench.settings.alias_duplicate';
    seen.add(comparisonKey);
  }
  return null;
};

export const scriptAliasErrorKey = (
  bindings: readonly ScriptConnectionBinding[],
): string | null => aliasErrorKeyForValues(
  bindings.map((binding) => String(binding.alias || '').trim()),
);

export const scriptInputAliasErrorKey = (
  inputs: readonly ScriptInputBinding[],
): string | null => aliasErrorKeyForValues(
  inputs.map((input) => String(input.alias || '').trim()),
);

export const scriptDraftAliasErrorKey = (
  bindings: readonly ScriptConnectionBinding[],
  inputs: readonly ScriptInputBinding[],
): string | null => scriptAliasErrorKey(bindings) || scriptInputAliasErrorKey(inputs);

export const scriptAliasErrorForBinding = (
  bindings: readonly ScriptConnectionBinding[],
  index: number,
): string | null => {
  const alias = String(bindings[index]?.alias || '').trim();
  if (!alias) return 'script_workbench.settings.alias_required';
  if (alias.length > MAX_SCRIPT_ALIAS_LENGTH || !SCRIPT_ALIAS_PATTERN.test(alias)) {
    return 'script_workbench.settings.alias_invalid';
  }
  if (bindings.some((binding, bindingIndex) => (
    bindingIndex !== index
    && String(binding.alias || '').trim().toLowerCase() === alias.toLowerCase()
  ))) {
    return 'script_workbench.settings.alias_duplicate';
  }
  return null;
};
