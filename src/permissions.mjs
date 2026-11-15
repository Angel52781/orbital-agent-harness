import fs from 'node:fs';
import path from 'node:path';
import {
  capabilityCatalog,
  capabilityDefinition,
  expandedCapabilities,
  getAgent,
  isExecutableAgent,
  loadOrganization
} from './registry.mjs';

const MODES = new Set(['read-only', 'workspace-write']);
const SURFACES = new Set(['private', 'team']);
const READ_ONLY_DENIED_CAPABILITIES = new Set(['devspace-write']);
const RESOLVED_ENVELOPES = new WeakSet();

function fail(code) {
  throw new Error(`permission-denied:${code}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalDirectory(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${field}-must-be-absolute`);
  let canonical;
  try {
    canonical = fs.realpathSync(value);
  } catch {
    fail(`${field}-not-found`);
  }
  if (!fs.statSync(canonical).isDirectory()) fail(`${field}-not-directory`);
  return canonical;
}

function validatedModes(policy, field) {
  if (!isRecord(policy) || !Array.isArray(policy.allowedModes) || policy.allowedModes.length === 0) {
    fail(`missing-${field}-mode-ceiling`);
  }
  const modes = new Set();
  for (const mode of policy.allowedModes) {
    if (!MODES.has(mode)) fail(`invalid-${field}-mode-ceiling`);
    modes.add(mode);
  }
  return modes;
}

function validatedCapabilities(values, field, catalog, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    fail(`invalid-${field}`);
  }
  const capabilities = new Set();
  for (const capability of values) {
    if (typeof capability !== 'string' || !catalog.has(capability)) fail(`unknown-${field}`);
    capabilities.add(capability);
  }
  return capabilities;
}

function freezeEnvelope(envelope) {
  Object.freeze(envelope.requestedCapabilities);
  Object.freeze(envelope.effectiveCapabilities);
  Object.freeze(envelope.deniedCapabilities);
  for (const decision of envelope.capabilityDecisions) Object.freeze(decision);
  Object.freeze(envelope.capabilityDecisions);
  Object.freeze(envelope.writeScopes);
  Object.freeze(envelope.replaceableWriteScopes);
  Object.freeze(envelope);
  RESOLVED_ENVELOPES.add(envelope);
  return envelope;
}

export function resolvePermissionEnvelope({
  agentId,
  principal,
  surface,
  mode,
  requestedMode,
  workspaceRoot,
  requestedCapabilities,
  writeScopes = [],
  replaceableWriteScopes = [],
  callerPolicy,
  projectPolicy
} = {}) {
  if (mode !== undefined && requestedMode !== undefined && mode !== requestedMode) {
    fail('conflicting-requested-mode');
  }
  const effectiveMode = requestedMode ?? mode;
  const organization = loadOrganization();
  if (organization.accessPolicy?.runtimeGrant !== 'grant-on-dispatch'
      || organization.accessPolicy?.permissionCeiling !== 'caller-intersection') {
    fail('invalid-organization-policy');
  }

  const principalPolicy = organization.principals?.find((item) => item.id === principal);
  if (!principalPolicy || !['owner', 'team'].includes(principal)) fail('invalid-principal');
  if (!SURFACES.has(surface) || !principalPolicy.surfaces?.includes(surface)) {
    fail('surface-not-allowed');
  }
  if (!MODES.has(effectiveMode)) fail('invalid-mode');

  const agent = getAgent(agentId);
  if (!isExecutableAgent(agent)) fail('agent-not-executable');
  const callerModes = validatedModes(callerPolicy, 'caller');
  const projectModes = validatedModes(projectPolicy, 'project');
  const agentModes = new Set(agent.runtimePolicy.allowedModes);
  if (!callerModes.has(effectiveMode) || !projectModes.has(effectiveMode) || !agentModes.has(effectiveMode)) {
    fail('mode-exceeds-ceiling');
  }
  if (!Array.isArray(writeScopes)
      || writeScopes.some((scope) => typeof scope !== 'string' || !scope.trim())) {
    fail('invalid-write-scopes');
  }
  const resolvedWriteScopes = [...new Set(writeScopes)];
  if (!Array.isArray(replaceableWriteScopes)
      || replaceableWriteScopes.some((scope) => typeof scope !== 'string' || !scope.trim())) {
    fail('invalid-replaceable-write-scopes');
  }
  const resolvedReplaceableWriteScopes = [...new Set(replaceableWriteScopes)];
  if (resolvedReplaceableWriteScopes.some((scope) => !resolvedWriteScopes.includes(scope))) {
    fail('replaceable-write-scope-not-granted');
  }
  if (effectiveMode === 'read-only' && resolvedWriteScopes.length > 0) fail('write-scopes-in-read-only-mode');
  if (effectiveMode === 'read-only' && resolvedReplaceableWriteScopes.length > 0) {
    fail('replaceable-write-scopes-in-read-only-mode');
  }
  if (effectiveMode === 'workspace-write' && agent.runtimePolicy.requireWriteScopes
      && resolvedWriteScopes.length === 0) {
    fail('explicit-write-scopes-required');
  }

  const canonicalRoot = canonicalDirectory(workspaceRoot, 'workspace-root');
  if (!isRecord(projectPolicy) || !Object.hasOwn(projectPolicy, 'workspaceRoot')) {
    fail('missing-project-workspace-root');
  }
  const projectRoot = canonicalDirectory(projectPolicy.workspaceRoot, 'project-workspace-root');
  if (canonicalRoot !== projectRoot) fail('workspace-root-outside-project');

  const catalog = new Set(capabilityCatalog());
  const requested = validatedCapabilities(requestedCapabilities, 'requested-capability', catalog);
  const callerCeiling = validatedCapabilities(
    callerPolicy.capabilityCeiling,
    'caller-capability-ceiling',
    catalog
  );
  const projectCeiling = validatedCapabilities(
    projectPolicy.capabilityCeiling,
    'project-capability-ceiling',
    catalog
  );
  const callerApproved = validatedCapabilities(
    callerPolicy.approvedCapabilities ?? [],
    'caller-approved-capability',
    catalog
  );
  const projectApproved = validatedCapabilities(
    projectPolicy.approvedCapabilities ?? [],
    'project-approved-capability',
    catalog
  );
  const agentCeiling = new Set(expandedCapabilities(agent));

  const requestedList = [...requested].sort();
  const capabilityDecisions = requestedList.map((capability) => {
    let reason = null;
    if (!callerCeiling.has(capability)) reason = 'caller-ceiling';
    else if (!projectCeiling.has(capability)) reason = 'project-ceiling';
    else if (!agentCeiling.has(capability)) reason = 'agent-ceiling';
    else if (effectiveMode === 'read-only' && READ_ONLY_DENIED_CAPABILITIES.has(capability)) {
      reason = 'read-only-mode';
    } else {
      const definition = capabilityDefinition(capability);
      if (['authorization-required', 'approval-required'].includes(definition.enforcement)
          && (!callerApproved.has(capability) || !projectApproved.has(capability))) {
        reason = definition.enforcement;
      }
    }
    return {
      capability,
      status: reason ? 'DENIED' : 'GRANTED',
      reason
    };
  });
  const effectiveCapabilities = capabilityDecisions
    .filter((decision) => decision.status === 'GRANTED')
    .map((decision) => decision.capability);
  const granted = new Set(effectiveCapabilities);

  return freezeEnvelope({
    schemaVersion: 1,
    resolved: true,
    agentId,
    principal,
    surface,
    mode: effectiveMode,
    workspaceRoot: canonicalRoot,
    requestedCapabilities: requestedList,
    effectiveCapabilities,
    deniedCapabilities: requestedList.filter((capability) => !granted.has(capability)),
    capabilityDecisions,
    writeScopes: resolvedWriteScopes,
    replaceableWriteScopes: resolvedReplaceableWriteScopes
  });
}

export function assertResolvedPermissionEnvelope(envelope, { agentId } = {}) {
  if (!isRecord(envelope) || !RESOLVED_ENVELOPES.has(envelope)) {
    fail('unresolved-envelope');
  }
  if (envelope.schemaVersion !== 1 || envelope.resolved !== true) fail('invalid-envelope');
  if (agentId !== undefined && envelope.agentId !== agentId) fail('agent-envelope-mismatch');
  canonicalDirectory(envelope.workspaceRoot, 'workspace-root');

  const agent = getAgent(envelope.agentId);
  if (!isExecutableAgent(agent)) fail('agent-not-executable');
  const allowed = new Set(expandedCapabilities(agent));
  const requested = new Set(envelope.requestedCapabilities);
  for (const capability of envelope.effectiveCapabilities) {
    if (!allowed.has(capability) || !requested.has(capability)) fail('invalid-effective-grant');
    if (envelope.mode === 'read-only' && READ_ONLY_DENIED_CAPABILITIES.has(capability)) {
      fail('write-capability-in-read-only-envelope');
    }
  }
  if (!Array.isArray(envelope.capabilityDecisions)
      || envelope.capabilityDecisions.length !== envelope.requestedCapabilities.length) {
    fail('invalid-capability-decisions');
  }
  if (!Array.isArray(envelope.writeScopes)) fail('invalid-write-scopes');
  if (!Array.isArray(envelope.replaceableWriteScopes)) fail('invalid-replaceable-write-scopes');
  if (envelope.replaceableWriteScopes.some((scope) => !envelope.writeScopes.includes(scope))) {
    fail('replaceable-write-scope-not-granted');
  }
  if (envelope.mode === 'read-only' && envelope.writeScopes.length > 0) fail('write-scopes-in-read-only-mode');
  if (envelope.mode === 'workspace-write' && agent.runtimePolicy.requireWriteScopes
      && envelope.writeScopes.length === 0) {
    fail('explicit-write-scopes-required');
  }
  return envelope;
}

export function isResolvedPermissionEnvelope(value) {
  return isRecord(value) && RESOLVED_ENVELOPES.has(value);
}
