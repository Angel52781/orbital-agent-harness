import { architectOutputContract } from './architect-output.mjs';
import { capabilityCatalog, expandedCapabilities, getAgent } from './registry.mjs';

const PLAN_SCHEMA = 'orbital.sponsor-plan.v1';
const MAX_PACKAGES = 12;
const ALLOWED_PROVIDERS = new Set(['codex', 'antigravity']);
const ALLOWED_WORKER_ROLES = new Set(architectOutputContract().allowedWorkers);
const ROUTING_MODES = new Set(['director-led', 'sponsor-bound', 'legacy-auto']);
const MISSION_BUDGET_LIMITS = Object.freeze({
  maxSteerRounds: 32,
  maxPackageReworkRounds: 16,
  maxReplanRounds: 32,
  maxDirectorReviews: 64,
  maxProviderWaitCycles: 256,
  maxProviderWaitAgeMs: 8 * 24 * 60 * 60 * 1000
});

function fail(code) {
  throw new Error(`sponsor-plan-invalid:${code}`);
}

function text(value, label, { max = 4000, required = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    fail(label);
  }
  if (typeof value !== 'string') fail(label);
  const result = value.trim();
  if ((required && !result) || result.length > max) fail(label);
  return result || null;
}

function strings(value, label, { required = true, maxItems = 20, maxItem = 2000 } = {}) {
  if (value === undefined || value === null) {
    if (!required) return [];
    fail(label);
  }
  if (!Array.isArray(value) || value.length > maxItems) fail(label);
  const result = value.map((item) => text(item, label, { max: maxItem }));
  if (required && result.length === 0) fail(label);
  return result;
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}-field-${key}`);
  }
}

function normalizeComplexity(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim().toLowerCase();
  if (['low', 'routine', 'simple', 'baja', '1', 'fast'].includes(raw)) return 'low';
  if (['normal', 'medium', 'standard', 'media', '2', 'balanced'].includes(raw)) return 'normal';
  if (['high', 'critical', 'complex', 'max', 'alta', '3', 'strong'].includes(raw)) return 'high';
  fail('complexity');
}

function boundedPositiveInteger(value, label, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) fail(label);
  return value;
}

function normalizeRoutingMode(value) {
  // Historical Sponsor plans predate explicit routing ownership. Preserve
  // their exact behavior when they are replayed/resumed, while requiring new
  // callers to opt into either Director-led routing or a deliberately fixed
  // Sponsor-bound graph.
  const mode = value == null ? 'legacy-auto' : text(value, 'routing-mode', { max: 40 });
  if (!ROUTING_MODES.has(mode)) fail('routing-mode');
  return mode;
}

export function normalizeMissionBudget(value) {
  if (value === undefined || value === null) return null;
  exactKeys(value, new Set(Object.keys(MISSION_BUDGET_LIMITS)), 'budget');
  const budget = {};
  for (const [key, max] of Object.entries(MISSION_BUDGET_LIMITS)) {
    if (value[key] === undefined) continue;
    budget[key] = boundedPositiveInteger(value[key], `budget-${key}`, max);
  }
  if (Object.keys(budget).length === 0) fail('budget-empty');
  return Object.freeze(budget);
}

function normalizeRuntimeRequest(value, id) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`package-runtime-request-${id}`);
  }
  let visited = 0;
  const secretKey = /(?:^|[_-])(authorization|cookie|credential|password|secret|token|api[_-]?key)(?:$|[_-])/i;
  const walk = (item, depth = 0) => {
    visited += 1;
    if (visited > 500 || depth > 8) fail(`package-runtime-request-${id}`);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail(`package-runtime-request-${id}`);
      return item;
    }
    if (typeof item === 'string') {
      if (item.length > 4000 || /[\0]/.test(item)) fail(`package-runtime-request-${id}`);
      return item;
    }
    if (Array.isArray(item)) {
      if (item.length > 100) fail(`package-runtime-request-${id}`);
      return item.map((entry) => walk(entry, depth + 1));
    }
    if (!item || typeof item !== 'object') fail(`package-runtime-request-${id}`);
    const output = {};
    const entries = Object.entries(item);
    if (entries.length > 100) fail(`package-runtime-request-${id}`);
    for (const [key, entry] of entries) {
      if (!key || key.length > 120 || secretKey.test(key)) {
        if (secretKey.test(key)) fail(`package-runtime-request-secret-key-${id}:${key}`);
        fail(`package-runtime-request-${id}`);
      }
      output[key] = walk(entry, depth + 1);
    }
    return output;
  };
  const normalized = walk(value);
  if (typeof normalized.action !== 'string' || !normalized.action.trim() || normalized.action.length > 120) {
    fail(`package-runtime-request-${id}`);
  }
  normalized.action = normalized.action.trim();
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 12_000) {
    fail(`package-runtime-request-${id}`);
  }
  return normalized;
}

function normalizePackage(input, index) {
  exactKeys(input, new Set([
    'id', 'objective', 'dependsOn', 'expectedResult', 'validation',
    'modeHint', 'writeScopes', 'preferredRole', 'requestedCapabilities', 'allowedProviders',
    'providerConstraintReason', 'specializations', 'requireArtifact', 'capabilityRequirements',
    'runtimeRequest', 'optional', 'complexity', 'difficulty', 'tier', 'metadata', 'notes', 'tags', 'title'
  ]), `package-${index}`);
  const id = text(input.id, `package-id-${index}`, { max: 64 });
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) fail(`package-id-${index}`);
  const dependsOn = strings(input.dependsOn ?? [], `package-dependencies-${id}`, {
    required: false,
    maxItems: MAX_PACKAGES,
    maxItem: 64
  });
  if (dependsOn.some((value) => !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value))) {
    fail(`package-dependencies-${id}`);
  }
  const validation = input.validation ?? 'evidence-result';
  if (!['non-empty-result', 'evidence-result', 'review-result', 'qa-go', 'release-pass'].includes(validation)) fail(`package-validation-${id}`);
  const requireArtifact = input.requireArtifact ?? false;
  if (typeof requireArtifact !== 'boolean'
      || (requireArtifact && !['qa-go', 'release-pass'].includes(validation))) {
    fail(`package-require-artifact-${id}`);
  }
  const capabilityRequirements = input.capabilityRequirements ?? {};
  if (!capabilityRequirements || typeof capabilityRequirements !== 'object'
      || Array.isArray(capabilityRequirements)
      || Object.keys(capabilityRequirements).some((key) =>
        !['workerPublicHttps', 'ownerHostPublicHttps', 'hostSystemdMutation',
          'browserTools', 'providerToolCalls', 'sharedProviderQuota'].includes(key)
        || typeof capabilityRequirements[key] !== 'boolean')) {
    fail(`package-capability-requirements-${id}`);
  }
  const modeHint = input.modeHint ?? 'read-only';
  if (!['read-only', 'workspace-write'].includes(modeHint)) fail(`package-mode-${id}`);
  if (['qa-go', 'release-pass', 'review-result'].includes(validation) && modeHint !== 'read-only') {
    fail(`package-validation-mode-incompatible-${id}:${validation}:${modeHint}`);
  }
  const writeScopes = strings(input.writeScopes ?? [], `package-write-scopes-${id}`, {
    required: false,
    maxItems: 12,
    maxItem: 500
  }).map(scope => scope.replace(/\/\*+$/, '').replace(/\/+$/, '') || (scope.trim() === '.' ? '.' : ''));
  if (modeHint === 'workspace-write' && writeScopes.length === 0) fail(`package-write-scopes-${id}`);
  if (modeHint === 'read-only' && writeScopes.length > 0) fail(`package-readonly-write-scopes-${id}`);
  for (const rawScope of writeScopes) {
    const clean = String(rawScope || '').trim();
    if (
      !clean
      || clean.startsWith('/')
      || /^[a-zA-Z]:[\\/]/.test(clean)
      || clean === '..'
      || clean.startsWith('../')
      || clean.includes('/../')
      || clean.endsWith('/..')
      || clean.includes('\\')
    ) {
      fail(`package-write-scope-invalid-${id}:${rawScope}`);
    }
  }
  const preferredRole = text(input.preferredRole, `package-preferred-role-${id}`, {
    max: 80,
    required: false
  });
  // Omitted capabilities mean the Sponsor delegates the minimum concrete
  // capability selection to the Director/runtime. An explicit array remains
  // an exact Sponsor contract and keeps the historical strict semantics.
  const requestedCapabilities = !Object.hasOwn(input, 'requestedCapabilities')
    || input.requestedCapabilities === null
    ? null
    : [...new Set(strings(
        input.requestedCapabilities,
        `package-requested-capabilities-${id}`,
        {
          required: false,
          maxItems: 40,
          maxItem: 120
        }
      ))];
  const allowedProviders = input.allowedProviders == null
    ? null
    : [...new Set(strings(input.allowedProviders, `package-allowed-providers-${id}`, {
        required: false,
        maxItems: 3,
        maxItem: 40
      }))];
  if (allowedProviders && (allowedProviders.length === 0
      || allowedProviders.some((provider) => !ALLOWED_PROVIDERS.has(provider)))) {
    fail(`package-allowed-providers-${id}`);
  }
  const providerConstraintReason = text(
    input.providerConstraintReason,
    `package-provider-constraint-reason-${id}`,
    { max: 800, required: false }
  );
  const specializations = input.specializations == null
    ? null
    : [...new Set(strings(input.specializations, `package-specializations-${id}`, {
        required: false,
        maxItems: 12,
        maxItem: 120
      }))];
  const runtimeRequest = normalizeRuntimeRequest(input.runtimeRequest, id);
  const optional = input.optional ?? false;
  if (typeof optional !== 'boolean') fail(`package-optional-${id}`);
  const catalog = new Set(capabilityCatalog());
  for (const capability of requestedCapabilities ?? []) {
    if (!catalog.has(capability)) {
      fail(`package-requested-capability-unknown-${id}:${capability}`);
    }
  }
  if (preferredRole) {
    let agent;
    try {
      agent = getAgent(preferredRole);
    } catch (error) {
      if (error instanceof Error && error.message === `unknown-agent:${preferredRole}`) {
        fail(`package-preferred-role-unknown-${id}:${preferredRole}`);
      }
      throw error;
    }
    if (!agent.runtimePolicy?.allowedModes?.includes(modeHint)) {
      fail(`package-preferred-role-mode-incompatible-${id}:${preferredRole}:${modeHint}`);
    }
    if (!ALLOWED_WORKER_ROLES.has(preferredRole)) {
      fail(`package-preferred-role-not-executable-${id}:${preferredRole}`);
    }
    const ceiling = new Set(expandedCapabilities(agent));
    for (const capability of requestedCapabilities ?? []) {
      if (!ceiling.has(capability)) {
        fail(`package-requested-capability-not-supported-${id}:${preferredRole}:${capability}`);
      }
    }
  }
  return Object.freeze({
    id,
    objective: text(input.objective, `package-objective-${id}`, { max: 8000 }),
    dependsOn: [...new Set(dependsOn)],
    expectedResult: text(input.expectedResult ?? input.objective ?? 'Evidence-backed completion of package objective.', `package-expected-result-${id}`, { max: 3000 }),
    validation,
    requireArtifact,
    capabilityRequirements: { ...capabilityRequirements },
    modeHint,
    writeScopes: [...new Set(writeScopes)],
    preferredRole,
    requestedCapabilities,
    ...(allowedProviders !== null ? { allowedProviders } : {}),
    ...(providerConstraintReason ? { providerConstraintReason } : {}),
    ...(specializations !== null ? { specializations } : {}),
    ...(runtimeRequest !== null ? { runtimeRequest } : {}),
    optional
  });
}

export function validateSponsorPlan(input) {
  exactKeys(input, new Set([
    'schema', 'objective', 'summary', 'acceptance', 'constraints', 'nonGoals',
    'workPackages', 'references', 'allowedProviders', 'providerConstraintReason', 'budget', 'workspaceRoot',
    'routingMode', 'complexity', 'difficulty', 'tier', 'metadata', 'notes', 'tags', 'title', 'project'
  ]), 'root');
  if (input.schema !== PLAN_SCHEMA) fail('schema');
  if (!Array.isArray(input.workPackages)
      || input.workPackages.length < 1
      || input.workPackages.length > MAX_PACKAGES) {
    fail('work-packages');
  }
  const workPackages = input.workPackages.map(normalizePackage);
  const routingMode = normalizeRoutingMode(input.routingMode);
  const ids = new Set(workPackages.map((item) => item.id));
  if (ids.size !== workPackages.length) fail('duplicate-package-id');
  for (const item of workPackages) {
    if (item.dependsOn.includes(item.id)) fail(`package-self-dependency-${item.id}`);
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) fail(`package-dependency-missing-${item.id}:${dependency}`);
    }
  }
  if (routingMode === 'sponsor-bound' && workPackages.some((item) => (
    !item.preferredRole || !Array.isArray(item.requestedCapabilities)
  ))) {
    fail('sponsor-bound-package-not-fully-bound');
  }
  // A research-state or LIVE approval marker can only be promoted by a
  // software-integrator AFTER independent typed QA and release gates have
  // consumed physically attested evidence. A builder cannot opt into state
  // writes by wording a general evidence-result package as an approval.
  const byId = new Map(workPackages.map((item) => [item.id, item]));
  const ancestry = (item, visited = new Set()) => {
    for (const id of item.dependsOn) {
      if (visited.has(id)) continue;
      visited.add(id);
      ancestry(byId.get(id), visited);
    }
    return [...visited].map((id) => byId.get(id));
  };
  for (const pkg of workPackages) {
    const protectedState = pkg.writeScopes.some((scope) =>
      /(?:^|\/)data\/state(?:\/|$)|(?:^|\/)LIVE_COLLECTION_APPROVED(?:\.json)?$/i
        .test(scope.replace(/\\/g, '/')));
    if (!protectedState) continue;
    if (pkg.preferredRole !== 'software-integrator') fail(`protected-state-integrator-only-${pkg.id}`);
    const parents = ancestry(pkg);
    const qa = parents.find((p) => p.validation === 'qa-go' && p.requireArtifact);
    const release = parents.find((p) => p.validation === 'release-pass' && p.requireArtifact
      && qa && ancestry(p).some((ancestor) => ancestor.id === qa.id));
    if (!qa || !release) fail(`protected-state-dual-attested-gate-required-${pkg.id}`);
  }
  const allowedProviders = input.allowedProviders == null
    ? null
    : [...new Set(strings(input.allowedProviders, 'allowed-providers', {
        required: false,
        maxItems: 3,
        maxItem: 40
      }))];
  if (allowedProviders && (allowedProviders.length === 0
      || allowedProviders.some((provider) => !ALLOWED_PROVIDERS.has(provider)))) {
    fail('allowed-providers');
  }
  const providerConstraintReason = text(
    input.providerConstraintReason,
    'provider-constraint-reason',
    { max: 800, required: false }
  );
  const workspaceRoot = text(
    input.workspaceRoot,
    'workspace-root',
    { max: 1000, required: false }
  );
  const budget = normalizeMissionBudget(input.budget);
  const complexity = normalizeComplexity(input.complexity ?? input.difficulty ?? input.tier);
  return Object.freeze({
    schema: PLAN_SCHEMA,
    routingMode,
    objective: text(input.objective, 'objective', { max: 16_000 }),
    summary: text(input.summary ?? input.objective, 'summary', { max: 6000 }),
    acceptance: strings(input.acceptance, 'acceptance', { maxItems: 24, maxItem: 2500 }),
    constraints: strings(input.constraints ?? [], 'constraints', { required: false, maxItems: 24, maxItem: 2500 }),
    nonGoals: strings(input.nonGoals ?? [], 'non-goals', { required: false, maxItems: 24, maxItem: 2500 }),
    ...(allowedProviders !== null ? { allowedProviders } : {}),
    ...(providerConstraintReason ? { providerConstraintReason } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(budget ? { budget } : {}),
    ...(complexity ? { complexity } : {}),
    workPackages,
    references: strings(input.references ?? [], 'references', { required: false, maxItems: 24, maxItem: 1000 })
  });
}

export function sponsorPlanAllowedWriteScopes(plan) {
  return [...new Set(validateSponsorPlan(plan).workPackages.flatMap((item) => item.writeScopes))];
}

export const sponsorPlanSchema = PLAN_SCHEMA;
