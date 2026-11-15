import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { causalRetryDecision, classifyExecutionFailure } from '../src/failure-classifier.mjs';
import { createWorkGraph, runWorkGraph } from '../src/work-graph.mjs';
import { resolvePermissionEnvelope } from '../src/permissions.mjs';
import { capabilityCatalog } from '../src/registry.mjs';

test('forbidden worker proxy routes to owner-host and cannot be retried in same sandbox', () => {
  const reason = classifyExecutionFailure(new Error('PROXY_TUNNEL_403_FORBIDDEN on public HTTPS CONNECT'));
  assert.equal(reason.cause, 'SANDBOX_EGRESS_DENIED');
  assert.equal(reason.recovery, 'HOST_CANARY_REQUIRED');
  for (const code of ['PROXY_TUNNEL_403_FORBIDDEN', 'INNER_QA_BLOCK',
    'INNER_RELEASE_FAIL', 'QA_ARTIFACT_SHA256_MISMATCH', 'CODEX_SHARED_QUOTA_EXHAUSTED',
    'PROVIDER_PERMISSION_POLICY_BLOCKED', 'RESULT_CONTRACT_FAILED']) {
    assert.equal(causalRetryDecision({ reasonCode: code }).retry, false, code);
  }
  const first = causalRetryDecision({ reasonCode: 'TRANSIENT_SOCKET_RESET' });
  assert.equal(first.retry, true);
  const repeated = causalRetryDecision({
    reasonCode: 'TRANSIENT_SOCKET_RESET', priorSignatures: [first.signature]
  });
  assert.equal(repeated.retry, false);
  assert.equal(repeated.reasonCode, 'REPEATED_CAUSAL_SIGNATURE');
});

test('real graph does not burn maxAttempts=5 on an unchanged deterministic provider policy', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const graph = createWorkGraph({
    mode: 'read-only', nodes: [{
      id: 'worker', logicalAgent: 'research-evidence',
      objective: 'Research constrained public source',
      expectedResult: 'Evidence or concrete blocker',
      retryPolicy: { maxAttempts: 5 }
    }]
  });
  const all = capabilityCatalog();
  let invocations = 0;
  const output = await runWorkGraph(graph, {
    eventFile: path.join(root, 'events.jsonl'),
    stateFile: path.join(root, 'state.json'),
    heartbeatMs: 0,
    envelopeFor: ({ node }) => resolvePermissionEnvelope({
      agentId: node.logicalAgent, principal: 'owner', surface: 'private',
      mode: 'read-only', workspaceRoot: root, requestedCapabilities: ['context-routing'],
      callerPolicy: { allowedModes: ['read-only'], capabilityCeiling: all },
      projectPolicy: { allowedModes: ['read-only'], capabilityCeiling: all, workspaceRoot: root }
    }),
    dispatcher: async () => {
      invocations += 1;
      return { ok: false, reasonCode: 'PROXY_TUNNEL_403_FORBIDDEN' };
    }
  });
  assert.equal(output.state, 'FAIL');
  assert.equal(invocations, 1);
  const lifecycle = (await fs.readFile(path.join(root, 'events.jsonl'), 'utf8')).split('\n')
    .filter(Boolean).map((line) => JSON.parse(line));
  const failure = lifecycle.find((e) => e.state === 'FAIL');
  assert.equal(failure.detail.retryDecision.retry, false);
  assert.equal(failure.detail.retryDecision.primaryCause, 'SANDBOX_EGRESS_DENIED');
});
