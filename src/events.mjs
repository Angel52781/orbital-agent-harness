import crypto from 'node:crypto';

export const AGENT_STATES = Object.freeze([
  'QUEUED',
  'READY',
  'RUNNING',
  'WAITING_APPROVAL',
  'BLOCKED',
  'PASS',
  'FAIL',
  'CANCELLED',
  'IDLE'
]);

export const TERMINAL_AGENT_STATES = Object.freeze(['BLOCKED', 'PASS', 'CANCELLED']);

const TRANSITIONS = Object.freeze({
  IDLE: new Set(['QUEUED', 'READY', 'CANCELLED']),
  QUEUED: new Set(['READY', 'BLOCKED', 'CANCELLED']),
  READY: new Set(['RUNNING', 'BLOCKED', 'CANCELLED']),
  // RUNNING -> RUNNING is reserved for lifecycle heartbeats. It does not
  // widen execution authority or reset attempts; it only proves the worker
  // process is still alive while a long provider/tool call is in flight.
  RUNNING: new Set(['RUNNING', 'WAITING_APPROVAL', 'BLOCKED', 'PASS', 'FAIL', 'CANCELLED']),
  WAITING_APPROVAL: new Set(['READY', 'RUNNING', 'BLOCKED', 'CANCELLED']),
  FAIL: new Set(['READY']),
  BLOCKED: new Set(),
  PASS: new Set(),
  CANCELLED: new Set()
});

const SECRET_KEY = /api.?key|access.?token|refresh.?token|auth(?:orization)?|cookie|credential|password|passwd|private.?key|secret|session|token/i;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g
];
const ASSIGNED_SECRET = /\b((?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth(?:orization)?|credential|password|passwd|secret|token)\s*[:=]\s*)([^\s,;]+)/gi;

function redactString(value) {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) redacted = redacted.replace(pattern, '[REDACTED]');
  return redacted
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(ASSIGNED_SECRET, '$1[REDACTED]');
}

/** Return a JSON-safe copy with credential-like keys and values removed. */
export function redactSecrets(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => redactSecrets(item, seen));
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(item, seen);
  }
  seen.delete(value);
  return result;
}

export function assertAgentState(state) {
  if (!AGENT_STATES.includes(state)) throw new Error(`invalid-agent-state:${state}`);
  return state;
}

export function assertLifecycleTransition(previousState, nextState) {
  assertAgentState(nextState);
  if (previousState === null || previousState === undefined) return nextState;
  assertAgentState(previousState);
  if (!TRANSITIONS[previousState].has(nextState)) {
    throw new Error(`invalid-agent-transition:${previousState}->${nextState}`);
  }
  return nextState;
}

export function lifecycleEvent({
  eventId = crypto.randomUUID(),
  runId = null,
  graphId = null,
  nodeId = null,
  instanceId,
  logicalAgent = null,
  agentId = null,
  replica = 1,
  state,
  previousState,
  attempt = 0,
  provider = null,
  model = null,
  project = null,
  task = null,
  principal = null,
  surface = null,
  mode = null,
  reasonCode = null,
  artifactRefs = [],
  detail = null,
  at = new Date().toISOString()
}) {
  assertLifecycleTransition(previousState, state);
  const resolvedAgent = logicalAgent || agentId;
  if (!instanceId) throw new Error('invalid-lifecycle-event:missing-instanceId');
  if (!resolvedAgent) throw new Error('invalid-lifecycle-event:missing-logicalAgent');
  if (!Number.isInteger(replica) || replica < 1) throw new Error(`invalid-lifecycle-event:replica:${replica}`);
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error(`invalid-lifecycle-event:attempt:${attempt}`);
  if (!Array.isArray(artifactRefs)) throw new Error('invalid-lifecycle-event:artifactRefs');

  return redactSecrets({
    schema: 'orbital.agent.lifecycle.v1',
    eventId,
    runId,
    graphId,
    nodeId,
    instanceId,
    logicalAgent: resolvedAgent,
    // Compatibility alias for v0.1 consumers.
    agentId: resolvedAgent,
    replica,
    state,
    attempt,
    provider,
    model,
    project,
    task,
    principal,
    surface,
    mode,
    reasonCode,
    artifactRefs,
    detail,
    at
  });
}

export function validateLifecycleSequence(events) {
  const lastStateByInstance = new Map();
  for (const event of events) {
    if (!event?.instanceId) throw new Error('invalid-lifecycle-sequence:missing-instanceId');
    const previous = lastStateByInstance.get(event.instanceId);
    assertLifecycleTransition(previous, event.state);
    lastStateByInstance.set(event.instanceId, event.state);
  }
  return true;
}
