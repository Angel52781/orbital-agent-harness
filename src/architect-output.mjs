import {
  expandedCapabilities,
  getAgent,
  getProfileSpecialization,
  isExecutableAgent
} from './registry.mjs';
import { createWorkGraph } from './work-graph.mjs';

const MAX_NODES = 12;
const MAX_REPLICAS = 3;
const MODEL_CLASS_RANK = { economy: 0, fast: 1, balanced: 2, strong: 3, max: 4 };
const DIRECTOR_MODEL_CLASSES = new Set(['fast', 'balanced', 'strong']);
const ALLOWED_WORKERS = new Set([
  'research-evidence',
  'software-builder',
  'frontend-ux-engineer',
  'code-auditor',
  'qa-e2e',
  'security-reviewer',
  'reliability-observability',
  'software-integrator',
  'release-auditor',
  'art-director',
  'product-ux-designer',
  'visual-systems-designer',
  'content-director',
  'editorial-producer',
  'social-content-producer',
  'video-editor',
  'growth-director',
  'data-acquisition-scraping',
  'outbound-strategist',
  'sales-engineer'
]);

function fail(code) {
  throw new Error(`architect-output-invalid:${code}`);
}

function strings(value, field, { maxItems = 100, required = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return [];
    fail(field);
  }
  if (!Array.isArray(value)) {
    fail(field);
  }
  if (value.some((item) => item !== null && item !== undefined && typeof item !== 'string' && typeof item !== 'object')) {
    fail(field);
  }
  const cleaned = value
    .map((item) => (typeof item === 'string' ? item.trim() : (item && typeof item === 'object' ? JSON.stringify(item) : '')))
    .filter(Boolean)
    .slice(0, maxItems);
  if (required && value.length > 0 && cleaned.length === 0) fail(field);
  return cleaned;
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field);
  return value;
}

function exactKeys(value, allowed, field) {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) fail(`${field}-unknown-fields:${extra.sort().join(',')}`);
}

function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) fail('empty');
  const fenced = raw.match(/^\s*\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`\s*$/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) fail('json');
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    fail('json');
  }
}

function normalizeValidation(value) {
  if (value === undefined) return { type: 'dispatcher-ok' };
  const input = object(value, 'validation');
  exactKeys(input, new Set(['type', 'requireArtifact']), 'validation');
  const allowed = new Set(['dispatcher-ok', 'non-empty-result', 'evidence-result', 'review-result', 'qa-go', 'release-pass']);
  if (!allowed.has(input.type)) fail('validation-type');
  if (input.requireArtifact !== undefined && (typeof input.requireArtifact !== 'boolean'
      || (input.requireArtifact && !['qa-go', 'release-pass'].includes(input.type)))) {
    fail('validation-require-artifact');
  }
  return { type: input.type, ...(input.requireArtifact ? { requireArtifact: true } : {}) };
}

function normalizeNode(input, index) {
  const node = object(input, `node-${index}`);
  exactKeys(node, new Set([
    'id',
    'logicalAgent',
    'objective',
    'dependsOn',
    'dependencies',
    'expectedResult',
    'expectedArtifact',
    'validation',
    'retryPolicy',
    'replicaCount',
    'replicaObjectives',
    'mode',
    'requestedCapabilities',
    'modelClass',
    'specializations',
    'allowedProviders',
    'capabilityRequirements',
    'writeScopes',
    'sponsorPackageId',
    'optional'
  ]), `node-${index}`);
  if (typeof node.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(node.id)) fail(`node-id-${index}`);
  if (typeof node.logicalAgent !== 'string' || !ALLOWED_WORKERS.has(node.logicalAgent)) {
    fail(`worker-not-allowed-${node.logicalAgent || index}`);
  }
  const agent = getAgent(node.logicalAgent);
  if (!isExecutableAgent(agent)) fail(`worker-not-executable-${node.logicalAgent}`);
  if (typeof node.objective !== 'string' || !node.objective.trim() || node.objective.length > 12_000) {
    fail(`node-objective-${node.id}`);
  }
  const dependsOn = node.dependsOn ?? node.dependencies ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.some((item) => typeof item !== 'string' || !item)) {
    fail(`node-dependencies-${node.id}`);
  }
  const expectedResult = node.expectedResult ?? node.expectedArtifact;
  if (typeof expectedResult !== 'string' || !expectedResult.trim() || expectedResult.length > 4000) {
    fail(`node-expected-result-${node.id}`);
  }
  const replicaCount = node.replicaCount ?? 1;
  if (!Number.isInteger(replicaCount) || replicaCount < 1 || replicaCount > MAX_REPLICAS) {
    fail(`node-replicas-${node.id}`);
  }
  const declaredProviders = node.allowedProviders;
  if (declaredProviders !== undefined && (!Array.isArray(declaredProviders)
      || declaredProviders.length === 0
      || declaredProviders.some((provider) => !['antigravity', 'codex'].includes(provider)))) {
    fail(`node-providers-${node.id}`);
  }
  // More workers must never silently multiply Codex token usage. Independent
  // Antigravity profiles may run replicated tasks; singletons retain normal
  // provider routing unless the Director explicitly restricts the provider.
  if (replicaCount > 1 && declaredProviders !== undefined
      && (declaredProviders.length !== 1 || declaredProviders[0] !== 'antigravity')) {
    fail(`node-replicas-require-antigravity-${node.id}`);
  }
  const allowedProviders = replicaCount > 1 ? ['antigravity']
    : declaredProviders === undefined ? null : [...new Set(declaredProviders)];
  const retry = node.retryPolicy ?? { maxAttempts: 1 };
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) fail(`node-retry-${node.id}`);
  exactKeys(retry, new Set(['maxAttempts', 'backoffMs']), `node-retry-${node.id}`);
  const maxAttempts = retry.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) fail(`node-retry-${node.id}`);

  const requestedCapabilities = node.requestedCapabilities ?? [];
  if (!Array.isArray(requestedCapabilities) || requestedCapabilities.some((item) => typeof item !== 'string')) {
    fail(`node-capabilities-${node.id}`);
  }
  const ceiling = new Set(expandedCapabilities(agent));
  for (const capability of requestedCapabilities) {
    if (!ceiling.has(capability)) fail(`node-capability-exceeds-agent-${node.id}:${capability}`);
  }
  const capabilityRequirements = node.capabilityRequirements ?? {};
  if (!capabilityRequirements || typeof capabilityRequirements !== 'object'
      || Array.isArray(capabilityRequirements)
      || Object.keys(capabilityRequirements).some((key) =>
        !['workerPublicHttps', 'ownerHostPublicHttps', 'hostSystemdMutation',
          'browserTools', 'providerToolCalls', 'sharedProviderQuota'].includes(key)
        || typeof capabilityRequirements[key] !== 'boolean')) {
    fail(`node-capability-requirements-${node.id}`);
  }
  let modelClass = node.modelClass ?? null;
  if (modelClass !== null) {
    if (!DIRECTOR_MODEL_CLASSES.has(modelClass)) fail(`node-model-class-${node.id}`);
    const agentMinimum = agent.modelPolicy?.minimumClass ?? 'economy';
    if ((MODEL_CLASS_RANK[modelClass] ?? -1) < (MODEL_CLASS_RANK[agentMinimum] ?? 0)) {
      modelClass = agentMinimum;
    }
  }
  const specializations = node.specializations ?? [];
  if (!Array.isArray(specializations)
      || specializations.some((name) => typeof name !== 'string' || !name.trim())) {
    fail(`node-specializations-${node.id}`);
  }
  const normalizedSpecializations = [...new Set(specializations.map((name) => name.trim()))];
  for (const name of normalizedSpecializations) {
    try {
      getProfileSpecialization(name, { agentId: node.logicalAgent });
    } catch {
      fail(`node-specialization-not-allowed-${node.id}:${name}`);
    }
  }

  const mode = node.mode ?? (
    ['software-builder', 'social-content-producer', 'video-editor'].includes(node.logicalAgent)
      ? 'workspace-write'
      : 'read-only'
  );
  if (!agent.runtimePolicy.allowedModes.includes(mode)) fail(`node-mode-${node.id}`);
  const writeScopes = node.writeScopes ?? [];
  if (!Array.isArray(writeScopes) || writeScopes.some((item) => typeof item !== 'string' || !item)) {
    fail(`node-write-scopes-${node.id}`);
  }
  if (mode === 'read-only' && writeScopes.length) fail(`node-readonly-write-scope-${node.id}`);
  if (mode === 'workspace-write' && writeScopes.length === 0) fail(`node-write-scope-required-${node.id}`);
  if (mode === 'workspace-write' && replicaCount > 1) fail(`node-replicated-write-${node.id}`);
  const sponsorPackageId = node.sponsorPackageId ?? null;
  if (sponsorPackageId !== null
      && (typeof sponsorPackageId !== 'string'
        || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(sponsorPackageId))) {
    fail(`node-sponsor-package-${node.id}`);
  }
  const optional = node.optional ?? false;
  if (typeof optional !== 'boolean') fail(`node-optional-${node.id}`);

  return {
    id: node.id,
    logicalAgent: node.logicalAgent,
    objective: node.objective.trim(),
    dependsOn: [...new Set(dependsOn)],
    expectedResult: expectedResult.trim(),
    validation: normalizeValidation(node.validation),
    retryPolicy: { maxAttempts, backoffMs: 0 },
    replicaCount,
    replicaObjectives: Array.isArray(node.replicaObjectives) ? node.replicaObjectives : undefined,
    mode,
    requestedCapabilities: [...new Set(requestedCapabilities)].sort(),
    capabilityRequirements: { ...capabilityRequirements },
    modelClass,
    specializations: normalizedSpecializations,
    allowedProviders,
    writeScopes: [...new Set(writeScopes)],
    sponsorPackageId,
    optional,
    replicaWriteScopes: replicaCount === 1 ? [[...new Set(writeScopes)]] : undefined
  };
}

export function parseArchitectOutput(text, {
  project = null,
  task = null,
  surface = 'private'
} = {}) {
  const raw = object(extractJson(text), 'root');
  exactKeys(raw, new Set([
    'schema',
    'current_state',
    'decisions',
    'non_goals',
    'open_gaps',
    'pre_mortem',
    'work_graph',
    'acceptance',
    'build_order'
  ]), 'root');
  if (raw.schema !== undefined && raw.schema !== 'orbital.architect-output.v1') {
    fail('schema');
  }
  const rawGraph = object(raw.work_graph, 'work-graph');
  exactKeys(rawGraph, new Set(['nodes']), 'work-graph');
  const nodes = rawGraph.nodes;
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > MAX_NODES) fail('work-graph-nodes');
  const normalizedNodes = nodes.map(normalizeNode);
  if (normalizedNodes.some((node) => node.logicalAgent === 'software-architect')) {
    fail('architect-self-delegation');
  }
  const ids = new Set(normalizedNodes.map((node) => node.id));
  if (ids.size !== normalizedNodes.length) fail('duplicate-node-id');

  const graph = createWorkGraph({
    project,
    task,
    surface,
    nodes: normalizedNodes
  });
  graph.nodes.forEach((node, index) => {
    node.requestedCapabilities = normalizedNodes[index].requestedCapabilities;
    node.specializations = normalizedNodes[index].specializations;
    node.writeScopes = normalizedNodes[index].writeScopes;
    node.sponsorPackageId = normalizedNodes[index].sponsorPackageId;
    node.optional = normalizedNodes[index].optional;
  });

  return Object.freeze({
    schema: 'orbital.architect-output.v1',
    current_state: strings(raw.current_state, 'current-state'),
    decisions: strings(raw.decisions, 'decisions'),
    non_goals: strings(raw.non_goals, 'non-goals'),
    open_gaps: strings(raw.open_gaps, 'open-gaps', { required: false }),
    pre_mortem: strings(raw.pre_mortem, 'pre-mortem'),
    acceptance: strings(raw.acceptance, 'acceptance'),
    build_order: strings(raw.build_order, 'build-order'),
    work_graph: graph
  });
}

export function architectOutputContract() {
  return Object.freeze({
    schema: 'orbital.architect-output.v1',
    allowedWorkers: [...ALLOWED_WORKERS],
    maxNodes: MAX_NODES,
    maxReplicasPerNode: MAX_REPLICAS
  });
}
