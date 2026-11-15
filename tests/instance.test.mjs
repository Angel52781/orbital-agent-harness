import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstance } from '../src/instance.mjs';
import { resolvePermissionEnvelope } from '../src/permissions.mjs';
import { capabilityCatalog } from '../src/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_CAPABILITIES = capabilityCatalog();

function envelope(agentId, mode = 'read-only') {
  return resolvePermissionEnvelope({
    agentId,
    principal: 'owner',
    surface: 'private',
    mode,
    workspaceRoot: ROOT,
    requestedCapabilities: ALL_CAPABILITIES,
    callerPolicy: { allowedModes: ['read-only', 'workspace-write'], capabilityCeiling: ALL_CAPABILITIES },
    projectPolicy: {
      allowedModes: ['read-only', 'workspace-write'],
      capabilityCeiling: ALL_CAPABILITIES,
      workspaceRoot: ROOT
    }
  });
}

test('replicas of one logical agent have distinct correlated instance ids', () => {
  const runtimeEnvelope = envelope('research-evidence');
  const first = createInstance('research-evidence', {
    runId: 'run-1', graphId: 'graph-1', nodeId: 'research', replica: 1, replicaCount: 2, envelope: runtimeEnvelope
  });
  const second = createInstance('research-evidence', {
    runId: 'run-1', graphId: 'graph-1', nodeId: 'research', replica: 2, replicaCount: 2, envelope: runtimeEnvelope
  });

  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal(first.logicalAgent, second.logicalAgent);
  assert.equal(first.state, 'QUEUED');
  assert.equal(first.event.nodeId, 'research');
  assert.equal(second.event.replica, 2);
  assert.deepEqual(first.runtimeGrant, runtimeEnvelope.effectiveCapabilities);
  assert.ok(first.capabilitiesDiscoverable.includes('devspace-write'));
  assert.equal(first.runtimeGrant.includes('devspace-write'), false);
});

test('instance rejects fabricated envelopes and non-parallel logical agents', () => {
  assert.throws(
    () => createInstance('research-evidence', { envelope: { resolved: true } }),
    /permission-denied:unresolved-envelope/
  );
  assert.throws(
    () => createInstance('orbital-director', { replica: 1, replicaCount: 2 }),
    /parallel-instances-not-allowed/
  );
});

test('replicated workspace writes require explicit isolation', () => {
  const runtimeEnvelope = envelope('software-builder', 'workspace-write');
  assert.throws(
    () => createInstance('software-builder', { replica: 1, replicaCount: 2, envelope: runtimeEnvelope }),
    /replicated-write-requires-isolation/
  );
  const isolated = createInstance('software-builder', {
    replica: 1,
    replicaCount: 2,
    envelope: runtimeEnvelope,
    isolationKey: 'worktree-a'
  });
  assert.equal(isolated.mode, 'workspace-write');
  assert.equal(isolated.isolationKey, 'worktree-a');
});
