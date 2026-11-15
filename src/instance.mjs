import crypto from 'node:crypto';
import { capabilityCatalog, getAgent } from './registry.mjs';
import { lifecycleEvent } from './events.mjs';
import { assertResolvedPermissionEnvelope } from './permissions.mjs';

export function createInstance(agentId, {
  runId = null,
  graphId = null,
  nodeId = null,
  project = null,
  task = null,
  replica = 1,
  replicaCount = 1,
  envelope = null,
  runtimeEnvelope = null,
  isolationKey = null,
  writeScopes = null,
  providerSelection = null
} = {}) {
  const agent = getAgent(agentId);
  if (!Number.isInteger(replica) || replica < 1) throw new Error(`invalid-instance-replica:${replica}`);
  if (!Number.isInteger(replicaCount) || replicaCount < 1 || replica > replicaCount) {
    throw new Error(`invalid-instance-replica-count:${replicaCount}`);
  }
  if (replicaCount > 1 && !agent.parallelInstances) {
    throw new Error(`parallel-instances-not-allowed:${agentId}`);
  }

  const resolvedEnvelope = runtimeEnvelope || envelope;
  assertResolvedPermissionEnvelope(resolvedEnvelope, { agentId });
  const effectiveWriteScopes = writeScopes ?? resolvedEnvelope.writeScopes;
  if (!Array.isArray(effectiveWriteScopes)
      || effectiveWriteScopes.some((scope) => typeof scope !== 'string' || !scope)) {
    throw new Error(`invalid-write-scopes:${agentId}`);
  }
  if (resolvedEnvelope.mode === 'workspace-write' && agent.runtimePolicy.requireWriteScopes
      && effectiveWriteScopes.length === 0) {
    throw new Error(`workspace-write-requires-scopes:${agentId}`);
  }
  if (resolvedEnvelope.mode === 'workspace-write' && replicaCount > 1
      && !isolationKey && effectiveWriteScopes.length === 0) {
    throw new Error(`replicated-write-requires-isolation:${agentId}`);
  }

  const instanceId = `${agentId}-${replica}-${crypto.randomUUID()}`;
  const event = lifecycleEvent({
    runId,
    graphId,
    nodeId,
    instanceId,
    logicalAgent: agentId,
    replica,
    state: 'QUEUED',
    project,
    task,
    principal: resolvedEnvelope.principal,
    surface: resolvedEnvelope.surface,
    mode: resolvedEnvelope.mode
  });

  return {
    instanceId,
    logicalAgent: agentId,
    displayName: `${agent.displayName} #${replica}`,
    replica,
    replicaCount,
    runId,
    graphId,
    nodeId,
    principal: resolvedEnvelope.principal,
    surface: resolvedEnvelope.surface,
    mode: resolvedEnvelope.mode,
    project,
    task,
    capabilitiesDiscoverable: capabilityCatalog(),
    runtimeGrant: [...resolvedEnvelope.effectiveCapabilities],
    runtimeEnvelope: resolvedEnvelope,
    isolationKey,
    writeScopes: [...effectiveWriteScopes],
    providerSelection,
    state: 'QUEUED',
    attempt: 0,
    artifactRefs: [],
    result: null,
    event
  };
}
