import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INFRASTRUCTURE_RECOVERY_REASON_CODES,
  LOCAL_STEER_REASON_CODES,
  MATERIAL_HUMAN_BOUNDARY_REASON_CODES,
  STRUCTURAL_REPLAN_REASON_CODES,
  TRANSIENT_RETRY_REASON_CODES,
  classifyManagedRecovery,
  humanBoundaryFromReason,
  materialHumanBoundary,
  recoveryActionForReason
} from '../src/recovery-policy.mjs';

test('recovery state model exhaustively maps every declared reason code to one action', () => {
  const groups = [
    ['WAITING_PROVIDER', INFRASTRUCTURE_RECOVERY_REASON_CODES],
    ['STEER', LOCAL_STEER_REASON_CODES],
    ['BLOCK', MATERIAL_HUMAN_BOUNDARY_REASON_CODES],
    ['REPLAN', STRUCTURAL_REPLAN_REASON_CODES],
    ['RETRY', TRANSIENT_RETRY_REASON_CODES]
  ];
  const seen = new Map();
  for (const [expected, reasons] of groups) {
    for (const reason of reasons) {
      assert.equal(seen.has(reason), false, `duplicate taxonomy reason ${reason}`);
      seen.set(reason, expected);
      assert.equal(recoveryActionForReason(reason), expected, reason);
      const viaExecution = classifyManagedRecovery({ execution: { state: 'BLOCKED', reasonCode: reason } });
      assert.equal(viaExecution.action, expected, `execution:${reason}`);
      if (expected !== 'RETRY') {
        const viaGraph = classifyManagedRecovery({
          execution: { state: 'BLOCKED', reasonCode: 'EXIT_1' },
          graph: { nodes: [{ state: 'BLOCKED', reasonCode: reason, instances: [] }] }
        });
        assert.equal(viaGraph.action, expected, `graph:${reason}`);
      }
    }
  }
  assert.ok(seen.size >= 35);
});
test('recovery state model preserves precedence: human boundary > provider wait > local steer > structural replan', () => {
  const graph = {
    nodes: [
      { state: 'BLOCKED', reasonCode: 'DEPENDENCY_NOT_PASS', instances: [] },
      { state: 'BLOCKED', reasonCode: 'EVIDENCE_RESULT_NOT_STRUCTURED', instances: [] },
      { state: 'BLOCKED', reasonCode: 'PROVIDER_SHARED_QUOTA_EXHAUSTED', instances: [] },
      { state: 'BLOCKED', reasonCode: 'CREDENTIALS_REQUIRED', instances: [] }
    ]
  };
  assert.deepEqual(
    classifyManagedRecovery({ execution: { state: 'BLOCKED', reasonCode: 'EXIT_1' }, graph }),
    { action: 'BLOCK', reasonCode: 'CREDENTIALS_REQUIRED' }
  );
  graph.nodes.pop();
  assert.equal(classifyManagedRecovery({ execution: { state: 'BLOCKED' }, graph }).action, 'WAITING_PROVIDER');
  graph.nodes.pop();
  assert.equal(classifyManagedRecovery({ execution: { state: 'BLOCKED' }, graph }).action, 'STEER');
  graph.nodes.pop();
  assert.equal(classifyManagedRecovery({ execution: { state: 'BLOCKED' }, graph }).action, 'REPLAN');
});
test('shared recovery taxonomy never retries deterministic structural failures', () => {
  for (const reason of [
    'HOST_HTTPS_REQUIRED',
    'PROVIDER_TOOL_CAPABILITY_REQUIRED',
    'PROVIDER_QUOTA_UNVERIFIED',
    'DISPATCH_EXCEPTION',
    'WORKER_REPORTED_BLOCKED'
  ]) {
    assert.equal(recoveryActionForReason(reason), 'REPLAN', reason);
  }
  for (const reason of [
    'EVIDENCE_RESULT_NOT_STRUCTURED',
    'QA_ARTIFACT_DOMAIN_MISMATCH',
    'BINDING_VERDICT_SNAPSHOT_MISMATCH',
    'ATTESTED_ARTIFACT_OUTSIDE_ROOT',
    'INNER_QA_BLOCK',
    'INNER_RELEASE_FAIL',
    'FINAL_REVIEW_MATERIALIZATION_EXCEPTION',
    'FLOW_VIDEO_CLI_FAILED'
  ]) {
    assert.equal(recoveryActionForReason(reason), 'STEER', reason);
  }
});
test('provider quota and human boundaries have distinct controller actions', () => {
  assert.equal(recoveryActionForReason('PROVIDER_SHARED_QUOTA_EXHAUSTED'), 'WAITING_PROVIDER');
  assert.equal(recoveryActionForReason('HOST_ACTION_APPROVAL_REQUIRED'), 'BLOCK');
  assert.equal(recoveryActionForReason('PAYMENT_RAIL_UNAVAILABLE'), 'BLOCK');
});
test('Director BLOCK is accepted only with a structured material human boundary', () => {
  const graph = { state: 'PASS', nodes: [] };
  assert.deepEqual(
    classifyManagedRecovery({ execution: { state: 'PASS' }, graph, review: { decision: 'BLOCK' } }),
    { action: 'REPLAN', reasonCode: 'DIRECTOR_BLOCK_MISSING_STRUCTURED_BOUNDARY' }
  );
  const boundary = humanBoundaryFromReason('PAYMENT_RAIL_UNAVAILABLE', 'No payment rail is deployed.');
  assert.equal(materialHumanBoundary(boundary), true);
  assert.deepEqual(
    classifyManagedRecovery({
      execution: { state: 'PASS' }, graph,
      review: { decision: 'BLOCK', boundary }
    }),
    { action: 'BLOCK', reasonCode: 'PAYMENT_RAIL_UNAVAILABLE' }
  );
});
