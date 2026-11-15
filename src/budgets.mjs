import { getAgent } from './registry.mjs';

const BYTES_PER_TOKEN = 4;

function positiveInteger(value, fallback = null) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  return fallback;
}

export function executionBudget(agentId) {
  const policy = getAgent(agentId).executionPolicy ?? {};
  const contextBudgetTokens = positiveInteger(policy.contextBudgetTokens);
  const outputBudgetTokens = positiveInteger(policy.outputBudgetTokens);
  return Object.freeze({
    contextBudgetTokens,
    outputBudgetTokens,
    maxPromptBytes: contextBudgetTokens ? contextBudgetTokens * BYTES_PER_TOKEN : null,
    maxOutputBytes: outputBudgetTokens ? outputBudgetTokens * BYTES_PER_TOKEN : null
  });
}

export function usageForText(value) {
  const bytes = Buffer.byteLength(String(value ?? ''), 'utf8');
  return Object.freeze({
    bytes,
    estimatedModelUnits: Math.ceil(bytes / BYTES_PER_TOKEN)
  });
}

export function promptBudgetCheck(agentId, prompt) {
  const budget = executionBudget(agentId);
  const usage = usageForText(prompt);
  return Object.freeze({
    ok: budget.maxPromptBytes === null || usage.bytes <= budget.maxPromptBytes,
    budget,
    usage
  });
}

export function effectiveOutputByteLimit(agentId, requested = null) {
  const budget = executionBudget(agentId);
  const requestedLimit = positiveInteger(requested);
  if (budget.maxOutputBytes === null) return requestedLimit;
  if (requestedLimit === null) return budget.maxOutputBytes;
  return Math.min(requestedLimit, budget.maxOutputBytes);
}

