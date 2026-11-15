import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertLifecycleTransition,
  lifecycleEvent,
  redactSecrets,
  validateLifecycleSequence
} from '../src/events.mjs';
import { appendJsonl, atomicWriteJson, readJson, readJsonl } from '../src/evidence.mjs';

test('lifecycle event is generic enough for future visual office', () => {
  const event = lifecycleEvent({
    runId: 'run-1',
    graphId: 'graph-1',
    nodeId: 'build',
    instanceId: 'x',
    agentId: 'software-builder',
    replica: 2,
    state: 'RUNNING',
    attempt: 1,
    project: 'fixture',
    task: 'bounded-task',
    principal: 'owner',
    surface: 'private',
    mode: 'workspace-write',
    provider: 'codex',
    model: 'selected-at-runtime'
  });
  assert.equal(event.schema, 'orbital.agent.lifecycle.v1');
  assert.ok(event.eventId);
  assert.equal(event.logicalAgent, 'software-builder');
  assert.equal(event.replica, 2);
  assert.equal(event.attempt, 1);
  assert.equal(event.state, 'RUNNING');
  assert.equal(event.project, 'fixture');
  assert.equal(event.principal, 'owner');
});

test('invalid lifecycle state fails closed', () => {
  assert.throws(() => lifecycleEvent({ instanceId: 'x', agentId: 'a', state: 'MAGIC' }), /invalid-agent-state/);
});

test('invalid state transitions fail closed while bounded retry is valid', () => {
  assert.throws(() => assertLifecycleTransition('QUEUED', 'PASS'), /invalid-agent-transition/);
  const events = ['QUEUED', 'READY', 'RUNNING', 'FAIL', 'READY', 'RUNNING', 'PASS'].map((state) => ({
    instanceId: 'retry-instance', state
  }));
  assert.equal(validateLifecycleSequence(events), true);
});

test('nested secret keys and credential-like values are recursively redacted', () => {
  const safe = redactSecrets({
    password: 'do-not-write',
    nested: {
      authorization: 'Bearer raw-credential',
      message: 'token=raw-token',
      array: ['sk-proj-abcdefghijklmnopqrstuvwxyz', { apiKey: 'raw-api-key' }]
    }
  });
  assert.equal(safe.password, '[REDACTED]');
  assert.equal(safe.nested.authorization, '[REDACTED]');
  assert.equal(safe.nested.message, 'token=[REDACTED]');
  assert.equal(safe.nested.array[0], '[REDACTED]');
  assert.equal(safe.nested.array[1].apiKey, '[REDACTED]');
  assert.equal(JSON.stringify(safe).includes('raw-'), false);
});

test('evidence appends JSONL and replaces JSON atomically with redaction', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oas-events-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const eventsFile = path.join(directory, 'events.jsonl');
  const stateFile = path.join(directory, 'state.json');

  await appendJsonl(eventsFile, { state: 'READY', secret: 'first' });
  await appendJsonl(eventsFile, { state: 'PASS', detail: 'Bearer raw-value' });
  await atomicWriteJson(stateFile, { revision: 1, token: 'raw-token' });
  await atomicWriteJson(stateFile, { revision: 2, nested: { password: 'raw-password' } });

  const events = await readJsonl(eventsFile);
  assert.deepEqual(events.map((event) => event.state), ['READY', 'PASS']);
  assert.equal(events[0].secret, '[REDACTED]');
  assert.equal(events[1].detail, 'Bearer [REDACTED]');
  assert.deepEqual(await readJson(stateFile), { revision: 2, nested: { password: '[REDACTED]' } });
  assert.deepEqual((await fs.readdir(directory)).sort(), ['events.jsonl', 'state.json']);
});
