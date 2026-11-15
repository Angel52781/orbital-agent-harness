import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePermissionEnvelope } from '../src/permissions.mjs';
import { capabilityCatalog } from '../src/registry.mjs';
import { readJsonl } from '../src/evidence.mjs';
import { verifyAttestedArtifact } from '../src/attested-artifacts.mjs';
import {
  createWorkGraph,
  loadWorkGraph,
  prepareWorkGraphResume,
  serialGraphPersister,
  runWorkGraph
} from '../src/work-graph.mjs';

test('concurrent graph checkpoints cannot persist an older state after a newer one', async () => {
  const graph = { version: 1 };
  const writes = [];
  let releaseFirst;
  let startedFirst;
  const firstStarted = new Promise(resolve => { startedFirst = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const persist = serialGraphPersister(graph, {
    stateFile: 'fixture-state.json', now: () => '2026-10-23T20:00:00.000Z',
    save: async (_file, value) => {
      const version = value.version;
      if (version === 1) { startedFirst(); await firstGate; }
      writes.push(version);
    }
  });
  const first = persist();
  await firstStarted;
  graph.version = 2;
  const second = persist();
  await Promise.resolve();
  assert.deepEqual(writes, [], 'newer checkpoint cannot overtake a slow older write');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(writes, [1, 2]);
  assert.equal(writes.at(-1), graph.version);
});

test('failed checkpoint propagates error without permanently wedging the checkpoint queue', async () => {
  const graph = { state: 'RUNNING' };
  let attempts = 0;
  const persist = serialGraphPersister(graph, {
    stateFile: 'fixture.json', now: () => '2026-10-23T20:00:00.000Z',
    save: async () => { if (++attempts === 1) throw new Error('disk-failed'); }
  });
  await assert.rejects(persist(), /disk-failed/);
  await persist();
  assert.equal(attempts, 2);
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_CAPABILITIES = capabilityCatalog();

function envelope(agentId, mode = 'read-only', writeScopes = []) {
  return resolvePermissionEnvelope({
    agentId,
    principal: 'owner',
    surface: 'private',
    mode,
    workspaceRoot: ROOT,
    requestedCapabilities: ALL_CAPABILITIES,
    writeScopes,
    callerPolicy: { allowedModes: ['read-only', 'workspace-write'], capabilityCeiling: ALL_CAPABILITIES },
    projectPolicy: {
      allowedModes: ['read-only', 'workspace-write'],
      capabilityCeiling: ALL_CAPABILITIES,
      workspaceRoot: ROOT
    }
  });
}

test('dependent reviewers receive the provider used by mutating upstream work', async (context) => {
  const output = await files(context);
  const graph = createWorkGraph({
    project: 'oas-fixture',
    task: 'build then independently review',
    surface: 'private',
    nodes: [
      {
        id: 'build',
        logicalAgent: 'software-builder',
        objective: 'build',
        expectedResult: 'build evidence',
        mode: 'workspace-write',
        replicaWriteScopes: [['src']]
      },
      {
        id: 'review',
        logicalAgent: 'code-auditor',
        objective: 'review',
        expectedResult: 'review evidence',
        mode: 'read-only',
        dependsOn: ['build']
      }
    ]
  });
  let reviewerProviders = null;
  const result = await runWorkGraph(graph, {
    ...output,
    envelopeFor: ({ node }) => envelope(
      node.logicalAgent,
      node.mode,
      node.mode === 'workspace-write' ? node.replicaWriteScopes[0] : []
    ),
    dispatcher: async (input) => {
      if (input.nodeId === 'build') {
        return { ok: true, result: 'built', provider: 'codex', model: 'fixture-codex' };
      }
      reviewerProviders = input.dependencyProviders;
      return { ok: true, result: 'reviewed', provider: 'antigravity', model: 'fixture-agy' };
    }
  });
  assert.equal(result.state, 'PASS');
  assert.deepEqual(reviewerProviders, ['codex']);
  assert.equal(result.nodes[0].instances[0].lastProvider, 'codex');
  assert.equal(result.nodes[1].instances[0].lastProvider, 'antigravity');
});

test('an inner QA_BLOCK prevents downstream activation despite reviewer wrapper PASS', async (context) => {
  const output = await files(context);
  const graph = createWorkGraph({
    project: 'oas-fixture',
    task: 'review then activate',
    mode: 'read-only',
    nodes: [
      {
        id: 'qa-gate',
        logicalAgent: 'qa-e2e',
        objective: 'Check the proposed activation',
        expectedResult: 'A binding independent audit verdict.',
        validation: { type: 'evidence-result' }
      },
      {
        id: 'activate',
        logicalAgent: 'research-evidence',
        objective: 'Activate only if QA_GO',
        dependsOn: ['qa-gate'],
        expectedResult: 'Authorized activation.'
      }
    ]
  });
  const dispatched = [];
  const result = await runWorkGraph(graph, {
    ...output,
    envelopeFor: ({ node }) => envelope(node.logicalAgent),
    dispatcher: async ({ nodeId }) => {
      dispatched.push(nodeId);
      return {
        ok: true,
        result: JSON.stringify({
          status: 'PASS',
          evidence: { auditVerdict: 'QA_BLOCK', finding: 'Unapproved source.' }
        })
      };
    }
  });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.nodes[0].reasonCode, 'INNER_QA_BLOCK');
  assert.equal(JSON.parse(result.nodes[0].result[0]).evidence.auditVerdict, 'QA_BLOCK');
  assert.equal(JSON.parse(result.nodes[0].result[0]).evidence.finding, 'Unapproved source.');
  assert.equal(result.nodes[1].reasonCode, 'DEPENDENCY_NOT_PASS');
  assert.deepEqual(dispatched, ['qa-gate']);
});

test('an inner releaseVerdict FAIL blocks a reviewer node even when execution succeeded', async (context) => {
  const output = await files(context);
  const graph = createWorkGraph({
    mode: 'read-only',
    nodes: [{
      id: 'release',
      logicalAgent: 'release-auditor',
      objective: 'Audit the final release.',
      expectedResult: 'An independent release verdict.',
      validation: { type: 'evidence-result' }
    }]
  });
  const result = await runWorkGraph(graph, {
    ...output,
    envelope: envelope('release-auditor'),
    dispatcher: async () => ({
      ok: true,
      result: '```json\n{"status":"PASS","evidence":{"releaseVerdict":"FAIL","reason":"QA report disagrees with filesystem."}}\n```'
    })
  });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.nodes[0].reasonCode, 'INNER_RELEASE_FAIL');
});

test('a non-binding review-result REVISE passes execution and allows downstream correction', async (context) => {
  const output = await files(context);
  const graph = createWorkGraph({
    mode: 'read-only',
    nodes: [
      {
        id: 'critic',
        logicalAgent: 'release-auditor',
        objective: 'Critique an animatic before final release.',
        expectedResult: 'A non-binding review verdict with findings.',
        validation: { type: 'review-result' }
      },
      {
        id: 'fix',
        logicalAgent: 'video-editor',
        objective: 'Apply only the critic findings.',
        dependsOn: ['critic'],
        expectedResult: 'Corrected review artifact.',
        validation: { type: 'evidence-result' },
        mode: 'workspace-write',
        replicaWriteScopes: [['tmp/review-result-fixture']]
      }
    ]
  });
  const dispatched = [];
  const result = await runWorkGraph(graph, {
    ...output,
    envelopeFor: ({ node }) => envelope(
      node.logicalAgent,
      node.mode,
      node.mode === 'workspace-write' ? node.replicaWriteScopes[0] : []
    ),
    dispatcher: async ({ nodeId }) => {
      dispatched.push(nodeId);
      if (nodeId === 'critic') {
        return {
          ok: true,
          result: JSON.stringify({
            status: 'PASS',
            evidence: {
              reviewVerdict: 'REVISE',
              counts: { P0: 0, P1: 1, P2: 0, P3: 0 },
              findings: [{ id: 'F1', severity: 'P1', timestamp: '1.0-2.0' }]
            }
          })
        };
      }
      return {
        ok: true,
        result: JSON.stringify({ status: 'PASS', evidence: { corrected: ['F1'] } })
      };
    }
  });
  assert.equal(result.state, 'PASS', JSON.stringify(result));
  assert.deepEqual(dispatched, ['critic', 'fix']);
  assert.equal(result.nodes[0].state, 'PASS');
  assert.equal(JSON.parse(result.nodes[0].result[0]).evidence.reviewVerdict, 'REVISE');
  assert.equal(result.nodes[1].state, 'PASS');
});

test('mandatory qa-go graph contract blocks missing verdicts and permits digest-free QA_GO', async (context) => {
  const graph = () => createWorkGraph({
    mode: 'read-only',
    nodes: [{
      id: 'qa',
      logicalAgent: 'qa-e2e',
      objective: 'Independently review a synthetic snapshot.',
      expectedResult: 'A signed QA_GO or a documented block.',
      validation: { type: 'qa-go' }
    }]
  });
  const evaluate = async (evidence) => runWorkGraph(graph(), {
    ...(await files(context)),
    envelope: envelope('qa-e2e'),
    dispatcher: async () => ({ ok: true, result: JSON.stringify({ status: 'PASS', evidence }) })
  });
  const missing = await evaluate({ reviewedTests: 42 });
  assert.equal(missing.state, 'BLOCKED');
  assert.equal(missing.nodes[0].reasonCode, 'BINDING_VERDICT_MISSING_OR_REJECTED');
  const unsigned = await evaluate({ auditVerdict: 'QA_GO' });
  assert.equal(unsigned.state, 'PASS');
  const signed = await evaluate({
    auditVerdict: 'QA_GO',
    sourceSha256: 'a'.repeat(64),
    artifactDigest: 'b'.repeat(64)
  });
  assert.equal(signed.state, 'PASS');
});

test('dependent independent QA_GO passes without requiring or manufacturing hashes', async (context) => {
  const output = await files(context);
  const graph = createWorkGraph({
    project: 'oas-fixture',
    task: 'verify existing editorial deliverable then independent QA',
    mode: 'read-only',
    nodes: [
      { id: 'verify', logicalAgent: 'research-evidence', objective: 'verify',
        expectedResult: 'grounded checks', validation: { type: 'evidence-result' } },
      { id: 'qa', logicalAgent: 'qa-e2e', objective: 'review verified result',
        expectedResult: 'independent QA_GO or QA_BLOCK', dependsOn: ['verify'],
        validation: { type: 'qa-go' } }
    ]
  });
  const result = await runWorkGraph(graph, {
    ...output,
    envelopeFor: ({ node }) => envelope(node.logicalAgent),
    dispatcher: async ({ nodeId }) => ({
      ok: true, result: JSON.stringify(nodeId === 'verify'
        ? { status: 'PASS', evidence: { checks: 79, outcome: 'PASS' } }
        : { status: 'PASS', evidence: { auditVerdict: 'QA_GO',
          findings: [], outcome: 'Independent checks passed.' } })
    })
  });
  assert.equal(result.state, 'PASS', JSON.stringify(result.nodes.map((n) => ({ id: n.id, state: n.state, reasonCode: n.reasonCode }))));
  const signed = JSON.parse(result.nodes[1].result[0]).evidence;
  assert.equal(signed.auditVerdict, 'QA_GO');
  assert.equal(signed.sourceSha256, undefined);
  assert.equal(signed.artifactDigest, undefined);
  assert.deepEqual(result.nodes[1].instances[0].artifactRefs, []);
});

test('upstream-bound QA does not manufacture approval for a reviewer QA_BLOCK', async (context) => {
  const graph = createWorkGraph({
    mode: 'read-only',
    nodes: [
      { id: 'verify', logicalAgent: 'research-evidence', objective: 'verify',
        expectedResult: 'checks', validation: { type: 'evidence-result' } },
      { id: 'qa', logicalAgent: 'qa-e2e', objective: 'independent review',
        expectedResult: 'QA_GO or block', dependsOn: ['verify'], validation: { type: 'qa-go' } }
    ]
  });
  const result = await runWorkGraph(graph, {
    ...(await files(context)),
    envelopeFor: ({ node }) => envelope(node.logicalAgent),
    dispatcher: async ({ nodeId }) => ({
      ok: true, result: JSON.stringify({ status: 'PASS', evidence: nodeId === 'verify'
        ? { checks: 79 } : { auditVerdict: 'QA_BLOCK', findings: ['critical defect'] } })
    })
  });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.nodes[1].reasonCode, 'INNER_QA_BLOCK');
});

test('the live work-graph entrypoint serializes competing writers and permits disjoint work', async (context) => {
  const leaseStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oas-shared-graph-leases-'));
  context.after(() => fs.rm(leaseStateDir, { recursive: true, force: true }));
  const makeGraph = (id, scope) => createWorkGraph({
    graphId: `graph-${id}`,
    runId: `run-${id}`,
    project: 'oas-fixture',
    task: 'isolated fake write',
    nodes: [{
      id,
      logicalAgent: 'software-builder',
      objective: 'Synthetic no-op with a controlled async boundary.',
      expectedResult: 'Synthetic success.',
      mode: 'workspace-write',
      replicaWriteScopes: [[scope]]
    }]
  });
  const runOptions = async (scope, dispatcher) => ({
    ...(await files(context)),
    workspaceRoot: ROOT,
    leaseStateDir,
    leaseWaitMs: 5,
    envelopeFor: ({ node }) => envelope(node.logicalAgent, 'workspace-write', [scope]),
    dispatcher
  });
  let releaseFirst;
  let startedFirst;
  const enteredFirst = new Promise((resolve) => { startedFirst = resolve; });
  const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
  const first = runWorkGraph(makeGraph('first', 'src'), await runOptions('src', async () => {
    startedFirst();
    await holdFirst;
    return { ok: true, result: 'done' };
  }));
  await enteredFirst;

  let secondDispatched = false;
  const second = runWorkGraph(makeGraph('second', 'src/child'), await runOptions('src/child', async () => {
    secondDispatched = true;
    return { ok: true, result: 'done' };
  }));
  const third = await runWorkGraph(makeGraph('third', 'tests'), await runOptions('tests', async () => ({
    ok: true,
    result: 'unrelated work continued'
  })));
  assert.equal(third.state, 'PASS');
  assert.equal(secondDispatched, false, 'overlapping writer dispatched before lease release');
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.state, 'PASS');
  assert.equal(secondResult.state, 'PASS');
  assert.equal(secondDispatched, true);
});

async function files(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oas-graph-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { eventFile: path.join(directory, 'events.jsonl'), stateFile: path.join(directory, 'graph.json') };
}

test('two replicas are distinct and observably concurrent', async (context) => {
  const output = await files(context);
  const graph = createWorkGraph({
    graphId: 'graph-replicas',
    runId: 'run-replicas',
    project: 'oas-fixture',
    task: 'independent research',
    surface: 'private',
    mode: 'read-only',
    nodes: [{
      id: 'research',
      logicalAgent: 'research-evidence',
      objective: 'Investigate two bounded questions',
      expectedResult: 'One answer per replica',
      validation: { type: 'non-empty-result' },
      replicaCount: 2,
      replicaObjectives: ['question-a', 'question-b']
    }]
  });

  let active = 0;
  let maximumActive = 0;
  const starts = [];
  const dispatcher = async (input) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    starts.push({ replica: input.replica, instanceId: input.instanceId, objective: input.objective });
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    return { ok: true, result: `answer-${input.replica}`, provider: 'fixture', model: 'fixture-model' };
  };

  const result = await runWorkGraph(graph, {
    ...output,
    dispatcher,
    envelope: envelope('research-evidence')
  });
  assert.equal(result.state, 'PASS');
  assert.equal(maximumActive, 2);
  assert.equal(new Set(starts.map((item) => item.instanceId)).size, 2);
  assert.deepEqual(starts.map((item) => item.objective).sort(), ['question-a', 'question-b']);
  assert.equal(result.nodes[0].instances.every((instance) => instance.state === 'PASS'), true);

  const events = await readJsonl(output.eventFile);
  assert.equal(events.filter((event) => event.state === 'RUNNING').length, 2);
  assert.equal(new Set(events.map((event) => event.instanceId)).size, 2);
  assert.equal(events.every((event) => event.runId === 'run-replicas'), true);
  assert.equal(events.every((event) => event.principal === 'owner'), true);
  assert.equal((await loadWorkGraph(output.stateFile)).state, 'PASS');
});

test('long-running workers emit RUNNING heartbeats until the dispatcher returns', async (context) => {
  const output = await files(context);
  const graph = createWorkGraph({
    graphId: 'graph-heartbeat',
    runId: 'run-heartbeat',
    project: 'oas-fixture',
    task: 'prove worker liveness',
    surface: 'private',
    mode: 'read-only',
    nodes: [{
      id: 'research',
      logicalAgent: 'research-evidence',
      objective: 'wait long enough to heartbeat',
      expectedResult: 'heartbeat then result'
    }]
  });

  const result = await runWorkGraph(graph, {
    ...output,
    heartbeatMs: 5,
    dispatcher: async () => {
      await new Promise((resolve) => setTimeout(resolve, 24));
      return { ok: true, result: 'done', provider: 'fixture', model: 'fixture-model' };
    },
    envelope: envelope('research-evidence')
  });

  assert.equal(result.state, 'PASS');
  const events = await readJsonl(output.eventFile);
  const running = events.filter((event) => event.state === 'RUNNING');
  assert.equal(running.length >= 2, true);
  assert.equal(running.some((event) => event.reasonCode === 'HEARTBEAT'), true);
  assert.equal(events.at(-1).state, 'PASS');
});

test('dependencies wait for bounded retry and failed dependencies block dispatch', async (context) => {
  const retryFiles = await files(context);
  const order = [];
  const attempts = new Map();
  const retryGraph = createWorkGraph({
    mode: 'read-only',
    nodes: [
      {
        id: 'source', logicalAgent: 'research-evidence', objective: 'source', expectedResult: 'source',
        retryPolicy: { maxAttempts: 2 }
      },
      {
        id: 'consumer', logicalAgent: 'research-evidence', objective: 'consumer', dependsOn: ['source'],
        expectedResult: 'consumer'
      }
    ]
  });
  const dispatcher = async (input) => {
    order.push(`${input.nodeId}:${input.attempt}`);
    attempts.set(input.nodeId, (attempts.get(input.nodeId) ?? 0) + 1);
    if (input.nodeId === 'source' && input.attempt === 1) return { ok: false, reasonCode: 'FIXTURE_RETRY' };
    return { ok: true, result: input.nodeId };
  };
  const passed = await runWorkGraph(retryGraph, {
    ...retryFiles,
    dispatcher,
    envelope: envelope('research-evidence')
  });
  assert.equal(passed.state, 'PASS');
  assert.deepEqual(order, ['source:1', 'source:2', 'consumer:1']);

  const blockedFiles = await files(context);
  const called = [];
  const blockedGraph = createWorkGraph({
    mode: 'read-only',
    nodes: [
      { id: 'failing', logicalAgent: 'research-evidence', objective: 'fail', expectedResult: 'never' },
      {
        id: 'blocked', logicalAgent: 'research-evidence', objective: 'must not run', dependsOn: ['failing'],
        expectedResult: 'never'
      }
    ]
  });
  const failed = await runWorkGraph(blockedGraph, {
    ...blockedFiles,
    envelope: envelope('research-evidence'),
    dispatcher: async (input) => {
      called.push(input.nodeId);
      return { ok: false, reasonCode: 'FIXTURE_FAILURE' };
    }
  });
  assert.equal(failed.state, 'FAIL');
  assert.deepEqual(called, ['failing']);
  assert.equal(failed.nodes.find((node) => node.id === 'blocked').state, 'BLOCKED');
});

test('resume preserves upstream PASS evidence and reruns only the failed node and dependents', async (context) => {
  const firstFiles = await files(context);
  const graph = createWorkGraph({
    mode: 'read-only',
    nodes: [
      { id: 'direction', logicalAgent: 'research-evidence', objective: 'direction', expectedResult: 'direction' },
      {
        id: 'build', logicalAgent: 'research-evidence', objective: 'build',
        dependsOn: ['direction'], expectedResult: 'build'
      },
      {
        id: 'review', logicalAgent: 'research-evidence', objective: 'review',
        dependsOn: ['build'], expectedResult: 'review'
      }
    ]
  });
  const firstCalls = [];
  const first = await runWorkGraph(graph, {
    ...firstFiles,
    envelope: envelope('research-evidence'),
    dispatcher: async (input) => {
      firstCalls.push(input.nodeId);
      if (input.nodeId === 'build') {
        return {
          ok: false,
          blocked: true,
          status: 'BLOCKED',
          reasonCode: 'FIXTURE_BUILD_BLOCKED',
          result: JSON.stringify({ status: 'BLOCKED', evidence: { checkpoint: 'built-source' } })
        };
      }
      return { ok: true, result: input.nodeId, provider: 'fixture', model: 'fixture' };
    }
  });
  assert.equal(first.state, 'BLOCKED');
  assert.deepEqual(firstCalls, ['direction', 'build']);

  const resumed = prepareWorkGraphResume(first, 'build', { runId: 'resume-fixture' });
  assert.equal(resumed.nodes.find((node) => node.id === 'direction').state, 'PASS');
  assert.equal(resumed.nodes.find((node) => node.id === 'build').state, 'QUEUED');
  assert.match(
    resumed.nodes.find((node) => node.id === 'build').resumeCheckpoint.previousResult,
    /built-source/
  );

  const resumeFiles = await files(context);
  const resumeCalls = [];
  const completed = await runWorkGraph(resumed, {
    ...resumeFiles,
    envelope: envelope('research-evidence'),
    resume: true,
    dispatcher: async (input) => {
      resumeCalls.push(input.nodeId);
      return { ok: true, result: input.nodeId + '-resumed', provider: 'fixture', model: 'fixture' };
    }
  });
  assert.equal(completed.state, 'PASS');
  assert.deepEqual(resumeCalls, ['build', 'review']);
  assert.equal(completed.nodes.find((node) => node.id === 'direction').result[0], 'direction');
});

test('resume can discard only the invalidated node checkpoint while preserving upstream PASS evidence', () => {
  const graph = createWorkGraph({
    mode: 'read-only',
    nodes: [
      {
        id: 'upstream',
        logicalAgent: 'research-evidence',
        objective: 'upstream',
        expectedResult: 'upstream'
      },
      {
        id: 'gate',
        logicalAgent: 'research-evidence',
        objective: 'gate',
        dependsOn: ['upstream'],
        expectedResult: 'gate'
      }
    ]
  });
  graph.nodes[0].state = 'PASS';
  graph.nodes[0].result = ['upstream-evidence'];
  graph.nodes[0].instances = [{ result: 'upstream-evidence' }];
  graph.nodes[1].state = 'PASS';
  graph.nodes[1].result = ['stale-pass'];
  graph.nodes[1].instances = [{ result: 'stale-pass' }];
  graph.state = 'PASS';

  const resumed = prepareWorkGraphResume(graph, 'gate', {
    runId: 'clean-gate-rerun',
    preserveFromNodeCheckpoint: false
  });
  assert.equal(resumed.nodes[0].state, 'PASS');
  assert.deepEqual(resumed.nodes[0].result, ['upstream-evidence']);
  assert.equal(resumed.nodes[1].state, 'QUEUED');
  assert.equal(resumed.nodes[1].resumeCheckpoint, null);
});

test('blocked dependency propagation reaches a fixed point regardless of node order', async (context) => {
  const output = await files(context);
  const calls = [];
  const graph = createWorkGraph({
    mode: 'read-only',
    nodes: [
      {
        id: 'grandchild', logicalAgent: 'research-evidence', objective: 'grandchild',
        dependsOn: ['child'], expectedResult: 'never'
      },
      {
        id: 'child', logicalAgent: 'research-evidence', objective: 'child',
        dependsOn: ['root'], expectedResult: 'never'
      },
      {
        id: 'root', logicalAgent: 'research-evidence', objective: 'root',
        expectedResult: 'never'
      }
    ]
  });
  const result = await runWorkGraph(graph, {
    ...output,
    envelope: envelope('research-evidence'),
    dispatcher: async (input) => {
      calls.push(input.nodeId);
      return { ok: false, reasonCode: 'FIXTURE_ROOT_FAILURE' };
    }
  });
  assert.equal(result.state, 'FAIL');
  assert.deepEqual(calls, ['root']);
  assert.equal(result.nodes.find((node) => node.id === 'child').state, 'BLOCKED');
  assert.equal(result.nodes.find((node) => node.id === 'grandchild').state, 'BLOCKED');
});

test('missing authorized provider is a concrete blocked state, never a false pass', async (context) => {
  const output = await files(context);
  const graph = createWorkGraph({
    mode: 'read-only',
    nodes: [{ id: 'research', logicalAgent: 'research-evidence', objective: 'research', expectedResult: 'answer' }]
  });
  const result = await runWorkGraph(graph, {
    ...output,
    envelope: envelope('research-evidence'),
    dispatcher: async () => ({ ok: false, reasonCode: 'NO_AUTHORIZED_PROVIDER', attempts: [] })
  });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.nodes[0].instances[0].state, 'BLOCKED');
  const events = await readJsonl(output.eventFile);
  assert.equal(events.at(-1).reasonCode, 'NO_AUTHORIZED_PROVIDER');
});

test('provider exhaustion is preserved through evidence validation as an infrastructure failure', async (context) => {
  const output = await files(context);
  const graph = createWorkGraph({
    mode: 'read-only',
    nodes: [{
      id: 'security',
      logicalAgent: 'security-reviewer',
      objective: 'audit security',
      expectedResult: 'structured evidence',
      validation: { type: 'evidence-result' }
    }]
  });
  const result = await runWorkGraph(graph, {
    ...output,
    envelope: envelope('security-reviewer'),
    dispatcher: async () => ({
      ok: false,
      reasonCode: 'PROVIDERS_EXHAUSTED',
      attempts: [{
        provider: 'antigravity',
        model: 'gemini-test',
        status: 'FAIL',
        errorClass: 'TIMEOUT',
        providerReasonCode: 'ANTIGRAVITY_TIMEOUT'
      }]
    })
  });

  assert.equal(result.state, 'FAIL');
  assert.equal(result.nodes[0].reasonCode, 'PROVIDERS_EXHAUSTED');
  assert.equal(result.nodes[0].instances[0].reasonCode, 'PROVIDERS_EXHAUSTED');
  const events = await readJsonl(output.eventFile);
  assert.equal(events.at(-1).reasonCode, 'PROVIDERS_EXHAUSTED');
});

test('documents specialization materializes declared artifacts into the durable execution output', async (context) => {
  const output = await files(context);
  const sourceRoot = path.join(path.dirname(output.stateFile), 'provider-scratch');
  await fs.mkdir(sourceRoot, { recursive: true });
  const sourcePdf = path.join(sourceRoot, 'report.pdf');
  const sourceMd = path.join(sourceRoot, 'report.md');
  const sourceJson = path.join(sourceRoot, 'report.json');
  await fs.writeFile(sourcePdf, '%PDF-1.4\nfixture\n');
  await fs.writeFile(sourceMd, '# Report\n');
  await fs.writeFile(sourceJson, '{"ok":true}\n');

  const graph = createWorkGraph({
    mode: 'read-only',
    nodes: [{
      id: 'report',
      logicalAgent: 'editorial-producer',
      specializations: ['documents-presentations'],
      objective: 'produce durable report artifacts',
      expectedResult: 'PDF + Markdown/JSON report',
      validation: { type: 'evidence-result' }
    }]
  });
  const result = await runWorkGraph(graph, {
    ...output,
    artifactSourceRoots: [sourceRoot],
    envelope: envelope('editorial-producer'),
    dispatcher: async () => ({
      ok: true,
      provider: 'antigravity',
      model: 'fixture',
      result: JSON.stringify({
        status: 'PASS',
        evidence: {
          artifacts: {
            pdf: sourcePdf,
            markdown: sourceMd,
            json: sourceJson
          },
          summary: 'complete'
        }
      })
    })
  });

  assert.equal(result.state, 'PASS');
  const instance = result.nodes[0].instances[0];
  assert.equal(instance.artifactRefs.length, 3);
  for (const ref of instance.artifactRefs) {
    assert.match(ref, /^artifacts\/report\//);
    await fs.access(path.join(path.dirname(output.stateFile), ref));
  }
  const parsed = JSON.parse(instance.result);
  assert.match(parsed.evidence.artifacts.pdf, /artifacts\/report\/report\.pdf$/);
});

test('documents specialization fails closed when a declared artifact is missing', async (context) => {
  const output = await files(context);
  const sourceRoot = path.join(path.dirname(output.stateFile), 'provider-scratch');
  await fs.mkdir(sourceRoot, { recursive: true });
  const graph = createWorkGraph({
    mode: 'read-only',
    nodes: [{
      id: 'report',
      logicalAgent: 'editorial-producer',
      specializations: ['documents-presentations'],
      objective: 'produce durable report artifacts',
      expectedResult: 'PDF report',
      validation: { type: 'evidence-result' }
    }]
  });
  const result = await runWorkGraph(graph, {
    ...output,
    artifactSourceRoots: [sourceRoot],
    envelope: envelope('editorial-producer'),
    dispatcher: async () => ({
      ok: true,
      provider: 'antigravity',
      model: 'fixture',
      result: JSON.stringify({
        status: 'PASS',
        evidence: {
          artifacts: { pdf: path.join(sourceRoot, 'missing.pdf') },
          summary: 'complete'
        }
      })
    })
  });

  assert.equal(result.state, 'FAIL');
  assert.equal(result.nodes[0].reasonCode, 'DOCUMENT_ARTIFACT_MISSING');
  assert.equal(result.nodes[0].instances[0].reasonCode, 'DOCUMENT_ARTIFACT_MISSING');
});

test('work graph persists compatible PROFILE_ONLY specialization metadata and rejects invalid bases', () => {
  const specialized = createWorkGraph({
    mode: 'read-only',
    nodes: [{
      id: 'review',
      logicalAgent: 'release-auditor',
      specializations: ['video-frame-critic'],
      objective: 'review exact rendered video',
      expectedResult: 'frame-level review'
    }]
  });
  assert.deepEqual(specialized.nodes[0].specializations, ['video-frame-critic']);

  assert.throws(() => createWorkGraph({
    mode: 'read-only',
    nodes: [{
      id: 'invalid-review',
      logicalAgent: 'research-evidence',
      specializations: ['video-frame-critic'],
      objective: 'invalid',
      expectedResult: 'invalid'
    }]
  }), /invalid-work-graph:specialization-not-allowed/);
});

test('structured worker BLOCKED output cannot satisfy non-empty-result validation', async (context) => {
  const output = await files(context);
  const graph = createWorkGraph({
    mode: 'read-only',
    nodes: [{
      id: 'research',
      logicalAgent: 'research-evidence',
      objective: 'research',
      expectedResult: 'evidence',
      validation: { type: 'non-empty-result' }
    }]
  });
  const result = await runWorkGraph(graph, {
    ...output,
    envelope: envelope('research-evidence'),
    dispatcher: async () => ({
      ok: true,
      result: '{"status":"BLOCKED","lack":"required source"}',
      provider: 'fixture',
      model: 'fixture-model'
    })
  });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.nodes[0].instances[0].state, 'BLOCKED');
  const events = await readJsonl(output.eventFile);
  assert.equal(events.at(-1).reasonCode, 'WORKER_REPORTED_BLOCKED');
});

test('explicit prose BLOCKED verdicts cannot produce a false PASS', async (context) => {
  for (const workerText of [
    '`BLOCKED`: source built but render is unavailable.',
    '### Independent Visual QA Report\n\n**Verdict:** **`BLOCKED`**\n\nNo exact MP4 exists.',
    '## Veredicto: `BLOCKED`\n\nEl contrato de artefacto no se cumple.'
  ]) {
    const output = await files(context);
    const graph = createWorkGraph({
      mode: 'read-only',
      nodes: [{
        id: 'research',
        logicalAgent: 'research-evidence',
        objective: 'research',
        expectedResult: 'evidence',
        validation: { type: 'non-empty-result' }
      }]
    });
    const result = await runWorkGraph(graph, {
      ...output,
      envelope: envelope('research-evidence'),
      dispatcher: async () => ({
        ok: true,
        result: workerText,
        provider: 'fixture',
        model: 'fixture-model'
      })
    });
    assert.equal(result.state, 'BLOCKED');
    assert.equal(result.nodes[0].instances[0].state, 'BLOCKED');
  }
});

test('DAG cycles, unsafe replicated writes and unbounded retries fail closed', () => {
  assert.throws(() => createWorkGraph({ nodes: [
    { id: 'a', logicalAgent: 'research-evidence', objective: 'a', dependsOn: ['b'], expectedResult: 'a' },
    { id: 'b', logicalAgent: 'research-evidence', objective: 'b', dependsOn: ['a'], expectedResult: 'b' }
  ] }), /invalid-work-graph:cycle/);

  assert.throws(() => createWorkGraph({ mode: 'workspace-write', nodes: [{
    id: 'builders', logicalAgent: 'software-builder', objective: 'build', expectedResult: 'code', replicaCount: 2
  }] }), /replicated-write-requires-isolation/);

  assert.throws(() => createWorkGraph({ mode: 'workspace-write', nodes: [{
    id: 'builders', logicalAgent: 'software-builder', objective: 'build', expectedResult: 'code', replicaCount: 2,
    replicaWriteScopes: [['src'], ['src/feature']]
  }] }), /overlapping-replica-write-scopes/);

  const isolated = createWorkGraph({ mode: 'workspace-write', nodes: [{
    id: 'builders', logicalAgent: 'software-builder', objective: 'build', expectedResult: 'code', replicaCount: 2,
    isolationKey: 'worktree'
  }] });
  assert.equal(isolated.nodes[0].isolationKey, 'worktree');

  assert.throws(() => createWorkGraph({ nodes: [{
    id: 'retry', logicalAgent: 'research-evidence', objective: 'retry', expectedResult: 'answer',
    retryPolicy: { maxAttempts: 11 }
  }] }), /retry-max-attempts/);
});
