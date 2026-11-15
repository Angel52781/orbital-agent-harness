import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expandedCapabilities, getAgent, getProfileSpecialization } from './registry.mjs';
import { createInstance } from './instance.mjs';
import { lifecycleEvent, redactSecrets } from './events.mjs';
import { appendJsonl, atomicWriteJson, readJson } from './evidence.mjs';
import { validateDeclaredDomainVerdicts, validateRequiredDomainVerdict } from './binding-verdict.mjs';
import { validateReviewResult } from './result-contracts.mjs';
import { classifyExecutionFailure, causalRetryDecision } from './failure-classifier.mjs';
import { acquireExecutionLease, releaseExecutionLease } from './execution-isolation.mjs';
import { materializeQaEvidenceResult } from './attested-artifacts.mjs';
import { preflightNodeCapabilities } from './capability-preflight.mjs';

const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 60_000;
const MODEL_CLASSES = new Set(['fast', 'balanced', 'strong']);

function fail(code) {
  throw new Error(`invalid-work-graph:${code}`);
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail(field);
  return value;
}

function normalizeRetry(value = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('retry-policy');
  const maxAttempts = value.maxAttempts ?? ((value.maxRetries ?? 0) + 1);
  const backoffMs = value.backoffMs ?? 0;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    fail('retry-max-attempts');
  }
  if (!Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > MAX_BACKOFF_MS) {
    fail('retry-backoff');
  }
  return { maxAttempts, backoffMs };
}

function normalizedScope(scope) {
  nonEmptyString(scope, 'write-scope');
  return path.resolve('/', scope);
}

function scopesOverlap(left, right) {
  const a = normalizedScope(left);
  const b = normalizedScope(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

function normalizeReplicaWriteScopes(node, replicaCount) {
  const source = node.replicaWriteScopes ?? node.writeScopes ?? [];
  if (source.length === 0) return Array.from({ length: replicaCount }, () => []);
  if (!Array.isArray(source) || source.length !== replicaCount || source.some((entry) => !Array.isArray(entry))) {
    fail(`replica-write-scopes:${node.id}`);
  }
  const scopes = source.map((entry) => entry.map((scope) => nonEmptyString(scope, 'write-scope')));
  for (let leftReplica = 0; leftReplica < scopes.length; leftReplica += 1) {
    for (let rightReplica = leftReplica + 1; rightReplica < scopes.length; rightReplica += 1) {
      for (const left of scopes[leftReplica]) {
        for (const right of scopes[rightReplica]) {
          if (scopesOverlap(left, right)) fail(`overlapping-replica-write-scopes:${node.id}`);
        }
      }
    }
  }
  return scopes;
}

function normalizeNode(input, graphMode) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('node');
  const id = nonEmptyString(input.id, 'node-id');
  const logicalAgent = nonEmptyString(input.logicalAgent ?? input.agentId, `logical-agent:${id}`);
  const agent = getAgent(logicalAgent);
  const objective = nonEmptyString(input.objective, `objective:${id}`);
  const specializations = input.specializations ?? [];
  if (!Array.isArray(specializations)
      || specializations.some((name) => typeof name !== 'string' || !name.trim())) {
    fail(`specializations:${id}`);
  }
  const normalizedSpecializations = [...new Set(specializations.map((name) => name.trim()))];
  for (const name of normalizedSpecializations) {
    try {
      getProfileSpecialization(name, { agentId: logicalAgent });
    } catch {
      fail(`specialization-not-allowed:${id}:${name}`);
    }
  }
  const dependsOn = [...(input.dependsOn ?? input.dependencies ?? [])];
  if (!dependsOn.every((item) => typeof item === 'string' && item.length > 0)) fail(`dependencies:${id}`);
  if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(id)) fail(`dependencies:${id}`);
  if (!Object.hasOwn(input, 'expectedResult') && !Object.hasOwn(input, 'expectedArtifact')) {
    fail(`expected-result:${id}`);
  }

  const replicaCount = input.replicaCount ?? 1;
  if (!Number.isInteger(replicaCount) || replicaCount < 1) fail(`replica-count:${id}`);
  if (replicaCount > 1 && !agent.parallelInstances) fail(`parallel-instances-not-allowed:${logicalAgent}`);

  const replicaObjectives = input.replicaObjectives === undefined
    ? Array.from({ length: replicaCount }, () => objective)
    : [...input.replicaObjectives];
  if (replicaObjectives.length !== replicaCount
      || replicaObjectives.some((item) => typeof item !== 'string' || item.trim() === '')) {
    fail(`replica-objectives:${id}`);
  }

  const mode = input.mode ?? graphMode ?? null;
  const modelClass = input.modelClass ?? null;
  if (modelClass !== null && !MODEL_CLASSES.has(modelClass)) fail(`model-class:${id}`);
  const requestedCapabilities = input.requestedCapabilities ?? [];
  if (!Array.isArray(requestedCapabilities)
      || requestedCapabilities.some((capability) => typeof capability !== 'string'
        || !expandedCapabilities(agent).includes(capability))) {
    fail(`requested-capabilities:${id}`);
  }
  const sponsorPackageId = input.sponsorPackageId ?? null;
  if (sponsorPackageId !== null && (typeof sponsorPackageId !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(sponsorPackageId))) {
    fail(`sponsor-package:${id}`);
  }
  const allowedProviders = input.allowedProviders ?? null;
  if (allowedProviders !== null && (!Array.isArray(allowedProviders)
      || allowedProviders.length === 0
      || allowedProviders.some((provider) => !['antigravity', 'codex'].includes(provider)))) {
    fail(`allowed-providers:${id}`);
  }
  const isolationKey = input.isolationKey ?? null;
  if (isolationKey !== null) nonEmptyString(isolationKey, `isolation-key:${id}`);
  const replicaWriteScopes = normalizeReplicaWriteScopes(input, replicaCount);
  if (replicaCount > 1 && mode === 'workspace-write'
      && !isolationKey && replicaWriteScopes.some((scopes) => scopes.length === 0)) {
    fail(`replicated-write-requires-isolation:${id}`);
  }

  return {
    id,
    logicalAgent,
    specializations: normalizedSpecializations,
    objective,
    dependsOn,
    expectedResult: input.expectedResult ?? input.expectedArtifact,
    validation: input.validation ?? { type: 'dispatcher-ok' },
    requestedCapabilities: [...new Set(requestedCapabilities)].sort(),
    sponsorPackageId,
    allowedProviders: allowedProviders === null ? null : [...new Set(allowedProviders)],
    ...(input.runtimeRequest ? { runtimeRequest: structuredClone(input.runtimeRequest) } : {}),
    capabilityRequirements: input.capabilityRequirements ?? {},
    optional: input.optional === true,
    ...(Number.isInteger(input.maxVerificationLoops) && input.maxVerificationLoops >= 0
      ? { maxVerificationLoops: input.maxVerificationLoops }
      : {}),
    retryPolicy: normalizeRetry(input.retryPolicy ?? input.retry),
    state: 'QUEUED',
    replicaCount,
    replicaObjectives,
    mode,
    modelClass,
    isolationKey,
    replicaWriteScopes,
    instances: [],
    result: null,
    reasonCode: null
  };
}

function assertDag(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) fail('duplicate-node-id');
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) fail(`unknown-dependency:${node.id}:${dependency}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail(`cycle:${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const node of nodes) visit(node.id);
}

export function createWorkGraph({
  graphId = `graph-${crypto.randomUUID()}`,
  runId = `run-${crypto.randomUUID()}`,
  project = null,
  task = null,
  surface = null,
  mode = null,
  nodes,
  createdAt = new Date().toISOString()
} = {}) {
  nonEmptyString(graphId, 'graph-id');
  nonEmptyString(runId, 'run-id');
  if (!Array.isArray(nodes) || nodes.length === 0) fail('nodes');
  if (surface !== null && !['private', 'team'].includes(surface)) fail('surface');
  if (mode !== null && !['read-only', 'workspace-write'].includes(mode)) fail('mode');
  const normalizedNodes = nodes.map((node) => normalizeNode(node, mode));
  assertDag(normalizedNodes);
  return {
    schema: 'orbital.work-graph.v1',
    graphId,
    runId,
    project,
    task,
    surface,
    mode,
    state: 'QUEUED',
    nodes: normalizedNodes,
    createdAt,
    updatedAt: createdAt,
    completedAt: null
  };
}

export function validateWorkGraph(graph) {
  if (graph?.schema !== 'orbital.work-graph.v1') fail('schema');
  nonEmptyString(graph.graphId, 'graph-id');
  nonEmptyString(graph.runId, 'run-id');
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) fail('nodes');
  assertDag(graph.nodes);
  return graph;
}

export function prepareWorkGraphResume(inputGraph, fromNodeId, {
  runId = 'resume-' + crypto.randomUUID(),
  at = new Date().toISOString(),
  preserveFromNodeCheckpoint = true,
  steering = null
} = {}) {
  validateWorkGraph(inputGraph);
  nonEmptyString(fromNodeId, 'resume-node-id');
  const graph = structuredClone(inputGraph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  if (!byId.has(fromNodeId)) fail('resume-node-not-found:' + fromNodeId);

  const affected = new Set([fromNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (affected.has(node.id)) continue;
      if (node.dependsOn.some((dependency) => affected.has(dependency))) {
        affected.add(node.id);
        changed = true;
      }
    }
  }

  for (const node of graph.nodes) {
    if (!affected.has(node.id)) {
      if (node.state !== 'PASS') fail('resume-nonpass-outside-scope:' + node.id);
      continue;
    }
    const lastInstance = Array.isArray(node.instances) ? node.instances.at(-1) : null;
    const priorCheckpoint = node.resumeCheckpoint ?? null;
    node.resumeCheckpoint = node.id === fromNodeId && !preserveFromNodeCheckpoint
      ? null
      : {
          previousState: node.state,
          previousReasonCode: node.reasonCode ?? null,
          previousResult: lastInstance?.result ?? node.result ?? null,
          priorCheckpoint
        };
    if (steering && node.id !== fromNodeId) {
      node.deltaVerificationScope = {
        mode: 'STEER_DELTA',
        steeredNodeId: fromNodeId,
        directive: steering.directive ?? null,
        instruction: 'Verifica ÚNICAMENTE el ajuste quirúrgico aplicado en ' + fromNodeId + '. Prohibido re-auditar módulos, tests o capturas cuyos archivos no cambiaron (PASS_LOCKED).'
      };
    }
    node.state = 'QUEUED';
    node.instances = [];
    node.result = null;
    node.reasonCode = null;
  }
  graph.runId = runId;
  graph.state = 'QUEUED';
  graph.updatedAt = at;
  graph.completedAt = null;
  return graph;
}

export function prepareWorkGraphPackageRework(inputGraph, packageId, {
  runId = 'rework-' + crypto.randomUUID(),
  at = new Date().toISOString(),
  directive = null
} = {}) {
  validateWorkGraph(inputGraph);
  nonEmptyString(packageId, 'rework-package-id');
  const graph = structuredClone(inputGraph);
  const packageNodes = graph.nodes.filter(
    (node) => node.sponsorPackageId === packageId || node.id === packageId
  );
  if (packageNodes.length === 0) fail('rework-package-not-found:' + packageId);

  const packageNodeIds = new Set(packageNodes.map((node) => node.id));
  const affected = new Set(packageNodeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (affected.has(node.id)) continue;
      if (node.dependsOn.some((dependency) => affected.has(dependency))) {
        affected.add(node.id);
        changed = true;
      }
    }
  }

  for (const node of graph.nodes) {
    if (!affected.has(node.id)) {
      if (node.state !== 'PASS') fail('rework-nonpass-outside-scope:' + node.id);
      continue;
    }
    const lastInstance = Array.isArray(node.instances) ? node.instances.at(-1) : null;
    const priorCheckpoint = node.resumeCheckpoint ?? null;
    node.resumeCheckpoint = {
      previousState: node.state,
      previousReasonCode: node.reasonCode ?? null,
      previousResult: lastInstance?.result ?? node.result ?? null,
      priorCheckpoint,
      ...(packageNodeIds.has(node.id) && directive ? {
        controlPlanePackageRework: {
          classification: 'PACKAGE_REWORK',
          packageId,
          directive,
          appliedAt: at
        }
      } : {})
    };
    if (!packageNodeIds.has(node.id)) {
      node.deltaVerificationScope = {
        mode: 'PACKAGE_REWORK_DELTA',
        reworkedPackageId: packageId,
        reworkedNodeIds: [...packageNodeIds],
        directive: directive ?? null,
        instruction: 'Re-evalúa ÚNICAMENTE el bloque rehecho (' + packageId + ') y sus interfaces directas. Los demás paquetes continúan en PASS_LOCKED.'
      };
    }
    node.state = 'QUEUED';
    node.instances = [];
    node.result = null;
    node.reasonCode = null;
  }
  graph.runId = runId;
  graph.state = 'QUEUED';
  graph.updatedAt = at;
  graph.completedAt = null;
  return graph;
}

export async function saveWorkGraph(file, graph) {
  validateWorkGraph(graph);
  await atomicWriteJson(file, graph);
}

export async function loadWorkGraph(file) {
  return validateWorkGraph(await readJson(file));
}

/** Serialize checkpoint writes for one running graph. Atomic rename alone
 * prevents partial files, not old async writes from landing after newer ones.
 * Request order is preserved even under parallel node transitions.
 */
export function serialGraphPersister(graph, { stateFile, now, save = saveWorkGraph }) {
  let tail = Promise.resolve();
  return function persist() {
    const pending = tail.catch(() => {}).then(async () => {
      graph.updatedAt = now();
      await save(stateFile, graph);
    });
    tail = pending;
    return pending;
  };
}

function selectEnvelope(node, replica, options, graph) {
  const resolver = options.envelopeFor ?? options.envelopeResolver ?? options.resolveEnvelope;
  if (typeof resolver === 'function') return resolver({ node, replica, graph });
  if (options.envelopes) return options.envelopes[node.id] ?? options.envelopes[node.logicalAgent];
  return options.envelope ?? options.runtimeEnvelope;
}

function selectedProvider(result) {
  const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
  const successfulAttempt = [...attempts].reverse().find((attempt) => attempt.status === 'PASS' || attempt.ok === true);
  const lastAttempt = attempts.at(-1);
  const selection = result?.selection?.recommendation;
  const candidate = successfulAttempt ?? lastAttempt ?? selection ?? {};
  return {
    provider: result?.provider ?? candidate.provider ?? null,
    model: result?.model ?? candidate.model?.id ?? candidate.model ?? null
  };
}

function safeDispatchSummary(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    failureDiagnostic: result.failureDiagnostic ?? null,
    independence: result.independence ?? null,
    attempts: Array.isArray(result.attempts) ? result.attempts.map((attempt) => ({
      provider: attempt.provider ?? null,
      model: attempt.model?.id ?? attempt.model ?? null,
      status: attempt.status ?? null,
      errorClass: attempt.errorClass ?? null,
      providerReasonCode: attempt.providerReasonCode ?? null,
      startedAt: attempt.startedAt ?? null,
      finishedAt: attempt.finishedAt ?? attempt.completedAt ?? null,
      quota: attempt.provider === 'codex' && attempt.quotaTelemetry
        ? {
            before: {
              severity: attempt.quotaTelemetry.before?.severity ?? null,
              primaryRemainingPercent: attempt.quotaTelemetry.before?.primary?.remainingPercent ?? null,
              secondaryRemainingPercent: attempt.quotaTelemetry.before?.secondary?.remainingPercent ?? null
            },
            after: {
              severity: attempt.quotaTelemetry.after?.severity ?? null,
              primaryRemainingPercent: attempt.quotaTelemetry.after?.primary?.remainingPercent ?? null,
              secondaryRemainingPercent: attempt.quotaTelemetry.after?.secondary?.remainingPercent ?? null
            },
            delta: attempt.quotaTelemetry.delta ?? null
          }
        : null
    })) : []
  };
}

function fieldAt(value, field) {
  return field.split('.').reduce((current, segment) => current?.[segment], value);
}

function structuredWorkerStatus(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const status = value.status ?? value.state;
    return typeof status === 'string' ? status.trim().toUpperCase() : null;
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const fenced = raw.match(/^\s*\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`\s*$/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const status = parsed.status ?? parsed.state;
    return typeof status === 'string' ? status.trim().toUpperCase() : null;
  } catch {
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 20);
    for (const line of lines) {
      const normalized = line.replace(/^#{1,6}\s*/, '').replace(/[\*_`]/g, '').trim();
      const match = normalized.match(
        /^(?:(?:verdict|veredicto|status|estado)\s*:\s*)?(BLOCKED|NEEDS_HUMAN|FAIL(?:ED)?|ERROR)(?:\s*[:—-]|\s*$)/i
      );
      if (match) return match[1].toUpperCase();
    }
    return null;
  }
}

function structuredWorkerObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return structuredClone(value);
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const fenced = raw.match(/^\s*\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`\s*$/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isMutatingNode(node) {
  if (!node) return false;
  if (node.mode === 'workspace-write') return true;
  return Array.isArray(node.instances) && node.instances.some((inst) => inst.mode === 'workspace-write');
}

function selectSurgicalBuilders(candidateBuilders, feedback, criticNode, byId) {
  if (candidateBuilders.length <= 1) return candidateBuilders;

  const rawCorpus = [
    ...(feedback?.findings ?? []),
    ...(criticNode?.result ?? []).map((item) => typeof item === 'string' ? item : JSON.stringify(item ?? ''))
  ].join(' ').toLowerCase();

  // 1. Check explicit targetNodeId in structured critic output
  for (const raw of (criticNode?.result ?? [])) {
    const parsed = structuredWorkerObject(raw);
    const explicitTarget = parsed?.evidence?.targetNodeId
      ?? parsed?.evidence?.nodeId
      ?? parsed?.targetNodeId
      ?? null;
    if (typeof explicitTarget === 'string' && explicitTarget.trim()) {
      const exact = candidateBuilders.filter(
        (b) => b.id === explicitTarget.trim() || b.sponsorPackageId === explicitTarget.trim()
      );
      if (exact.length > 0) return exact;
    }
  }

  // 2. Match builder id, sponsorPackageId, or writeScopes against findings text
  const scored = candidateBuilders.map((builder) => {
    let score = 0;
    if (builder.id && rawCorpus.includes(builder.id.toLowerCase())) score += 4;
    if (builder.sponsorPackageId && rawCorpus.includes(builder.sponsorPackageId.toLowerCase())) score += 3;
    const scopes = [
      ...(builder.writeScopes ?? []),
      ...((builder.replicaWriteScopes ?? []).flat())
    ].filter((s) => typeof s === 'string' && s.trim());
    for (const rawScope of scopes) {
      const cleanScope = rawScope.replace(/\/\*+$/, '').replace(/^\.\/+/, '').toLowerCase();
      if (!cleanScope || cleanScope === '.') continue;
      if (rawCorpus.includes(cleanScope)) {
        score += 5;
      } else {
        const parts = cleanScope.split('/').filter((seg) => seg.length >= 4 && !['src', 'lib', 'app', 'test', 'docs', 'features', 'presentation', 'screens', 'widgets'].includes(seg));
        for (const seg of parts) {
          if (rawCorpus.includes(seg)) score += 2;
        }
      }
    }
    return { builder, score };
  });

  const maxScore = Math.max(...scored.map((item) => item.score));
  if (maxScore > 0) {
    const matched = scored.filter((item) => item.score > 0).map((item) => item.builder);
    if (matched.length > 0 && matched.length < candidateBuilders.length) {
      return matched;
    }
  }

  // 3. Fallback: pick only leaf mutating builders (closest upstream to criticNode)
  // rather than resetting earlier upstream stages that feed into later builders.
  const builderIds = new Set(candidateBuilders.map((b) => b.id));
  const upstreamOfOtherBuilder = new Set();
  for (const b of candidateBuilders) {
    const q = [...(b.dependsOn ?? [])];
    const seen = new Set();
    while (q.length > 0) {
      const depId = q.shift();
      if (seen.has(depId)) continue;
      seen.add(depId);
      if (builderIds.has(depId)) upstreamOfOtherBuilder.add(depId);
      const depNode = byId.get(depId);
      if (depNode) q.push(...(depNode.dependsOn ?? []));
    }
  }
  const leafBuilders = candidateBuilders.filter((b) => !upstreamOfOtherBuilder.has(b.id));
  return leafBuilders.length > 0 ? leafBuilders : candidateBuilders;
}

function findVerificationLoopSubgraph(criticNode, graph, byId, feedback = null) {
  const ancestors = new Set();
  const queue = [...criticNode.dependsOn];
  while (queue.length > 0) {
    const id = queue.shift();
    if (ancestors.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    ancestors.add(id);
    for (const depId of node.dependsOn) queue.push(depId);
  }
  const candidateBuilders = [...ancestors]
    .map((id) => byId.get(id))
    .filter((node) => node && node.state === 'PASS' && isMutatingNode(node));
  if (candidateBuilders.length === 0) return null;

  const builders = selectSurgicalBuilders(candidateBuilders, feedback, criticNode, byId);

  // Requeue only the selected builders, the criticNode itself, and nodes that
  // lie on the directed path between the selected builders and criticNode.
  const downstreamOfBuilders = new Set(builders.map((b) => b.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (downstreamOfBuilders.has(node.id)) continue;
      if (node.dependsOn.some((depId) => downstreamOfBuilders.has(depId))) {
        downstreamOfBuilders.add(node.id);
        changed = true;
      }
    }
  }

  const nodesToRequeue = new Set(builders.map((b) => b.id));
  nodesToRequeue.add(criticNode.id);
  for (const id of ancestors) {
    if (downstreamOfBuilders.has(id)) {
      nodesToRequeue.add(id);
    }
  }
  return {
    builders,
    nodesToRequeue: [...nodesToRequeue].map((id) => byId.get(id)).filter(Boolean)
  };
}

function extractVerificationLoopFeedback(criticNode, round) {
  const findings = [];
  let verdict = criticNode.reasonCode ?? 'REVISE';
  for (const raw of (criticNode.result ?? [])) {
    const parsed = structuredWorkerObject(raw);
    const ev = parsed?.evidence ?? {};
    verdict = ev.auditVerdict ?? ev.releaseVerdict ?? ev.reviewVerdict ?? verdict;
    const rawList = ev.findings ?? ev.defects ?? ev.issues ?? [];
    if (Array.isArray(rawList)) {
      for (const item of rawList) {
        findings.push(typeof item === 'string' ? item : JSON.stringify(item));
      }
    } else if (typeof rawList === 'string' && rawList.trim()) {
      findings.push(rawList.trim());
    }
    for (const singleKey of ['finding', 'reason', 'summary', 'message']) {
      if (typeof ev[singleKey] === 'string' && ev[singleKey].trim()) {
        findings.push(ev[singleKey].trim());
      }
    }
  }
  return redactSecrets({
    round,
    reviewerNodeId: criticNode.id,
    reviewerAgent: criticNode.logicalAgent,
    reasonCode: criticNode.reasonCode ?? 'REVIEW_REVISE',
    verdict: String(verdict),
    findings: [...new Set(findings)].slice(0, 25)
  });
}

function documentsArtifactRequired(node) {
  return node.specializations?.includes('documents-presentations')
    && /\b(pdf|pptx|docx|xlsx|markdown|json)\b/i.test(String(node.expectedResult ?? ''));
}

async function materializeDeclaredDocumentArtifacts(node, dispatchResult, options) {
  if (!node.specializations?.includes('documents-presentations')) {
    return { ok: true, result: dispatchResult?.result, artifactRefs: [] };
  }
  const parsed = structuredWorkerObject(dispatchResult?.result);
  const declared = parsed?.evidence?.artifacts;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    return documentsArtifactRequired(node)
      ? { ok: false, reasonCode: 'DOCUMENT_ARTIFACTS_NOT_DECLARED' }
      : { ok: true, result: dispatchResult?.result, artifactRefs: [] };
  }
  const entries = Object.entries(declared).filter(([, value]) => typeof value === 'string' && value.trim());
  if (entries.length === 0) {
    return documentsArtifactRequired(node)
      ? { ok: false, reasonCode: 'DOCUMENT_ARTIFACTS_NOT_DECLARED' }
      : { ok: true, result: dispatchResult?.result, artifactRefs: [] };
  }
  const executionRoot = path.dirname(options.stateFile);
  const destinationRoot = path.join(executionRoot, 'artifacts', node.id);
  const defaultSourceRoots = [
    '/srv/orbital/runtimes/private/state/agy-profiles',
    '/srv/orbital/runtimes/team/state/agy-profiles'
  ];
  const sourceRoots = (options.artifactSourceRoots ?? defaultSourceRoots).map((item) => path.resolve(item));
  const artifactRefs = [];
  const rewritten = { ...declared };
  await fs.mkdir(destinationRoot, { recursive: true });
  for (const [name, sourceValue] of entries) {
    const source = path.resolve(sourceValue);
    let realSource;
    try {
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 25 * 1024 * 1024) {
        return { ok: false, reasonCode: 'DOCUMENT_ARTIFACT_INVALID' };
      }
      realSource = await fs.realpath(source);
    } catch {
      return { ok: false, reasonCode: 'DOCUMENT_ARTIFACT_MISSING' };
    }
    if (!sourceRoots.some((root) => realSource === root || realSource.startsWith(`${root}${path.sep}`))) {
      return { ok: false, reasonCode: 'DOCUMENT_ARTIFACT_SOURCE_NOT_ALLOWED' };
    }
    const extension = path.extname(realSource).toLowerCase();
    if (!['.pdf', '.md', '.json', '.pptx', '.docx', '.xlsx'].includes(extension)) {
      return { ok: false, reasonCode: 'DOCUMENT_ARTIFACT_EXTENSION_NOT_ALLOWED' };
    }
    const destination = path.join(destinationRoot, path.basename(realSource));
    await fs.copyFile(realSource, destination);
    rewritten[name] = destination;
    artifactRefs.push(path.relative(executionRoot, destination));
  }
  parsed.evidence = { ...parsed.evidence, artifacts: rewritten };
  return {
    ok: true,
    result: JSON.stringify(parsed),
    artifactRefs
  };
}

async function validateDispatch(validation, result, validators, context) {
  const type = validation?.type ?? 'dispatcher-ok';
  if (type === 'dispatcher-ok') return { ok: result?.ok === true };
  if (type === 'non-empty-result') {
    const value = result?.result;
    return { ok: value !== null && value !== undefined && value !== '' };
  }
  if (type === 'evidence-result') {
    return validateDeclaredDomainVerdicts(result?.result, {
      snapshot: context?.node?.validation?.snapshot ?? null
    });
  }
  if (type === 'review-result') {
    return validateReviewResult(result?.result);
  }
  if (type === 'qa-go' || type === 'release-pass') {
    return validateRequiredDomainVerdict(
      result?.result,
      type === 'qa-go' ? 'auditVerdict' : 'releaseVerdict',
      type === 'qa-go' ? 'QA_GO' : 'PASS'
    );
  }
  if (type === 'result-field-equals') {
    return { ok: fieldAt(result?.result, validation.field) === validation.equals };
  }
  if (type === 'named') {
    const validator = validators?.[validation.name];
    if (typeof validator !== 'function') fail(`unknown-validator:${validation.name}`);
    const outcome = await validator(result, context);
    return typeof outcome === 'boolean' ? { ok: outcome } : outcome;
  }
  fail(`validation-type:${type}`);
}

function wait(milliseconds) {
  return milliseconds === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDispatchOrHeartbeat(dispatchPromise, heartbeatMs) {
  if (heartbeatMs <= 0) return dispatchPromise;
  let timer = null;
  try {
    return await Promise.race([
      dispatchPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'heartbeat' }), heartbeatMs);
      })
    ]);
  } finally {
    // Promise.race does NOT cancel the losing timer. Without clearTimeout,
    // every successful worker left a live 30s timer that delayed Node exit,
    // slowed controller handoff and accumulated spurious liveness resources.
    if (timer !== null) clearTimeout(timer);
  }
}

export async function runWorkGraph(inputGraph, options = {}) {
  if (typeof options.dispatcher !== 'function') throw new Error('work-graph-runner:missing-dispatcher');
  if (!options.eventFile) throw new Error('work-graph-runner:missing-event-file');
  if (!options.stateFile) throw new Error('work-graph-runner:missing-state-file');

  validateWorkGraph(inputGraph);
  const graph = inputGraph;
  const now = options.now ?? (() => new Date().toISOString());
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 0) {
    throw new Error('work-graph-runner:invalid-heartbeat-ms');
  }

  const persist = serialGraphPersister(graph, { stateFile: options.stateFile, now });

  async function transition(instance, state, meta = {}) {
    const event = lifecycleEvent({
      runId: graph.runId,
      graphId: graph.graphId,
      nodeId: instance.nodeId,
      instanceId: instance.instanceId,
      logicalAgent: instance.logicalAgent,
      replica: instance.replica,
      previousState: instance.state,
      state,
      attempt: instance.attempt,
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      project: graph.project,
      task: graph.task,
      principal: instance.principal ?? null,
      surface: instance.surface,
      mode: instance.mode,
      reasonCode: meta.reasonCode ?? null,
      artifactRefs: meta.artifactRefs ?? instance.artifactRefs ?? [],
      detail: meta.detail ?? null,
      at: now()
    });
    instance.state = state;
    instance.reasonCode = meta.reasonCode ?? null;
    if (meta.provider) instance.lastProvider = meta.provider;
    if (meta.model) instance.lastModel = meta.model;
    if (meta.artifactRefs) instance.artifactRefs = redactSecrets(meta.artifactRefs);
    await appendJsonl(options.eventFile, event);
    await persist();
    return event;
  }

  const resume = options.resume === true;
  if (!resume && graph.nodes.some((node) => node.instances?.length > 0 || node.state !== 'QUEUED')) {
    throw new Error('work-graph-runner:graph-already-started');
  }
  if (resume) {
    for (const node of graph.nodes) {
      if (!['PASS', 'QUEUED'].includes(node.state)) {
        throw new Error('work-graph-runner:invalid-resume-state:' + node.id + ':' + node.state);
      }
      if (node.state === 'QUEUED' && node.instances?.length > 0) {
        throw new Error('work-graph-runner:resume-node-has-instances:' + node.id);
      }
    }
  }

  async function instantiateNodeReplicas(node) {
    for (let replica = 1; replica <= node.replicaCount; replica += 1) {
      const envelope = await selectEnvelope(node, replica, options, graph);
      if (!envelope) throw new Error(`work-graph-runner:missing-envelope:${node.id}:${replica}`);
      if (node.mode !== null && node.mode !== envelope.mode) {
        throw new Error(`work-graph-runner:mode-envelope-mismatch:${node.id}`);
      }
      const isolationKey = node.isolationKey ? `${node.isolationKey}:${replica}` : null;
      const instance = createInstance(node.logicalAgent, {
        runId: graph.runId,
        graphId: graph.graphId,
        nodeId: node.id,
        project: graph.project,
        task: graph.task,
        replica,
        replicaCount: node.replicaCount,
        envelope,
        isolationKey,
        writeScopes: envelope.writeScopes ?? node.replicaWriteScopes[replica - 1]
      });
      node.instances.push(instance);
      await appendJsonl(options.eventFile, instance.event);
    }
  }

  for (const node of graph.nodes) {
    if (resume && node.state === 'PASS') continue;
    await instantiateNodeReplicas(node);
  }
  // Evaluate required network/host/provider capabilities BEFORE dispatch,
  // not after a restricted worker fails the same HTTPS CONNECT repeatedly.
  // The matrix is provided by a host-side observer; unavailable/unknown is
  // never inferred as permission. Graphs without requirements are unchanged.
  let preflightBlocked = false;
  for (const node of graph.nodes) {
    if (resume && node.state === 'PASS') continue;
    const preflight = preflightNodeCapabilities(node.capabilityRequirements, options.capabilityMatrix);
    // External retrieval cannot be reported as an observed result unless the
    // runtime actually granted it. Preserve existing protected-action runtime
    // gates (video generation, credentials, payment, etc.) independently.
    const externalRetrieval = new Set(['web-search', 'source-verification', 'browser', 'playwright', 'firecrawl']);
    const missingEffective = node.instances.flatMap((instance) => {
      const effective = new Set(instance.runtimeEnvelope?.effectiveCapabilities ?? []);
      return (node.requestedCapabilities ?? []).filter((capability) =>
        externalRetrieval.has(capability) && !effective.has(capability));
    });
    const denied = [...new Set(missingEffective)];
    if (!preflight.ok || denied.length > 0) {
      preflightBlocked = true;
      node.state = 'BLOCKED';
      node.reasonCode = denied.length > 0 ? 'REQUESTED_CAPABILITY_NOT_GRANTED' : preflight.reasonCode;
      for (const instance of node.instances) {
        await transition(instance, 'BLOCKED', {
          reasonCode: node.reasonCode,
          detail: { capabilityPreflight: preflight, deniedCapabilities: denied }
        });
      }
    }
  }
  // A failed preflight is local to the affected node. Dependency propagation
  // below blocks only nodes that actually depend on it; independent branches
  // continue. Optional failed nodes therefore cannot stop otherwise viable
  // work merely by existing in the graph.
  if (preflightBlocked) await persist();
  // Hold one lease for ALL mutating node scopes for the entire graph,
  // including its read-only review waves. The project root is resolved by
  // the prepared executor, and leaseStateDir is SHARED across project runs.
  // Direct/unit graph callers may omit both until they opt in deliberately.
  const mutatingScopes = [...new Set(graph.nodes
    .filter((node) => node.mode === 'workspace-write')
    .flatMap((node) => node.instances.flatMap((instance) => instance.writeScopes ?? [])))];
  let executionLease = null;
  if (mutatingScopes.length && options.workspaceRoot && options.leaseStateDir) {
    graph.state = 'WAITING_WRITE_SCOPE';
    await persist();
    let lastWaitReason = null;
    while (!executionLease) {
      const attempt = await acquireExecutionLease({
        stateDir: options.leaseStateDir,
        runId: graph.runId,
        principal: options.principal ?? 'owner',
        workspaceRoot: options.workspaceRoot,
        writeScopes: mutatingScopes
      });
      if (attempt.ok) {
        executionLease = attempt;
        await appendJsonl(options.eventFile, {
          schema: 'orbital.write-scope-event.v1',
          at: now(), runId: graph.runId, type: 'WRITE_SCOPE_ACQUIRED',
          fence: attempt.lease.fence, scopes: attempt.lease.scopes
        });
        break;
      }
      if (!['WRITE_SCOPE_LEASE_HELD', 'WRITE_SCOPE_LEASE_ACQUIRE_BUSY',
        'WRITE_SCOPE_LEASE_RECOVERY_RACE'].includes(attempt.reasonCode)) {
        throw new Error(`work-graph-runner:write-scope-acquire:${attempt.reasonCode}`);
      }
      if (lastWaitReason !== attempt.reasonCode) {
        await appendJsonl(options.eventFile, {
          schema: 'orbital.write-scope-event.v1',
          at: now(), runId: graph.runId, type: 'WRITE_SCOPE_WAITING',
          reasonCode: attempt.reasonCode, holder: attempt.holder ?? null
        });
        lastWaitReason = attempt.reasonCode;
      }
      await wait(options.leaseWaitMs ?? 1000);
    }
  }

  try {
    graph.state = 'RUNNING';
    await persist();

  async function executeReplica(node, instance) {
    const priorRetrySignatures = [];
    for (let attempt = 1; attempt <= node.retryPolicy.maxAttempts; attempt += 1) {
      instance.attempt = attempt;
      await transition(instance, 'RUNNING');
      let dispatchResult;
      try {
        const dependencyResults = Object.fromEntries(
          node.dependsOn.map((dependencyId) => {
            const dependency = graph.nodes.find((candidate) => candidate.id === dependencyId);
            return [dependencyId, dependency?.result ?? null];
          })
        );
        const dependencyNodes = node.dependsOn
          .map((dependencyId) => graph.nodes.find((candidate) => candidate.id === dependencyId))
          .filter(Boolean);
        const mutatingDependencies = dependencyNodes.filter((dependency) => dependency.mode === 'workspace-write');
        const independenceSources = mutatingDependencies.length > 0 ? mutatingDependencies : dependencyNodes;
        const dependencyProviders = [...new Set(
          independenceSources.flatMap((dependency) => (
            (dependency.instances ?? [])
              .filter((candidate) => candidate.state === 'PASS' && candidate.lastProvider)
              .map((candidate) => candidate.lastProvider)
          ))
        )].sort();
        const dispatchPromise = Promise.resolve().then(() => options.dispatcher({
          agentId: node.logicalAgent,
          logicalAgent: node.logicalAgent,
          prompt: node.replicaObjectives[instance.replica - 1],
          objective: node.replicaObjectives[instance.replica - 1],
          expectedResult: node.expectedResult,
          validation: node.validation,
          envelope: instance.runtimeEnvelope,
          runId: graph.runId,
          graphId: graph.graphId,
          nodeId: node.id,
          instanceId: instance.instanceId,
          replica: instance.replica,
          attempt,
          project: graph.project,
          task: graph.task,
          isolationKey: instance.isolationKey,
          writeScopes: instance.writeScopes,
          dependencyResults,
          dependencyProviders,
          verificationLoopFeedback: node.verificationLoopFeedback ?? null,
          verificationLoopRound: node.verificationLoopHistory?.length ?? 0,
          deltaVerificationScope: node.deltaVerificationScope ?? null
        })).then(
          (value) => ({ kind: 'done', value }),
          (error) => ({ kind: 'error', error })
        );

        while (true) {
          const outcome = await waitForDispatchOrHeartbeat(dispatchPromise, heartbeatMs);
          if (outcome.kind === 'heartbeat') {
            await transition(instance, 'RUNNING', {
              reasonCode: 'HEARTBEAT',
              detail: { heartbeat: true }
            });
            continue;
          }
          if (outcome.kind === 'error') throw outcome.error;
          dispatchResult = outcome.value;
          break;
        }
      } catch (error) {
        const diagnostic = classifyExecutionFailure(error, {
          phase: 'dispatch',
          nodeId: node.id,
          dependents: graph.nodes.filter((candidate) => candidate.dependsOn.includes(node.id)).map((candidate) => candidate.id)
        });
        dispatchResult = {
          ok: false,
          reasonCode: 'DISPATCH_EXCEPTION',
          error: { name: error?.name ?? 'Error', message: diagnostic.message },
          failureDiagnostic: diagnostic
        };
      }

      const provider = selectedProvider(dispatchResult);
      let artifactRefs = Array.isArray(dispatchResult?.artifactRefs) ? dispatchResult.artifactRefs : [];
      if (dispatchResult?.ok === true && node.specializations?.includes('documents-presentations')) {
        const materialized = await materializeDeclaredDocumentArtifacts(node, dispatchResult, options);
        if (!materialized.ok) {
          dispatchResult = {
            ...dispatchResult,
            ok: false,
            reasonCode: materialized.reasonCode
          };
        } else {
          dispatchResult = {
            ...dispatchResult,
            result: materialized.result,
            artifactRefs: [...artifactRefs, ...materialized.artifactRefs]
          };
          artifactRefs = dispatchResult.artifactRefs;
        }
      }
      // Build durable reviewer evidence BEFORE validating a model-provided
      // digest. Ordinary evidence results without a serialized QA report stay
      // backwards compatible. A wrong claimed SHA fails at the producer node,
      // not after another release worker has consumed the false handoff.
      if (dispatchResult?.ok === true
          && ['evidence-result', 'qa-go'].includes(node.validation?.type)) {
        const materialized = await materializeQaEvidenceResult(dispatchResult.result, {
          executionRoot: options.executionRoot ?? path.dirname(options.stateFile),
          nodeId: node.id,
          workspaceRoot: options.workspaceRoot ?? null,
          requireArtifact: false
        });
        if (!materialized.ok) {
          dispatchResult = {
            ...dispatchResult, ok: false, reasonCode: materialized.reasonCode,
            failureDiagnostic: materialized.detail ?? null
          };
        } else if (materialized.attested) {
          dispatchResult = {
            ...dispatchResult, result: materialized.result,
            artifactRefs: [...artifactRefs, ...materialized.artifactRefs]
          };
          artifactRefs = dispatchResult.artifactRefs;
        }
      }
      if (dispatchResult?.blocked === true || dispatchResult?.status === 'BLOCKED'
          || dispatchResult?.reasonCode === 'NO_AUTHORIZED_PROVIDER') {
        instance.result = redactSecrets(dispatchResult?.result ?? null);
        await transition(instance, 'BLOCKED', {
          ...provider,
          artifactRefs,
          reasonCode: dispatchResult.reasonCode ?? 'DISPATCH_BLOCKED',
          detail: safeDispatchSummary(dispatchResult)
        });
        return false;
      }

      const workerStatus = structuredWorkerStatus(dispatchResult?.result);
      if (['BLOCKED', 'NEEDS_HUMAN'].includes(workerStatus)) {
        instance.result = redactSecrets(dispatchResult?.result ?? null);
        await transition(instance, 'BLOCKED', {
          ...provider,
          artifactRefs,
          reasonCode: `WORKER_REPORTED_${workerStatus}`,
          detail: safeDispatchSummary(dispatchResult)
        });
        return false;
      }
      if (['FAIL', 'FAILED', 'ERROR'].includes(workerStatus)) {
        instance.result = redactSecrets(dispatchResult?.result ?? null);
        await transition(instance, 'FAIL', {
          ...provider,
          artifactRefs,
          reasonCode: `WORKER_REPORTED_${workerStatus}`,
          detail: safeDispatchSummary(dispatchResult)
        });
        return false;
      }

      let validation = null;
      if (dispatchResult?.ok === true) {
        try {
          validation = await validateDispatch(node.validation, dispatchResult, options.validators, {
            graph, node, instance, executionRoot: options.executionRoot ?? path.dirname(options.stateFile)
          });
        } catch (error) {
          validation = { ok: false, reasonCode: 'VALIDATOR_EXCEPTION', detail: error.message };
        }
      }
      const passed = dispatchResult?.ok === true && validation?.ok === true;
      instance.result = redactSecrets(dispatchResult?.result ?? null);
      if (passed) {
        await transition(instance, 'PASS', {
          ...provider,
          artifactRefs,
          reasonCode: dispatchResult?.reasonCode ?? null,
          detail: safeDispatchSummary(dispatchResult)
        });
        return true;
      }
      // A reviewer can execute successfully yet deny approval. This is a
      // binding domain gate: stop dependents, do not exhaust provider retries,
      // and retain the exact inner verdict as durable evidence.
      if ([
        'INNER_QA_BLOCK', 'INNER_RELEASE_FAIL', 'BINDING_VERDICT_SNAPSHOT_MISMATCH',
        'BINDING_VERDICT_MISSING_OR_REJECTED', 'BINDING_VERDICT_EVIDENCE_DIGEST_MISSING',
        'ATTESTED_QA_ARTIFACT_REQUIRED', 'ATTESTED_ARTIFACT_DRIFT',
        'ATTESTED_ARTIFACT_NOT_REGULAR_FILE', 'ATTESTED_ARTIFACT_OUTSIDE_ROOT',
        'REVIEW_DOMAIN_ROLE_CONFLICT'
      ].includes(validation?.reasonCode)) {
        await transition(instance, 'BLOCKED', {
          ...provider,
          artifactRefs,
          reasonCode: validation.reasonCode,
          detail: { dispatch: safeDispatchSummary(dispatchResult), validation: redactSecrets(validation) }
        });
        return false;
      }

      const reasonCode = dispatchResult?.ok === false
        ? (dispatchResult?.reasonCode ?? 'DISPATCH_FAILED')
        : (validation?.reasonCode ?? dispatchResult?.reasonCode ?? 'VALIDATION_FAILED');
      const lastAttempt = Array.isArray(dispatchResult?.attempts) ? dispatchResult.attempts.at(-1) : null;
      const retryDecision = causalRetryDecision({
        reasonCode: lastAttempt?.providerReasonCode ?? reasonCode,
        diagnostic: dispatchResult?.failureDiagnostic ?? validation?.detail ?? null,
        priorSignatures: priorRetrySignatures
      });
      priorRetrySignatures.push(retryDecision.signature);
      await transition(instance, 'FAIL', {
        ...provider,
        artifactRefs,
        reasonCode,
        detail: { dispatch: safeDispatchSummary(dispatchResult), validation: redactSecrets(validation),
          retryDecision }
      });
      if (attempt < node.retryPolicy.maxAttempts) {
        if (['EVIDENCE_RESULT_NOT_STRUCTURED', 'RESULT_CONTRACT_FAILED',
          'QA_ARTIFACT_SHA256_MISMATCH', 'QA_ARTIFACT_BODY_MISMATCH',
          'QA_ARTIFACT_INVALID_JSON', 'QA_ARTIFACT_DOMAIN_MISMATCH',
          'ATTESTED_QA_ARTIFACT_REQUIRED'].includes(reasonCode) || !retryDecision.retry) {
          break;
        }
        await wait(node.retryPolicy.backoffMs);
        await transition(instance, 'READY', { reasonCode: 'RETRY_SCHEDULED' });
      }
    }
    return false;
  }

  async function executeNode(node) {
    node.state = 'RUNNING';
    const outcomes = await Promise.all(node.instances.map((instance) => executeReplica(node, instance)));
    // Preserve the worker/reviewer payload even when the node is BLOCKED or
    // FAIL. Binding QA can execute successfully and return detailed findings
    // while intentionally denying approval; dropping node.result here forces
    // the Controller/Director to reconstruct diagnostics from events.jsonl.
    // Instance results are already secret-redacted before this aggregation.
    node.result = node.instances.map((instance) => instance.result);
    if (node.instances.some((instance) => instance.state === 'BLOCKED')) {
      node.state = 'BLOCKED';
      const blockedInstance = node.instances.find((instance) => instance.state === 'BLOCKED');
      node.reasonCode = blockedInstance?.reasonCode ?? 'REPLICA_BLOCKED';
    } else if (outcomes.every(Boolean)) {
      node.state = 'PASS';
    } else {
      node.state = 'FAIL';
      const failingInstance = node.instances.find((instance) => instance.state === 'FAIL');
      node.reasonCode = failingInstance?.reasonCode ?? 'RETRY_EXHAUSTED';
    }
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const defaultMaxVerificationLoops = Number.isInteger(options.maxVerificationLoops) ? options.maxVerificationLoops : 2;
  while (graph.nodes.some((node) => node.state === 'QUEUED' || node.state === 'READY')) {
    let changed = true;
    while (changed) {
      changed = false;
      const queued = graph.nodes.filter((node) => node.state === 'QUEUED');
      for (const node of queued) {
        const depNodes = node.dependsOn.map((id) => byId.get(id));
        const requiredFailed = depNodes.some((dep) => !dep.optional && ['FAIL', 'BLOCKED', 'CANCELLED'].includes(dep.state));
        const allTerminal = depNodes.every((dep) => dep.state === 'PASS' || (dep.optional && ['FAIL', 'BLOCKED', 'CANCELLED'].includes(dep.state)));
        if (requiredFailed) {
          node.state = 'BLOCKED';
          const blockedDependencies = node.dependsOn.map((id) => byId.get(id));
          node.reasonCode = blockedDependencies.some((dependency) =>
            String(dependency?.reasonCode ?? '').startsWith('CAPABILITY_PREFLIGHT_')
            || ['BROWSER_CAPABILITY_REQUIRED', 'NETWORK_CAPABILITY_UNVERIFIED', 'HOST_CANARY_REQUIRED',
              'HOST_HTTPS_REQUIRED', 'PROVIDER_TOOL_CAPABILITY_REQUIRED', 'PROVIDER_QUOTA_UNVERIFIED']
              .includes(dependency?.reasonCode))
            ? 'CAPABILITY_PREFLIGHT_DEPENDENCY_NOT_READY'
            : 'DEPENDENCY_NOT_PASS';
          for (const instance of node.instances) {
            await transition(instance, 'BLOCKED', { reasonCode: node.reasonCode });
          }
          changed = true;
        } else if (allTerminal) {
          node.state = 'READY';
          for (const instance of node.instances) await transition(instance, 'READY');
          changed = true;
        }
      }
    }

    const ready = graph.nodes.filter((node) => node.state === 'READY');
    if (ready.length === 0) {
      if (!graph.nodes.some((node) => node.state === 'QUEUED')) break;
      throw new Error('work-graph-runner:no-progress');
    }
    await Promise.all(ready.map(executeNode));

    // In-Graph Verification Loop (Claude Code style): when a Critic / QA /
    // Release reviewer rejects or requests REVISE on work produced by an
    // upstream workspace-write builder, automatically feed the structured
    // findings back to the builder, re-run the builder to fix the micro-defects,
    // and re-verify before ever blocking the graph or escalating to the Director.
    for (const criticNode of ready) {
      const isBindingRejection = criticNode.state === 'BLOCKED'
        && ['INNER_QA_BLOCK', 'INNER_RELEASE_FAIL'].includes(criticNode.reasonCode);
      const isReviewRevise = criticNode.state === 'PASS'
        && criticNode.validation?.type === 'review-result'
        && (criticNode.result ?? []).some((raw) => {
          const parsed = structuredWorkerObject(raw);
          return String(parsed?.evidence?.reviewVerdict ?? '').trim().toUpperCase() === 'REVISE';
        })
        && !graph.nodes.some((candidate) => candidate.dependsOn.includes(criticNode.id) && isMutatingNode(candidate));

      if (!isBindingRejection && !isReviewRevise) continue;
      const maxLoops = criticNode.maxVerificationLoops ?? defaultMaxVerificationLoops;
      const nextRound = (criticNode.verificationLoopCount ?? 0) + 1;
      if (nextRound > maxLoops) continue;

      const feedback = extractVerificationLoopFeedback(criticNode, nextRound);
      const subgraph = findVerificationLoopSubgraph(criticNode, graph, byId, feedback);
      if (!subgraph) continue;

      criticNode.verificationLoopCount = nextRound;
      criticNode.verificationLoopHistory = [...(criticNode.verificationLoopHistory ?? []), feedback];
      criticNode.deltaVerificationScope = {
        mode: 'VERIFICATION_LOOP_DELTA',
        round: nextRound,
        targetBuilders: subgraph.builders.map((b) => b.id),
        priorFindingsToVerify: feedback.findings,
        instruction: 'Verifica ÚNICAMENTE que los hallazgos puntuales de la ronda previa hayan sido corregidos en los archivos tocados. Prohibido re-auditar módulos, tests o capturas que ya estaban aprobados (PASS_LOCKED).'
      };
      graph.verificationLoopEvents = [
        ...(graph.verificationLoopEvents ?? []),
        { at: now(), ...feedback, builders: subgraph.builders.map((b) => b.id) }
      ];
      await appendJsonl(options.eventFile, {
        schema: 'orbital.verification-loop-event.v1',
        at: now(),
        runId: graph.runId,
        graphId: graph.graphId,
        round: nextRound,
        reviewerNodeId: criticNode.id,
        reviewerAgent: criticNode.logicalAgent,
        builders: subgraph.builders.map((b) => b.id),
        reasonCode: feedback.reasonCode,
        verdict: feedback.verdict,
        findings: feedback.findings
      });

      const findingsList = feedback.findings.length > 0
        ? feedback.findings.map((f, i) => `  ${i + 1}. ${f}`).join('\n')
        : '  1. Corrige los defectos reportados por el nodo revisor y re-verifica empíricamente.';
      const feedbackHeader = [
        `[VERIFICATION_LOOP_ROUND_${nextRound} — AUTOCORRECCIÓN QUIRÚRGICA PROPORCIONAL (DELTA_ONLY) SOLICITADA POR ${criticNode.id} (${criticNode.logicalAgent})]`,
        `Veredicto previo: ${feedback.verdict} (${feedback.reasonCode})`,
        'ATENCIÓN: Tu entrega base ya fue ejecutada. Tienes PROHIBIDO rehacer el trabajo desde cero, regenerar matrices de capturas no afectadas o correr suites globales innecesarias.',
        'Hallazgos específicos que DEBES corregir de forma quirúrgica antes de volver a emitir status="PASS":',
        findingsList,
        'Instrucción proporcional: Modifica ÚNICAMENTE el archivo/componente causante del hallazgo dentro de tu writeScope, ejecuta solo la prueba/captura de esa superficie y conserva intactos los demás artefactos (PASS_LOCKED).',
        '',
        '[CONTEXTO DE REFERENCIA DEL OBJETIVO BASE (YA EJECUTADO — NO REPETIR TRABAJO YA APROBADO)]:'
      ].join('\n');

      for (const builder of subgraph.builders) {
        builder.baseReplicaObjectives = builder.baseReplicaObjectives ?? [...builder.replicaObjectives];
        builder.verificationLoopFeedback = feedback;
        builder.verificationLoopHistory = [...(builder.verificationLoopHistory ?? []), feedback];
        builder.replicaObjectives = builder.baseReplicaObjectives.map((baseObj) => `${feedbackHeader}\n${baseObj}`);
      }

      for (const nodeToRequeue of subgraph.nodesToRequeue) {
        nodeToRequeue.priorVerificationLoopInstances = [
          ...(nodeToRequeue.priorVerificationLoopInstances ?? []),
          ...nodeToRequeue.instances
        ];
        nodeToRequeue.instances = [];
        nodeToRequeue.state = 'QUEUED';
        nodeToRequeue.result = null;
        nodeToRequeue.reasonCode = null;
        await instantiateNodeReplicas(nodeToRequeue);
      }
    }

    await persist();
  }

  const requiredNodes = graph.nodes.filter((node) => node.optional !== true);
  graph.state = requiredNodes.every((node) => node.state === 'PASS')
    ? 'PASS'
    : requiredNodes.some((node) => node.state === 'FAIL') ? 'FAIL' : 'BLOCKED';
  // Capture the post-execution workspace state while the graph still owns its
  // write-scope lease. The later Director review can re-attest this exact
  // state and refuse a stale ACCEPT if another run/manual edit changes the
  // checkout after workers finish but before the terminal decision.
  if (typeof options.finalWorkspaceFingerprint === 'function') {
    graph.terminalWorkspaceFingerprint = await options.finalWorkspaceFingerprint();
  }
  graph.completedAt = now();
  await persist();
  return graph;
  } finally {
    if (executionLease) {
      const released = await releaseExecutionLease({
        file: executionLease.file,
        runId: graph.runId,
        fence: executionLease.lease.fence
      });
      const releaseConfirmed = released.ok === true && released.released === true;
      await appendJsonl(options.eventFile, {
        schema: 'orbital.write-scope-event.v1',
        at: now(), runId: graph.runId,
        type: releaseConfirmed ? 'WRITE_SCOPE_RELEASED' : 'WRITE_SCOPE_RELEASE_FAILED',
        fence: executionLease.lease.fence,
        reasonCode: releaseConfirmed ? null : (released.reasonCode ?? 'LEASE_RELEASE_NOT_CONFIRMED')
      });
      if (!releaseConfirmed) {
        throw new Error(`work-graph-runner:write-scope-release:${released.reasonCode ?? 'LEASE_RELEASE_NOT_CONFIRMED'}`);
      }
    }
  }
}
