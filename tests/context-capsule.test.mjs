import test from 'node:test';
import assert from 'node:assert/strict';

import { createContextCapsule, contextCapsuleSize } from '../src/context-capsule.mjs';

test('context capsule is bounded, hashed and strips excessive context', () => {
  const capsule = createContextCapsule({
    objective: 'Design a bounded software change',
    current_state: Array.from({ length: 40 }, (_, i) => `state-${i}`),
    evidence_refs: ['PROJECT_CONTEXT.md', 'graphify://node/123'],
    recommended_capabilities: ['graphify', 'context-routing', 'github-read'],
    risk: 'medium'
  });
  assert.equal(capsule.schema, 'orbital.context-capsule.v1');
  assert.equal(capsule.current_state.length, 12);
  assert.match(capsule.context_hash, /^[a-f0-9]{64}$/);
  assert.ok(contextCapsuleSize(capsule) < 12_000);
});

test('context capsule preserves deltas and unknowns as first-class compact fields', () => {
  const capsule = createContextCapsule({
    delta: ['changed checkout contract'],
    unknowns: ['whether migration is required']
  });
  assert.deepEqual(capsule.delta, ['changed checkout contract']);
  assert.deepEqual(capsule.unknowns, ['whether migration is required']);
});
