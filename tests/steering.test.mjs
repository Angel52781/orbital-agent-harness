import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateSteering, steeringPolicy } from '../src/steering.mjs';

test('local reversible correction becomes NODE_STEER and preserves the plan contract', () => {
  const result = evaluateSteering({
    nodeId: 'landing',
    directive: 'Use the approved alternate logo asset; keep the existing scope and acceptance criteria.'
  });
  assert.equal(result.ok, true);
  assert.equal(result.classification, 'NODE_STEER');
  assert.equal(steeringPolicy.rerunScope, 'target-node-and-dependents');
});

test('structural changes require replanning rather than silently widening the approved plan', () => {
  for (const change of ['objective', 'acceptance', 'permissions', 'writeScopes', 'dependencies', 'capabilities']) {
    const result = evaluateSteering({
      nodeId: 'landing',
      directive: 'Change the approved plan contract.',
      changes: [change]
    });
    assert.equal(result.ok, false);
    assert.equal(result.classification, 'PLAN_INVALIDATION');
    assert.equal(result.reasonCode, 'STEERING_REQUIRES_REPLAN');
  }
});

test('steering rejects missing node or empty directive', () => {
  assert.equal(evaluateSteering({ directive: 'fix' }).reasonCode, 'STEERING_NODE_REQUIRED');
  assert.equal(evaluateSteering({ nodeId: 'x', directive: ' ' }).reasonCode, 'STEERING_DIRECTIVE_INVALID');
});
