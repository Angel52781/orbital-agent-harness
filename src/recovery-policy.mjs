export const INFRASTRUCTURE_RECOVERY_REASON_CODES = new Set([
  'NO_AUTHORIZED_PROVIDER',
  'PROVIDERS_EXHAUSTED',
  'ANTIGRAVITY_POOL_EXHAUSTED',
  'CODEX_SHARED_QUOTA_EXHAUSTED',
  'PROVIDER_SHARED_QUOTA_EXHAUSTED',
  'ANTIGRAVITY_TIMEOUT',
  'CODEX_TIMEOUT',
  'ANTIGRAVITY_STALLED',
  'CODEX_STALLED'
]);

export const MATERIAL_HUMAN_BOUNDARY_REASON_CODES = new Set([
  'HOST_ACTION_APPROVAL_REQUIRED',
  'OWNER_APPROVAL_REQUIRED',
  'PROTECTED_ACTION_APPROVAL_REQUIRED',
  'EXTERNAL_CREDENTIAL_MISSING',
  'CREDENTIALS_REQUIRED',
  'AUTHENTICATION_REQUIRED',
  'PAYMENT_RAIL_UNAVAILABLE',
  'PAYMENT_EVIDENCE_RAIL_UNAVAILABLE'
]);

export const LOCAL_STEER_REASON_CODES = new Set([
  'EVIDENCE_RESULT_NOT_STRUCTURED',
  'RESULT_CONTRACT_FAILED',
  'QA_ARTIFACT_DOMAIN_MISMATCH',
  'QA_ARTIFACT_SHA256_MISMATCH',
  'QA_ARTIFACT_BODY_MISMATCH',
  'QA_ARTIFACT_INVALID_JSON',
  'BINDING_VERDICT_SNAPSHOT_MISMATCH',
  'BINDING_VERDICT_MISSING_OR_REJECTED',
  'BINDING_VERDICT_EVIDENCE_DIGEST_MISSING',
  'ATTESTED_QA_ARTIFACT_REQUIRED',
  'ATTESTED_ARTIFACT_DRIFT',
  'ATTESTED_ARTIFACT_OUTSIDE_ROOT',
  'INNER_QA_BLOCK',
  'INNER_RELEASE_FAIL',
  'FINAL_REVIEW_MATERIALIZATION_EXCEPTION',
  'FINAL_REVIEW_RESULT_REPARSE_FAILED',
  'FLOW_VIDEO_CLI_FAILED'
]);

export const PACKAGE_REWORK_REASON_CODES = new Set([
  'PACKAGE_CONTRACT_INCOMPLETE',
  'PACKAGE_CAPABILITY_REASSIGNMENT_REQUIRED',
  'PACKAGE_SUBGRAPH_BLOCKED',
  'DIRECTOR_PACKAGE_REWORK'
]);

export const STRUCTURAL_REPLAN_REASON_CODES = new Set([
  'DEPENDENCY_NOT_PASS',
  'CAPABILITY_PREFLIGHT_DEPENDENCY_NOT_READY',
  'CAPABILITY_PREFLIGHT_MISSING',
  'BROWSER_CAPABILITY_REQUIRED',
  'NETWORK_CAPABILITY_UNVERIFIED',
  'HOST_CANARY_REQUIRED',
  'HOST_HTTPS_REQUIRED',
  'PROVIDER_TOOL_CAPABILITY_REQUIRED',
  'PROVIDER_QUOTA_UNVERIFIED',
  'PROVIDER_PERMISSION_POLICY_BLOCKED',
  'PROVIDER_CAPABILITY_UNAVAILABLE',
  'WORKER_REPORTED_BLOCKED',
  'WORKER_REPORTED_NEEDS_HUMAN',
  'DISPATCH_EXCEPTION',
  'VALIDATOR_EXCEPTION'
]);

export const TRANSIENT_RETRY_REASON_CODES = new Set([
  'GATEWAY_RESTART',
  'CONTROLLER_WATCHDOG_LOST_CHILD',
  'WORKER_OOM',
  'TEMPORARY_INTERRUPTION'
]);

export function recoveryActionForReason(reasonCode) {
  if (!reasonCode) return null;
  if (MATERIAL_HUMAN_BOUNDARY_REASON_CODES.has(reasonCode)) return 'BLOCK';
  if (INFRASTRUCTURE_RECOVERY_REASON_CODES.has(reasonCode)) return 'WAITING_PROVIDER';
  if (LOCAL_STEER_REASON_CODES.has(reasonCode)) return 'STEER';
  if (PACKAGE_REWORK_REASON_CODES.has(reasonCode)) return 'REWORK_PACKAGE';
  if (STRUCTURAL_REPLAN_REASON_CODES.has(reasonCode)) return 'REPLAN';
  if (TRANSIENT_RETRY_REASON_CODES.has(reasonCode)) return 'RETRY';
  return null;
}
export function materialHumanBoundary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return value.schema === 'orbital.human-boundary.v1'
    && MATERIAL_HUMAN_BOUNDARY_REASON_CODES.has(value.reasonCode)
    && typeof value.kind === 'string' && value.kind.length > 0
    && typeof value.detail === 'string' && value.detail.length > 0;
}
export function humanBoundaryFromReason(reasonCode, detail = null) {
  if (!MATERIAL_HUMAN_BOUNDARY_REASON_CODES.has(reasonCode)) return null;
  const kind = reasonCode.includes('CREDENTIAL') || reasonCode === 'AUTHENTICATION_REQUIRED'
    ? 'credential'
    : reasonCode.includes('PAYMENT')
      ? 'external-rail'
      : reasonCode.includes('APPROVAL')
        ? 'authorization'
        : 'protected-action';
  return Object.freeze({
    schema: 'orbital.human-boundary.v1',
    reasonCode,
    kind,
    requirement: reasonCode,
    detail: detail || `Execution requires human intervention for ${reasonCode}.`
  });
}
export function graphRecoveryReasonCodes(graph) {
  const codes = [];
  for (const node of graph?.nodes ?? []) {
    if (node.reasonCode) codes.push(node.reasonCode);
    for (const instance of node.instances ?? []) {
      if (instance.reasonCode) codes.push(instance.reasonCode);
    }
  }
  return codes;
}
export function providerInfrastructureReason(execution, graph = null) {
  if (INFRASTRUCTURE_RECOVERY_REASON_CODES.has(execution?.reasonCode)) {
    return execution.reasonCode;
  }
  return graphRecoveryReasonCodes(graph)
    .find((reason) => INFRASTRUCTURE_RECOVERY_REASON_CODES.has(reason)) ?? null;
}
export function classifyManagedRecovery({ execution, graph = null, review = null } = {}) {
  if (review?.decision === 'STEER') {
    return { action: 'STEER', reasonCode: 'DIRECTOR_LOCAL_CORRECTION' };
  }
  if (review?.decision === 'REWORK_PACKAGE') {
    return { action: 'REWORK_PACKAGE', reasonCode: 'DIRECTOR_PACKAGE_REWORK' };
  }
  if (review?.decision === 'REPLAN') {
    return { action: 'REPLAN', reasonCode: 'DIRECTOR_STRUCTURAL_REPLAN' };
  }
  if (review?.decision === 'BLOCK') {
    if (materialHumanBoundary(review.boundary)) {
      return { action: 'BLOCK', reasonCode: review.boundary.reasonCode };
    }
    return { action: 'REPLAN', reasonCode: 'DIRECTOR_BLOCK_MISSING_STRUCTURED_BOUNDARY' };
  }

  const reasons = graphRecoveryReasonCodes(graph);
  const human = reasons.find((reason) => recoveryActionForReason(reason) === 'BLOCK');
  if (human) return { action: 'BLOCK', reasonCode: human };
  const provider = providerInfrastructureReason(execution, graph);
  if (provider) return { action: 'WAITING_PROVIDER', reasonCode: provider };
  const steer = reasons.find((reason) => recoveryActionForReason(reason) === 'STEER');
  if (steer) return { action: 'STEER', reasonCode: steer };
  const packageRework = reasons.find((reason) => recoveryActionForReason(reason) === 'REWORK_PACKAGE');
  if (packageRework) return { action: 'REWORK_PACKAGE', reasonCode: packageRework };
  const replan = reasons.find((reason) => recoveryActionForReason(reason) === 'REPLAN');
  if (replan) return { action: 'REPLAN', reasonCode: replan };
  const explicitExecution = recoveryActionForReason(execution?.reasonCode);
  if (explicitExecution) return { action: explicitExecution, reasonCode: execution.reasonCode };
  if (execution?.state === 'INTERRUPTED') {
    return { action: 'RETRY', reasonCode: execution.reasonCode ?? 'TEMPORARY_INTERRUPTION' };
  }
  if (execution && ['FAIL', 'BLOCKED'].includes(execution.state)) {
    return { action: 'REPLAN', reasonCode: execution.reasonCode ?? 'STRATEGY_OR_PLAN_INCOMPLETE' };
  }
  return { action: 'REPLAN', reasonCode: 'STRATEGY_OR_PLAN_INCOMPLETE' };
}
