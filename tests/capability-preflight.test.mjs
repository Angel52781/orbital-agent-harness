import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preflightNodeCapabilities, verifyPaymentEvidenceCapability } from '../src/capability-preflight.mjs';
import { createWorkGraph, runWorkGraph } from '../src/work-graph.mjs';
import { resolvePermissionEnvelope } from '../src/permissions.mjs';
import { capabilityCatalog } from '../src/registry.mjs';

test('sandbox HTTPS 403 yields one material host boundary, not another worker retry', () => {
  assert.deepEqual(preflightNodeCapabilities({ workerPublicHttps: true }, {
    workerPublicHttps: 'PROXY_TUNNEL_403_FORBIDDEN', ownerHostPublicHttps: 'AVAILABLE'
  }), { ok: false, reasonCode: 'HOST_CANARY_REQUIRED',
    requiredSurface: 'owner-host', primaryFailure: 'PROXY_TUNNEL_403_FORBIDDEN', retrySameWorker: false });
  assert.equal(preflightNodeCapabilities({ workerPublicHttps: true }, null).reasonCode,
    'CAPABILITY_PREFLIGHT_MISSING');
  assert.equal(preflightNodeCapabilities({ workerPublicHttps: true }, {
    workerPublicHttps: 'AVAILABLE'
  }).ok, true);
  assert.equal(preflightNodeCapabilities({ hostSystemdMutation: true }, {
    hostSystemdMutation: 'UNAUTHORIZED'
  }).reasonCode, 'HOST_ACTION_APPROVAL_REQUIRED');
  assert.equal(preflightNodeCapabilities({ sharedProviderQuota: true }, {
    sharedProviderQuota: 'EXHAUSTED'
  }).reasonCode, 'PROVIDER_SHARED_QUOTA_EXHAUSTED');
});
test('real work-graph blocks before dispatch on unmet observed network capability', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-capability-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const graph = createWorkGraph({
    project: 'network-preflight-fixture',
    task: 'public canary',
    mode: 'read-only',
    nodes: [
      { id: 'canary', logicalAgent: 'research-evidence', objective: 'Fetch public HTTPS',
        expectedResult: 'real public API body and digest',
        validation: { type: 'evidence-result' },
        retryPolicy: { maxAttempts: 3 },
        capabilityRequirements: { workerPublicHttps: true }
      },
      { id: 'qa', logicalAgent: 'code-auditor', dependsOn: ['canary'],
        objective: 'Review captured bytes', expectedResult: 'report' }
    ]
  });
  const capabilities = capabilityCatalog();
  let dispatches = 0;
  const finished = await runWorkGraph(graph, {
    eventFile: path.join(root, 'events.jsonl'), stateFile: path.join(root, 'state.json'),
    heartbeatMs: 0,
    capabilityMatrix: { workerPublicHttps: 'PROXY_TUNNEL_403_FORBIDDEN', ownerHostPublicHttps: 'AVAILABLE' },
    envelopeFor: ({ node }) => resolvePermissionEnvelope({
      agentId: node.logicalAgent, principal: 'owner', surface: 'private',
      mode: 'read-only', workspaceRoot: root,
      requestedCapabilities: ['context-routing'],
      callerPolicy: { allowedModes: ['read-only'], capabilityCeiling: capabilities },
      projectPolicy: { allowedModes: ['read-only'], capabilityCeiling: capabilities, workspaceRoot: root }
    }),
    dispatcher: async () => { dispatches += 1; throw Error('must never reach the proxy'); }
  });
  assert.equal(finished.state, 'BLOCKED');
  assert.equal(finished.nodes[0].reasonCode, 'HOST_CANARY_REQUIRED');
  assert.equal(finished.nodes[1].reasonCode, 'CAPABILITY_PREFLIGHT_DEPENDENCY_NOT_READY');
  assert.equal(dispatches, 0);
});
test('blocked optional channel does not prevent independent required branches from passing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-capability-optional-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const graph = createWorkGraph({
    project: 'optional-channel-fixture',
    task: 'continue without browser channel',
    mode: 'read-only',
    nodes: [
      {
        id: 'browser-channel', logicalAgent: 'research-evidence', optional: true,
        objective: 'Try optional public browser acquisition.', expectedResult: 'optional evidence',
        capabilityRequirements: { workerPublicHttps: true }
      },
      {
        id: 'independent-research', logicalAgent: 'research-evidence',
        objective: 'Use an independent non-browser evidence path.', expectedResult: 'required evidence'
      },
      {
        id: 'strategy', logicalAgent: 'growth-director', dependsOn: ['independent-research'],
        objective: 'Synthesize only the viable evidence path.', expectedResult: 'strategy'
      }
    ]
  });
  const capabilities = capabilityCatalog();
  const dispatched = [];
  const finished = await runWorkGraph(graph, {
    eventFile: path.join(root, 'events.jsonl'), stateFile: path.join(root, 'state.json'),
    heartbeatMs: 0,
    capabilityMatrix: { workerPublicHttps: 'PROXY_TUNNEL_403_FORBIDDEN', ownerHostPublicHttps: 'AVAILABLE' },
    envelopeFor: ({ node }) => resolvePermissionEnvelope({
      agentId: node.logicalAgent, principal: 'owner', surface: 'private', mode: 'read-only', workspaceRoot: root,
      requestedCapabilities: ['context-routing'],
      callerPolicy: { allowedModes: ['read-only'], capabilityCeiling: capabilities },
      projectPolicy: { allowedModes: ['read-only'], capabilityCeiling: capabilities, workspaceRoot: root }
    }),
    dispatcher: async ({ nodeId }) => {
      dispatched.push(nodeId);
      return { ok: true, result: `PASS:${nodeId}` };
    }
  });
  assert.equal(finished.nodes[0].state, 'BLOCKED');
  assert.equal(finished.nodes[0].reasonCode, 'HOST_CANARY_REQUIRED');
  assert.deepEqual(dispatched.sort(), ['independent-research', 'strategy']);
  assert.equal(finished.nodes[1].state, 'PASS');
  assert.equal(finished.nodes[2].state, 'PASS');
  assert.equal(finished.state, 'PASS');
});
test('paymentEvidence fails closed when unavailable and code presence alone never certifies', () => {
  // Preflight check with unmet requirement
  const unmet = preflightNodeCapabilities({ paymentEvidence: true }, { paymentEvidence: 'UNVERIFIED' });
  assert.equal(unmet.ok, false);
  assert.equal(unmet.reasonCode, 'PAYMENT_EVIDENCE_RAIL_UNAVAILABLE');

  // Preflight check with available matrix
  const met = preflightNodeCapabilities({ paymentEvidence: true }, { paymentEvidence: 'AVAILABLE' });
  assert.equal(met.ok, true);

  // verifyPaymentEvidenceCapability helper verification
  const missingSecret = verifyPaymentEvidenceCapability({
    secretConfigured: false,
    stateDirWritable: true,
    daemonHealthy: true,
    aggregateSchemaValid: true
  });
  assert.equal(missingSecret.ok, false);
  assert.equal(missingSecret.status, 'UNAVAILABLE');

  const healthy = verifyPaymentEvidenceCapability({
    secretConfigured: true,
    stateDirWritable: true,
    daemonHealthy: true,
    aggregateSchemaValid: true
  });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.status, 'AVAILABLE');
});
